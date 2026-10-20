// Cobros al firmar y webhooks de cobro sobre PGlite: idempotencia de webhooks hasta terminar, checkouts descartados,
// checkouts simultáneos, reembolsos y disputas del proveedor, plan al enviar y cambio de suscripción sin bloquear la
// organización durante las llamadas al proveedor (Stripe simulado con un fetch falso).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-payments-flow-"));
delete process.env.DATABASE_URL;
process.env.STRIPE_SECRET_KEY = "sk_test_flow";
process.env.STRIPE_API_BASE = "https://stripe.test";

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
const real = globalThis.fetch;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  globalThis.fetch = real;
  await app?.close();
  await db?.close();
});

/** Sobre con un firmante pagador y su link; el cobro con el proveedor y estado pedidos. */
async function setup(o: { status?: string; provider?: string; payStatus?: string; expiresAt?: string | null } = {}) {
  const { randomToken, sha256Hex, uuidv7 } = await import("../src/lib/util");
  const envelope = uuidv7();
  const recipient = uuidv7();
  const payment = uuidv7();
  const token = randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, expires_at) VALUES ($1, $2, 'Contrato', $3, $4)`, [envelope, tenant, o.status ?? "sent", o.expiresAt ?? null]);
  await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash) VALUES ($1,$2,$3,'signer','Ana','ana@x.test','sent',$4)`, [
    recipient,
    tenant,
    envelope,
    sha256Hex(token),
  ]);
  await db.query(
    `INSERT INTO envelope_payments (id, tenant_id, envelope_id, recipient_id, provider, amount, currency, description, timing, status)
     VALUES ($1,$2,$3,$4,$5,100,'USD','Honorarios','before_sign',$6)`,
    [payment, tenant, envelope, recipient, o.provider ?? "mock", o.payStatus ?? "pending"],
  );
  return { envelope, recipient, payment, token };
}

const row = async (id: string) => (await db.one<any>(`SELECT * FROM envelope_payments WHERE id = $1`, [id]))!;
const events = async (envelope: string, type: string) => db.query<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = $2`, [envelope, type]);

describe("webhooks de cobro: idempotencia hasta terminar", () => {
  it("en curso → 409; terminado → duplicate; fallado → se reprocesa; abandonado → se reprocesa", async () => {
    const { claimWebhookEvent, processWebhookEvent, WEBHOOK_IN_PROGRESS_SECONDS } = await import("../src/modules/billing/webhooks");
    // Mientras el primero procesa, el reintento del proveedor ve el evento en curso (antes: 200 duplicate).
    let inside: string | undefined;
    const first = await processWebhookEvent(db, "stripe", "evt_a", async () => {
      inside = await claimWebhookEvent(db, "stripe", "evt_a");
    });
    expect(first).toBe("new");
    expect(inside).toBe("in_progress");
    expect(await claimWebhookEvent(db, "stripe", "evt_a")).toBe("duplicate");

    // Si el manejador falla, la marca se borra y el reintento lo procesa.
    await expect(processWebhookEvent(db, "stripe", "evt_b", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    let ran = 0;
    expect(await processWebhookEvent(db, "stripe", "evt_b", async () => void ran++)).toBe("new");
    expect(ran).toBe(1);

    // El proceso murió sin terminar ni borrar la marca: reciente → en curso; viejo → se vuelve a tomar.
    await db.query(`INSERT INTO payment_webhook_events (provider, event_id) VALUES ('mercadopago', 'evt_c')`);
    expect(await claimWebhookEvent(db, "mercadopago", "evt_c")).toBe("in_progress");
    await db.query(`UPDATE payment_webhook_events SET received_at = now() - make_interval(secs => $1) WHERE event_id = 'evt_c'`, [WEBHOOK_IN_PROGRESS_SECONDS + 5]);
    expect(await processWebhookEvent(db, "mercadopago", "evt_c", async () => void ran++)).toBe("new");
    expect(ran).toBe(2);
    expect((await db.one<any>(`SELECT processed_at FROM payment_webhook_events WHERE event_id = 'evt_c'`))!.processed_at).not.toBeNull();
  });
});

describe("checkouts descartados", () => {
  it("se acumulan, el barrido cierra todos y un pago por uno descartado no se acredita (mismo destinatario)", async () => {
    const { DISCARD_CHECKOUT_SET, closeStaleCheckouts, markPaymentPaid, markPaymentFailed } = await import("../src/modules/billing/payments");
    const s = await setup({ payStatus: "checkout_created" });
    await db.query(`UPDATE envelope_payments SET checkout_id = 'mock_1', checkout_ref = 'mock_1', checkout_url = 'u1' WHERE id = $1`, [s.payment]);
    await db.query(`UPDATE envelope_payments SET ${DISCARD_CHECKOUT_SET} WHERE id = $1`, [s.payment]);
    await db.query(`UPDATE envelope_payments SET checkout_id = 'mock_2', checkout_url = 'u2' WHERE id = $1`, [s.payment]); // sin checkout_ref (anterior a 0063)
    await db.query(`UPDATE envelope_payments SET ${DISCARD_CHECKOUT_SET} WHERE id = $1`, [s.payment]);
    let p = await row(s.payment);
    expect(p.stale_checkout_ids).toEqual(["mock_1", "mock_2"]); // antes el segundo pisaba al primero
    expect(p.discarded_checkout_refs).toEqual(["mock_1", "mock_2"]);
    expect(p.checkout_id).toBeNull();

    // Pago del contacto anterior por el checkout descartado: mismo recipientId, pero se reembolsa (duplicate).
    const res = await markPaymentPaid(db, s.payment, { providerPaymentId: "pi_old", receipt: {}, payerRecipientId: s.recipient, checkoutRef: "mock_1" });
    expect(res).toEqual({ duplicate: "pi_old" });
    expect((await row(s.payment)).status).toBe("checkout_created");
    // Un rechazo de ese checkout tampoco toca el cobro actual.
    await markPaymentFailed(db, s.payment, "rechazado", s.recipient, { checkoutRef: "mock_2", ref: "x" });
    expect(await events(s.envelope, "payment.failed")).toHaveLength(0);

    const errors: unknown[] = [];
    await closeStaleCheckouts({ db, log: { error: (o) => errors.push(o) } });
    expect(errors).toEqual([]);
    expect((await row(s.payment)).stale_checkout_ids).toEqual([]);
    p = await row(s.payment);
    expect(p.discarded_checkout_refs).toEqual(["mock_1", "mock_2"]); // la lista de descartados es permanente

    // El checkout vigente sí se acredita.
    expect(await markPaymentPaid(db, s.payment, { providerPaymentId: "pi_new", receipt: {}, payerRecipientId: s.recipient, checkoutRef: "mock_3" })).toBeUndefined();
    expect((await row(s.payment)).status).toBe("paid");
  });

  it("un rechazo reprocesado no suma otro payment.failed", async () => {
    const { markPaymentFailed } = await import("../src/modules/billing/payments");
    const s = await setup({ payStatus: "checkout_created" });
    await markPaymentFailed(db, s.payment, "rechazado", null, { ref: "cs_1" });
    await db.query(`UPDATE envelope_payments SET status = 'checkout_created' WHERE id = $1`, [s.payment]);
    await markPaymentFailed(db, s.payment, "rechazado", null, { ref: "cs_1" });
    expect(await events(s.envelope, "payment.failed")).toHaveLength(1);
    expect((await row(s.payment)).status).toBe("checkout_created");
  });
});

describe("checkout del firmante", () => {
  it("vencido sin marcar: no se ofrece pagar ni se crea checkout", async () => {
    const s = await setup({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const info = await app.inject({ method: "GET", url: `/v1/signing/${s.token}/payment` });
    expect(info.statusCode).toBe(200);
    expect(info.json().canPay).toBe(false);
    const c = await app.inject({ method: "POST", url: `/v1/signing/${s.token}/payment/checkout` });
    expect(c.statusCode).toBe(409);
    expect((await row(s.payment)).checkout_id).toBeNull();
  });

  it("dos pedidos simultáneos entregan el mismo checkout y el otro queda para cerrar", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/signing/${s.token}/payment/checkout` }),
      app.inject({ method: "POST", url: `/v1/signing/${s.token}/payment/checkout` }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const p = await row(s.payment);
    expect(a.json().url).toBe(b.json().url);
    expect(p.checkout_url).toBe(a.json().url);
    expect(p.stale_checkout_ids).toHaveLength(1);
    expect(p.stale_checkout_ids[0]).not.toBe(p.checkout_id);
    expect(await events(s.envelope, "payment.checkout_created")).toHaveLength(1);
  });
});

describe("reembolsos y disputas informados por el proveedor", () => {
  it("Stripe charge.refunded total: cobro reembolsado, evento una vez, sobre sin cambios ni trabado", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const { paymentBlocksCompletion } = await import("../src/modules/billing/payments");
    const { SYSTEM } = await import("../src/infra/evidence");
    const s = await setup({ provider: "stripe", payStatus: "paid" });
    await db.query(`UPDATE envelope_payments SET provider_payment_id = 'pi_1', paid_at = now() WHERE id = $1`, [s.payment]);
    // Reembolso de un cobro duplicado (otro PaymentIntent): no toca el cobro.
    await handleStripeEvent(db, { type: "charge.refunded", data: { object: { payment_intent: "pi_dup", amount: 10000, amount_refunded: 10000, refunded: true } } });
    expect((await row(s.payment)).status).toBe("paid");
    // Parcial: solo el evento.
    await handleStripeEvent(db, { type: "charge.refunded", data: { object: { payment_intent: "pi_1", amount: 10000, amount_refunded: 2500, refunded: false } } });
    expect((await row(s.payment)).status).toBe("paid");
    expect((await events(s.envelope, "payment.partially_refunded"))[0].data.amountRefunded).toBe(25);
    const full = { type: "charge.refunded", data: { object: { payment_intent: "pi_1", amount: 10000, amount_refunded: 10000, refunded: true } } };
    await handleStripeEvent(db, full);
    await handleStripeEvent(db, full);
    const p = await row(s.payment);
    expect(p.status).toBe("refunded");
    expect(p.refunded_at).not.toBeNull();
    const ev = await events(s.envelope, "payment.refunded");
    expect(ev).toHaveLength(1);
    expect(ev[0].data.reason).toBe("provider");
    expect((await db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [s.envelope]))!.status).toBe("sent");
    expect(await paymentBlocksCompletion(db, tenant, s.envelope, SYSTEM)).toBe(false);
    // Ni la firma (before_sign) queda trabada.
    const info = await app.inject({ method: "GET", url: `/v1/signing/${s.token}/payment` });
    expect(info.json().blocksSigning).toBe(false);
  });

  it("Stripe charge.dispute.created y Mercado Pago charged_back marcan la disputa una vez", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const { markPaymentDisputed, toPayment } = await import("../src/modules/billing/payments");
    const s = await setup({ provider: "stripe", payStatus: "paid" });
    await db.query(`UPDATE envelope_payments SET provider_payment_id = 'pi_2', paid_at = now() WHERE id = $1`, [s.payment]);
    const dispute = { type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: "pi_2", amount: 10000, reason: "fraudulent" } } };
    await handleStripeEvent(db, dispute);
    await handleStripeEvent(db, dispute);
    const p = await row(s.payment);
    expect(p.status).toBe("paid");
    expect(toPayment(p).disputedAt).not.toBeNull();
    const ev = await events(s.envelope, "payment.disputed");
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ disputeId: "dp_1", reason: "fraudulent", amount: 100 });

    const m = await setup({ provider: "mercadopago", payStatus: "paid" });
    await db.query(`UPDATE envelope_payments SET provider_payment_id = '777', paid_at = now() WHERE id = $1`, [m.payment]);
    await markPaymentDisputed(db, "mercadopago", "777", { disputeId: "mp:777", reason: "charged_back" });
    await markPaymentDisputed(db, "mercadopago", "777", { disputeId: "mp:777", reason: "charged_back" });
    expect(await events(m.envelope, "payment.disputed")).toHaveLength(1);
    expect((await row(m.payment)).disputed_at).not.toBeNull();
  });
});

describe("envío de un borrador con cobro", () => {
  it("exige el plan con cobros (402) en sendEnvelope", async () => {
    const { sendEnvelope } = await import("../src/modules/envelopes");
    const { SYSTEM } = await import("../src/infra/evidence");
    const s = await setup({ status: "draft" });
    await db.query(`UPDATE tenants SET billing_plan = 'starter' WHERE id = $1`, [tenant]);
    try {
      const err = await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e);
      expect(err.statusCode ?? err.status).toBe(402);
      expect(err.code).toBe("plan_limit");
      // Con un plan que lo incluye pasa ese control (y falla después por el borrador incompleto).
      await db.query(`UPDATE tenants SET billing_plan = 'business' WHERE id = $1`, [tenant]);
      const err2 = await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e);
      expect(err2.code).toBe("envelope_incomplete");
    } finally {
      await db.query(`UPDATE tenants SET billing_plan = NULL WHERE id = $1`, [tenant]);
    }
  });
});

describe("cambio de suscripción", () => {
  it("cancela la anterior fuera del bloqueo y revalida: una confirmación simultánea también se cancela", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const { uuidv7 } = await import("../src/lib/util");
    const t2 = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name, billing_provider, subscription_id) VALUES ($1, $2, 'T2', 'stripe', 'sub_old')`, [t2, `t-${t2.slice(-8)}`]);
    const deleted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (init?.method === "DELETE") {
        const id = url.split("/").pop()!;
        deleted.push(id);
        // Durante la llamada al proveedor otra confirmación cambia la suscripción vigente. Con la organización bloqueada
        // (como antes) esta escritura esperaría al lock y la prueba se colgaría.
        if (id === "sub_old") await db.query(`UPDATE tenants SET subscription_id = 'sub_mid' WHERE id = $1`, [t2]);
        return json({ id, status: "canceled" });
      }
      return json({ id: "sub_new", current_period_end: 1_900_000_000 });
    }) as typeof fetch;
    try {
      await handleStripeEvent(db, {
        type: "checkout.session.completed",
        data: { object: { mode: "subscription", payment_status: "paid", subscription: "sub_new", customer: "cus_1", metadata: { tenantId: t2, plan: "business" } } },
      });
    } finally {
      globalThis.fetch = real;
    }
    expect(deleted).toEqual(["sub_old", "sub_mid"]);
    const t = await db.one<any>(`SELECT billing_plan, subscription_id, billing_provider FROM tenants WHERE id = $1`, [t2]);
    expect(t).toMatchObject({ billing_plan: "business", subscription_id: "sub_new", billing_provider: "stripe" });
  });
});
