// OAuth 2.0 (RFC 6749 + PKCE RFC 7636 + revocación RFC 7009 + introspección RFC 7662).
//   POST /oauth/token       client_credentials · authorization_code (PKCE S256 obligatorio) · refresh_token (con rotación)
//   POST /oauth/revoke      revoca un access o refresh token (el refresh revoca la familia entera)
//   POST /oauth/introspect  estado de un token emitido para la misma app
//   GET  /oauth/authorize   pantalla de consentimiento (página de la web, ver apps/web/src/pages/OAuthConsent.tsx)
//   /v1/oauth/authorize/*   lo que usa esa página (sesión web)
//   /v1/oauth/apps*         alta y administración de apps (permiso api_keys:manage)
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthorizeDecision,
  AuthorizeRequest,
  BUILTIN_ROLE_PERMISSIONS,
  CreateOAuthAppInput,
  OAUTH_SCOPES,
  UpdateOAuthAppInput,
  type AuthorizeInfo,
  type ConnectedApp,
  type OAuthApp,
  type OAuthScope,
  type Permission,
} from "@calasign/shared";
import type { Db } from "../infra/db";
import { AppError, badRequest, notFound } from "../lib/errors";
import { iso, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { hasPerm } from "./access";
import { auditFromRequest } from "./audit";
import { authenticate, type AuthContext, type Services } from "./context";
import { CODE_PREFIX, CODE_TTL_SEC, REFRESH_PREFIX, issueTokens, requireUserSession } from "./oauth-tokens";

// ───────────────────────────── Utilidades ─────────────────────────────

class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description: string,
  ) {
    super(description);
  }
}

function sendOAuthError(reply: FastifyReply, e: OAuthError) {
  reply.header("cache-control", "no-store").header("pragma", "no-cache");
  if (e.error === "invalid_client") reply.header("www-authenticate", 'Basic realm="calasign"');
  return reply.code(e.status).send({ error: e.error, error_description: e.description });
}

function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function pkceS256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function parseScopes(raw: string | undefined | null): string[] {
  return [...new Set((raw ?? "").split(/\s+/).filter(Boolean))];
}

/** Autenticación del cliente: HTTP Basic (RFC 6749 §2.3.1) o client_id/client_secret en el cuerpo. */
async function authenticateClient(db: Db, req: FastifyRequest, body: Record<string, string>, opts: { allowPublic: boolean }) {
  let clientId = body.client_id;
  let secret = body.client_secret;
  const h = req.headers.authorization;
  if (h?.startsWith("Basic ")) {
    const raw = Buffer.from(h.slice(6), "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i < 0) throw new OAuthError(401, "invalid_client", "Credenciales del cliente mal formadas");
    try {
      clientId = decodeURIComponent(raw.slice(0, i).replace(/\+/g, " "));
      secret = decodeURIComponent(raw.slice(i + 1).replace(/\+/g, " "));
    } catch {
      throw new OAuthError(401, "invalid_client", "Credenciales del cliente mal formadas");
    }
  }
  if (!clientId) throw new OAuthError(401, "invalid_client", "Falta client_id");
  const c = await db.one<any>(`SELECT * FROM oauth_clients WHERE client_id = $1 AND revoked_at IS NULL`, [clientId]);
  if (!c) throw new OAuthError(401, "invalid_client", "Cliente desconocido");
  if (c.secret_hash) {
    if (!secret || !safeEqualHex(sha256Hex(secret), c.secret_hash)) throw new OAuthError(401, "invalid_client", "Secreto inválido");
  } else if (!opts.allowPublic) {
    throw new OAuthError(401, "invalid_client", "Este endpoint requiere un cliente confidencial");
  }
  return c;
}

async function revokeFamily(db: Db, familyId: string) {
  await db.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
}

// ───────────────────────────── Mapeo ─────────────────────────────

async function toApp(db: Db, r: any): Promise<OAuthApp> {
  let role: string | null = null;
  let roleId: string | null = null;
  if (r.service_api_key_id) {
    const k = await db.one<any>(`SELECT role, role_id FROM api_keys WHERE id = $1`, [r.service_api_key_id]);
    role = k?.role ?? null;
    roleId = k?.role_id ?? null;
  }
  const n = await db.one<any>(
    `SELECT count(*)::int AS n FROM oauth_tokens WHERE client_id = $1 AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()`,
    [r.id],
  );
  return {
    id: r.id,
    clientId: r.client_id,
    name: r.name,
    description: r.description,
    confidential: Boolean(r.secret_hash),
    secretPrefix: r.secret_prefix,
    grantTypes: r.grant_types,
    redirectUris: r.redirect_uris,
    scopes: r.scopes,
    role,
    roleId,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    revokedAt: iso(r.revoked_at),
    activeTokens: n?.n ?? 0,
  };
}

/** Quien crea la identidad de servicio tiene que tener todos los permisos de su rol (igual que con API keys). */
async function assertCanGrantRole(db: Db, a: AuthContext, role: string, roleId: string | null) {
  let perms: readonly Permission[];
  if (role === "custom") {
    const r = await db.one<any>(`SELECT permissions FROM roles WHERE id = $1 AND tenant_id = $2`, [roleId, a.tenantId]);
    if (!r) throw badRequest("invalid_role", "Rol inexistente");
    perms = r.permissions;
  } else if (role === "admin" || role === "member") {
    perms = BUILTIN_ROLE_PERMISSIONS[role];
  } else {
    throw badRequest("invalid_role", "Rol inválido");
  }
  if (a.access?.role === "owner") return;
  const missing = perms.filter((p) => !hasPerm(a, p));
  if (missing.length) throw new AppError(403, "forbidden", `No podés crear una app con permisos que no tenés: ${missing.join(", ")}`, { missing });
}

// ───────────────────────────── Autorización (consentimiento) ─────────────────────────────

interface ValidatedAuthorize {
  client: any;
  scopes: OAuthScope[];
  redirectUri: string;
  req: ReturnType<typeof AuthorizeRequest.parse>;
}

async function validateAuthorize(db: Db, raw: unknown): Promise<ValidatedAuthorize> {
  const parsed = AuthorizeRequest.safeParse(raw);
  if (!parsed.success) throw badRequest("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const q = parsed.data;
  const client = await db.one<any>(`SELECT * FROM oauth_clients WHERE client_id = $1 AND revoked_at IS NULL`, [q.client_id]);
  if (!client) throw badRequest("invalid_client", "Aplicación desconocida");
  if (!client.grant_types.includes("authorization_code")) throw badRequest("unauthorized_client", "La aplicación no admite autorización de usuarios");
  // La URI de redirección tiene que coincidir exactamente con una registrada (sin comodines).
  if (!client.redirect_uris.includes(q.redirect_uri)) throw badRequest("invalid_redirect_uri", "URI de redirección no registrada para esta aplicación");
  // Apps registradas antes de que el alta rechazara estos esquemas: la pantalla de consentimiento navegaría a la URI
  // (también al rechazar) y `javascript:` ejecutaría código en el origen de CalaSign.
  if (!isSafeRedirectUri(q.redirect_uri)) throw badRequest("invalid_redirect_uri", "Esquema de URI de redirección no permitido");
  const requested = parseScopes(q.scope);
  const scopes = (requested.length ? requested : client.scopes) as OAuthScope[];
  const unknown = scopes.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s) || !client.scopes.includes(s));
  if (unknown.length) throw badRequest("invalid_scope", `Scopes no permitidos para esta aplicación: ${unknown.join(", ")}`);
  return { client, scopes, redirectUri: q.redirect_uri, req: q };
}

/** Esquemas que no son un destino de redirección (ejecutan código o leen archivos locales). Igual que en el alta. */
const FORBIDDEN_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "filesystem:"]);

function isSafeRedirectUri(uri: string) {
  try {
    return !FORBIDDEN_REDIRECT_SCHEMES.has(new URL(uri).protocol.toLowerCase());
  } catch {
    return false;
  }
}

function withParams(uri: string, params: Record<string, string | undefined>) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function oauthRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  // Endpoints del protocolo: aceptan application/x-www-form-urlencoded (lo normal en OAuth) y JSON.
  await app.register(async (o) => {
    o.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    const rl = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
    const bodyOf = (req: FastifyRequest) => Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));

    o.post("/oauth/token", rl, async (req, reply) => {
      const body = bodyOf(req);
      try {
        const grant = body.grant_type;
        if (grant === "client_credentials") {
          const c = await authenticateClient(s.db, req, body, { allowPublic: false });
          if (!c.grant_types.includes("client_credentials") || !c.service_api_key_id)
            throw new OAuthError(400, "unauthorized_client", "La aplicación no admite client_credentials");
          const requested = parseScopes(body.scope).filter((x) => x !== "offline_access");
          const allowed = (c.scopes as string[]).filter((x) => x !== "offline_access");
          const scopes = requested.length ? requested : allowed;
          const bad = scopes.filter((x) => !allowed.includes(x));
          if (bad.length) throw new OAuthError(400, "invalid_scope", `Scopes no permitidos: ${bad.join(", ")}`);
          const tok = await issueTokens(s.db, { clientId: c.id, tenantId: c.tenant_id, userId: null, serviceApiKeyId: c.service_api_key_id, scopes, withRefresh: false });
          return reply.header("cache-control", "no-store").send(tok);
        }

        if (grant === "authorization_code") {
          const c = await authenticateClient(s.db, req, body, { allowPublic: true });
          if (!body.code || !body.redirect_uri || !body.code_verifier) throw new OAuthError(400, "invalid_request", "Faltan code, redirect_uri o code_verifier");
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) throw new OAuthError(400, "invalid_request", "code_verifier inválido");
          const codeHash = sha256Hex(body.code);
          const result = await s.db.tx(async (t) => {
            const code = await t.one<any>(`SELECT * FROM oauth_authorization_codes WHERE code_hash = $1 FOR UPDATE`, [codeHash]);
            if (!code || code.client_id !== c.id) throw new OAuthError(400, "invalid_grant", "Código inválido");
            if (code.used_at) {
              // Reutilización de un código: se revocan los tokens emitidos con él (RFC 6749 §4.1.2).
              // Se devuelve una marca (no se lanza) para que la revocación quede confirmada.
              await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE code_hash = $1 AND revoked_at IS NULL`, [codeHash]);
              return "reused" as const;
            }
            if (new Date(code.expires_at) <= new Date()) throw new OAuthError(400, "invalid_grant", "El código venció");
            if (code.redirect_uri !== body.redirect_uri) throw new OAuthError(400, "invalid_grant", "redirect_uri no coincide");
            if (pkceS256(body.code_verifier) !== code.code_challenge) throw new OAuthError(400, "invalid_grant", "code_verifier no coincide (PKCE)");
            await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE code_hash = $1`, [codeHash]);
            const member = await t.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [code.tenant_id, code.user_id]);
            if (!member) throw new OAuthError(400, "invalid_grant", "El usuario ya no pertenece a la organización");
            return issueTokens(t, {
              clientId: c.id,
              tenantId: code.tenant_id,
              userId: code.user_id,
              serviceApiKeyId: null,
              scopes: code.scopes,
              codeHash,
              withRefresh: code.scopes.includes("offline_access"),
            });
          });
          if (result === "reused") throw new OAuthError(400, "invalid_grant", "El código ya fue usado: se revocaron los tokens emitidos con él");
          return reply.header("cache-control", "no-store").send(result);
        }

        if (grant === "refresh_token") {
          const c = await authenticateClient(s.db, req, body, { allowPublic: true });
          if (!body.refresh_token?.startsWith(REFRESH_PREFIX)) throw new OAuthError(400, "invalid_grant", "refresh_token inválido");
          const result = await s.db.tx(async (t) => {
            const old = await t.one<any>(`SELECT * FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' FOR UPDATE`, [sha256Hex(body.refresh_token)]);
            if (!old || old.client_id !== c.id) throw new OAuthError(400, "invalid_grant", "refresh_token inválido");
            if (old.revoked_at) throw new OAuthError(400, "invalid_grant", "refresh_token revocado");
            if (old.used_at) {
              // Rotación: un refresh token ya canjeado que vuelve a aparecer indica robo → se revoca toda la familia.
              await revokeFamily(t, old.family_id);
              return "reused" as const;
            }
            if (new Date(old.expires_at) <= new Date()) throw new OAuthError(400, "invalid_grant", "refresh_token vencido");
            const requested = parseScopes(body.scope);
            const scopes = requested.length ? requested : old.scopes;
            if (scopes.some((x: string) => !old.scopes.includes(x))) throw new OAuthError(400, "invalid_scope", "No se pueden ampliar los scopes");
            if (old.user_id) {
              const member = await t.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [old.tenant_id, old.user_id]);
              if (!member) throw new OAuthError(400, "invalid_grant", "El usuario ya no pertenece a la organización");
            }
            await t.query(`UPDATE oauth_tokens SET used_at = now() WHERE id = $1`, [old.id]);
            // El access token anterior de la familia deja de valer al rotar.
            await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND kind = 'access' AND revoked_at IS NULL`, [old.family_id]);
            return issueTokens(t, {
              clientId: c.id,
              tenantId: old.tenant_id,
              userId: old.user_id,
              serviceApiKeyId: old.service_api_key_id,
              scopes,
              familyId: old.family_id,
              codeHash: old.code_hash,
              withRefresh: scopes.includes("offline_access"),
            });
          });
          if (result === "reused") throw new OAuthError(400, "invalid_grant", "refresh_token reutilizado: se revocaron todos los tokens de esta autorización");
          return reply.header("cache-control", "no-store").send(result);
        }

        throw new OAuthError(400, "unsupported_grant_type", "grant_type no soportado");
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(reply, e);
        throw e;
      }
    });

    o.post("/oauth/revoke", rl, async (req, reply) => {
      const body = bodyOf(req);
      try {
        const c = await authenticateClient(s.db, req, body, { allowPublic: true });
        if (!body.token) throw new OAuthError(400, "invalid_request", "Falta token");
        const t = await s.db.one<any>(`SELECT id, kind, family_id, client_id FROM oauth_tokens WHERE token_hash = $1`, [sha256Hex(body.token)]);
        // RFC 7009: un token desconocido o de otra app responde 200 igual (no se revela nada).
        if (t && t.client_id === c.id) {
          if (t.kind === "refresh") await revokeFamily(s.db, t.family_id);
          else await s.db.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [t.id]);
        }
        return reply.header("cache-control", "no-store").send({});
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(reply, e);
        throw e;
      }
    });

    o.post("/oauth/introspect", rl, async (req, reply) => {
      const body = bodyOf(req);
      try {
        const c = await authenticateClient(s.db, req, body, { allowPublic: false });
        if (!body.token) throw new OAuthError(400, "invalid_request", "Falta token");
        const t = await s.db.one<any>(
          `SELECT t.*, u.email FROM oauth_tokens t LEFT JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
          [sha256Hex(body.token)],
        );
        reply.header("cache-control", "no-store");
        const active = t && t.client_id === c.id && !t.revoked_at && !(t.kind === "refresh" && t.used_at) && new Date(t.expires_at) > new Date();
        if (!active) return { active: false };
        return {
          active: true,
          scope: t.scopes.join(" "),
          client_id: c.client_id,
          token_type: t.kind === "access" ? "Bearer" : "refresh_token",
          sub: t.user_id ?? `app:${c.client_id}`,
          username: t.email ?? undefined,
          tenant_id: t.tenant_id,
          iat: Math.floor(new Date(t.created_at).getTime() / 1000),
          exp: Math.floor(new Date(t.expires_at).getTime() / 1000),
        };
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(reply, e);
        throw e;
      }
    });
  });

  // ───────── Consentimiento (lo usa la página /oauth/authorize de la web) ─────────

  app.get("/v1/oauth/authorize/info", { preHandler: auth }, async (req) => {
    const a = req.auth;
    requireUserSession(a);
    const v = await validateAuthorize(s.db, req.query);
    const [user, org, owner, consent] = await Promise.all([
      s.db.one<any>(`SELECT name, email FROM users WHERE id = $1`, [a.userId]),
      s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [a.tenantId]),
      s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [v.client.tenant_id]),
      s.db.one<any>(`SELECT scopes FROM oauth_consents WHERE client_id = $1 AND user_id = $2 AND tenant_id = $3`, [v.client.id, a.userId, a.tenantId]),
    ]);
    const granted = new Set<string>(consent?.scopes ?? []);
    const info: AuthorizeInfo = {
      client: { name: v.client.name, description: v.client.description, organizationName: owner?.name ?? "", clientId: v.client.client_id },
      scopes: v.scopes.map((sc) => ({ scope: sc, granted: granted.has(sc) })),
      user: { name: user.name, email: user.email },
      organization: { name: org?.name ?? "" },
      redirectUri: v.redirectUri,
      previouslyApproved: v.scopes.every((sc) => granted.has(sc)),
    };
    return info;
  });

  app.post("/v1/oauth/authorize/decision", { preHandler: auth }, async (req) => {
    const a = req.auth;
    requireUserSession(a);
    const body = AuthorizeDecision.parse(req.body);
    const v = await validateAuthorize(s.db, body);
    if (!body.approve) {
      return { redirectTo: withParams(v.redirectUri, { error: "access_denied", error_description: "El usuario no autorizó la aplicación", state: v.req.state }) };
    }
    const code = CODE_PREFIX + randomToken(32);
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO oauth_authorization_codes (code_hash, client_id, tenant_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'S256', now() + ($8 || ' seconds')::interval)`,
        [sha256Hex(code), v.client.id, a.tenantId, a.userId, v.redirectUri, v.scopes, v.req.code_challenge, String(CODE_TTL_SEC)],
      );
      await t.query(
        `INSERT INTO oauth_consents (client_id, user_id, tenant_id, scopes) VALUES ($1,$2,$3,$4)
         ON CONFLICT (client_id, user_id, tenant_id) DO UPDATE SET scopes = (SELECT array_agg(DISTINCT x) FROM unnest(oauth_consents.scopes || EXCLUDED.scopes) x), updated_at = now()`,
        [v.client.id, a.userId, a.tenantId, v.scopes],
      );
    });
    await auditFromRequest(s.db, req, a, "oauth.authorized", { targetType: "oauth_app", targetId: v.client.client_id, data: { app: v.client.name, scopes: v.scopes } });
    return { redirectTo: withParams(v.redirectUri, { code, state: v.req.state }) };
  });

  // Apps que el usuario autorizó (para revocarlas desde Seguridad / Apps conectadas).
  app.get("/v1/oauth/connected-apps", { preHandler: auth }, async (req) => {
    const a = req.auth;
    requireUserSession(a);
    const rows = await s.db.query<any>(
      `SELECT c.client_id, c.name, t.name AS org, oc.scopes, oc.updated_at
         FROM oauth_consents oc JOIN oauth_clients c ON c.id = oc.client_id JOIN tenants t ON t.id = c.tenant_id
        WHERE oc.user_id = $1 AND oc.tenant_id = $2 AND c.revoked_at IS NULL ORDER BY oc.updated_at DESC`,
      [a.userId, a.tenantId],
    );
    const items: ConnectedApp[] = rows.map((r) => ({ clientId: r.client_id, name: r.name, organizationName: r.org, scopes: r.scopes, authorizedAt: iso(r.updated_at)! }));
    return { items };
  });

  app.delete<{ Params: { clientId: string } }>("/v1/oauth/connected-apps/:clientId", { preHandler: auth }, async (req, reply) => {
    const a = req.auth;
    requireUserSession(a);
    const c = await s.db.one<any>(`SELECT id, name FROM oauth_clients WHERE client_id = $1`, [req.params.clientId]);
    if (!c) throw notFound("Aplicación");
    await s.db.tx(async (t) => {
      await t.query(`DELETE FROM oauth_consents WHERE client_id = $1 AND user_id = $2 AND tenant_id = $3`, [c.id, a.userId, a.tenantId]);
      await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND user_id = $2 AND tenant_id = $3 AND revoked_at IS NULL`, [c.id, a.userId, a.tenantId]);
    });
    await auditFromRequest(s.db, req, a, "oauth.disconnected", { targetType: "oauth_app", targetId: req.params.clientId, data: { app: c.name } });
    return reply.code(204).send();
  });

  // ───────── Administración de apps (permiso api_keys:manage, ver access.ts) ─────────

  app.get("/v1/oauth/apps", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(`SELECT * FROM oauth_clients WHERE tenant_id = $1 ORDER BY created_at DESC`, [req.auth!.tenantId]);
    return { items: await Promise.all(rows.map((r) => toApp(s.db, r))) };
  });

  app.post("/v1/oauth/apps", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const input = CreateOAuthAppInput.parse(req.body);
    const usesCc = input.grantTypes.includes("client_credentials");
    const role = input.role ?? "member";
    if (usesCc) await assertCanGrantRole(s.db, a, role, input.roleId ?? null);
    const id = uuidv7();
    const clientId = `csapp_${randomToken(12)}`;
    const secret = input.confidential === false ? null : `cssec_${randomToken(32)}`;
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO oauth_clients (id, tenant_id, client_id, secret_hash, secret_prefix, name, description, redirect_uris, grant_types, scopes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, a.tenantId, clientId, secret ? sha256Hex(secret) : null, secret ? secret.slice(0, 12) : null, input.name, input.description ?? null, input.redirectUris ?? [], input.grantTypes, input.scopes, a.userId],
      );
      if (usesCc) {
        // Identidad de servicio: una API key interna sin secreto utilizable; da el rol y la propiedad de los sobres.
        const keyId = uuidv7();
        await t.query(
          `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by, role, role_id, oauth_client_id)
           VALUES ($1,$2,$3,'oauth',$4,$5,$6,$7,$8)`,
          [keyId, a.tenantId, `App OAuth: ${input.name}`, sha256Hex(`unusable:${randomToken(32)}`), a.userId, role, input.roleId ?? null, id],
        );
        await t.query(`UPDATE oauth_clients SET service_api_key_id = $2 WHERE id = $1`, [id, keyId]);
      }
    });
    await auditFromRequest(s.db, req, a, "oauth_app.created", { targetType: "oauth_app", targetId: clientId, data: { name: input.name, grantTypes: input.grantTypes, scopes: input.scopes } });
    const row = await s.db.one<any>(`SELECT * FROM oauth_clients WHERE id = $1`, [id]);
    reply.code(201);
    return { app: await toApp(s.db, row), clientSecret: secret };
  });

  const loadOwn = async (a: AuthContext, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Aplicación");
    const r = await s.db.one<any>(`SELECT * FROM oauth_clients WHERE id = $1 AND tenant_id = $2`, [id, a.tenantId]);
    if (!r) throw notFound("Aplicación");
    return r;
  };

  app.get<{ Params: { id: string } }>("/v1/oauth/apps/:id", { preHandler: auth }, async (req) => toApp(s.db, await loadOwn(req.auth!, req.params.id)));

  app.patch<{ Params: { id: string } }>("/v1/oauth/apps/:id", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const r = await loadOwn(a, req.params.id);
    if (r.revoked_at) throw new AppError(409, "revoked", "La aplicación está revocada");
    const input = UpdateOAuthAppInput.parse(req.body);
    if (input.redirectUris && r.grant_types.includes("authorization_code") && input.redirectUris.length === 0)
      throw badRequest("invalid_request", "authorization_code requiere al menos una URI de redirección");
    await s.db.query(
      `UPDATE oauth_clients SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         redirect_uris = COALESCE($5, redirect_uris), scopes = COALESCE($6, scopes), updated_at = now() WHERE id = $1`,
      [r.id, input.name ?? null, input.description !== undefined, input.description ?? null, input.redirectUris ?? null, input.scopes ?? null],
    );
    if (input.scopes) {
      // Si se quitan scopes, los tokens vigentes con scopes que ya no corresponden se revocan.
      await s.db.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL AND NOT (scopes <@ $2::text[])`, [r.id, input.scopes]);
    }
    await auditFromRequest(s.db, req, a, "oauth_app.updated", { targetType: "oauth_app", targetId: r.client_id, data: { fields: Object.keys(input) } });
    return toApp(s.db, await s.db.one<any>(`SELECT * FROM oauth_clients WHERE id = $1`, [r.id]));
  });

  app.post<{ Params: { id: string } }>("/v1/oauth/apps/:id/rotate-secret", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const r = await loadOwn(a, req.params.id);
    if (r.revoked_at) throw new AppError(409, "revoked", "La aplicación está revocada");
    if (!r.secret_hash) throw badRequest("public_client", "Un cliente público no tiene secreto");
    const secret = `cssec_${randomToken(32)}`;
    await s.db.query(`UPDATE oauth_clients SET secret_hash = $2, secret_prefix = $3, updated_at = now() WHERE id = $1`, [r.id, sha256Hex(secret), secret.slice(0, 12)]);
    await auditFromRequest(s.db, req, a, "oauth_app.secret_rotated", { targetType: "oauth_app", targetId: r.client_id });
    return { app: await toApp(s.db, await s.db.one<any>(`SELECT * FROM oauth_clients WHERE id = $1`, [r.id])), clientSecret: secret };
  });

  app.delete<{ Params: { id: string } }>("/v1/oauth/apps/:id", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const r = await loadOwn(a, req.params.id);
    await s.db.tx(async (t) => {
      await t.query(`UPDATE oauth_clients SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE id = $1`, [r.id]);
      await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL`, [r.id]);
      if (r.service_api_key_id) await t.query(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`, [r.service_api_key_id]);
    });
    await auditFromRequest(s.db, req, a, "oauth_app.revoked", { targetType: "oauth_app", targetId: r.client_id, data: { name: r.name } });
    return reply.code(204).send();
  });
}
