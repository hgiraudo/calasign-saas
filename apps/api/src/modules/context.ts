import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import type { Db } from "../infra/db";
import type { BlobStore } from "../infra/storage";
import type { Actor } from "../infra/evidence";
import { bearerToken, sha256Hex } from "../lib/util";
import { AUTHENTICATES, forgetCredential, rememberAuthenticatedCredential } from "../lib/ip";
import { AppError, unauthorized } from "../lib/errors";
import { assertExpectedSession } from "../lib/expected-tenant";
import { enforceRoutePolicy, loadAccess, type AccessInfo } from "./access";
import { accessTokenTenant, enforceOAuthScope, isOAuthAccessToken, oauthAuthContext, restrictAccessToScopes } from "./oauth-tokens";
import { applySessionSsoPolicy } from "./identity/sso";
import { applyAgentActor } from "./mcp/agent-actor";

export interface Services {
  db: Db;
  blobs: BlobStore;
}

export interface AuthContext {
  tenantId: string;
  userId: string | null;
  apiKeyId: string | null;
  actor: Actor;
  /** Rol, permisos y grupos (RBAC). Lo completa authenticate(). */
  access?: AccessInfo;
  /** Presente si la petición vino con un access token OAuth: app y scopes concedidos. */
  oauth?: { clientId: string; clientPublicId: string; scopes: string[]; ssoSession?: boolean };
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Cookie de la sesión web. Con HTTPS (cookieSecure: dev y producción) lleva el prefijo __Host-: el navegador solo la
 * acepta con Secure, Path=/ y sin Domain, así que un subdominio (p. ej. un dominio propio mal configurado o un
 * servicio en *.calasign…) no puede plantar ni pisar la sesión. En local sin HTTPS queda "cs_session".
 */
export const SESSION_COOKIE = config.cookieSecure ? "__Host-cs_session" : "cs_session";
// Con HTTPS, la de nombre viejo (cs_session, sin __Host-) ya no abre sesión: un subdominio la puede plantar. Se leyó
// durante la transición, del deploy del 2026-10-20 hasta el 5-Nov-2026, pasada la vida máxima de una sesión (SESSION_DAYS).

/** Token de la sesión web del pedido. */
export function sessionCookieToken(req: FastifyRequest): string | undefined {
  return req.cookies?.[SESSION_COOKIE] || undefined;
}

/**
 * Deja la cookie de sesión. `maxAgeSeconds` null: cookie de sesión del navegador (se borra al cerrarlo), para los
 * ingresos sin "recordarme".
 */
export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number | null) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    ...(maxAgeSeconds == null ? {} : { maxAge: maxAgeSeconds }),
  });
}

/** Borra la cookie de sesión. */
export function clearSessionCookie(reply: FastifyReply) {
  // Secure también al borrar: el navegador rechaza un Set-Cookie __Host- sin Secure (y la cookie no se borraría).
  reply.clearCookie(SESSION_COOKIE, { path: "/", secure: config.cookieSecure });
}

/** Vida máxima de una sesión web con "recordarme" (y de la cookie persistente). */
export const SESSION_DAYS = 14;
/** Cada cuánto se actualiza sessions.last_seen_at como mucho. */
export const SESSION_TOUCH_MINUTES = 5;

/**
 * Condición SQL de una sesión vigente (alias de la tabla sessions): sin vencer y, sin "recordarme", con actividad en
 * las últimas config.sessionIdleHours horas (número de la configuración, no un dato del pedido).
 */
export function sessionAliveSql(alias: string): string {
  return `${alias}.expires_at > now() AND (${alias}.remember OR ${alias}.last_seen_at > now() - interval '${config.sessionIdleHours} hours')`;
}

export function clientInfo(req: FastifyRequest) {
  return { ip: req.ip ?? null, userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null };
}

/**
 * Verificación liviana (solo lectura, por índice único) de una credencial Bearer para el límite de pedidos
 * (lib/ip.ts rateLimitIdentity): la organización de la API key o del access token OAuth vigente, o null. No reemplaza
 * a authenticate() (membresía, política SSO, scopes): solo decide en qué cupo cuenta el pedido.
 */
export async function bearerCredentialTenant(db: Db, token: string): Promise<string | null> {
  if (isOAuthAccessToken(token)) return accessTokenTenant(db, token);
  const row = await db.one<{ tenant_id: string }>(`SELECT tenant_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [sha256Hex(token)]);
  return row?.tenant_id ?? null;
}

/** Resuelve sesión (cookie), API key o access token OAuth (Bearer). */
export function authenticate(s: Services) {
  const inner = async (req: FastifyRequest, _reply: FastifyReply) => {
    const { ip, userAgent } = clientInfo(req);
    // El esquema sin distinguir mayúsculas ("bearer …" también es Bearer, RFC 7235).
    const key = bearerToken(req.headers.authorization);
    if (key) {
      if (isOAuthAccessToken(key)) {
        try {
          req.auth = await oauthAuthContext(s.db, key, ip, userAgent);
        } catch (e) {
          // Solo un rechazo de la credencial (401/403: token vencido, revocado, membresía quitada) la deja en la caché
          // negativa del límite. Un error del momento (base caída, timeout) no: si no, una credencial válida contaba
          // 60 s en el cupo de la IP.
          if (e instanceof AppError && (e.status === 401 || e.status === 403)) forgetCredential(key);
          throw e;
        }
        // Credencial válida: cuenta en su propio cupo del límite (lib/ip.ts rateLimitIdentity) sin volver a consultarla.
        rememberAuthenticatedCredential(key, req.auth.tenantId);
        enforceOAuthScope(req, req.auth);
        req.auth.access = await loadAccess(s.db, req.auth);
        // Como la sesión web SSO: el segundo factor lo maneja el proveedor de identidad (si no, quien autorizó una app
        // desde SSO en una organización con 2FA obligatorio quedaba con un token inservible y sin forma de activar 2FA).
        if (req.auth.oauth?.ssoSession && req.auth.access) req.auth.access.twoFactorSetupRequired = false;
        restrictAccessToScopes(req.auth);
        await enforceRoutePolicy(s.db, req, req.auth);
        return;
      }
      const row = await s.db.one<any>(`SELECT id, tenant_id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [sha256Hex(key)]);
      if (!row) {
        forgetCredential(key);
        throw unauthorized();
      }
      rememberAuthenticatedCredential(key, row.tenant_id);
      s.db.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.id]).catch(() => {});
      req.auth = {
        tenantId: row.tenant_id,
        userId: null,
        apiKeyId: row.id,
        actor: { type: "api_key", id: row.id, label: `API key: ${row.name}`, ip, userAgent },
      };
      req.auth.access = await loadAccess(s.db, req.auth);
      await enforceRoutePolicy(s.db, req, req.auth);
      return;
    }
    const token = sessionCookieToken(req);
    if (!token) throw unauthorized();
    const row = await s.db.one<any>(
      `SELECT s.user_id, s.tenant_id, s.auth_method, s.sso_tenant_id, s.last_seen_at < now() - interval '${SESSION_TOUCH_MINUTES} minutes' AS stale,
              u.name, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND ${sessionAliveSql("s")}`,
      [sha256Hex(token)],
    );
    if (!row) throw unauthorized();
    // Última actividad (cierre por inactividad): a lo sumo una escritura cada SESSION_TOUCH_MINUTES por sesión.
    if (row.stale) s.db.query(`UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, [sha256Hex(token)]).catch(() => {});
    // Pestaña que quedó en otra organización o cuenta (x-calasign-tenant / x-calasign-user): 409 tenant_mismatch.
    assertExpectedSession(req, { tenantId: row.tenant_id, userId: row.user_id });
    req.auth = {
      tenantId: row.tenant_id,
      userId: row.user_id,
      apiKeyId: null,
      actor: { type: "user", id: row.user_id, label: `${row.name} <${row.email}>`, ip, userAgent },
    };
    req.auth.access = await loadAccess(s.db, req.auth);
    await applySessionSsoPolicy(s.db, req.auth, row);
    await enforceRoutePolicy(s.db, req, req.auth);
  };
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    await inner(req, reply);
    // Pedidos que hace el servidor MCP en nombre de un agente de IA: la evidencia lo nombra.
    if (req.auth) applyAgentActor(req, req.auth);
  };
  // Las rutas que lo usan, con límite propio, cuentan en el cupo de la organización de la credencial (lib/ip.ts markBearerAuthRoutes).
  return Object.assign(handler, { [AUTHENTICATES]: true });
}
