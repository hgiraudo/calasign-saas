// Canje de la URL de firma embebida (GET /embed/:code): entrega un token de sesión derivado (migración 0083,
// signer-token.ts) en lugar del link permanente del destinatario; toda la superficie del firmante lo acepta, con
// vencimiento deslizante y revocación al cerrarse el sobre o rotar el link. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-signer-session-"));
delete process.env.DATABASE_URL;
process.env.VERIFF_API_KEY = "veriff_test_key";
process.env.VERIFF_SHARED_SECRET = "veriff_test_secret";
process.env.VERIFF_BASE_URL = "https://veriff.test";

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";
const ORIGIN = "https://app.integrador.test";
const KEY = "cs_test_signer_session_token_key";
const auth = { authorization: `Bearer ${KEY}` };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const real = globalThis.fetch;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, embed_frame_ancestors) VALUES ($1, $2, 'T', $3)`, [tenant, `t-${tenant.slice(-8)}`, [ORIGIN]]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  globalThis.fetch = real;
  await app?.close();
  await db?.close();
});

type Opts = { embedded?: boolean; authMethod?: string; role?: string; idv?: string };

async function setup(o: Opts = {}) {
  const { randomToken, sha256Hex, uuidv7, encrypt } = await import("../src/lib/util");
  const envelope = uuidv7();
  const recipient = uuidv7();
  const token = randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [envelope, tenant]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc, embedded, auth_method,
       id_verification_provider, id_verification_level, identity_status)
     VALUES ($1,$2,$3,$4,'Ana','ana@x.test','sent',$5,$6,$7,$8,$9,$10,$11)`,
    [
      recipient,
      tenant,
      envelope,
      o.role ?? "signer",
      sha256Hex(token),
      encrypt(token),
      o.embedded ?? true,
      o.authMethod ?? "link",
      o.idv ?? null,
      o.idv ? "document" : null,
      o.idv ? "pending" : null,
    ],
  );
  return { envelope, recipient, token };
}

/** Canjea una URL embebida nueva y devuelve el Location y el token de sesión. */
async function redeem(envelope: string, recipient: string, frameAncestors: string[] = [ORIGIN]) {
  const su = await app.inject({
    method: "POST",
    url: `/v1/envelopes/${envelope}/recipients/${recipient}/signing-url`,
    headers: auth,
    payload: { frameAncestors, returnUrl: `${ORIGIN}/done` },
  });
  expect(su.statusCode).toBe(201);
  const code = String(su.json().url).split("/embed/")[1];
  const ex = await app.inject({ method: "GET", url: `/embed/${code}` });
  return { ex, location: String(ex.headers.location ?? ""), session: String(ex.headers.location ?? "").split("/s/")[1]?.split("?")[0] ?? "" };
}

const signing = (token: string, path = "", method: "GET" | "POST" = "GET", payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/v1/signing/${token}${path}`, payload: payload as any, headers });
const frameAncestors = (csp: unknown) => /frame-ancestors ([^;]*)/.exec(String(csp ?? ""))?.[1]?.trim();

describe("canje embebido → token de sesión", () => {
  it("redirige a /s/<token de sesión>?embed=1, sin el token permanente", async () => {
    const { envelope, recipient, token } = await setup();
    const { ex, location, session } = await redeem(envelope, recipient);
    expect(ex.statusCode).toBe(302);
    expect(location).toMatch(/^\/s\/[A-Za-z0-9_-]{20,100}\?embed=1$/);
    expect(session).not.toBe(token);
    expect(location).not.toContain(token);
    const { sha256Hex } = await import("../src/lib/util");
    const row = await db.one<any>(`SELECT * FROM signer_session_tokens WHERE token_hash = $1`, [sha256Hex(session)]);
    expect(row).toMatchObject({ recipient_id: recipient, envelope_id: envelope, access_token_hash: sha256Hex(token), revoked_at: null });
    const ttlH = (new Date(row.expires_at).getTime() - Date.now()) / 3_600_000;
    const maxH = (new Date(row.max_expires_at).getTime() - Date.now()) / 3_600_000;
    expect(ttlH).toBeGreaterThan(1.9);
    expect(ttlH).toBeLessThanOrEqual(2);
    expect(maxH).toBeGreaterThan(7.9);
    expect(maxH).toBeLessThanOrEqual(8);
    // La evidencia del inicio de la sesión no lleva el token.
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.embedded_session_started'`, [envelope]);
    expect(JSON.stringify(ev.data)).not.toContain(session);
  });

  it("la página y /embed lo aceptan: CSP con los orígenes del integrador y returnUrl", async () => {
    const { envelope, recipient } = await setup();
    const { location, session } = await redeem(envelope, recipient);
    const page = await app.inject({ method: "GET", url: location });
    expect(frameAncestors(page.headers["content-security-policy"])).toBe(`'self' ${ORIGIN}`);
    const info = await signing(session, "/embed");
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ embedded: true, returnUrl: `${ORIGIN}/done`, origins: [ORIGIN] });
  });

  it("ver, consentir y firmar con el token de sesión: atribuido al destinatario", async () => {
    const { envelope, recipient, token } = await setup();
    const { session } = await redeem(envelope, recipient);
    const s1 = await signing(session);
    expect(s1.statusCode).toBe(200);
    expect(s1.json().recipient.id).toBe(recipient);
    const viewed = await db.one<any>(`SELECT status FROM recipients WHERE id = $1`, [recipient]);
    expect(viewed.status).toBe("viewed");
    const c = await signing(session, "/consent", "POST");
    expect(c.statusCode).toBe(200);
    expect(c.json().recipient.consented).toBe(true);
    const done = await signing(session, "/complete", "POST", { fields: [], signature: { kind: "drawn", imagePng: PNG } });
    expect(done.statusCode).toBe(200);
    expect(done.json().recipient.status).toBe("signed");
    const evs = await db.query<any>(
      `SELECT type, actor_type, actor_id FROM envelope_events WHERE envelope_id = $1 AND type IN ('recipient.viewed','recipient.consented','recipient.signed') ORDER BY seq`,
      [envelope],
    );
    expect(evs.map((e) => e.type).sort()).toEqual(["recipient.consented", "recipient.signed", "recipient.viewed"]);
    for (const e of evs) expect(e).toMatchObject({ actor_type: "recipient", actor_id: recipient });
    // El permanente sigue funcionando igual (los links por correo no cambian).
    expect((await signing(token)).statusCode).toBe(200);
  });

  it("rechazar con el token de sesión: responde la sesión final y, pasada la gracia, el token queda revocado", async () => {
    const { envelope, recipient, token } = await setup();
    const { session } = await redeem(envelope, recipient);
    const d = await signing(session, "/decline", "POST", { reason: "No estoy de acuerdo" });
    expect(d.statusCode).toBe(200);
    expect(d.json().recipient.status).toBe("declined");
    const { sha256Hex } = await import("../src/lib/util");
    const row = await db.one<any>(`SELECT revoked_at FROM signer_session_tokens WHERE token_hash = $1`, [sha256Hex(session)]);
    expect(row.revoked_at).not.toBeNull();
    await db.query(`UPDATE signer_session_tokens SET revoked_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256Hex(session)]);
    expect((await signing(session)).statusCode).toBe(404);
    // El link permanente sigue mostrando el sobre rechazado.
    expect((await signing(token)).statusCode).toBe(200);
  });

  it("anular el sobre: 15 min de gracia (la página muestra el cierre, CSP del integrador); pasada la gracia, 404 y CSP 'none'", async () => {
    const { envelope, recipient } = await setup();
    const { location, session } = await redeem(envelope, recipient);
    await db.query(`UPDATE envelopes SET status = 'voided' WHERE id = $1`, [envelope]);
    const { sha256Hex } = await import("../src/lib/util");
    const row = await db.one<any>(`SELECT revoked_at FROM signer_session_tokens WHERE token_hash = $1`, [sha256Hex(session)]);
    const graceMin = (new Date(row.revoked_at).getTime() - Date.now()) / 60_000;
    expect(graceMin).toBeGreaterThan(14);
    expect(graceMin).toBeLessThanOrEqual(15);
    const s1 = await signing(session);
    expect(s1.statusCode).toBe(200);
    expect(s1.json().envelope.status).toBe("voided");
    expect(s1.json().documents).toEqual([]);
    expect(frameAncestors((await app.inject({ method: "GET", url: location })).headers["content-security-policy"])).toBe(`'self' ${ORIGIN}`);
    await db.query(`UPDATE signer_session_tokens SET revoked_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256Hex(session)]);
    expect((await signing(session)).statusCode).toBe(404);
    expect((await signing(session, "/consent", "POST")).statusCode).toBe(404);
    expect(frameAncestors((await app.inject({ method: "GET", url: location })).headers["content-security-policy"])).toBe("'none'");
  });

  it("vencido por el barrido (expired): misma gracia", async () => {
    const { envelope, recipient } = await setup();
    const { session } = await redeem(envelope, recipient);
    await db.query(`UPDATE envelopes SET status = 'expired' WHERE id = $1`, [envelope]);
    const s1 = await signing(session);
    expect(s1.statusCode).toBe(200);
    expect(s1.json().envelope.status).toBe("expired");
  });

  it("canje con el sobre ya anulado: 410", async () => {
    const { envelope, recipient } = await setup();
    const su = await app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/recipients/${recipient}/signing-url`, headers: auth, payload: {} });
    await db.query(`UPDATE envelopes SET status = 'voided' WHERE id = $1`, [envelope]);
    const ex = await app.inject({ method: "GET", url: `/embed/${String(su.json().url).split("/embed/")[1]}` });
    expect(ex.statusCode).toBe(410);
  });

  it("usos seguidos no escriben: el vencimiento se desliza solo si el último uso tiene más de 1 minuto", async () => {
    const { envelope, recipient } = await setup();
    const { session } = await redeem(envelope, recipient);
    const { sha256Hex } = await import("../src/lib/util");
    const h = sha256Hex(session);
    // Último uso reciente: un GET (y sus hooks) no toca la fila.
    await db.query(`UPDATE signer_session_tokens SET last_used_at = now() - interval '10 seconds', expires_at = now() + interval '1 hour' WHERE token_hash = $1`, [h]);
    const before = await db.one<any>(`SELECT last_used_at, expires_at FROM signer_session_tokens WHERE token_hash = $1`, [h]);
    expect((await signing(session)).statusCode).toBe(200);
    expect((await signing(session, "/embed")).statusCode).toBe(200);
    const same = await db.one<any>(`SELECT last_used_at, expires_at FROM signer_session_tokens WHERE token_hash = $1`, [h]);
    expect(new Date(same.last_used_at).getTime()).toBe(new Date(before.last_used_at).getTime());
    expect(new Date(same.expires_at).getTime()).toBe(new Date(before.expires_at).getTime());
    // Más de un minuto: se desliza a 2 h.
    await db.query(`UPDATE signer_session_tokens SET last_used_at = now() - interval '2 minutes' WHERE token_hash = $1`, [h]);
    expect((await signing(session)).statusCode).toBe(200);
    const slid = await db.one<any>(`SELECT last_used_at, expires_at FROM signer_session_tokens WHERE token_hash = $1`, [h]);
    expect(Date.now() - new Date(slid.last_used_at).getTime()).toBeLessThan(30_000);
    expect((new Date(slid.expires_at).getTime() - Date.now()) / 3_600_000).toBeGreaterThan(1.9);
  });

  it("vencido (TTL) → 404 como un link inválido; el uso desliza el vencimiento sin pasar el tope", async () => {
    const { envelope, recipient } = await setup();
    const { session } = await redeem(envelope, recipient);
    const { sha256Hex } = await import("../src/lib/util");
    const h = sha256Hex(session);
    await db.query(`UPDATE signer_session_tokens SET expires_at = now() + interval '1 minute', max_expires_at = now() + interval '30 minutes', last_used_at = now() - interval '5 minutes' WHERE token_hash = $1`, [h]);
    expect((await signing(session)).statusCode).toBe(200);
    const slid = await db.one<any>(`SELECT expires_at, max_expires_at FROM signer_session_tokens WHERE token_hash = $1`, [h]);
    expect(new Date(slid.expires_at).getTime()).toBe(new Date(slid.max_expires_at).getTime());
    await db.query(`UPDATE signer_session_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [h]);
    expect((await signing(session)).statusCode).toBe(404);
    expect((await signing(session, "/embed")).statusCode).toBe(404);
  });

  it("rotar el link del destinatario (corrección del contacto) lo revoca", async () => {
    const { envelope, recipient } = await setup();
    const { session } = await redeem(envelope, recipient);
    const { sha256Hex, randomToken, encrypt } = await import("../src/lib/util");
    const nt = randomToken();
    await db.query(`UPDATE recipients SET access_token_hash = $2, access_token_enc = $3 WHERE id = $1`, [recipient, sha256Hex(nt), encrypt(nt)]);
    expect((await signing(session)).statusCode).toBe(404);
    const row = await db.one<any>(`SELECT revoked_at FROM signer_session_tokens WHERE token_hash = $1`, [sha256Hex(session)]);
    expect(row.revoked_at).not.toBeNull();
  });

  it("OTP (URL para pestaña): el código se valida con el token de sesión y la cookie queda atada a ese token", async () => {
    const { envelope, recipient } = await setup({ embedded: false, authMethod: "otp_email" });
    const { location, session } = await redeem(envelope, recipient, []);
    expect(location).toMatch(/\?embed=1&tab=1$/);
    expect((await signing(session, "/consent", "POST")).statusCode).toBe(401);
    const { sha256Hex, uuidv7 } = await import("../src/lib/util");
    await db.query(
      `INSERT INTO otp_challenges (id, tenant_id, recipient_id, method, destination, code_hash, expires_at) VALUES ($1,$2,$3,'otp_email','ana@x.test',$4, now() + interval '10 minutes')`,
      [uuidv7(), tenant, recipient, sha256Hex(`${recipient}:123456`)],
    );
    const v = await signing(session, "/otp/verify", "POST", { code: "123456" });
    expect(v.statusCode).toBe(200);
    expect(v.json().otpRequired).toBe(false);
    const setCookie = String(v.headers["set-cookie"]);
    expect(setCookie).toContain(`Path=/v1/signing/${session}`);
    const cookie = setCookie.split(";")[0];
    const c = await signing(session, "/consent", "POST", undefined, { cookie });
    expect(c.statusCode).toBe(200);
  });

  /** Vuelta del proveedor: sigue la URL que se le dio al proveedor (ruta neutra) con o sin la cookie de la página. */
  const followReturn = (url: string, cookie?: string) => {
    const u = new URL(url);
    return app.inject({ method: "GET", url: `${u.pathname}${u.search}`, headers: cookie ? { cookie } : {} });
  };
  const returnCookie = (res: { headers: Record<string, unknown> }) => {
    const raw = ([] as string[]).concat((res.headers["set-cookie"] as any) ?? []).find((c) => c.startsWith("cs_signer_return="));
    return raw ? { pair: raw.split(";")[0], raw } : null;
  };

  async function mockPayment(envelope: string, recipient: string) {
    const { uuidv7 } = await import("../src/lib/util");
    const payment = uuidv7();
    await db.query(
      `INSERT INTO envelope_payments (id, tenant_id, envelope_id, recipient_id, provider, amount, currency, description, timing, status)
       VALUES ($1,$2,$3,$4,'mock',100,'USD','Honorarios','before_sign','pending')`,
      [payment, tenant, envelope, recipient],
    );
    return payment;
  }

  async function completeMock(checkoutUrl: string) {
    const u = new URL(checkoutUrl);
    const done = await app.inject({
      method: "POST",
      url: `${u.pathname.replace(/\/?$/, "")}/complete${u.search}`,
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: u.origin },
      payload: "outcome=paid",
    });
    expect(done.statusCode).toBe(200);
    return String(done.json().redirect);
  }

  it("pago simulado: la vuelta es neutra y lleva al token con que se pagó (cookie), sin el permanente en la URL", async () => {
    const { envelope, recipient, token } = await setup();
    const payment = await mockPayment(envelope, recipient);
    const { session } = await redeem(envelope, recipient);
    const co = await signing(session, "/payment/checkout", "POST");
    expect(co.statusCode).toBe(200);
    const ck = returnCookie(co)!;
    expect(ck.raw).toContain(`Path=/v1/payments/return/${payment}`);
    expect(ck.raw).toMatch(/HttpOnly/i);
    expect(ck.raw).toMatch(/SameSite=Lax/i);
    expect(ck.raw).toMatch(/Max-Age=7200/);
    const back = await completeMock(co.json().url);
    expect(back).toContain(`/v1/payments/return/${payment}?`);
    expect(back).toContain("payment=success");
    expect(back).not.toContain(token);
    expect(back).not.toContain(session);
    const ret = await followReturn(back, ck.pair);
    expect(ret.statusCode).toBe(303);
    expect(String(ret.headers.location)).toMatch(new RegExp(`/s/${session}\\?payment=success$`));
  });

  it("checkout reutilizado desde otra sesión: la vuelta va al token actual, no al del primer inicio", async () => {
    const { envelope, recipient } = await setup();
    const { uuidv7 } = await import("../src/lib/util");
    const payment = uuidv7();
    // Preferencia de Mercado Pago ya creada (se reutiliza siempre): sus URLs de vuelta se armaron en el primer inicio.
    await db.query(
      `INSERT INTO envelope_payments (id, tenant_id, envelope_id, recipient_id, provider, amount, currency, description, timing, status, checkout_id, checkout_url)
       VALUES ($1,$2,$3,$4,'mercadopago',100,'USD','Honorarios','before_sign','checkout_created','pref_1','https://mp.test/checkout/pref_1')`,
      [payment, tenant, envelope, recipient],
    );
    const { session: first } = await redeem(envelope, recipient);
    expect((await signing(first, "/payment/checkout", "POST")).statusCode).toBe(200);
    const { session: second } = await redeem(envelope, recipient);
    const co = await signing(second, "/payment/checkout", "POST");
    expect(co.json().url).toBe("https://mp.test/checkout/pref_1");
    const ck = returnCookie(co)!;
    const { signerReturnUrl } = await import("../src/modules/signer-return");
    const r = await db.one<any>(`SELECT id, access_token_hash FROM recipients WHERE id = $1`, [recipient]);
    const back = signerReturnUrl("http://localhost:5173", "payments", payment, r, { payment: "success" });
    // Con la cookie de este navegador: el token con el que se retomó.
    let ret = await followReturn(back, ck.pair);
    expect(String(ret.headers.location)).toContain(`/s/${second}?payment=success`);
    // Sin cookie (iframe de terceros): fallback al último token guardado, si la URL trae la clave k.
    ret = await followReturn(back);
    expect(ret.statusCode).toBe(303);
    expect(String(ret.headers.location)).toContain(`/s/${second}?payment=success`);
    // Una cookie con el token vencido o de otro destinatario no gana: se usa el fallback.
    ret = await followReturn(back, "cs_signer_return=AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(String(ret.headers.location)).toContain(`/s/${second}?payment=success`);
    // Sin cookie ni clave (o con una clave de otro pago): página neutra, sin token.
    const noKey = new URL(back);
    noKey.searchParams.delete("k");
    ret = await followReturn(noKey.toString());
    expect(ret.statusCode).toBe(200);
    expect(ret.headers["content-type"]).toContain("text/html");
    expect(ret.body).not.toContain(second);
    noKey.searchParams.set("k", "x".repeat(43));
    expect((await followReturn(noKey.toString())).statusCode).toBe(200);
    // Rotar el link del destinatario invalida la clave y los tokens de sesión: neutra.
    await db.query(`UPDATE recipients SET access_token_hash = $2 WHERE id = $1`, [recipient, "f".repeat(64)]);
    ret = await followReturn(back, ck.pair);
    expect(ret.statusCode).toBe(200);
    expect(ret.headers.location).toBeUndefined();
  });

  it("verificación de identidad: vuelta neutra al token con que se inició o retomó", async () => {
    const { envelope, recipient, token } = await setup({ idv: "veriff" });
    let callback = "";
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (url.startsWith("https://veriff.test/v1/sessions")) {
        callback = JSON.parse(String(init?.body ?? "{}"))?.verification?.callback ?? "";
        return new Response(JSON.stringify({ verification: { id: "vf_1", url: "https://veriff.test/go/vf_1" } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return real(input, init);
    }) as typeof fetch;
    try {
      const { session } = await redeem(envelope, recipient);
      const st = await signing(session, "/identity/start", "POST");
      expect(st.statusCode).toBe(200);
      const v = await db.one<any>(`SELECT id FROM identity_verifications WHERE recipient_id = $1`, [recipient]);
      expect(callback).toContain(`/v1/identity/return/${v.id}?k=`);
      expect(callback).not.toContain(token);
      expect(callback).not.toContain(session);
      const ck1 = returnCookie(st)!;
      expect(ck1.raw).toContain(`Path=/v1/identity/return/${v.id}`);
      let ret = await followReturn(callback, ck1.pair);
      expect(ret.statusCode).toBe(303);
      expect(String(ret.headers.location)).toMatch(new RegExp(`/s/${session}\\?identity=return$`));
      // Retomada desde otra sesión (la verificación sigue en curso): la vuelta va al token nuevo.
      const { session: second } = await redeem(envelope, recipient);
      const st2 = await signing(second, "/identity/start", "POST");
      expect(st2.statusCode).toBe(200);
      ret = await followReturn(callback, returnCookie(st2)!.pair);
      expect(String(ret.headers.location)).toContain(`/s/${second}?identity=return`);
      ret = await followReturn(callback);
      expect(String(ret.headers.location)).toContain(`/s/${second}?identity=return`);
      // Id desconocido: neutra.
      expect((await app.inject({ method: "GET", url: `/v1/identity/return/${recipient}?k=x` })).statusCode).toBe(200);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("verificación cancelada por el cierre del sobre: el destinatario vuelve a 'pending' y la sesión no queda en curso", async () => {
    const { envelope, recipient, token } = await setup({ idv: "veriff", embedded: false });
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (url.startsWith("https://veriff.test/v1/sessions"))
        return new Response(JSON.stringify({ verification: { id: "vf_close", url: "https://veriff.test/go/vf_close" } }), { status: 201, headers: { "content-type": "application/json" } });
      return real(input, init);
    }) as typeof fetch;
    try {
      expect((await signing(token, "/identity/start", "POST")).statusCode).toBe(200);
      expect((await db.one<any>(`SELECT identity_status FROM recipients WHERE id = $1`, [recipient])).identity_status).toBe("in_progress");
      await db.query(`UPDATE envelopes SET status = 'voided' WHERE id = $1`, [envelope]);
      // Resultado tardío del proveedor (webhook de decisión): la verificación se cancela.
      const { veriffSignature } = await import("../src/modules/identity/providers");
      const raw = JSON.stringify({ status: "success", verification: { id: "vf_close", status: "approved", person: { firstName: "Ana" } } });
      const wh = await app.inject({
        method: "POST",
        url: "/v1/integrations/identity/veriff/webhook",
        payload: raw,
        headers: { "content-type": "application/json", "x-hmac-signature": veriffSignature(raw, "veriff_test_secret") },
      });
      expect(wh.statusCode).toBe(200);
      expect((await db.one<any>(`SELECT status FROM identity_verifications WHERE recipient_id = $1`, [recipient])).status).toBe("canceled");
      expect((await db.one<any>(`SELECT identity_status FROM recipients WHERE id = $1`, [recipient])).identity_status).toBe("pending");
      const ses = await signing(token);
      if (ses.statusCode === 200) expect(ses.json().identity?.status ?? "pending").not.toBe("in_progress");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("página neutra: marca del sobre e idioma del destinatario; sin id, Accept-Language", async () => {
    const { envelope, recipient } = await setup();
    const { uuidv7 } = await import("../src/lib/util");
    const brand = uuidv7();
    await db.query(`INSERT INTO brands (id, tenant_id, name, slug, config) VALUES ($1,$2,'Acme','acme-ret',$3)`, [brand, tenant, JSON.stringify({ productName: "FirmaPro" })]);
    await db.query(`UPDATE envelopes SET brand_id = $2 WHERE id = $1`, [envelope, brand]);
    await db.query(`UPDATE recipients SET locale = 'en' WHERE id = $1`, [recipient]);
    const payment = await mockPayment(envelope, recipient);
    let ret = await app.inject({ method: "GET", url: `/v1/payments/return/${payment}?payment=success` });
    expect(ret.statusCode).toBe(200);
    expect(ret.body).toContain("The payment returned to FirmaPro");
    expect(ret.body).toContain("<title>FirmaPro</title>");
    expect(ret.body).not.toMatch(/CalaSign/);
    expect(ret.body).not.toContain("volvió");
    ret = await app.inject({ method: "GET", url: `/v1/identity/return/${uuidv7()}?k=x`, headers: { "accept-language": "pt-BR,pt;q=0.9,en;q=0.5" } });
    expect(ret.statusCode).toBe(200);
    expect(ret.body).toContain("A verificação de identidade voltou para");
    expect(ret.body).toContain("Você pode fechar esta aba");
    ret = await app.inject({ method: "GET", url: `/v1/identity/return/${uuidv7()}` });
    expect(ret.body).toContain("La verificación de identidad volvió a");
  });

  it("iniciar desde el link permanente no pisa el token de sesión vigente guardado (fallback del iframe)", async () => {
    const { envelope, recipient, token } = await setup();
    const payment = await mockPayment(envelope, recipient);
    const { session } = await redeem(envelope, recipient);
    expect((await signing(session, "/payment/checkout", "POST")).statusCode).toBe(200);
    expect((await signing(token, "/payment/checkout", "POST")).statusCode).toBe(200);
    const { signerReturnUrl } = await import("../src/modules/signer-return");
    const r = await db.one<any>(`SELECT id, access_token_hash FROM recipients WHERE id = $1`, [recipient]);
    const back = signerReturnUrl("http://localhost:5173", "payments", payment, r, { payment: "success" });
    let ret = await followReturn(back);
    expect(String(ret.headers.location)).toContain(`/s/${session}?payment=success`);
    // Revocado el de sesión, el permanente sí lo reemplaza.
    const { sha256Hex } = await import("../src/lib/util");
    await db.query(`UPDATE signer_session_tokens SET revoked_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256Hex(session)]);
    expect((await signing(token, "/payment/checkout", "POST")).statusCode).toBe(200);
    ret = await followReturn(back);
    expect(String(ret.headers.location)).toContain(`/s/${token}?payment=success`);
  });

  it("canje con el sobre ya completado: el token nace revocado con 15 minutos de gracia", async () => {
    const { envelope, recipient } = await setup();
    const su = await app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/recipients/${recipient}/signing-url`, headers: auth, payload: { frameAncestors: [ORIGIN] } });
    expect(su.statusCode).toBe(201);
    await db.query(`UPDATE envelopes SET status = 'completed' WHERE id = $1`, [envelope]);
    const ex = await app.inject({ method: "GET", url: `/embed/${String(su.json().url).split("/embed/")[1]}` });
    expect(ex.statusCode).toBe(302);
    const session = String(ex.headers.location).split("/s/")[1].split("?")[0];
    const { sha256Hex } = await import("../src/lib/util");
    const row = await db.one<any>(`SELECT revoked_at FROM signer_session_tokens WHERE token_hash = $1`, [sha256Hex(session)]);
    const mins = (new Date(row.revoked_at).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(14);
    expect(mins).toBeLessThanOrEqual(15);
    expect((await signing(session)).statusCode).toBe(200);
    await db.query(`UPDATE signer_session_tokens SET revoked_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256Hex(session)]);
    expect((await signing(session)).statusCode).toBe(404);
  });

  it("el barrido purga los tokens vencidos o revocados hace más de un día", async () => {
    const { envelope, recipient } = await setup();
    const { session: oldExpired } = await redeem(envelope, recipient);
    const { session: oldRevoked } = await redeem(envelope, recipient);
    const { session: recentRevoked } = await redeem(envelope, recipient);
    const { session: alive } = await redeem(envelope, recipient);
    const { sha256Hex } = await import("../src/lib/util");
    await db.query(`UPDATE signer_session_tokens SET expires_at = now() - interval '25 hours' WHERE token_hash = $1`, [sha256Hex(oldExpired)]);
    await db.query(`UPDATE signer_session_tokens SET revoked_at = now() - interval '25 hours' WHERE token_hash = $1`, [sha256Hex(oldRevoked)]);
    await db.query(`UPDATE signer_session_tokens SET revoked_at = now() - interval '2 hours' WHERE token_hash = $1`, [sha256Hex(recentRevoked)]);
    const { sweep } = await import("../src/modules/jobs");
    const { createBlobStore } = await import("../src/infra/storage");
    const log = { info() {}, warn() {}, error() {} };
    await sweep({ db, blobs: createBlobStore(), log });
    const left = (await db.query<any>(`SELECT token_hash FROM signer_session_tokens WHERE recipient_id = $1`, [recipient])).map((x) => x.token_hash);
    expect(left).toEqual(expect.arrayContaining([sha256Hex(recentRevoked), sha256Hex(alive)]));
    expect(left).not.toContain(sha256Hex(oldExpired));
    expect(left).not.toContain(sha256Hex(oldRevoked));
  }, 60_000);
});
