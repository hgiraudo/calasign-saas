// Endurecimiento de identidad (migración 0077): SCIM DELETE conserva la fila y bloquea el JIT, restablecer la contraseña
// lista (y opcionalmente revoca) credenciales creadas, 2FA cierra otras sesiones, email_verified
// en OIDC, anti-replay SAML, duración de sesiones SSO. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-identity-hardening-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let tenant = "";
const SCIM = "cs_scim_test_identity_hardening_000000000000";
const scimHeaders = { authorization: `Bearer ${SCIM}`, "content-type": "application/scim+json" };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = await newTenant();
  await db.query(`INSERT INTO sso_domains (domain, tenant_id, verification_token, verified_at) VALUES ('empresa.test', $1, 'tok', now())`, [tenant]);
  await db.query(`INSERT INTO scim_tokens (id, tenant_id, name, prefix, token_hash) VALUES ($1,$2,'idp','cs_scim_test',$3)`, [util.uuidv7(), tenant, util.sha256Hex(SCIM)]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function newTenant() {
  const id = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', 'enterprise')`, [id, `t-${id.slice(-8)}`]);
  return id;
}

async function newUser(email: string, opts: { tenantId?: string; role?: string; proven?: boolean; totp?: boolean } = {}) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash, password_reset_at) VALUES ($1,$2,'Ana','scrypt$x', $3)`, [
    id,
    email,
    opts.proven ? new Date().toISOString() : null,
  ]);
  if (opts.tenantId) await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [opts.tenantId, id, opts.role ?? "member"]);
  if (opts.totp) {
    await db.query(`UPDATE users SET totp_secret_enc = 'x', totp_enabled_at = now(), totp_recovery_hashes = '{h}' WHERE id = $1`, [id]);
  }
  return id;
}

async function newSession(userId: string, tenantId: string, authMethod = "password") {
  const token = util.randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method, sso_tenant_id) VALUES ($1,$2,$3, now() + interval '14 days', $4, $5)`,
    [util.sha256Hex(token), userId, tenantId, authMethod, authMethod === "sso" ? tenantId : null],
  );
  return token;
}

const totpOn = async (userId: string) => Boolean((await db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [userId]))!.totp_enabled_at);

describe("SCIM DELETE", () => {
  it("conserva la fila (inactiva y borrada), oculta al usuario (404) y el JIT por SSO no lo vuelve a sumar", async () => {
    const { scimBlocksJit } = await import("../src/modules/identity/sso");
    const created = await app.inject({ method: "POST", url: "/scim/v2/Users", headers: scimHeaders, payload: { userName: "borrada@empresa.test", externalId: "ext-1" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(await scimBlocksJit(db, tenant, id)).toBe(false);

    const del = await app.inject({ method: "DELETE", url: `/scim/v2/Users/${id}`, headers: scimHeaders });
    expect(del.statusCode).toBe(204);
    const row = await db.one<any>(`SELECT active, deleted_at FROM scim_users WHERE tenant_id = $1 AND user_id = $2`, [tenant, id]);
    expect(row).toMatchObject({ active: false });
    expect(row.deleted_at).not.toBeNull();
    expect(await db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenant, id])).toBeNull();

    // RFC 7644 §3.6: un recurso borrado no se devuelve.
    expect((await app.inject({ method: "GET", url: `/scim/v2/Users/${id}`, headers: scimHeaders })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/scim/v2/Users/${id}`, headers: scimHeaders })).statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: `/scim/v2/Users?filter=${encodeURIComponent('userName eq "borrada@empresa.test"')}`, headers: scimHeaders });
    expect(list.json().totalResults).toBe(0);

    // El bloqueo del JIT mira la fila conservada.
    expect(await scimBlocksJit(db, tenant, id)).toBe(true);

    // El IdP lo vuelve a crear: deja de estar borrado (y de bloquear el JIT).
    const again = await app.inject({ method: "POST", url: "/scim/v2/Users", headers: scimHeaders, payload: { userName: "borrada@empresa.test" } });
    expect(again.statusCode).toBe(201);
    expect(again.json().id).toBe(id);
    expect(await db.one<any>(`SELECT active, deleted_at FROM scim_users WHERE tenant_id = $1 AND user_id = $2`, [tenant, id])).toMatchObject({ active: true, deleted_at: null });
    expect(await scimBlocksJit(db, tenant, id)).toBe(false);
  });

  it("también bloquea el JIT a un usuario desactivado (active = false)", async () => {
    const { scimBlocksJit } = await import("../src/modules/identity/sso");
    const created = await app.inject({ method: "POST", url: "/scim/v2/Users", headers: scimHeaders, payload: { userName: "inactiva@empresa.test", active: false } });
    expect(created.statusCode).toBe(201);
    expect(await scimBlocksJit(db, tenant, created.json().id)).toBe(true);
  });
});

describe("restablecer la contraseña", () => {
  async function resetToken(userId: string) {
    const token = util.randomToken();
    await db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [util.sha256Hex(token), userId]);
    return token;
  }

  async function setup(email: string) {
    const t1 = await newTenant();
    const t2 = await newTenant();
    const u = await newUser(email, { tenantId: t1, role: "owner", totp: true });
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'admin')`, [t2, u]);
    const key = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by) VALUES ($1,$2,'k','cs_test',$3,$4)`, [key, t1, util.sha256Hex(util.randomToken()), u]);
    const otherKey = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1,$2,'ajena','cs_test',$3)`, [otherKey, t1, util.sha256Hex(util.randomToken())]);
    const scim = util.uuidv7();
    await db.query(`INSERT INTO scim_tokens (id, tenant_id, name, prefix, token_hash, created_by) VALUES ($1,$2,'s','cs_scim',$3,$4)`, [scim, t2, util.sha256Hex(util.randomToken()), u]);
    // App de servicio (client_credentials) creada por la persona, con su API key interna.
    const svcKey = util.uuidv7();
    const svcApp = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by) VALUES ($1,$2,'svc','cs_svc',$3,$4)`, [svcKey, t2, util.sha256Hex(util.randomToken()), u]);
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, secret_hash, name, grant_types, scopes, service_api_key_id, created_by)
       VALUES ($1,$2,$3,$4,'svc','{client_credentials}','{envelopes:read}',$5,$6)`,
      [svcApp, t2, `cs_cli_${svcApp.slice(-12)}`, util.sha256Hex("secreto"), svcKey, u],
    );
    await db.query(`UPDATE api_keys SET oauth_client_id = $2 WHERE id = $1`, [svcKey, svcApp]);
    const inv = util.uuidv7();
    await db.query(
      `INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,'invitado@x.test','member',$3,$4, now() + interval '7 days')`,
      [inv, t1, util.sha256Hex(util.randomToken()), u],
    );
    return { t1, t2, u, key, otherKey, scim, svcApp, inv };
  }

  const revokedAt = async (table: string, id: string) => (await db.one<any>(`SELECT revoked_at FROM ${table} WHERE id = $1`, [id]))!.revoked_at;

  it("por defecto no revoca nada: lista las credenciales activas por organización y audita en cada una", async () => {
    const x = await setup("reset@empresa.test");
    const r = await app.inject({ method: "POST", url: "/v1/auth/password/reset", payload: { token: await resetToken(x.u), password: "una-clave-nueva-larga" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ ok: true, revokedCredentials: null });
    expect(body.twoFactorCleared).toBeUndefined();
    const byTenant = Object.fromEntries(body.createdCredentials.map((c: any) => [c.tenantId, c]));
    expect(byTenant[x.t1]).toMatchObject({ tenantName: "Org", apiKeys: 1, scimTokens: 0, serviceApps: 0, invitations: 1 });
    expect(byTenant[x.t2]).toMatchObject({ apiKeys: 0, scimTokens: 1, serviceApps: 1, invitations: 0 });
    expect(await revokedAt("api_keys", x.key)).toBeNull();
    expect(await revokedAt("scim_tokens", x.scim)).toBeNull();
    expect(await revokedAt("invitations", x.inv)).toBeNull();
    expect((await db.one<any>(`SELECT secret_hash FROM oauth_clients WHERE id = $1`, [x.svcApp]))!.secret_hash).toBe(util.sha256Hex("secreto"));
    // La 2FA no se borra al restablecer.
    expect(await totpOn(x.u)).toBe(true);
    const a1 = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'user.password_reset'`, [x.t1]);
    expect(a1.data).toMatchObject({ revokeCreatedCredentials: false, activeCreatedCredentials: { apiKeys: 1, invitations: 1 } });
    expect(a1.data.revokedCredentials).toBeUndefined();
    expect(a1.data.twoFactorCleared).toBeUndefined();
    const a2 = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'user.password_reset'`, [x.t2]);
    expect(a2.data).toMatchObject({ activeCreatedCredentials: { scimTokens: 1, serviceApps: 1 } });
  });

  it("revokeCreatedCredentials: revoca solo sus API keys e invitaciones (nunca tokens SCIM ni apps de servicio)", async () => {
    const x = await setup("reset-revoca@empresa.test");
    const r = await app.inject({
      method: "POST",
      url: "/v1/auth/password/reset",
      payload: { token: await resetToken(x.u), password: "una-clave-nueva-larga", revokeCreatedCredentials: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().revokedCredentials).toEqual({ apiKeys: 1, invitations: 1 });
    const byTenant = Object.fromEntries(r.json().createdCredentials.map((c: any) => [c.tenantId, c]));
    expect(byTenant[x.t1]).toBeUndefined();
    expect(byTenant[x.t2]).toMatchObject({ apiKeys: 0, scimTokens: 1, serviceApps: 1 });
    expect(await revokedAt("api_keys", x.key)).not.toBeNull();
    expect(await revokedAt("api_keys", x.otherKey)).toBeNull();
    expect(await revokedAt("invitations", x.inv)).not.toBeNull();
    expect(await revokedAt("scim_tokens", x.scim)).toBeNull();
    expect((await db.one<any>(`SELECT secret_hash FROM oauth_clients WHERE id = $1`, [x.svcApp]))!.secret_hash).toBe(util.sha256Hex("secreto"));
    // La membresía sigue.
    expect(await db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [x.t1, x.u])).not.toBeNull();
    const a1 = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'user.password_reset'`, [x.t1]);
    expect(a1.data).toMatchObject({ revokeCreatedCredentials: true, revokedCredentials: { apiKeys: [x.key], invitations: 1 } });
  });

  it("en una organización de la que ya no es miembro solo se audita si ahí se le revocó algo", async () => {
    for (const revoke of [false, true]) {
      const x = await setup(`reset-ex-${revoke}@empresa.test`);
      const ex = await newTenant();
      const exKey = util.uuidv7();
      await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by) VALUES ($1,$2,'k','cs_test',$3,$4)`, [exKey, ex, util.sha256Hex(util.randomToken()), x.u]);
      const r = await app.inject({
        method: "POST",
        url: "/v1/auth/password/reset",
        payload: { token: await resetToken(x.u), password: "una-clave-nueva-larga", revokeCreatedCredentials: revoke },
      });
      expect(r.statusCode).toBe(200);
      const audited = await db.one(`SELECT 1 FROM account_audit_log WHERE tenant_id = $1 AND action = 'user.password_reset'`, [ex]);
      if (revoke) expect(audited).not.toBeNull();
      else expect(audited).toBeNull();
      // En las organizaciones de las que es miembro se audita siempre.
      expect(await db.one(`SELECT 1 FROM account_audit_log WHERE tenant_id = $1 AND action = 'user.password_reset'`, [x.t2])).not.toBeNull();
    }
  });
});

describe("SCIM: revocar el último token libera el bloqueo del JIT", () => {
  it("borra las filas inactivas o borradas de scim_users y el JIT deja de estar bloqueado", async () => {
    const { scimBlocksJit } = await import("../src/modules/identity/sso");
    const t1 = await newTenant();
    const owner = await newUser("owner-scim@empresa.test", { tenantId: t1, role: "owner", proven: true });
    const cookie = await newSession(owner, t1);
    const tok1 = util.uuidv7();
    const tok2 = util.uuidv7();
    for (const id of [tok1, tok2]) {
      await db.query(`INSERT INTO scim_tokens (id, tenant_id, name, prefix, token_hash) VALUES ($1,$2,'idp','cs_scim',$3)`, [id, t1, util.sha256Hex(util.randomToken())]);
    }
    const off = await newUser("desactivada-scim@empresa.test");
    const on = await newUser("activa-scim@empresa.test", { tenantId: t1 });
    await db.query(`INSERT INTO scim_users (tenant_id, user_id, active, deleted_at) VALUES ($1,$2,false, now())`, [t1, off]);
    await db.query(`INSERT INTO scim_users (tenant_id, user_id, active) VALUES ($1,$2,true)`, [t1, on]);
    expect(await scimBlocksJit(db, t1, off)).toBe(true);

    // Queda otro token activo: sigue bloqueado.
    expect((await app.inject({ method: "DELETE", url: `/v1/settings/scim/tokens/${tok1}`, cookies: { cs_session: cookie } })).statusCode).toBe(204);
    expect(await scimBlocksJit(db, t1, off)).toBe(true);
    // El último: se liberan.
    expect((await app.inject({ method: "DELETE", url: `/v1/settings/scim/tokens/${tok2}`, cookies: { cs_session: cookie } })).statusCode).toBe(204);
    expect(await db.one(`SELECT 1 FROM scim_users WHERE tenant_id = $1 AND user_id = $2`, [t1, off])).toBeNull();
    expect(await db.one(`SELECT 1 FROM scim_users WHERE tenant_id = $1 AND user_id = $2`, [t1, on])).not.toBeNull();
    expect(await scimBlocksJit(db, t1, off)).toBe(false);
    const audit = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'scim.jit_blocks_released'`, [t1]);
    expect(audit.data).toMatchObject({ scimUsersReleased: 1 });
  });

  it("sin tokens SCIM activos una fila vieja no bloquea", async () => {
    const { scimBlocksJit } = await import("../src/modules/identity/sso");
    const t1 = await newTenant();
    const u = await newUser("vieja-scim@empresa.test");
    await db.query(`INSERT INTO scim_users (tenant_id, user_id, active) VALUES ($1,$2,false)`, [t1, u]);
    expect(await scimBlocksJit(db, t1, u)).toBe(false);
  });
});

describe("2FA: activar o desactivar cierra las otras sesiones", () => {
  it("la sesión actual sigue y las demás se cierran, al activar y al desactivar", async () => {
    const { decrypt } = util;
    const { totpAt, currentStep } = await import("../src/lib/totp");
    const t1 = await newTenant();
    const u = await newUser("dosfa@empresa.test", { tenantId: t1, role: "owner", proven: true });
    const current = await newSession(u, t1);
    const other = await newSession(u, t1);
    const cookies = { cs_session: current };

    const setup = await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies });
    expect(setup.statusCode).toBe(200);
    const pending = (await db.one<any>(`SELECT totp_pending_enc FROM users WHERE id = $1`, [u]))!.totp_pending_enc;
    const code = totpAt(decrypt(pending), currentStep());
    const enable = await app.inject({ method: "POST", url: "/v1/me/2fa/enable", cookies, payload: { code } });
    expect(enable.statusCode).toBe(200);
    const rows = await db.query<any>(`SELECT token_hash FROM sessions WHERE user_id = $1`, [u]);
    expect(rows.map((r) => r.token_hash)).toEqual([util.sha256Hex(current)]);
    expect(rows.map((r) => r.token_hash)).not.toContain(util.sha256Hex(other));

    const third = await newSession(u, t1);
    const disable = await app.inject({ method: "POST", url: "/v1/me/2fa/disable", cookies, payload: { code: enable.json().recoveryCodes[0] } });
    expect(disable.statusCode).toBe(200);
    const left = await db.query<any>(`SELECT token_hash FROM sessions WHERE user_id = $1`, [u]);
    expect(left.map((r) => r.token_hash)).toEqual([util.sha256Hex(current)]);
    expect(left.map((r) => r.token_hash)).not.toContain(util.sha256Hex(third));
    const audit = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'user.2fa_disabled'`, [t1]);
    expect(audit.data).toMatchObject({ otherSessionsClosed: 1 });
  });
});

describe("SSO", () => {
  it("tokens OAuth autorizados desde una sesión SSO no pasan de la duración de la conexión", async () => {
    const { issueTokens, ssoFamilyDeadline } = await import("../src/modules/oauth-tokens");
    const t1 = await newTenant();
    await db.query(`INSERT INTO sso_configs (tenant_id, enabled, protocol, session_ttl_hours) VALUES ($1, true, 'oidc', 2)`, [t1]);
    const u = await newUser("oauth-sso@empresa.test", { tenantId: t1, proven: true });
    const client = util.uuidv7();
    const clientId = `cs_cli_${client.slice(-12)}`;
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris, grant_types, scopes) VALUES ($1,$2,$3,'app','{https://app.test/cb}','{authorization_code}','{envelopes:read,offline_access}')`,
      [client, t1, clientId],
    );
    const tok = await issueTokens(db, { clientId: client, tenantId: t1, userId: u, serviceApiKeyId: null, scopes: ["envelopes:read", "offline_access"], withRefresh: true, authMethod: "sso", ssoTenantId: t1 });
    const rows = await db.query<any>(`SELECT kind, created_at, expires_at, family_id FROM oauth_tokens WHERE client_id = $1`, [client]);
    const refresh = rows.find((r) => r.kind === "refresh");
    // El refresh vence con la sesión SSO (2 h), no a los 30 días.
    expect(new Date(refresh.expires_at).getTime() - new Date(refresh.created_at).getTime()).toBeLessThanOrEqual(2 * 3600_000 + 1000);
    expect(tok.expires_in).toBeLessThanOrEqual(3600);
    expect((await ssoFamilyDeadline(db, refresh.family_id, t1))!.getTime()).toBeLessThanOrEqual(new Date(refresh.created_at).getTime() + 2 * 3600_000 + 1);

    // Con contraseña: sin tope.
    const pw = await issueTokens(db, { clientId: client, tenantId: t1, userId: u, serviceApiKeyId: null, scopes: ["envelopes:read", "offline_access"], withRefresh: true, authMethod: "password" });
    expect(pw.expires_in).toBe(3600);

    // La familia empezó hace más que la duración: el refresh se rechaza aunque el token todavía no haya vencido.
    await db.query(`UPDATE oauth_tokens SET created_at = now() - interval '3 hours', expires_at = now() + interval '1 day' WHERE family_id = $1`, [refresh.family_id]);
    const r = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token!, client_id: clientId }).toString(),
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_grant");
  });

  it("tokens OAuth autorizados desde una sesión SSO: el tope arranca en la sesión que autorizó, no en el canje", async () => {
    const { createHash } = await import("node:crypto");
    const t1 = await newTenant();
    await db.query(`INSERT INTO sso_configs (tenant_id, enabled, protocol, session_ttl_hours) VALUES ($1, true, 'oidc', 8)`, [t1]);
    const u = await newUser("oauth-sso-code@empresa.test", { tenantId: t1, proven: true });
    const client = util.uuidv7();
    const clientId = `cs_cli_${client.slice(-12)}`;
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris, grant_types, scopes) VALUES ($1,$2,$3,'app','{https://app.test/cb}','{authorization_code,refresh_token}','{envelopes:read,offline_access}')`,
      [client, t1, clientId],
    );
    // Sesión SSO que vence en 30 minutos (la conexión permitiría 8 h).
    const cookie = util.randomToken();
    await db.query(
      `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method, sso_tenant_id) VALUES ($1,$2,$3, now() + interval '30 minutes', 'sso', $3)`,
      [util.sha256Hex(cookie), u, t1],
    );
    const verifier = util.randomToken() + util.randomToken();
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://app.test/cb",
      scope: "envelopes:read offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const decide = async () => {
      const d = await app.inject({ method: "POST", url: "/v1/oauth/authorize/decision", cookies: { cs_session: cookie }, payload: { ...authorize, approve: true } });
      expect(d.statusCode).toBe(200);
      return new URL(d.json().redirectTo).searchParams.get("code")!;
    };
    const exchange = (code: string) =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "https://app.test/cb", code_verifier: verifier, client_id: clientId }).toString(),
      });
    const sess = await db.one<any>(`SELECT expires_at FROM sessions WHERE token_hash = $1`, [util.sha256Hex(cookie)]);
    const code = await decide();
    const stored = await db.one<any>(`SELECT sso_session_expires_at FROM oauth_authorization_codes WHERE code_hash = $1`, [util.sha256Hex(code)]);
    expect(new Date(stored.sso_session_expires_at).getTime()).toBe(new Date(sess.expires_at).getTime());
    const tok = await exchange(code);
    expect(tok.statusCode).toBe(200);
    const rows = await db.query<any>(`SELECT kind, expires_at, sso_deadline FROM oauth_tokens WHERE code_hash = $1`, [util.sha256Hex(code)]);
    const refresh = rows.find((r) => r.kind === "refresh");
    // El refresh vence con la sesión que autorizó (30 min), no a las 8 h del canje.
    expect(new Date(refresh.expires_at).getTime()).toBeLessThanOrEqual(new Date(sess.expires_at).getTime());
    expect(new Date(refresh.sso_deadline).getTime()).toBe(new Date(sess.expires_at).getTime());
    // Al rotar, el tope de la familia se mantiene (no vuelve a contar 8 h desde el primer token).
    const rot = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.json().refresh_token, client_id: clientId }).toString(),
    });
    expect(rot.statusCode).toBe(200);
    const after = await db.query<any>(`SELECT expires_at FROM oauth_tokens WHERE code_hash = $1 AND kind = 'refresh' AND used_at IS NULL`, [util.sha256Hex(code)]);
    expect(after).toHaveLength(1);
    expect(new Date(after[0].expires_at).getTime()).toBeLessThanOrEqual(new Date(sess.expires_at).getTime());

    // La sesión ya venció cuando se canjea el código: no se emiten tokens.
    const late = await decide();
    await db.query(`UPDATE oauth_authorization_codes SET sso_session_expires_at = now() - interval '1 second' WHERE code_hash = $1`, [util.sha256Hex(late)]);
    const r = await exchange(late);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_grant");
  });

  it("al cambiar el issuer OIDC sin mandar trustUnverifiedEmail, la confianza vuelve a false", async () => {
    const t1 = await newTenant();
    const owner = await newUser("owner-issuer@empresa.test", { tenantId: t1, role: "owner", proven: true });
    const cookie = await newSession(owner, t1);
    // Como dejó 0079 a una conexión existente: confianza heredada.
    await db.query(
      `INSERT INTO sso_configs (tenant_id, enabled, protocol, oidc_issuer, oidc_client_id, oidc_trust_unverified_email) VALUES ($1, false, 'oidc', 'https://login.microsoftonline.com/x/v2.0', 'abc', true)`,
      [t1],
    );
    const put = (oidc: Record<string, unknown>) => app.inject({ method: "PUT", url: "/v1/settings/sso", cookies: { cs_session: cookie }, payload: { enabled: false, protocol: "oidc", oidc } });
    // Mismo issuer, sin mandarla: se conserva.
    const same = await put({ issuer: "https://login.microsoftonline.com/x/v2.0", clientId: "abc" });
    expect(same.statusCode).toBe(200);
    expect(same.json().oidc.trustUnverifiedEmail).toBe(true);
    // Otro issuer, sin mandarla: false.
    const other = await put({ issuer: "https://idp-nuevo.empresa.test", clientId: "abc" });
    expect(other.statusCode).toBe(200);
    expect(other.json().oidc.trustUnverifiedEmail).toBe(false);
    // Otro issuer pidiéndola explícitamente: true.
    const explicit = await put({ issuer: "https://otro-idp.empresa.test", clientId: "abc", trustUnverifiedEmail: true });
    expect(explicit.json().oidc.trustUnverifiedEmail).toBe(true);
  });

  it("0079: las conexiones OIDC existentes confían en el correo sin email_verified y las sesiones SSO abiertas se recortan", async () => {
    const { readFileSync } = await import("node:fs");
    const t1 = await newTenant();
    const t2 = await newTenant();
    await db.query(`INSERT INTO sso_configs (tenant_id, enabled, protocol, oidc_issuer, session_ttl_hours) VALUES ($1, true, 'oidc', 'https://login.microsoftonline.com/x/v2.0', 8)`, [t1]);
    await db.query(`INSERT INTO sso_configs (tenant_id, enabled, protocol, saml_entry_point) VALUES ($1, true, 'saml', 'https://idp.test/sso')`, [t2]);
    const u = await newUser("mig-0079@empresa.test", { tenantId: t1, proven: true });
    await newSession(u, t1, "sso");
    const pwSession = await newSession(u, t1, "password");
    const sql = readFileSync(new URL("../migrations/0079_identity_sso_compat.sql", import.meta.url), "utf8");
    for (const stmt of sql.split(/;\s*$/m).map((x) => x.trim()).filter((x) => x && !/^(--[^\n]*\n?)*$/.test(x))) await db.query(stmt);
    expect((await db.one<any>(`SELECT oidc_trust_unverified_email FROM sso_configs WHERE tenant_id = $1`, [t1]))!.oidc_trust_unverified_email).toBe(true);
    expect((await db.one<any>(`SELECT oidc_trust_unverified_email FROM sso_configs WHERE tenant_id = $1`, [t2]))!.oidc_trust_unverified_email).toBe(false);
    const sso = await db.one<any>(`SELECT created_at, expires_at FROM sessions WHERE user_id = $1 AND auth_method = 'sso'`, [u]);
    expect(new Date(sso.expires_at).getTime() - new Date(sso.created_at).getTime()).toBeLessThanOrEqual(8 * 3600_000);
    const pwRow = await db.one<any>(`SELECT created_at, expires_at FROM sessions WHERE token_hash = $1`, [util.sha256Hex(pwSession)]);
    expect(new Date(pwRow.expires_at).getTime() - new Date(pwRow.created_at).getTime()).toBeGreaterThan(13 * 86400_000);
  });

  it("OIDC email_verified: solo true o \"true\"; si falta, según la opción de la conexión; false nunca", async () => {
    const { oidcEmailVerified } = await import("../src/modules/identity/sso");
    expect(oidcEmailVerified({ email_verified: true }, false)).toBe(true);
    expect(oidcEmailVerified({ email_verified: "true" }, false)).toBe(true);
    expect(oidcEmailVerified({}, false)).toBe(false);
    expect(oidcEmailVerified({ email_verified: "yes" }, false)).toBe(false);
    expect(oidcEmailVerified({ email_verified: 1 }, false)).toBe(false);
    expect(oidcEmailVerified({}, true)).toBe(true);
    expect(oidcEmailVerified({ email_verified: false }, true)).toBe(false);
    expect(oidcEmailVerified({ email_verified: "false" }, true)).toBe(false);
  });

  it("SAML: la misma Assertion no se acepta dos veces (hasta que vence)", async () => {
    const { rememberSamlAssertion, samlAssertionInfo } = await import("../src/modules/identity/sso");
    const nooa = new Date(Date.now() + 5 * 60_000).toISOString();
    const info = samlAssertionInfo({ getAssertion: () => ({ Assertion: { $: { ID: "_abc123" }, Conditions: [{ $: { NotOnOrAfter: nooa } }] } }) });
    expect(info.id).toBe("_abc123");
    expect(info.notOnOrAfter?.toISOString()).toBe(nooa);
    expect(samlAssertionInfo({ getAssertion: () => ({ Assertion: { $: {} } }) }).id).toBeNull();

    expect(await rememberSamlAssertion(db, tenant, "_abc123", info.notOnOrAfter)).toBe(true);
    expect(await rememberSamlAssertion(db, tenant, "_abc123", info.notOnOrAfter)).toBe(false);
    // Otra organización tiene su propio espacio de IDs.
    const other = await newTenant();
    expect(await rememberSamlAssertion(db, other, "_abc123", info.notOnOrAfter)).toBe(true);
    const row = await db.one<any>(`SELECT expires_at FROM saml_assertion_ids WHERE tenant_id = $1 AND assertion_id = '_abc123'`, [tenant]);
    expect(new Date(row.expires_at).getTime()).toBeGreaterThanOrEqual(Date.now() + 10 * 60_000);
    // Vencida: la fila ya no bloquea (y el barrido la borra).
    await db.query(`UPDATE saml_assertion_ids SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1`, [tenant]);
    expect(await rememberSamlAssertion(db, tenant, "_abc123", null)).toBe(true);
  });

  it("duración de sesiones SSO: por defecto 24 h, configurable por organización y acorta las abiertas", async () => {
    const { ssoSessionTtlHours } = await import("../src/modules/identity/sso");
    expect(ssoSessionTtlHours(null)).toBe(24);
    expect(ssoSessionTtlHours({ session_ttl_hours: 8 })).toBe(8);
    expect(ssoSessionTtlHours({ session_ttl_hours: 10_000 })).toBe(336);
    expect(ssoSessionTtlHours({ session_ttl_hours: 0 })).toBe(24);

    const t1 = await newTenant();
    const owner = await newUser("owner-sso@empresa.test", { tenantId: t1, role: "owner", proven: true });
    const cookie = await newSession(owner, t1);
    const member = await newUser("miembro-sso@empresa.test", { tenantId: t1, proven: true });
    await newSession(member, t1, "sso");
    const r = await app.inject({
      method: "PUT",
      url: "/v1/settings/sso",
      cookies: { cs_session: cookie },
      payload: {
        enabled: false,
        protocol: "oidc",
        sessionTtlHours: 8,
        oidc: { issuer: "https://idp.empresa.test", clientId: "abc", trustUnverifiedEmail: true },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sessionTtlHours: 8, oidc: { trustUnverifiedEmail: true } });
    const s = await db.one<any>(`SELECT created_at, expires_at FROM sessions WHERE user_id = $1`, [member]);
    expect(new Date(s.expires_at).getTime() - new Date(s.created_at).getTime()).toBeLessThanOrEqual(8 * 3600_000);
    // Omitidos: se conservan.
    const r2 = await app.inject({ method: "PUT", url: "/v1/settings/sso", cookies: { cs_session: cookie }, payload: { enabled: false, protocol: "oidc" } });
    expect(r2.json()).toMatchObject({ sessionTtlHours: 8, oidc: { trustUnverifiedEmail: true } });
    // Fuera de rango: 400.
    const bad = await app.inject({ method: "PUT", url: "/v1/settings/sso", cookies: { cs_session: cookie }, payload: { enabled: false, protocol: "oidc", sessionTtlHours: 400 } });
    expect(bad.statusCode).toBe(400);
  });
});
