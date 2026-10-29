// Vincular una cuenta YA existente por SSO (JIT) o SCIM, y suspenderla / reactivarla por SCIM, no borra su 2FA ni sus
// sesiones o tokens de otras organizaciones (se quitó la limpieza automática de cuentas "no probadas": ver
// docs/ARQUITECTURA.md, "Cuentas pre-registradas con un correo ajeno"). La membresía nueva queda con
// password_allowed = false. App real sobre PGlite; el IdP OIDC se simula interceptando safeRequest.
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-identity-link-"));
delete process.env.DATABASE_URL;

const ISSUER = "https://idp.link.test";
const CLIENT_ID = "calasign-client";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", use: "sig", alg: "RS256" };
/** Lo que el IdP simulado firma en el próximo id_token (email y nonce). */
const idp = { email: "", nonce: "" };

function idToken() {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: idp.email,
    email: idp.email,
    email_verified: true,
    nonce: idp.nonce,
    iat: now,
    exp: now + 300,
  });
  return `${head}.${body}.${cryptoSign("sha256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

vi.mock("../src/modules/webhooks", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/modules/webhooks")>();
  const json = (o: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(o)) });
  return {
    ...orig,
    safeRequest: async (url: string) => {
      if (url === `${ISSUER}/.well-known/openid-configuration`)
        return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
      if (url === `${ISSUER}/jwks`) return json({ keys: [jwk] });
      if (url === `${ISSUER}/token`) return json({ id_token: idToken(), token_type: "Bearer" });
      throw new Error(`safeRequest inesperado: ${url}`);
    },
  };
});

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let tenant = "";
let slug = "";
const SCIM = "cs_scim_test_identity_link_keeps_00000000000";
const scimHeaders = { authorization: `Bearer ${SCIM}`, "content-type": "application/scim+json" };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = await newTenant();
  slug = (await db.one<any>(`SELECT slug FROM tenants WHERE id = $1`, [tenant]))!.slug;
  await db.query(`INSERT INTO sso_domains (domain, tenant_id, verification_token, verified_at) VALUES ('link.test', $1, 'tok', now())`, [tenant]);
  await db.query(`INSERT INTO scim_tokens (id, tenant_id, name, prefix, token_hash) VALUES ($1,$2,'idp','cs_scim_test',$3)`, [
    util.uuidv7(),
    tenant,
    util.sha256Hex(SCIM),
  ]);
  await db.query(
    `INSERT INTO sso_configs (tenant_id, enabled, protocol, jit_enabled, jit_role, oidc_issuer, oidc_client_id, oidc_client_secret_enc)
     VALUES ($1, true, 'oidc', true, 'member', $2, $3, $4)`,
    [tenant, ISSUER, CLIENT_ID, util.encrypt("secreto")],
  );
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

/** Cuenta registrada con contraseña (sin prueba del correo), 2FA activa, miembro de su organización propia con una sesión. */
async function existingAccount(email: string) {
  const own = await newTenant();
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Ana','scrypt$x')`, [id, email]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [own, id]);
  await db.query(`UPDATE users SET totp_secret_enc = 'x', totp_enabled_at = now(), totp_recovery_hashes = '{h}' WHERE id = $1`, [id]);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1,$2,$3, now() + interval '14 days', 'password')`,
    [util.sha256Hex(util.randomToken()), id, own],
  );
  return { id, own };
}

const totpOn = async (userId: string) => Boolean((await db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [userId]))!.totp_enabled_at);
const sessionsIn = async (userId: string, tenantId: string) =>
  Number((await db.one<any>(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND tenant_id = $2`, [userId, tenantId]))!.n);
const membership = (userId: string) =>
  db.one<any>(`SELECT role, password_allowed FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenant, userId]);

async function ssoLogin(email: string) {
  const start = await app.inject({ method: "GET", url: `/v1/auth/sso/start?org=${slug}` });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get("state")!;
  idp.email = email;
  idp.nonce = loc.searchParams.get("nonce")!;
  return app.inject({ method: "GET", url: `/v1/auth/sso/oidc/callback?code=c0de&state=${state}`, cookies: { cs_sso_state: state } });
}

describe("vincular una cuenta existente no toca su 2FA ni sus sesiones", () => {
  it("SSO (JIT): crea la membresía sin contraseña, abre la sesión SSO y conserva la 2FA y la sesión de la otra organización", async () => {
    const u = await existingAccount("jit@link.test");
    const r = await ssoLogin("jit@link.test");
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe("/app");
    expect(await membership(u.id)).toMatchObject({ role: "member", password_allowed: false });
    expect(await totpOn(u.id)).toBe(true);
    expect(await sessionsIn(u.id, u.own)).toBe(1);
    expect(await sessionsIn(u.id, tenant)).toBe(1);
    const audit = await db.one<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'member.jit_provisioned' AND target_id = $2`,
      [tenant, u.id],
    );
    expect(audit.data).toEqual({ email: "jit@link.test", role: "member" });
    // Un segundo SSO sigue funcionando.
    expect((await ssoLogin("jit@link.test")).headers.location).toBe("/app");
  });

  it("SCIM POST: vincula sin borrar la 2FA ni las sesiones; la auditoría no lleva unprovenAccountSecured", async () => {
    const u = await existingAccount("scim@link.test");
    const r = await app.inject({ method: "POST", url: "/scim/v2/Users", headers: scimHeaders, payload: { userName: "scim@link.test" } });
    expect(r.statusCode).toBe(201);
    expect(await membership(u.id)).toMatchObject({ password_allowed: false });
    expect(await totpOn(u.id)).toBe(true);
    expect(await sessionsIn(u.id, u.own)).toBe(1);
    const audit = await db.one<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'member.scim_provisioned' AND target_id = $2`,
      [tenant, u.id],
    );
    expect(audit.data).toEqual({ email: "scim@link.test", active: true });
  });

  it("SCIM: suspender y reactivar (PATCH y PUT) no borra la 2FA ni las sesiones de otras organizaciones", async () => {
    for (const method of ["PATCH", "PUT"] as const) {
      const email = `susp-${method.toLowerCase()}@link.test`;
      const u = await existingAccount(email);
      expect((await app.inject({ method: "POST", url: "/scim/v2/Users", headers: scimHeaders, payload: { userName: email } })).statusCode).toBe(201);
      const setActive = (active: boolean) =>
        method === "PATCH"
          ? app.inject({
              method: "PATCH",
              url: `/scim/v2/Users/${u.id}`,
              headers: scimHeaders,
              payload: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: active }] },
            })
          : app.inject({ method: "PUT", url: `/scim/v2/Users/${u.id}`, headers: scimHeaders, payload: { userName: email, active } });
      expect((await setActive(false)).statusCode).toBe(200);
      expect(await membership(u.id)).toBeNull();
      expect((await setActive(true)).statusCode).toBe(200);
      expect(await membership(u.id)).not.toBeNull();
      expect(await totpOn(u.id)).toBe(true);
      expect(await sessionsIn(u.id, u.own)).toBe(1);
    }
  });

  it("SCIM: borrar (DELETE) y volver a crear no borra la 2FA", async () => {
    const u = await existingAccount("re@link.test");
    expect(
      (await app.inject({ method: "POST", url: "/scim/v2/Users", headers: scimHeaders, payload: { userName: "re@link.test" } })).statusCode,
    ).toBe(201);
    expect((await app.inject({ method: "DELETE", url: `/scim/v2/Users/${u.id}`, headers: scimHeaders })).statusCode).toBe(204);
    expect(
      (await app.inject({ method: "POST", url: "/scim/v2/Users", headers: scimHeaders, payload: { userName: "re@link.test" } })).statusCode,
    ).toBe(201);
    expect(await totpOn(u.id)).toBe(true);
    expect(await sessionsIn(u.id, u.own)).toBe(1);
  });
});
