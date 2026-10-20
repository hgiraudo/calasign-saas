// Webhooks de Stripe y Mercado Pago: un endpoint por proveedor para cobros al firmar y suscripciones.
// Se verifica la firma antes de tocar nada, cada evento se procesa hasta terminar una vez (processed_at), y en Mercado Pago el estado
// se consulta a la API (la notificación solo trae el id).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PlanId } from "@calasign/shared";
import { PLAN_IDS } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError } from "../../lib/errors";
import type { Services } from "../context";
import { markPaymentDisputed, markPaymentFailed, markPaymentPaid, markPaymentRefundedByProvider, refundDuplicatePayment } from "./payments";
import {
  mpCancelPreapproval,
  mpExpirePreference,
  mpGetPayment,
  mpGetPreapproval,
  stripeCancelSubscription,
  stripeGetSubscriptionPeriodEnd,
  toMinorUnits,
  verifyMercadoPagoSignature,
  verifyStripeSignature,
} from "./providers";
import { applySubscription } from "./subscriptions";

/** Un evento recibido y sin terminar se considera en curso durante este tiempo; después se reprocesa. */
export const WEBHOOK_IN_PROGRESS_SECONDS = 120;

/**
 * Toma un evento para procesarlo. "new": nuevo, o recibido antes y nunca terminado (el proceso murió) hace más de
 * WEBHOOK_IN_PROGRESS_SECONDS: se procesa (los manejadores son idempotentes). "duplicate": ya procesado.
 * "in_progress": otro pedido lo está procesando: el proveedor recibe 409 y reintenta (antes recibía 200 "duplicate" y,
 * si el primero fallaba, el evento se perdía).
 */
export async function claimWebhookEvent(db: Db, provider: string, eventId: string): Promise<"new" | "duplicate" | "in_progress"> {
  const ins = await db.query(`INSERT INTO payment_webhook_events (provider, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`, [provider, eventId]);
  if (ins.length) return "new";
  // Abandonado: se vuelve a tomar (con received_at nuevo, así un pedido simultáneo lo ve en curso).
  const retaken = await db.query(
    `UPDATE payment_webhook_events SET received_at = now()
      WHERE provider = $1 AND event_id = $2 AND processed_at IS NULL AND received_at <= now() - make_interval(secs => $3) RETURNING event_id`,
    [provider, eventId, WEBHOOK_IN_PROGRESS_SECONDS],
  );
  if (retaken.length) return "new";
  const row = await db.one<{ processed_at: string | null }>(`SELECT processed_at FROM payment_webhook_events WHERE provider = $1 AND event_id = $2`, [provider, eventId]);
  // Borrado entre las dos consultas (falló el que lo procesaba): que el proveedor reintente.
  return row?.processed_at ? "duplicate" : "in_progress";
}

async function finishEvent(db: Db, provider: string, eventId: string) {
  await db.query(`UPDATE payment_webhook_events SET processed_at = now() WHERE provider = $1 AND event_id = $2`, [provider, eventId]);
}

async function forgetEvent(db: Db, provider: string, eventId: string) {
  await db.query(`DELETE FROM payment_webhook_events WHERE provider = $1 AND event_id = $2 AND processed_at IS NULL`, [provider, eventId]);
}

/** Procesa un evento tomado con claimWebhookEvent: lo marca procesado al terminar o lo suelta si falla. */
export async function processWebhookEvent(db: Db, provider: string, eventId: string, run: () => Promise<void>) {
  const claim = await claimWebhookEvent(db, provider, eventId);
  if (claim !== "new") return claim;
  try {
    await run();
  } catch (err) {
    await forgetEvent(db, provider, eventId).catch(() => {}); // que el proveedor reintente
    throw err;
  }
  await finishEvent(db, provider, eventId);
  return claim;
}

type Cancel = { provider: string; id: string };

async function cancelProviderSubscription(c: Cancel) {
  if (c.provider === "stripe") await stripeCancelSubscription(c.id);
  else if (c.provider === "mercadopago") await mpCancelPreapproval(c.id);
}

/**
 * Cambio de suscripción de una organización sin tener la organización bloqueada durante las llamadas al proveedor
 * (hasta 20 s, frenando cuotas e invitaciones). `decide` corre con la organización bloqueada y dice qué hacer:
 * aplicar (`apply`, en la misma transacción), no hacer nada, o cancelar antes una suscripción en el proveedor
 * (`cancel`). La cancelación se hace fuera de la transacción y después se vuelve a decidir con un bloqueo nuevo: si
 * la suscripción vigente cambió mientras tanto (otra confirmación simultánea), se decide sobre la nueva; las ya
 * canceladas en esta pasada no se vuelven a cancelar.
 */
export async function changeSubscription(
  db: Db,
  tenantId: string,
  decide: (t: { billing_provider: string | null; subscription_id: string | null }, tx: Db) => Promise<{ cancel?: Cancel; apply: boolean }>,
  apply: (tx: Db) => Promise<void>,
) {
  const canceled = new Set<string>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const todo = await db.tx(async (tx): Promise<Cancel | null> => {
      const t = await tx.one<any>(`SELECT billing_provider, subscription_id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      if (!t) return null;
      const d = await decide(t, tx);
      if (d.cancel && !canceled.has(`${d.cancel.provider}:${d.cancel.id}`)) return d.cancel;
      if (d.apply) await apply(tx);
      return null;
    });
    if (!todo) return;
    await cancelProviderSubscription(todo);
    canceled.add(`${todo.provider}:${todo.id}`);
  }
  // La suscripción vigente siguió cambiando: error, y el proveedor reintenta el evento.
  throw new AppError(409, "subscription_changing", "La suscripción de la organización cambió mientras se procesaba el evento");
}

const isPlan = (p: unknown): p is PlanId => typeof p === "string" && (PLAN_IDS as readonly string[]).includes(p);

// ───────────────────────────── Stripe ─────────────────────────────

export async function handleStripeEvent(db: Db, event: any) {
  const obj = event?.data?.object ?? {};
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (obj.mode === "payment") {
        const paymentId = obj.metadata?.paymentId;
        if (!paymentId) return;
        // Pix y otros medios asíncronos llegan con payment_status=unpaid y se confirman después.
        if (obj.payment_status !== "paid") return;
        const p = await db.one<any>(`SELECT amount, currency FROM envelope_payments WHERE id = $1`, [paymentId]);
        if (!p) return;
        if (obj.amount_total !== toMinorUnits(Number(p.amount)) || String(obj.currency).toUpperCase() !== String(p.currency).toUpperCase()) {
          throw new AppError(400, "payment_mismatch", "El monto o la moneda del pago no coinciden con el cobro");
        }
        const res = await markPaymentPaid(db, paymentId, {
          providerPaymentId: typeof obj.payment_intent === "string" ? obj.payment_intent : obj.id,
          payerRecipientId: obj.metadata?.recipientId ?? null,
          checkoutRef: obj.id ?? null,
          receipt: { provider: "stripe", sessionId: obj.id, paymentIntent: obj.payment_intent ?? null, amountTotal: obj.amount_total, currency: obj.currency },
        });
        // Segundo cobro de la misma deuda (p. ej. el checkout del pagador anterior): se reembolsa, como en Mercado Pago.
        if (res?.duplicate) await refundDuplicatePayment(db, paymentId, res.duplicate, "stripe");
      } else if (obj.mode === "subscription") {
        const tenantId = obj.metadata?.tenantId;
        const plan = obj.metadata?.plan;
        if (!tenantId || !isPlan(plan)) return;
        // Medios asíncronos (Boleto, débito): el checkout se completa sin cobrar y el plan se activa recién con
        // async_payment_succeeded (que vuelve por acá con payment_status=paid), igual que los cobros al firmar.
        if (obj.payment_status === "unpaid") return;
        const subscriptionId = typeof obj.subscription === "string" ? obj.subscription : null;
        // Otra suscripción vigente (otro checkout de Stripe pagado en paralelo, o una de Mercado Pago autorizada mientras
        // este seguía abierto): queda la que se acaba de pagar y la anterior se cancela. Si no, la anterior seguiría
        // cobrando y, al pisarse subscription_id, ya no se podría ver ni cancelar desde la app.
        // Decidido con la organización bloqueada (changeSubscription): dos confirmaciones simultáneas leían la misma
        // suscripción anterior, cancelaban esa y la última pisaba a la otra, que seguía cobrando sin que la app la viera.
        // La cancelación en el proveedor va fuera del bloqueo y se revalida después.
        // Fecha de renovación desde el alta (si no, quedaba vacía, o la de la suscripción anterior, hasta el primer
        // "updated"). Mejor esfuerzo: sin ella igual se activa el plan.
        const renewsAt = subscriptionId ? await stripeGetSubscriptionPeriodEnd(subscriptionId).catch(() => null) : null;
        await changeSubscription(
          db,
          tenantId,
          async (t) => ({
            cancel: t.subscription_id && t.subscription_id !== subscriptionId && t.billing_provider ? { provider: t.billing_provider, id: t.subscription_id } : undefined,
            apply: true,
          }),
          (tx) =>
            applySubscription(tx, tenantId, {
              plan,
              provider: "stripe",
              customerId: typeof obj.customer === "string" ? obj.customer : null,
              subscriptionId,
              status: "active",
              renewsAt,
              source: "Stripe",
            }),
        );
        if (obj.metadata?.checkoutId) await db.query(`UPDATE billing_checkouts SET status = 'completed', completed_at = now() WHERE id = $1`, [obj.metadata.checkoutId]);
      }
      return;
    }
    case "checkout.session.async_payment_failed": {
      if (obj.mode === "payment" && obj.metadata?.paymentId) {
        await markPaymentFailed(db, obj.metadata.paymentId, "pago rechazado por Stripe", obj.metadata.recipientId ?? null, { checkoutRef: obj.id ?? null, ref: obj.id ?? null });
      }
      return;
    }
    // Reembolsos y disputas hechos en Stripe (o la confirmación de un reembolso propio). El objeto es el cargo o la
    // disputa; el cobro se busca por su PaymentIntent. El estado del sobre no cambia.
    case "charge.refunded": {
      const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      if (!pi) return;
      const full = obj.refunded === true || (Number.isFinite(obj.amount) && obj.amount_refunded >= obj.amount);
      await markPaymentRefundedByProvider(db, "stripe", pi, { full, amountRefunded: Number.isFinite(obj.amount_refunded) ? obj.amount_refunded / 100 : null });
      return;
    }
    case "charge.dispute.created": {
      const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      if (!pi || !obj.id) return;
      await markPaymentDisputed(db, "stripe", pi, { disputeId: obj.id, reason: obj.reason ?? null, amount: Number.isFinite(obj.amount) ? obj.amount / 100 : null });
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const tenantId = obj.metadata?.tenantId;
      if (!tenantId) return;
      await db.tx(async (tx) => {
        const t = await tx.one<any>(`SELECT subscription_id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
        // Solo la suscripción vigente. Sin suscripción registrada no se acepta ninguna: Stripe no garantiza el orden de
        // los eventos, y un "updated" (status active) atrasado de una suscripción ya borrada volvía a dar el plan pago
        // sin cobro. El alta la hace checkout.session.completed.
        if (!t?.subscription_id || t.subscription_id !== obj.id) return;
        const ended = event.type === "customer.subscription.deleted" || ["canceled", "incomplete_expired"].includes(obj.status);
        // "unpaid": Stripe no la cancela (si se paga la factura vuelve a "active"). Se baja a Free pero sigue vinculada:
        // si se desvinculaba, el "active" posterior se ignoraba y el cliente que pagó quedaba en Free (y sin portal).
        const unpaid = obj.status === "unpaid";
        const plan: PlanId = ended || unpaid ? "free" : isPlan(obj.metadata?.plan) ? obj.metadata.plan : "free";
        await applySubscription(tx, tenantId, {
          plan,
          provider: ended ? null : "stripe",
          customerId: typeof obj.customer === "string" ? obj.customer : null,
          subscriptionId: ended ? null : obj.id,
          status: obj.status ?? (ended ? "canceled" : "active"),
          renewsAt: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
          source: "Stripe",
        });
      });
      return;
    }
    default:
      return;
  }
}

// ───────────────────────────── Mercado Pago ─────────────────────────────

export async function handleMercadoPagoNotification(db: Db, type: string, dataId: string) {
  if (type === "payment") {
    const pay = await mpGetPayment(dataId);
    const ref = pay.externalReference ?? "";
    if (!ref.startsWith("pay:")) return;
    // pay:<cobro>[:<pagador para el que se armó el checkout>[:<referencia del checkout>]] (las preferencias viejas no
    // traen el pagador ni la referencia).
    const [paymentId, payerRecipientId, checkoutRef] = ref.slice(4).split(":");
    if (pay.status === "approved") {
      // Monto y moneda son obligatorios: sin ellos no se puede comprobar que se pagó lo que se cobra.
      if (!Number.isFinite(pay.amount) || !pay.currency) {
        throw new AppError(400, "payment_mismatch", "Mercado Pago no informó el monto o la moneda del pago");
      }
      const res = await markPaymentPaid(db, paymentId, {
        providerPaymentId: pay.id,
        payerRecipientId: payerRecipientId || null,
        checkoutRef: checkoutRef || null,
        amount: pay.amount,
        currency: pay.currency,
        receipt: { provider: "mercadopago", paymentId: pay.id, method: pay.method, approvedAt: pay.approvedAt },
      });
      // Segundo cobro de la misma preferencia (p. ej. un Boleto acreditado después de pagar con tarjeta): se reembolsa.
      // Si el reembolso falla, la notificación da error y Mercado Pago la reintenta.
      if (res?.duplicate) await refundDuplicatePayment(db, paymentId, res.duplicate);
      else {
        // Ya acreditado: la preferencia de Checkout Pro se cierra para que no se pueda pagar otra vez (mejor esfuerzo).
        const row = await db.one<any>(`SELECT checkout_id FROM envelope_payments WHERE id = $1 AND provider = 'mercadopago'`, [paymentId]);
        if (row?.checkout_id) await mpExpirePreference(row.checkout_id).catch(() => undefined);
      }
    } else if (["rejected", "cancelled"].includes(pay.status)) {
      await markPaymentFailed(db, paymentId, `pago ${pay.status} en Mercado Pago`, payerRecipientId || null, { checkoutRef: checkoutRef || null, ref: pay.id });
    } else if (pay.status === "refunded") {
      // Reembolso total hecho en Mercado Pago (o la confirmación de uno propio). Solo cuenta si es el pago acreditado.
      await markPaymentRefundedByProvider(db, "mercadopago", pay.id, { full: true });
    } else if (pay.status === "charged_back") {
      await markPaymentDisputed(db, "mercadopago", pay.id, { disputeId: `mp:${pay.id}`, reason: "charged_back" });
    }
    return;
  }
  if (type === "subscription_preapproval" || type === "preapproval") {
    const pre = await mpGetPreapproval(dataId);
    const m = /^sub:([0-9a-f-]{36}):(\w+)$/.exec(pre.externalReference ?? "");
    if (!m || !isPlan(m[2])) return;
    const [, tenantId, plan] = m;
    const active = pre.status === "authorized";
    const ended = ["cancelled", "paused"].includes(pre.status);
    if (!active && !ended) return; // pending: todavía no autorizó
    // Decidido con la organización bloqueada (como el alta por Stripe): dos altas simultáneas no dejan una cobrando sin
    // registrar. Las cancelaciones en el proveedor van fuera del bloqueo (changeSubscription).
    await changeSubscription(
      db,
      tenantId,
      async (t, tx) => {
        if (ended) {
          // Solo baja el plan si la que se cancela es la suscripción vigente (no una anterior reemplazada por otra).
          return { apply: t.billing_provider === "mercadopago" && t.subscription_id === pre.id };
        }
        if (t.billing_provider === "mercadopago" && t.subscription_id && t.subscription_id !== pre.id) {
          // Dos suscripciones autorizadas: queda la del checkout más reciente y la otra se cancela para no cobrar dos
          // veces (la notificación de una anterior puede llegar tarde y no tiene que pisar a la nueva).
          const started = async (ref: string) =>
            (await tx.one<any>(`SELECT max(created_at) AS at FROM billing_checkouts WHERE tenant_id = $1 AND provider = 'mercadopago' AND provider_ref = $2`, [tenantId, ref]))?.at;
          const [mine, theirs] = [await started(pre.id), await started(t.subscription_id)];
          if (mine && theirs && new Date(mine) < new Date(theirs)) return { cancel: { provider: "mercadopago", id: pre.id }, apply: false };
          return { cancel: { provider: "mercadopago", id: t.subscription_id }, apply: true };
        }
        // Una de Stripe pagada antes: queda la recién autorizada y la de Stripe se cancela (si no, cobrarían las dos).
        if (t.billing_provider === "stripe" && t.subscription_id) return { cancel: { provider: "stripe", id: t.subscription_id }, apply: true };
        return { apply: true };
      },
      (tx) =>
        applySubscription(tx, tenantId, {
          plan: active ? (plan as PlanId) : "free",
          provider: active ? "mercadopago" : null,
          subscriptionId: active ? pre.id : null,
          status: pre.status,
          renewsAt: pre.nextPaymentDate,
          source: "Mercado Pago",
        }),
    );
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

function claimReply(reply: FastifyReply, claim: "new" | "duplicate" | "in_progress") {
  if (claim === "duplicate") return { received: true, duplicate: true };
  // Otro pedido lo está procesando: 409 para que el proveedor reintente más tarde (si ese falla, el reintento lo procesa).
  if (claim === "in_progress") return reply.code(409).send({ error: { code: "event_in_progress", message: "El evento se está procesando; reintentar más tarde" } });
  return { received: true };
}

export async function billingWebhookRoutes(app: FastifyInstance, s: Services) {
  await app.register(async (o) => {
    // Stripe firma el cuerpo exacto: se recibe como texto y se parsea después de verificar.
    o.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    const rl = { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } };

    o.post("/v1/integrations/payments/stripe/webhook", rl, async (req: FastifyRequest, reply) => {
      const secret = config.billing.stripe.webhookSecret;
      const raw = String(req.body ?? "");
      if (!secret || !verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, secret)) {
        return reply.code(400).send({ error: { code: "invalid_signature", message: "Firma inválida" } });
      }
      let event: any;
      try {
        event = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: { code: "invalid_json", message: "JSON inválido" } });
      }
      if (!event?.id) return { received: true, duplicate: true };
      const claim = await processWebhookEvent(s.db, "stripe", event.id, () => handleStripeEvent(s.db, event));
      return claimReply(reply, claim);
    });

    o.post<{ Querystring: Record<string, string> }>("/v1/integrations/payments/mercadopago/webhook", rl, async (req, reply) => {
      let body: any = {};
      try {
        body = req.body ? JSON.parse(String(req.body)) : {};
      } catch {
        body = {};
      }
      const q = req.query ?? {};
      const type = String(body.type ?? body.topic ?? q.type ?? q.topic ?? "");
      // El id firmado (x-signature) es el de la query: es el que se procesa, no uno distinto del cuerpo.
      const dataId = String(q["data.id"] ?? body?.data?.id ?? q.id ?? "");
      if (!type || !dataId) return reply.code(400).send({ error: { code: "invalid_notification", message: "Falta type o data.id" } });
      const secret = config.billing.mercadopago.webhookSecret;
      if (secret) {
        const ok = verifyMercadoPagoSignature({
          xSignature: req.headers["x-signature"] as string | undefined,
          xRequestId: req.headers["x-request-id"] as string | undefined,
          dataId,
          secret,
        });
        if (!ok) return reply.code(400).send({ error: { code: "invalid_signature", message: "Firma inválida" } });
      } else if (config.environment === "prod") {
        return reply.code(503).send({ error: { code: "not_configured", message: "MP_WEBHOOK_SECRET no configurado" } });
      }
      // Solo partes firmadas (data.id y x-request-id): con type/action del cuerpo, cambiarlos reprocesaba la misma notificación.
      const eventId = `${dataId}:${String(req.headers["x-request-id"] ?? "")}`;
      const claim = await processWebhookEvent(s.db, "mercadopago", eventId, () => handleMercadoPagoNotification(s.db, type, dataId));
      return claimReply(reply, claim);
    });
  });
}
