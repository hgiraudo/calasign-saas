// Cobro al firmar: el sobre define un monto que paga un firmante, antes de firmar o después.
// "after_sign": el sobre recién se completa (y se sella) cuando el pago se confirma.
// "before_sign": el firmante no puede completar la firma hasta pagar.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EnvelopePaymentInput,
  PAYMENT_PROVIDERS,
  type EnvelopePayment,
  type PaymentMethodCode,
  type PaymentProvider,
  type PaymentProviderInfo,
  type SignerPaymentInfo,
} from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { SYSTEM, appendEvent, type Actor } from "../../infra/evidence";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors";
import { decrypt, iso, randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import { authenticate, type Services } from "../context";
import { tenantBaseUrl } from "../custom-domains";
import { advanceRouting, lockEnvelope } from "../envelopes";
import { resolveToken } from "../signing";
import { ProviderError, mpCreatePreference, providerConfigured, stripeCreatePaymentCheckout, stripeGetCheckoutSession } from "./providers";
import { escapeHtml, mockPage, mockPageCsp } from "./mock-page";

// Código estable (lo traduce la interfaz) y texto documental en español, en el mismo orden.
const PROVIDER_METHODS: Record<PaymentProvider, [PaymentMethodCode, string][]> = {
  stripe: [["card", "Tarjeta"], ["pix", "Pix (cuentas de Stripe en Brasil)"], ["wallet", "Apple Pay / Google Pay"]],
  mercadopago: [["card", "Tarjeta"], ["pix", "Pix (Brasil)"], ["pse", "PSE (Colombia)"], ["boleto", "Boleto (Brasil)"], ["cash", "Efectivo según país"]],
  mock: [["simulated", "Simulado (solo pruebas)"]],
};

export function toPayment(r: any): EnvelopePayment {
  return {
    id: r.id,
    amount: Number(r.amount),
    currency: r.currency,
    description: r.description,
    payerRecipientId: r.recipient_id,
    timing: r.timing,
    provider: r.provider,
    status: r.status,
    paidAt: iso(r.paid_at),
    providerPaymentId: r.provider_payment_id,
  };
}

export function paymentProviders(): PaymentProviderInfo[] {
  return PAYMENT_PROVIDERS.filter((p) => p !== "mock" || config.billing.mockEnabled).map((id) => ({
    id,
    configured: providerConfigured(id),
    methods: PROVIDER_METHODS[id].map(([, label]) => label),
    methodCodes: PROVIDER_METHODS[id].map(([code]) => code),
  }));
}

function formatAmount(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("es", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

// ───────────────────────────── Puertas del flujo ─────────────────────────────

/**
 * Lo llama advanceRouting antes de finalizar: si hay un cobro sin confirmar, el sobre queda esperando el pago
 * (estado "sent" con todos los firmantes listos) y se deja constancia una sola vez.
 */
export async function paymentBlocksCompletion(db: Db, tenantId: string, envelopeId: string, actor: Actor): Promise<boolean> {
  const p = await db.one<any>(`SELECT * FROM envelope_payments WHERE envelope_id = $1`, [envelopeId]);
  if (!p || p.status === "paid") return false;
  const already = await db.one(`SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.awaiting_payment'`, [envelopeId]);
  if (!already) {
    await appendEvent(db, {
      tenantId,
      envelopeId,
      type: "envelope.awaiting_payment",
      actor,
      data: { paymentId: p.id, amount: Number(p.amount), currency: p.currency },
    });
  }
  return true;
}

/** Datos del pago para el certificado de finalización. */
export async function paymentsForCertificate(db: Db, envelopeId: string) {
  const rows = await db.query<any>(
    `SELECT p.*, r.name AS payer_name FROM envelope_payments p JOIN recipients r ON r.id = p.recipient_id WHERE p.envelope_id = $1 AND p.status = 'paid'`,
    [envelopeId],
  );
  return rows.map((p) => ({
    description: p.description,
    amount: formatAmount(Number(p.amount), p.currency),
    payerName: p.payer_name,
    provider: p.provider === "mercadopago" ? "Mercado Pago" : p.provider === "stripe" ? "Stripe" : "Simulado",
    reference: p.provider_payment_id ?? p.checkout_id ?? p.id,
    paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
  }));
}

/** Confirma un pago (webhook verificado o pago simulado). Idempotente. Si el sobre esperaba el pago, lo completa. */
export async function markPaymentPaid(
  db: Db,
  paymentId: string,
  r: { providerPaymentId: string | null; receipt: Record<string, unknown>; amount?: number; currency?: string },
) {
  await db.tx(async (t) => {
    const p0 = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1`, [paymentId]);
    if (!p0) throw notFound("Pago");
    const e = await lockEnvelope(t, p0.tenant_id, p0.envelope_id);
    const p = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    if (p.status === "paid") return;
    // Un monto no numérico (NaN) haría falsa cualquier comparación: se trata como diferencia.
    if (r.amount !== undefined && (!Number.isFinite(r.amount) || Math.abs(r.amount - Number(p.amount)) > 0.005)) {
      throw new AppError(400, "payment_mismatch", "El monto pagado no coincide con el cobro");
    }
    if (r.currency && r.currency.toUpperCase() !== String(p.currency).toUpperCase()) {
      throw new AppError(400, "payment_mismatch", "La moneda del pago no coincide con el cobro");
    }
    await t.query(
      `UPDATE envelope_payments SET status = 'paid', paid_at = now(), provider_payment_id = $2, receipt = $3, updated_at = now() WHERE id = $1`,
      [p.id, r.providerPaymentId, JSON.stringify(r.receipt)],
    );
    const payer = await t.one<any>(`SELECT name FROM recipients WHERE id = $1`, [p.recipient_id]);
    await appendEvent(t, {
      tenantId: p.tenant_id,
      envelopeId: p.envelope_id,
      type: "payment.completed",
      actor: { ...SYSTEM, label: `Pago (${p.provider})` },
      data: {
        paymentId: p.id,
        recipientId: p.recipient_id,
        payer: payer?.name ?? null,
        amount: Number(p.amount),
        currency: p.currency,
        provider: p.provider,
        providerPaymentId: r.providerPaymentId,
      },
    });
    // after_sign: si ya firmaron todos, el sobre pasa a finalizar ahora.
    if (e.status === "sent") await advanceRouting(t, p.tenant_id, p.envelope_id, SYSTEM);
  });
}

export async function markPaymentFailed(db: Db, paymentId: string, reason: string) {
  await db.tx(async (t) => {
    const p0 = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1`, [paymentId]);
    if (!p0) return;
    await lockEnvelope(t, p0.tenant_id, p0.envelope_id);
    const p = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    if (p.status === "paid" || p.status === "failed") return;
    // Vuelve a "pending": el firmante puede intentar de nuevo.
    await t.query(`UPDATE envelope_payments SET status = 'pending', updated_at = now() WHERE id = $1`, [p.id]);
    await appendEvent(t, {
      tenantId: p.tenant_id,
      envelopeId: p.envelope_id,
      type: "payment.failed",
      actor: { ...SYSTEM, label: `Pago (${p.provider})` },
      data: { paymentId: p.id, reason: reason.slice(0, 300) },
    });
  });
}

function signerInfo(p: any | null, r: any, e: any): SignerPaymentInfo {
  if (!p || p.recipient_id !== r.id) {
    return { required: false, amount: null, currency: null, description: null, timing: null, status: null, canPay: false, blocksSigning: false };
  }
  const paid = p.status === "paid";
  const open = e.status === "sent";
  const canPay = !paid && open && (p.timing === "before_sign" ? ["sent", "viewed"].includes(r.status) : r.status === "signed");
  return {
    required: true,
    amount: Number(p.amount),
    currency: p.currency,
    description: p.description,
    timing: p.timing,
    status: p.status,
    canPay,
    blocksSigning: p.timing === "before_sign" && !paid,
  };
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function paymentRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  type E = { Params: { id: string } };
  type T = { Params: { token: string } };

  // before_sign: completar la firma exige el pago confirmado.
  app.addHook("preHandler", async (req: FastifyRequest) => {
    if ((req.routeOptions?.url ?? "") !== "/v1/signing/:token/complete") return;
    const token = (req.params as { token?: string }).token ?? "";
    const { recipient } = await resolveToken(s.db, token);
    const p = await s.db.one<any>(`SELECT * FROM envelope_payments WHERE recipient_id = $1 AND timing = 'before_sign' AND status <> 'paid'`, [recipient.id]);
    if (p) {
      throw new AppError(402, "payment_required", "Para firmar primero hay que completar el pago", {
        amount: Number(p.amount),
        currency: p.currency,
        description: p.description,
      });
    }
  });

  app.get("/v1/payments/providers", { preHandler: auth }, async () => ({ items: paymentProviders() }));

  app.get<E>("/v1/envelopes/:id/payment", { preHandler: auth }, async (req) => {
    const p = await s.db.one<any>(`SELECT * FROM envelope_payments WHERE envelope_id = $1 AND tenant_id = $2`, [req.params.id, req.auth!.tenantId]);
    return { payment: p ? toPayment(p) : null, providers: paymentProviders() };
  });

  app.put<E>("/v1/envelopes/:id/payment", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const input = EnvelopePaymentInput.parse(req.body);
    if (!providerConfigured(input.provider)) {
      throw badRequest("provider_not_configured", `El proveedor ${input.provider} no está configurado en este entorno`);
    }
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "draft") throw conflict("not_draft", "El cobro se configura mientras el sobre es un borrador");
      const r = await t.one<any>(`SELECT id, role FROM recipients WHERE id = $1 AND envelope_id = $2`, [input.payerRecipientId, e.id]);
      if (!r) throw badRequest("invalid_payer", "El pagador tiene que ser un destinatario del sobre");
      if (r.role !== "signer") throw badRequest("invalid_payer", "El pagador tiene que ser un firmante");
      await t.query(
        `INSERT INTO envelope_payments (id, tenant_id, envelope_id, recipient_id, provider, amount, currency, description, timing)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (envelope_id) DO UPDATE SET recipient_id = EXCLUDED.recipient_id, provider = EXCLUDED.provider, amount = EXCLUDED.amount,
           currency = EXCLUDED.currency, description = EXCLUDED.description, timing = EXCLUDED.timing, updated_at = now()`,
        [uuidv7(), a.tenantId, e.id, input.payerRecipientId, input.provider, input.amount, input.currency, input.description, input.timing],
      );
      await appendEvent(t, {
        tenantId: a.tenantId,
        envelopeId: e.id,
        type: "payment.configured",
        actor: a.actor,
        data: { amount: input.amount, currency: input.currency, provider: input.provider, timing: input.timing, payerRecipientId: input.payerRecipientId },
      });
    });
    const p = await s.db.one<any>(`SELECT * FROM envelope_payments WHERE envelope_id = $1`, [req.params.id]);
    return { payment: toPayment(p), providers: paymentProviders() };
  });

  app.delete<E>("/v1/envelopes/:id/payment", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "draft") throw conflict("not_draft", "El cobro solo se quita mientras el sobre es un borrador");
      await t.query(`DELETE FROM envelope_payments WHERE envelope_id = $1`, [e.id]);
    });
    return reply.code(204).send();
  });

  // ───────── Firmante ─────────

  app.get<T>("/v1/signing/:token/payment", async (req) => {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    const p = await s.db.one<any>(`SELECT * FROM envelope_payments WHERE envelope_id = $1`, [e.id]);
    return signerInfo(p, r, e);
  });

  app.post<T>("/v1/signing/:token/payment/checkout", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const token = req.params.token;
    const { recipient: r, envelope: e } = await resolveToken(s.db, token);
    const p = await s.db.one<any>(`SELECT * FROM envelope_payments WHERE envelope_id = $1`, [e.id]);
    const info = signerInfo(p, r, e);
    if (!info.required) throw notFound("Cobro");
    if (p.status === "paid") throw conflict("already_paid", "El pago ya está confirmado");
    if (!info.canPay) throw conflict("payment_not_available", p.timing === "after_sign" ? "El pago se habilita después de firmar" : "El sobre no admite pagos ahora");

    // Un checkout anterior que sigue cobrable se reutiliza: si se creara otro (doble clic, dos pestañas), el firmante
    // podría pagar los dos y el segundo cobro quedaría sin acreditar (markPaymentPaid lo ignora).
    try {
      if (p.provider === "stripe" && p.checkout_id) {
        const prev = await stripeGetCheckoutSession(p.checkout_id);
        if (prev.status === "open" && prev.url) return { url: prev.url };
        if (prev.status === "complete" && p.status === "checkout_created")
          throw conflict("payment_processing", "El pago se está procesando; en unos instantes queda confirmado");
      } else if (p.provider === "mercadopago" && p.checkout_url) {
        // También después de un pago rechazado (status vuelve a "pending"): la preferencia de Checkout Pro sigue
        // cobrable y el comprador puede reintentar en ella. Una preferencia nueva dejaría dos cobrables y, si se pagan
        // las dos, el segundo cobro no se acredita.
        return { url: p.checkout_url as string };
      }
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(502, "payment_provider_error", `No se pudo iniciar el pago: ${err.message}`);
      throw err;
    }

    const base = await tenantBaseUrl(s.db, e.tenant_id);
    const back = `${base}/s/${token}`;
    let checkoutId: string;
    let url: string;
    let nonceHash: string | null = null;
    try {
      if (p.provider === "mock") {
        if (!config.billing.mockEnabled) throw badRequest("provider_not_configured", "El proveedor simulado no está disponible");
        const nonce = randomToken(24);
        nonceHash = sha256Hex(nonce);
        checkoutId = `mock_${uuidv7()}`;
        url = `${config.appUrl}/v1/payments/mock/checkout/${p.id}?n=${nonce}`;
      } else if (p.provider === "stripe") {
        const c = await stripeCreatePaymentCheckout({
          amount: Number(p.amount),
          currency: p.currency,
          description: p.description,
          successUrl: `${back}?payment=success`,
          cancelUrl: `${back}?payment=cancel`,
          metadata: { paymentId: p.id, envelopeId: e.id, tenantId: e.tenant_id },
          customerEmail: r.email,
          // Misma clave para pedidos simultáneos sobre el mismo estado; cambia cuando la sesión anterior vence o falla.
          idempotencyKey: `pay:${p.id}:${p.checkout_id ?? "first"}`,
        });
        checkoutId = c.id;
        url = c.url;
      } else {
        const c = await mpCreatePreference({
          title: p.description,
          amount: Number(p.amount),
          currency: p.currency,
          externalReference: `pay:${p.id}`,
          notificationUrl: `${config.appUrl}/v1/integrations/payments/mercadopago/webhook`,
          successUrl: `${back}?payment=success`,
          failureUrl: `${back}?payment=cancel`,
          payerEmail: r.email,
        });
        checkoutId = c.id;
        url = c.url;
      }
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(502, "payment_provider_error", `No se pudo iniciar el pago: ${err.message}`);
      throw err;
    }
    await s.db.tx(async (t) => {
      await lockEnvelope(t, e.tenant_id, e.id);
      await t.query(
        `UPDATE envelope_payments SET status = 'checkout_created', checkout_id = $2, checkout_url = $3, checkout_nonce_hash = $4, updated_at = now()
         WHERE id = $1 AND status <> 'paid'`,
        [p.id, checkoutId, url, nonceHash],
      );
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "payment.checkout_created",
        actor: { type: "recipient", id: r.id, label: r.name, ip: req.ip, userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null },
        data: { paymentId: p.id, provider: p.provider, checkoutId },
      });
    });
    return { url };
  });

  // ───────── Proveedor simulado (fuera de producción) ─────────

  type M = { Params: { id: string }; Querystring: { n?: string } };
  async function loadMock(id: string, nonce: string | undefined) {
    if (!config.billing.mockEnabled) throw notFound("Pago");
    const p = await s.db.one<any>(`SELECT p.*, e.subject FROM envelope_payments p JOIN envelopes e ON e.id = p.envelope_id WHERE p.id = $1 AND p.provider = 'mock'`, [id]);
    if (!p || !nonce || !p.checkout_nonce_hash || sha256Hex(nonce) !== p.checkout_nonce_hash) throw notFound("Pago");
    return p;
  }

  await app.register(async (o) => {
  // La página simulada envía un formulario HTML (application/x-www-form-urlencoded).
  o.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  o.get<M>("/v1/payments/mock/checkout/:id", async (req, reply: FastifyReply) => {
    const p = await loadMock(req.params.id, req.query.n);
    const action = `/v1/payments/mock/checkout/${encodeURIComponent(p.id)}/complete?n=${encodeURIComponent(req.query.n!)}`;
    // Referrer-Policy same-origin: con no-referrer el navegador manda "Origin: null" y el control de origen rechaza el POST.
    reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", mockPageCsp(new URL(await tenantBaseUrl(s.db, p.tenant_id)).origin))
      .header("referrer-policy", "same-origin");
    return mockPage({
      title: "Pago simulado",
      lead: `${escapeHtml(p.subject)}`,
      amount: formatAmount(Number(p.amount), p.currency),
      description: p.description,
      action,
      paid: p.status === "paid",
    });
  });

  o.post<M & { Body: { outcome?: string } }>("/v1/payments/mock/checkout/:id/complete", async (req, reply) => {
    const p = await loadMock(req.params.id, req.query.n);
    const outcome = (req.body as any)?.outcome ?? "paid";
    if (outcome === "paid") {
      await markPaymentPaid(s.db, p.id, { providerPaymentId: `mock_pay_${p.id.slice(-8)}`, receipt: { provider: "mock", simulated: true } });
    } else {
      await markPaymentFailed(s.db, p.id, "rechazado en el pago simulado");
    }
    const r = await s.db.one<any>(`SELECT access_token_enc FROM recipients WHERE id = $1`, [p.recipient_id]);
    const base = await tenantBaseUrl(s.db, p.tenant_id);
    const back = r?.access_token_enc ? `${base}/s/${decrypt(r.access_token_enc)}?payment=${outcome === "paid" ? "success" : "cancel"}` : base;
    if ((req.headers.accept ?? "").includes("application/json")) return { ok: true, outcome, redirect: back };
    return reply.redirect(back, 303);
  });
  });
}
