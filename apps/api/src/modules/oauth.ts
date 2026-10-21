// OAuth 2.0 (RFC 6749 + PKCE RFC 7636 + revocación RFC 7009 + introspección RFC 7662).
//   POST /oauth/token       client_credentials · authorization_code (PKCE S256 obligatorio) · refresh_token (con rotación)
//   POST /oauth/revoke      revoca un access o refresh token (el refresh revoca la familia entera)
//   POST /oauth/introspect  estado de un token emitido para la misma app
//   GET  /oauth/authorize   pantalla de consentimiento (página de la web, ver apps/web/src/pages/OAuthConsent.tsx)
//   /v1/oauth/authorize/*   lo que usa esa página (sesión web)
//   /v1/oauth/apps*         alta y administración de apps (permiso api_keys:manage)
//   POST /oauth/register    registro dinámico de clientes (RFC 7591) para conectores MCP (Claude, ChatGPT, Claude Code,
//                           Gemini CLI): la app no es de ninguna organización; la autoriza un usuario y los tokens quedan
//                           en la organización de ese usuario. Solo authorization_code + PKCE (+ refresh), nunca
//                           client_credentials (sería acceso a una organización sin ningún usuario detrás).
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthorizeDecision,
  AuthorizeRequest,
  BUILTIN_ROLE_PERMISSIONS,
  CreateOAuthAppInput,
  MCP_DEFAULT_SCOPES,
  OAUTH_SCOPES,
  PERMISSIONS,
  UpdateOAuthAppInput,
  type AuthorizeInfo,
  type ConnectedApp,
  type OAuthApp,
  type OAuthScope,
  type Permission,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { AppError, badRequest, notFound } from "../lib/errors";
import { iso, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { hasPerm } from "./access";
import { auditFromRequest } from "./audit";
import { authenticate, sessionCookieToken, type AuthContext, type Services } from "./context";
import { CODE_PREFIX, CODE_TTL_SEC, REFRESH_PREFIX, assertUserTokenAllowed, issueTokens, requireUserSession, ssoCodeDeadline, ssoFamilyDeadline } from "./oauth-tokens";
import { actingPerson } from "./member-access";

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
  // El esquema sin distinguir mayúsculas (RFC 7235 §2.1).
  const basic = h ? /^basic\s+(.*)$/is.exec(h) : null;
  if (basic) {
    const raw = Buffer.from(basic[1].trim(), "base64").toString("utf8");
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

/** La política de la organización (membresía actual, SSO obligatorio) aplicada a un token de usuario, como error OAuth. */
async function userGrantAllowed(db: Db, t: Parameters<typeof assertUserTokenAllowed>[1]) {
  try {
    await assertUserTokenAllowed(db, t);
  } catch (e) {
    if (e instanceof AppError) throw new OAuthError(400, "invalid_grant", e.message);
    throw e;
  }
}

/**
 * Refresh tokens: una app del registro dinámico solo si se registró con refresh_token en grant_types. El alta ya no le
 * habilita offline_access sin ese grant, pero las registradas antes lo tienen guardado y seguían recibiendo y canjeando
 * refresh tokens. Las apps de una organización no declaran refresh_token (su grant es authorization_code + offline_access).
 */
function refreshAllowed(c: { registration?: string | null; grant_types: string[] }) {
  return c.registration !== "dynamic" || c.grant_types.includes("refresh_token");
}

async function revokeFamily(db: Db, familyId: string) {
  await db.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`, [familyId]);
}

// ───────────────────────────── Mapeo ─────────────────────────────

async function toApp(db: Db, r: any, viewer?: AuthContext): Promise<OAuthApp> {
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
    ...(viewer
      ? { canTakeOver: await assertCanTakeOverApp(db, viewer, r, "").then(() => true, () => false) }
      : {}),
  };
}

/** Quien crea la identidad de servicio tiene que tener todos los permisos de su rol (igual que con API keys). */
async function assertCanGrantRole(db: Db, a: AuthContext, role: string, roleId: string | null, what = "crear una app") {
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
  if (missing.length) throw new AppError(403, "forbidden", `No podés ${what} con permisos que no tenés: ${missing.join(", ")}`, { missing });
}

/**
 * Una app con client_credentials actúa con el rol de su identidad de servicio. Rotar su secreto (la respuesta lo
 * entrega), cambiarle los scopes o revocarla lo hace solo quien tiene todos esos permisos, como al crearla y como con
 * las API keys (assertCanManageApiKey). Si no, alguien con api_keys:manage y menos permisos rotaba el secreto de una
 * app de administrador creada por un propietario y pedía tokens con ese rol.
 */
async function assertCanManageServiceApp(db: Db, a: AuthContext, app: { service_api_key_id?: string | null }, what: string) {
  if (!app.service_api_key_id) return;
  const k = await db.one<any>(`SELECT role, role_id, revoked_at FROM api_keys WHERE id = $1`, [app.service_api_key_id]);
  if (!k || k.revoked_at) return;
  await assertCanGrantRole(db, a, k.role, k.role_id, what);
}

/**
 * Cambiar las URI de redirección o rotar el secreto de una app ajena es quedarse con los códigos y tokens de quienes
 * ya confían en ella: solo quien la creó (persona o API key vigente), un propietario o quien tiene todos los permisos de
 * su creador. Si no, un rol con api_keys:manage apuntaba la app "oficial" de un propietario a su servidor y mandaba el
 * link de consentimiento.
 */
async function assertCanTakeOverApp(db: Db, a: AuthContext, app: { created_by?: string | null; created_by_api_key_id?: string | null }, what: string) {
  if (a.access?.role === "owner") return;
  if (app.created_by && app.created_by === a.userId) return;
  // La API key que la creó (directa, no la identidad de servicio de una app OAuth): si llegó acá está vigente.
  if (app.created_by_api_key_id && !a.oauth && a.apiKeyId === app.created_by_api_key_id) return;
  const m = app.created_by
    ? await db.one<any>(`SELECT role, role_id FROM memberships WHERE user_id = $1 AND tenant_id = $2`, [app.created_by, a.tenantId])
    : null;
  if (!m) {
    // Sin creador conocido (app anterior a created_by, creada por una API key) o con un creador que ya no es miembro: no
    // se sabe qué permisos tenía, así que hace falta un propietario o alguien con todos los permisos. Antes se permitía
    // y cualquiera con api_keys:manage se quedaba con la app de un administrador que se fue.
    const missing = PERMISSIONS.filter((p) => !hasPerm(a, p));
    if (missing.length) throw new AppError(403, "forbidden", `No podés ${what}: hace falta un propietario o todos los permisos`, { missing });
    return;
  }
  if (m.role === "owner") throw new AppError(403, "forbidden", `No podés ${what}: la creó un propietario`);
  await assertCanGrantRole(db, a, m.role, m.role_id, what);
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
  // La URI de redirección tiene que coincidir exactamente con una registrada (sin comodines; en loopback, cualquier puerto).
  if (!redirectUriAllowed(client.redirect_uris, q.redirect_uri)) throw badRequest("invalid_redirect_uri", "URI de redirección no registrada para esta aplicación");
  // Apps registradas antes de que el alta rechazara estos esquemas: la pantalla de consentimiento navegaría a la URI
  // (también al rechazar) y `javascript:` ejecutaría código en el origen de CalaSign.
  if (!isSafeRedirectUri(q.redirect_uri)) throw badRequest("invalid_redirect_uri", "Esquema de URI de redirección no permitido");
  if (q.resource !== undefined && !isValidResource(q.resource)) throw badRequest("invalid_target", `Recurso desconocido: usá ${config.appUrl}/mcp`);
  const requested = parseScopes(q.scope);
  let scopes: OAuthScope[];
  if (client.registration === "dynamic") {
    // Conectores MCP: piden lo que dicen los metadatos (a veces también openid/profile/email, o todos los scopes del
    // servidor). Se concede lo pedido que la app tiene habilitado (RFC 6749 §3.3 permite conceder menos; la respuesta
    // del token dice qué se concedió); si no queda nada, lo que usan las herramientas MCP.
    scopes = requested.filter((s) => client.scopes.includes(s) && (s !== "offline_access" || refreshAllowed(client))) as OAuthScope[];
    if (!scopes.length) scopes = MCP_DEFAULT_SCOPES.filter((s) => client.scopes.includes(s));
    // Registrada con refresh_token: sin offline_access el conector pediría autorizar de nuevo cada hora.
    if (client.grant_types.includes("refresh_token") && client.scopes.includes("offline_access") && !scopes.includes("offline_access")) scopes.push("offline_access");
    if (!scopes.length) throw badRequest("invalid_scope", "La aplicación no tiene scopes habilitados");
  } else {
    scopes = (requested.length ? requested : client.scopes) as OAuthScope[];
    const unknown = scopes.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s) || !client.scopes.includes(s));
    if (unknown.length) throw badRequest("invalid_scope", `Scopes no permitidos para esta aplicación: ${unknown.join(", ")}`);
  }
  return { client, scopes, redirectUri: q.redirect_uri, req: q };
}

/** RFC 8707: el único recurso protegido es la API/servidor MCP de esta instalación. */
export function isValidResource(resource: string) {
  const base = config.appUrl.replace(/\/$/, "");
  return [base, `${base}/`, `${base}/mcp`, `${base}/mcp/`].includes(resource);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function isLoopbackHttp(u: URL) {
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * La URI pedida coincide exactamente con una registrada. Excepción de RFC 8252 §7.3: para http en loopback
 * (127.0.0.1, [::1], localhost) el puerto puede ser cualquiera, porque las apps de escritorio y las CLI (Claude Code,
 * Gemini CLI) escuchan en un puerto libre que eligen en el momento. Host, ruta y query tienen que coincidir igual.
 */
export function redirectUriAllowed(registered: readonly string[], uri: string): boolean {
  if (registered.includes(uri)) return true;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(u) || u.username || u.password || u.hash) return false;
  return registered.some((r) => {
    try {
      const x = new URL(r);
      return isLoopbackHttp(x) && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
    } catch {
      return false;
    }
  });
}

// ───────────────────────────── Registro dinámico (RFC 7591) ─────────────────────────────

const DCR_GRANT_TYPES = ["authorization_code", "refresh_token"];
const DCR_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

class RegistrationError extends Error {
  constructor(
    readonly error: "invalid_redirect_uri" | "invalid_client_metadata",
    readonly description: string,
  ) {
    super(description);
  }
}

/** Solo https, o http en loopback (apps de escritorio y CLI). Sin esquemas propios, credenciales ni fragmento. */
function checkDcrRedirectUri(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) throw new RegistrationError("invalid_redirect_uri", "Cada redirect_uri tiene que ser una URL de hasta 500 caracteres");
  const uri = raw.trim();
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new RegistrationError("invalid_redirect_uri", `redirect_uri inválida: ${uri.slice(0, 100)}`);
  }
  if (uri.includes("#")) throw new RegistrationError("invalid_redirect_uri", "La redirect_uri no puede tener fragmento (#)");
  if (u.username || u.password) throw new RegistrationError("invalid_redirect_uri", "La redirect_uri no puede llevar credenciales");
  if (u.protocol !== "https:" && !isLoopbackHttp(u)) {
    throw new RegistrationError("invalid_redirect_uri", "La redirect_uri tiene que ser https, o http en loopback (127.0.0.1, [::1] o localhost)");
  }
  return uri;
}

function optionalHttpsUrl(raw: unknown, name: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 500) throw new RegistrationError("invalid_client_metadata", `${name} inválida`);
  try {
    if (new URL(raw).protocol === "https:") return raw;
  } catch {
    /* cae al error */
  }
  throw new RegistrationError("invalid_client_metadata", `${name} tiene que ser una URL https`);
}

interface DcrMetadata {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  authMethod: (typeof DCR_AUTH_METHODS)[number];
  scopes: OAuthScope[];
  clientUri: string | null;
  logoUri: string | null;
}

export function parseDcrMetadata(body: unknown): DcrMetadata {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RegistrationError("invalid_client_metadata", "El cuerpo tiene que ser un objeto JSON");
  const b = body as Record<string, unknown>;
  // Sin caracteres de control (el nombre se muestra en la pantalla de consentimiento y en Apps conectadas).
  const name = typeof b.client_name === "string" ? b.client_name.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!name) throw new RegistrationError("invalid_client_metadata", "Falta client_name");
  if (name.length > 100) throw new RegistrationError("invalid_client_metadata", "client_name admite hasta 100 caracteres");
  if (!Array.isArray(b.redirect_uris) || b.redirect_uris.length < 1 || b.redirect_uris.length > 10) {
    throw new RegistrationError("invalid_redirect_uri", "redirect_uris tiene que ser una lista de 1 a 10 URIs");
  }
  const redirectUris = [...new Set(b.redirect_uris.map(checkDcrRedirectUri))];
  const strList = (v: unknown, field: string, def: string[]) => {
    if (v === undefined || v === null) return def;
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) throw new RegistrationError("invalid_client_metadata", `${field} tiene que ser una lista de textos`);
    return [...new Set(v as string[])];
  };
  const grantTypes = strList(b.grant_types, "grant_types", DCR_GRANT_TYPES);
  const badGrant = grantTypes.filter((g) => !DCR_GRANT_TYPES.includes(g));
  if (badGrant.length) {
    throw new RegistrationError("invalid_client_metadata", `grant_types no admitidos en el registro dinámico: ${badGrant.join(", ")} (solo authorization_code y refresh_token)`);
  }
  if (!grantTypes.includes("authorization_code")) throw new RegistrationError("invalid_client_metadata", "grant_types tiene que incluir authorization_code");
  const responseTypes = strList(b.response_types, "response_types", ["code"]);
  if (responseTypes.some((r) => r !== "code")) throw new RegistrationError("invalid_client_metadata", 'response_types admite solo "code"');
  const authMethod = (b.token_endpoint_auth_method ?? "none") as DcrMetadata["authMethod"];
  if (!DCR_AUTH_METHODS.includes(authMethod)) {
    throw new RegistrationError("invalid_client_metadata", `token_endpoint_auth_method admite ${DCR_AUTH_METHODS.join(", ")}`);
  }
  let scopes: OAuthScope[] = [...OAUTH_SCOPES];
  if (b.scope !== undefined && b.scope !== null) {
    if (typeof b.scope !== "string" || b.scope.length > 1000) throw new RegistrationError("invalid_client_metadata", "scope inválido");
    const requested = parseScopes(b.scope);
    const unknown = requested.filter((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
    if (unknown.length) throw new RegistrationError("invalid_client_metadata", `Scopes desconocidos: ${unknown.join(", ").slice(0, 200)}`);
    // Vacío o solo espacios: como si no lo mandara (si no, la app quedaba sin ningún scope y no se podía autorizar).
    if (requested.length) scopes = requested as OAuthScope[];
  }
  // Sin refresh_token en grant_types no hay refresh tokens: offline_access no se le habilita.
  if (!grantTypes.includes("refresh_token")) scopes = scopes.filter((s) => s !== "offline_access");
  if (!scopes.length) throw new RegistrationError("invalid_client_metadata", "scope no deja ningún permiso");
  return {
    clientName: name,
    redirectUris,
    grantTypes,
    responseTypes,
    authMethod,
    scopes,
    clientUri: optionalHttpsUrl(b.client_uri, "client_uri"),
    logoUri: optionalHttpsUrl(b.logo_uri, "logo_uri"),
  };
}

/** Barrido: apps registradas dinámicamente que en 30 días nadie autorizó (ni tienen tokens) se borran. */
export async function purgeUnusedDynamicClients(db: Db): Promise<number> {
  const rows = await db.query<any>(
    `DELETE FROM oauth_clients c WHERE c.id IN (
       SELECT id FROM oauth_clients x WHERE x.registration = 'dynamic' AND x.created_at < now() - interval '30 days'
          AND NOT EXISTS (SELECT 1 FROM oauth_consents oc WHERE oc.client_id = x.id)
          AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = x.id)
        LIMIT 500)
     RETURNING c.id`,
  );
  return rows.length;
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

    // Registro dinámico (RFC 7591). Público por diseño (así se conectan Claude, ChatGPT y las CLI): la app registrada
    // no puede nada hasta que un usuario la autorice en la pantalla de consentimiento, que la marca "no verificada".
    o.post("/oauth/register", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      let m: DcrMetadata;
      try {
        m = parseDcrMetadata(req.body);
      } catch (e) {
        if (e instanceof RegistrationError) return reply.code(400).send({ error: e.error, error_description: e.description });
        throw e;
      }
      const id = uuidv7();
      const clientId = `csdyn_${randomToken(16)}`;
      const secret = m.authMethod === "none" ? null : `cssec_${randomToken(32)}`;
      const row = await s.db.one<any>(
        `INSERT INTO oauth_clients (id, tenant_id, client_id, secret_hash, secret_prefix, name, redirect_uris, grant_types, scopes,
                                    registration, client_uri, logo_uri, token_endpoint_auth_method)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'dynamic', $9, $10, $11) RETURNING created_at`,
        [id, clientId, secret ? sha256Hex(secret) : null, secret ? secret.slice(0, 12) : null, m.clientName, m.redirectUris, m.grantTypes, m.scopes, m.clientUri, m.logoUri, m.authMethod],
      );
      req.log.info({ clientId, name: m.clientName, redirectUris: m.redirectUris }, "app OAuth registrada dinámicamente");
      return reply.code(201).send({
        client_id: clientId,
        ...(secret ? { client_secret: secret } : {}),
        client_id_issued_at: Math.floor(new Date(row.created_at).getTime() / 1000),
        client_secret_expires_at: 0,
        client_name: m.clientName,
        redirect_uris: m.redirectUris,
        grant_types: m.grantTypes,
        response_types: m.responseTypes,
        token_endpoint_auth_method: m.authMethod,
        scope: m.scopes.join(" "),
        ...(m.clientUri ? { client_uri: m.clientUri } : {}),
        ...(m.logoUri ? { logo_uri: m.logoUri } : {}),
      });
    });

    o.post("/oauth/token", rl, async (req, reply) => {
      const body = bodyOf(req);
      try {
        const grant = body.grant_type;
        // RFC 8707: si el cliente dice para qué recurso quiere el token, tiene que ser este servidor.
        if (body.resource !== undefined && !isValidResource(body.resource)) {
          throw new OAuthError(400, "invalid_target", `Recurso desconocido: usá ${config.appUrl}/mcp`);
        }
        if (grant === "client_credentials") {
          const c = await authenticateClient(s.db, req, body, { allowPublic: false });
          // Una app registrada dinámicamente nunca: no es de ninguna organización (y el CHECK de la tabla lo asegura).
          if (c.registration === "dynamic" || !c.tenant_id || !c.grant_types.includes("client_credentials") || !c.service_api_key_id)
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
            // La app puede haber cambiado desde que se emitió el código (vale 10 minutos): si un administrador le quitó
            // scopes o una URI de redirección (p. ej. una comprometida), el PATCH revoca los tokens vigentes, pero un
            // código sin canjear seguía dando tokens con lo quitado.
            if (!redirectUriAllowed(c.redirect_uris as string[], code.redirect_uri)) {
              throw new OAuthError(400, "invalid_grant", "La URI de redirección del código ya no está registrada para la aplicación");
            }
            if ((code.scopes as string[]).some((x) => !(c.scopes as string[]).includes(x))) {
              throw new OAuthError(400, "invalid_grant", "La aplicación ya no tiene habilitados todos los scopes autorizados: hay que volver a autorizarla");
            }
            await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE code_hash = $1`, [codeHash]);
            await userGrantAllowed(t, { tenantId: code.tenant_id, userId: code.user_id, authMethod: code.auth_method, ssoTenantId: code.sso_tenant_id, issuedAt: new Date(code.created_at) });
            // Autorizado desde una sesión SSO: el tope de la familia arranca en esa sesión (no en el canje); si ya pasó,
            // no se emiten tokens que nacerían vencidos.
            const ssoDeadline = code.auth_method === "sso" ? await ssoCodeDeadline(t, code) : null;
            if (ssoDeadline && ssoDeadline <= new Date()) throw new OAuthError(400, "invalid_grant", "La sesión de inicio único venció: volvé a autorizar la aplicación");
            return issueTokens(t, {
              authMethod: code.auth_method,
              ssoTenantId: code.sso_tenant_id,
              ssoDeadline,
              clientId: c.id,
              tenantId: code.tenant_id,
              userId: code.user_id,
              serviceApiKeyId: null,
              scopes: code.scopes,
              codeHash,
              withRefresh: code.scopes.includes("offline_access") && refreshAllowed(c),
            });
          });
          if (result === "reused") throw new OAuthError(400, "invalid_grant", "El código ya fue usado: se revocaron los tokens emitidos con él");
          return reply.header("cache-control", "no-store").send(result);
        }

        if (grant === "refresh_token") {
          const c = await authenticateClient(s.db, req, body, { allowPublic: true });
          if (!refreshAllowed(c)) throw new OAuthError(400, "unauthorized_client", "La aplicación no admite refresh_token");
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
            // Autorizado desde una sesión SSO: la familia no pasa de la duración de sesión de la conexión (contada desde que
            // empezó), aunque el refresh token sea anterior a ese tope (ver ssoFamilyDeadline).
            if (old.auth_method === "sso") {
              const deadline = await ssoFamilyDeadline(t, old.family_id, old.sso_tenant_id);
              if (deadline && deadline <= new Date()) throw new OAuthError(400, "invalid_grant", "La sesión de inicio único venció: volvé a autorizar la aplicación");
            }
            const requested = parseScopes(body.scope);
            const scopes = requested.length ? requested : old.scopes;
            if (scopes.some((x: string) => !old.scopes.includes(x))) throw new OAuthError(400, "invalid_scope", "No se pueden ampliar los scopes");
            if (old.user_id) {
              await userGrantAllowed(t, { tenantId: old.tenant_id, userId: old.user_id, authMethod: old.auth_method, ssoTenantId: old.sso_tenant_id, issuedAt: new Date(old.created_at) });
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
              authMethod: old.auth_method,
              ssoTenantId: old.sso_tenant_id,
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
          `SELECT t.*, u.email, k.revoked_at AS key_revoked_at FROM oauth_tokens t LEFT JOIN users u ON u.id = t.user_id
             LEFT JOIN api_keys k ON k.id = t.service_api_key_id WHERE t.token_hash = $1`,
          [sha256Hex(body.token)],
        );
        reply.header("cache-control", "no-store");
        let active = t && t.client_id === c.id && !t.revoked_at && !(t.kind === "refresh" && t.used_at) && new Date(t.expires_at) > new Date();
        // "active" tiene que decir lo mismo que la API al usar el token: un token de un miembro quitado (o de una
        // membresía anterior), uno autorizado con contraseña cuando la organización exige SSO, o uno de una identidad de
        // servicio revocada ya no autorizan nada, aunque no estén revocados ni vencidos.
        if (active && t.service_api_key_id && t.key_revoked_at) active = false;
        if (active && t.user_id) {
          try {
            await assertUserTokenAllowed(s.db, { tenantId: t.tenant_id, userId: t.user_id, authMethod: t.auth_method, ssoTenantId: t.sso_tenant_id, issuedAt: new Date(t.created_at) });
          } catch (e) {
            if (!(e instanceof AppError)) throw e;
            active = false;
          }
        }
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
      v.client.tenant_id ? s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [v.client.tenant_id]) : null,
      s.db.one<any>(`SELECT scopes FROM oauth_consents WHERE client_id = $1 AND user_id = $2 AND tenant_id = $3`, [v.client.id, a.userId, a.tenantId]),
    ]);
    const granted = new Set<string>(consent?.scopes ?? []);
    const info: AuthorizeInfo = {
      client: {
        name: v.client.name,
        description: v.client.description,
        organizationName: owner?.name ?? "",
        clientId: v.client.client_id,
        unverified: v.client.registration === "dynamic",
      },
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
      return { redirectTo: withParams(v.redirectUri, { error: "access_denied", error_description: "El usuario no autorizó la aplicación", state: v.req.state, iss: config.appUrl }) };
    }
    // Cómo se autenticó la sesión que autoriza: los tokens lo heredan y valen solo mientras esa sesión valdría
    // (p. ej. con "SSO obligatorio", un token autorizado con contraseña deja de valer).
    const sess = await s.db.one<any>(`SELECT auth_method, sso_tenant_id, expires_at FROM sessions WHERE token_hash = $1`, [sha256Hex(sessionCookieToken(req) ?? "")]);
    const code = CODE_PREFIX + randomToken(32);
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO oauth_authorization_codes (code_hash, client_id, tenant_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, auth_method, sso_tenant_id, sso_session_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'S256', now() + ($8 || ' seconds')::interval, $9, $10, $11)`,
        [
          sha256Hex(code),
          v.client.id,
          a.tenantId,
          a.userId,
          v.redirectUri,
          v.scopes,
          v.req.code_challenge,
          String(CODE_TTL_SEC),
          sess?.auth_method ?? "password",
          sess?.sso_tenant_id ?? null,
          // Autorizado desde una sesión SSO: los tokens no pasan del vencimiento de esa sesión (ver ssoCodeDeadline).
          sess?.auth_method === "sso" ? sess.expires_at : null,
        ],
      );
      await t.query(
        `INSERT INTO oauth_consents (client_id, user_id, tenant_id, scopes) VALUES ($1,$2,$3,$4)
         ON CONFLICT (client_id, user_id, tenant_id) DO UPDATE SET scopes = (SELECT array_agg(DISTINCT x) FROM unnest(oauth_consents.scopes || EXCLUDED.scopes) x), updated_at = now()`,
        [v.client.id, a.userId, a.tenantId, v.scopes],
      );
    });
    await auditFromRequest(s.db, req, a, "oauth.authorized", {
      targetType: "oauth_app",
      targetId: v.client.client_id,
      data: { app: v.client.name, scopes: v.scopes, ...(v.client.registration === "dynamic" ? { unverified: true, redirectUri: v.redirectUri } : {}) },
    });
    // `iss` (RFC 9207): protege a los clientes con varios servidores de autorización contra la confusión de emisor.
    return { redirectTo: withParams(v.redirectUri, { code, state: v.req.state, iss: config.appUrl }) };
  });

  // Apps que el usuario autorizó (para revocarlas desde Seguridad / Apps conectadas).
  app.get("/v1/oauth/connected-apps", { preHandler: auth }, async (req) => {
    const a = req.auth;
    requireUserSession(a);
    const rows = await s.db.query<any>(
      `SELECT c.client_id, c.name, c.registration, t.name AS org, oc.scopes, oc.updated_at
         FROM oauth_consents oc JOIN oauth_clients c ON c.id = oc.client_id LEFT JOIN tenants t ON t.id = c.tenant_id
        WHERE oc.user_id = $1 AND oc.tenant_id = $2 AND c.revoked_at IS NULL ORDER BY oc.updated_at DESC`,
      [a.userId, a.tenantId],
    );
    const items: ConnectedApp[] = rows.map((r) => ({
      clientId: r.client_id,
      name: r.name,
      organizationName: r.org ?? "",
      scopes: r.scopes,
      authorizedAt: iso(r.updated_at)!,
      unverified: r.registration === "dynamic",
    }));
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
      // Y los códigos todavía sin canjear (valen 10 minutos): canjeados después de desconectar, la app recibía tokens
      // nuevos (con refresh token) que esta revocación ya no alcanzaba. Como al restablecer la contraseña.
      await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE client_id = $1 AND user_id = $2 AND tenant_id = $3 AND used_at IS NULL`, [
        c.id,
        a.userId,
        a.tenantId,
      ]);
    });
    await auditFromRequest(s.db, req, a, "oauth.disconnected", { targetType: "oauth_app", targetId: req.params.clientId, data: { app: c.name } });
    return reply.code(204).send();
  });

  // ───────── Administración de apps (permiso api_keys:manage, ver access.ts) ─────────

  app.get("/v1/oauth/apps", { preHandler: auth }, async (req) => {
    const rows = await s.db.query<any>(`SELECT * FROM oauth_clients WHERE tenant_id = $1 ORDER BY created_at DESC`, [req.auth!.tenantId]);
    return { items: await Promise.all(rows.map((r) => toApp(s.db, r, req.auth!))) };
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
    // A nombre de la persona (también si la crea una API key): así la app se inutiliza con su baja.
    const creator = await actingPerson(s.db, a);
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO oauth_clients (id, tenant_id, client_id, secret_hash, secret_prefix, name, description, redirect_uris, grant_types, scopes, created_by, created_by_api_key_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, a.tenantId, clientId, secret ? sha256Hex(secret) : null, secret ? secret.slice(0, 12) : null, input.name, input.description ?? null, input.redirectUris ?? [], input.grantTypes, input.scopes, creator, a.oauth ? null : a.apiKeyId],
      );
      if (usesCc) {
        // Identidad de servicio: una API key interna sin secreto utilizable; da el rol y la propiedad de los sobres.
        const keyId = uuidv7();
        await t.query(
          `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by, role, role_id, oauth_client_id)
           VALUES ($1,$2,$3,'oauth',$4,$5,$6,$7,$8)`,
          [keyId, a.tenantId, `App OAuth: ${input.name}`, sha256Hex(`unusable:${randomToken(32)}`), creator, role, input.roleId ?? null, id],
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

  app.get<{ Params: { id: string } }>("/v1/oauth/apps/:id", { preHandler: auth }, async (req) => toApp(s.db, await loadOwn(req.auth!, req.params.id), req.auth!));

  app.patch<{ Params: { id: string } }>("/v1/oauth/apps/:id", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const r = await loadOwn(a, req.params.id);
    if (r.revoked_at) throw new AppError(409, "revoked", "La aplicación está revocada");
    const input = UpdateOAuthAppInput.parse(req.body);
    if (input.scopes) await assertCanManageServiceApp(s.db, a, r, "cambiar los scopes de una app");
    if (input.redirectUris) await assertCanTakeOverApp(s.db, a, r, "cambiar las URI de redirección de esta app");
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
    if (input.redirectUris) {
      // Una URI quitada (p. ej. una comprometida): los tokens emitidos con códigos que se entregaron ahí se revocan.
      // Antes solo se frenaban los códigos sin canjear; los tokens (y sus refresh tokens) ya emitidos seguían valiendo.
      const issued = await s.db.query<any>(
        `SELECT DISTINCT c.code_hash, c.redirect_uri FROM oauth_tokens t JOIN oauth_authorization_codes c ON c.code_hash = t.code_hash
          WHERE t.client_id = $1 AND t.revoked_at IS NULL`,
        [r.id],
      );
      const gone = issued.filter((x) => !redirectUriAllowed(input.redirectUris!, x.redirect_uri)).map((x) => x.code_hash as string);
      if (gone.length) await s.db.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND code_hash = ANY($2) AND revoked_at IS NULL`, [r.id, gone]);
    }
    await auditFromRequest(s.db, req, a, "oauth_app.updated", { targetType: "oauth_app", targetId: r.client_id, data: { fields: Object.keys(input) } });
    return toApp(s.db, await s.db.one<any>(`SELECT * FROM oauth_clients WHERE id = $1`, [r.id]));
  });

  app.post<{ Params: { id: string } }>("/v1/oauth/apps/:id/rotate-secret", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const r = await loadOwn(a, req.params.id);
    if (r.revoked_at) throw new AppError(409, "revoked", "La aplicación está revocada");
    if (!r.secret_hash) throw badRequest("public_client", "Un cliente público no tiene secreto");
    await assertCanManageServiceApp(s.db, a, r, "rotar el secreto de una app");
    await assertCanTakeOverApp(s.db, a, r, "rotar el secreto de esta app");
    const secret = `cssec_${randomToken(32)}`;
    await s.db.query(`UPDATE oauth_clients SET secret_hash = $2, secret_prefix = $3, updated_at = now() WHERE id = $1`, [r.id, sha256Hex(secret), secret.slice(0, 12)]);
    await auditFromRequest(s.db, req, a, "oauth_app.secret_rotated", { targetType: "oauth_app", targetId: r.client_id });
    return { app: await toApp(s.db, await s.db.one<any>(`SELECT * FROM oauth_clients WHERE id = $1`, [r.id])), clientSecret: secret };
  });

  app.delete<{ Params: { id: string } }>("/v1/oauth/apps/:id", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const r = await loadOwn(a, req.params.id);
    await assertCanManageServiceApp(s.db, a, r, "revocar una app");
    await s.db.tx(async (t) => {
      await t.query(`UPDATE oauth_clients SET revoked_at = COALESCE(revoked_at, now()), updated_at = now() WHERE id = $1`, [r.id]);
      await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL`, [r.id]);
      if (r.service_api_key_id) await t.query(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`, [r.service_api_key_id]);
    });
    await auditFromRequest(s.db, req, a, "oauth_app.revoked", { targetType: "oauth_app", targetId: r.client_id, data: { name: r.name } });
    return reply.code(204).send();
  });
}
