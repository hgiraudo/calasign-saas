// Inicio de sesión único (SSO) para remitentes: OIDC (código de autorización + PKCE) y SAML 2.0 (SP-initiated).
// Una sesión abierta por SSO queda atada a esa organización (no puede cambiar a otra sin volver a entrar), y la
// política "SSO obligatorio" rechaza sesiones con contraseña salvo las de propietarios (acceso de emergencia).
import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate, type JsonWebKey } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SAML, ValidateInResponseTo, type CacheProvider } from "@node-saml/node-saml";
import { SsoDiscoverInput, SsoSettingsInput, type SsoDiscoverResponse, type SsoSettings } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError, badRequest, conflict, forbidden } from "../../lib/errors";
import { decrypt, encrypt, randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import { auditFromRequest, changedValues, recordAudit } from "../audit";
import { authenticate, clientInfo, setSessionCookie, type AuthContext, type Services } from "../context";
import { syncSsoDomains } from "../data/sso-domains";
import { safeRequest } from "../webhooks";
import { tenantPlan, usersCount } from "../billing/plans";
import { blockedByConsoleRemoval, provisionMembership } from "../member-access";

/**
 * Duración absoluta (sin renovación) de una sesión abierta por SSO, configurable por organización
 * (sso_configs.session_ttl_hours, 1 h a 14 días; por defecto 24 h). Corta: así lo que el IdP decide (baja, bloqueo,
 * cambio de políticas) llega a la sesión en horas y no en semanas. Las sesiones con contraseña siguen en 14 días.
 */
export const SSO_SESSION_TTL_DEFAULT_HOURS = 24;
export const SSO_SESSION_TTL_MAX_HOURS = 14 * 24;
export function ssoSessionTtlHours(c: { session_ttl_hours?: number | null } | null | undefined): number {
  const h = Math.trunc(Number(c?.session_ttl_hours ?? SSO_SESSION_TTL_DEFAULT_HOURS));
  return Number.isFinite(h) && h >= 1 ? Math.min(h, SSO_SESSION_TTL_MAX_HOURS) : SSO_SESSION_TTL_DEFAULT_HOURS;
}
const STATE_TTL_MIN = 10;
/**
 * El state queda atado al navegador que inició el ingreso (cookie). Sin esto, alguien completa el ingreso con SU
 * cuenta del IdP, frena antes del callback y le pasa ese link a otra persona, que queda conectada a la cuenta del
 * atacante (y lo que suba queda en ella): "login CSRF".
 */
const STATE_COOKIE = "cs_sso_state";
const CLOCK_SKEW_S = 120;

// ───────────────────────────── Configuración ─────────────────────────────

interface SsoRow {
  tenant_id: string;
  enabled: boolean;
  protocol: "oidc" | "saml";
  jit_enabled: boolean;
  jit_role: "admin" | "member";
  enforce: boolean;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_enc: string | null;
  oidc_scopes: string | null;
  saml_entry_point: string | null;
  saml_idp_issuer: string | null;
  saml_idp_cert: string | null;
  saml_email_attribute: string | null;
  oidc_trust_unverified_email: boolean;
  session_ttl_hours: number;
}

async function loadConfig(db: Db, tenantId: string): Promise<SsoRow | null> {
  return db.one<SsoRow>(`SELECT * FROM sso_configs WHERE tenant_id = $1`, [tenantId]);
}

function spUrls(slug: string) {
  const base = config.appUrl;
  return {
    oidcRedirectUri: `${base}/v1/auth/sso/oidc/callback`,
    samlEntityId: `${base}/v1/auth/sso/saml/${slug}/metadata`,
    samlAcsUrl: `${base}/v1/integrations/sso/saml/${slug}/acs`,
    samlMetadataUrl: `${base}/v1/auth/sso/saml/${slug}/metadata`,
    loginUrl: `${base}/v1/auth/sso/start?org=${encodeURIComponent(slug)}`,
  };
}

/** Normaliza un certificado del IdP a PEM y valida que sea un X.509. */
export function normalizeCert(input: string): string {
  const body = input.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const pem = `-----BEGIN CERTIFICATE-----\n${body.replace(/(.{64})/g, "$1\n").trim()}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(pem); // lanza si no es válido
  return pem;
}

function certFingerprint(pem: string | null): string | null {
  if (!pem) return null;
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
}

/** Configuración SSO auditable (sin secretos: el client secret queda fuera; del certificado, solo la huella). */
async function ssoAuditSnapshot(db: Db, tenantId: string) {
  const c = await loadConfig(db, tenantId);
  const domains = (await db.query<{ domain: string }>(`SELECT domain FROM sso_domains WHERE tenant_id = $1 ORDER BY domain`, [tenantId])).map((d) => d.domain);
  return {
    values: {
      enabled: Boolean(c?.enabled),
      protocol: c?.protocol ?? null,
      issuer: c?.oidc_issuer ?? null,
      clientId: c?.oidc_client_id ?? null,
      scopes: c?.oidc_scopes ?? null,
      trustUnverifiedEmail: c ? Boolean(c.oidc_trust_unverified_email) : null,
      entryPoint: c?.saml_entry_point ?? null,
      idpIssuer: c?.saml_idp_issuer ?? null,
      // Del certificado del IdP, solo la huella SHA-256.
      certFingerprint: certFingerprint(c?.saml_idp_cert ?? null),
      emailAttribute: c?.saml_email_attribute ?? null,
      enforce: Boolean(c?.enforce),
      jitEnabled: c ? Boolean(c.jit_enabled) : null,
      jitRole: c?.jit_role ?? null,
      domains,
      sessionTtlHours: c ? ssoSessionTtlHours(c) : null,
    } as Record<string, unknown>,
    secretEnc: (c?.oidc_client_secret_enc as string | null | undefined) ?? null,
  };
}

async function toSettings(db: Db, tenantId: string): Promise<SsoSettings> {
  const t = await db.one<any>(`SELECT slug FROM tenants WHERE id = $1`, [tenantId]);
  const c = await loadConfig(db, tenantId);
  const domains = (await db.query<{ domain: string }>(`SELECT domain FROM sso_domains WHERE tenant_id = $1 ORDER BY domain`, [tenantId])).map((d) => d.domain);
  return {
    enabled: Boolean(c?.enabled),
    protocol: c?.protocol ?? "oidc",
    domains,
    jitEnabled: c?.jit_enabled ?? true,
    jitRole: c?.jit_role ?? "member",
    enforce: Boolean(c?.enforce),
    sessionTtlHours: ssoSessionTtlHours(c),
    oidc: c?.oidc_issuer
      ? {
          issuer: c.oidc_issuer,
          clientId: c.oidc_client_id ?? "",
          scopes: c.oidc_scopes ?? "openid email profile",
          hasClientSecret: Boolean(c.oidc_client_secret_enc),
          trustUnverifiedEmail: Boolean(c.oidc_trust_unverified_email),
        }
      : null,
    saml: c?.saml_entry_point
      ? { entryPoint: c.saml_entry_point, idpIssuer: c.saml_idp_issuer ?? "", idpCertFingerprint: certFingerprint(c.saml_idp_cert), emailAttribute: c.saml_email_attribute }
      : null,
    serviceProvider: spUrls(t.slug),
  };
}

function allowedUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (config.environment === "local" && url.protocol === "http:");
  } catch {
    return false;
  }
}

// ───────────────────────────── Política de sesiones ─────────────────────────────

/**
 * Verifica que la sesión pueda usarse en la organización:
 *  - sesión SSO: solo en la organización que la abrió;
 *  - organización con SSO obligatorio: solo sesiones SSO, salvo propietarios (acceso de emergencia);
 *  - membresía creada por SSO o SCIM: sin sesiones con contraseña hasta que el usuario la restablezca (ver
 *    0029_r11_identity: si no, quien registró una cuenta con el correo de otra persona entraría con su contraseña a la
 *    organización de esa persona apenas el SSO o SCIM la vinculan).
 */
export async function assertSessionAllowed(
  db: Db,
  s: { authMethod: string; ssoTenantId: string | null; userId?: string | null },
  tenantId: string,
  role: string | null,
) {
  if (s.authMethod === "sso" && s.ssoTenantId !== tenantId) {
    throw new AppError(401, "sso_reauth_required", "Esta sesión de inicio único es de otra organización: volvé a ingresar");
  }
  if (s.authMethod !== "sso" && s.userId) {
    const m = await db.one<any>(`SELECT password_allowed FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, s.userId]);
    if (m && m.password_allowed === false) {
      throw new AppError(401, "password_not_allowed", "En esta organización ingresá con inicio de sesión único (SSO) o restablecé tu contraseña");
    }
  }
  if (s.authMethod !== "sso" && role !== "owner") {
    const c = await db.one<any>(`SELECT enforce, enabled FROM sso_configs WHERE tenant_id = $1`, [tenantId]);
    if (c?.enabled && c.enforce) throw new AppError(401, "sso_required", "Tu organización exige ingresar con inicio de sesión único (SSO)");
  }
}

/** Para authenticate(): sesión de navegador → aplica la política y exime del alta obligatoria de 2FA a las sesiones SSO. */
export async function applySessionSsoPolicy(db: Db, a: AuthContext, session: { auth_method?: string; sso_tenant_id?: string | null }) {
  const authMethod = session.auth_method ?? "password";
  await assertSessionAllowed(db, { authMethod, ssoTenantId: session.sso_tenant_id ?? null, userId: a.userId }, a.tenantId, a.access?.role ?? null);
  if (authMethod === "sso" && a.access) a.access.twoFactorSetupRequired = false; // el IdP gestiona el segundo factor
}

/** Para el ingreso con contraseña: primera organización del usuario que admite contraseña. */
export async function passwordLoginTenant(
  db: Db,
  userId: string,
): Promise<{ tenantId: string } | { ssoRequired: { slug: string } } | { passwordResetRequired: true } | null> {
  const rows = await db.query<any>(
    `SELECT m.tenant_id, m.role, m.password_allowed, t.slug, c.enabled, c.enforce FROM memberships m JOIN tenants t ON t.id = m.tenant_id
     LEFT JOIN sso_configs c ON c.tenant_id = m.tenant_id WHERE m.user_id = $1 ORDER BY m.created_at`,
    [userId],
  );
  if (!rows.length) return null;
  const ok = rows.find((r) => r.password_allowed !== false && (!(r.enabled && r.enforce) || r.role === "owner"));
  if (ok) return { tenantId: ok.tenant_id };
  // Solo quedan organizaciones que no admiten esta contraseña: por SSO si lo tienen; si no, restableciéndola.
  const sso = rows.find((r) => r.enabled);
  if (sso) return { ssoRequired: { slug: sso.slug ?? "" } };
  return { passwordResetRequired: true };
}

// ───────────────────────────── OIDC ─────────────────────────────

const discoveryCache = new Map<string, { doc: any; at: number }>();
const jwksCache = new Map<string, { keys: JsonWebKey[]; at: number }>();

/**
 * GET/POST JSON a un IdP. Las URLs las configura la organización (issuer, endpoints del documento de descubrimiento):
 * van por `safeRequest` (sin destinos internos, validados en la misma resolución DNS que usa la conexión, sin seguir
 * redirecciones y con tope de tamaño) y el error no reproduce el cuerpo de la respuesta.
 */
async function getJson(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) {
  const res = await safeRequest(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body, timeoutMs: 10_000, maxBytes: 1024 * 1024 });
  let body: any;
  try {
    body = JSON.parse(res.body.toString("utf8"));
  } catch {
    throw new Error(`${url}: respuesta no JSON (HTTP ${res.status})`);
  }
  if (res.status < 200 || res.status >= 300) {
    const code = typeof body?.error === "string" ? `: ${body.error.slice(0, 60)}` : "";
    throw new Error(`${url}: HTTP ${res.status}${code}`);
  }
  return body;
}

export async function oidcDiscovery(issuer: string): Promise<any> {
  const key = issuer.replace(/\/$/, "");
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const doc = await getJson(`${key}/.well-known/openid-configuration`);
  if (String(doc.issuer ?? "").replace(/\/$/, "") !== key) throw new Error("el issuer del documento de descubrimiento no coincide");
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) if (!allowedUrl(doc[k] ?? "")) throw new Error(`descubrimiento sin ${k} válido`);
  discoveryCache.set(key, { doc, at: Date.now() });
  return doc;
}

async function jwks(uri: string, force = false): Promise<JsonWebKey[]> {
  const hit = jwksCache.get(uri);
  if (!force && hit && Date.now() - hit.at < 600_000) return hit.keys;
  const body = await getJson(uri);
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(uri, { keys, at: Date.now() });
  return keys;
}

const JWS_ALGS: Record<string, { hash: string; kty: string; pss?: boolean; dsa?: boolean }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
  PS256: { hash: "sha256", kty: "RSA", pss: true },
  ES256: { hash: "sha256", kty: "EC", dsa: true },
  ES384: { hash: "sha384", kty: "EC", dsa: true },
};

/** Valida un ID token (firma con JWKS, iss, aud, azp, exp, iat, nonce). Devuelve los claims. */
export async function validateIdToken(
  idToken: string,
  opts: { issuer: string; clientId: string; nonce: string; jwksUri: string; now?: number },
): Promise<Record<string, any>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("id_token mal formado");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const alg = JWS_ALGS[header.alg];
  if (!alg) throw new Error(`algoritmo no admitido: ${header.alg}`);
  let keys = await jwks(opts.jwksUri);
  const pick = (ks: JsonWebKey[]) => ks.filter((k: any) => k.kty === alg.kty && (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
  let candidates = pick(keys);
  if (!candidates.length) {
    keys = await jwks(opts.jwksUri, true); // rotación de claves
    candidates = pick(keys);
  }
  if (!candidates.length) throw new Error("no hay una clave del IdP para verificar el id_token");
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");
  const ok = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return cryptoVerify(alg.hash, data, alg.pss ? { key, padding: 6, saltLength: 32 } : alg.dsa ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
    } catch {
      return false;
    }
  });
  if (!ok) throw new Error("firma del id_token inválida");

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (String(claims.iss ?? "").replace(/\/$/, "") !== opts.issuer.replace(/\/$/, "")) throw new Error("iss inválido");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) throw new Error("aud inválido");
  if (aud.length > 1 && claims.azp !== opts.clientId) throw new Error("azp inválido");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now) throw new Error("id_token vencido");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now) throw new Error("iat en el futuro");
  if (claims.nonce !== opts.nonce) throw new Error("nonce inválido");
  return claims;
}

// ───────────────────────────── SAML ─────────────────────────────

/** Cache de AuthnRequest en la base: la validación de InResponseTo funciona con varias instancias. */
function dbCache(db: Db): CacheProvider {
  return {
    async saveAsync(key, value) {
      await db.query(`DELETE FROM saml_request_cache WHERE created_at < now() - interval '1 hour'`);
      await db.query(`INSERT INTO saml_request_cache (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [key, value]);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      const r = await db.one<any>(`SELECT value FROM saml_request_cache WHERE key = $1 AND created_at > now() - interval '15 minutes'`, [key]);
      return r?.value ?? null;
    },
    async removeAsync(key) {
      if (!key) return null;
      const r = await db.one<any>(`DELETE FROM saml_request_cache WHERE key = $1 RETURNING value`, [key]);
      return r?.value ?? null;
    },
  };
}

function samlFor(db: Db, slug: string, c: SsoRow): SAML {
  const sp = spUrls(slug);
  return new SAML({
    entryPoint: c.saml_entry_point!,
    issuer: sp.samlEntityId,
    callbackUrl: sp.samlAcsUrl,
    idpCert: c.saml_idp_cert!,
    idpIssuer: c.saml_idp_issuer ?? undefined,
    audience: sp.samlEntityId,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: STATE_TTL_MIN * 60_000,
    cacheProvider: dbCache(db),
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: CLOCK_SKEW_S * 1000,
    maxAssertionAgeMs: 10 * 60_000,
  });
}

/**
 * OIDC: el correo vale solo con email_verified = true (o "true", que mandan algunos IdP). Si falta o es otra cosa se
 * rechaza, salvo que la organización haya elegido confiar en el correo del IdP sin el claim (oidc_trust_unverified_email):
 * algunos IdP no lo mandan (p. ej. Microsoft Entra ID según el tipo de cuenta y los claims opcionales configurados).
 * Un false explícito se rechaza siempre.
 */
export function oidcEmailVerified(claims: Record<string, unknown>, trustUnverified: boolean): boolean {
  const v = claims.email_verified;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return trustUnverified;
}

/** ID y vencimiento de la Assertion SAML ya validada (profile de node-saml). */
export function samlAssertionInfo(profile: { getAssertion?: () => any }): { id: string | null; notOnOrAfter: Date | null } {
  const a = profile.getAssertion?.()?.Assertion;
  const id = typeof a?.$?.ID === "string" && a.$.ID.length > 0 && a.$.ID.length <= 512 ? a.$.ID : null;
  const raw = a?.Conditions?.[0]?.$?.NotOnOrAfter ?? a?.Subject?.[0]?.SubjectConfirmation?.[0]?.SubjectConfirmationData?.[0]?.$?.NotOnOrAfter;
  const d = typeof raw === "string" ? new Date(raw) : null;
  return { id, notOnOrAfter: d && !Number.isNaN(d.getTime()) ? d : null };
}

/**
 * Anti-replay SAML: registra el ID de la Assertion hasta que deja de ser válida (NotOnOrAfter, y como mínimo 10 min +
 * tolerancia de reloj, que es lo que node-saml acepta desde IssueInstant; tope de un día). Devuelve false si ya se usó.
 */
export async function rememberSamlAssertion(db: Db, tenantId: string, id: string, notOnOrAfter: Date | null): Promise<boolean> {
  const minMs = Date.now() + (10 * 60 + CLOCK_SKEW_S) * 1000;
  const until = new Date(Math.min(Math.max(notOnOrAfter ? notOnOrAfter.getTime() + CLOCK_SKEW_S * 1000 : 0, minMs), Date.now() + 86_400_000));
  const r = await db.query(
    `INSERT INTO saml_assertion_ids (tenant_id, assertion_id, expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, assertion_id) DO UPDATE SET expires_at = EXCLUDED.expires_at WHERE saml_assertion_ids.expires_at < now()
     RETURNING assertion_id`,
    [tenantId, id, until.toISOString()],
  );
  return r.length > 0;
}

/**
 * ¿El JIT tiene que rechazar a este usuario? Sí si la organización lo aprovisionó por SCIM y hoy no está activo
 * (desactivado o borrado por el IdP): el alta automática por SSO no lo vuelve a sumar (lo decide el IdP por SCIM).
 */
export async function scimBlocksJit(db: Db, tenantId: string, userId: string): Promise<boolean> {
  // Solo mientras la organización tenga SCIM en uso (algún token activo): sin IdP que administre, una baja vieja no
  // puede bloquear para siempre (al revocar el último token las filas se borran: releaseScimJitBlocks).
  return Boolean(
    await db.one(
      `SELECT 1 FROM scim_users WHERE tenant_id = $1 AND user_id = $2 AND (active = false OR deleted_at IS NOT NULL)
          AND EXISTS (SELECT 1 FROM scim_tokens WHERE tenant_id = $1 AND revoked_at IS NULL)`,
      [tenantId, userId],
    ),
  );
}

// ───────────────────────────── Rutas ─────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function safeRedirectPath(p: unknown): string {
  const s = typeof p === "string" ? p : "";
  // Sin espacios, controles ni barras invertidas: el navegador quita tabs/saltos y trata "\" como "/", así que
  // "/\t/evil.com" o "/\\evil.com" terminaban en "//evil.com" (redirección abierta después del ingreso).
  // Largo hasta 4000 y, si se pasa, /app (nunca una URL cortada: la vuelta a /oauth/authorize de un conector MCP pasa
  // fácilmente los 500 caracteres y, truncada, el pedido de autorización quedaba roto).
  return s.startsWith("/") && !s.startsWith("//") && s.length <= 4000 && !/[\s\\\x00-\x1f\x7f]/.test(s) ? s : "/app";
}

export async function ssoRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  async function createSsoSession(reply: FastifyReply, req: FastifyRequest, userId: string, tenantId: string, c: SsoRow) {
    const token = randomToken();
    const { ip, userAgent } = clientInfo(req);
    const hours = ssoSessionTtlHours(c);
    await s.db.query(
      `INSERT INTO sessions (token_hash, user_id, tenant_id, ip, user_agent, expires_at, auth_method, sso_tenant_id)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6::int), 'sso', $3)`,
      [sha256Hex(token), userId, tenantId, ip, userAgent, hours],
    );
    setSessionCookie(reply, token, hours * 3600);
  }

  /** Une la identidad del IdP con un usuario (alta JIT si corresponde) y abre la sesión. */
  async function completeLogin(req: FastifyRequest, reply: FastifyReply, tenantId: string, c: SsoRow, email: string, name: string | null, protocol: string) {
    const { ip, userAgent } = clientInfo(req);
    email = email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new AppError(400, "sso_no_email", "El proveedor de identidad no envió un correo válido");
    const domainRows = await s.db.query<{ domain: string; verified_at: string | null }>(`SELECT domain, verified_at FROM sso_domains WHERE tenant_id = $1`, [tenantId]);
    const emailDomain = email.split("@")[1];
    if (domainRows.length && !domainRows.some((d) => d.domain === emailDomain)) {
      throw new AppError(403, "sso_domain_mismatch", "El correo no pertenece a los dominios de la organización");
    }
    // El IdP lo configura la organización: solo puede afirmar identidades de sus dominios VERIFICADOS. Sin eso, un IdP
    // propio podría "presentar" el correo de un usuario de otra organización y abrir una sesión como esa persona.
    const domainVerified = domainRows.some((d) => d.domain === emailDomain && d.verified_at);

    let user = await s.db.one<any>(`SELECT id, name FROM users WHERE lower(email) = $1`, [email]);
    let member = user ? await s.db.one<any>(`SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, user.id]) : null;
    if (!member && !domainVerified) {
      await recordAudit(s.db, { tenantId, action: "auth.sso_denied", actor: { type: "anonymous", label: email }, ip, userAgent, data: { protocol, reason: "domain_not_verified" } });
      throw new AppError(403, "sso_domain_not_verified", "Para dar de alta usuarios por SSO, el dominio del correo tiene que estar verificado en la organización");
    }
    if (!member) {
      if (!c.jit_enabled) {
        await recordAudit(s.db, { tenantId, action: "auth.sso_denied", actor: { type: "anonymous", label: email }, ip, userAgent, data: { protocol, reason: "not_member" } });
        throw new AppError(403, "sso_not_member", "No sos miembro de esta organización. Pedí una invitación al administrador.");
      }
      // Desactivado o borrado por SCIM: el alta automática por SSO no lo vuelve a sumar (lo decide el proveedor de identidad).
      if (user && (await scimBlocksJit(s.db, tenantId, user.id))) {
        await recordAudit(s.db, { tenantId, action: "auth.sso_denied", actor: { type: "anonymous", label: email }, ip, userAgent, data: { protocol, reason: "scim_deactivated" } });
        throw new AppError(
          403,
          "sso_scim_deactivated",
          "Tu proveedor de identidad te desactivó en esta organización. Pedile a un administrador que te invite.",
        );
      }
      const outcome = await s.db.tx(async (t) => {
        // Cupo de usuarios del plan, como en invitaciones y SCIM (con la organización bloqueada: dos altas simultáneas
        // no lo superan). El SSO es de Enterprise (sin cupo), pero la configuración queda al bajar de plan: sin esto,
        // una organización que pasó a Business seguía sumando usuarios por JIT sin límite.
        await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
        // Quitado desde la consola: el JIT no lo vuelve a sumar hasta que lo inviten de nuevo.
        if (user && (await blockedByConsoleRemoval(t, tenantId, user.id, email))) return { removed: true as const };
        const { plan } = await tenantPlan(t, tenantId);
        // Su propia invitación pendiente (si la hay) no cuenta como un lugar más: la acepta esta alta.
        if (plan.users !== null && (await usersCount(t, tenantId, email)) >= plan.users) return { overLimit: plan };
        if (!user) {
          const id = uuidv7();
          await t.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,$3,'sso-only','es')`, [id, email, name?.trim() || email.split("@")[0]]);
          user = { id, name };
        }
        // Una cuenta YA existente se vincula tal cual: su 2FA y sus sesiones (de ésta y de otras organizaciones) no se
        // tocan. Ver "Cuentas pre-registradas con un correo ajeno" en docs/ARQUITECTURA.md.
        // Sin contraseña en esta organización: si la cuenta ya existía, su contraseña pudo elegirla otra persona
        // (el registro no verifica el correo). Restablecerla (que prueba el control del correo) la habilita.
        // Con una invitación vigente para el correo, entra con el rol de la invitación (y la invitación queda aceptada).
        return { joined: await provisionMembership(t, tenantId, user.id, email, c.jit_role) };
      });
      if ("removed" in outcome) {
        await recordAudit(s.db, { tenantId, action: "auth.sso_denied", actor: { type: "anonymous", label: email }, ip, userAgent, data: { protocol, reason: "removed_by_admin" } });
        throw new AppError(403, "sso_member_removed", "Un administrador te quitó de esta organización. Para volver a entrar, pedile que te invite de nuevo.");
      }
      if ("overLimit" in outcome && outcome.overLimit) {
        const overLimit = outcome.overLimit;
        await recordAudit(s.db, { tenantId, action: "auth.sso_denied", actor: { type: "anonymous", label: email }, ip, userAgent, data: { protocol, reason: "plan_limit", max: overLimit.users } });
        throw new AppError(402, "sso_plan_limit", `El plan ${overLimit.name} permite hasta ${overLimit.users} usuario(s): pedí al administrador que amplíe el plan`);
      }
      member = { role: outcome.joined.role };
      await recordAudit(s.db, {
        tenantId,
        action: "member.jit_provisioned",
        actor: { type: "system", label: `SSO ${protocol.toUpperCase()}` },
        targetType: "user",
        targetId: user!.id,
        ip,
        userAgent,
        data: {
          email,
          role: outcome.joined.role,
          ...(outcome.joined.roleId ? { roleId: outcome.joined.roleId } : {}),
          ...(outcome.joined.invitationId ? { invitationId: outcome.joined.invitationId } : {}),
        },
      });
    }
    await createSsoSession(reply, req, user!.id, tenantId, c);
    await recordAudit(s.db, { tenantId, action: "auth.login_sso", actor: { type: "user", id: user!.id, label: email }, ip, userAgent, data: { protocol } });
  }

  /**
   * Cookie del state. El ACS de SAML recibe un POST cross-site del IdP: con SameSite=Lax el navegador no mandaría la
   * cookie, así que va con SameSite=None (que exige Secure); sin HTTPS (desarrollo local) queda en Lax.
   */
  function setStateCookie(reply: FastifyReply, state: string) {
    reply.setCookie(STATE_COOKIE, state, {
      path: "/v1/",
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: config.cookieSecure ? "none" : "lax",
      maxAge: STATE_TTL_MIN * 60,
    });
  }

  /** El state del callback tiene que ser el que este navegador recibió al iniciar el ingreso. */
  function stateFromThisBrowser(req: FastifyRequest, reply: FastifyReply, state: string): boolean {
    const cookie = req.cookies?.[STATE_COOKIE] ?? "";
    reply.clearCookie(STATE_COOKIE, { path: "/v1/" });
    return cookie.length > 0 && cookie.length === state.length && sha256Hex(cookie) === sha256Hex(state);
  }

  function failRedirect(reply: FastifyReply, code: string) {
    return reply.redirect(`/login?sso_error=${encodeURIComponent(code)}`, 302);
  }

  // ───────── Configuración (remitente) ─────────

  app.get("/v1/settings/sso", { preHandler: auth }, async (req) => toSettings(s.db, req.auth!.tenantId));

  app.put("/v1/settings/sso", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    // El IdP configurado puede abrir sesión como cualquier miembro (también los propietarios): configurarlo
    // equivale a poder ser propietario, así que solo lo hace un propietario.
    if (a.access?.role !== "owner") throw forbidden("Solo un propietario puede configurar el inicio de sesión único (SSO)");
    const input = SsoSettingsInput.parse(req.body);
    const cur = await loadConfig(s.db, a.tenantId);
    if (input.oidc && !allowedUrl(input.oidc.issuer)) throw badRequest("invalid_issuer", "El issuer tiene que ser https");
    if (input.saml && !allowedUrl(input.saml.entryPoint)) throw badRequest("invalid_entry_point", "La URL de inicio de sesión del IdP tiene que ser https");
    let cert: string | null = cur?.saml_idp_cert ?? null;
    if (input.saml?.idpCert) {
      try {
        cert = normalizeCert(input.saml.idpCert);
      } catch {
        throw badRequest("invalid_certificate", "El certificado del IdP no es un X.509 válido");
      }
    }
    if (input.enabled && input.protocol === "saml" && !cert) throw badRequest("certificate_required", "Falta el certificado de firma del IdP");
    const secretEnc = input.oidc?.clientSecret ? encrypt(input.oidc.clientSecret) : cur?.oidc_client_secret_enc ?? null;
    if (input.enabled && input.protocol === "oidc" && !secretEnc) throw badRequest("client_secret_required", "Falta el client secret de OIDC");
    if (input.enabled && input.protocol === "oidc") {
      // Sin el bloque oidc (p. ej. al cambiar solo enforce o JIT) se conservan issuer y client id guardados.
      const issuer = input.oidc?.issuer ?? cur?.oidc_issuer;
      if (!issuer || !(input.oidc?.clientId ?? cur?.oidc_client_id)) throw badRequest("oidc_config_required", "Falta la configuración OIDC (issuer y client id)");
      try {
        await oidcDiscovery(issuer);
      } catch (err) {
        throw badRequest("oidc_discovery_failed", `No se pudo leer la configuración del IdP: ${(err as Error).message}`);
      }
    }
    if (input.enforce && !input.enabled) throw badRequest("sso_disabled", "Para exigir SSO primero hay que habilitarlo");

    const oidcIssuerChanged = (input.oidc?.issuer ?? cur?.oidc_issuer ?? null) !== (cur?.oidc_issuer ?? null);
    await s.db.tx(async (t) => {
      const before = await ssoAuditSnapshot(t, a.tenantId);
      // Conserva la verificación DNS de los dominios que siguen (ver modules/data/sso-domains.ts).
      await syncSsoDomains(t, a.tenantId, input.domains ?? []);
      await t.query(
        `INSERT INTO sso_configs (tenant_id, enabled, protocol, jit_enabled, jit_role, enforce, oidc_issuer, oidc_client_id, oidc_client_secret_enc, oidc_scopes,
           saml_entry_point, saml_idp_issuer, saml_idp_cert, saml_email_attribute, oidc_trust_unverified_email, session_ttl_hours, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, protocol = EXCLUDED.protocol, jit_enabled = EXCLUDED.jit_enabled,
           jit_role = EXCLUDED.jit_role, enforce = EXCLUDED.enforce, oidc_issuer = EXCLUDED.oidc_issuer, oidc_client_id = EXCLUDED.oidc_client_id,
           oidc_client_secret_enc = EXCLUDED.oidc_client_secret_enc, oidc_scopes = EXCLUDED.oidc_scopes, saml_entry_point = EXCLUDED.saml_entry_point,
           saml_idp_issuer = EXCLUDED.saml_idp_issuer, saml_idp_cert = EXCLUDED.saml_idp_cert, saml_email_attribute = EXCLUDED.saml_email_attribute,
           oidc_trust_unverified_email = EXCLUDED.oidc_trust_unverified_email, session_ttl_hours = EXCLUDED.session_ttl_hours, updated_at = now()`,
        [
          a.tenantId,
          input.enabled,
          input.protocol,
          input.jitEnabled ?? true,
          input.jitRole ?? "member",
          Boolean(input.enforce),
          input.oidc?.issuer ?? cur?.oidc_issuer ?? null,
          input.oidc?.clientId ?? cur?.oidc_client_id ?? null,
          secretEnc,
          input.oidc?.scopes ?? cur?.oidc_scopes ?? "openid email profile",
          input.saml?.entryPoint ?? cur?.saml_entry_point ?? null,
          input.saml?.idpIssuer ?? cur?.saml_idp_issuer ?? null,
          cert,
          input.saml ? input.saml.emailAttribute ?? null : cur?.saml_email_attribute ?? null,
          // Omitida: se conserva la guardada, salvo que cambie el issuer: la confianza era en el IdP anterior (p. ej. la
          // que 0079 dio a las conexiones existentes) y un IdP nuevo arranca sin ella (false) hasta que se pida.
          input.oidc?.trustUnverifiedEmail ?? (oidcIssuerChanged ? false : cur?.oidc_trust_unverified_email ?? false),
          input.sessionTtlHours ?? cur?.session_ttl_hours ?? SSO_SESSION_TTL_DEFAULT_HOURS,
        ],
      );
      // Al deshabilitar el SSO o cambiar de IdP se cierran las sesiones (y los tokens OAuth) que abrió el IdP anterior:
      // si no, cambiar un IdP comprometido o mal configurado dejaba vigentes hasta 14 días las sesiones que había abierto.
      const idp = (p: string, issuer: string | null, clientId: string | null, entryPoint: string | null, samlIssuer: string | null, samlCert: string | null) =>
        p === "oidc" ? `oidc|${issuer}|${clientId}` : `saml|${entryPoint}|${samlIssuer}|${samlCert}`;
      const idpChanged =
        cur != null &&
        idp(cur.protocol, cur.oidc_issuer, cur.oidc_client_id, cur.saml_entry_point, cur.saml_idp_issuer, cur.saml_idp_cert) !==
          idp(
            input.protocol,
            input.oidc?.issuer ?? cur.oidc_issuer ?? null,
            input.oidc?.clientId ?? cur.oidc_client_id ?? null,
            input.saml?.entryPoint ?? cur.saml_entry_point ?? null,
            input.saml?.idpIssuer ?? cur.saml_idp_issuer ?? null,
            cert,
          );
      if (cur?.enabled && (!input.enabled || idpChanged)) {
        await t.query(`DELETE FROM sessions WHERE auth_method = 'sso' AND sso_tenant_id = $1`, [a.tenantId]);
        await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE tenant_id = $1 AND auth_method = 'sso' AND revoked_at IS NULL`, [a.tenantId]);
        await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE tenant_id = $1 AND auth_method = 'sso' AND used_at IS NULL`, [a.tenantId]);
      }
      // Duración más corta: las sesiones SSO ya abiertas no pasan del nuevo tope (contado desde que se abrieron).
      if (input.sessionTtlHours != null && input.sessionTtlHours < ssoSessionTtlHours(cur)) {
        await t.query(
          `UPDATE sessions SET expires_at = LEAST(expires_at, created_at + make_interval(hours => $2::int)) WHERE auth_method = 'sso' AND sso_tenant_id = $1`,
          [a.tenantId, input.sessionTtlHours],
        );
      }
      // Al exigir SSO se cierran las sesiones con contraseña de quienes no son propietarios.
      if (input.enabled && input.enforce) {
        await t.query(
          `DELETE FROM sessions s USING memberships m WHERE s.tenant_id = $1 AND s.auth_method = 'password'
             AND m.tenant_id = s.tenant_id AND m.user_id = s.user_id AND m.role <> 'owner'`,
          [a.tenantId],
        );
      }
      // Auditoría con los valores anterior y nuevo de lo que cambió (no solo los nombres de los campos): quién cambió de
      // IdP, aflojó la exigencia de SSO o el rol del alta JIT. Secretos nunca: del client secret, solo si cambió.
      const after = await ssoAuditSnapshot(t, a.tenantId);
      const diff = changedValues(before.values, after.values);
      const secretChanged = before.secretEnc !== after.secretEnc;
      await auditFromRequest(t, req, a, "settings.sso_updated", {
        targetType: "settings",
        targetId: "sso",
        data: { changed: diff.changed, from: diff.from, to: diff.to, secretChanged },
      });
    });
    return toSettings(s.db, a.tenantId);
  });

  // ───────── Descubrimiento e inicio (público) ─────────

  app.post("/v1/auth/sso/discover", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req): Promise<SsoDiscoverResponse> => {
    const { email } = SsoDiscoverInput.parse(req.body);
    const r = await s.db.one<any>(
      `SELECT t.slug, t.name, c.enforce FROM sso_domains d JOIN tenants t ON t.id = d.tenant_id JOIN sso_configs c ON c.tenant_id = d.tenant_id
       WHERE d.domain = $1 AND d.verified_at IS NOT NULL AND c.enabled`,
      [email.split("@")[1]],
    );
    if (!r) return { sso: false, startUrl: null, organizationName: null, enforced: false };
    return {
      sso: true,
      startUrl: `/v1/auth/sso/start?org=${encodeURIComponent(r.slug)}&login_hint=${encodeURIComponent(email)}`,
      organizationName: r.name,
      enforced: Boolean(r.enforce),
    };
  });

  app.get<{ Querystring: { org?: string; login_hint?: string; redirect?: string } }>(
    "/v1/auth/sso/start",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const slug = String(req.query.org ?? "");
      const t = await s.db.one<any>(`SELECT id, slug FROM tenants WHERE slug = $1`, [slug]);
      const c = t ? await loadConfig(s.db, t.id) : null;
      if (!t || !c?.enabled) return failRedirect(reply, "sso_not_configured");
      const state = randomToken();
      const redirectPath = safeRedirectPath(req.query.redirect);
      try {
        if (c.protocol === "oidc") {
          const doc = await oidcDiscovery(c.oidc_issuer!);
          const verifier = randomToken(48);
          const nonce = randomToken();
          await s.db.query(
            `INSERT INTO sso_states (state_hash, tenant_id, protocol, code_verifier_enc, nonce, redirect_path, expires_at)
             VALUES ($1,$2,'oidc',$3,$4,$5, now() + interval '${STATE_TTL_MIN} minutes')`,
            [sha256Hex(state), t.id, encrypt(verifier), nonce, redirectPath],
          );
          setStateCookie(reply, state);
          const url = new URL(doc.authorization_endpoint);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("client_id", c.oidc_client_id!);
          url.searchParams.set("redirect_uri", spUrls(t.slug).oidcRedirectUri);
          url.searchParams.set("scope", c.oidc_scopes || "openid email profile");
          url.searchParams.set("state", state);
          url.searchParams.set("nonce", nonce);
          url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
          url.searchParams.set("code_challenge_method", "S256");
          if (req.query.login_hint && EMAIL_RE.test(req.query.login_hint)) url.searchParams.set("login_hint", req.query.login_hint);
          return reply.redirect(url.toString(), 302);
        }
        await s.db.query(
          `INSERT INTO sso_states (state_hash, tenant_id, protocol, redirect_path, expires_at) VALUES ($1,$2,'saml',$3, now() + interval '${STATE_TTL_MIN} minutes')`,
          [sha256Hex(state), t.id, redirectPath],
        );
        setStateCookie(reply, state);
        const url = await samlFor(s.db, t.slug, c).getAuthorizeUrlAsync(state, undefined, {});
        return reply.redirect(url, 302);
      } catch (err) {
        req.log.error({ err: String(err), tenant: slug }, "no se pudo iniciar el SSO");
        return failRedirect(reply, "sso_idp_unreachable");
      }
    },
  );

  /** Consume el state (un solo uso, vigente). */
  async function consumeState(state: string, protocol: "oidc" | "saml") {
    const row = await s.db.one<any>(
      `UPDATE sso_states SET used_at = now() WHERE state_hash = $1 AND protocol = $2 AND used_at IS NULL AND expires_at > now() RETURNING *`,
      [sha256Hex(state), protocol],
    );
    await s.db.query(`DELETE FROM sso_states WHERE expires_at < now() - interval '1 day'`);
    return row;
  }

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/v1/auth/sso/oidc/callback", async (req, reply) => {
    if (req.query.error) return failRedirect(reply, "sso_idp_error");
    if (!req.query.code || !req.query.state) return failRedirect(reply, "sso_invalid_response");
    if (!stateFromThisBrowser(req, reply, req.query.state)) return failRedirect(reply, "sso_state_invalid");
    const st = await consumeState(req.query.state, "oidc");
    if (!st) return failRedirect(reply, "sso_state_invalid");
    const t = await s.db.one<any>(`SELECT id, slug FROM tenants WHERE id = $1`, [st.tenant_id]);
    const c = await loadConfig(s.db, st.tenant_id);
    if (!c?.enabled || c.protocol !== "oidc") return failRedirect(reply, "sso_not_configured");
    try {
      const doc = await oidcDiscovery(c.oidc_issuer!);
      const secret = c.oidc_client_secret_enc ? decrypt(c.oidc_client_secret_enc) : "";
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: spUrls(t.slug).oidcRedirectUri,
        code_verifier: decrypt(st.code_verifier_enc),
        client_id: c.oidc_client_id!,
      });
      const methods: string[] = doc.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
      if (methods.includes("client_secret_post") && !methods.includes("client_secret_basic")) form.set("client_secret", secret);
      else headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.oidc_client_id!)}:${encodeURIComponent(secret)}`).toString("base64")}`;
      const tok = await getJson(doc.token_endpoint, { method: "POST", headers, body: form.toString() });
      if (!tok.id_token) throw new Error("el IdP no devolvió id_token");
      const claims = await validateIdToken(tok.id_token, { issuer: c.oidc_issuer!, clientId: c.oidc_client_id!, nonce: st.nonce, jwksUri: doc.jwks_uri });
      if (!oidcEmailVerified(claims, Boolean(c.oidc_trust_unverified_email))) {
        throw new AppError(403, "sso_email_unverified", "El correo no está verificado en el proveedor de identidad");
      }
      await completeLogin(req, reply, t.id, c, String(claims.email ?? ""), claims.name ?? ([claims.given_name, claims.family_name].filter(Boolean).join(" ") || null), "oidc");
      return reply.redirect(st.redirect_path || "/app", 302);
    } catch (err) {
      req.log.warn({ err: String((err as Error).message ?? err), tenant: t?.slug }, "SSO OIDC rechazado");
      return failRedirect(reply, err instanceof AppError ? err.code : "sso_invalid_response");
    }
  });

  app.get<{ Params: { slug: string } }>("/v1/auth/sso/saml/:slug/metadata", async (req, reply) => {
    const t = await s.db.one<any>(`SELECT id, slug FROM tenants WHERE slug = $1`, [req.params.slug]);
    if (!t) return reply.code(404).send({ error: { code: "not_found", message: "Organización no encontrada" } });
    const c = await loadConfig(s.db, t.id);
    const sp = spUrls(t.slug);
    // El certificado del IdP no hace falta para generar la metadata del SP; se usa uno ficticio si no hay.
    const saml = new SAML({ issuer: sp.samlEntityId, callbackUrl: sp.samlAcsUrl, idpCert: c?.saml_idp_cert ?? "-", wantAssertionsSigned: true,
      identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" });
    reply.header("content-type", "application/samlmetadata+xml; charset=utf-8");
    return saml.generateServiceProviderMetadata(null, null);
  });

  // ACS: el IdP hace un POST cross-site (form), por eso vive bajo /v1/integrations (sin el control de Origin).
  await app.register(async (sub) => {
    sub.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    sub.post<{ Params: { slug: string }; Body: Record<string, string> }>(
      "/v1/integrations/sso/saml/:slug/acs",
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const t = await s.db.one<any>(`SELECT id, slug FROM tenants WHERE slug = $1`, [req.params.slug]);
        const c = t ? await loadConfig(s.db, t.id) : null;
        if (!t || !c?.enabled || c.protocol !== "saml") return failRedirect(reply, "sso_not_configured");
        const body = (req.body ?? {}) as Record<string, string>;
        if (!body.RelayState || !stateFromThisBrowser(req, reply, body.RelayState)) return failRedirect(reply, "sso_state_invalid");
        const st = await consumeState(body.RelayState, "saml");
        if (!st || st.tenant_id !== t.id) return failRedirect(reply, "sso_state_invalid");
        try {
          const { profile } = await samlFor(s.db, t.slug, c).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse ?? "", RelayState: body.RelayState });
          if (!profile) throw new Error("respuesta SAML sin perfil");
          // Anti-replay: cada Assertion se usa una sola vez (además del InResponseTo de un solo uso).
          const assertion = samlAssertionInfo(profile as any);
          if (!assertion.id) throw new AppError(400, "sso_invalid_response", "La aserción SAML no tiene ID");
          if (!(await rememberSamlAssertion(s.db, t.id, assertion.id, assertion.notOnOrAfter))) {
            await recordAudit(s.db, { tenantId: t.id, action: "auth.sso_denied", actor: { type: "anonymous", label: null }, ...clientInfo(req), data: { protocol: "saml", reason: "assertion_replay" } });
            throw new AppError(400, "sso_assertion_replay", "Esta respuesta SAML ya se usó");
          }
          const attr = c.saml_email_attribute ? profile[c.saml_email_attribute] : null;
          const email = String(
            (Array.isArray(attr) ? attr[0] : attr) ?? profile.email ?? profile.mail ?? profile["urn:oid:0.9.2342.19200300.100.1.3"] ?? profile.nameID ?? "",
          );
          const nameAttr = profile["displayName"] ?? profile["http://schemas.microsoft.com/identity/claims/displayname"] ?? null;
          await completeLogin(req, reply, t.id, c, email, typeof nameAttr === "string" ? nameAttr : null, "saml");
          return reply.redirect(st.redirect_path || "/app", 302);
        } catch (err) {
          req.log.warn({ err: String((err as Error).message ?? err), tenant: t.slug }, "SSO SAML rechazado");
          return failRedirect(reply, err instanceof AppError ? err.code : "sso_invalid_response");
        }
      },
    );
  });
}
