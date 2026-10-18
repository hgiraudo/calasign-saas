// Cobros y suscripciones: verificación de firma de webhooks y armado/lectura de pedidos a Stripe y Mercado Pago.
// Las fixtures siguen la documentación pública de cada proveedor; las APIs se simulan con un servidor HTTP local.
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let base = "";
const calls: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const replies = new Map<string, { status: number; body: unknown }>();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const r = replies.get(`${req.method} ${req.url!.split("?")[0]}`) ?? { status: 404, body: { message: "not found" } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  process.env.STRIPE_SECRET_KEY = "sk_test_123";
  process.env.STRIPE_API_BASE = base;
  process.env.MP_ACCESS_TOKEN = "TEST-123";
  process.env.MP_API_BASE = base;
});
afterAll(() => server.close());

const load = () => import("../src/modules/billing/providers");

describe("Stripe", () => {
  it("verifica Stripe-Signature (t=…,v1=…) con tolerancia de tiempo", async () => {
    const { verifyStripeSignature } = await load();
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const secret = "whsec_test";
    const t = 1_700_000_000;
    const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    expect(verifyStripeSignature(payload, `t=${t},v1=${v1}`, secret, 300, t + 10)).toBe(true);
    // Varias firmas (rotación de secreto): alcanza con una válida.
    expect(verifyStripeSignature(payload, `t=${t},v1=${"0".repeat(64)},v1=${v1}`, secret, 300, t)).toBe(true);
    expect(verifyStripeSignature(payload, `t=${t},v1=${v1}`, "otro", 300, t)).toBe(false);
    expect(verifyStripeSignature(payload + " ", `t=${t},v1=${v1}`, secret, 300, t)).toBe(false);
    expect(verifyStripeSignature(payload, `t=${t},v1=${v1}`, secret, 300, t + 301)).toBe(false); // repetición tardía
    expect(verifyStripeSignature(payload, undefined, secret)).toBe(false);
    expect(verifyStripeSignature(payload, "v1=abc", secret)).toBe(false);
  });

  it("codifica parámetros anidados como x-www-form-urlencoded de Stripe", async () => {
    const { stripeForm } = await load();
    const s = stripeForm({ mode: "payment", metadata: { paymentId: "p1" }, line_items: [{ quantity: 1, price_data: { currency: "brl", unit_amount: 15050 } }], skip: undefined });
    expect(decodeURIComponent(s)).toBe("mode=payment&metadata[paymentId]=p1&line_items[0][quantity]=1&line_items[0][price_data][currency]=brl&line_items[0][price_data][unit_amount]=15050");
  });

  it("crea un Checkout de pago con el monto en centavos y la metadata del cobro", async () => {
    const { stripeCreatePaymentCheckout } = await load();
    replies.set("POST /v1/checkout/sessions", { status: 200, body: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } });
    calls.length = 0;
    const r = await stripeCreatePaymentCheckout({
      amount: 150.5,
      currency: "BRL",
      description: "Honorarios",
      successUrl: "https://dev/s/t?payment=success",
      cancelUrl: "https://dev/s/t?payment=cancel",
      metadata: { paymentId: "pay_1", envelopeId: "env_1", tenantId: "ten_1" },
    });
    expect(r).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const body = new URLSearchParams(calls[0].body);
    expect(calls[0].headers.authorization).toBe("Bearer sk_test_123");
    expect(body.get("mode")).toBe("payment");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("15050");
    expect(body.get("line_items[0][price_data][currency]")).toBe("brl");
    expect(body.get("metadata[paymentId]")).toBe("pay_1");
    expect(body.get("client_reference_id")).toBe("pay_1");
    expect(body.has("payment_method_types[0]")).toBe(false); // los medios (Pix, tarjeta) los define la cuenta
  });

  it("crea un Checkout de suscripción mensual", async () => {
    const { stripeCreateSubscriptionCheckout } = await load();
    replies.set("POST /v1/checkout/sessions", { status: 200, body: { id: "cs_sub", url: "https://checkout.stripe.com/c/pay/cs_sub" } });
    calls.length = 0;
    await stripeCreateSubscriptionCheckout({ planName: "Business", amount: 49, currency: "USD", successUrl: "s", cancelUrl: "c", metadata: { tenantId: "t1", plan: "business" }, customerEmail: "a@b.c" });
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][price_data][recurring][interval]")).toBe("month");
    expect(body.get("subscription_data[metadata][plan]")).toBe("business");
    expect(body.get("customer_email")).toBe("a@b.c");
  });

  it("propaga el error de la API como ProviderError", async () => {
    const { stripeCreatePortal, ProviderError } = await load();
    replies.set("POST /v1/billing_portal/sessions", { status: 400, body: { error: { message: "No such customer" } } });
    await expect(stripeCreatePortal("cus_x", "https://dev")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("Mercado Pago", () => {
  it("verifica x-signature con el manifiesto id;request-id;ts (ejemplo de la documentación)", async () => {
    const { verifyMercadoPagoSignature } = await load();
    const secret = "mp-secret";
    const ts = "1704908010";
    const manifest = "id:123456789;request-id:bb56a2f1-6aae-46ac-982e-9dcd3581d08e;ts:1704908010;";
    const v1 = createHmac("sha256", secret).update(manifest).digest("hex");
    const ok = (x: Partial<Parameters<typeof verifyMercadoPagoSignature>[0]>) =>
      verifyMercadoPagoSignature({ xSignature: `ts=${ts},v1=${v1}`, xRequestId: "bb56a2f1-6aae-46ac-982e-9dcd3581d08e", dataId: "123456789", secret, ...x });
    expect(ok({})).toBe(true);
    expect(ok({ dataId: "123456780" })).toBe(false);
    expect(ok({ xRequestId: "otro" })).toBe(false);
    expect(ok({ secret: "otro" })).toBe(false);
    expect(ok({ xSignature: undefined })).toBe(false);
    // data.id alfanumérico va en minúsculas en el manifiesto.
    const v1b = createHmac("sha256", secret).update("id:abc123;request-id:r;ts:1;").digest("hex");
    expect(verifyMercadoPagoSignature({ xSignature: `ts=1,v1=${v1b}`, xRequestId: "r", dataId: "ABC123", secret })).toBe(true);
    // Tolerancia opcional (ts en milisegundos).
    expect(ok({ toleranceSec: 60, nowMs: Number(ts) + 10_000 })).toBe(true);
    expect(ok({ toleranceSec: 5, nowMs: Number(ts) + 10_000 })).toBe(false);
  });

  it("crea una preferencia de Checkout Pro (sandbox con token TEST-) y lee un pago", async () => {
    const { mpCreatePreference, mpGetPayment } = await load();
    replies.set("POST /checkout/preferences", {
      status: 201,
      body: { id: "pref_1", init_point: "https://www.mercadopago.com/checkout?pref_id=pref_1", sandbox_init_point: "https://sandbox.mercadopago.com/checkout?pref_id=pref_1" },
    });
    calls.length = 0;
    const p = await mpCreatePreference({
      title: "Reserva",
      amount: 25000,
      currency: "COP",
      externalReference: "pay:abc",
      notificationUrl: "https://dev/v1/integrations/payments/mercadopago/webhook",
      successUrl: "s",
      failureUrl: "f",
    });
    expect(p.url).toContain("sandbox");
    const sent = JSON.parse(calls[0].body);
    expect(sent.items[0]).toEqual({ title: "Reserva", quantity: 1, unit_price: 25000, currency_id: "COP" });
    expect(sent.external_reference).toBe("pay:abc");
    expect(calls[0].headers.authorization).toBe("Bearer TEST-123");

    // GET /v1/payments/{id} (respuesta resumida de la documentación).
    replies.set("GET /v1/payments/1234", {
      status: 200,
      body: { id: 1234, status: "approved", external_reference: "pay:abc", transaction_amount: 25000, currency_id: "COP", date_approved: "2026-10-17T12:00:00.000-04:00", payment_method_id: "pse" },
    });
    const pay = await mpGetPayment("1234");
    expect(pay).toEqual({ id: "1234", status: "approved", externalReference: "pay:abc", amount: 25000, currency: "COP", approvedAt: "2026-10-17T12:00:00.000-04:00", method: "pse" });
  });

  it("crea y consulta una suscripción (preapproval)", async () => {
    const { mpCreatePreapproval, mpGetPreapproval } = await load();
    replies.set("POST /preapproval", { status: 201, body: { id: "pre_1", init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=pre_1" } });
    calls.length = 0;
    await mpCreatePreapproval({ reason: "CalaSign Business", externalReference: "sub:t:business", payerEmail: "a@b.c", amount: 249, currency: "BRL", backUrl: "b" });
    const sent = JSON.parse(calls[0].body);
    expect(sent.auto_recurring).toEqual({ frequency: 1, frequency_type: "months", transaction_amount: 249, currency_id: "BRL" });
    replies.set("GET /preapproval/pre_1", { status: 200, body: { id: "pre_1", status: "authorized", external_reference: "sub:t:business", next_payment_date: "2026-11-17T00:00:00.000-03:00" } });
    expect(await mpGetPreapproval("pre_1")).toEqual({ id: "pre_1", status: "authorized", externalReference: "sub:t:business", nextPaymentDate: "2026-11-17T00:00:00.000-03:00" });
  });
});

describe("Planes", () => {
  it("cada plan superior incluye lo del anterior y el precio local existe", async () => {
    const { PLANS, PLAN_IDS, PLAN_PRICES, BILLING_CURRENCIES } = await import("@calasign/shared");
    for (let i = 1; i < PLAN_IDS.length; i++) {
      const prev = PLANS[PLAN_IDS[i - 1]];
      const cur = PLANS[PLAN_IDS[i]];
      for (const f of prev.features) expect(cur.features).toContain(f);
      if (cur.envelopesPerMonth !== null && prev.envelopesPerMonth !== null) expect(cur.envelopesPerMonth).toBeGreaterThan(prev.envelopesPerMonth);
    }
    for (const p of ["starter", "business", "enterprise"] as const) for (const c of BILLING_CURRENCIES) expect(PLAN_PRICES[p][c]).toBeGreaterThan(0);
  });

  it("toMinorUnits redondea a centavos", async () => {
    const { toMinorUnits } = await load();
    expect(toMinorUnits(150.5)).toBe(15050);
    expect(toMinorUnits(0.1 + 0.2)).toBe(30);
  });
});
