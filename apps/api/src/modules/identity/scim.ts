// Aprovisionamiento SCIM 2.0 (RFC 7643 / 7644): Users y Groups sobre los miembros y grupos de la organización.
// Autenticación con token Bearer por organización (guardado como hash). Desactivar un usuario le quita la
// membresía, los grupos y las sesiones en la organización, pero sigue visible para el IdP (active: false). Borrarlo
// (DELETE) hace lo mismo y lo oculta (404, RFC 7644 §3.6), pero la fila queda (deleted_at): el alta JIT por SSO no lo
// vuelve a sumar, y un POST posterior del IdP lo vuelve a aprovisionar.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actingPerson, releaseScimJitBlocks, revokeMemberAccess } from "../member-access";
import { BUILTIN_ROLE_PERMISSIONS, CreateScimTokenInput, type ScimSettings, type ScimToken } from "@calasign/shared";
import { z } from "zod";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError, notFound } from "../../lib/errors";
import { iso, randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import { recordAudit } from "../audit";
import { hasPerm } from "../access";
import { authenticate, clientInfo, type AuthContext, type Services } from "../context";
import { UPGRADE_URL, tenantPlan, usersCount } from "../billing/plans";

const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const BASE = "/scim/v2";

class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message);
  }
}

const scimBase = () => `${config.appUrl}${BASE}`;
const asBool = (v: unknown) => (typeof v === "string" ? v.toLowerCase() === "true" : Boolean(v));

// ───────────────────────────── Filtros ─────────────────────────────

/** Admite `attr eq "valor"` (los IdP usan casi siempre userName, externalId, emails.value o displayName). */
export function parseFilter(filter: string | undefined, allowed: string[]): { attr: string; value: string } | null {
  if (!filter) return null;
  // Largo acotado: la regex retrocede en O(n³) sobre una cadena de espacios (2000 espacios = 2 s de CPU por pedido).
  if (filter.length > 512) throw new ScimError(400, "Filtro demasiado largo", "invalidFilter");
  const m = /^\s*([A-Za-z.[\]" ]+?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, `Filtro no admitido: ${filter}`, "invalidFilter");
  let attr = m[1].trim();
  if (/^emails\[type eq "work"\]\.value$/i.test(attr) || /^emails$/i.test(attr)) attr = "emails.value";
  const hit = allowed.find((a) => a.toLowerCase() === attr.toLowerCase());
  if (!hit) throw new ScimError(400, `Atributo de filtro no admitido: ${attr}`, "invalidFilter");
  return { attr: hit, value: m[2].replace(/\\(.)/g, "$1") };
}

// ───────────────────────────── Usuarios ─────────────────────────────

interface UserRow {
  id: string;
  email: string;
  name: string;
  created_at: string;
  external_id: string | null;
  given_name: string | null;
  family_name: string | null;
  active: boolean;
  updated_at: string | null;
}

/**
 * Usuarios visibles para SCIM: miembros de la organización + aprovisionados (aunque estén desactivados), salvo los
 * borrados por SCIM (deleted_at) que no volvieron a ser miembros (p. ej. por una invitación desde la consola).
 */
const USERS_SQL = `
  SELECT u.id, u.email, u.name, u.created_at, su.external_id, su.given_name, su.family_name,
         (m.user_id IS NOT NULL) AS active, COALESCE(su.updated_at, u.created_at) AS updated_at
  FROM users u
  LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
  LEFT JOIN scim_users su ON su.user_id = u.id AND su.tenant_id = $1
  WHERE (m.user_id IS NOT NULL OR (su.user_id IS NOT NULL AND su.deleted_at IS NULL))`;

async function userGroups(db: Db, tenantId: string, userId: string) {
  return db.query<any>(
    `SELECT g.id, g.name FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE g.tenant_id = $1 AND gm.user_id = $2 ORDER BY g.name`,
    [tenantId, userId],
  );
}

async function toScimUser(db: Db, tenantId: string, u: UserRow) {
  const [first, ...rest] = (u.name ?? "").split(/\s+/);
  const givenName = u.given_name ?? first ?? null;
  const familyName = u.family_name ?? (rest.join(" ") || null);
  const groups = await userGroups(db, tenantId, u.id);
  return {
    schemas: [SCHEMA_USER],
    id: u.id,
    externalId: u.external_id ?? undefined,
    userName: u.email,
    displayName: u.name,
    name: { givenName, familyName, formatted: u.name },
    emails: [{ value: u.email, type: "work", primary: true }],
    active: Boolean(u.active),
    groups: groups.map((g) => ({ value: g.id, display: g.name, $ref: `${scimBase()}/Groups/${g.id}` })),
    meta: { resourceType: "User", created: iso(u.created_at), lastModified: iso(u.updated_at), location: `${scimBase()}/Users/${u.id}` },
  };
}

async function findUser(db: Db, tenantId: string, id: string): Promise<UserRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, "Usuario no encontrado");
  const u = await db.one<UserRow>(`${USERS_SQL} AND u.id = $2`, [tenantId, id]);
  if (!u) throw new ScimError(404, "Usuario no encontrado");
  return u;
}

const ScimUserInput = z
  .object({
    userName: z.string().trim().toLowerCase().email().optional(),
    externalId: z.string().max(500).optional().nullable(),
    displayName: z.string().max(200).optional().nullable(),
    name: z.object({ givenName: z.string().max(200).optional().nullable(), familyName: z.string().max(200).optional().nullable(), formatted: z.string().max(400).optional().nullable() }).partial().optional().nullable(),
    emails: z.array(z.object({ value: z.string(), primary: z.union([z.boolean(), z.string()]).optional(), type: z.string().optional() }).passthrough()).optional().nullable(),
    active: z.union([z.boolean(), z.string()]).optional(),
  })
  .passthrough();

function emailOf(input: z.infer<typeof ScimUserInput>): string | null {
  if (input.userName) return input.userName;
  const e = input.emails?.find((x) => asBool(x.primary)) ?? input.emails?.[0];
  return e?.value?.trim().toLowerCase() ?? null;
}

function displayNameOf(input: z.infer<typeof ScimUserInput>, email: string): string {
  return (
    input.displayName?.trim() ||
    input.name?.formatted?.trim() ||
    [input.name?.givenName, input.name?.familyName].filter(Boolean).join(" ").trim() ||
    email.split("@")[0]
  );
}

/** Activa / desactiva la membresía de un usuario aprovisionado. */
type Revoked = Awaited<ReturnType<typeof revokeMemberAccess>>;

/** Lo revocado al desactivar, para la auditoría (como member.removed desde la consola). */
const revokedData = (r: Revoked | null | undefined) =>
  r && (r.keys.length || r.invitations || r.serviceApps.length || r.scimTokens)
    ? { revokedCredentials: { apiKeys: r.keys.map((k) => k.id), invitations: r.invitations, serviceApps: r.serviceApps, scimTokens: r.scimTokens } }
    : {};

/** Resultado de activar o desactivar: lo revocado (baja). */
type ActiveResult = { revoked: Revoked | null };

async function setActive(db: Db, tenantId: string, userId: string, active: boolean): Promise<ActiveResult> {
  let revoked: Revoked | null = null;
  const m = await db.one<any>(`SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  if (active && !m) {
    // Cupo de usuarios del plan: una alta o reactivación por SCIM ocupa un lugar igual que una invitación.
    // Con la organización bloqueada (como en miembros e invitaciones): dos altas simultáneas no superan el cupo.
    await db.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
    const { plan } = await tenantPlan(db, tenantId);
    if (plan.users !== null && (await usersCount(db, tenantId)) >= plan.users) {
      throw new ScimError(402, `plan_limit: el plan ${plan.name} permite hasta ${plan.users} usuario(s); ampliá el plan en ${UPGRADE_URL}`, "plan_limit");
    }
    // Acá se vincula la cuenta a la organización (alta activa, reactivación o PATCH/PUT active = true). Una cuenta YA
    // existente se vincula tal cual: su 2FA y sus sesiones no se tocan (ver "Cuentas pre-registradas con un correo
    // ajeno" en docs/ARQUITECTURA.md).
    const t = await db.one<any>(`SELECT scim_default_role FROM tenants WHERE id = $1`, [tenantId]);
    // Sin contraseña en esta organización hasta que el usuario la restablezca: si la cuenta ya existía, su contraseña
    // pudo elegirla otra persona (el registro no verifica el correo). Ver 0029_r11_identity.
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role, password_allowed) VALUES ($1,$2,$3,false) ON CONFLICT DO NOTHING`, [
      tenantId,
      userId,
      t?.scim_default_role ?? "member",
    ]);
    // Una invitación pendiente al mismo correo ya no hace falta: si quedara, después de una baja lo volvía a sumar.
    await db.query(
      `UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND lower(email) = (SELECT lower(email) FROM users WHERE id = $2)`,
      [tenantId, userId],
    );
  } else if (!active && m) {
    // Los propietarios se administran desde la consola (allí solo otro propietario puede quitarlos): un token SCIM,
    // que puede crear un administrador, no puede desactivarlos.
    if (m.role === "owner") throw new ScimError(409, "Los propietarios no se pueden desactivar por SCIM", "mutability");
    await db.query(`DELETE FROM group_members gm USING groups g WHERE gm.group_id = g.id AND g.tenant_id = $1 AND gm.user_id = $2`, [tenantId, userId]);
    await db.query(`DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    await db.query(`DELETE FROM sessions WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    // Como la baja desde la consola: API keys, invitaciones que mandó, tokens OAuth y secretos de sus apps de servicio.
    revoked = await revokeMemberAccess(db, tenantId, userId);
  }
  await db.query(`UPDATE scim_users SET active = $3, updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId, active]);
  return { revoked };
}

/**
 * SCIM solo puede crear o vincular cuentas (y cambiar correos) de los dominios VERIFICADOS de la organización, igual
 * que el alta JIT por SSO. Sin esto, un token SCIM podría reservar el correo de cualquier persona, o sumar a la
 * organización la cuenta de un usuario de otra, y después abrir sesiones como esa persona con un IdP propio.
 */
async function assertVerifiedDomain(db: Db, tenantId: string, email: string) {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const ok = await db.one(`SELECT 1 FROM sso_domains WHERE tenant_id = $1 AND domain = $2 AND verified_at IS NOT NULL`, [tenantId, domain]);
  if (!ok) {
    throw new ScimError(
      403,
      `El dominio ${domain || "(vacío)"} no está verificado en la organización: SCIM solo administra correos de dominios verificados (Ajustes → SSO). Para sumar a otra persona, invitala desde la consola.`,
    );
  }
}

/** ¿El rol del miembro tiene algún permiso que el rol por defecto de SCIM no tiene? */
async function exceedsScimDefaultRole(db: Db, tenantId: string, role: string, roleId: string | null): Promise<boolean> {
  const t = await db.one<any>(`SELECT scim_default_role FROM tenants WHERE id = $1`, [tenantId]);
  const allowed = new Set<string>(BUILTIN_ROLE_PERMISSIONS[(t?.scim_default_role ?? "member") as keyof typeof BUILTIN_ROLE_PERMISSIONS] ?? []);
  let perms: readonly string[];
  if (role === "custom") {
    const r = await db.one<any>(`SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2`, [roleId, tenantId]);
    perms = r?.permissions ?? [];
  } else perms = BUILTIN_ROLE_PERMISSIONS[role as keyof typeof BUILTIN_ROLE_PERMISSIONS] ?? [];
  return perms.some((p) => !allowed.has(p));
}

/** Fila de scim_users (si estaba borrada y el IdP vuelve a administrarlo, deja de estarlo). */
async function ensureScimUser(db: Db, tenantId: string, userId: string) {
  await db.query(
    `INSERT INTO scim_users (tenant_id, user_id) VALUES ($1,$2) ON CONFLICT (tenant_id, user_id) DO UPDATE SET deleted_at = NULL WHERE scim_users.deleted_at IS NOT NULL`,
    [tenantId, userId],
  );
}

/** Aplica atributos (de POST/PUT o de un PATCH ya reducido) a un usuario existente. */
async function applyUserAttrs(db: Db, tenantId: string, userId: string, attrs: Record<string, unknown>): Promise<ActiveResult | null> {
  await ensureScimUser(db, tenantId, userId);
  const sets: string[] = [];
  const params: unknown[] = [tenantId, userId];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if ("externalId" in attrs) set("external_id", attrs.externalId ?? null);
  if ("name.givenName" in attrs) set("given_name", attrs["name.givenName"] ?? null);
  if ("name.familyName" in attrs) set("family_name", attrs["name.familyName"] ?? null);
  if (sets.length) await db.query(`UPDATE scim_users SET ${sets.join(", ")}, updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, params);

  const membership = await db.one<any>(`SELECT role, role_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  const otherOrgs = Number((await db.one<any>(`SELECT count(*)::int AS n FROM memberships WHERE user_id = $1 AND tenant_id <> $2`, [userId, tenantId]))?.n ?? 0);

  let display = typeof attrs.displayName === "string" ? attrs.displayName.trim() : null;
  if (!display && ("name.givenName" in attrs || "name.familyName" in attrs)) {
    const su = await db.one<any>(`SELECT given_name, family_name FROM scim_users WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
    display = [su?.given_name, su?.family_name].filter(Boolean).join(" ").trim() || null;
  }
  // El nombre (como el correo) es de la cuenta, no de la organización: no se toca si la persona está en otras.
  if (display && otherOrgs === 0) await db.query(`UPDATE users SET name = $2 WHERE id = $1`, [userId, display.slice(0, 200)]);

  if (typeof attrs.userName === "string" && attrs.userName) {
    const email = attrs.userName.trim().toLowerCase();
    const cur = await db.one<any>(`SELECT email FROM users WHERE id = $1`, [userId]);
    if (cur && cur.email.toLowerCase() !== email) {
      // El correo es global: solo se cambia si el usuario no pertenece a otras organizaciones.
      if (otherOrgs > 0) throw new ScimError(400, "No se puede cambiar el correo de un usuario que pertenece a otras organizaciones", "mutability");
      // Cambiar el correo de acceso de un propietario equivaldría a tomar su cuenta.
      if (membership?.role === "owner") throw new ScimError(409, "El correo de un propietario no se puede cambiar por SCIM", "mutability");
      // Lo mismo con quien tiene más permisos que el rol por defecto de SCIM: el token lo puede crear quien tiene esos
      // permisos y no más; cambiar el correo de un administrador por uno propio (y restablecer la contraseña) sería
      // quedarse con su cuenta. Esos correos se cambian desde el IdP con el rol por defecto adecuado o desde la consola.
      if (membership && (await exceedsScimDefaultRole(db, tenantId, membership.role, membership.role_id))) {
        throw new ScimError(409, "El correo de un usuario con más permisos que el rol por defecto de SCIM no se puede cambiar por SCIM", "mutability");
      }
      const taken = await db.one(`SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2`, [email, userId]);
      if (taken) throw new ScimError(409, "Ya existe un usuario con ese correo", "uniqueness");
      await assertVerifiedDomain(db, tenantId, email);
      await db.query(`UPDATE users SET email = $2 WHERE id = $1`, [userId, email]);
    }
  }
  return "active" in attrs ? setActive(db, tenantId, userId, asBool(attrs.active)) : null;
}

function flattenUser(input: z.infer<typeof ScimUserInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const email = emailOf(input);
  if (email) out.userName = email;
  if (input.externalId !== undefined) out.externalId = input.externalId;
  if (input.displayName !== undefined) out.displayName = input.displayName;
  if (input.name) {
    if (input.name.givenName !== undefined) out["name.givenName"] = input.name.givenName;
    if (input.name.familyName !== undefined) out["name.familyName"] = input.name.familyName;
    if (!input.displayName && input.name.formatted) out.displayName = input.name.formatted;
  }
  if (input.active !== undefined) out.active = input.active;
  return out;
}

// ───────────────────────────── PATCH ─────────────────────────────

const PatchInput = z.object({
  schemas: z.array(z.string()).optional(),
  Operations: z
    .array(z.object({ op: z.string(), path: z.string().optional().nullable(), value: z.unknown().optional() }))
    .min(1)
    .max(100),
});

/** Reduce las operaciones de un PATCH de usuario a atributos planos. */
export function userPatchToAttrs(ops: z.infer<typeof PatchInput>["Operations"]): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  const assign = (path: string, value: unknown) => {
    const p = path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, "");
    if (/^emails(\[.*\])?(\.value)?$/i.test(p)) {
      const v = Array.isArray(value) ? (value.find((x: any) => asBool(x?.primary)) ?? value[0])?.value : typeof value === "object" && value ? (value as any).value : value;
      if (typeof v === "string") attrs.userName = v.trim().toLowerCase();
      return;
    }
    if (/^name$/i.test(p) && value && typeof value === "object") {
      const n = value as any;
      if ("givenName" in n) attrs["name.givenName"] = n.givenName;
      if ("familyName" in n) attrs["name.familyName"] = n.familyName;
      if (n.formatted) attrs.displayName = n.formatted;
      return;
    }
    const key = ({ username: "userName", externalid: "externalId", displayname: "displayName", active: "active", "name.givenname": "name.givenName", "name.familyname": "name.familyName" } as Record<string, string>)[p.toLowerCase()];
    if (key) attrs[key] = value;
  };
  for (const op of ops) {
    const kind = op.op.toLowerCase();
    if (kind !== "add" && kind !== "replace" && kind !== "remove") throw new ScimError(400, `Operación no admitida: ${op.op}`, "invalidSyntax");
    if (kind === "remove") {
      if (op.path) assign(op.path, null);
      continue;
    }
    if (op.path) assign(op.path, op.value);
    else if (op.value && typeof op.value === "object") for (const [k, v] of Object.entries(op.value as object)) assign(k, v);
  }
  return attrs;
}

// ───────────────────────────── Grupos ─────────────────────────────

async function toScimGroup(db: Db, g: any) {
  const members = await db.query<any>(
    `SELECT u.id, u.name FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1 ORDER BY u.name`,
    [g.id],
  );
  return {
    schemas: [SCHEMA_GROUP],
    id: g.id,
    externalId: g.external_id ?? undefined,
    displayName: g.name,
    members: members.map((m) => ({ value: m.id, display: m.name, $ref: `${scimBase()}/Users/${m.id}` })),
    meta: { resourceType: "Group", created: iso(g.created_at), lastModified: iso(g.updated_at ?? g.created_at), location: `${scimBase()}/Groups/${g.id}` },
  };
}

const GROUPS_SQL = `SELECT g.id, g.name, g.created_at, sg.external_id, sg.updated_at FROM groups g LEFT JOIN scim_groups sg ON sg.group_id = g.id WHERE g.tenant_id = $1`;

async function findGroup(db: Db, tenantId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ScimError(404, "Grupo no encontrado");
  const g = await db.one<any>(`${GROUPS_SQL} AND g.id = $2`, [tenantId, id]);
  if (!g) throw new ScimError(404, "Grupo no encontrado");
  return g;
}

async function addGroupMembers(db: Db, tenantId: string, groupId: string, userIds: string[]) {
  for (const uid of userIds) {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) continue;
    const m = await db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, uid]);
    if (!m) continue; // usuarios desactivados o ajenos a la organización no entran a grupos
    await db.query(`INSERT INTO group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [groupId, uid]);
  }
}

function memberIds(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  return arr.map((x: any) => (typeof x === "string" ? x : x?.value)).filter((x): x is string => typeof x === "string");
}

// ───────────────────────────── Rutas ─────────────────────────────

/**
 * Las altas por SCIM entran con el rol por defecto: elegirlo o crear un token que lo otorga equivale a asignar ese
 * rol, así que (como en invitaciones y miembros) solo lo hace quien tiene todos sus permisos o un propietario.
 */
function assertCanGrantScimRole(a: AuthContext, role: string) {
  if (a.access?.role === "owner") return;
  const perms = BUILTIN_ROLE_PERMISSIONS[role as keyof typeof BUILTIN_ROLE_PERMISSIONS] ?? [];
  const missing = perms.filter((p) => !hasPerm(a, p));
  if (missing.length) {
    throw new AppError(403, "forbidden", `No podés aprovisionar usuarios con el rol ${role}: te faltan permisos (${missing.join(", ")})`, { missing });
  }
}

export async function scimRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  // ───────── Administración de tokens (remitente) ─────────

  const toToken = (r: any): ScimToken => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: iso(r.created_at)!,
    lastUsedAt: iso(r.last_used_at),
    revokedAt: iso(r.revoked_at),
  });

  async function settingsOut(tenantId: string): Promise<ScimSettings> {
    const rows = await s.db.query(`SELECT * FROM scim_tokens WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
    const t = await s.db.one<any>(`SELECT scim_default_role FROM tenants WHERE id = $1`, [tenantId]);
    return { baseUrl: scimBase(), tokens: rows.map(toToken), defaultRole: t?.scim_default_role ?? "member" };
  }

  app.get("/v1/settings/scim", { preHandler: auth }, async (req) => settingsOut(req.auth!.tenantId));

  app.patch("/v1/settings/scim", { preHandler: auth }, async (req) => {
    const input = z.object({ defaultRole: z.enum(["admin", "member"]) }).parse(req.body);
    assertCanGrantScimRole(req.auth!, input.defaultRole);
    await s.db.query(`UPDATE tenants SET scim_default_role = $2 WHERE id = $1`, [req.auth!.tenantId, input.defaultRole]);
    return settingsOut(req.auth!.tenantId);
  });

  app.post("/v1/settings/scim/tokens", { preHandler: auth }, async (req, reply) => {
    const input = CreateScimTokenInput.parse(req.body);
    // El token no solo da altas con el rol por defecto: desactiva a cualquier miembro que no sea propietario (también
    // administradores) y arma los grupos (sumarse a uno da acceso a lo compartido con él). Con el rol por defecto
    // "member", un rol con members:manage + settings:manage y poco más creaba un token y hacía por SCIM lo que la consola
    // le niega (assertCanManage, assertCanAddToGroup). Lo crea quien tiene todos los permisos, o un propietario.
    assertCanGrantScimRole(req.auth!, "admin");
    const secret = `cs_scim_${randomToken(32)}`;
    const row = await s.db.one(
      `INSERT INTO scim_tokens (id, tenant_id, name, prefix, token_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuidv7(), req.auth!.tenantId, input.name, secret.slice(0, 14), sha256Hex(secret), await actingPerson(s.db, req.auth!)],
    );
    reply.code(201);
    return { token: toToken(row), secret };
  });

  app.delete<{ Params: { id: string } }>("/v1/settings/scim/tokens/:id", { preHandler: auth }, async (req, reply) => {
    const tenantId = req.auth!.tenantId;
    const released = await s.db.tx(async (t) => {
      const r = await t.query(`UPDATE scim_tokens SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL RETURNING id`, [req.params.id, tenantId]);
      if (!r.length) throw notFound("Token SCIM");
      // Era el último: sin IdP que administre, las bajas por SCIM ya no bloquean el alta JIT por SSO.
      return releaseScimJitBlocks(t, tenantId);
    });
    if (released) {
      await recordAudit(s.db, {
        tenantId,
        action: "scim.jit_blocks_released",
        actor: { type: req.auth!.apiKeyId ? "api_key" : "user", id: req.auth!.apiKeyId ?? req.auth!.userId, label: req.auth!.actor.label },
        targetType: "scim_token",
        targetId: req.params.id,
        data: { scimUsersReleased: released },
        ...clientInfo(req),
      }).catch(() => {});
    }
    return reply.code(204).send();
  });

  // ───────── Endpoints SCIM ─────────

  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser(["application/scim+json", "application/json"], { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => {
      try {
        done(null, body ? JSON.parse(String(body)) : {});
      } catch {
        done(new ScimError(400, "JSON inválido", "invalidSyntax") as any, undefined);
      }
    });

    sub.setErrorHandler((err, _req, reply) => {
      let e = err as any;
      // Carrera con otro alta del mismo correo o grupo (índice único): 409 SCIM en vez de 500.
      if (e?.code === "23505") e = new ScimError(409, "Ya existe un recurso con ese valor", "uniqueness");
      const status = e instanceof ScimError ? e.status : e instanceof z.ZodError ? 400 : e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
      const detail = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : status === 500 ? "Error interno" : e.message;
      if (status === 500) _req.log.error({ err }, "error SCIM");
      reply
        .code(status)
        .header("content-type", "application/scim+json")
        .send({ schemas: [SCHEMA_ERROR], status: String(status), detail, ...(e.scimType ? { scimType: e.scimType } : e instanceof z.ZodError ? { scimType: "invalidValue" } : {}) });
    });

    // Autenticación por token Bearer de la organización.
    sub.addHook("onRequest", async (req: FastifyRequest) => {
      const h = req.headers.authorization ?? "";
      const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
      if (!token) throw new ScimError(401, "Falta el token");
      const row = await s.db.one<any>(`SELECT id, tenant_id, name FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256Hex(token)]);
      if (!row) throw new ScimError(401, "Token inválido");
      s.db.query(`UPDATE scim_tokens SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
      (req as any).scim = { tenantId: row.tenant_id, tokenId: row.id, tokenName: row.name };
    });
    sub.addHook("onSend", async (_req, reply, payload) => {
      reply.header("content-type", "application/scim+json; charset=utf-8");
      return payload;
    });

    const T = (req: FastifyRequest) => (req as any).scim as { tenantId: string; tokenId: string; tokenName: string };
    const audit = (req: FastifyRequest, action: string, targetType: string, targetId: string, data: Record<string, unknown> = {}) =>
      recordAudit(s.db, {
        tenantId: T(req).tenantId,
        action,
        actor: { type: "system", id: T(req).tokenId, label: `SCIM: ${T(req).tokenName}` },
        targetType,
        targetId,
        data,
        ...clientInfo(req),
      });

    sub.get(`${BASE}/ServiceProviderConfig`, async () => ({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: `${config.appUrl}/developers`,
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer", description: "Token SCIM de la organización", primary: true }],
      meta: { resourceType: "ServiceProviderConfig", location: `${scimBase()}/ServiceProviderConfig` },
    }));

    sub.get(`${BASE}/ResourceTypes`, async () => ({
      schemas: [SCHEMA_LIST],
      totalResults: 2,
      Resources: [
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: SCHEMA_USER },
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: SCHEMA_GROUP },
      ],
    }));

    sub.get(`${BASE}/Schemas`, async () => ({
      schemas: [SCHEMA_LIST],
      totalResults: 2,
      Resources: [
        { id: SCHEMA_USER, name: "User", attributes: ["userName", "name", "displayName", "emails", "active", "externalId", "groups"].map((n) => ({ name: n })) },
        { id: SCHEMA_GROUP, name: "Group", attributes: ["displayName", "members", "externalId"].map((n) => ({ name: n })) },
      ],
    }));

    // Users
    sub.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>(`${BASE}/Users`, async (req) => {
      const { tenantId } = T(req);
      const f = parseFilter(req.query.filter, ["userName", "externalId", "emails.value"]);
      const startIndex = Math.min(1_000_000_000, Math.max(1, Math.trunc(Number(req.query.startIndex ?? 1)) || 1));
      const count = Math.min(200, Math.max(0, Math.trunc(Number(req.query.count ?? 100)) || 0));
      const params: unknown[] = [tenantId];
      let where = "";
      if (f) {
        params.push(f.value);
        where = f.attr === "externalId" ? ` AND su.external_id = $2` : ` AND lower(u.email) = lower($2)`;
      }
      const total = await s.db.one<any>(`SELECT count(*)::int AS n FROM (${USERS_SQL}${where}) x`, params);
      params.push(count, startIndex - 1);
      const rows = await s.db.query<UserRow>(`${USERS_SQL}${where} ORDER BY u.created_at, u.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return {
        schemas: [SCHEMA_LIST],
        totalResults: Number(total?.n ?? 0),
        startIndex,
        itemsPerPage: rows.length,
        Resources: await Promise.all(rows.map((u) => toScimUser(s.db, tenantId, u))),
      };
    });

    sub.get<{ Params: { id: string } }>(`${BASE}/Users/:id`, async (req) => toScimUser(s.db, T(req).tenantId, await findUser(s.db, T(req).tenantId, req.params.id)));

    sub.post(`${BASE}/Users`, async (req, reply: FastifyReply) => {
      const { tenantId } = T(req);
      const input = ScimUserInput.parse(req.body);
      const email = emailOf(input);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ScimError(400, "userName (correo) es obligatorio", "invalidValue");
      const active = input.active === undefined ? true : asBool(input.active);
      await assertVerifiedDomain(s.db, tenantId, email);
      const userId = await s.db.tx(async (t) => {
        let u = await t.one<any>(`SELECT id FROM users WHERE lower(email) = $1`, [email]);
        if (u) {
          // Un usuario borrado por SCIM (deleted_at) se puede volver a crear: el IdP no lo ve y no tiene otra forma.
          const known = await t.one(
            `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 UNION SELECT 1 FROM scim_users WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
            [tenantId, u.id],
          );
          if (known) throw new ScimError(409, "El usuario ya existe en la organización", "uniqueness");
          // Se vincula una cuenta existente tal cual (su 2FA y sus sesiones no se tocan); creada inactiva
          // (active = false) todavía no se vincula: la membresía se crea al activarla después.
        } else {
          u = { id: uuidv7() };
          await t.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,$3,'scim-provisioned','es')`, [u.id, email, displayNameOf(input, email)]);
        }
        await t.query(
          `INSERT INTO scim_users (tenant_id, user_id, external_id, given_name, family_name, active) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET external_id = EXCLUDED.external_id, given_name = EXCLUDED.given_name, family_name = EXCLUDED.family_name,
             active = EXCLUDED.active, deleted_at = NULL, updated_at = now()`,
          [tenantId, u.id, input.externalId ?? null, input.name?.givenName ?? null, input.name?.familyName ?? null, active],
        );
        if (active) await setActive(t, tenantId, u.id, true);
        return u.id as string;
      });
      await audit(req, "member.scim_provisioned", "user", userId, { email, active });
      reply.code(201).header("location", `${scimBase()}/Users/${userId}`);
      return toScimUser(s.db, tenantId, await findUser(s.db, tenantId, userId));
    });

    sub.put<{ Params: { id: string } }>(`${BASE}/Users/:id`, async (req) => {
      const { tenantId } = T(req);
      await findUser(s.db, tenantId, req.params.id);
      const input = ScimUserInput.parse(req.body);
      const attrs = flattenUser(input);
      if (!("active" in attrs)) attrs.active = true;
      const r = await s.db.tx((t) => applyUserAttrs(t, tenantId, req.params.id, attrs));
      await audit(req, "member.scim_updated", "user", req.params.id, { fields: Object.keys(attrs), ...revokedData(r?.revoked) });
      return toScimUser(s.db, tenantId, await findUser(s.db, tenantId, req.params.id));
    });

    sub.patch<{ Params: { id: string } }>(`${BASE}/Users/:id`, async (req) => {
      const { tenantId } = T(req);
      await findUser(s.db, tenantId, req.params.id);
      const input = PatchInput.parse(req.body);
      const attrs = userPatchToAttrs(input.Operations);
      const r = await s.db.tx((t) => applyUserAttrs(t, tenantId, req.params.id, attrs));
      await audit(req, "active" in attrs ? (asBool(attrs.active) ? "member.scim_activated" : "member.scim_deactivated") : "member.scim_updated", "user", req.params.id, {
        fields: Object.keys(attrs),
        ...revokedData(r?.revoked),
      });
      return toScimUser(s.db, tenantId, await findUser(s.db, tenantId, req.params.id));
    });

    sub.delete<{ Params: { id: string } }>(`${BASE}/Users/:id`, async (req, reply: FastifyReply) => {
      const { tenantId } = T(req);
      await findUser(s.db, tenantId, req.params.id);
      const revoked = await s.db.tx(async (t) => {
        await ensureScimUser(t, tenantId, req.params.id);
        const r = (await setActive(t, tenantId, req.params.id, false)).revoked;
        // La fila queda (active = false, deleted_at): sin ella el alta JIT por SSO lo volvía a sumar. GET y listados
        // SCIM ya no lo muestran (404).
        await t.query(`UPDATE scim_users SET active = false, deleted_at = now(), updated_at = now() WHERE tenant_id = $1 AND user_id = $2`, [tenantId, req.params.id]);
        return r;
      });
      await audit(req, "member.scim_deleted", "user", req.params.id, revokedData(revoked));
      return reply.code(204).send();
    });

    // Groups
    sub.get<{ Querystring: { filter?: string; startIndex?: string; count?: string; excludedAttributes?: string } }>(`${BASE}/Groups`, async (req) => {
      const { tenantId } = T(req);
      const f = parseFilter(req.query.filter, ["displayName", "externalId"]);
      const startIndex = Math.min(1_000_000_000, Math.max(1, Math.trunc(Number(req.query.startIndex ?? 1)) || 1));
      const count = Math.min(200, Math.max(0, Math.trunc(Number(req.query.count ?? 100)) || 0));
      const params: unknown[] = [tenantId];
      let where = "";
      if (f) {
        params.push(f.value);
        where = f.attr === "externalId" ? ` AND sg.external_id = $2` : ` AND lower(g.name) = lower($2)`;
      }
      const total = await s.db.one<any>(`SELECT count(*)::int AS n FROM (${GROUPS_SQL}${where}) x`, params);
      params.push(count, startIndex - 1);
      const rows = await s.db.query<any>(`${GROUPS_SQL}${where} ORDER BY g.created_at, g.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      const noMembers = /members/.test(req.query.excludedAttributes ?? "");
      const resources = await Promise.all(rows.map((g) => toScimGroup(s.db, g)));
      return {
        schemas: [SCHEMA_LIST],
        totalResults: Number(total?.n ?? 0),
        startIndex,
        itemsPerPage: rows.length,
        Resources: noMembers ? resources.map(({ members: _m, ...g }) => g) : resources,
      };
    });

    sub.get<{ Params: { id: string } }>(`${BASE}/Groups/:id`, async (req) => toScimGroup(s.db, await findGroup(s.db, T(req).tenantId, req.params.id)));

    const GroupInput = z
      .object({ displayName: z.string().trim().min(1).max(200), externalId: z.string().max(500).optional().nullable(), members: z.array(z.any()).optional() })
      .passthrough();

    sub.post(`${BASE}/Groups`, async (req, reply: FastifyReply) => {
      const { tenantId } = T(req);
      const input = GroupInput.parse(req.body);
      const id = uuidv7();
      await s.db.tx(async (t) => {
        const dup = await t.one(`SELECT 1 FROM groups WHERE tenant_id = $1 AND lower(name) = lower($2)`, [tenantId, input.displayName]);
        if (dup) throw new ScimError(409, "Ya existe un grupo con ese nombre", "uniqueness");
        await t.query(`INSERT INTO groups (id, tenant_id, name) VALUES ($1,$2,$3)`, [id, tenantId, input.displayName]);
        await t.query(`INSERT INTO scim_groups (group_id, tenant_id, external_id) VALUES ($1,$2,$3)`, [id, tenantId, input.externalId ?? null]);
        await addGroupMembers(t, tenantId, id, memberIds(input.members));
      });
      await audit(req, "group.scim_created", "group", id, { name: input.displayName });
      reply.code(201).header("location", `${scimBase()}/Groups/${id}`);
      return toScimGroup(s.db, await findGroup(s.db, tenantId, id));
    });

    sub.put<{ Params: { id: string } }>(`${BASE}/Groups/:id`, async (req) => {
      const { tenantId } = T(req);
      const g = await findGroup(s.db, tenantId, req.params.id);
      const input = GroupInput.parse(req.body);
      await s.db.tx(async (t) => {
        await t.query(`UPDATE groups SET name = $2 WHERE id = $1`, [g.id, input.displayName]);
        await t.query(
          `INSERT INTO scim_groups (group_id, tenant_id, external_id) VALUES ($1,$2,$3) ON CONFLICT (group_id) DO UPDATE SET external_id = EXCLUDED.external_id, updated_at = now()`,
          [g.id, tenantId, input.externalId ?? null],
        );
        await t.query(`DELETE FROM group_members WHERE group_id = $1`, [g.id]);
        await addGroupMembers(t, tenantId, g.id, memberIds(input.members));
      });
      await audit(req, "group.scim_updated", "group", g.id);
      return toScimGroup(s.db, await findGroup(s.db, tenantId, g.id));
    });

    sub.patch<{ Params: { id: string } }>(`${BASE}/Groups/:id`, async (req, reply: FastifyReply) => {
      const { tenantId } = T(req);
      const g = await findGroup(s.db, tenantId, req.params.id);
      const input = PatchInput.parse(req.body);
      await s.db.tx(async (t) => {
        for (const op of input.Operations) {
          const kind = op.op.toLowerCase();
          const path = op.path ?? "";
          const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(path);
          if (kind === "remove" && filtered) {
            await t.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id::text = $2`, [g.id, filtered[1]]);
          } else if (/^members$/i.test(path)) {
            if (kind === "add") await addGroupMembers(t, tenantId, g.id, memberIds(op.value));
            else if (kind === "remove") {
              const ids = memberIds(op.value);
              if (ids.length) await t.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id::text = ANY($2)`, [g.id, ids]);
              else await t.query(`DELETE FROM group_members WHERE group_id = $1`, [g.id]);
            } else if (kind === "replace") {
              await t.query(`DELETE FROM group_members WHERE group_id = $1`, [g.id]);
              await addGroupMembers(t, tenantId, g.id, memberIds(op.value));
            }
          } else if (/^displayName$/i.test(path) && kind !== "remove") {
            await t.query(`UPDATE groups SET name = $2 WHERE id = $1`, [g.id, String(op.value)]);
          } else if (/^externalId$/i.test(path)) {
            await t.query(
              `INSERT INTO scim_groups (group_id, tenant_id, external_id) VALUES ($1,$2,$3) ON CONFLICT (group_id) DO UPDATE SET external_id = EXCLUDED.external_id`,
              [g.id, tenantId, kind === "remove" ? null : op.value ?? null],
            );
          } else if (!path && op.value && typeof op.value === "object") {
            const v = op.value as any;
            if (v.displayName) await t.query(`UPDATE groups SET name = $2 WHERE id = $1`, [g.id, String(v.displayName)]);
            if (v.members) {
              if (kind === "replace") await t.query(`DELETE FROM group_members WHERE group_id = $1`, [g.id]);
              await addGroupMembers(t, tenantId, g.id, memberIds(v.members));
            }
          } else {
            throw new ScimError(400, `Ruta de PATCH no admitida: ${path || "(vacía)"}`, "invalidPath");
          }
        }
        await t.query(`UPDATE scim_groups SET updated_at = now() WHERE group_id = $1`, [g.id]);
      });
      await audit(req, "group.scim_updated", "group", g.id, { operations: input.Operations.length });
      // Azure AD espera 204 sin cuerpo cuando no se piden atributos; Okta acepta ambos.
      if (input.Operations.every((o) => /^members/i.test(o.path ?? ""))) return reply.code(204).send();
      return toScimGroup(s.db, await findGroup(s.db, tenantId, g.id));
    });

    sub.delete<{ Params: { id: string } }>(`${BASE}/Groups/:id`, async (req, reply: FastifyReply) => {
      const { tenantId } = T(req);
      const g = await findGroup(s.db, tenantId, req.params.id);
      await s.db.tx(async (t) => {
        await t.query(`DELETE FROM envelope_shares WHERE group_id = $1`, [g.id]);
        await t.query(`DELETE FROM template_shares WHERE group_id = $1`, [g.id]);
        await t.query(`DELETE FROM groups WHERE id = $1`, [g.id]);
      });
      await audit(req, "group.scim_deleted", "group", g.id);
      return reply.code(204).send();
    });
  });
}
