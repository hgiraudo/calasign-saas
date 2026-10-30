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
  ReauthInput,
  TotpCodeInput,
  TotpReauthInput,
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
import { AppError, assertNotStale, badRequest, conflict, forbidden, notFound, unauthorized } from "../lib/errors";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from "../lib/totp";
import { decrypt, encrypt, hashPassword, iso, maskDestination, randomToken, sha256Hex, uuidv7, verifyPassword } from "../lib/util";
import { isSuppressed, sendTracked } from "../notifications/outbound";
import { normLocale, render } from "../notifications/templates";
import { mailBranding, resolveBrand, senderFor } from "./white-label/brand";
import { hasPerm } from "./access";
import { auditFromRequest, recordAudit } from "./audit";
import { authenticate, clientInfo, sessionAliveSql, sessionCookieToken, type AuthContext, type Services } from "./context";
import { assertSessionAllowed } from "./identity/sso";
import { assertInvitationCapacity, tenantPlan } from "./billing/plans";
import { actingPerson, clearConsoleRemoval, recordConsoleRemoval, revokeMemberAccess } from "./member-access";
import { clearLoginAttempts, clearTwoFactorAttempts, passwordAccepted, takeLoginAttempt, takeTwoFactorAttempt } from "./login-attempts";
import { assertRecentAuth, openPasswordSession } from "./sessions";
import { enqueueSecurityNotice } from "./security-notices";
import { assertPasswordStrength } from "../lib/password-policy";

const INVITE_DAYS = 7;
const ROLE_LABEL: Record<string, string> = { owner: "Propietario", admin: "Administrador", member: "Miembro" };
const ROLE_LABEL_I18N = {
  es: ROLE_LABEL,
  "pt-BR": { owner: "Proprietário", admin: "Administrador", member: "Membro" },
  en: { owner: "Owner", admin: "Administrator", member: "Member" },
} as const;

// ───────────────────────────── Sesiones ─────────────────────────────

export async function createUserSession(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  tenantId: string,
  opts: { rememberMe?: boolean } = {},
) {
  await openPasswordSession(db, req, reply, userId, tenantId, opts);
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

/**
 * Si el usuario tiene 2FA, crea un desafío y devuelve su token (no se crea sesión todavía). `invitationId`: el
 * desafío viene de aceptar una invitación, que se acepta recién al verificar el segundo factor.
 */
export async function createTwoFactorChallenge(
  db: Db,
  userId: string,
  tenantId: string,
  invitationId: string | null = null,
  opts: { rememberMe?: boolean } = {},
): Promise<TwoFactorChallenge | null> {
  const u = await db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [userId]);
  if (!u?.totp_enabled_at) return null;
  const token = randomToken();
  await db.query(
    `INSERT INTO login_challenges (token_hash, user_id, tenant_id, invitation_id, expires_at, remember) VALUES ($1,$2,$3,$4, now() + interval '10 minutes', $5)`,
    [sha256Hex(token), userId, tenantId, invitationId, opts.rememberMe === true],
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
  // Consumo atómico: el mismo código de recuperación no sirve en dos pedidos simultáneos.
  const used = await db.query(
    `UPDATE users SET totp_recovery_hashes = array_remove(totp_recovery_hashes, $2) WHERE id = $1 AND $2 = ANY(totp_recovery_hashes) RETURNING id`,
    [userId, h],
  );
  return used.length ? "recovery" : null;
}

// Bloqueo por intentos de ingreso: login-attempts.ts (se reexporta para los módulos que lo importaban de acá).
export { MAX_FAILED_LOGINS, clearLoginAttempts, takeLoginAttempt } from "./login-attempts";

// ───────────────────────────── Helpers de roles ─────────────────────────────

async function resolveRole(db: Db, tenantId: string, input: { role: string; roleId?: string | null }) {
  if (input.role !== "custom")
    return { role: input.role as MemberRole, roleId: null as string | null, roleName: ROLE_LABEL[input.role] ?? input.role };
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

/**
 * Cambiar el rol de un miembro, quitarlo o editar un rol que ya tiene permisos: solo si quien lo hace tiene todos los
 * permisos actuales (salvo propietarios). Si no, un rol personalizado con members:manage quitaba o bajaba de rol a
 * un administrador (o le recortaba un rol personalizado) aunque tuviera menos permisos que él.
 */
function assertCanManage(a: AuthContext, current: readonly Permission[], what: string) {
  if (a.access?.role === "owner") return;
  const missing = current.filter((p) => !hasPerm(a, p));
  if (missing.length) throw new AppError(403, "forbidden", `No podés ${what}: tiene permisos que vos no tenés (${missing.join(", ")})`, { missing });
}

/**
 * Revocar una API key o cambiarle el rol: como con los miembros, solo si quien lo hace tiene todos sus permisos
 * actuales (salvo propietarios, y salvo la propia key). Si no, un rol con api_keys:manage revocaba o bajaba a "member"
 * la key de administración de una integración aunque tuviera menos permisos que ella.
 */
export async function assertCanManageApiKey(db: Db, a: AuthContext, keyId: string) {
  if (a.apiKeyId === keyId) return;
  const k = await db.one<any>(`SELECT role, role_id FROM api_keys WHERE id = $1 AND tenant_id = $2 AND oauth_client_id IS NULL`, [keyId, a.tenantId]);
  if (!k) return; // la ruta responde 404
  assertCanManage(a, await permsOf(db, a.tenantId, k.role, k.role_id), "administrar esta API key");
}

/**
 * Sumar personas a un grupo les da acceso a lo que se compartió con él (sobres y plantillas restringidas): como con
 * los roles, no se otorga lo que uno no tiene. Lo hace un propietario, un miembro del grupo (ya ve todo lo compartido)
 * o quien ve todos los sobres y administra las plantillas. Si no, un rol con members:manage se sumaba a sí mismo a un
 * grupo ajeno y veía los sobres compartidos con él.
 */
async function assertCanAddToGroup(db: Db, a: AuthContext, groupId: string, userIds: string[]) {
  if (a.access?.role === "owner" || (hasPerm(a, "envelopes:view_all") && hasPerm(a, "templates:manage"))) return;
  const cur = new Set((await db.query<any>(`SELECT user_id FROM group_members WHERE group_id = $1`, [groupId])).map((r) => r.user_id as string));
  if (!userIds.some((u) => !cur.has(u))) return;
  if (a.userId && cur.has(a.userId)) return;
  throw new AppError(
    403,
    "forbidden",
    "Sumar personas a este grupo les da acceso a lo que se compartió con él: lo hace un miembro del grupo o quien ve todos los sobres y plantillas",
    {
      permission: "envelopes:view_all",
    },
  );
}

async function permsOf(db: Db, tenantId: string, role: string, roleId: string | null): Promise<readonly Permission[]> {
  if (role !== "custom") return BUILTIN_ROLE_PERMISSIONS[role as keyof typeof BUILTIN_ROLE_PERMISSIONS] ?? [];
  const r = await db.one<any>(`SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2`, [roleId, tenantId]);
  return (r?.permissions ?? []) as Permission[];
}

/** Dentro de la transacción (con el tenant bloqueado): el miembro sigue con el rol que vieron los chequeos de permisos. */
async function assertSameRole(t: Db, tenantId: string, userId: string, cur: { role: string; role_id: string | null }) {
  const now = await t.one<any>(`SELECT role, role_id FROM memberships WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`, [tenantId, userId]);
  if (!now) throw notFound("Miembro");
  if (now.role !== cur.role || (now.role_id ?? null) !== (cur.role_id ?? null)) {
    throw conflict("member_changed", "El rol del miembro cambió mientras tanto: volvé a cargar y probá de nuevo");
  }
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

const INVITE_HEADING = { es: "Invitación al equipo", "pt-BR": "Convite para a equipe", en: "Team invitation" } as const;

/**
 * Correo de invitación con la marca de la organización (colores, logo, plantilla, marca blanca) y su remitente (dominio
 * de correo propio si lo tiene), como los demás avisos a la organización (webhooks.ts notifyWebhookDeactivated).
 */
export async function sendInvitationEmail(
  db: Db,
  tenantId: string,
  to: string,
  org: string,
  inviter: string,
  roleName: string,
  link: string,
  localeIn?: string | null,
) {
  const locale = normLocale(localeIn);
  const wl = await resolveBrand(db, tenantId, null);
  const sendAs = await senderFor(db, wl);
  const m = render(
    "team_invitation",
    locale,
    { recipientName: "", senderName: inviter, organizationName: org, subject: INVITE_HEADING[locale], detail: roleName, days: INVITE_DAYS, link },
    mailBranding(wl, null, locale),
  );
  // Registrado en notifications (con la organización): un rebote o una queja de este correo se atribuye a ella.
  const out = await sendTracked(
    db,
    { tenantId, template: "invitation" },
    {
      channel: "email",
      to,
      subject: m.subject,
      text: m.text,
      html: m.html,
      link,
      tenantId,
      locale,
      from: sendAs.from,
      replyTo: sendAs.replyTo,
      dkim: sendAs.dkim,
      fallbackFrom: sendAs.fallbackFrom,
    },
  );
  if (out.status === "failed") throw new Error(`no se pudo enviar la invitación: ${out.error}`);
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
      // Una sesión SSO o un token OAuth valen solo en su organización: no listan las demás de la cuenta. Si no, el IdP
      // de una organización (que puede afirmar el correo de un miembro) o una app autorizada en ella veían en qué otras
      // organizaciones está esa persona y con qué rol.
      const onlyCurrent = Boolean(a.oauth) || (await sessionAuthMethod(req)) === "sso";
      const rows = await s.db.query<any>(
        `SELECT t.id, t.name, t.slug, m.role, r.name AS role_name FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN roles r ON r.id = m.role_id WHERE m.user_id = $1 AND (NOT $2 OR m.tenant_id = $3) ORDER BY t.name`,
        [a.userId, onlyCurrent, a.tenantId],
      );
      tenants = rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        role: r.role,
        roleName: r.role === "custom" ? r.role_name : (ROLE_LABEL[r.role] ?? r.role),
        current: r.id === a.tenantId,
      }));
      const u = await s.db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
      const t = await s.db.one<any>(`SELECT require_2fa FROM tenants WHERE id = $1`, [a.tenantId]);
      twoFactor = { enabled: Boolean(u?.totp_enabled_at), requiredByTenant: Boolean(t?.require_2fa), setupRequired: acc.twoFactorSetupRequired };
    }
    const { plan } = await tenantPlan(s.db, a.tenantId);
    return {
      role: acc.role,
      roleName: acc.roleName,
      permissions: [...acc.permissions],
      groups,
      tenants,
      twoFactor,
      planFeatures: [...plan.features],
      planName: plan.name,
    };
  });

  app.post("/v1/auth/switch-tenant", { preHandler: auth }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para sesiones de usuario");
    const { tenantId } = SwitchTenantInput.parse(req.body);
    const m = await s.db.one<any>(`SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, a.userId]);
    if (!m) throw notFound("Organización");
    // SSO (Fase 5): una sesión SSO no cambia de organización; una con contraseña no entra a una que exige SSO.
    // Solo una sesión web (cookie) cambia de organización; un token OAuth/API no tiene sesión que mover.
    const cookie = sessionCookieToken(req);
    if (!cookie) throw forbidden("Solo para sesiones de usuario");
    const sess = await s.db.one<any>(`SELECT user_id, auth_method, sso_tenant_id FROM sessions WHERE token_hash = $1`, [sha256Hex(cookie)]);
    if (!sess || sess.user_id !== a.userId) throw forbidden("Solo para sesiones de usuario");
    await assertSessionAllowed(
      s.db,
      { authMethod: sess?.auth_method ?? "password", ssoTenantId: sess?.sso_tenant_id ?? null, userId: a.userId },
      tenantId,
      m.role,
    );
    await s.db.query(`UPDATE sessions SET tenant_id = $2 WHERE token_hash = $1`, [sha256Hex(cookie), tenantId]);
    await recordAudit(s.db, {
      tenantId,
      action: "auth.tenant_switched",
      actor: { type: "user", id: a.userId, label: a.actor.label },
      ...clientInfo(req),
      data: { from: a.tenantId },
    });
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
      roleName: r.role === "custom" ? r.role_name : (ROLE_LABEL[r.role] ?? r.role),
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
    assertCanManage(a, await permsOf(s.db, a.tenantId, cur.role, cur.role_id), "cambiar el rol de este miembro");
    assertCanGrant(a, target, await permsOf(s.db, a.tenantId, target.role, target.roleId));
    let revoked: Awaited<ReturnType<typeof revokeMemberAccess>> | null = null;
    await s.db.tx(async (t) => {
      // Serializa los cambios de propietarios de la organización: dos bajas simultáneas no la dejan sin ninguno.
      await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [a.tenantId]);
      // Los chequeos de arriba vieron el rol antes del bloqueo: si cambió mientras tanto (p. ej. lo hicieron propietario),
      // no se aplica sobre una foto vieja.
      await assertSameRole(t, a.tenantId, req.params.userId!, cur);
      await t.query(`UPDATE memberships SET role = $3, role_id = $4 WHERE tenant_id = $1 AND user_id = $2`, [
        a.tenantId,
        req.params.userId,
        target.role,
        target.roleId,
      ]);
      if (cur.role === "owner" && target.role !== "owner" && (await ownerCount(t, a.tenantId)) === 0) {
        throw conflict("last_owner", "La organización tiene que tener al menos un propietario");
      }
      // Con menos permisos que antes: las credenciales que creó con el rol anterior (API keys, apps de servicio, tokens
      // SCIM, invitaciones pendientes) tenían esos permisos y los conservaban. Se revocan, como en una baja.
      // Dejar de ser propietario también es una reducción aunque la lista de permisos sea la misma (propietario →
      // administrador): sin esto conservaba, p. ej., una invitación de propietario que se mandó a otro correo propio y,
      // al aceptarla, recuperaba la propiedad. revokeMemberAccess revoca todas las invitaciones pendientes que mandó.
      const before = await permsOf(t, a.tenantId, cur.role, cur.role_id);
      const after = new Set(await permsOf(t, a.tenantId, target.role, target.roleId));
      const demotedOwner = cur.role === "owner" && target.role !== "owner";
      if (demotedOwner || before.some((p) => !after.has(p)))
        revoked = await revokeMemberAccess(t, a.tenantId, req.params.userId!, { removal: false });
    });
    const rv = revoked as Awaited<ReturnType<typeof revokeMemberAccess>> | null;
    await auditFromRequest(s.db, req, a, "member.role_changed", {
      targetType: "user",
      targetId: req.params.userId,
      data: {
        from: cur.role === "custom" ? { role: "custom", roleId: cur.role_id } : cur.role,
        to: target.role === "custom" ? { role: "custom", roleId: target.roleId } : target.role,
        ...(rv && (rv.keys.length || rv.invitations || rv.serviceApps.length || rv.scimTokens)
          ? {
              revokedCredentials: {
                apiKeys: rv.keys.map((k) => k.id),
                invitations: rv.invitations,
                serviceApps: rv.serviceApps,
                scimTokens: rv.scimTokens,
              },
            }
          : {}),
      },
    });
    return { ok: true };
  });

  app.delete<P>("/v1/members/:userId", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const userId = req.params.userId!;
    const cur = await s.db.one<any>(`SELECT role, role_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, userId]);
    if (!cur) throw notFound("Miembro");
    if (cur.role === "owner" && a.access?.role !== "owner") throw forbidden("Solo un propietario puede quitar a otro propietario");
    if (userId !== a.userId) assertCanManage(a, await permsOf(s.db, a.tenantId, cur.role, cur.role_id), "quitar a este miembro");
    const revoked = await s.db.tx(async (t) => {
      // Serializa los cambios de propietarios de la organización: dos bajas simultáneas no la dejan sin ninguno.
      await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [a.tenantId]);
      await assertSameRole(t, a.tenantId, userId, cur);
      await t.query(`DELETE FROM group_members gm USING groups g WHERE gm.group_id = g.id AND g.tenant_id = $1 AND gm.user_id = $2`, [
        a.tenantId,
        userId,
      ]);
      await t.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, userId]);
      if (cur.role === "owner" && (await ownerCount(t, a.tenantId)) === 0)
        throw conflict("last_owner", "La organización tiene que tener al menos un propietario");
      // Cierra sus sesiones en esta organización.
      await t.query(`DELETE FROM sessions WHERE user_id = $1 AND tenant_id = $2`, [userId, a.tenantId]);
      // La baja se sostiene: el alta JIT por SSO o una activación por SCIM no lo vuelven a sumar hasta que lo inviten.
      // Salir por cuenta propia no es una baja de la organización: no bloquea que el IdP la vuelva a sumar.
      if (userId !== a.userId) await recordConsoleRemoval(t, a.tenantId, userId, await actingPerson(t, a));
      // Sobres en curso donde era anfitrión de una firma en persona: nadie más que un administrador (envelopes:manage_all)
      // puede abrir esa sesión. Se listan en la auditoría de la baja para que alguien los corrija o los abra.
      const hosted = await t.query<{ id: string }>(
        `SELECT DISTINCT e.id FROM recipients r JOIN envelopes e ON e.id = r.envelope_id
          WHERE e.tenant_id = $1 AND e.status = 'sent' AND r.in_person_host_user_id = $2 AND r.status IN ('created', 'sent', 'viewed')`,
        [a.tenantId, userId],
      );
      // Y el acceso que conserva por otras vías: API keys, invitaciones que mandó, tokens OAuth, secretos de apps de servicio.
      return { ...(await revokeMemberAccess(t, a.tenantId, userId)), inPersonHostEnvelopes: hosted.map((h) => h.id) };
    });
    await auditFromRequest(s.db, req, a, "member.removed", {
      targetType: "user",
      targetId: userId,
      data:
        revoked.keys.length || revoked.invitations || revoked.serviceApps.length || revoked.scimTokens || revoked.inPersonHostEnvelopes.length
          ? {
              ...(revoked.keys.length ? { revokedApiKeys: revoked.keys.map((k) => ({ id: k.id, name: k.name })) } : {}),
              ...(revoked.invitations ? { revokedInvitations: revoked.invitations } : {}),
              ...(revoked.serviceApps.length ? { disabledServiceAppSecrets: revoked.serviceApps } : {}),
              ...(revoked.scimTokens ? { revokedScimTokens: revoked.scimTokens } : {}),
              ...(revoked.inPersonHostEnvelopes.length ? { inPersonHostEnvelopes: revoked.inPersonHostEnvelopes } : {}),
            }
          : undefined,
    });
    return reply.code(204).send();
  });

  // ───────── Invitaciones ─────────

  /** Revocar o reemplazar una invitación pendiente: como con los miembros, solo quien tiene todos los permisos de su rol. */
  async function assertCanManageInvitation(a: AuthContext, inv: { role: string; role_id: string | null }) {
    if (inv.role === "owner" && a.access?.role !== "owner")
      throw forbidden("Solo un propietario puede revocar o reemplazar una invitación de propietario");
    assertCanManage(a, await permsOf(s.db, a.tenantId, inv.role, inv.role_id), "revocar o reemplazar esta invitación");
  }

  const toInvitation = (r: any): Invitation => ({
    id: r.id,
    email: r.email,
    role: r.role,
    roleId: r.role_id,
    roleName: r.role === "custom" ? (r.role_name ?? "?") : (ROLE_LABEL[r.role] ?? r.role),
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
    // La invitación nueva reemplaza (revoca) la pendiente para ese correo: como al cambiar el rol de un miembro, solo
    // quien podría otorgar el rol pendiente. Si no, un rol con members:manage cambiaba por "miembro" la invitación de
    // administrador (o de propietario) que había mandado otro.
    const pending = await s.db.one<any>(
      `SELECT role, role_id FROM invitations WHERE tenant_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
      [a.tenantId, input.email],
    );
    if (pending) await assertCanManageInvitation(a, pending);
    const token = randomToken();
    const id = uuidv7();
    await s.db.tx(async (t) => {
      // El cupo del plan se revisa de nuevo con la organización bloqueada (el control central de access.ts corre
      // antes y sin bloqueo): dos invitaciones simultáneas no superan el cupo.
      await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [a.tenantId]);
      await assertInvitationCapacity(t, a.tenantId, input.email);
      // Una invitación pendiente por correo: la anterior se revoca.
      await t.query(
        `UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL`,
        [a.tenantId, input.email],
      );
      await t.query(
        `INSERT INTO invitations (id, tenant_id, email, role, role_id, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '${INVITE_DAYS} days')`,
        // A nombre de la persona (también si invita una API key): así se revoca con su baja.
        [id, a.tenantId, input.email, target.role, target.roleId, sha256Hex(token), await actingPerson(t, a)],
      );
    });
    const org = await s.db.one<any>(`SELECT name, default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
    const inviter = a.userId ? (await s.db.one<any>(`SELECT name FROM users WHERE id = $1`, [a.userId]))?.name : a.actor.label;
    // En la app principal, no en el dominio propio de la organización: las páginas de cuenta (aceptar la invitación,
    // registrarse, iniciar sesión) no se sirven en los dominios propios. El correo sí sale con la marca.
    const acceptUrl = `${config.appUrl}/invite/${token}`;
    const mailLocale = normLocale(input.locale ?? org.default_locale);
    const roleForMail = target.role === "custom" ? target.roleName : ROLE_LABEL_I18N[mailLocale][target.role as "owner" | "admin" | "member"];
    // Dirección suprimida (rebote permanente vigente, global, o queja contra esta organización): no se manda; el link
    // de aceptación igual vuelve en la respuesta. No se informa en la respuesta ni en la auditoría (un rebote es de otra
    // organización y la queja, de la persona): queda solo en el log del servidor, con la dirección enmascarada.
    const emailSuppressed = await isSuppressed(s.db, input.email, a.tenantId);
    if (emailSuppressed)
      req.log.info({ tenantId: a.tenantId, invitationId: id, email: maskDestination(input.email) }, "invitación sin correo: dirección suprimida");
    else await sendInvitationEmail(s.db, a.tenantId, input.email, org.name, inviter ?? org.name, roleForMail, acceptUrl, mailLocale);
    await auditFromRequest(s.db, req, a, "member.invited", {
      targetType: "invitation",
      targetId: id,
      data: { email: input.email, role: target.role, roleId: target.roleId },
    });
    const row = await s.db.one<any>(
      `SELECT i.*, r.name AS role_name, u.name AS invited_by_name FROM invitations i LEFT JOIN roles r ON r.id = i.role_id LEFT JOIN users u ON u.id = i.invited_by WHERE i.id = $1`,
      [id],
    );
    reply.code(201);
    return { invitation: toInvitation(row), acceptUrl };
  });

  app.delete<P>("/v1/invitations/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const cur = await s.db.one<any>(
      `SELECT role, role_id FROM invitations WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [req.params.id, a.tenantId],
    );
    if (cur) await assertCanManageInvitation(a, cur);
    const r = await s.db.query(
      `UPDATE invitations SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email`,
      [req.params.id, a.tenantId],
    );
    if (!r.length) throw notFound("Invitación");
    await auditFromRequest(s.db, req, a, "member.invitation_revoked", {
      targetType: "invitation",
      targetId: req.params.id,
      data: { email: (r[0] as any).email },
    });
    return reply.code(204).send();
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
      role: r.role,
      roleName: r.role === "custom" ? r.role_name : (ROLE_LABEL[r.role] ?? r.role),
      invitedByName: r.invited_by_name,
      existingAccount: Boolean(existing),
      status: invitationStatus(r),
    };
  });

  /**
   * Recién sumado por una invitación a una organización con SSO obligatorio (y sin ser propietario): una sesión con
   * contraseña no le serviría (el primer pedido daba sso_required y la web mostraba "tu sesión terminó"). Se lo manda a
   * ingresar por SSO. Por la membresía (no la invitación): quien ya era propietario lo sigue siendo.
   */
  async function assertJoinedWithoutSso(tenantId: string, userId: string, email: string) {
    const m = await s.db.one<{ role: string }>(`SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    if (!m || m.role === "owner") return;
    const sso = await s.db.one<any>(
      `SELECT c.enabled, c.enforce, t.slug FROM sso_configs c JOIN tenants t ON t.id = c.tenant_id WHERE c.tenant_id = $1`,
      [tenantId],
    );
    if (sso?.enabled && sso.enforce) {
      throw new AppError(403, "sso_required", "Te sumaste a la organización: ingresá con su inicio de sesión único (SSO)", {
        joined: true,
        startUrl: `/v1/auth/sso/start?org=${encodeURIComponent(sso.slug)}&login_hint=${encodeURIComponent(email)}`,
      });
    }
  }

  /**
   * Marca la invitación como aceptada y crea la membresía (una sola vez; una invitación revocada o vencida no sirve).
   * `who`: el id de una cuenta existente o los datos de la cuenta nueva, que se crea en la MISMA transacción: si la
   * aceptación falla (cupo del plan, invitación ya usada), no queda una cuenta sin organización que después no podía
   * ingresar (401) ni registrarse (email_taken). Devuelve el id de la cuenta.
   */
  async function joinByInvitation(
    req: FastifyRequest,
    invitationId: string,
    who: string | { name: string; passwordHash: string; locale: string },
    email: string,
  ) {
    const userId = typeof who === "string" ? who : uuidv7();
    let inv: any;
    try {
      inv = await s.db.tx(async (t) => {
        // Cupo de usuarios del plan al aceptar (no solo al invitar): después de bajar de plan, las invitaciones pendientes
        // se seguían aceptando por encima del límite. Con la organización bloqueada, como el alta por SSO o SCIM.
        const pre = await t.one<any>(`SELECT tenant_id, email FROM invitations WHERE id = $1`, [invitationId]);
        if (pre) {
          await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [pre.tenant_id]);
          // Si ya es miembro no ocupa un lugar nuevo (la membresía existente se conserva).
          const member =
            typeof who === "string" ? await t.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [pre.tenant_id, userId]) : null;
          if (!member) await assertInvitationCapacity(t, pre.tenant_id, email);
        }
        if (typeof who !== "string") {
          if (!pre) throw new AppError(410, "invitation_used", "La invitación ya no es válida");
          await t.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,$3,$4,$5)`, [
            userId,
            pre.email,
            who.name,
            who.passwordHash,
            who.locale,
          ]);
        }
        const upd = await t.query<any>(
          `UPDATE invitations SET accepted_at = now(), accepted_by = $2
            WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id, tenant_id, role, role_id`,
          [invitationId, userId],
        );
        if (!upd.length) throw new AppError(410, "invitation_used", "La invitación ya no es válida");
        const i = upd[0];
        await t.query(
          `INSERT INTO memberships (tenant_id, user_id, role, role_id) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
          [i.tenant_id, userId, i.role, i.role_id],
        );
        // Invitado de nuevo después de una baja desde la consola: vuelve a valer el alta por SSO/SCIM.
        await clearConsoleRemoval(t, i.tenant_id, userId);
        return i;
      });
    } catch (e) {
      // Dos aceptaciones simultáneas que crean la misma cuenta: la segunda choca con el índice único del correo. La
      // cuenta ya existe (la creó la otra): se ingresa con su contraseña, no un 500.
      if (typeof who !== "string" && (e as { code?: unknown })?.code === "23505") {
        throw new AppError(409, "account_exists", "Ya se creó una cuenta con este correo: ingresá con tu contraseña para aceptar la invitación");
      }
      throw e;
    }
    await recordAudit(s.db, {
      tenantId: inv.tenant_id,
      action: "member.joined",
      actor: { type: "user", id: userId, label: email },
      targetType: "invitation",
      targetId: inv.id,
      data: { role: inv.role, roleId: inv.role_id },
      ...clientInfo(req),
    });
    return userId;
  }

  app.post<P>("/v1/invite/:token/accept", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = AcceptInvitationInput.parse(req.body ?? {});
    const inv = await invitationByToken(req.params.token!);
    const status = invitationStatus(inv);
    if (status !== "pending") throw new AppError(410, `invitation_${status}`, "La invitación ya no es válida");

    // ¿Hay sesión iniciada con ese mismo correo?
    let sessionUserId: string | null = null;
    const cookie = sessionCookieToken(req);
    if (cookie) {
      const srow = await s.db.one<any>(
        // Una sesión SSO solo sirve como prueba de identidad dentro de su propia organización (Fase 5).
        `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND ${sessionAliveSql("s")}
           AND (s.auth_method = 'password' OR s.sso_tenant_id = $2)`,
        [sha256Hex(cookie), inv.tenant_id],
      );
      if (srow && srow.email.toLowerCase() === inv.email.toLowerCase()) sessionUserId = srow.id;
    }

    const user = await s.db.one<any>(`SELECT id, password_hash, totp_enabled_at FROM users WHERE lower(email) = lower($1)`, [inv.email]);
    let verifiedByPassword = false;
    let newUser: { name: string; passwordHash: string; locale: string } | null = null;
    if (user && !sessionUserId) {
      // Cuenta creada por SSO o SCIM, sin contraseña propia: ninguna que escriba sirve (daba "contraseña incorrecta" y
      // contaba para el bloqueo), y la sesión SSO de otra organización no se acepta como prueba. La salida es crearla
      // con "Olvidé mi contraseña", como en el login.
      if (!String(user.password_hash ?? "").startsWith("scrypt$")) {
        throw new AppError(
          403,
          "password_reset_required",
          'Tu cuenta entra por inicio de sesión único (SSO) y no tiene contraseña: creala desde "Olvidé mi contraseña" y volvé a abrir esta invitación',
        );
      }
      // Sin contraseña no hay intento que contar (p. ej. la pantalla consultando si hace falta): 401 sin tocar el bloqueo.
      if (!input.password) throw unauthorized();
      // Es un ingreso con contraseña: mismo bloqueo por (cuenta, red) que /v1/auth/login, y los fallos cuentan para ese
      // bloqueo. Si no, alguien que invita el correo de otra persona a su propia organización prueba contraseñas acá
      // sin límite por cuenta (solo el de IP) y, si acierta, se queda con una sesión de esa persona.
      await takeLoginAttempt(s.db, user.id, clientInfo(req).ip);
      if (!(await verifyPassword(input.password, user.password_hash))) {
        const tenants = await s.db.query<any>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [user.id]);
        for (const m of tenants.length ? tenants : [{ tenant_id: inv.tenant_id }]) {
          await recordAudit(s.db, {
            tenantId: m.tenant_id,
            action: "auth.login_failed",
            actor: { type: "anonymous", id: user.id, label: inv.email },
            data: { reason: "bad_password_invitation" },
            ...clientInfo(req),
          });
        }
        throw unauthorized();
      }
      verifiedByPassword = true;
    }
    if (!user) {
      if (!input.name || !input.password) throw badRequest("account_required", "Para crear la cuenta hacen falta nombre y contraseña");
      assertPasswordStrength(input.password, inv.email);
      // La cuenta se crea junto con la membresía (joinByInvitation), en una sola transacción.
      const org = await s.db.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [inv.tenant_id]);
      newUser = { name: input.name, passwordHash: await hashPassword(input.password), locale: org?.default_locale ?? "es" };
    }

    // Si entró con contraseña y tiene 2FA, falta el segundo factor: la invitación se acepta recién al verificarlo.
    // Si no, alguien con solo la contraseña sumaba la cuenta de la víctima a su propia organización.
    if (user && verifiedByPassword && user.totp_enabled_at) {
      await passwordAccepted(s.db, user.id);
      return createTwoFactorChallenge(s.db, user.id, inv.tenant_id, inv.id);
    }
    // Sin segundo factor pendiente: el ingreso con contraseña terminó bien (con 2FA se vacía al verificar el código).
    if (user && verifiedByPassword) await clearLoginAttempts(s.db, user.id, clientInfo(req).ip);
    const userId = await joinByInvitation(req, inv.id, user ? (user.id as string) : newUser!, inv.email);
    await assertJoinedWithoutSso(inv.tenant_id, userId, inv.email);
    if (sessionUserId) {
      await s.db.query(`UPDATE sessions SET tenant_id = $2 WHERE token_hash = $1`, [sha256Hex(cookie!), inv.tenant_id]);
    } else {
      await createUserSession(s.db, req, reply, userId, inv.tenant_id);
    }
    return meResponse(s.db, userId, inv.tenant_id);
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
    await auditFromRequest(s.db, req, a, "role.created", {
      targetType: "role",
      targetId: id,
      data: { name: input.name, permissions: input.permissions },
    });
    reply.code(201);
    return toRole(await s.db.one(`SELECT *, 0 AS member_count FROM roles WHERE id = $1`, [id]));
  });

  app.patch<P>("/v1/roles/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateRoleInput.parse(req.body);
    const cur = await s.db.one<any>(`SELECT * FROM roles WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!cur) throw notFound("Rol");
    if (input.permissions) {
      assertCanManage(a, cur.permissions ?? [], "editar los permisos de este rol");
      assertCanGrant(a, { role: "custom" }, input.permissions);
    }
    // Recortar permisos: lo que crearon sus miembros con el rol anterior (API keys, apps de servicio, tokens SCIM,
    // invitaciones pendientes) conservaba esos permisos. Se revoca en la misma transacción, como al bajarle el rol a un miembro.
    const revokedByUser: Record<string, { apiKeys: string[]; invitations: number; serviceApps: string[]; scimTokens: number }> = {};
    try {
      await s.db.tx(async (t) => {
        // Mismo orden de bloqueos que el cambio de rol de un miembro (organización y después rol/membresía): en orden
        // inverso, un PATCH del rol simultáneo a un cambio de rol de uno de sus miembros podía trabarse (deadlock).
        await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [a.tenantId]);
        const locked = await t.one<{ permissions: string[] | null }>(`SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
          cur.id,
          a.tenantId,
        ]);
        if (!locked) throw notFound("Rol");
        await t.query(
          `UPDATE roles SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
             permissions = COALESCE($5, permissions), updated_at = now() WHERE id = $1`,
          [
            cur.id,
            input.name ?? null,
            input.description !== undefined,
            input.description ?? null,
            input.permissions ? [...new Set(input.permissions)] : null,
          ],
        );
        if (!input.permissions) return;
        const after = new Set<string>(input.permissions);
        if (!(locked.permissions ?? []).some((p) => !after.has(p))) return;
        const members = await t.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role_id = $2`, [
          a.tenantId,
          cur.id,
        ]);
        for (const m of members) {
          const rv = await revokeMemberAccess(t, a.tenantId, m.user_id, { removal: false });
          if (rv.keys.length || rv.invitations || rv.serviceApps.length || rv.scimTokens) {
            revokedByUser[m.user_id] = {
              apiKeys: rv.keys.map((k) => k.id),
              invitations: rv.invitations,
              serviceApps: rv.serviceApps,
              scimTokens: rv.scimTokens,
            };
          }
        }
      });
    } catch (e) {
      if (/roles_tenant_name_uq/.test(String(e))) throw conflict("role_exists", "Ya existe un rol con ese nombre");
      throw e;
    }
    await auditFromRequest(s.db, req, a, "role.updated", {
      targetType: "role",
      targetId: cur.id,
      data: {
        from: cur.permissions,
        to: input.permissions ?? cur.permissions,
        ...(Object.keys(revokedByUser).length ? { revokedCredentials: revokedByUser } : {}),
      },
    });
    return toRole(await s.db.one(`SELECT *, 0 AS member_count FROM roles WHERE id = $1`, [cur.id]));
  });

  app.delete<P>("/v1/roles/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    // Como al editar sus permisos: borrar un rol que tiene permisos que uno no tiene no lo hace cualquiera con members:manage.
    const cur = await s.db.one<any>(`SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!cur) throw notFound("Rol");
    assertCanManage(a, cur.permissions ?? [], "borrar este rol");
    const r = await s.db.tx(async (t) => {
      if (!(await t.one(`SELECT id FROM roles WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, a.tenantId]))) return [];
      // Invitaciones vencidas no cuentan: ya no se pueden aceptar.
      const used = await t.one(
        `SELECT 1 FROM memberships WHERE role_id = $1 UNION ALL SELECT 1 FROM api_keys WHERE role_id = $1 AND revoked_at IS NULL
         UNION ALL SELECT 1 FROM invitations WHERE role_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
        [req.params.id],
      );
      if (used) throw conflict("role_in_use", "El rol está asignado: cambiá esos miembros, API keys o invitaciones primero");
      // Las filas históricas (invitaciones usadas, revocadas o vencidas; keys revocadas) también lo referencian y la FK
      // no tiene ON DELETE: sin esto el borrado daba 500.
      await t.query(`UPDATE invitations SET role_id = NULL WHERE role_id = $1`, [req.params.id]);
      await t.query(`UPDATE api_keys SET role_id = NULL WHERE role_id = $1 AND revoked_at IS NOT NULL`, [req.params.id]);
      return t.query(`DELETE FROM roles WHERE id = $1 AND tenant_id = $2 RETURNING name`, [req.params.id, a.tenantId]);
    });
    if (!r.length) throw notFound("Rol");
    await auditFromRequest(s.db, req, a, "role.deleted", { targetType: "role", targetId: req.params.id, data: { name: (r[0] as any).name } });
    return reply.code(204).send();
  });

  // ───────── Rol de las API keys ─────────

  app.get("/v1/api-keys/roles", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(
      `SELECT k.id, k.role, k.role_id, r.name AS role_name FROM api_keys k LEFT JOIN roles r ON r.id = k.role_id WHERE k.tenant_id = $1`,
      [A(req).tenantId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        role: r.role,
        roleId: r.role_id,
        roleName: r.role === "custom" ? r.role_name : (ROLE_LABEL[r.role] ?? r.role),
      })),
    };
  });

  app.patch<P>("/v1/api-keys/:id/role", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = RoleAssignment.parse(req.body);
    if (input.role === "owner") throw badRequest("invalid_role", "Una API key no puede ser propietaria");
    await assertCanManageApiKey(s.db, a, req.params.id!);
    const target = await resolveRole(s.db, a.tenantId, input);
    assertCanGrant(a, target, await permsOf(s.db, a.tenantId, target.role, target.roleId));
    const r = await s.db.query(
      `UPDATE api_keys SET role = $3, role_id = $4 WHERE id = $1 AND tenant_id = $2 AND oauth_client_id IS NULL RETURNING id`,
      [req.params.id, a.tenantId, target.role, target.roleId],
    );
    if (!r.length) throw notFound("API key");
    await auditFromRequest(s.db, req, a, "api_key.role_changed", {
      targetType: "api_key",
      targetId: req.params.id,
      data: { role: target.role, roleId: target.roleId },
    });
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
        await t.query(`INSERT INTO groups (id, tenant_id, name, description) VALUES ($1,$2,$3,$4)`, [
          id,
          a.tenantId,
          input.name,
          input.description ?? null,
        ]);
        await setGroupMembers(t, a.tenantId, id, input.memberIds ?? []);
      });
    } catch (e) {
      if (/groups_tenant_name_uq/.test(String(e))) throw conflict("group_exists", "Ya existe un grupo con ese nombre");
      throw e;
    }
    await auditFromRequest(s.db, req, a, "group.created", {
      targetType: "group",
      targetId: id,
      data: { name: input.name, members: input.memberIds?.length ?? 0 },
    });
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
        await t.query(`UPDATE groups SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END WHERE id = $1`, [
          cur.id,
          input.name ?? null,
          input.description !== undefined,
          input.description ?? null,
        ]);
        if (input.memberIds) {
          await assertCanAddToGroup(t, a, cur.id, input.memberIds);
          await setGroupMembers(t, a.tenantId, cur.id, input.memberIds);
        }
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
    return reply.code(204).send();
  });

  // ───────── Compartir sobres y plantillas con grupos ─────────

  async function validGroups(tenantId: string, ids: string[], db: Db = s.db) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const rows = await db.query<any>(`SELECT id, name FROM groups WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, unique]);
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
    await auditFromRequest(s.db, req, a, "envelope.shared", {
      targetType: "envelope",
      targetId: req.params.id,
      data: { groups: groups.map((g) => g.name) },
    });
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
    const saved = await s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT visibility, updated_at FROM templates WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [
        req.params.id,
        a.tenantId,
      ]);
      if (!cur) throw notFound("Plantilla");
      // La visibilidad cambia el updatedAt de la plantilla: con X-Expected-Updated-At (el editor lo manda) no tapa una
      // edición ajena. Sin cambio de visibilidad no se toca (estrictamente creciente, como el resto de la plantilla).
      assertNotStale(req.headers, cur.updated_at);
      // Los grupos se validan después del 404/409: una plantilla inexistente o desactualizada no responde invalid_group.
      const groups = await validGroups(a.tenantId, input.groupIds, t);
      // La versión que se devuelve es la que deja este guardado (RETURNING, o la leída con FOR UPDATE si no cambió):
      // leerla después del COMMIT podría adoptar el updatedAt de otro guardado posterior sin sus datos.
      const upd = input.visibility
        ? await t.one<any>(
            `UPDATE templates SET visibility = $2, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
             WHERE id = $1 AND visibility IS DISTINCT FROM $2 RETURNING visibility, updated_at`,
            [req.params.id, input.visibility],
          )
        : null;
      await t.query(`DELETE FROM template_shares WHERE template_id = $1`, [req.params.id]);
      for (const g of groups) await t.query(`INSERT INTO template_shares (template_id, group_id) VALUES ($1,$2)`, [req.params.id, g.id]);
      return { groups, row: upd ?? cur };
    });
    const { groups, row: t } = saved;
    await auditFromRequest(s.db, req, a, "template.shared", {
      targetType: "template",
      targetId: req.params.id,
      data: { visibility: t.visibility, groups: groups.map((g: any) => g.name) },
    });
    return {
      groups: groups.map((g: any) => ({ id: g.id, name: g.name })),
      visibility: t.visibility,
      templateUpdatedAt: new Date(t.updated_at).toISOString(),
    };
  });

  // ───────── Seguridad y retención ─────────

  app.get("/v1/settings/security", { preHandler: auth }, async (req) => {
    const t = await s.db.one<any>(`SELECT retention_days, require_2fa FROM tenants WHERE id = $1`, [A(req).tenantId]);
    return { retentionDays: t.retention_days, require2fa: t.require_2fa };
  });

  app.patch("/v1/settings/security", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateSecuritySettingsInput.parse(req.body);
    // Evita que quien lo activa quede bloqueado. Con una sesión SSO no aplica: esas sesiones no exigen el alta (el IdP
    // gestiona el segundo factor) y desde ellas no se puede activar la 2FA de la cuenta, así que un administrador que
    // entra por SSO no podía exigirla nunca.
    if (input.require2fa && a.userId && (await sessionAuthMethod(req)) !== "sso") {
      const u = await s.db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
      if (!u?.totp_enabled_at) throw conflict("enable_2fa_first", "Activá tu verificación en dos pasos antes de exigirla a la organización");
    }
    // Valores anteriores para la auditoría (settings.changed los registra con los nuevos).
    const prev = await s.db.one<any>(`SELECT retention_days, require_2fa FROM tenants WHERE id = $1`, [a.tenantId]);
    (req as FastifyRequest & { auditBefore?: Record<string, unknown> }).auditBefore = {
      retentionDays: prev?.retention_days ?? null,
      require2fa: Boolean(prev?.require_2fa),
    };
    await s.db.query(
      `UPDATE tenants SET retention_days = CASE WHEN $2::boolean THEN $3 ELSE retention_days END, require_2fa = COALESCE($4, require_2fa) WHERE id = $1`,
      [a.tenantId, input.retentionDays !== undefined, input.retentionDays ?? null, input.require2fa ?? null],
    );
    const t = await s.db.one<any>(`SELECT retention_days, require_2fa FROM tenants WHERE id = $1`, [a.tenantId]);
    return { retentionDays: t.retention_days, require2fa: t.require_2fa };
  });

  // ───────── 2FA del usuario ─────────

  /**
   * La 2FA es de la cuenta (vale en todas sus organizaciones), pero una sesión SSO solo prueba la identidad dentro de
   * la organización que la abrió, cuyo IdP lo configura esa organización (y sin dominios cargados puede afirmar el
   * correo de cualquier miembro). Activarla desde ahí dejaba a un propietario ajeno con el segundo factor de la cuenta
   * de un miembro: sus ingresos con contraseña en las demás organizaciones quedaban bloqueados.
   */
  async function sessionAuthMethod(req: FastifyRequest): Promise<string | null> {
    const cookie = sessionCookieToken(req);
    const sess = cookie ? await s.db.one<any>(`SELECT auth_method FROM sessions WHERE token_hash = $1`, [sha256Hex(cookie)]) : null;
    return sess?.auth_method ?? null;
  }

  async function assertAccountSession(req: FastifyRequest) {
    if ((await sessionAuthMethod(req)) === "sso") {
      throw new AppError(
        403,
        "sso_session_2fa",
        "Con inicio de sesión único (SSO) el segundo factor lo gestiona el proveedor de identidad: ingresá con tu contraseña para activarlo",
      );
    }
  }

  /**
   * Al activar o desactivar la 2FA se cierran las OTRAS sesiones de la cuenta (la actual sigue) y se revocan sus tokens
   * OAuth: si alguien tenía la contraseña y una sesión abierta (o una app autorizada), activarla no lo sacaba; y quien
   * la desactiva desde una sesión robada no deja abiertas las del dueño sin enterarse. Devuelve cuántas sesiones cerró.
   */
  async function closeOtherSessions(req: FastifyRequest, userId: string): Promise<number> {
    const cookie = sessionCookieToken(req);
    return s.db.tx(async (t) => {
      const closed = await t.query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 RETURNING user_id`, [
        userId,
        cookie ? sha256Hex(cookie) : "",
      ]);
      await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await t.query(`DELETE FROM login_challenges WHERE user_id = $1`, [userId]);
      return closed.length;
    });
  }

  /**
   * La 2FA es de la cuenta (vale en todas sus organizaciones), como la contraseña: el cambio se audita en cada
   * organización de la que es miembro (y en la actual), no solo en la de la sesión. Si no, un administrador de otra
   * organización no se enteraba de que un miembro apagó la verificación en dos pasos.
   */
  async function auditAccountSecurity(req: FastifyRequest, a: AuthContext, action: string, data: Record<string, unknown> = {}) {
    const rows = await s.db.query<{ tenant_id: string }>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [a.userId]);
    const tenantIds = new Set<string>([a.tenantId, ...rows.map((r) => r.tenant_id)]);
    for (const tenantId of tenantIds) {
      await auditFromRequest(s.db, req, { ...a, tenantId }, action, { targetType: "user", targetId: a.userId, data }).catch((err) =>
        req.log.error({ err }, "no se pudo registrar la auditoría"),
      );
    }
  }

  app.post("/v1/me/2fa/setup", { preHandler: auth }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para usuarios");
    await assertAccountSession(req);
    const { password } = ReauthInput.parse(req.body ?? {});
    const u = await s.db.one<any>(`SELECT email, totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
    if (u.totp_enabled_at) throw conflict("2fa_already_enabled", "La verificación en dos pasos ya está activa");
    // Con una cookie robada no se activa un segundo factor ajeno (que dejaría afuera al dueño de la cuenta).
    await assertRecentAuth(s.db, req, a.userId, password);
    const secret = generateTotpSecret();
    await s.db.query(`UPDATE users SET totp_pending_enc = $2 WHERE id = $1`, [a.userId, encrypt(secret)]);
    const url = otpauthUrl(secret, u.email);
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { secret, otpauthUrl: url, qrSvg };
  });

  app.post("/v1/me/2fa/enable", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para usuarios");
    await assertAccountSession(req);
    const { code, password } = TotpReauthInput.parse(req.body);
    const u = await s.db.one<any>(`SELECT totp_pending_enc, totp_enabled_at FROM users WHERE id = $1`, [a.userId]);
    if (u.totp_enabled_at) throw conflict("2fa_already_enabled", "La verificación en dos pasos ya está activa");
    if (!u.totp_pending_enc) throw badRequest("2fa_setup_required", "Primero generá el código QR");
    await assertRecentAuth(s.db, req, a.userId, password);
    const secret = decrypt(u.totp_pending_enc);
    const step = verifyTotp(secret, code);
    if (step === null) throw badRequest("invalid_code", "Código incorrecto");
    const codes = generateRecoveryCodes();
    await s.db.query(
      `UPDATE users SET totp_secret_enc = $2, totp_pending_enc = NULL, totp_enabled_at = now(), totp_last_step = $3, totp_recovery_hashes = $4 WHERE id = $1`,
      [a.userId, encrypt(secret), step, codes.map((c) => sha256Hex(normalizeRecoveryCode(c)))],
    );
    const sessionsClosed = await closeOtherSessions(req, a.userId);
    await auditAccountSecurity(req, a, "user.2fa_enabled", { otherSessionsClosed: sessionsClosed });
    await enqueueSecurityNotice(s.db, req, a.userId, "2fa_enabled").catch((err) =>
      req.log.error({ err }, "no se pudo encolar el aviso de seguridad"),
    );
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
    const sessionsClosed = await closeOtherSessions(req, a.userId);
    await auditAccountSecurity(req, a, "user.2fa_disabled", { otherSessionsClosed: sessionsClosed });
    await enqueueSecurityNotice(s.db, req, a.userId, "2fa_disabled").catch((err) =>
      req.log.error({ err }, "no se pudo encolar el aviso de seguridad"),
    );
    return { ok: true };
  });

  app.post("/v1/me/2fa/recovery-codes", { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const a = A(req);
    if (!a.userId) throw forbidden("Solo para usuarios");
    const { code, password } = TotpReauthInput.parse(req.body);
    // Antes de consumir el código: sin re-autenticación no se gasta un paso TOTP.
    await assertRecentAuth(s.db, req, a.userId, password);
    if ((await checkSecondFactor(s.db, a.userId, code)) !== "totp") throw badRequest("invalid_code", "Código incorrecto");
    const codes = generateRecoveryCodes();
    await s.db.query(`UPDATE users SET totp_recovery_hashes = $2 WHERE id = $1`, [a.userId, codes.map((c) => sha256Hex(normalizeRecoveryCode(c)))]);
    await auditAccountSecurity(req, a, "user.2fa_recovery_regenerated");
    await enqueueSecurityNotice(s.db, req, a.userId, "2fa_recovery_regenerated").catch((err) =>
      req.log.error({ err }, "no se pudo encolar el aviso de seguridad"),
    );
    return { recoveryCodes: codes };
  });

  // Segundo paso del ingreso.
  app.post("/v1/auth/2fa/verify", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = TwoFactorLoginInput.parse(req.body);
    const ch = await s.db.one<any>(`SELECT * FROM login_challenges WHERE token_hash = $1 AND expires_at > now()`, [sha256Hex(input.challengeToken)]);
    if (!ch) throw new AppError(401, "challenge_expired", "El ingreso venció: volvé a ingresar tu contraseña");
    // El intento se cuenta antes de comparar y de forma atómica: pedidos concurrentes no superan el límite.
    const slot = await s.db.query(`UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = $1 AND attempts < 5 RETURNING attempts`, [
      ch.token_hash,
    ]);
    if (!slot.length) {
      await s.db.query(`DELETE FROM login_challenges WHERE token_hash = $1`, [ch.token_hash]);
      throw new AppError(401, "too_many_attempts", "Demasiados intentos: volvé a ingresar tu contraseña");
    }
    // Cupo de códigos de la cuenta (login-attempts.ts): también corta los desafíos ya abiertos (si no, alguien con la
    // contraseña junta muchos desafíos antes de fallar y prueba 5 códigos en cada uno). Es propio del segundo paso: los
    // fallos de contraseña desde otras redes no bloquean un desafío que ya pasó la contraseña.
    try {
      await takeTwoFactorAttempt(s.db, ch.user_id);
    } catch (e) {
      await s.db.query(`DELETE FROM login_challenges WHERE token_hash = $1`, [ch.token_hash]);
      throw e;
    }
    const method = await checkSecondFactor(s.db, ch.user_id, input.code);
    if (method) await clearTwoFactorAttempts(s.db, ch.user_id, clientInfo(req).ip);
    const u = await s.db.one<any>(`SELECT email FROM users WHERE id = $1`, [ch.user_id]);
    if (!method) {
      // Se registra en todas sus organizaciones (como la contraseña incorrecta): el bloqueo se cuenta en la primera,
      // que no siempre es la del desafío (p. ej. si la primera exige SSO).
      const tenants = await s.db.query<any>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [ch.user_id]);
      for (const m of tenants.length ? tenants : [{ tenant_id: ch.tenant_id }]) {
        await recordAudit(s.db, {
          tenantId: m.tenant_id,
          action: "auth.login_failed",
          actor: { type: "anonymous", id: ch.user_id, label: u?.email },
          data: { reason: "bad_2fa_code" },
          ...clientInfo(req),
        });
      }
      throw new AppError(401, "invalid_code", "Código incorrecto");
    }
    // El desafío se canjea una sola vez.
    const consumed = await s.db.query(`DELETE FROM login_challenges WHERE token_hash = $1 RETURNING user_id`, [ch.token_hash]);
    if (!consumed.length) throw new AppError(401, "challenge_expired", "El ingreso venció: volvé a ingresar tu contraseña");
    // Desafío de una invitación aceptada con contraseña: recién ahora, con el segundo factor, se suma a la organización.
    if (ch.invitation_id) {
      await joinByInvitation(req, ch.invitation_id, ch.user_id, u?.email ?? "");
      // Como en /accept sin 2FA: con SSO obligatorio, al IdP (no una sesión con contraseña que no le sirve).
      await assertJoinedWithoutSso(ch.tenant_id, ch.user_id, u?.email ?? "");
    }
    await createUserSession(s.db, req, reply, ch.user_id, ch.tenant_id, { rememberMe: Boolean(ch.remember) });
    await recordAudit(s.db, {
      tenantId: ch.tenant_id,
      action: "auth.login",
      actor: { type: "user", id: ch.user_id, label: u?.email },
      data: { twoFactor: method },
      ...clientInfo(req),
    });
    return meResponse(s.db, ch.user_id, ch.tenant_id);
  });

  // ───────── Hook: dueño de sobres creados por API key ─────────

  app.addHook("onSend", async (req, reply, payload) => {
    if (reply.statusCode >= 300 || req.method !== "POST" || !req.auth || typeof payload !== "string") return payload;
    const url = req.routeOptions?.url ?? "";
    try {
      if (req.auth.apiKeyId && url.startsWith("/v1/envelopes") && !url.includes(":")) {
        const id = JSON.parse(payload)?.envelope?.id;
        if (id)
          await s.db.query(`UPDATE envelopes SET created_by_api_key = $2 WHERE id = $1 AND tenant_id = $3 AND created_by_api_key IS NULL`, [
            id,
            req.auth.apiKeyId,
            req.auth.tenantId,
          ]);
      }
      // El rol de una API key nueva lo guarda POST /v1/api-keys en el mismo INSERT (validado por access.ts).
    } catch (err) {
      req.log.error({ err }, "post-proceso de equipos falló");
    }
    return payload;
  });
}
