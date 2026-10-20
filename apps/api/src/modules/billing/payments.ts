// Cobro al firmar: el sobre define un monto que paga un firmante, antes de firmar o después.
// "after_sign": el sobre recién se completa (y se sella) cuando el pago se confirma.
// "before_sign": el firmante no puede completar la firma hasta pagar.
import { envelopeBaseUrl } from "../white-label/brand";
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
import { advanceRouting, lockEnvelope, pastExpiry } from "../envelopes";
import { assertLinkCurrent, resolveToken } from "../signing";
import {
  ProviderError,
  mpCreatePreference,
  mpExpirePreference,
  mpRefundPayment,
  providerConfigured,
  stripeCreatePaymentCheckout,
  stripeExpireCheckoutSession,
  stripeGetCheckoutSession,
  stripeRefundPayment,
} from "./providers";

/** Estados en los que el sobre ya no se puede firmar: un pago que llega así se reembolsa. */
const CLOSED_STATUSES = ["voided", "declined", "expired"];
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
    refundRequiredAt: iso(r.refund_required_at),
    refundedAt: iso(r.refunded_at),
    refundError: r.refund_error ?? null,
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

function formatAmount(amount: number, currency: string, locale = "es") {
  try {
    return new Intl.NumberFormat(locale === "pt-BR" ? "pt-BR" : locale === "en" ? "en-US" : "es", { style: "currency", currency }).format(amount);
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
export async function paymentsForCertificate(db: Db, envelopeId: string, locale = "es") {
  const rows = await db.query<any>(
    `SELECT p.*, r.name AS payer_name FROM envelope_payments p JOIN recipients r ON r.id = p.recipient_id WHERE p.envelope_id = $1 AND p.status = 'paid'`,
    [envelopeId],
  );
  return rows.map((p) => ({
    description: p.description,
    // En el idioma del certificado (antes siempre en español).
    amount: formatAmount(Number(p.amount), p.currency, locale),
    payerName: p.payer_name,
    provider: p.provider === "mercadopago" ? "Mercado Pago" : p.provider === "stripe" ? "Stripe" : locale === "en" ? "Simulated" : "Simulado",
    reference: p.provider_payment_id ?? p.checkout_id ?? p.id,
    paidAt: p.paid_at ? new Date(p.paid_at).toISOString() : null,
  }));
}

/** Confirma un pago (webhook verificado o pago simulado). Idempotente. Si el sobre esperaba el pago, lo completa. */
/** Reembolsa un segundo cobro de Mercado Pago sobre un pago ya acreditado y lo deja en la evidencia (una vez). */
export async function refundDuplicatePayment(db: Db, paymentId: string, providerPaymentId: string, provider: "mercadopago" | "stripe" = "mercadopago") {
  if (provider === "stripe") await stripeRefundPayment(providerPaymentId, `dup:${providerPaymentId}`);
  else await mpRefundPayment(providerPaymentId, `dup:${providerPaymentId}`);
  const p = await db.one<any>(`SELECT tenant_id, envelope_id, provider FROM envelope_payments WHERE id = $1`, [paymentId]);
  if (!p) return;
  await db.tx(async (t) => {
    await lockEnvelope(t, p.tenant_id, p.envelope_id);
    const seen = await t.one(
      `SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'payment.duplicate_refunded' AND data->>'providerPaymentId' = $2`,
      [p.envelope_id, providerPaymentId],
    );
    if (seen) return;
    await appendEvent(t, {
      tenantId: p.tenant_id,
      envelopeId: p.envelope_id,
      type: "payment.duplicate_refunded",
      actor: { ...SYSTEM, label: `Pago (${p.provider})` },
      data: { paymentId, providerPaymentId },
    });
  });
}

export async function markPaymentPaid(
  db: Db,
  paymentId: string,
  r: { providerPaymentId: string | null; receipt: Record<string, unknown>; amount?: number; currency?: string; payerRecipientId?: string | null },
): Promise<{ duplicate: string } | undefined> {
  return db.tx(async (t): Promise<{ duplicate: string } | undefined> => {
    const p0 = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1`, [paymentId]);
    if (!p0) throw notFound("Pago");
    const e = await lockEnvelope(t, p0.tenant_id, p0.envelope_id);
    const p = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    // Ya reembolsado: otro evento del mismo pago (p. ej. async_payment_succeeded) no lo vuelve a "pagado".
    // Un cobro con OTRO id del proveedor es un segundo pago de la misma preferencia: lo reembolsa quien llama.
    if (p.status === "paid" || p.status === "refunded") {
      return r.providerPaymentId && p.provider_payment_id && r.providerPaymentId !== p.provider_payment_id ? { duplicate: r.providerPaymentId } : undefined;
    }
    // Un monto no numérico (NaN) haría falsa cualquier comparación: se trata como diferencia.
    // Checkout armado para otro pagador (el anterior, antes de una delegación, reasignación o corrección) y pagado
    // igual (un Boleto o efectivo ya emitido no se anula al cerrar la preferencia): no salda la deuda del pagador
    // actual ni queda a su nombre en la evidencia; quien llama lo reembolsa y el cobro sigue pendiente.
    if (r.payerRecipientId && r.payerRecipientId !== p.recipient_id) {
      return r.providerPaymentId ? { duplicate: r.providerPaymentId } : undefined;
    }
    if (r.amount !== undefined && (!Number.isFinite(r.amount) || Math.abs(r.amount - Number(p.amount)) > 0.005)) {
      throw new AppError(400, "payment_mismatch", "El monto pagado no coincide con el cobro");
    }
    if (r.currency && r.currency.toUpperCase() !== String(p.currency).toUpperCase()) {
      throw new AppError(400, "payment_mismatch", "La moneda del pago no coincide con el cobro");
    }
    // El pago llegó con el sobre ya cerrado (anulado, rechazado o vencido): p. ej. una sesión de Stripe pagada antes
    // de que el barrido la venciera, o un Boleto/efectivo de Mercado Pago iniciado antes y acreditado días después.
    // El dinero se cobró, así que se registra, pero queda marcado para reembolso (refundPaymentsOnClosedEnvelopes).
    // Vencido aunque el barrido no lo haya marcado todavía: el pago no completa el sobre y queda para reembolso.
    const closed = CLOSED_STATUSES.includes(e.status) || (e.status === "sent" && pastExpiry(e));
    await t.query(
      `UPDATE envelope_payments SET status = 'paid', paid_at = now(), provider_payment_id = $2, receipt = $3,
         refund_required_at = CASE WHEN $4::boolean THEN now() ELSE refund_required_at END, updated_at = now() WHERE id = $1`,
      [p.id, r.providerPaymentId, JSON.stringify(r.receipt), closed],
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
    if (closed) {
      await appendEvent(t, {
        tenantId: p.tenant_id,
        envelopeId: p.envelope_id,
        type: "payment.refund_required",
        actor: { ...SYSTEM, label: `Pago (${p.provider})` },
        data: { paymentId: p.id, envelopeStatus: e.status },
      });
    }
    // after_sign: si ya firmaron todos, el sobre pasa a finalizar ahora.
    if (e.status === "sent" && !closed) await advanceRouting(t, p.tenant_id, p.envelope_id, SYSTEM);
  });
}

/**
 * Cierra en el proveedor los checkouts que siguen abiertos en sobres que ya no se pueden firmar (anulados,
 * rechazados o vencidos). Sin esto, el firmante podía seguir pagando en la sesión de Stripe (24 h) o en la
 * preferencia de Mercado Pago y el cobro quedaba acreditado en un sobre cerrado, sin aviso ni reembolso.
 * Corre en el barrido periódico, así cubre todos los caminos que cierran un sobre y reintenta si el proveedor falla.
 */
export async function closeStaleCheckouts(d: { db: Db; log: { error: (o: object, m: string) => void } }, limit = 50) {
  // Checkouts descartados al cambiar el pagador: se cierran en el proveedor (siguen cobrables hasta que se cierren).
  const stale = await d.db.query<any>(
    `SELECT id, provider, stale_checkout_id FROM envelope_payments WHERE stale_checkout_id IS NOT NULL ORDER BY updated_at LIMIT $1`,
    [limit],
  );
  for (const p of stale) {
    try {
      if (p.provider === "stripe") await stripeExpireCheckoutSession(p.stale_checkout_id);
      else if (p.provider === "mercadopago") await mpExpirePreference(p.stale_checkout_id);
      await d.db.query(`UPDATE envelope_payments SET stale_checkout_id = NULL WHERE id = $1 AND stale_checkout_id = $2`, [p.id, p.stale_checkout_id]);
    } catch (err) {
      // Si el proveedor ya no lo conoce (404), no hay nada que cerrar: se suelta para no reintentarlo para siempre.
      if (err instanceof ProviderError && err.status === 404) {
        await d.db.query(`UPDATE envelope_payments SET stale_checkout_id = NULL WHERE id = $1 AND stale_checkout_id = $2`, [p.id, p.stale_checkout_id]).catch(() => {});
      } else {
        // Cualquier otro error (proveedor caído, sin configurar): pasa al final de la cola para no tapar a los demás.
        await d.db.query(`UPDATE envelope_payments SET updated_at = now() WHERE id = $1`, [p.id]).catch(() => {});
      }
      d.log.error({ err: String(err), paymentId: p.id }, "no se pudo cerrar un checkout descartado");
    }
  }
  const rows = await d.db.query<any>(
    `SELECT p.id, p.provider, p.checkout_id, p.envelope_id, p.tenant_id FROM envelope_payments p JOIN envelopes e ON e.id = p.envelope_id
      WHERE p.status IN ('pending','checkout_created') AND p.checkout_id IS NOT NULL AND p.checkout_closed_at IS NULL
        AND e.status IN ('voided','declined','expired')
      ORDER BY p.updated_at LIMIT $1`,
    [limit],
  );
  for (const p of rows) {
    try {
      let outcome = "expired";
      if (p.provider === "stripe") outcome = await stripeExpireCheckoutSession(p.checkout_id);
      else if (p.provider === "mercadopago") await mpExpirePreference(p.checkout_id);
      // "complete": se pagó antes de poder cerrarla; el webhook lo acredita y queda a la vista en la evidencia.
      // Marca y evento juntos, con el sobre bloqueado: sin el bloqueo, un webhook de pago simultáneo tomaba el mismo
      // número de evento, el de cierre fallaba (UNIQUE) y, ya marcado como cerrado, no se reintentaba nunca.
      await d.db.tx(async (t) => {
        await lockEnvelope(t, p.tenant_id, p.envelope_id);
        const marked = await t.query(
          `UPDATE envelope_payments SET checkout_closed_at = now(), checkout_url = NULL, updated_at = now() WHERE id = $1 AND checkout_closed_at IS NULL RETURNING id`,
          [p.id],
        );
        if (!marked.length) return;
        await appendEvent(t, {
          tenantId: p.tenant_id,
          envelopeId: p.envelope_id,
          type: "payment.checkout_closed",
          actor: { ...SYSTEM, label: `Pago (${p.provider})` },
          data: { paymentId: p.id, provider: p.provider, outcome },
        });
      });
    } catch (err) {
      await d.db.query(`UPDATE envelope_payments SET updated_at = now() WHERE id = $1`, [p.id]).catch(() => {});
      d.log.error({ err: String(err), paymentId: p.id }, "no se pudo cerrar el checkout de un sobre cerrado");
    }
  }
}

/**
 * Reembolsa los pagos que llegaron con el sobre ya cerrado (refund_required_at). Corre en el barrido periódico y
 * reintenta si el proveedor falla; la clave de idempotencia evita un doble reembolso si el resultado no se pudo guardar.
 */
export async function refundPaymentsOnClosedEnvelopes(d: { db: Db; log: { error: (o: object, m: string) => void } }, limit = 20) {
  const rows = await d.db.query<any>(
    // Solo con el sobre efectivamente cerrado: uno marcado por vencer que después se extendió (y sigue en curso) no se
    // reembolsa, o quedaría esperando un pago que ya no se puede hacer.
    `SELECT p.id, p.provider, p.provider_payment_id, p.envelope_id, p.tenant_id, p.amount, p.currency FROM envelope_payments p
       JOIN envelopes e ON e.id = p.envelope_id
      WHERE p.status = 'paid' AND p.refund_required_at IS NOT NULL AND p.refunded_at IS NULL AND e.status IN ('voided','declined','expired')
      ORDER BY p.refund_required_at LIMIT $1`,
    [limit],
  );
  for (const p of rows) {
    try {
      if (p.provider === "stripe") {
        if (!p.provider_payment_id) throw new Error("pago de Stripe sin PaymentIntent");
        await stripeRefundPayment(p.provider_payment_id, `refund:${p.id}`);
      } else if (p.provider === "mercadopago") {
        if (!p.provider_payment_id) throw new Error("pago de Mercado Pago sin id");
        await mpRefundPayment(p.provider_payment_id, `refund:${p.id}`);
      }
      // mock: no hay dinero que devolver.
      // Estado y evento juntos, con el sobre bloqueado: sin el bloqueo, un evento simultáneo del mismo sobre tomaba el
      // mismo número, el de reembolso fallaba (UNIQUE) y, con el pago ya marcado "refunded", no se reintentaba nunca:
      // la evidencia quedaba sin payment.refunded. Si la transacción falla, el próximo barrido repite el reembolso con
      // la misma clave de idempotencia (el proveedor no devuelve dos veces).
      await d.db.tx(async (t) => {
        await lockEnvelope(t, p.tenant_id, p.envelope_id);
        const marked = await t.query(
          `UPDATE envelope_payments SET status = 'refunded', refunded_at = now(), refund_error = NULL, updated_at = now()
            WHERE id = $1 AND status = 'paid' AND refunded_at IS NULL RETURNING id`,
          [p.id],
        );
        if (!marked.length) return;
        await appendEvent(t, {
          tenantId: p.tenant_id,
          envelopeId: p.envelope_id,
          type: "payment.refunded",
          actor: { ...SYSTEM, label: `Pago (${p.provider})` },
          data: { paymentId: p.id, amount: Number(p.amount), currency: p.currency, reason: "envelope_closed" },
        });
      });
    } catch (err) {
      await d.db.query(`UPDATE envelope_payments SET refund_error = $2, updated_at = now() WHERE id = $1`, [p.id, String(err).slice(0, 500)]).catch(() => {});
      d.log.error({ err: String(err), paymentId: p.id }, "no se pudo reembolsar un pago de un sobre cerrado");
    }
  }
}

export async function markPaymentFailed(db: Db, paymentId: string, reason: string, payerRecipientId?: string | null) {
  await db.tx(async (t) => {
    const p0 = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1`, [paymentId]);
    if (!p0) return;
    await lockEnvelope(t, p0.tenant_id, p0.envelope_id);
    const p = await t.one<any>(`SELECT * FROM envelope_payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    // Ya reembolsado: un rechazo tardío de otro intento no lo devuelve a "pending" (como en markPaymentPaid).
    if (p.status === "paid" || p.status === "refunded") return;
    // Rechazo de un checkout armado para un pagador anterior (p. ej. su Boleto venció después de una reasignación): no
    // toca el cobro del pagador actual (lo devolvía a "pending" con su sesión todavía en proceso y le sumaba
    // payment.failed a su evidencia).
    if (payerRecipientId && payerRecipientId !== p.recipient_id) return;
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

    // El dominio del sobre (el de su sub-marca, si tiene): la sesión del código del firmante vive en ese host y, al volver
    // del proveedor a otro, había que pedir otro código (y veía otro dominio).
    const base = await envelopeBaseUrl(s.db, e.tenant_id, e.id);
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
          // recipientId: a quién se le armó el checkout (si el pagador cambia y igual se paga este, se reembolsa).
          metadata: { paymentId: p.id, envelopeId: e.id, tenantId: e.tenant_id, recipientId: r.id },
          customerEmail: r.email,
          // Misma clave para pedidos simultáneos sobre el mismo estado; cambia cuando la sesión anterior vence o falla.
          // Con el link vigente del pagador: cambia al delegar, reasignar o corregir su contacto (checkout descartado), así
          // Stripe no devuelve la sesión anterior ni rechaza la clave por parámetros distintos.
          idempotencyKey: `pay:${p.id}:${String(r.access_token_hash ?? "").slice(0, 16)}:${p.checkout_id ?? "first"}`,
        });
        checkoutId = c.id;
        url = c.url;
      } else {
        const c = await mpCreatePreference({
          title: p.description,
          amount: Number(p.amount),
          currency: p.currency,
          externalReference: `pay:${p.id}:${r.id}`, // pagador para el que se armó (ver markPaymentPaid)
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
    const open = await s.db.tx(async (t) => {
      const cur = await lockEnvelope(t, e.tenant_id, e.id);
      // El link tiene que seguir vigente y el cobro, a su cargo: una corrección del contacto o un reemplazo (el cobro
      // pasa al nuevo destinatario) confirmados durante la llamada al proveedor no le entregan el checkout a quien tenía
      // el link anterior ni le guardan al nuevo pagador un checkout armado con los datos del anterior.
      assertLinkCurrent(await t.one<any>(`SELECT access_token_hash FROM recipients WHERE id = $1`, [r.id]), token);
      const payer = await t.one<any>(`SELECT recipient_id FROM envelope_payments WHERE id = $1`, [p.id]);
      if (payer?.recipient_id !== r.id) throw notFound("Cobro");
      const upd = await t.query(
        `UPDATE envelope_payments SET status = 'checkout_created', checkout_id = $2, checkout_url = $3, checkout_nonce_hash = $4, updated_at = now()
         WHERE id = $1 AND status NOT IN ('paid','refunded') RETURNING id`,
        [p.id, checkoutId, url, nonceHash],
      );
      // El sobre se anuló, rechazó o venció mientras se creaba el checkout en el proveedor (red): el checkout queda
      // guardado para que closeStaleCheckouts lo cierre, pero no se entrega ni se suma el evento a la evidencia de un
      // sobre cerrado. Tampoco si el pago se confirmó mientras tanto.
      if (cur.status !== "sent" || !upd.length) return false;
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "payment.checkout_created",
        actor: { type: "recipient", id: r.id, label: r.name, ip: req.ip, userAgent: (req.headers["user-agent"] as string | undefined)?.slice(0, 500) ?? null },
        data: { paymentId: p.id, provider: p.provider, checkoutId },
      });
      return true;
    });
    if (!open) throw conflict("payment_not_available", "El sobre no admite pagos ahora");
    return { url };
  });

  // ───────── Proveedor simulado (fuera de producción) ─────────

  type M = { Params: { id: string }; Querystring: { n?: string } };
  async function loadMock(id: string, nonce: string | undefined) {
    if (!config.billing.mockEnabled) throw notFound("Pago");
    const p = await s.db.one<any>(
      `SELECT p.*, e.subject, e.status AS envelope_status FROM envelope_payments p JOIN envelopes e ON e.id = p.envelope_id WHERE p.id = $1 AND p.provider = 'mock'`,
      [id],
    );
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
      .header("content-security-policy", mockPageCsp(new URL(await envelopeBaseUrl(s.db, p.tenant_id, p.envelope_id)).origin))
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
    // Como los proveedores reales después de cerrarse el checkout: un sobre anulado, rechazado o vencido no se paga.
    if (CLOSED_STATUSES.includes(p.envelope_status)) throw conflict("envelope_closed", "El sobre ya no admite pagos");
    const outcome = (req.body as any)?.outcome ?? "paid";
    if (outcome === "paid") {
      await markPaymentPaid(s.db, p.id, { providerPaymentId: `mock_pay_${p.id.slice(-8)}`, receipt: { provider: "mock", simulated: true } });
    } else {
      await markPaymentFailed(s.db, p.id, "rechazado en el pago simulado");
    }
    const r = await s.db.one<any>(`SELECT access_token_enc FROM recipients WHERE id = $1`, [p.recipient_id]);
    const base = await envelopeBaseUrl(s.db, p.tenant_id, p.envelope_id);
    const back = r?.access_token_enc ? `${base}/s/${decrypt(r.access_token_enc)}?payment=${outcome === "paid" ? "success" : "cancel"}` : base;
    if ((req.headers.accept ?? "").includes("application/json")) return { ok: true, outcome, redirect: back };
    return reply.redirect(back, 303);
  });
  });
}
