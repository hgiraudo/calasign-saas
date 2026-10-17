// Control de acceso central (RBAC). `authenticate()` llama a loadAccess + enforceRoutePolicy, así que
// cada ruta autenticada queda cubierta sin tocar su handler. Reglas por patrón de ruta:
//   /v1/envelopes/:id…      → acceso al sobre (ver: dueño, grupos compartidos o envelopes:view_all;
//                              modificar: dueño o envelopes:manage_all)
//   POST /v1/envelopes[/…]  → envelopes:create
//   /v1/templates/:id…      → acceso a la plantilla (ver según visibilidad; modificar: creador o templates:manage)
//   /v1/settings/* (no GET) → settings:manage      /v1/api-keys* → api_keys:manage
//   /v1/webhooks*, /v1/webhook-deliveries* → webhooks:manage      /v1/audit-log* → audit:view
//   /v1/members*, /v1/roles*, /v1/groups*, /v1/invitations* (no GET) → members:manage
// Rutas nuevas de otros módulos heredan estas reglas por su prefijo.
import type { FastifyRequest } from "fastify";
import { BUILTIN_ROLE_PERMISSIONS, PERMISSIONS, type MemberRole, type Permission } from "@calasign/shared";
import type { Db } from "../infra/db";
import { AppError, forbidden, notFound } from "../lib/errors";
import type { AuthContext } from "./context";

export interface AccessInfo {
  role: MemberRole;
  roleId: string | null;
  roleName: string;
  permissions: ReadonlySet<Permission>;
  groupIds: string[];
  twoFactorSetupRequired: boolean;
}

const ROLE_NAMES: Record<string, string> = { owner: "Propietario", admin: "Administrador", member: "Miembro" };

function builtin(role: string): Set<Permission> {
  return new Set(BUILTIN_ROLE_PERMISSIONS[role as keyof typeof BUILTIN_ROLE_PERMISSIONS] ?? []);
}

function sanitize(perms: string[] | null | undefined): Set<Permission> {
  const allowed = new Set<string>(PERMISSIONS);
  return new Set((perms ?? []).filter((p): p is Permission => allowed.has(p)));
}

/** Rol, permisos y grupos de un usuario o API key dentro de un tenant. */
export async function loadAccess(db: Db, a: { tenantId: string; userId: string | null; apiKeyId: string | null }): Promise<AccessInfo> {
  if (a.apiKeyId) {
    const k = await db.one<any>(
      `SELECT k.role, k.role_id, r.name AS role_name, r.permissions FROM api_keys k LEFT JOIN roles r ON r.id = k.role_id WHERE k.id = $1`,
      [a.apiKeyId],
    );
    const role = (k?.role ?? "admin") as MemberRole;
    return {
      role,
      roleId: k?.role_id ?? null,
      roleName: role === "custom" ? k?.role_name ?? "?" : ROLE_NAMES[role] ?? role,
      permissions: role === "custom" ? sanitize(k?.permissions) : builtin(role),
      groupIds: [],
      twoFactorSetupRequired: false,
    };
  }
  const m = await db.one<any>(
    `SELECT m.role, m.role_id, r.name AS role_name, r.permissions, t.require_2fa, u.totp_enabled_at
     FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id
     LEFT JOIN roles r ON r.id = m.role_id
     WHERE m.tenant_id = $1 AND m.user_id = $2`,
    [a.tenantId, a.userId],
  );
  if (!m) throw new AppError(401, "unauthorized", "Ya no sos miembro de esta organización");
  const groups = await db.query<{ group_id: string }>(
    `SELECT gm.group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = $1 AND g.tenant_id = $2`,
    [a.userId, a.tenantId],
  );
  const role = m.role as MemberRole;
  return {
    role,
    roleId: m.role_id,
    roleName: role === "custom" ? m.role_name : ROLE_NAMES[role] ?? role,
    permissions: role === "custom" ? sanitize(m.permissions) : builtin(role),
    groupIds: groups.map((g) => g.group_id),
    twoFactorSetupRequired: Boolean(m.require_2fa) && !m.totp_enabled_at,
  };
}

export function hasPerm(a: AuthContext, p: Permission): boolean {
  return Boolean(a.access?.permissions.has(p));
}

export function requirePerm(a: AuthContext, p: Permission) {
  if (!hasPerm(a, p)) throw new AppError(403, "forbidden", `Falta el permiso ${p}`, { permission: p });
}

// ───────────────────────────── Sobres ─────────────────────────────

/** Condición SQL de visibilidad de sobres (alias `e`). Agrega sus parámetros a `params`. Vacía si ve todo. */
export function envelopeVisibilitySql(a: AuthContext, params: unknown[], alias = "e"): string {
  if (hasPerm(a, "envelopes:view_all") || hasPerm(a, "envelopes:manage_all")) return "";
  if (a.apiKeyId) {
    params.push(a.apiKeyId);
    return ` AND ${alias}.created_by_api_key = $${params.length}`;
  }
  params.push(a.userId);
  const u = `$${params.length}`;
  params.push(a.access?.groupIds ?? []);
  const g = `$${params.length}::uuid[]`;
  return ` AND (${alias}.created_by = ${u} OR EXISTS (SELECT 1 FROM envelope_shares es WHERE es.envelope_id = ${alias}.id AND es.group_id = ANY(${g})))`;
}

export async function assertEnvelopeAccess(db: Db, a: AuthContext, envelopeId: string, mode: "view" | "manage") {
  if (!/^[0-9a-f-]{36}$/i.test(envelopeId)) throw notFound("Sobre");
  const e = await db.one<any>(`SELECT id, created_by, created_by_api_key FROM envelopes WHERE id = $1 AND tenant_id = $2`, [envelopeId, a.tenantId]);
  if (!e) throw notFound("Sobre");
  if (hasPerm(a, "envelopes:manage_all")) return;
  const own = a.apiKeyId ? e.created_by_api_key === a.apiKeyId : e.created_by === a.userId;
  if (own) return;
  if (mode === "view") {
    if (hasPerm(a, "envelopes:view_all")) return;
    const groups = a.access?.groupIds ?? [];
    if (groups.length) {
      const shared = await db.one(`SELECT 1 FROM envelope_shares WHERE envelope_id = $1 AND group_id = ANY($2::uuid[])`, [envelopeId, groups]);
      if (shared) return;
    }
    // Sin acceso de lectura: 404 para no revelar que existe.
    throw notFound("Sobre");
  }
  // Puede verlo pero no modificarlo: 403 explícito.
  const canView =
    hasPerm(a, "envelopes:view_all") ||
    ((a.access?.groupIds.length ?? 0) > 0 &&
      Boolean(await db.one(`SELECT 1 FROM envelope_shares WHERE envelope_id = $1 AND group_id = ANY($2::uuid[])`, [envelopeId, a.access!.groupIds])));
  if (!canView) throw notFound("Sobre");
  throw new AppError(403, "forbidden", "No podés modificar este sobre", { permission: "envelopes:manage_all" });
}

// ───────────────────────────── Plantillas ─────────────────────────────

export function templateVisibilitySql(a: AuthContext, params: unknown[], alias = "t"): string {
  if (hasPerm(a, "templates:manage")) return "";
  params.push(a.userId);
  const u = `$${params.length}`;
  params.push(a.access?.groupIds ?? []);
  const g = `$${params.length}::uuid[]`;
  return ` AND (${alias}.visibility = 'organization' OR ${alias}.created_by = ${u} OR EXISTS (SELECT 1 FROM template_shares ts WHERE ts.template_id = ${alias}.id AND ts.group_id = ANY(${g})))`;
}

export async function assertTemplateAccess(db: Db, a: AuthContext, templateId: string, mode: "view" | "manage") {
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) throw notFound("Plantilla");
  const t = await db.one<any>(`SELECT id, created_by, visibility FROM templates WHERE id = $1 AND tenant_id = $2`, [templateId, a.tenantId]);
  if (!t) throw notFound("Plantilla");
  if (hasPerm(a, "templates:manage")) return;
  const own = a.userId !== null && t.created_by === a.userId;
  if (own) return;
  let canView = t.visibility === "organization";
  if (!canView && (a.access?.groupIds.length ?? 0) > 0) {
    canView = Boolean(await db.one(`SELECT 1 FROM template_shares WHERE template_id = $1 AND group_id = ANY($2::uuid[])`, [templateId, a.access!.groupIds]));
  }
  if (!canView) throw notFound("Plantilla");
  if (mode === "manage") throw new AppError(403, "forbidden", "No podés modificar esta plantilla", { permission: "templates:manage" });
}

// ───────────────────────────── Política por ruta ─────────────────────────────

const ALWAYS_ALLOWED_DURING_2FA_SETUP = [/^\/v1\/me(\/|$)/, /^\/v1\/auth\//];

/** Aplica la política de la ruta. Se llama desde authenticate(), después de cargar el acceso. */
export async function enforceRoutePolicy(db: Db, req: FastifyRequest, a: AuthContext) {
  const url = req.routeOptions?.url ?? req.url.split("?")[0];
  const method = req.method;
  const params = (req.params ?? {}) as Record<string, string>;
  const isRead = method === "GET" || method === "HEAD";

  if (a.access?.twoFactorSetupRequired && !ALWAYS_ALLOWED_DURING_2FA_SETUP.some((r) => r.test(url))) {
    throw new AppError(403, "two_factor_setup_required", "Tu organización exige verificación en dos pasos: activala para continuar");
  }

  // Sobres
  if (url.startsWith("/v1/envelopes/:id")) {
    const readLike = isRead || url === "/v1/envelopes/:id/remind";
    return assertEnvelopeAccess(db, a, params.id, readLike ? "view" : "manage");
  }
  if (url.startsWith("/v1/envelopes") && method === "POST") return requirePerm(a, "envelopes:create");

  // Plantillas
  if (url === "/v1/templates/from-envelope/:envelopeId") {
    requirePerm(a, "envelopes:create");
    return assertEnvelopeAccess(db, a, params.envelopeId, "view");
  }
  if (url === "/v1/templates/:id/bulk-csv") return assertTemplateAccess(db, a, params.id, "view");
  if (url.startsWith("/v1/templates/:id")) return assertTemplateAccess(db, a, params.id, isRead ? "view" : "manage");
  if (url.startsWith("/v1/templates") && method === "POST") return requirePerm(a, "envelopes:create");

  // Identidad (Fase 5): SSO exige settings:manage (también para leer la configuración); SCIM, members:manage.
  if (url.startsWith("/v1/settings/sso")) return requirePerm(a, "settings:manage");
  if (url.startsWith("/v1/settings/scim")) {
    requirePerm(a, "members:manage");
    if (!isRead) requirePerm(a, "settings:manage");
    return;
  }

  // Administración
  if (url.startsWith("/v1/settings/") && !isRead) return requirePerm(a, "settings:manage");
  if (url.startsWith("/v1/api-keys")) {
    requirePerm(a, "api_keys:manage");
    // Una API key nueva nace con rol admin salvo que se pida otro: quien la crea tiene que tener
    // todos los permisos que la key va a tener (si no, sería una escalada de privilegios).
    if (method === "POST" && url === "/v1/api-keys") {
      const body = (req.body ?? {}) as { role?: string; roleId?: string };
      const role = body.role ?? "admin";
      if (role === "owner") throw new AppError(400, "invalid_role", "Una API key no puede ser propietaria");
      let perms: readonly Permission[] = BUILTIN_ROLE_PERMISSIONS[role as keyof typeof BUILTIN_ROLE_PERMISSIONS] ?? [];
      if (role === "custom") {
        const r = await db.one<any>(`SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2`, [body.roleId ?? null, a.tenantId]);
        if (!r) throw new AppError(400, "invalid_role", "Rol inexistente");
        perms = r.permissions;
      } else if (!["admin", "member"].includes(role)) {
        throw new AppError(400, "invalid_role", "Rol inválido");
      }
      if (a.access?.role !== "owner") {
        const missing = perms.filter((p) => !hasPerm(a, p));
        if (missing.length) throw new AppError(403, "forbidden", `No podés crear una API key con permisos que no tenés: ${missing.join(", ")}`, { missing });
      }
    }
    return;
  }
  if (url.startsWith("/v1/webhooks") || url.startsWith("/v1/webhook-deliveries")) return requirePerm(a, "webhooks:manage");
  if (url.startsWith("/v1/audit-log")) return requirePerm(a, "audit:view");
  // Envío masivo y formularios web: crean sobres en nombre de quien los configura.
  if (/^\/v1\/(bulk-sends|web-forms)(\/|$)/.test(url)) return requirePerm(a, "envelopes:create");
  // Reportes: estadísticas de toda la organización.
  if (url.startsWith("/v1/reports")) return requirePerm(a, "envelopes:view_all");
  if (/^\/v1\/(members|roles|groups|invitations)(\/|$)/.test(url) && !isRead) return requirePerm(a, "members:manage");
  if (url.startsWith("/v1/invitations") && isRead) return requirePerm(a, "members:manage");
}

export function assertNotForbiddenRole(a: AuthContext, target: { role: string }) {
  if (target.role === "owner" && a.access?.role !== "owner") throw forbidden("Solo un propietario puede asignar o quitar el rol de propietario");
}
