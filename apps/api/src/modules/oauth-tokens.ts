// OAuth 2.0 — tokens opacos (solo el hash en la base) y control por scope.
// Lo usa authenticate() (context.ts) para aceptar `Authorization: Bearer csat_…` además de las API keys.
import type { FastifyRequest } from "fastify";
import { OAUTH_SCOPE_PERMISSIONS, type OAuthScope, type Permission } from "@calasign/shared";
import type { Db } from "../infra/db";
import { AppError, unauthorized } from "../lib/errors";
import { randomToken, sha256Hex, uuidv7 } from "../lib/util";
import type { AuthContext } from "./context";

export const ACCESS_PREFIX = "csat_";
export const REFRESH_PREFIX = "csrt_";
export const CODE_PREFIX = "csac_";
export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_SEC = 30 * 24 * 3600;
export const CODE_TTL_SEC = 600;

export function isOAuthAccessToken(token: string) {
  return token.startsWith(ACCESS_PREFIX);
}

/** Emite un access token (y opcionalmente un refresh token de la misma familia). */
export async function issueTokens(
  db: Db,
  t: {
    clientId: string;
    tenantId: string;
    userId: string | null;
    serviceApiKeyId: string | null;
    scopes: string[];
    familyId?: string;
    codeHash?: string | null;
    withRefresh: boolean;
  },
) {
  const familyId = t.familyId ?? uuidv7();
  const access = ACCESS_PREFIX + randomToken(32);
  await db.query(
    `INSERT INTO oauth_tokens (id, token_hash, kind, client_id, tenant_id, user_id, service_api_key_id, scopes, family_id, code_hash, expires_at)
     VALUES ($1,$2,'access',$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)`,
    [uuidv7(), sha256Hex(access), t.clientId, t.tenantId, t.userId, t.serviceApiKeyId, t.scopes, familyId, t.codeHash ?? null, String(ACCESS_TTL_SEC)],
  );
  let refresh: string | null = null;
  if (t.withRefresh) {
    refresh = REFRESH_PREFIX + randomToken(32);
    await db.query(
      `INSERT INTO oauth_tokens (id, token_hash, kind, client_id, tenant_id, user_id, service_api_key_id, scopes, family_id, code_hash, expires_at)
       VALUES ($1,$2,'refresh',$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)`,
      [uuidv7(), sha256Hex(refresh), t.clientId, t.tenantId, t.userId, t.serviceApiKeyId, t.scopes, familyId, t.codeHash ?? null, String(REFRESH_TTL_SEC)],
    );
  }
  return {
    access_token: access,
    token_type: "Bearer" as const,
    expires_in: ACCESS_TTL_SEC,
    ...(refresh ? { refresh_token: refresh } : {}),
    scope: t.scopes.join(" "),
  };
}

export interface ResolvedOAuthToken {
  tokenId: string;
  clientId: string;
  clientPublicId: string;
  clientName: string;
  tenantId: string;
  userId: string | null;
  userLabel: string | null;
  serviceApiKeyId: string | null;
  scopes: OAuthScope[];
}

/** Resuelve un access token vigente; null si no existe, venció o fue revocado. */
export async function resolveAccessToken(db: Db, token: string): Promise<ResolvedOAuthToken | null> {
  const r = await db.one<any>(
    `SELECT t.id, t.client_id, t.tenant_id, t.user_id, t.service_api_key_id, t.scopes, c.client_id AS public_id, c.name AS client_name,
            u.name AS user_name, u.email AS user_email
       FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
       LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN api_keys k ON k.id = t.service_api_key_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND c.revoked_at IS NULL
        AND (t.service_api_key_id IS NULL OR k.revoked_at IS NULL)`,
    [sha256Hex(token)],
  );
  if (!r) return null;
  db.query(`UPDATE oauth_tokens SET last_used_at = now() WHERE id = $1`, [r.id]).catch(() => {});
  return {
    tokenId: r.id,
    clientId: r.client_id,
    clientPublicId: r.public_id,
    clientName: r.client_name,
    tenantId: r.tenant_id,
    userId: r.user_id,
    userLabel: r.user_id ? `${r.user_name} <${r.user_email}>` : null,
    serviceApiKeyId: r.service_api_key_id,
    scopes: r.scopes,
  };
}

/** Contexto de autenticación para un access token OAuth (sin acceso cargado todavía). */
export async function oauthAuthContext(db: Db, token: string, ip: string | null, userAgent: string | null): Promise<AuthContext> {
  const o = await resolveAccessToken(db, token);
  if (!o) throw unauthorized();
  const oauth = { clientId: o.clientId, clientPublicId: o.clientPublicId, scopes: o.scopes };
  if (o.userId) {
    return {
      tenantId: o.tenantId,
      userId: o.userId,
      apiKeyId: null,
      actor: { type: "user", id: o.userId, label: `${o.userLabel} vía ${o.clientName}`, ip, userAgent },
      oauth,
    };
  }
  return {
    tenantId: o.tenantId,
    userId: null,
    apiKeyId: o.serviceApiKeyId,
    actor: { type: "api_key", id: o.serviceApiKeyId, label: `App OAuth: ${o.clientName}`, ip, userAgent },
    oauth,
  };
}

/** Permisos RBAC alcanzables con un conjunto de scopes. */
export function permissionsForScopes(scopes: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) for (const p of OAUTH_SCOPE_PERMISSIONS[s as OAuthScope] ?? []) out.add(p as Permission);
  return out;
}

/** Recorta los permisos del rol a lo que permiten los scopes del token. */
export function restrictAccessToScopes(a: AuthContext) {
  if (!a.oauth || !a.access) return;
  const allowed = permissionsForScopes(a.oauth.scopes);
  a.access = { ...a.access, permissions: new Set([...a.access.permissions].filter((p) => allowed.has(p))) };
}

/**
 * Scope que exige una ruta para un token OAuth. `null`: cualquier token. `"deny"`: nunca con OAuth
 * (API keys, apps OAuth, 2FA, autenticación, etc. solo con la sesión o una API key).
 */
export function requiredScope(url: string, method: string): OAuthScope | null | "deny" {
  const write = !(method === "GET" || method === "HEAD");
  if (url === "/v1/me" || url === "/v1/me/access") return write ? "deny" : null;
  if (url === "/v1/templates/from-envelope/:envelopeId") return "templates:write";
  if (url.startsWith("/v1/envelopes") || /^\/v1\/(bulk-sends|web-forms|reports)(\/|$)/.test(url)) return write ? "envelopes:write" : "envelopes:read";
  if (url.startsWith("/v1/templates")) return write ? "templates:write" : "templates:read";
  if (/^\/v1\/(webhooks|webhook-deliveries)(\/|$)/.test(url)) return "webhooks:manage";
  if (/^\/v1\/(settings|notification-integrations|storage|domains)(\/|$)/.test(url)) return write ? "settings:write" : "settings:read";
  if (/^\/v1\/(members|roles|groups|invitations)(\/|$)/.test(url)) return write ? "members:write" : "members:read";
  if (url.startsWith("/v1/audit-log")) return "audit:read";
  return "deny";
}

export function enforceOAuthScope(req: FastifyRequest, a: AuthContext) {
  if (!a.oauth) return;
  const url = req.routeOptions?.url ?? req.url.split("?")[0];
  const need = requiredScope(url, req.method);
  if (need === null) return;
  if (need === "deny") throw new AppError(403, "insufficient_scope", "Este endpoint no está disponible con tokens OAuth");
  if (!a.oauth.scopes.includes(need)) {
    throw new AppError(403, "insufficient_scope", `El token no tiene el scope ${need}`, { requiredScope: need });
  }
}

/** Solo una sesión web de usuario (no API key ni token OAuth). */
export function requireUserSession(a: AuthContext | undefined): asserts a is AuthContext & { userId: string } {
  if (!a || !a.userId || a.apiKeyId || a.oauth) throw new AppError(403, "session_required", "Esta operación requiere iniciar sesión en la web");
}
