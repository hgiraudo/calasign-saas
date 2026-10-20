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
process.env.MP_ACCESS_TOKEN = "TEST-flow";
process.env.MP_API_BASE = "https://mp.test";

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
const KEY = "cs_test_payments_flow_key";
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
  const { sha256Hex } = await import("../src/lib/util");
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
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
      inside = (await claimWebhookEvent(db, "stripe", "evt_a")).status;
    });
    expect(first).toBe("new");
    expect(inside).toBe("in_progress");
    expect((await claimWebhookEvent(db, "stripe", "evt_a")).status).toBe("duplicate");

    // Si el manejador falla, la marca se borra y el reintento lo procesa.
    await expect(processWebhookEvent(db, "stripe", "evt_b", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    let ran = 0;
    expect(await processWebhookEvent(db, "stripe", "evt_b", async () => void ran++)).toBe("new");
    expect(ran).toBe(1);

    // El proceso murió sin terminar ni borrar la marca: reciente → en curso; viejo → se vuelve a tomar.
    await db.query(`INSERT INTO payment_webhook_events (provider, event_id) VALUES ('mercadopago', 'evt_c')`);
    expect((await claimWebhookEvent(db, "mercadopago", "evt_c")).status).toBe("in_progress");
    await db.query(`UPDATE payment_webhook_events SET received_at = now() - make_interval(secs => $1) WHERE event_id = 'evt_c'`, [WEBHOOK_IN_PROGRESS_SECONDS + 5]);
    expect(await processWebhookEvent(db, "mercadopago", "evt_c", async () => void ran++)).toBe("new");
    expect(ran).toBe(2);
    expect((await db.one<any>(`SELECT processed_at FROM payment_webhook_events WHERE event_id = 'evt_c'`))!.processed_at).not.toBeNull();
  });

  it("la marca es de quien la tomó: el primero, retomado por otro, no la suelta al fallar; terminar la recrea si no está", async () => {
    const { claimWebhookEvent, processWebhookEvent, WEBHOOK_IN_PROGRESS_SECONDS } = await import("../src/modules/billing/webhooks");
    expect(WEBHOOK_IN_PROGRESS_SECONDS).toBeGreaterThanOrEqual(600);
    const age = (id: string) =>
      db.query(`UPDATE payment_webhook_events SET received_at = now() - make_interval(secs => $1) WHERE event_id = $2`, [WEBHOOK_IN_PROGRESS_SECONDS + 5, id]);
    // A tarda más que el umbral, B lo retoma; A falla: la marca de B sigue (antes A la borraba y un tercero lo reprocesaba).
    let b: Awaited<ReturnType<typeof claimWebhookEvent>> | undefined;
    await expect(
      processWebhookEvent(db, "stripe", "evt_d", async () => {
        await age("evt_d");
        b = await claimWebhookEvent(db, "stripe", "evt_d");
        throw new Error("A falla");
      }),
    ).rejects.toThrow("A falla");
    expect(b?.status).toBe("new");
    const r = await db.one<any>(`SELECT claim_id, processed_at FROM payment_webhook_events WHERE event_id = 'evt_d'`);
    expect(r).toMatchObject({ claim_id: b!.claimId, processed_at: null });
    expect((await claimWebhookEvent(db, "stripe", "evt_d")).status).toBe("in_progress");

    // A termina bien aunque otro haya retomado y borrado la marca: se vuelve a crear como procesado.
    expect(
      await processWebhookEvent(db, "stripe", "evt_e", async () => {
        await db.query(`DELETE FROM payment_webhook_events WHERE event_id = 'evt_e'`);
      }),
    ).toBe("new");
    expect((await claimWebhookEvent(db, "stripe", "evt_e")).status).toBe("duplicate");
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

describe("pago previo y sobre cerrado", () => {
  const complete = (token: string) => app.inject({ method: "POST", url: `/v1/signing/${token}/complete`, payload: { fields: [] } });
  it("abierto con el pago pendiente: 402 payment_required", async () => {
    const s = await setup();
    const r = await complete(s.token);
    expect(r.statusCode).toBe(402);
    expect(r.json().code ?? r.json().error?.code).toBe("payment_required");
  });
  it("anulado o vencido sin marcar: no exige el pago, responde 410 (antes 402 con un pago imposible)", async () => {
    for (const o of [{ status: "voided" }, { expiresAt: new Date(Date.now() - 60_000).toISOString() }]) {
      const s = await setup(o);
      const r = await complete(s.token);
      expect(r.statusCode).toBe(410);
    }
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

  it("tras bajar a un plan sin cobros, el cobro se ve y se quita (solo configurarlo exige el plan) y el envío ya no da 402", async () => {
    const { sendEnvelope } = await import("../src/modules/envelopes");
    const { SYSTEM } = await import("../src/infra/evidence");
    const s = await setup({ status: "draft" });
    const auth = { authorization: `Bearer ${KEY}` };
    const url = `/v1/envelopes/${s.envelope}/payment`;
    // Starter tiene API pero no cobros.
    await db.query(`UPDATE tenants SET billing_plan = 'starter' WHERE id = $1`, [tenant]);
    try {
      expect((await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e)).code).toBe("plan_limit");
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(200);
      const put = await app.inject({
        method: "PUT",
        url,
        headers: auth,
        payload: { provider: "mock", amount: 10, currency: "USD", description: "x", timing: "before_sign", payerRecipientId: s.recipient },
      });
      expect(put.statusCode).toBe(402);
      expect((await app.inject({ method: "DELETE", url, headers: auth })).statusCode).toBe(204);
      expect(await db.one(`SELECT 1 FROM envelope_payments WHERE envelope_id = $1`, [s.envelope])).toBeFalsy();
      // Sin cobro el control del plan ya no aplica (falla después por el borrador incompleto: sin documentos).
      expect((await db.tx((t) => sendEnvelope(t, tenant, s.envelope, SYSTEM)).catch((e) => e)).code).toBe("envelope_incomplete");
    } finally {
      await db.query(`UPDATE tenants SET billing_plan = NULL WHERE id = $1`, [tenant]);
    }
  });
});

describe("cambio de suscripción", () => {
  /** Organización con una suscripción vigente y un Stripe falso que registra las cancelaciones. */
  async function org(provider: string, sub: string, plan = "starter") {
    const { uuidv7 } = await import("../src/lib/util");
    const id = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name, billing_plan, billing_provider, subscription_id) VALUES ($1, $2, 'T2', $3, $4, $5)`, [
      id,
      `t-${id.slice(-8)}`,
      plan,
      provider,
      sub,
    ]);
    return id;
  }
  const tenantRow = (id: string) => db.one<any>(`SELECT billing_plan, subscription_id, billing_provider FROM tenants WHERE id = $1`, [id]);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const completed = (tenantId: string, sub: string) => ({
    type: "checkout.session.completed",
    data: { object: { mode: "subscription", payment_status: "paid", subscription: sub, customer: "cus_1", metadata: { tenantId, plan: "business" } } },
  });

  it("aplica la nueva antes de cancelar la anterior: la baja de la anterior que llega en medio se ignora", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_old");
    const deleted: string[] = [];
    let during: any;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        const id = url.split("/").pop()!;
        deleted.push(id);
        // Al cancelarla en Stripe llega su customer.subscription.deleted (antes podía llegar con sub_old todavía vigente
        // y bajar la organización a Free). La organización no está bloqueada: si lo estuviera, esto se colgaría.
        during = await tenantRow(t2);
        await handleStripeEvent(db, { type: "customer.subscription.deleted", data: { object: { id, status: "canceled", customer: "cus_1", metadata: { tenantId: t2 } } } });
        return json({ id, status: "canceled" });
      }
      return json({ id: "sub_new", status: "active", current_period_end: 1_900_000_000 });
    }) as typeof fetch;
    try {
      await handleStripeEvent(db, completed(t2, "sub_new"));
    } finally {
      globalThis.fetch = real;
    }
    expect(deleted).toEqual(["sub_old"]);
    expect(during).toMatchObject({ billing_plan: "business", subscription_id: "sub_new" });
    expect(await tenantRow(t2)).toMatchObject({ billing_plan: "business", subscription_id: "sub_new", billing_provider: "stripe" });
    // La fila queda como constancia (cancelada), no se borra.
    expect(await db.query(`SELECT subscription_id FROM subscription_cancellations WHERE tenant_id = $1 AND done_at IS NOT NULL`, [t2])).toEqual([{ subscription_id: "sub_old" }]);
  });

  it("si la cancelación falla, el plan queda aplicado y el barrido la reintenta", async () => {
    const { handleStripeEvent, cancelPendingSubscriptions } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_old2");
    let fail = true;
    const deleted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        if (fail) return json({ error: { message: "caído" } }, 500);
        deleted.push(String(input).split("/").pop()!);
        return json({ status: "canceled" });
      }
      return json({ id: "sub_new2", status: "active", current_period_end: 1_900_000_000 });
    }) as typeof fetch;
    const errors: object[] = [];
    try {
      await handleStripeEvent(db, completed(t2, "sub_new2"));
      expect(await tenantRow(t2)).toMatchObject({ billing_plan: "business", subscription_id: "sub_new2" });
      const pending = await db.one<any>(`SELECT attempts, last_error FROM subscription_cancellations WHERE provider = 'stripe' AND subscription_id = 'sub_old2'`);
      expect(pending?.attempts).toBe(1);
      // Reciente: el barrido no la toma (para no pisarse con la cancelación inmediata).
      fail = false;
      await cancelPendingSubscriptions({ db, log: { error: (o) => void errors.push(o) } });
      expect(deleted).toEqual([]);
      await db.query(`UPDATE subscription_cancellations SET attempted_at = now() - interval '5 minutes' WHERE subscription_id = 'sub_old2'`);
      await cancelPendingSubscriptions({ db, log: { error: (o) => void errors.push(o) } });
    } finally {
      globalThis.fetch = real;
    }
    expect(errors).toEqual([]);
    expect(deleted).toEqual(["sub_old2"]);
    expect(await db.query(`SELECT 1 FROM subscription_cancellations WHERE subscription_id = 'sub_old2' AND done_at IS NULL`)).toHaveLength(0);
  });

  it("dos confirmaciones seguidas: cada una cancela la que reemplazó y queda la última", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_a");
    const deleted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(String(input).split("/").pop()!);
        return json({ status: "canceled" });
      }
      return json({ status: "active", current_period_end: 1_900_000_000 });
    }) as typeof fetch;
    try {
      await Promise.all([handleStripeEvent(db, completed(t2, "sub_b")), handleStripeEvent(db, completed(t2, "sub_c"))]);
    } finally {
      globalThis.fetch = real;
    }
    const t = await tenantRow(t2);
    expect(["sub_b", "sub_c"]).toContain(t.subscription_id);
    // Se cancelan la original y la que no quedó; nunca la vigente.
    expect(deleted.sort()).toEqual(["sub_a", t.subscription_id === "sub_b" ? "sub_c" : "sub_b"].sort());
  });

  it("Mercado Pago: una autorización atrasada de un checkout más viejo se cancela y no pisa la vigente", async () => {
    const { handleMercadoPagoNotification } = await import("../src/modules/billing/webhooks");
    const { uuidv7 } = await import("../src/lib/util");
    const t2 = await org("mercadopago", "pre_new", "business");
    const checkout = (ref: string, ago: string) =>
      db.query(`INSERT INTO billing_checkouts (id, tenant_id, provider, plan, currency, amount, provider_ref, created_at) VALUES ($1,$2,'mercadopago','starter','USD',10,$3, now() - $4::interval)`, [
        uuidv7(),
        t2,
        ref,
        ago,
      ]);
    await checkout("pre_old", "2 days");
    await checkout("pre_new", "1 day");
    const cancelled: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const id = String(input).split("/").pop()!;
      if (init?.method === "PUT") {
        cancelled.push(id);
        return json({ id, status: "cancelled" });
      }
      return json({ id, status: "authorized", external_reference: `sub:${t2}:starter`, next_payment_date: null });
    }) as typeof fetch;
    try {
      await handleMercadoPagoNotification(db, "subscription_preapproval", "pre_old");
    } finally {
      globalThis.fetch = real;
    }
    expect(cancelled).toEqual(["pre_old"]);
    expect(await tenantRow(t2)).toMatchObject({ billing_plan: "business", subscription_id: "pre_new", billing_provider: "mercadopago" });
  });

  it("si la reemplazada volvió a ser la vigente antes de cancelarla, el barrido no la cancela", async () => {
    const { cancelPendingSubscriptions } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_back");
    await db.query(`INSERT INTO subscription_cancellations (provider, subscription_id, tenant_id, attempted_at) VALUES ('stripe', 'sub_back', $1, now() - interval '5 minutes')`, [t2]);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return json({});
    }) as typeof fetch;
    try {
      await cancelPendingSubscriptions({ db, log: { error: () => {} } });
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(0);
    expect(await db.query(`SELECT 1 FROM subscription_cancellations WHERE subscription_id = 'sub_back'`)).toHaveLength(0);
  });
  it("un alta vieja reprocesada no vuelve a aplicar la cancelada ni cancela la vigente", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_s3");
    // B aplicó sub_s3 y canceló sub_s2 (que había aplicado A sin marcarse procesada).
    await db.query(`INSERT INTO subscription_cancellations (provider, subscription_id, tenant_id, done_at) VALUES ('stripe', 'sub_s2', $1, now())`, [t2]);
    const deleted: string[] = [];
    let status = "canceled";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(String(input).split("/").pop()!);
        return json({ status: "canceled" });
      }
      return json({ id: "sub_s2", status, current_period_end: 1_900_000_000 });
    }) as typeof fetch;
    try {
      // Stripe reintenta el alta de A: la suscripción ya está cancelada en Stripe.
      await handleStripeEvent(db, completed(t2, "sub_s2"));
      expect(await tenantRow(t2)).toMatchObject({ subscription_id: "sub_s3", billing_provider: "stripe" });
      // Aunque Stripe todavía la vea activa (cancelación pendiente), una reemplazada no se vuelve a aplicar.
      status = "active";
      await handleStripeEvent(db, completed(t2, "sub_s2"));
    } finally {
      globalThis.fetch = real;
    }
    expect(deleted).toEqual([]);
    expect(await tenantRow(t2)).toMatchObject({ subscription_id: "sub_s3", billing_provider: "stripe" });
  });

  it("alta para una organización inexistente: la suscripción nueva se cancela", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const { uuidv7 } = await import("../src/lib/util");
    const ghost = uuidv7();
    const deleted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(String(input).split("/").pop()!);
        return json({ status: "canceled" });
      }
      return json({ status: "active", current_period_end: 1_900_000_000 });
    }) as typeof fetch;
    try {
      await handleStripeEvent(db, completed(ghost, "sub_orphan"));
    } finally {
      globalThis.fetch = real;
    }
    expect(deleted).toEqual(["sub_orphan"]);
    expect(await db.one<any>(`SELECT tenant_id, done_at IS NOT NULL AS done FROM subscription_cancellations WHERE subscription_id = 'sub_orphan'`)).toMatchObject({ tenant_id: ghost, done: true });
  });

  it("barrido: backoff por intentos, máximo de intentos y sin tomar la misma fila dos veces", async () => {
    const { cancelPendingSubscriptions, SUBSCRIPTION_CANCEL_MAX_ATTEMPTS } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_cur_bk");
    const ins = (id: string, attempts: number, ago: string) =>
      db.query(`INSERT INTO subscription_cancellations (provider, subscription_id, tenant_id, attempts, attempted_at) VALUES ('stripe', $1, $2, $3, now() - $4::interval)`, [id, t2, attempts, ago]);
    await ins("sub_bk_wait", 3, "5 minutes"); // backoff de 8 min: todavía no
    await ins("sub_bk_due", 3, "9 minutes");
    await ins("sub_bk_max", SUBSCRIPTION_CANCEL_MAX_ATTEMPTS, "30 days"); // agotada: no se reintenta
    const deleted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") deleted.push(String(input).split("/").pop()!);
      return json({ status: "canceled" });
    }) as typeof fetch;
    const errors: object[] = [];
    try {
      const log = { error: (o: object) => void errors.push(o) };
      await Promise.all([cancelPendingSubscriptions({ db, log }), cancelPendingSubscriptions({ db, log })]);
    } finally {
      globalThis.fetch = real;
    }
    expect(errors).toEqual([]);
    expect(deleted).toEqual(["sub_bk_due"]);
    const rows = await db.query<any>(`SELECT subscription_id, done_at IS NOT NULL AS done FROM subscription_cancellations WHERE tenant_id = $1 ORDER BY subscription_id`, [t2]);
    expect(rows).toEqual([
      { subscription_id: "sub_bk_due", done: true },
      { subscription_id: "sub_bk_max", done: false },
      { subscription_id: "sub_bk_wait", done: false },
    ]);
  });

  it("barrido: al llegar al máximo de intentos registra una alerta", async () => {
    const { cancelPendingSubscriptions, SUBSCRIPTION_CANCEL_MAX_ATTEMPTS } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_cur_al");
    await db.query(`INSERT INTO subscription_cancellations (provider, subscription_id, tenant_id, attempts, attempted_at) VALUES ('stripe', 'sub_al', $1, $2, now() - interval '2 days')`, [
      t2,
      SUBSCRIPTION_CANCEL_MAX_ATTEMPTS - 1,
    ]);
    globalThis.fetch = (async () => json({ error: { message: "caído" } }, 500)) as typeof fetch;
    const errors: any[] = [];
    try {
      await cancelPendingSubscriptions({ db, log: { error: (o) => void errors.push(o) } });
    } finally {
      globalThis.fetch = real;
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ alert: true, subscriptionId: "sub_al", attempts: SUBSCRIPTION_CANCEL_MAX_ATTEMPTS });
    expect((await db.one<any>(`SELECT attempts FROM subscription_cancellations WHERE subscription_id = 'sub_al'`))?.attempts).toBe(SUBSCRIPTION_CANCEL_MAX_ATTEMPTS);
  });

  it("Mercado Pago: un 400 al cancelar un preapproval ya cancelado cuenta como cancelado", async () => {
    const { cancelPendingSubscriptions } = await import("../src/modules/billing/webhooks");
    const t2 = await org("mercadopago", "pre_cur_400");
    await db.query(`INSERT INTO subscription_cancellations (provider, subscription_id, tenant_id, attempted_at) VALUES ('mercadopago', 'pre_400', $1, now() - interval '5 minutes')`, [t2]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ message: "cannot modify a cancelled preapproval" }, 400);
      return json({ id: String(input).split("/").pop(), status: "cancelled", external_reference: null });
    }) as typeof fetch;
    const errors: object[] = [];
    try {
      await cancelPendingSubscriptions({ db, log: { error: (o) => void errors.push(o) } });
    } finally {
      globalThis.fetch = real;
    }
    expect(errors).toEqual([]);
    expect((await db.one<any>(`SELECT done_at IS NOT NULL AS done FROM subscription_cancellations WHERE subscription_id = 'pre_400'`))?.done).toBe(true);
  });

  it("barrido: 429 o 408 cuentan como proveedor caído (no se siguen tomando sus filas)", async () => {
    const { cancelPendingSubscriptions } = await import("../src/modules/billing/webhooks");
    for (const status of [429, 408]) {
      const t2 = await org("stripe", `sub_cur_rl${status}`);
      await db.query(
        `INSERT INTO subscription_cancellations (provider, subscription_id, tenant_id, attempted_at) VALUES ('stripe', $1, $3, now() - interval '1 day'), ('stripe', $2, $3, now() - interval '1 day')`,
        [`sub_rl${status}_a`, `sub_rl${status}_b`, t2],
      );
      let calls = 0;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE") calls++;
        return json({ error: { message: "slow down" } }, status);
      }) as typeof fetch;
      try {
        await cancelPendingSubscriptions({ db, log: { error: () => {} } }, 50);
      } finally {
        globalThis.fetch = real;
      }
      expect(calls).toBe(1);
      await db.query(`DELETE FROM subscription_cancellations WHERE tenant_id = $1`, [t2]);
    }
  });

  it("checkout pagado con la suscripción no activa (past_due): no se aplica y queda una alerta", async () => {
    const { handleStripeEvent } = await import("../src/modules/billing/webhooks");
    const t2 = await org("stripe", "sub_pd_cur");
    globalThis.fetch = (async () => json({ id: "sub_pd", status: "past_due", current_period_end: 1_900_000_000 })) as typeof fetch;
    const warns: any[] = [];
    try {
      await handleStripeEvent(db, completed(t2, "sub_pd"), { warn: (o: object) => void warns.push(o) });
    } finally {
      globalThis.fetch = real;
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ alert: true, status: "past_due", subscriptionId: "sub_pd", tenantId: t2 });
    expect(await tenantRow(t2)).toMatchObject({ subscription_id: "sub_pd_cur" });
  });
});
