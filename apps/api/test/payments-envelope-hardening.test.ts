// Cobros de sobres: proveedor ofrecido solo con su webhook configurado, moneda de la cuenta de Mercado Pago, pago
// cobrado en un sobre que se cierra sin completarse (constancia, sin reembolso automático) y repetición idempotente de
// POST /v1/envelopes sin guardar las URLs de firma. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-payments-envelope-"));
delete process.env.DATABASE_URL;
process.env.STRIPE_SECRET_KEY = "sk_test_env";
process.env.STRIPE_API_BASE = "https://stripe.test";
delete process.env.STRIPE_WEBHOOK_SECRET;
process.env.MP_ACCESS_TOKEN = "TEST-env";
process.env.MP_API_BASE = "https://mp.test";
process.env.MP_CURRENCIES = "ARS";
delete process.env.MP_WEBHOOK_SECRET;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";
const KEY = "cs_test_payments_envelope_key";
const auth = { authorization: `Bearer ${KEY}` };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'T', 'business')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

/** Sobre con un firmante pagador; cobro opcional con el proveedor, moneda y estado pedidos. */
async function setup(o: { status?: string; provider?: string; currency?: string; payStatus?: string | null; refundRequired?: boolean } = {}) {
  const { randomToken, sha256Hex, uuidv7, encrypt } = await import("../src/lib/util");
  const envelope = uuidv7();
  const recipient = uuidv7();
  const token = randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', $3)`, [envelope, tenant, o.status ?? "sent"]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc) VALUES ($1,$2,$3,'signer','Ana','ana@x.test','sent',$4,$5)`,
    [recipient, tenant, envelope, sha256Hex(token), encrypt(token)],
  );
  if (o.payStatus !== null) {
    await db.query(
      `INSERT INTO envelope_payments (id, tenant_id, envelope_id, recipient_id, provider, amount, currency, description, timing, status, paid_at, provider_payment_id, refund_required_at)
       VALUES ($1,$2,$3,$4,$5,100,$6,'Honorarios','before_sign',$7, CASE WHEN $7 = 'paid' THEN now() END, CASE WHEN $7 = 'paid' THEN 'pi_x' END, CASE WHEN $8 THEN now() END)`,
      [uuidv7(), tenant, envelope, recipient, o.provider ?? "mock", o.currency ?? "USD", o.payStatus ?? "pending", o.refundRequired ?? false],
    );
  }
  return { envelope, recipient, token };
}
const events = (envelope: string, type: string) => db.query<any>(`SELECT data, actor_type FROM envelope_events WHERE envelope_id = $1 AND type = $2`, [envelope, type]);
const putPayment = (envelope: string, recipient: string, provider: string, currency: string) =>
  app.inject({
    method: "PUT",
    url: `/v1/envelopes/${envelope}/payment`,
    headers: auth,
    payload: { provider, amount: 10, currency, description: "x", timing: "before_sign", payerRecipientId: recipient },
  });

describe("proveedor del cobro: credenciales y webhook", () => {
  it("Stripe sin STRIPE_WEBHOOK_SECRET no se ofrece ni se acepta; Mercado Pago sin MP_WEBHOOK_SECRET solo fuera de producción", async () => {
    const { envelopePaymentProviderConfigured } = await import("../src/modules/billing/providers");
    const { config } = await import("../src/config");
    const list = (await app.inject({ method: "GET", url: "/v1/payments/providers", headers: auth })).json().items as any[];
    expect(list.find((p) => p.id === "stripe")?.configured).toBe(false);
    expect(list.find((p) => p.id === "mercadopago")?.configured).toBe(true);
    const s = await setup({ status: "draft", payStatus: null });
    const put = await putPayment(s.envelope, s.recipient, "stripe", "USD");
    expect(put.statusCode).toBe(400);
    // Credenciales cargadas pero sin el secreto del webhook: lo dice (y qué hacer), no "no configurado".
    expect(put.json().error.code).toBe("payment_webhook_not_configured");
    expect(put.json().error.message).toContain("STRIPE_WEBHOOK_SECRET");
    expect(put.json().error.message).toMatch(/Quitá el cobro|otro proveedor/);

    const saved = { secret: config.billing.stripe.webhookSecret, env: config.environment };
    try {
      (config.billing.stripe as { webhookSecret: string | null }).webhookSecret = "whsec_x";
      expect(envelopePaymentProviderConfigured("stripe")).toBe(true);
      expect((await putPayment(s.envelope, s.recipient, "stripe", "USD")).statusCode).toBe(200);
      (config as { environment: string }).environment = "prod";
      expect(envelopePaymentProviderConfigured("mercadopago")).toBe(false);
    } finally {
      (config.billing.stripe as { webhookSecret: string | null }).webhookSecret = saved.secret;
      (config as { environment: string }).environment = saved.env;
    }
  });

  it("al enviar: un cobro con Stripe sin webhook no deja enviar (400 payment_webhook_not_configured)", async () => {
    const { sendEnvelope } = await import("../src/modules/envelopes");
    const { SYSTEM } = await import("../src/infra/evidence");
    const s = await setup({ status: "draft", provider: "stripe" });
    const err = await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e);
    expect(err.code).toBe("payment_webhook_not_configured");
    // Sin credenciales: sigue siendo provider_not_configured.
    const { assertEnvelopePaymentProvider } = await import("../src/modules/billing/providers");
    const { config } = await import("../src/config");
    const prev = config.billing.stripe.secretKey;
    try {
      (config.billing.stripe as { secretKey: string | null }).secretKey = null;
      await expect(assertEnvelopePaymentProvider("stripe", "USD")).rejects.toMatchObject({ code: "provider_not_configured" });
    } finally {
      (config.billing.stripe as { secretKey: string | null }).secretKey = prev;
    }
  });
});

describe("Mercado Pago: solo en la moneda de la cuenta", () => {
  it("PUT con otra moneda: 400 currency_not_supported; con la de la cuenta, 200", async () => {
    const s = await setup({ status: "draft", payStatus: null });
    const bad = await putPayment(s.envelope, s.recipient, "mercadopago", "USD");
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("currency_not_supported");
    expect(bad.json().error.message).toContain("ARS");
    expect(await db.one(`SELECT 1 FROM envelope_payments WHERE envelope_id = $1`, [s.envelope])).toBeFalsy();
    expect((await putPayment(s.envelope, s.recipient, "mercadopago", "ARS")).statusCode).toBe(200);
  });

  it("al enviar con otra moneda (cobro guardado antes): 400 currency_not_supported", async () => {
    const { sendEnvelope } = await import("../src/modules/envelopes");
    const { SYSTEM } = await import("../src/infra/evidence");
    const s = await setup({ status: "draft", provider: "mercadopago", currency: "USD" });
    const err = await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e);
    expect(err.code).toBe("currency_not_supported");
    // En ARS pasa ese control (y falla después por el borrador incompleto).
    await db.query(`UPDATE envelope_payments SET currency = 'ARS' WHERE envelope_id = $1`, [s.envelope]);
    expect((await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e)).code).toBe("envelope_incomplete");
  });

  it("al enviar no se consulta a Mercado Pago (dentro de la transacción): moneda desconocida, se deja pasar", async () => {
    const { sendEnvelope } = await import("../src/modules/envelopes");
    const { SYSTEM } = await import("../src/infra/evidence");
    const { config } = await import("../src/config");
    const { resetMpCurrencyCache } = await import("../src/modules/billing/providers");
    const prev = config.billing.mercadopago.currencies;
    const real = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (url.startsWith("https://mp.test")) {
        calls.push(url);
        return new Response(JSON.stringify({ site_id: "MLA" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return real(input, init);
    }) as typeof fetch;
    try {
      (config.billing.mercadopago as { currencies: string[] }).currencies = [];
      resetMpCurrencyCache();
      const s = await setup({ status: "draft", provider: "mercadopago", currency: "USD" });
      // Sin MP_CURRENCIES ni consulta previa: pasa ese control (y falla después por el borrador incompleto), sin red.
      expect((await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e)).code).toBe("envelope_incomplete");
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = real;
      (config.billing.mercadopago as { currencies: string[] }).currencies = prev;
      resetMpCurrencyCache();
    }
  });
});

describe("pago cobrado y sobre cerrado sin completarse: constancia, sin reembolso automático", () => {
  it("anular: payment.settled_on_closed_envelope y el cobro sigue pagado", async () => {
    const s = await setup({ payStatus: "paid" });
    const v = await app.inject({ method: "POST", url: `/v1/envelopes/${s.envelope}/void`, headers: auth, payload: { reason: "error" } });
    expect(v.statusCode).toBeLessThan(300);
    const ev = await events(s.envelope, "payment.settled_on_closed_envelope");
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ amount: 100, currency: "USD", provider: "mock", providerPaymentId: "pi_x", envelopeStatus: "voided", refund: "manual" });
    const p = await db.one<any>(`SELECT status, refund_required_at FROM envelope_payments WHERE envelope_id = $1`, [s.envelope]);
    expect(p).toMatchObject({ status: "paid", refund_required_at: null });
  });

  it("rechazo del firmante: constancia con el firmante como actor", async () => {
    const s = await setup({ payStatus: "paid" });
    const d = await app.inject({ method: "POST", url: `/v1/signing/${s.token}/decline`, payload: { reason: "no" } });
    expect(d.statusCode).toBe(200);
    const ev = await events(s.envelope, "payment.settled_on_closed_envelope");
    expect(ev).toHaveLength(1);
    expect(ev[0].data.envelopeStatus).toBe("declined");
    expect(ev[0].actor_type).toBe("recipient");
  });

  it("vencimiento del barrido: constancia; sin cobro pagado (pendiente o ya en reembolso) no se registra", async () => {
    const paid = await setup({ payStatus: "paid" });
    const pending = await setup({ payStatus: "pending" });
    const late = await setup({ payStatus: "paid", refundRequired: true });
    for (const s of [paid, pending, late]) await db.query(`UPDATE envelopes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [s.envelope]);
    const { sweep } = await import("../src/modules/jobs");
    const { createBlobStore } = await import("../src/infra/storage");
    await sweep({ db, blobs: createBlobStore(), log: { info() {}, warn() {}, error() {} } });
    expect((await db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [paid.envelope])).status).toBe("expired");
    const ev = await events(paid.envelope, "payment.settled_on_closed_envelope");
    expect(ev).toHaveLength(1);
    expect(ev[0].data.envelopeStatus).toBe("expired");
    expect(await events(pending.envelope, "payment.settled_on_closed_envelope")).toHaveLength(0);
    expect(await events(late.envelope, "payment.settled_on_closed_envelope")).toHaveLength(0);
  }, 60_000);
});

describe("POST /v1/envelopes idempotente con firmantes embebidos", () => {
  function minimalPdf() {
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"];
    let out = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => {
      offs.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    return Buffer.from(out, "latin1").toString("base64");
  }

  it("no guarda las URLs de firma; al repetir emite URLs nuevas y, si ya no se puede, las omite con signingUrlsHint", async () => {
    const payload = {
      subject: "Embebido",
      documents: [{ base64: minimalPdf(), name: "a.pdf" }],
      recipients: [{ name: "Eva", email: "eva@x.test", embedded: true }],
      fields: [{ type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
      send: true,
    };
    const headers = { ...auth, "idempotency-key": "oneshot-embedded-1" };
    const first = await app.inject({ method: "POST", url: "/v1/envelopes", headers, payload });
    expect(first.statusCode, first.body).toBe(201);
    const body = first.json();
    expect(body.signingUrls).toHaveLength(1);
    const url1 = body.signingUrls[0].url as string;
    const code1 = url1.split("/embed/")[1];
    const stored = await db.one<any>(`SELECT response FROM idempotency_keys WHERE tenant_id = $1 AND key LIKE '%|oneshot-embedded-1'`, [tenant]);
    expect(JSON.stringify(stored.response)).not.toContain(code1);
    expect(stored.response.signingUrls).toEqual([{ recipientId: body.signingUrls[0].recipientId }]);

    const again = await app.inject({ method: "POST", url: "/v1/envelopes", headers, payload });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replay"]).toBe("true");
    const r2 = again.json();
    expect(r2.envelope.id).toBe(body.envelope.id);
    expect(r2.signingUrls).toHaveLength(1);
    expect(r2.signingUrls[0].recipientId).toBe(body.signingUrls[0].recipientId);
    // Sin canjear ni vencer: la misma URL (no se emite un código nuevo en cada repetición).
    expect(r2.signingUrls[0].url).toBe(url1);
    expect(r2.signingUrlsHint).toBeUndefined();
    const again2 = await app.inject({ method: "POST", url: "/v1/envelopes", headers, payload });
    expect(again2.json().signingUrls[0].url).toBe(url1);
    const sessions = await db.query<any>(`SELECT used_at, replay_code_enc FROM embed_sessions WHERE envelope_id = $1`, [body.envelope.id]);
    expect(sessions).toHaveLength(1);
    // Canjeada: la próxima repetición emite una nueva (y el código guardado se borra).
    expect((await app.inject({ method: "GET", url: `/embed/${code1}` })).statusCode).toBe(302);
    expect((await db.one<any>(`SELECT replay_code_enc FROM embed_sessions WHERE envelope_id = $1`, [body.envelope.id])).replay_code_enc).toBeNull();
    const again3 = await app.inject({ method: "POST", url: "/v1/envelopes", headers, payload });
    const url3 = String(again3.json().signingUrls[0].url);
    expect(url3).not.toBe(url1);
    // La URL reemitida sirve.
    expect((await app.inject({ method: "GET", url: `/embed/${url3.split("/embed/")[1]}` })).statusCode).toBe(302);

    // Sobre anulado: ya no se puede emitir; se omite con la pista.
    await app.inject({ method: "POST", url: `/v1/envelopes/${body.envelope.id}/void`, headers: auth, payload: { reason: "x" } });
    const third = await app.inject({ method: "POST", url: "/v1/envelopes", headers, payload });
    expect(third.statusCode).toBe(201);
    expect(third.json().signingUrls).toEqual([]);
    expect(third.json().signingUrlsHint).toContain("signing-url");
  }, 60_000);
});

