// Autenticación del personal (app real sobre PGlite): re-autenticación de la 2FA, avisos de seguridad al correo,
// bloqueo por (cuenta, red) con techo global y cupo propio del segundo paso, "olvidé mi contraseña" por red, sesiones
// (recordarme, inactividad, listado, cierre y cerrar todas), refresh OAuth con scope más chico y contraseñas débiles.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-staff-auth-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let totp: typeof import("../src/lib/totp");

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  totp = await import("../src/lib/totp");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const PW = "un-pasaje-largo-y-raro-42";
let seq = 0;

async function newTenant() {
  const id = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', 'enterprise')`, [id, `t-${id.slice(-8)}`]);
  return id;
}
async function newUser(tenantId: string | null, opts: { password?: string | null } = {}) {
  const id = util.uuidv7();
  const email = `persona${++seq}-${id.slice(-6)}@empresa.test`;
  const hash = opts.password === null ? "sso-only" : await util.hashPassword(opts.password ?? PW);
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Ana',$3)`, [id, email, hash]);
  if (tenantId) await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenantId, id]);
  return { id, email };
}
async function newSession(userId: string, tenantId: string, opts: { authenticatedAgo?: string; remember?: boolean; lastSeenAgo?: string } = {}) {
  const token = util.randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method, authenticated_at, remember, last_seen_at, ip, user_agent)
     VALUES ($1,$2,$3, now() + interval '14 days', 'password', now() - $4::interval, $5, now() - $6::interval, '203.0.113.77',
             'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0')`,
    [util.sha256Hex(token), userId, tenantId, opts.authenticatedAgo ?? "0 minutes", opts.remember ?? true, opts.lastSeenAgo ?? "0 minutes"],
  );
  return token;
}
const jobsOf = (userId: string, kind: string) =>
  db.query<any>(`SELECT payload FROM jobs WHERE queue = 'notify' AND payload->>'kind' = $1 AND payload->>'userId' = $2`, [kind, userId]);
const login = (email: string, password: string, ip: string, extra: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password, ...extra }, remoteAddress: ip });

describe("2FA: re-autenticación y avisos", () => {
  it("setup/enable/recovery-codes piden la contraseña o un ingreso reciente; los cambios encolan avisos", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const stale = await newSession(u.id, t, { authenticatedAgo: "2 hours" });
    const cookies = { cs_session: stale };

    const none = await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies });
    expect(none.statusCode).toBe(403);
    expect(none.json().error).toMatchObject({ code: "reauth_required", details: { password: true } });
    const bad = await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies, payload: { password: "otra-cosa-cualquiera" } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("invalid_password");

    const ok = await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies, payload: { password: PW } });
    expect(ok.statusCode).toBe(200);
    const secret = util.decrypt((await db.one<any>(`SELECT totp_pending_enc FROM users WHERE id = $1`, [u.id]))!.totp_pending_enc);
    const noPw = await app.inject({ method: "POST", url: "/v1/me/2fa/enable", cookies, payload: { code: totp.totpAt(secret, totp.currentStep()) } });
    expect(noPw.json().error.code).toBe("reauth_required");
    expect((await db.one<any>(`SELECT totp_enabled_at FROM users WHERE id = $1`, [u.id]))!.totp_enabled_at).toBeNull();
    const en = await app.inject({
      method: "POST",
      url: "/v1/me/2fa/enable",
      cookies,
      payload: { code: totp.totpAt(secret, totp.currentStep()), password: PW },
    });
    expect(en.statusCode).toBe(200);
    expect(await jobsOf(u.id, "2fa_enabled")).toHaveLength(1);

    // Regenerar: sin re-autenticación no gasta el código; con la contraseña, sí y avisa.
    const code = totp.totpAt(secret, totp.currentStep() + 1);
    expect((await app.inject({ method: "POST", url: "/v1/me/2fa/recovery-codes", cookies, payload: { code } })).json().error.code).toBe(
      "reauth_required",
    );
    const regen = await app.inject({ method: "POST", url: "/v1/me/2fa/recovery-codes", cookies, payload: { code, password: PW } });
    expect(regen.statusCode).toBe(200);
    expect(await jobsOf(u.id, "2fa_recovery_regenerated")).toHaveLength(1);

    const dis = await app.inject({ method: "POST", url: "/v1/me/2fa/disable", cookies, payload: { code: regen.json().recoveryCodes[0] } });
    expect(dis.statusCode).toBe(200);
    const [job] = await jobsOf(u.id, "2fa_disabled");
    expect(job.payload).toMatchObject({ kind: "2fa_disabled", userId: u.id });
  });

  it("cuenta sin contraseña (solo SSO): vale un ingreso reciente; si no, reauth_required sin pedir contraseña", async () => {
    const t = await newTenant();
    const u = await newUser(t, { password: null });
    const stale = await newSession(u.id, t, { authenticatedAgo: "11 minutes" });
    const r = await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies: { cs_session: stale }, payload: { password: "lo-que-sea-123" } });
    expect(r.json().error).toMatchObject({ code: "reauth_required", details: { password: false } });
    const fresh = await newSession(u.id, t, { authenticatedAgo: "1 minute" });
    expect((await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies: { cs_session: fresh } })).statusCode).toBe(200);
  });

  it("los avisos de seguridad tienen texto en los tres idiomas", async () => {
    const { render } = await import("../src/notifications/templates");
    for (const kind of ["password_changed", "2fa_enabled", "2fa_disabled", "2fa_recovery_regenerated"] as const) {
      for (const loc of ["es", "pt-BR", "en"]) {
        const m = render(kind, loc, {
          recipientName: "Ana",
          senderName: "CalaSign",
          organizationName: "CalaSign",
          subject: "x",
          date: "1 de enero",
          detail: "203.0.113.0/24",
          link: "https://x.test",
        });
        expect(m.text).toContain("203.0.113.0/24");
      }
    }
  });
});

describe("restablecer la contraseña", () => {
  it("rechaza contraseñas débiles y, al cambiarla, encola el aviso", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const forgot = await app.inject({ method: "POST", url: "/v1/auth/password/forgot", payload: { email: u.email }, remoteAddress: "198.51.100.10" });
    expect(forgot.statusCode).toBe(202);
    const token = util.randomToken();
    await db.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1`, [u.id]);
    await db.query(`INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '30 minutes')`, [
      util.sha256Hex(token),
      u.id,
    ]);
    const weak = await app.inject({ method: "POST", url: "/v1/auth/password/reset", payload: { token, password: "password12345" } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toMatchObject({ code: "weak_password", details: { reason: "common" } });
    const mine = await app.inject({ method: "POST", url: "/v1/auth/password/reset", payload: { token, password: `${u.email.split("@")[0]}-2026!` } });
    expect(mine.json().error).toMatchObject({ code: "weak_password", details: { reason: "email" } });
    const ok = await app.inject({ method: "POST", url: "/v1/auth/password/reset", payload: { token, password: "otro-pasaje-largo-77" } });
    expect(ok.statusCode).toBe(200);
    expect(await jobsOf(u.id, "password_changed")).toHaveLength(1);
  });

  it("el tope de pedidos es por (cuenta, red): otra red recibe su link sin invalidar los de la persona", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const ask = (ip: string) => app.inject({ method: "POST", url: "/v1/auth/password/forgot", payload: { email: u.email }, remoteAddress: ip });
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]) expect((await ask(ip)).statusCode).toBe(202);
    // La 4.ª desde la misma /24 no crea otro link; cada pedido desde la misma red reemplaza al anterior.
    expect((await db.query(`SELECT 1 FROM password_resets WHERE user_id = $1`, [u.id])).length).toBe(3);
    await ask("198.51.100.20");
    const rows = await db.query<any>(`SELECT ip_key, used_at FROM password_resets WHERE user_id = $1 ORDER BY created_at`, [u.id]);
    expect(rows).toHaveLength(4);
    // El pedido desde otra red no invalida el último link de 192.0.2.0/24 (vence solo).
    expect(rows.filter((r) => r.used_at === null).map((r) => r.ip_key)).toEqual(["192.0.2.0/24", "198.51.100.0/24"]);
  });

  it("el techo por cuenta es alto (50/h): muchas redes ajenas no dejan sin link a la persona", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    for (let i = 0; i < 25; i++) {
      await db.query(`INSERT INTO password_resets (token_hash, user_id, ip_key, expires_at) VALUES ($1,$2,$3, now() + interval '30 minutes')`, [
        util.sha256Hex(util.randomToken()),
        u.id,
        `10.${i}.0.0/24`,
      ]);
    }
    await app.inject({ method: "POST", url: "/v1/auth/password/forgot", payload: { email: u.email }, remoteAddress: "198.51.100.44" });
    expect(
      await db.query(`SELECT 1 FROM password_resets WHERE user_id = $1 AND ip_key = '198.51.100.0/24' AND used_at IS NULL`, [u.id]),
    ).toHaveLength(1);
    expect(await db.query(`SELECT 1 FROM password_resets WHERE user_id = $1 AND used_at IS NULL`, [u.id])).toHaveLength(26);
  });
});

describe("bloqueo de ingresos", () => {
  it("los fallos desde una red bloquean esa red, no a la persona desde otra; el techo global sí la bloquea", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    for (let i = 0; i < 10; i++) expect((await login(u.email, "mala-contraseña-x", `203.0.113.${i + 1}`)).statusCode).toBe(401);
    expect((await login(u.email, PW, "203.0.113.200")).statusCode).toBe(429);
    expect((await login(u.email, PW, "198.51.100.5")).statusCode).toBe(200);
    // Techo global de la cuenta: bloquea las redes desconocidas, no la red desde la que ya ingresó.
    await db.query(`UPDATE login_attempts SET n = 50, window_start = now() WHERE user_id = $1 AND scope = 'account'`, [u.id]);
    expect((await login(u.email, PW, "192.0.2.50")).statusCode).toBe(429);
    expect((await login(u.email, PW, "198.51.100.77")).statusCode).toBe(200);
    // La red conocida sigue con su propio cupo.
    for (let i = 0; i < 10; i++) await login(u.email, "mala-contraseña-x", "198.51.100.78");
    expect((await login(u.email, PW, "198.51.100.79")).statusCode).toBe(429);
  });

  it("el techo global solo cuenta fallos: ingresos y re-autenticaciones correctos no lo acercan", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const acct = async () => (await db.one<any>(`SELECT n FROM login_attempts WHERE user_id = $1 AND scope = 'account'`, [u.id]))?.n ?? 0;
    for (let i = 0; i < 3; i++) expect((await login(u.email, PW, `203.0.113.${i + 1}`)).statusCode).toBe(200);
    expect(await acct()).toBe(0);
    await login(u.email, "mala-contraseña-x", "203.0.113.9");
    expect(await acct()).toBe(1);
    const cookies = { cs_session: await newSession(u.id, t, { authenticatedAgo: "2 hours" }) };
    expect(
      (await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies, payload: { password: PW }, remoteAddress: "203.0.113.1" })).statusCode,
    ).toBe(200);
    expect(await acct()).toBe(1);
    // Con 2FA, la contraseña correcta ya devuelve el intento (antes del código).
    const secret = totp.generateTotpSecret();
    await db.query(`UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now() WHERE id = $1`, [u.id, util.encrypt(secret)]);
    expect((await login(u.email, PW, "192.0.2.80")).json().twoFactorRequired).toBe(true);
    expect(await acct()).toBe(1);
    // Una red desconocida con la cuenta en el techo queda bloqueada; el titular, desde una red conocida, no.
    await db.query(`UPDATE login_attempts SET n = 50, window_start = now() WHERE user_id = $1 AND scope = 'account'`, [u.id]);
    expect((await login(u.email, PW, "192.0.2.81")).statusCode).toBe(429);
    expect(await acct()).toBe(50);
    expect((await login(u.email, PW, "203.0.113.2")).json().twoFactorRequired).toBe(true);
    // Una red conocida hace más de 30 días ya no lo es.
    await db.query(`UPDATE login_attempts SET window_start = now() - interval '31 days' WHERE user_id = $1 AND scope = 'ok:203.0.113.0/24'`, [u.id]);
    expect((await login(u.email, PW, "203.0.113.3")).statusCode).toBe(429);
  });

  it("un desafío de 2FA ya abierto no lo bloquean los fallos de contraseña desde otras redes", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const secret = totp.generateTotpSecret();
    await db.query(`UPDATE users SET totp_secret_enc = $2, totp_enabled_at = now() WHERE id = $1`, [u.id, util.encrypt(secret)]);
    const ch = await login(u.email, PW, "198.51.100.9");
    expect(ch.json().twoFactorRequired).toBe(true);
    for (let i = 0; i < 12; i++) await login(u.email, "mala-contraseña-x", `203.0.113.${i + 1}`);
    const v = await app.inject({
      method: "POST",
      url: "/v1/auth/2fa/verify",
      payload: { challengeToken: ch.json().challengeToken, code: totp.totpAt(secret, totp.currentStep()) },
      remoteAddress: "198.51.100.9",
    });
    expect(v.statusCode).toBe(200);
  });

  it("aceptar una invitación sin contraseña no cuenta un intento", async () => {
    const t = await newTenant();
    const owner = await newUser(t);
    const u = await newUser(null);
    const token = util.randomToken();
    await db.query(
      `INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,'member',$4,$5, now() + interval '7 days')`,
      [util.uuidv7(), t, u.email, util.sha256Hex(token), owner.id],
    );
    const r = await app.inject({ method: "POST", url: `/v1/invite/${token}/accept`, payload: {} });
    expect(r.statusCode).toBe(401);
    expect(await db.one(`SELECT 1 FROM login_attempts WHERE user_id = $1`, [u.id])).toBeNull();
  });

  it("una cuenta solo SSO invitada a otra organización recibe la salida (restablecer), no 'contraseña incorrecta'", async () => {
    const t = await newTenant();
    const owner = await newUser(t);
    const u = await newUser(null, { password: null });
    const token = util.randomToken();
    await db.query(
      `INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,'member',$4,$5, now() + interval '7 days')`,
      [util.uuidv7(), t, u.email, util.sha256Hex(token), owner.id],
    );
    for (const payload of [{}, { password: "lo-que-sea-que-pruebe-1" }]) {
      const r = await app.inject({ method: "POST", url: `/v1/invite/${token}/accept`, payload });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("password_reset_required");
    }
    // No es un intento fallido: no cuenta para el bloqueo ni deja la membresía hecha.
    expect(await db.one(`SELECT 1 FROM login_attempts WHERE user_id = $1`, [u.id])).toBeNull();
    expect(await db.one(`SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2`, [u.id, t])).toBeNull();
  });
});

describe("sesiones", () => {
  it("sin recordarme la cookie es de sesión; con recordarme dura 14 días", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const plain = await login(u.email, PW, "198.51.100.30");
    expect(String(plain.headers["set-cookie"])).not.toMatch(/Max-Age/i);
    const remembered = await login(u.email, PW, "198.51.100.30", { rememberMe: true });
    expect(String(remembered.headers["set-cookie"])).toMatch(/Max-Age=1209600/);
    const rows = await db.query<any>(`SELECT remember FROM sessions WHERE user_id = $1 ORDER BY created_at`, [u.id]);
    expect(rows.map((r) => r.remember)).toEqual([false, true]);
  });

  it("una sesión sin recordarme se cierra por inactividad; la actividad se registra", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const idle = await newSession(u.id, t, { remember: false, lastSeenAgo: "25 hours" });
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { cs_session: idle } })).statusCode).toBe(401);
    const kept = await newSession(u.id, t, { remember: true, lastSeenAgo: "25 hours" });
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { cs_session: kept } })).statusCode).toBe(200);
    const active = await newSession(u.id, t, { remember: false, lastSeenAgo: "6 minutes" });
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { cs_session: active } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const seen = await db.one<any>(`SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM sessions WHERE token_hash = $1`, [
      util.sha256Hex(active),
    ]);
    expect(seen.fresh).toBe(true);
  });

  it("listar, cerrar una y cerrar todas (con los tokens OAuth)", async () => {
    const t = await newTenant();
    const u = await newUser(t);
    const mine = await newSession(u.id, t);
    const other = await newSession(u.id, t);
    const cookies = { cs_session: mine };
    const list = await app.inject({ method: "GET", url: "/v1/me/sessions", cookies });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as any[];
    expect(items).toHaveLength(2);
    expect(items.filter((x) => x.current)).toHaveLength(1);
    expect(items[0]).toMatchObject({ ip: "203.0.113.0/24", userAgent: "Firefox · Windows" });
    const otherId = (await db.one<any>(`SELECT id FROM sessions WHERE token_hash = $1`, [util.sha256Hex(other)]))!.id;
    expect((await app.inject({ method: "DELETE", url: `/v1/me/sessions/${otherId}`, cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `/v1/me/sessions/${otherId}`, cookies })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/v1/me/sessions/no-es-un-id`, cookies })).statusCode).toBe(404);
    // Ajena: 404.
    const stranger = await newUser(t);
    const strangerSess = await newSession(stranger.id, t);
    const strangerId = (await db.one<any>(`SELECT id FROM sessions WHERE token_hash = $1`, [util.sha256Hex(strangerSess)]))!.id;
    expect((await app.inject({ method: "DELETE", url: `/v1/me/sessions/${strangerId}`, cookies })).statusCode).toBe(404);

    const { issueTokens } = await import("../src/modules/oauth-tokens");
    const client = util.uuidv7();
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris, grant_types, scopes) VALUES ($1,$2,$3,'app','{https://app.test/cb}','{authorization_code}','{envelopes:read}')`,
      [client, t, `cs_cli_${client.slice(-12)}`],
    );
    await issueTokens(db, {
      clientId: client,
      tenantId: t,
      userId: u.id,
      serviceApiKeyId: null,
      scopes: ["envelopes:read"],
      withRefresh: false,
      authMethod: "password",
    });
    await newSession(u.id, t);
    const all = await app.inject({ method: "POST", url: "/v1/auth/logout-all", cookies });
    expect(all.statusCode).toBe(204);
    expect(await db.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [u.id])).toHaveLength(0);
    expect(await db.query(`SELECT 1 FROM oauth_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u.id])).toHaveLength(0);
    expect(await db.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [stranger.id])).toHaveLength(1);
  });
});

describe("OAuth: refresh con scope más chico", () => {
  it("el access token lleva el subconjunto y el refresh token conserva la concesión", async () => {
    const { issueTokens } = await import("../src/modules/oauth-tokens");
    const t = await newTenant();
    const u = await newUser(t);
    const client = util.uuidv7();
    const clientId = `cs_cli_${client.slice(-12)}`;
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris, grant_types, scopes) VALUES ($1,$2,$3,'app','{https://app.test/cb}','{authorization_code,refresh_token}','{envelopes:read,envelopes:write,offline_access}')`,
      [client, t, clientId],
    );
    const tok = await issueTokens(db, {
      clientId: client,
      tenantId: t,
      userId: u.id,
      serviceApiKeyId: null,
      scopes: ["envelopes:read", "envelopes:write", "offline_access"],
      withRefresh: true,
      authMethod: "password",
    });
    const refresh = (rt: string, scope?: string) =>
      app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId, ...(scope ? { scope } : {}) }).toString(),
      });
    const narrow = await refresh(tok.refresh_token!, "envelopes:read");
    expect(narrow.statusCode).toBe(200);
    expect(narrow.json().scope).toBe("envelopes:read");
    expect(narrow.json().refresh_token).toBeTruthy();
    const rows = await db.query<any>(
      `SELECT kind, scopes FROM oauth_tokens WHERE client_id = $1 AND revoked_at IS NULL AND used_at IS NULL ORDER BY created_at DESC`,
      [client],
    );
    expect(rows.find((r) => r.kind === "access").scopes).toEqual(["envelopes:read"]);
    expect(rows.find((r) => r.kind === "refresh").scopes).toEqual(["envelopes:read", "envelopes:write", "offline_access"]);
    // Con el refresh nuevo se puede volver a pedir el conjunto completo.
    const full = await refresh(narrow.json().refresh_token);
    expect(full.json().scope).toBe("envelopes:read envelopes:write offline_access");
  });
});

describe("política de contraseñas", () => {
  it("rechaza comunes y basadas en el correo; acepta las demás", async () => {
    const { weakPasswordReason } = await import("../src/lib/password-policy");
    expect(weakPasswordReason("corta")).toBe("too_short");
    expect(weakPasswordReason("1234567890")).toBe("common");
    expect(weakPasswordReason("Password2024!")).toBe("common");
    expect(weakPasswordReason("qwertyuiop")).toBe("common");
    expect(weakPasswordReason("aaaaaaaaaaaa")).toBe("common");
    expect(weakPasswordReason("ana.perez-2026", "ana.perez@acme.com")).toBe("email");
    expect(weakPasswordReason("ana.perez@acme.com", "ana.perez@acme.com")).toBe("email");
    expect(weakPasswordReason("una-clave-segura-123", "ana@acme.com")).toBeNull();
    // Parte local corta: contenerla no alcanza; sí armarse con ella (al derecho, al revés o repetida). Sin "+etiqueta".
    expect(weakPasswordReason("bananas-in-pyjamas-7", "ana@acme.com")).toBeNull();
    expect(weakPasswordReason("Roberto2024!!", "roberto@acme.com")).toBe("email");
    expect(weakPasswordReason("bobbobbob12", "bob+x@acme.com")).toBe("email");
    expect(weakPasswordReason("Bob-2024-!!!", "bob+news@acme.com")).toBe("email");
    expect(weakPasswordReason("ANA-ana-2024", "ana@acme.com")).toBe("email");
    expect(weakPasswordReason("trebor-2024-!!", "robert+tag@acme.com")).toBe("email");
    expect(weakPasswordReason("lisa-montaña-1987", "lis@acme.com")).toBeNull();
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { name: "X", email: "nuevo-x@acme.test", password: "iloveyou123", organization: "Org X" },
    });
    expect(signup.statusCode).toBe(400);
    expect(signup.json().error.code).toBe("weak_password");
  });
});
