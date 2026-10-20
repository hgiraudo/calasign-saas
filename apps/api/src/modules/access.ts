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
import { enforcePlanForRequest } from "./billing/plans";

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
  // También los sobres en los que es anfitrión de una firma en persona: tiene que encontrarlos para abrir la sesión.
  return (
    ` AND (${alias}.created_by = ${u} OR EXISTS (SELECT 1 FROM envelope_shares es WHERE es.envelope_id = ${alias}.id AND es.group_id = ANY(${g}))` +
    ` OR EXISTS (SELECT 1 FROM recipients hr WHERE hr.envelope_id = ${alias}.id AND hr.in_person_host_user_id = ${u}))`
  );
}

/** El usuario es anfitrión de una firma en persona del sobre (o de ese destinatario, si se indica). */
async function isInPersonHost(db: Db, a: AuthContext, envelopeId: string, recipientId?: string): Promise<boolean> {
  if (!a.userId || a.apiKeyId) return false;
  if (recipientId !== undefined && !/^[0-9a-f-]{36}$/i.test(recipientId)) return false;
  const row = await db.one(
    `SELECT 1 FROM recipients WHERE envelope_id = $1 AND tenant_id = $2 AND in_person_host_user_id = $3 ${recipientId !== undefined ? "AND id = $4" : ""} LIMIT 1`,
    recipientId !== undefined ? [envelopeId, a.tenantId, a.userId, recipientId] : [envelopeId, a.tenantId, a.userId],
  );
  return Boolean(row);
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
    if (await isInPersonHost(db, a, envelopeId)) return;
    // Sin acceso de lectura: 404 para no revelar que existe.
    throw notFound("Sobre");
  }
  // Puede verlo pero no modificarlo: 403 explícito.
  const canView =
    hasPerm(a, "envelopes:view_all") ||
    ((a.access?.groupIds.length ?? 0) > 0 &&
      Boolean(await db.one(`SELECT 1 FROM envelope_shares WHERE envelope_id = $1 AND group_id = ANY($2::uuid[])`, [envelopeId, a.access!.groupIds]))) ||
    (await isInPersonHost(db, a, envelopeId));
  if (!canView) throw notFound("Sobre");
  throw new AppError(403, "forbidden", "No podés modificar este sobre", { permission: "envelopes:manage_all" });
}

// ───────────────────────────── Plantillas ─────────────────────────────

export function templateVisibilitySql(a: AuthContext, params: unknown[], alias = "t"): string {
  if (hasPerm(a, "templates:manage")) return "";
  // Dueño: el usuario que la creó o, si la creó una API key, esa key.
  params.push(a.apiKeyId ?? a.userId);
  const owner = a.apiKeyId ? `${alias}.created_by_api_key = $${params.length}` : `${alias}.created_by = $${params.length}`;
  params.push(a.access?.groupIds ?? []);
  const g = `$${params.length}::uuid[]`;
  return ` AND (${alias}.visibility = 'organization' OR ${owner} OR EXISTS (SELECT 1 FROM template_shares ts WHERE ts.template_id = ${alias}.id AND ts.group_id = ANY(${g})))`;
}

/** Regla de "manage" de assertTemplateAccess sobre una fila ya cargada (con created_by y created_by_api_key). */
export function canManageTemplateRow(a: AuthContext, t: { created_by: string | null; created_by_api_key: string | null }): boolean {
  if (hasPerm(a, "templates:manage")) return true;
  return a.apiKeyId ? t.created_by_api_key === a.apiKeyId : a.userId !== null && t.created_by === a.userId;
}

export async function assertTemplateAccess(db: Db, a: AuthContext, templateId: string, mode: "view" | "manage") {
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) throw notFound("Plantilla");
  const t = await db.one<any>(`SELECT id, created_by, created_by_api_key, visibility FROM templates WHERE id = $1 AND tenant_id = $2`, [templateId, a.tenantId]);
  if (!t) throw notFound("Plantilla");
  if (canManageTemplateRow(a, t)) return;
  let canView = t.visibility === "organization";
  if (!canView && (a.access?.groupIds.length ?? 0) > 0) {
    canView = Boolean(await db.one(`SELECT 1 FROM template_shares WHERE template_id = $1 AND group_id = ANY($2::uuid[])`, [templateId, a.access!.groupIds]));
  }
  if (!canView) throw notFound("Plantilla");
  if (mode === "manage") throw new AppError(403, "forbidden", "No podés modificar esta plantilla", { permission: "templates:manage" });
}

// ───────────────────────────── Política por ruta ─────────────────────────────

const ALWAYS_ALLOWED_DURING_2FA_SETUP = [/^\/v1\/me(\/|$)/, /^\/v1\/auth\//];

/** Rutas autenticadas que cambian datos sin pedir permisos: solo tocan datos de quien llama (el handler exige sesión). */
const SELF_SCOPED_MUTATIONS = new Set([
  "POST /v1/me/2fa/setup",
  "POST /v1/me/2fa/enable",
  "POST /v1/me/2fa/disable",
  "POST /v1/me/2fa/recovery-codes",
  "POST /v1/auth/switch-tenant",
  "POST /v1/oauth/authorize/decision",
  "DELETE /v1/oauth/connected-apps/:clientId",
]);

/** Aplica la política de la ruta. Se llama desde authenticate(), después de cargar el acceso. */
export async function enforceRoutePolicy(db: Db, req: FastifyRequest, a: AuthContext) {
  const url = req.routeOptions?.url ?? req.url.split("?")[0];
  const method = req.method;
  const params = (req.params ?? {}) as Record<string, string>;
  const isRead = method === "GET" || method === "HEAD";

  if (a.access?.twoFactorSetupRequired && !ALWAYS_ALLOWED_DURING_2FA_SETUP.some((r) => r.test(url))) {
    throw new AppError(403, "two_factor_setup_required", "Tu organización exige verificación en dos pasos: activala para continuar");
  }

  // Plan y facturación: límites del plan (402 plan_limit) y permiso billing:manage.
  await enforcePlanForRequest(db, req, a);
  if (/^\/v1\/billing(\/|$)/.test(url)) return requirePerm(a, "billing:manage");


  // Sobres
  // En persona: la sesión la abre el anfitrión asignado (el handler exige que sea él), aunque el sobre no sea suyo; p. ej.
  // uno creado con una API key, que tiene que indicar el anfitrión, o por un colega que lo eligió como anfitrión.
  if (url === "/v1/envelopes/:id/recipients/:recipientId/in-person" && /^[0-9a-f-]{36}$/i.test(params.id ?? "")) {
    if (await isInPersonHost(db, a, params.id, params.recipientId)) return;
  }
  if (url.startsWith("/v1/envelopes/:id")) {
    // Clonar no modifica el original (como /v1/templates/from-envelope, alcanza con verlo); el handler exige envelopes:create.
    const readLike = isRead || url === "/v1/envelopes/:id/remind" || url === "/v1/envelopes/:id/clone";
    return assertEnvelopeAccess(db, a, params.id, readLike ? "view" : "manage");
  }
  // Lote: cada elemento se ejecuta como su pedido individual (app.inject con la misma credencial) y ahí se aplica su
  // política. Sin esto, el lote exigía envelopes:create también para action=get (un rol de solo lectura recibía 403).
  if (url === "/v1/envelopes/batch") return;
  if (url.startsWith("/v1/envelopes") && method === "POST") return requirePerm(a, "envelopes:create");

  // Plantillas
  if (url === "/v1/templates/from-envelope/:envelopeId") {
    requirePerm(a, "envelopes:create");
    return assertEnvelopeAccess(db, a, params.envelopeId, "view");
  }
  if (url === "/v1/templates/:id/bulk-csv") return assertTemplateAccess(db, a, params.id, "view");
  if (url.startsWith("/v1/templates/:id")) return assertTemplateAccess(db, a, params.id, isRead ? "view" : "manage");
  if (url.startsWith("/v1/templates") && method === "POST") return requirePerm(a, "envelopes:create");

  // BYOK: activar, cambiar o desactivar la clave decide quién puede leer los documentos de la organización: solo un propietario.
  if (url === "/v1/settings/byok" && (method === "PUT" || method === "DELETE")) {
    requirePerm(a, "settings:manage");
    if (a.access?.role !== "owner") throw forbidden("Solo un propietario de la organización puede activar, cambiar o desactivar la clave BYOK");
    return;
  }
  // Identidad (Fase 5): SSO exige settings:manage (también para leer la configuración); SCIM, members:manage.
  if (url.startsWith("/v1/settings/sso")) return requirePerm(a, "settings:manage");
  if (url.startsWith("/v1/settings/scim")) {
    requirePerm(a, "members:manage");
    if (!isRead) requirePerm(a, "settings:manage");
    return;
  }

  // Supresiones de correo (quejas de la organización): ver la lista expone direcciones de firmantes de todos los sobres.
  if (url.startsWith("/v1/settings/email-suppressions")) return requirePerm(a, "settings:manage");
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
  if (url.startsWith("/v1/webhooks") || url.startsWith("/v1/webhook-deliveries")) {
    requirePerm(a, "webhooks:manage");
    // Un webhook recibe los datos (asunto, destinatarios) de TODOS los sobres de la organización: crearlo, cambiar su
    // URL o reenviar entregas pide además poder verlos todos.
    if (!isRead) requirePerm(a, "envelopes:view_all");
    return;
  }
  if (url.startsWith("/v1/audit-log")) return requirePerm(a, "audit:view");
  // Evidencia: certificados de la organización (listarlos alcanza con poder crear sobres, para elegir el sello
  // de empresa), conectores de firma y firma XML.
  if (url === "/v1/certificates" && isRead) return requirePerm(a, "envelopes:create");
  if (url.startsWith("/v1/certificates") || url.startsWith("/v1/signature-providers")) return requirePerm(a, "settings:manage");
  // Firmar XML con un certificado de la organización (p. ej. facturas electrónicas) es firmar en nombre de la empresa
  // cualquier contenido: no alcanza con poder crear sobres.
  if (url === "/v1/xml/sign") return requirePerm(a, "settings:manage");
  if (url.startsWith("/v1/xml/")) return requirePerm(a, "envelopes:create");
  // Envío masivo y formularios web: crean sobres en nombre de quien los configura.
  if (/^\/v1\/(bulk-sends|web-forms)(\/|$)/.test(url)) return requirePerm(a, "envelopes:create");
  // Plataforma: apps OAuth (como las API keys), avisos a Slack/Teams, almacenamiento y dominio propio.
  if (url.startsWith("/v1/oauth/apps")) return requirePerm(a, "api_keys:manage");
  if (/^\/v1\/(notification-integrations|storage|domains)(\/|$)/.test(url)) {
    if (url.startsWith("/v1/storage/oauth/") && url.endsWith("/callback")) return;
    requirePerm(a, "settings:manage");
    // Archivo en un bucket propio o avisos a un canal: reciben los PDF firmados o los datos de todos los sobres.
    if (!isRead && !url.startsWith("/v1/domains")) requirePerm(a, "envelopes:view_all");
    return;
  }
  // Aprobaciones de workflows: quien fue asignado para aprobar es cualquier miembro (checkApprovers solo pide la
  // membresía), así que ver ejecuciones y decidir no exige envelopes:create. Cada ruta ya limita lo visible (quien la
  // inició, quien aprueba o quien ve todo) y quién decide (canDecide). Sin esto, un aprobador con un rol sin ese
  // permiso recibía el aviso pero no podía aprobar y la ejecución quedaba esperando.
  if (/^\/v1\/workflow-runs(\/|$)/.test(url) && (isRead || url === "/v1/workflow-runs/:id/steps/:index/decision")) return;
  // Acuerdos (Fase 6): repositorio, documentos generados, cláusulas, workflows y negociación. Los permisos
  // finos (plantillas y workflows: templates:manage; campos: settings:manage) se validan en cada ruta.
  if (/^\/v1\/(agreements|agreement-views|agreement-fields|document-templates|clauses|workflows|workflow-runs|negotiations)(\/|$)/.test(url)) {
    return requirePerm(a, "envelopes:create");
  }
  // CRM y ERP: enviar desde un registro y vincular sobres crea/opera sobres; conexiones y mapeos son ajustes.
  if (url.startsWith("/v1/crm/")) {
    if (url.startsWith("/v1/crm/oauth/") && url.endsWith("/callback")) return;
    if (url === "/v1/crm/mappings/:id/send" || url.startsWith("/v1/crm/links")) return requirePerm(a, "envelopes:create");
    if (isRead && (url.startsWith("/v1/crm/runs") || url === "/v1/crm/providers")) return;
    // Listar los mapeos (para elegir uno y enviar desde el CRM, p. ej. la acción de Pipedrive): quien puede enviar.
    if (isRead && url === "/v1/crm/mappings") return requirePerm(a, "envelopes:create");
    requirePerm(a, "settings:manage");
    // Conexiones y mapeos escriben el estado (y adjuntan PDF) de los sobres en el CRM: pide ver todos los sobres.
    if (!isRead) requirePerm(a, "envelopes:view_all");
    return;
  }
  // Conectores HRIS/CLM: enviar desde un registro y ver vínculos opera sobres; conexiones, búsqueda de registros
  // (datos de RR. HH.) y flujos son ajustes.
  if (url.startsWith("/v1/connectors/")) {
    if (url.startsWith("/v1/connectors/oauth/") && url.endsWith("/callback")) return;
    if (url === "/v1/connectors/flows/:id/send" || url.startsWith("/v1/connectors/links")) return requirePerm(a, "envelopes:create");
    if (isRead && (url.startsWith("/v1/connectors/runs") || url === "/v1/connectors/providers")) return;
    requirePerm(a, "settings:manage");
    if (!isRead) requirePerm(a, "envelopes:view_all");
    return;
  }
  // Datos: la clave BYOK (y su política) solo la ven y administran quienes manejan los ajustes.
  if (url.startsWith("/v1/settings/byok") || url.startsWith("/v1/settings/sso/domains")) return requirePerm(a, "settings:manage");
  // Reportes: estadísticas de toda la organización.
  if (url.startsWith("/v1/reports")) return requirePerm(a, "envelopes:view_all");
  // Salir de la organización: quitarse a uno mismo (con su sesión, no con una key ni un token de app) no pide
  // members:manage; el handler cuida que no quede sin propietario.
  if (method === "DELETE" && url === "/v1/members/:userId" && a.userId && !a.apiKeyId && !a.oauth && params.userId === a.userId) return;
  if (/^\/v1\/(members|roles|groups|invitations)(\/|$)/.test(url) && !isRead) return requirePerm(a, "members:manage");
  if (url.startsWith("/v1/invitations") && isRead) return requirePerm(a, "members:manage");
  // Rechazo por defecto: una ruta autenticada que cambia datos y no coincidió con ninguna regla de arriba tiene que
  // sumarse a SELF_SCOPED_MUTATIONS (si solo toca datos propios de quien llama) o tener su propia regla de permisos.
  // Así una ruta nueva no queda abierta a cualquier miembro por olvido. Esta comprobación va siempre al final.
  if (!isRead && !SELF_SCOPED_MUTATIONS.has(`${method} ${url}`) && !url.startsWith("/dev/")) {
    throw new AppError(403, "forbidden", "Ruta sin política de acceso", { route: `${method} ${url}` });
  }
}

export function assertNotForbiddenRole(a: AuthContext, target: { role: string }) {
  if (target.role === "owner" && a.access?.role !== "owner") throw forbidden("Solo un propietario puede asignar o quitar el rol de propietario");
}
