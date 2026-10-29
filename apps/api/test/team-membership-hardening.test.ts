// Equipos (app real sobre PGlite): bajar a un propietario revoca sus invitaciones, encabezado x-calasign-tenant
// (pestañas en otra organización), bajas desde la consola que SSO (JIT) y SCIM respetan, aceptar una invitación sin
// dejar cuentas sueltas, login/signup de una cuenta sin organizaciones, JIT/SCIM que aceptan la invitación pendiente
// con su rol y cambio de correo por SCIM que invalida los links de restablecimiento. El IdP OIDC se simula
// interceptando safeRequest.
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-team-hardening-"));
delete process.env.DATABASE_URL;

const ISSUER = "https://idp.team-hardening.test";
const CLIENT_ID = "calasign-client";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", use: "sig", alg: "RS256" };
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

const ORIGIN = "http://localhost:5173";
const H = (session: string, extra: Record<string, string> = {}) => ({ cookie: `cs_session=${session}`, origin: ORIGIN, ...extra });

async function session(userId: string, tenantId: string) {
  const token = util.randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1,$2,$3, now() + interval '14 days', 'password')`,
    [util.sha256Hex(token), userId, tenantId],
  );
  return token;
}

async function user(email: string, passwordHash = "scrypt$x") {
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [id, email, email.split("@")[0], passwordHash]);
  return id;
}

async function member(tenantId: string, email: string, role = "member") {
  const id = await user(email);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenantId, id, role]);
  return id;
}

/** Organización con propietario (y su sesión), dominio verificado, SSO OIDC con JIT y un token SCIM. */
async function org(domain: string, plan = "enterprise") {
  const id = util.uuidv7();
  const slug = `t-${id.slice(-8)}`;
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', $3)`, [id, slug, plan]);
  const ownerId = await member(id, `owner@${domain}`, "owner");
  const ownerSession = await session(ownerId, id);
  await db.query(`INSERT INTO sso_domains (domain, tenant_id, verification_token, verified_at) VALUES ($1, $2, 'tok', now())`, [domain, id]);
  await db.query(
    `INSERT INTO sso_configs (tenant_id, enabled, protocol, jit_enabled, jit_role, oidc_issuer, oidc_client_id, oidc_client_secret_enc)
     VALUES ($1, true, 'oidc', true, 'member', $2, $3, $4)`,
    [id, ISSUER, CLIENT_ID, util.encrypt("secreto")],
  );
  const scim = `cs_scim_${util.randomToken(32)}`;
  await db.query(`INSERT INTO scim_tokens (id, tenant_id, name, prefix, token_hash) VALUES ($1,$2,'idp','cs_scim_test',$3)`, [
    util.uuidv7(),
    id,
    util.sha256Hex(scim),
  ]);
  return { id, slug, ownerId, ownerSession, scimHeaders: { authorization: `Bearer ${scim}`, "content-type": "application/scim+json" } };
}

async function invite(tenantId: string, email: string, role: string, invitedBy: string | null = null) {
  const id = util.uuidv7();
  const token = util.randomToken();
  await db.query(
    `INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '7 days')`,
    [id, tenantId, email, role, util.sha256Hex(token), invitedBy],
  );
  return { id, token };
}

async function ssoLogin(slug: string, email: string) {
  const start = await app.inject({ method: "GET", url: `/v1/auth/sso/start?org=${slug}` });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get("state")!;
  idp.email = email;
  idp.nonce = loc.searchParams.get("nonce")!;
  return app.inject({ method: "GET", url: `/v1/auth/sso/oidc/callback?code=c0de&state=${state}`, cookies: { cs_sso_state: state } });
}

const membership = (tenantId: string, userId: string) =>
  db.one<any>(`SELECT role, role_id FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
const userByEmail = (email: string) => db.one<any>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);

describe("propietario → administrador", () => {
  it("revoca la invitación de propietario que mandó (no recupera la propiedad aceptándola)", async () => {
    const o = await org("demote.test");
    const second = await member(o.id, "segunda@demote.test", "owner");
    const inv = await invite(o.id, "segunda+alt@otro.test", "owner", second);
    const r = await app.inject({ method: "PATCH", url: `/v1/members/${second}`, headers: H(o.ownerSession), payload: { role: "admin" } });
    expect(r.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT revoked_at FROM invitations WHERE id = $1`, [inv.id]))!.revoked_at).not.toBeNull();
    const accept = await app.inject({
      method: "POST",
      url: `/v1/invite/${inv.token}/accept`,
      payload: { name: "Alt", password: "una-clave-larga-123" },
    });
    expect(accept.statusCode).toBe(410);
  });
});

describe("x-calasign-tenant", () => {
  it("rechaza con 409 tenant_mismatch un pedido de una pestaña que quedó en otra organización (solo sesiones web)", async () => {
    const o = await org("tabs.test");
    const other = util.uuidv7();
    const ok = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: H(o.ownerSession, { "x-calasign-tenant": o.id }),
      payload: { name: "Pestaña ok", permissions: [] },
    });
    expect(ok.statusCode).toBe(201);
    const stale = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: H(o.ownerSession, { "x-calasign-tenant": other }),
      payload: { name: "Pestaña vieja", permissions: [] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("tenant_mismatch");
    expect(await db.one(`SELECT 1 FROM roles WHERE tenant_id = $1 AND name = 'Pestaña vieja'`, [o.id])).toBeNull();
    // Sin encabezado (otros clientes) y las lecturas: como siempre.
    expect(
      (await app.inject({ method: "POST", url: "/v1/roles", headers: H(o.ownerSession), payload: { name: "Sin encabezado", permissions: [] } }))
        .statusCode,
    ).toBe(201);
    expect((await app.inject({ method: "GET", url: "/v1/roles", headers: H(o.ownerSession, { "x-calasign-tenant": other }) })).statusCode).toBe(200);
    // Una API key define su organización: el encabezado se ignora.
    const key = await app.inject({ method: "POST", url: "/v1/api-keys", headers: H(o.ownerSession), payload: { name: "integración" } });
    expect(key.statusCode).toBe(201);
    const byKey = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: { authorization: `Bearer ${key.json().secret}`, "x-calasign-tenant": other },
      payload: { name: "Por API", permissions: [] },
    });
    expect(byKey.statusCode).toBe(201);
    // Otra cuenta en la misma cookie (x-calasign-user distinto): también 409.
    const otherUser = await app.inject({
      method: "POST",
      url: "/v1/roles",
      headers: H(o.ownerSession, { "x-calasign-tenant": o.id, "x-calasign-user": util.uuidv7() }),
      payload: { name: "Otra cuenta", permissions: [] },
    });
    expect(otherUser.statusCode).toBe(409);
    expect(otherUser.json().error.code).toBe("tenant_mismatch");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/roles",
          headers: H(o.ownerSession, { "x-calasign-tenant": o.id, "x-calasign-user": o.ownerId }),
          payload: { name: "Misma cuenta", permissions: [] },
        })
      ).statusCode,
    ).toBe(201);
    // Rutas públicas (firmante): no pasan por authenticate(), el encabezado no aplica.
    const pub = await app.inject({
      method: "POST",
      url: `/v1/signing/${util.randomToken()}/otp/send`,
      headers: H(o.ownerSession, { "x-calasign-tenant": other }),
      payload: {},
    });
    expect(pub.json()?.error?.code).not.toBe("tenant_mismatch");
    // Cerrar sesión siempre se puede.
    const extra = await session(o.ownerId, o.id);
    expect((await app.inject({ method: "POST", url: "/v1/auth/logout", headers: H(extra, { "x-calasign-tenant": other }) })).statusCode).toBe(204);
  });
});

describe("baja desde la consola", () => {
  it("SSO (JIT) y SCIM no vuelven a sumar a quien quitaron; una invitación nueva sí (con su rol)", async () => {
    const o = await org("baja.test");
    const email = "quitada@baja.test";
    const uid = await member(o.id, email);
    expect((await app.inject({ method: "DELETE", url: `/v1/members/${uid}`, headers: H(o.ownerSession) })).statusCode).toBe(204);
    expect(await db.one(`SELECT 1 FROM member_removals WHERE tenant_id = $1 AND user_id = $2`, [o.id, uid])).not.toBeNull();

    const jit = await ssoLogin(o.slug, email);
    expect(jit.statusCode).toBe(302);
    expect(jit.headers.location).toBe("/login?sso_error=sso_member_removed");
    expect(await membership(o.id, uid)).toBeNull();

    const scim = await app.inject({ method: "POST", url: "/scim/v2/Users", headers: o.scimHeaders, payload: { userName: email, active: true } });
    expect(scim.statusCode).toBe(403);
    expect(await membership(o.id, uid)).toBeNull();
    expect(await db.one(`SELECT 1 FROM scim_users WHERE tenant_id = $1 AND user_id = $2`, [o.id, uid])).toBeNull();

    // Invitada de nuevo: el JIT acepta la invitación con su rol y la baja deja de valer.
    const inv = await invite(o.id, email, "admin", o.ownerId);
    const again = await ssoLogin(o.slug, email);
    expect(again.headers.location).toBe("/app");
    expect(await membership(o.id, uid)).toMatchObject({ role: "admin" });
    expect((await db.one<any>(`SELECT accepted_at, accepted_by FROM invitations WHERE id = $1`, [inv.id]))!.accepted_by).toBe(uid);
    expect(await db.one(`SELECT 1 FROM member_removals WHERE tenant_id = $1 AND user_id = $2`, [o.id, uid])).toBeNull();
  });

  it("salir por cuenta propia no deja una baja que bloquee el JIT", async () => {
    const o = await org("sale.test");
    const uid = await member(o.id, "sale@sale.test");
    const own = await session(uid, o.id);
    expect((await app.inject({ method: "DELETE", url: `/v1/members/${uid}`, headers: H(own) })).statusCode).toBe(204);
    expect(await db.one(`SELECT 1 FROM member_removals WHERE tenant_id = $1 AND user_id = $2`, [o.id, uid])).toBeNull();
    expect((await ssoLogin(o.slug, "sale@sale.test")).headers.location).toBe("/app");
    expect(await membership(o.id, uid)).not.toBeNull();
  });

  it("aceptar una invitación por el link también borra la baja", async () => {
    const o = await org("baja2.test");
    const pw = "una-clave-larga-123";
    const uid = await user("vuelve@baja2.test", await util.hashPassword(pw));
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'member')`, [o.id, uid]);
    expect((await app.inject({ method: "DELETE", url: `/v1/members/${uid}`, headers: H(o.ownerSession) })).statusCode).toBe(204);
    const inv = await invite(o.id, "vuelve@baja2.test", "member", o.ownerId);
    const r = await app.inject({ method: "POST", url: `/v1/invite/${inv.token}/accept`, payload: { password: pw } });
    expect(r.statusCode).toBe(200);
    expect(await db.one(`SELECT 1 FROM member_removals WHERE tenant_id = $1 AND user_id = $2`, [o.id, uid])).toBeNull();
  });
});

describe("JIT / SCIM con una invitación pendiente", () => {
  it("una invitación como propietaria entra como administradora por JIT o SCIM", async () => {
    const o = await org("jitowner.test");
    await invite(o.id, "duena@jitowner.test", "owner", o.ownerId);
    expect((await ssoLogin(o.slug, "duena@jitowner.test")).headers.location).toBe("/app");
    const u = await userByEmail("duena@jitowner.test");
    expect(await membership(o.id, u!.id)).toMatchObject({ role: "admin" });
    await invite(o.id, "duena2@jitowner.test", "owner", o.ownerId);
    const r = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: o.scimHeaders,
      payload: { userName: "duena2@jitowner.test", active: true },
    });
    expect(r.statusCode).toBe(201);
    expect(await membership(o.id, r.json().id)).toMatchObject({ role: "admin" });
  });

  it("JIT: entra con el rol de la invitación y su invitación no cuenta como un lugar más del plan", async () => {
    // Starter: 3 usuarios. Propietario + un miembro + la invitación de la persona = 3.
    const o = await org("jitinv.test", "starter");
    await member(o.id, "otro@jitinv.test");
    const inv = await invite(o.id, "invitada@jitinv.test", "admin", o.ownerId);
    const r = await ssoLogin(o.slug, "invitada@jitinv.test");
    expect(r.headers.location).toBe("/app");
    const u = await userByEmail("invitada@jitinv.test");
    expect(await membership(o.id, u!.id)).toMatchObject({ role: "admin" });
    expect(await db.one<any>(`SELECT accepted_at, revoked_at FROM invitations WHERE id = $1`, [inv.id])).toMatchObject({ revoked_at: null });
    expect((await db.one<any>(`SELECT accepted_at FROM invitations WHERE id = $1`, [inv.id]))!.accepted_at).not.toBeNull();
    // Cupo lleno: otra persona sin invitación no entra.
    const full = await ssoLogin(o.slug, "sin-invitacion@jitinv.test");
    expect(full.headers.location).toBe("/login?sso_error=sso_plan_limit");
  });

  it("SCIM: el alta acepta la invitación pendiente con su rol y no la cuenta como lugar extra", async () => {
    const o = await org("scimin.test", "starter");
    await member(o.id, "otro@scimin.test");
    const inv = await invite(o.id, "prov@scimin.test", "admin", o.ownerId);
    const r = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: o.scimHeaders,
      payload: { userName: "prov@scimin.test", active: true },
    });
    expect(r.statusCode).toBe(201);
    expect(await membership(o.id, r.json().id)).toMatchObject({ role: "admin" });
    expect((await db.one<any>(`SELECT accepted_by FROM invitations WHERE id = $1`, [inv.id]))!.accepted_by).toBe(r.json().id);
  });
});

describe("aceptar una invitación sin dejar cuentas sueltas", () => {
  it("si la aceptación falla (cupo del plan), no se crea la cuenta", async () => {
    const o = await org("orphan.test", "starter");
    await member(o.id, "a@orphan.test");
    await member(o.id, "b@orphan.test");
    const inv = await invite(o.id, "nueva@orphan.test", "member", o.ownerId);
    const r = await app.inject({
      method: "POST",
      url: `/v1/invite/${inv.token}/accept`,
      payload: { name: "Nueva", password: "una-clave-larga-123" },
    });
    expect(r.statusCode).toBe(402);
    expect(await userByEmail("nueva@orphan.test")).toBeNull();
  });

  it("dos aceptaciones simultáneas que crean la misma cuenta: una entra, la otra no es un 500", async () => {
    const o = await org("race.test");
    const inv = await invite(o.id, "doble@race.test", "member", o.ownerId);
    const payload = { name: "Doble", password: "una-clave-larga-123" };
    const rs = await Promise.all([
      app.inject({ method: "POST", url: `/v1/invite/${inv.token}/accept`, payload }),
      app.inject({ method: "POST", url: `/v1/invite/${inv.token}/accept`, payload }),
    ]);
    const codes = rs.map((r) => r.statusCode).sort();
    expect(codes).not.toContain(500);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(Number((await db.one<any>(`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'doble@race.test'`))!.n)).toBe(1);
  });

  it("cuenta sin organizaciones: el login dice no_organization y el signup con su contraseña le crea una", async () => {
    const pw = "una-clave-larga-123";
    const uid = await user("suelta@solo.test", await util.hashPassword(pw));
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "suelta@solo.test", password: pw } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error.code).toBe("no_organization");
    const bad = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "suelta@solo.test", password: "otra-clave-larga-123" } });
    expect(bad.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "suelta@solo.test", password: "otra-clave-larga-123", name: "X", organization: "Org X" },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe("email_taken");
    const ok = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "suelta@solo.test", password: pw, name: "X", organization: "Org Nueva" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user.id).toBe(uid);
    expect(await membership(ok.json().tenant.id, uid)).toMatchObject({ role: "owner" });
    // Ya con organización: un signup más es email_taken aunque la contraseña sea la suya.
    const twice = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email: "suelta@solo.test", password: pw, name: "X", organization: "Otra" },
    });
    expect(twice.statusCode).toBe(409);
  });
});

describe("signup con un correo existente", () => {
  it("no cuenta intentos en cuentas con organizaciones; una cuenta sin organizaciones bloqueada responde email_taken", async () => {
    const o = await org("signup-lock.test");
    const signup = (email: string, password: string) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/signup",
        payload: { email, password, name: "X", organization: "Org" },
        remoteAddress: `203.0.113.${Math.floor(Math.random() * 200) + 1}`,
      });
    const taken = await signup(`owner@signup-lock.test`, "otra-clave-larga-123");
    expect(taken.json().error.code).toBe("email_taken");
    expect(await db.one(`SELECT 1 FROM login_attempts WHERE user_id = $1`, [o.ownerId])).toBeNull();

    const pw = "una-clave-larga-123";
    const uid = await user("bloqueada@signup-lock.test", await util.hashPassword(pw));
    await db.query(`INSERT INTO login_attempts (user_id, window_start, n) VALUES ($1, now(), 1000)`, [uid]);
    const locked = await signup("bloqueada@signup-lock.test", "otra-clave-larga-123");
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error.code).toBe("email_taken");
    // Ni con la contraseña correcta mientras dura el bloqueo.
    expect((await signup("bloqueada@signup-lock.test", pw)).json().error.code).toBe("email_taken");
  });

  it("login sin organizaciones con 2FA: el aviso pide una invitación", async () => {
    const pw = "una-clave-larga-123";
    const uid = await user("suelta2fa@solo.test", await util.hashPassword(pw));
    await db.query(`UPDATE users SET totp_enabled_at = now() WHERE id = $1`, [uid]);
    const r = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "suelta2fa@solo.test", password: pw } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatchObject({ code: "no_organization", details: { twoFactor: true } });
    expect(r.json().error.message).toContain("invit");
  });
});

describe("SCIM: cambio de correo", () => {
  it("invalida los links de restablecimiento de contraseña pendientes", async () => {
    const o = await org("mail.test");
    const created = await app.inject({
      method: "POST",
      url: "/scim/v2/Users",
      headers: o.scimHeaders,
      payload: { userName: "antes@mail.test", active: true },
    });
    expect(created.statusCode).toBe(201);
    const uid = created.json().id as string;
    const reset = util.sha256Hex(util.randomToken());
    await db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [reset, uid]);
    const r = await app.inject({
      method: "PATCH",
      url: `/scim/v2/Users/${uid}`,
      headers: o.scimHeaders,
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "userName", value: "despues@mail.test" }],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().userName).toBe("despues@mail.test");
    expect((await db.one<any>(`SELECT used_at FROM password_resets WHERE token_hash = $1`, [reset]))!.used_at).not.toBeNull();
  });
});
