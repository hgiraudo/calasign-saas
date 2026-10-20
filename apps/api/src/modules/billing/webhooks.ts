// Webhooks de Stripe y Mercado Pago: un endpoint por proveedor para cobros al firmar y suscripciones.
// Se verifica la firma antes de tocar nada, cada evento se procesa una sola vez, y en Mercado Pago el estado
// se consulta a la API (la notificación solo trae el id).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PlanId } from "@calasign/shared";
import { PLAN_IDS } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError } from "../../lib/errors";
import type { Services } from "../context";
import { markPaymentFailed, markPaymentPaid, refundDuplicatePayment } from "./payments";
import {
  mpCancelPreapproval,
  mpExpirePreference,
  mpGetPayment,
  mpGetPreapproval,
  stripeCancelSubscription,
  toMinorUnits,
  verifyMercadoPagoSignature,
  verifyStripeSignature,
} from "./providers";
import { applySubscription } from "./subscriptions";

/** true si el evento es nuevo (y queda registrado). */
async function firstTime(db: Db, provider: string, eventId: string): Promise<boolean> {
  const r = await db.query(`INSERT INTO payment_webhook_events (provider, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`, [provider, eventId]);
  return r.length > 0;
}

async function forgetEvent(db: Db, provider: string, eventId: string) {
  await db.query(`DELETE FROM payment_webhook_events WHERE provider = $1 AND event_id = $2`, [provider, eventId]);
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
        // Con la organización bloqueada: dos confirmaciones simultáneas leían la misma suscripción anterior, cancelaban
        // esa y la última pisaba a la otra, que seguía cobrando sin que la app la viera.
        await db.tx(async (tx) => {
          const t = await tx.one<any>(`SELECT billing_provider, subscription_id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
          if (t?.subscription_id && t.subscription_id !== subscriptionId) {
            if (t.billing_provider === "stripe") await stripeCancelSubscription(t.subscription_id);
            else if (t.billing_provider === "mercadopago") await mpCancelPreapproval(t.subscription_id);
          }
          await applySubscription(tx, tenantId, {
            plan,
            provider: "stripe",
            customerId: typeof obj.customer === "string" ? obj.customer : null,
            subscriptionId,
            status: "active",
            source: "Stripe",
          });
        });
        if (obj.metadata?.checkoutId) await db.query(`UPDATE billing_checkouts SET status = 'completed', completed_at = now() WHERE id = $1`, [obj.metadata.checkoutId]);
      }
      return;
    }
    case "checkout.session.async_payment_failed": {
      if (obj.mode === "payment" && obj.metadata?.paymentId) await markPaymentFailed(db, obj.metadata.paymentId, "pago rechazado por Stripe");
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
        const ended = event.type === "customer.subscription.deleted" || ["canceled", "unpaid", "incomplete_expired"].includes(obj.status);
        const plan: PlanId = ended ? "free" : isPlan(obj.metadata?.plan) ? obj.metadata.plan : "free";
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
    const paymentId = ref.slice(4);
    if (pay.status === "approved") {
      // Monto y moneda son obligatorios: sin ellos no se puede comprobar que se pagó lo que se cobra.
      if (!Number.isFinite(pay.amount) || !pay.currency) {
        throw new AppError(400, "payment_mismatch", "Mercado Pago no informó el monto o la moneda del pago");
      }
      const res = await markPaymentPaid(db, paymentId, {
        providerPaymentId: pay.id,
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
      await markPaymentFailed(db, paymentId, `pago ${pay.status} en Mercado Pago`);
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
    // Con la organización bloqueada (como el alta por Stripe): dos altas simultáneas no dejan una cobrando sin registrar.
    await db.tx(async (tx) => {
      const t = await tx.one<any>(`SELECT billing_provider, subscription_id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
      if (!t) return;
      if (ended) {
        // Solo baja el plan si la que se cancela es la suscripción vigente (no una anterior reemplazada por otra).
        if (t.billing_provider !== "mercadopago" || t.subscription_id !== pre.id) return;
      } else if (t.billing_provider === "mercadopago" && t.subscription_id && t.subscription_id !== pre.id) {
        // Dos suscripciones autorizadas: queda la del checkout más reciente y la otra se cancela para no cobrar dos veces
        // (la notificación de una anterior puede llegar tarde y no tiene que pisar a la nueva).
        const started = async (ref: string) =>
          (await tx.one<any>(`SELECT max(created_at) AS at FROM billing_checkouts WHERE tenant_id = $1 AND provider = 'mercadopago' AND provider_ref = $2`, [tenantId, ref]))?.at;
        const [mine, theirs] = [await started(pre.id), await started(t.subscription_id)];
        if (mine && theirs && new Date(mine) < new Date(theirs)) {
          await mpCancelPreapproval(pre.id);
          return;
        }
        await mpCancelPreapproval(t.subscription_id);
      } else if (t.billing_provider === "stripe" && t.subscription_id) {
        // Una de Stripe pagada antes: queda la recién autorizada y la de Stripe se cancela (si no, cobrarían las dos).
        await stripeCancelSubscription(t.subscription_id);
      }
      await applySubscription(tx, tenantId, {
        plan: active ? (plan as PlanId) : "free",
        provider: active ? "mercadopago" : null,
        subscriptionId: active ? pre.id : null,
        status: pre.status,
        renewsAt: pre.nextPaymentDate,
        source: "Mercado Pago",
      });
    });
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

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
      if (!event?.id || !(await firstTime(s.db, "stripe", event.id))) return { received: true, duplicate: true };
      try {
        await handleStripeEvent(s.db, event);
      } catch (err) {
        await forgetEvent(s.db, "stripe", event.id); // que Stripe reintente
        throw err;
      }
      return { received: true };
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
      if (!(await firstTime(s.db, "mercadopago", eventId))) return { received: true, duplicate: true };
      try {
        await handleMercadoPagoNotification(s.db, type, dataId);
      } catch (err) {
        await forgetEvent(s.db, "mercadopago", eventId);
        throw err;
      }
      return { received: true };
    });
  });
}
