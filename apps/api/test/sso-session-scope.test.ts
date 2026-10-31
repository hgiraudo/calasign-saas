// Alcance de una sesión SSO y control de Origin (pentest white-box del 31-Oct-2026, app real sobre PGlite):
//  - Una sesión SSO vale sólo en su organización: el IdP de A, que puede afirmar el correo de un miembro, no ve ni
//    cierra las sesiones de esa persona en B ni revoca sus apps OAuth de B (como ya hacía /v1/me/access).
//  - "Authorization: Basic …" no saltea el control de Origin: authenticate usa la cookie igual.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-sso-scope-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
const ORIGIN = { origin: "http://localhost:5173" };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function tenant(slug: string) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1,$2,$2,'enterprise')`, [id, slug]);
  return id;
}

async function session(userId: string, tenantId: string, method: "password" | "sso") {
  const token = util.randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method, sso_tenant_id, ip, user_agent, authenticated_at, last_seen_at)
     VALUES ($1,$2,$3, now() + interval '1 day', $4, $5, '203.0.113.77', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', now(), now())`,
    [util.sha256Hex(token), userId, tenantId, method, method === "sso" ? tenantId : null],
  );
  return token;
}

async function memberOfBoth(email: string) {
  const a = await tenant(`a-${email.split("@")[0]}`);
  const b = await tenant(`b-${email.split("@")[0]}`);
  await db.query(`INSERT INTO sso_configs (tenant_id, enabled, protocol) VALUES ($1, true, 'oidc')`, [a]);
  const u = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Ana','scrypt$x')`, [u, email]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'member'), ($3,$2,'member')`, [a, u, b]);
  return { a, b, u, ssoA: await session(u, a, "sso"), pwB: await session(u, b, "password") };
}

describe("sesión SSO: alcance de su organización", () => {
  it("/v1/me/sessions no lista las sesiones de la otra organización", async () => {
    const { ssoA, pwB } = await memberOfBoth("ana1@example.com");
    const fromSso = await app.inject({ method: "GET", url: "/v1/me/sessions", cookies: { cs_session: ssoA } });
    expect(fromSso.statusCode).toBe(200);
    expect(fromSso.json().items).toHaveLength(1);
    expect(fromSso.json().items[0].current).toBe(true);
    // Con contraseña, la cuenta entera (las dos).
    const fromPw = await app.inject({ method: "GET", url: "/v1/me/sessions", cookies: { cs_session: pwB } });
    expect(fromPw.json().items).toHaveLength(2);
  });

  it("DELETE /v1/me/sessions/:id de otra organización da 404 y la sesión sigue", async () => {
    const { ssoA, pwB } = await memberOfBoth("ana2@example.com");
    const other = await db.one<{ id: string }>(`SELECT id FROM sessions WHERE token_hash = $1`, [util.sha256Hex(pwB)]);
    const res = await app.inject({ method: "DELETE", url: `/v1/me/sessions/${other!.id}`, cookies: { cs_session: ssoA }, headers: ORIGIN });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { cs_session: pwB } })).statusCode).toBe(200);
  });

  it("logout-all desde SSO cierra sólo lo de su organización (sesiones y tokens OAuth)", async () => {
    const { a, b, u, ssoA, pwB } = await memberOfBoth("ana3@example.com");
    const client = util.uuidv7();
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris, grant_types, scopes)
       VALUES ($1,$2,$3,'App',ARRAY['https://app.example.com/cb'],ARRAY['authorization_code'],ARRAY['envelopes:read'])`,
      [client, b, `cli_${client}`],
    );
    const tokB = util.uuidv7();
    await db.query(
      `INSERT INTO oauth_tokens (id, token_hash, kind, client_id, tenant_id, user_id, scopes, family_id, expires_at)
       VALUES ($1,$2,'access',$3,$4,$5,ARRAY['envelopes:read'],$1, now() + interval '1 hour')`,
      [tokB, util.sha256Hex(util.randomToken()), client, b, u],
    );
    const res = await app.inject({ method: "POST", url: "/v1/auth/logout-all", cookies: { cs_session: ssoA }, headers: ORIGIN });
    expect(res.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { cs_session: ssoA } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { cs_session: pwB } })).statusCode).toBe(200);
    const t = await db.one<{ revoked_at: Date | null }>(`SELECT revoked_at FROM oauth_tokens WHERE id = $1`, [tokB]);
    expect(t!.revoked_at).toBeNull();
    // La auditoría queda sólo en A (no le avisa a B que la persona usa SSO en otra organización).
    const audit = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM account_audit_log WHERE action = 'auth.logout_all' AND actor_id = $1`,
      [u],
    );
    expect(audit.map((r) => r.tenant_id)).toEqual([a]);
  });
});

describe("control de Origin", () => {
  it("Authorization que no es Bearer no saltea el control (la cookie se usaría igual)", async () => {
    const t = await tenant("org-origin");
    const u = util.uuidv7();
    await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,'duena@origin.test','Dueña','scrypt$x')`, [u]);
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [t, u]);
    const ck = await session(u, t, "password");
    const evil = { origin: "https://evil.example" };
    for (const authorization of [undefined, "Basic Zm9vOmJhcg==", "Bearer "]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/api-keys",
        cookies: { cs_session: ck },
        headers: authorization ? { ...evil, authorization } : evil,
        payload: { name: "x" },
      });
      expect(res.statusCode, String(authorization)).toBe(403);
      expect(res.json().error.code).toBe("bad_origin");
    }
  });
});
