// Fase 4 — Equipos: miembros, invitaciones, roles personalizados, grupos, visibilidad compartida,
// cambio de organización, 2FA (TOTP) y ajustes de seguridad/retención.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import {
  AcceptInvitationInput,
  BUILTIN_ROLE_PERMISSIONS,
  CreateGroupInput,
  CreateRoleInput,
  InviteMemberInput,
  PutSharesInput,
  PutTemplateSharesInput,
  RoleAssignment,
  SwitchTenantInput,
  TotpCodeInput,
  TwoFactorLoginInput,
  UpdateGroupInput,
  UpdateRoleInput,
  UpdateSecuritySettingsInput,
  type AccessResponse,
  type CustomRole,
  type Group,
  type Invitation,
  type InvitationPreview,
  type Member,
  type MemberRole,
  type Permission,
  type TwoFactorChallenge,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "../lib/totp";
import { decrypt, encrypt, hashPassword, iso, randomToken, sha256Hex, uuidv7, verifyPassword } from "../lib/util";
import { deliver } from "../notifications/channels";
import { normLocale } from "../notifications/templates";
import { hasPerm } from "./access";
import { auditFromRequest, recordAudit } from "./audit";
import { SESSION_COOKIE, authenticate, clientInfo, type AuthContext, type Services } from "./context";

const SESSION_DAYS = 14;
const INVITE_DAYS = 7;
const ROLE_LABEL: Record<string, string> = { owner: "Propietario", admin: "Administrador", member: "Miembro" };

// ───────────────────────────── Sesiones ─────────────────────────────

export async function createUserSession(db: Db, req: FastifyRequest, reply: FastifyReply, userId: string, tenantId: string) {
  const token = randomToken();
  const { ip, userAgent } = clientInfo(req);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '${SESSION_DAYS} days')`,
    [sha256Hex(token), userId, tenantId, ip, userAgent],
  );
  reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: config.cookieSecure, maxAge: SESSION_DAYS * 86400 });
}

async function meResponse(db: Db, userId: string, tenantId: string) {
  const u = await db.one<any>(`SELECT id, email, name, locale FROM users WHERE id = $1`, [userId]);
  const t = await db.one<any>(`SELECT id, slug, name, plan, default_locale FROM tenants WHERE id = $1`, [tenantId]);
  return {
    user: { id: u.id, email: u.email, name: u.name, locale: u.locale },
    tenant: { id: t.id, slug: t.slug, name: t.name, plan: t.plan, defaultLocale: t.default_locale },
  };
}

// ───────────────────────────── 2FA en el ingreso ─────────────────────────────

/** Si el usuario tiene 2FA, crea un desafío y devuelve su token (no se crea sesión todavía). */
export async function createTwoFactorChallenge(db: Db, userId: string, tenantId: string): Promise<TwoFactorChallenge | null> {
  const u = await db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [userId]);
  if (!u?.totp_enabled_at) return null;
  const token = randomToken();
  await db.query(
    `INSERT INTO login_challenges (token_hash, user_id, tenant_id, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')`,
    [sha256Hex(token), userId, tenantId],
  );
  return { twoFactorRequired: true, challengeToken: token };
}

/** Verifica un código TOTP o de recuperación. Consume el código (anti-reutilización). */
async function checkSecondFactor(db: Db, userId: string, code: string): Promise<"totp" | "recovery" | null> {
  const u = await db.one<any>(`SELECT totp_secret_enc, totp_last_step, totp_recovery_hashes FROM users WHERE id = $1`, [userId]);
  if (!u?.totp_secret_enc) return null;
  const step = verifyTotp(decrypt(u.totp_secret_enc), code, { lastStep: u.totp_last_step == null ? null : Number(u.totp_last_step) });
  if (step !== null) {
    const upd = await db.query(
      `UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
      [userId, step],
    );
    return upd.length ? "totp" : null;
  }
  const h = sha256Hex(normalizeRecoveryCode(code));
  const hashes: string[] = u.totp_recovery_hashes ?? [];
  if (hashes.includes(h)) {
    await db.query(`UPDATE users SET totp_recovery_hashes = array_remove(totp_recovery_hashes, $2) WHERE id = $1`, [userId, h]);
    return "recovery";
  }
  return null;
}

// ───────────────────────────── Helpers de roles ─────────────────────────────

async function resolveRole(db: Db, tenantId: string, input: { role: string; roleId?: string | null }) {
  if (input.role !== "custom") return { role: input.role as MemberRole, roleId: null as string | null, roleName: ROLE_LABEL[input.role] ?? input.role };
  const r = await db.one<any>(`SELECT id, name FROM roles WHERE id = $1 AND tenant_id = $2`, [input.roleId, tenantId]);
  if (!r) throw badRequest("invalid_role", "Rol inexistente");
  return { role: "custom" as MemberRole, roleId: r.id as string, roleName: r.name as string };
}

/** Un rol no puede otorgar permisos que quien lo asigna no tiene (salvo propietarios). */
function assertCanGrant(a: AuthContext, target: { role: string }, perms: readonly Permission[]) {
  if (target.role === "owner" && a.access?.role !== "owner") throw forbidden("Solo un propietario puede asignar el rol de propietario");
  if (a.access?.role === "owner") return;
  const missing = perms.filter((p) => !hasPerm(a, p));
  if (missing.length) throw new AppError(403, "forbidden", `No podés otorgar permisos que no tenés: ${missing.join(", ")}`, { missing });
}

async function permsOf(db: Db, tenantId: string, role: string, roleId: string | null): Promise<readonly Permission[]> {
  if (role !== "custom") return BUILTIN_ROLE_PERMISSIONS[role as keyof typeof BUILTIN_ROLE_PERMISSIONS] ?? [];
  const r = await db.one<any>(`SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2`, [roleId, tenantId]);
  return (r?.permissions ?? []) as Permission[];
}

async function ownerCount(db: Db, tenantId: string) {
  const r = await db.one<any>(`SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1 AND role = 'owner'`, [tenantId]);
  return r?.n ?? 0;
}

function invitationStatus(r: any): Invitation["status"] {
  if (r.accepted_at) return "accepted";
  if (r.revoked_at) return "revoked";
  if (new Date(r.expires_at) < new Date()) return "expired";
  return "pending";
}

const INVITE_TEXT = {
  es: {
    subject: (org: string) => `Te invitaron a ${org} en CalaSign`,
    body: (inviter: string, org: string, role: string) => `${inviter} te invitó a sumarte a ${org} en CalaSign con el rol ${role}.`,
    cta: "Aceptar invitación",
    expires: (d: number) => `La invitación vence en ${d} días.`,
  },
  "pt-BR": {
    subject: (org: string) => `Você foi convidado para ${org} na CalaSign`,
    body: (inviter: string, org: string, role: string) => `${inviter} convidou você para participar de ${org} na CalaSign com o perfil ${role}.`,
    cta: "Aceitar convite",
    expires: (d: number) => `O convite expira em ${d} dias.`,
  },
  en: {
    subject: (org: string) => `You've been invited to ${org} on CalaSign`,
    body: (inviter: string, org: string, role: string) => `${inviter} invited you to join ${org} on CalaSign as ${role}.`,
    cta: "Accept invitation",
    expires: (d: number) => `The invitation expires in ${d} days.`,
  },
} as const;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

async function sendInvitationEmail(tenantId: string, to: string, org: string, inviter: string, roleName: string, link: string, localeIn?: string | null) {
  const L = INVITE_TEXT[normLocale(localeIn)];
  const subject = L.subject(org);
  const line = L.body(inviter, org, roleName);
  const text = `${line}\n\n${L.cta}: ${link}\n\n${L.expires(INVITE_DAYS)}`;
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0b1f3a;background:#f3f5f8;padding:24px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:10px;padding:28px">
<p style="font-size:18px;font-weight:bold;margin:0 0 16px">Cala<span style="color:#2ec4b6">Sign</span></p>
<p style="font-size:15px;line-height:1.5">${esc(line)}</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#0f7c7c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold">${esc(L.cta)}</a></p>
<p style="font-size:12px;color:#5b6576">${esc(L.expires(INVITE_DAYS))}<br>${esc(link)}</p></div></body></html>`;
  return deliver({ channel: "email", to, subject, text, html, link, tenantId, locale: localeIn ?? "es" });
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function teamRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  type P = { Params: { id: string; userId?: string; token?: string } };

  // ───────── Acceso de la sesión y cambio de organización ─────────

  app.get("/v1/me/access", { preHandler: auth }, async (req): Promise<AccessResponse> => {
    const a = A(req);
    const acc = a.access!;
    const groups = acc.groupIds.length
      ? await s.db.query<any>(`SELECT id, name FROM groups WHERE id = ANY($1::uuid[]) ORDER BY name`, [acc.groupIds])
      : [];
    let tenants: AccessResponse["tenants"] = [];
    let twoFactor = { enabled: false, requiredByTenant: false, setupRequired: false };
    if (a.userId) {
      const rows = await s.db.query<any>(
        `SELECT t.id, t.name, t.slug, m.role, r.name AS role_name FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN roles r ON r.id = m.role_id WHERE m.user_id = $1 ORDER BY t.name`,
        [a.userId],
      );
      tenants = rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        role: r.role,
        roleName: r.role === "custom" ? r.role_name : ROLE_LABEL[r.role] ?? r.role,
        current: r.id === a.tenantId,
      }));
      const u = await s.db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
      const t = await s.db.one<any>(`SELECT require_2fa FROM tenants WHERE id = $1`, [a.tenantId]);
      twoFactor = { enabled: Boolean(u?.totp_enabled_at), requiredByTenant: Boolean(t?.require_2fa), setupRequired: acc.twoFactorSetupRequired };
    }
    return { role: acc.role, roleName: acc.roleName, permissions: [...acc.permissions], groups, tenants, twoFactor };
  });

  app.post("/v1/auth/switch-tenant", { preHandler: auth }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para sesiones de usuario");
    const { tenantId } = SwitchTenantInput.parse(req.body);
    const m = await s.db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, a.userId]);
    if (!m) throw notFound("Organización");
    await s.db.query(`UPDATE sessions SET tenant_id = $2 WHERE token_hash = $1`, [sha256Hex(req.cookies[SESSION_COOKIE]!), tenantId]);
    await recordAudit(s.db, { tenantId, action: "auth.tenant_switched", actor: { type: "user", id: a.userId, label: a.actor.label }, ...clientInfo(req), data: { from: a.tenantId } });
    return meResponse(s.db, a.userId, tenantId);
  });

  // ───────── Miembros ─────────

  app.get("/v1/members", { preHandler: auth }, async (req) => {
    const a = A(req);
    const rows = await s.db.query<any>(
      `SELECT m.user_id, m.role, m.role_id, m.created_at, u.name, u.email, u.totp_enabled_at, r.name AS role_name
       FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN roles r ON r.id = m.role_id
       WHERE m.tenant_id = $1 ORDER BY u.name`,
      [a.tenantId],
    );
    const gm = await s.db.query<any>(
      `SELECT gm.user_id, g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE g.tenant_id = $1 ORDER BY g.name`,
      [a.tenantId],
    );
    const items: Member[] = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      email: r.email,
      role: r.role,
      roleId: r.role_id,
      roleName: r.role === "custom" ? r.role_name : ROLE_LABEL[r.role] ?? r.role,
      groups: gm.filter((g) => g.user_id === r.user_id).map((g) => ({ id: g.id, name: g.name })),
      twoFactorEnabled: Boolean(r.totp_enabled_at),
      joinedAt: iso(r.created_at)!,
    }));
    return { items };
  });

  app.patch<P>("/v1/members/:userId", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = RoleAssignment.parse(req.body);
    const target = await resolveRole(s.db, a.tenantId, input);
    const cur = await s.db.one<any>(`SELECT role, role_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, req.params.userId]);
    if (!cur) throw notFound("Miembro");
    if (cur.role === "owner" && a.access?.role !== "owner") throw forbidden("Solo un propietario puede cambiar el rol de otro propietario");
    assertCanGrant(a, target, await permsOf(s.db, a.tenantId, target.role, target.roleId));
    await s.db.tx(async (t) => {
      await t.query(`UPDATE memberships SET role = $3, role_id = $4 WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, req.params.userId, target.role, target.roleId]);
      if (cur.role === "owner" && target.role !== "owner" && (await ownerCount(t, a.tenantId)) === 0) {
        throw conflict("last_owner", "La organización tiene que tener al menos un propietario");
      }
    });
    await auditFromRequest(s.db, req, a, "member.role_changed", {
      targetType: "user",
      targetId: req.params.userId,
      data: { from: cur.role === "custom" ? { role: "custom", roleId: cur.role_id } : cur.role, to: target.role === "custom" ? { role: "custom", roleId: target.roleId } : target.role },
    });
    return { ok: true };
  });

  app.delete<P>("/v1/members/:userId", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const userId = req.params.userId!;
    const cur = await s.db.one<any>(`SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, userId]);
    if (!cur) throw notFound("Miembro");
    if (cur.role === "owner" && a.access?.role !== "owner") throw forbidden("Solo un propietario puede quitar a otro propietario");
    await s.db.tx(async (t) => {
      await t.query(`DELETE FROM group_members gm USING groups g WHERE gm.group_id = g.id AND g.tenant_id = $1 AND gm.user_id = $2`, [a.tenantId, userId]);
      await t.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, userId]);
      if (cur.role === "owner" && (await ownerCount(t, a.tenantId)) === 0) throw conflict("last_owner", "La organización tiene que tener al menos un propietario");
      // Cierra sus sesiones en esta organización.
      await t.query(`DELETE FROM sessions WHERE user_id = $1 AND tenant_id = $2`, [userId, a.tenantId]);
    });
    await auditFromRequest(s.db, req, a, "member.removed", { targetType: "user", targetId: userId });
    reply.code(204).send();
  });

  // ───────── Invitaciones ─────────

  const toInvitation = (r: any): Invitation => ({
    id: r.id,
    email: r.email,
    role: r.role,
    roleId: r.role_id,
    roleName: r.role === "custom" ? r.role_name ?? "?" : ROLE_LABEL[r.role] ?? r.role,
    invitedBy: r.invited_by_name ?? null,
    createdAt: iso(r.created_at)!,
    expiresAt: iso(r.expires_at)!,
    status: invitationStatus(r),
  });

  app.get("/v1/invitations", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(
      `SELECT i.*, r.name AS role_name, u.name AS invited_by_name FROM invitations i LEFT JOIN roles r ON r.id = i.role_id
       LEFT JOIN users u ON u.id = i.invited_by WHERE i.tenant_id = $1 ORDER BY i.created_at DESC LIMIT 200`,
      [A(req).tenantId],
    );
    return { items: rows.map(toInvitation) };
  });

  app.post("/v1/invitations", { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = A(req);
    const input = InviteMemberInput.parse(req.body);
    const target = await resolveRole(s.db, a.tenantId, input);
    assertCanGrant(a, target, await permsOf(s.db, a.tenantId, target.role, target.roleId));
    const already = await s.db.one(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND lower(u.email) = lower($2)`,
      [a.tenantId, input.email],
    );
    if (already) throw conflict("already_member", "Esa persona ya es miembro de la organización");
    // Una invitación pendiente por correo: la anterior se revoca.
    await s.db.query(
      `UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL`,
      [a.tenantId, input.email],
    );
    const token = randomToken();
    const id = uuidv7();
    await s.db.query(
      `INSERT INTO invitations (id, tenant_id, email, role, role_id, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${INVITE_DAYS} days')`,
      [id, a.tenantId, input.email, target.role, target.roleId, sha256Hex(token), a.userId],
    );
    const org = await s.db.one<any>(`SELECT name, default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
    const inviter = a.userId ? (await s.db.one<any>(`SELECT name FROM users WHERE id = $1`, [a.userId]))?.name : a.actor.label;
    const acceptUrl = `${config.appUrl}/invite/${token}`;
    await sendInvitationEmail(a.tenantId, input.email, org.name, inviter ?? org.name, target.roleName, acceptUrl, input.locale ?? org.default_locale);
    await auditFromRequest(s.db, req, a, "member.invited", { targetType: "invitation", targetId: id, data: { email: input.email, role: target.role, roleId: target.roleId } });
    const row = await s.db.one<any>(
      `SELECT i.*, r.name AS role_name, u.name AS invited_by_name FROM invitations i LEFT JOIN roles r ON r.id = i.role_id LEFT JOIN users u ON u.id = i.invited_by WHERE i.id = $1`,
      [id],
    );
    reply.code(201);
    return { invitation: toInvitation(row), acceptUrl };
  });

  app.delete<P>("/v1/invitations/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await s.db.query(
      `UPDATE invitations SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email`,
      [req.params.id, a.tenantId],
    );
    if (!r.length) throw notFound("Invitación");
    await auditFromRequest(s.db, req, a, "member.invitation_revoked", { targetType: "invitation", targetId: req.params.id, data: { email: (r[0] as any).email } });
    reply.code(204).send();
  });

  // Pública: vista previa y aceptación por token.
  async function invitationByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound("Invitación");
    const r = await s.db.one<any>(
      `SELECT i.*, t.name AS org_name, r.name AS role_name, u.name AS invited_by_name FROM invitations i JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN roles r ON r.id = i.role_id LEFT JOIN users u ON u.id = i.invited_by WHERE i.token_hash = $1`,
      [sha256Hex(token)],
    );
    if (!r) throw notFound("Invitación");
    return r;
  }

  app.get<P>("/v1/invite/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<InvitationPreview> => {
    const r = await invitationByToken(req.params.token!);
    const existing = await s.db.one(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [r.email]);
    return {
      organizationName: r.org_name,
      email: r.email,
      roleName: r.role === "custom" ? r.role_name : ROLE_LABEL[r.role] ?? r.role,
      invitedByName: r.invited_by_name,
      existingAccount: Boolean(existing),
      status: invitationStatus(r),
    };
  });

  app.post<P>("/v1/invite/:token/accept", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = AcceptInvitationInput.parse(req.body ?? {});
    const inv = await invitationByToken(req.params.token!);
    const status = invitationStatus(inv);
    if (status !== "pending") throw new AppError(410, `invitation_${status}`, "La invitación ya no es válida");

    // ¿Hay sesión iniciada con ese mismo correo?
    let sessionUserId: string | null = null;
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      const srow = await s.db.one<any>(
        `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [sha256Hex(cookie)],
      );
      if (srow && srow.email.toLowerCase() === inv.email.toLowerCase()) sessionUserId = srow.id;
    }

    let user = await s.db.one<any>(`SELECT id, password_hash, totp_enabled_at FROM users WHERE lower(email) = lower($1)`, [inv.email]);
    let verifiedByPassword = false;
    if (user && !sessionUserId) {
      if (!input.password || !(await verifyPassword(input.password, user.password_hash))) throw unauthorized();
      verifiedByPassword = true;
    }
    if (!user) {
      if (!input.name || !input.password) throw badRequest("account_required", "Para crear la cuenta hacen falta nombre y contraseña");
      if (input.password.length < 10) throw badRequest("weak_password", "La contraseña debe tener al menos 10 caracteres");
      const id = uuidv7();
      const org = await s.db.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [inv.tenant_id]);
      await s.db.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,$3,$4,$5)`, [
        id,
        inv.email,
        input.name,
        await hashPassword(input.password),
        org?.default_locale ?? "es",
      ]);
      user = { id, totp_enabled_at: null };
    }

    await s.db.tx(async (t) => {
      const upd = await t.query(
        `UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
        [inv.id, user.id],
      );
      if (!upd.length) throw new AppError(410, "invitation_used", "La invitación ya fue usada");
      await t.query(
        `INSERT INTO memberships (tenant_id, user_id, role, role_id) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
        [inv.tenant_id, user.id, inv.role, inv.role_id],
      );
    });
    await recordAudit(s.db, {
      tenantId: inv.tenant_id,
      action: "member.joined",
      actor: { type: "user", id: user.id, label: inv.email },
      targetType: "invitation",
      targetId: inv.id,
      data: { role: inv.role, roleId: inv.role_id },
      ...clientInfo(req),
    });

    // Si entró con contraseña y tiene 2FA, falta el segundo factor antes de crear la sesión.
    if (verifiedByPassword && user.totp_enabled_at) {
      return createTwoFactorChallenge(s.db, user.id, inv.tenant_id);
    }
    if (sessionUserId) {
      await s.db.query(`UPDATE sessions SET tenant_id = $2 WHERE token_hash = $1`, [sha256Hex(cookie!), inv.tenant_id]);
    } else {
      await createUserSession(s.db, req, reply, user.id, inv.tenant_id);
    }
    return meResponse(s.db, user.id, inv.tenant_id);
  });

  // ───────── Roles personalizados ─────────

  const toRole = (r: any): CustomRole => ({
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    memberCount: Number(r.member_count ?? 0),
    createdAt: iso(r.created_at)!,
  });

  app.get("/v1/roles", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(
      `SELECT r.*, (SELECT count(*) FROM memberships m WHERE m.role_id = r.id) + (SELECT count(*) FROM api_keys k WHERE k.role_id = r.id AND k.revoked_at IS NULL) AS member_count
       FROM roles r WHERE r.tenant_id = $1 ORDER BY r.name`,
      [A(req).tenantId],
    );
    return {
      items: rows.map(toRole),
      builtin: (["owner", "admin", "member"] as const).map((k) => ({ role: k, name: ROLE_LABEL[k], permissions: BUILTIN_ROLE_PERMISSIONS[k] })),
    };
  });

  app.post("/v1/roles", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateRoleInput.parse(req.body);
    assertCanGrant(a, { role: "custom" }, input.permissions);
    const id = uuidv7();
    try {
      await s.db.query(`INSERT INTO roles (id, tenant_id, name, description, permissions) VALUES ($1,$2,$3,$4,$5)`, [
        id,
        a.tenantId,
        input.name,
        input.description ?? null,
        [...new Set(input.permissions)],
      ]);
    } catch (e) {
      if (/roles_tenant_name_uq/.test(String(e))) throw conflict("role_exists", "Ya existe un rol con ese nombre");
      throw e;
    }
    await auditFromRequest(s.db, req, a, "role.created", { targetType: "role", targetId: id, data: { name: input.name, permissions: input.permissions } });
    reply.code(201);
    return toRole(await s.db.one(`SELECT *, 0 AS member_count FROM roles WHERE id = $1`, [id]));
  });

  app.patch<P>("/v1/roles/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateRoleInput.parse(req.body);
    const cur = await s.db.one<any>(`SELECT * FROM roles WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!cur) throw notFound("Rol");
    if (input.permissions) assertCanGrant(a, { role: "custom" }, input.permissions);
    try {
      await s.db.query(
        `UPDATE roles SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           permissions = COALESCE($5, permissions), updated_at = now() WHERE id = $1`,
        [cur.id, input.name ?? null, input.description !== undefined, input.description ?? null, input.permissions ? [...new Set(input.permissions)] : null],
      );
    } catch (e) {
      if (/roles_tenant_name_uq/.test(String(e))) throw conflict("role_exists", "Ya existe un rol con ese nombre");
      throw e;
    }
    await auditFromRequest(s.db, req, a, "role.updated", { targetType: "role", targetId: cur.id, data: { from: cur.permissions, to: input.permissions ?? cur.permissions } });
    return toRole(await s.db.one(`SELECT *, 0 AS member_count FROM roles WHERE id = $1`, [cur.id]));
  });

  app.delete<P>("/v1/roles/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const used = await s.db.one(
      `SELECT 1 FROM memberships WHERE role_id = $1 UNION ALL SELECT 1 FROM api_keys WHERE role_id = $1 AND revoked_at IS NULL
       UNION ALL SELECT 1 FROM invitations WHERE role_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1`,
      [req.params.id],
    );
    if (used) throw conflict("role_in_use", "El rol está asignado: cambiá esos miembros, API keys o invitaciones primero");
    const r = await s.db.query(`DELETE FROM roles WHERE id = $1 AND tenant_id = $2 RETURNING name`, [req.params.id, a.tenantId]);
    if (!r.length) throw notFound("Rol");
    await auditFromRequest(s.db, req, a, "role.deleted", { targetType: "role", targetId: req.params.id, data: { name: (r[0] as any).name } });
    reply.code(204).send();
  });

  // ───────── Rol de las API keys ─────────

  app.get("/v1/api-keys/roles", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(
      `SELECT k.id, k.role, k.role_id, r.name AS role_name FROM api_keys k LEFT JOIN roles r ON r.id = k.role_id WHERE k.tenant_id = $1`,
      [A(req).tenantId],
    );
    return { items: rows.map((r) => ({ id: r.id, role: r.role, roleId: r.role_id, roleName: r.role === "custom" ? r.role_name : ROLE_LABEL[r.role] ?? r.role })) };
  });

  app.patch<P>("/v1/api-keys/:id/role", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = RoleAssignment.parse(req.body);
    if (input.role === "owner") throw badRequest("invalid_role", "Una API key no puede ser propietaria");
    const target = await resolveRole(s.db, a.tenantId, input);
    assertCanGrant(a, target, await permsOf(s.db, a.tenantId, target.role, target.roleId));
    const r = await s.db.query(`UPDATE api_keys SET role = $3, role_id = $4 WHERE id = $1 AND tenant_id = $2 RETURNING id`, [
      req.params.id,
      a.tenantId,
      target.role,
      target.roleId,
    ]);
    if (!r.length) throw notFound("API key");
    await auditFromRequest(s.db, req, a, "api_key.role_changed", { targetType: "api_key", targetId: req.params.id, data: { role: target.role, roleId: target.roleId } });
    return { id: req.params.id, role: target.role, roleId: target.roleId, roleName: target.roleName };
  });

  // ───────── Grupos ─────────

  async function loadGroups(tenantId: string, id?: string): Promise<Group[]> {
    const groups = await s.db.query<any>(
      `SELECT * FROM groups WHERE tenant_id = $1 ${id ? "AND id = $2" : ""} ORDER BY name`,
      id ? [tenantId, id] : [tenantId],
    );
    const ids = groups.map((g) => g.id);
    const members = ids.length
      ? await s.db.query<any>(
          `SELECT gm.group_id, u.id, u.name, u.email FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ANY($1::uuid[]) ORDER BY u.name`,
          [ids],
        )
      : [];
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      createdAt: iso(g.created_at)!,
      members: members.filter((m) => m.group_id === g.id).map((m) => ({ userId: m.id, name: m.name, email: m.email })),
    }));
  }

  async function setGroupMembers(db: Db, tenantId: string, groupId: string, userIds: string[]) {
    const unique = [...new Set(userIds)];
    if (unique.length) {
      const ok = await db.query<any>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`, [tenantId, unique]);
      if (ok.length !== unique.length) throw badRequest("invalid_member", "Algún usuario no es miembro de la organización");
    }
    await db.query(`DELETE FROM group_members WHERE group_id = $1`, [groupId]);
    for (const u of unique) await db.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1,$2)`, [groupId, u]);
  }

  app.get("/v1/groups", { preHandler: auth }, async (req) => ({ items: await loadGroups(A(req).tenantId) }));

  app.get<P>("/v1/groups/:id", { preHandler: auth }, async (req) => {
    const [g] = await loadGroups(A(req).tenantId, req.params.id);
    if (!g) throw notFound("Grupo");
    return g;
  });

  app.post("/v1/groups", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateGroupInput.parse(req.body);
    const id = uuidv7();
    try {
      await s.db.tx(async (t) => {
        await t.query(`INSERT INTO groups (id, tenant_id, name, description) VALUES ($1,$2,$3,$4)`, [id, a.tenantId, input.name, input.description ?? null]);
        await setGroupMembers(t, a.tenantId, id, input.memberIds ?? []);
      });
    } catch (e) {
      if (/groups_tenant_name_uq/.test(String(e))) throw conflict("group_exists", "Ya existe un grupo con ese nombre");
      throw e;
    }
    await auditFromRequest(s.db, req, a, "group.created", { targetType: "group", targetId: id, data: { name: input.name, members: input.memberIds?.length ?? 0 } });
    reply.code(201);
    return (await loadGroups(a.tenantId, id))[0];
  });

  app.patch<P>("/v1/groups/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateGroupInput.parse(req.body);
    const cur = await s.db.one<any>(`SELECT id FROM groups WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!cur) throw notFound("Grupo");
    try {
      await s.db.tx(async (t) => {
        await t.query(
          `UPDATE groups SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END WHERE id = $1`,
          [cur.id, input.name ?? null, input.description !== undefined, input.description ?? null],
        );
        if (input.memberIds) await setGroupMembers(t, a.tenantId, cur.id, input.memberIds);
      });
    } catch (e) {
      if (/groups_tenant_name_uq/.test(String(e))) throw conflict("group_exists", "Ya existe un grupo con ese nombre");
      throw e;
    }
    await auditFromRequest(s.db, req, a, "group.updated", { targetType: "group", targetId: cur.id, data: { fields: Object.keys(input) } });
    return (await loadGroups(a.tenantId, cur.id))[0];
  });

  app.delete<P>("/v1/groups/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await s.db.query(`DELETE FROM groups WHERE id = $1 AND tenant_id = $2 RETURNING name`, [req.params.id, a.tenantId]);
    if (!r.length) throw notFound("Grupo");
    await auditFromRequest(s.db, req, a, "group.deleted", { targetType: "group", targetId: req.params.id, data: { name: (r[0] as any).name } });
    reply.code(204).send();
  });

  // ───────── Compartir sobres y plantillas con grupos ─────────

  async function validGroups(tenantId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const rows = await s.db.query<any>(`SELECT id, name FROM groups WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, unique]);
    if (rows.length !== unique.length) throw badRequest("invalid_group", "Algún grupo no existe");
    return rows;
  }

  app.get<P>("/v1/envelopes/:id/shares", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(
      `SELECT g.id, g.name FROM envelope_shares es JOIN groups g ON g.id = es.group_id WHERE es.envelope_id = $1 ORDER BY g.name`,
      [req.params.id],
    );
    return { groups: rows };
  });

  app.put<P>("/v1/envelopes/:id/shares", { preHandler: auth }, async (req) => {
    const a = A(req);
    const { groupIds } = PutSharesInput.parse(req.body);
    const groups = await validGroups(a.tenantId, groupIds);
    await s.db.tx(async (t) => {
      await t.query(`DELETE FROM envelope_shares WHERE envelope_id = $1`, [req.params.id]);
      for (const g of groups) await t.query(`INSERT INTO envelope_shares (envelope_id, group_id) VALUES ($1,$2)`, [req.params.id, g.id]);
    });
    await auditFromRequest(s.db, req, a, "envelope.shared", { targetType: "envelope", targetId: req.params.id, data: { groups: groups.map((g) => g.name) } });
    return { groups: groups.map((g) => ({ id: g.id, name: g.name })) };
  });

  app.get<P>("/v1/templates/:id/shares", { preHandler: auth }, async (req) => {
    const t = await s.db.one<any>(`SELECT visibility FROM templates WHERE id = $1`, [req.params.id]);
    const rows = await s.db.query<any>(
      `SELECT g.id, g.name FROM template_shares ts JOIN groups g ON g.id = ts.group_id WHERE ts.template_id = $1 ORDER BY g.name`,
      [req.params.id],
    );
    return { groups: rows, visibility: t?.visibility ?? "organization" };
  });

  app.put<P>("/v1/templates/:id/shares", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = PutTemplateSharesInput.parse(req.body);
    const groups = await validGroups(a.tenantId, input.groupIds);
    await s.db.tx(async (t) => {
      if (input.visibility) await t.query(`UPDATE templates SET visibility = $2, updated_at = now() WHERE id = $1`, [req.params.id, input.visibility]);
      await t.query(`DELETE FROM template_shares WHERE template_id = $1`, [req.params.id]);
      for (const g of groups) await t.query(`INSERT INTO template_shares (template_id, group_id) VALUES ($1,$2)`, [req.params.id, g.id]);
    });
    const t = await s.db.one<any>(`SELECT visibility FROM templates WHERE id = $1`, [req.params.id]);
    await auditFromRequest(s.db, req, a, "template.shared", {
      targetType: "template",
      targetId: req.params.id,
      data: { visibility: t.visibility, groups: groups.map((g) => g.name) },
    });
    return { groups: groups.map((g) => ({ id: g.id, name: g.name })), visibility: t.visibility };
  });

  // ───────── Seguridad y retención ─────────

  app.get("/v1/settings/security", { preHandler: auth }, async (req) => {
    const t = await s.db.one<any>(`SELECT retention_days, require_2fa FROM tenants WHERE id = $1`, [A(req).tenantId]);
    return { retentionDays: t.retention_days, require2fa: t.require_2fa };
  });

  app.patch("/v1/settings/security", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateSecuritySettingsInput.parse(req.body);
    if (input.require2fa && a.userId) {
      // Evita que quien lo activa quede bloqueado.
      const u = await s.db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
      if (!u?.totp_enabled_at) throw conflict("enable_2fa_first", "Activá tu verificación en dos pasos antes de exigirla a la organización");
    }
    await s.db.query(
      `UPDATE tenants SET retention_days = CASE WHEN $2::boolean THEN $3 ELSE retention_days END, require_2fa = COALESCE($4, require_2fa) WHERE id = $1`,
      [a.tenantId, input.retentionDays !== undefined, input.retentionDays ?? null, input.require2fa ?? null],
    );
    const t = await s.db.one<any>(`SELECT retention_days, require_2fa FROM tenants WHERE id = $1`, [a.tenantId]);
    return { retentionDays: t.retention_days, require2fa: t.require_2fa };
  });

  // ───────── 2FA del usuario ─────────

  app.post("/v1/me/2fa/setup", { preHandler: auth }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para usuarios");
    const u = await s.db.one<any>(`SELECT email, totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
    if (u.totp_enabled_at) throw conflict("2fa_already_enabled", "La verificación en dos pasos ya está activa");
    const secret = generateTotpSecret();
    await s.db.query(`UPDATE users SET totp_pending_enc = $2 WHERE id = $1`, [a.userId, encrypt(secret)]);
    const url = otpauthUrl(secret, u.email);
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, otpauthUrl: url, qrSvg };
  });

  app.post("/v1/me/2fa/enable", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para usuarios");
    const { code } = TotpCodeInput.parse(req.body);
    const u = await s.db.one<any>(`SELECT totp_pending_enc, totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
    if (u.totp_enabled_at) throw conflict("2fa_already_enabled", "La verificación en dos pasos ya está activa");
    if (!u.totp_pending_enc) throw badRequest("2fa_setup_required", "Primero generá el código QR");
    const secret = decrypt(u.totp_pending_enc);
    const step = verifyTotp(secret, code);
    if (step === null) throw badRequest("invalid_code", "Código incorrecto");
    const codes = generateRecoveryCodes();
    await s.db.query(
      `UPDATE users SET totp_secret_enc = $2, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $3, totp_recovery_hashes = $4 WHERE id = $1`,
      [a.userId, encrypt(secret), step, codes.map((c) => sha256Hex(normalizeRecoveryCode(c)))],
    );
    await auditFromRequest(s.db, req, a, "user.2fa_enabled", { targetType: "user", targetId: a.userId });
    return { recoveryCodes: codes };
  });

  app.post("/v1/me/2fa/disable", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para usuarios");
    const { code } = TotpCodeInput.parse(req.body);
    const required = await s.db.one(
      `SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND t.require_2fa LIMIT 1`,
      [a.userId],
    );
    if (required) throw conflict("2fa_required_by_tenant", "Alguna de tus organizaciones exige verificación en dos pasos");
    if (!(await checkSecondFactor(s.db, a.userId, code))) throw badRequest("invalid_code", "Código incorrecto");
    await s.db.query(
      `UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_recovery_hashes = '{}', totp_last_step = NULL WHERE id = $1`,
      [a.userId],
    );
    await auditFromRequest(s.db, req, a, "user.2fa_disabled", { targetType: "user", targetId: a.userId });
    return { ok: true };
  });

  app.post("/v1/me/2fa/recovery-codes", { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para usuarios");
    const { code } = TotpCodeInput.parse(req.body);
    if ((await checkSecondFactor(s.db, a.userId, code)) !== "totp") throw badRequest("invalid_code", "Código incorrecto");
    const codes = generateRecoveryCodes();
    await s.db.query(`UPDATE users SET totp_recovery_hashes = $2 WHERE id = $1`, [a.userId, codes.map((c) => sha256Hex(normalizeRecoveryCode(c)))]);
    await auditFromRequest(s.db, req, a, "user.2fa_recovery_regenerated", { targetType: "user", targetId: a.userId });
    return { recoveryCodes: codes };
  });

  // Segundo paso del ingreso.
  app.post("/v1/auth/2fa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = TwoFactorLoginInput.parse(req.body);
    const ch = await s.db.one<any>(`SELECT * FROM login_challenges WHERE token_hash = $1 AND expires_at > now()`, [sha256Hex(input.challengeToken)]);
    if (!ch) throw new AppError(401, "challenge_expired", "El ingreso venció: volvé a ingresar tu contraseña");
    if (ch.attempts >= 5) {
      await s.db.query(`DELETE FROM login_challenges WHERE token_hash = $1`, [ch.token_hash]);
      throw new AppError(401, "too_many_attempts", "Demasiados intentos: volvé a ingresar tu contraseña");
    }
    const method = await checkSecondFactor(s.db, ch.user_id, input.code);
    const u = await s.db.one<any>(`SELECT email FROM users WHERE id = $1`, [ch.user_id]);
    if (!method) {
      await s.db.query(`UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = $1`, [ch.token_hash]);
      await recordAudit(s.db, { tenantId: ch.tenant_id, action: "auth.login_failed", actor: { type: "anonymous", id: ch.user_id, label: u?.email }, data: { reason: "bad_2fa_code" }, ...clientInfo(req) });
      throw new AppError(401, "invalid_code", "Código incorrecto");
    }
    await s.db.query(`DELETE FROM login_challenges WHERE token_hash = $1`, [ch.token_hash]);
    await createUserSession(s.db, req, reply, ch.user_id, ch.tenant_id);
    await recordAudit(s.db, { tenantId: ch.tenant_id, action: "auth.login", actor: { type: "user", id: ch.user_id, label: u?.email }, data: { twoFactor: method }, ...clientInfo(req) });
    return meResponse(s.db, ch.user_id, ch.tenant_id);
  });

  // ───────── Hooks: dueño de sobres creados por API key; rol al crear una API key ─────────

  app.addHook("onSend", async (req, reply, payload) => {
    if (reply.statusCode >= 300 || req.method !== "POST" || !req.auth || typeof payload !== "string") return payload;
    const url = req.routeOptions?.url ?? "";
    try {
      if (req.auth.apiKeyId && url.startsWith("/v1/envelopes") && !url.includes(":")) {
        const id = JSON.parse(payload)?.envelope?.id;
        if (id) await s.db.query(`UPDATE envelopes SET created_by_api_key = $2 WHERE id = $1 AND tenant_id = $3 AND created_by_api_key IS NULL`, [id, req.auth.apiKeyId, req.auth.tenantId]);
      }
      if (url === "/v1/api-keys") {
        const body = req.body as any;
        const keyId = JSON.parse(payload)?.apiKey?.id;
        if (keyId && body?.role && body.role !== "admin") {
          const parsed = RoleAssignment.safeParse({ role: body.role, roleId: body.roleId ?? null });
          if (parsed.success && parsed.data.role !== "owner") {
            const target = await resolveRole(s.db, req.auth.tenantId, parsed.data);
            assertCanGrant(req.auth, target, await permsOf(s.db, req.auth.tenantId, target.role, target.roleId));
            await s.db.query(`UPDATE api_keys SET role = $2, role_id = $3 WHERE id = $1`, [keyId, target.role, target.roleId]);
          }
        }
      }
    } catch (err) {
      req.log.error({ err }, "post-proceso de equipos falló");
    }
    return payload;
  });
}
