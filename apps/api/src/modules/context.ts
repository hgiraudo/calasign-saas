import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import type { Db } from "../infra/db";
import type { BlobStore } from "../infra/storage";
import type { Actor } from "../infra/evidence";
import { bearerToken, sha256Hex } from "../lib/util";
import { AUTHENTICATES, forgetCredential, rememberAuthenticatedCredential } from "../lib/ip";
import { unauthorized } from "../lib/errors";
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
/**
 * Nombre anterior. Transición: se sigue leyendo si no está la nueva (las sesiones abiertas antes del cambio no se
 * cierran de golpe) hasta config.legacySessionCookieReadUntil, y cada login o logout la borra.
 * TODO(2026-11-10): quitar (pasada la vida máxima de una sesión, SESSION_DAYS, desde el deploy del 2026-10-20 que
 * introdujo __Host-cs_session) junto con legacySessionCookieDomains y legacySessionCookieReadUntil de config.ts.
 */
export const LEGACY_SESSION_COOKIE = "cs_session";
const SESSION_COOKIE_NAMES = SESSION_COOKIE === LEGACY_SESSION_COOKIE ? [SESSION_COOKIE] : [SESSION_COOKIE, LEGACY_SESSION_COOKIE];

/** Token de la sesión web del pedido (cookie nueva o, durante la transición, la vieja). */
export function sessionCookieToken(req: FastifyRequest): string | undefined {
  const v = req.cookies?.[SESSION_COOKIE];
  if (v) return v;
  // Pasada la transición, la vieja ya no abre sesión: sin el prefijo __Host-, un subdominio la puede plantar.
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE && Date.now() >= config.legacySessionCookieReadUntil) return undefined;
  return req.cookies?.[LEGACY_SESSION_COOKIE] || undefined;
}

/** Todos los nombres con los que puede llegar la sesión web (para quitarla de un pedido). */
export function sessionCookieNames(): readonly string[] {
  return SESSION_COOKIE_NAMES;
}

/** Deja la cookie de sesión (y borra la del nombre viejo si quedaba). */
export function setSessionCookie(reply: FastifyReply, token: string, maxAgeSeconds: number) {
  reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure: config.cookieSecure, maxAge: maxAgeSeconds });
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE) reply.clearCookie(LEGACY_SESSION_COOKIE, { path: "/", secure: config.cookieSecure });
}

/** Borra la cookie de sesión con cualquiera de sus nombres. */
export function clearSessionCookie(reply: FastifyReply) {
  // Secure también al borrar: el navegador rechaza un Set-Cookie __Host- sin Secure (y la cookie no se borraría).
  for (const n of SESSION_COOKIE_NAMES) reply.clearCookie(n, { path: "/", secure: config.cookieSecure });
  // La vieja también con Domain= del host y sus dominios padre: una cs_session plantada desde un subdominio con
  // Domain=<padre> no se borra con el Set-Cookie sin Domain (los atributos tienen que coincidir).
  if (SESSION_COOKIE !== LEGACY_SESSION_COOKIE)
    for (const domain of config.legacySessionCookieDomains) reply.clearCookie(LEGACY_SESSION_COOKIE, { path: "/", domain, secure: config.cookieSecure });
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
          forgetCredential(key);
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
      const row = await s.db.one<any>(
        `SELECT id, tenant_id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
        [sha256Hex(key)],
      );
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
      `SELECT s.user_id, s.tenant_id, s.auth_method, s.sso_tenant_id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256Hex(token)],
    );
    if (!row) throw unauthorized();
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
  // Las rutas que lo usan cuentan en el cupo de la credencial también con límite propio (lib/ip.ts markBearerAuthRoutes).
  return Object.assign(handler, { [AUTHENTICATES]: true });
}
