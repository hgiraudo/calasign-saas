// Plan y suscripción de la organización: resumen con uso, checkout (Stripe Billing, Mercado Pago preapproval o
// proveedor de prueba), portal y cancelación. La confirmación llega por webhook (webhooks.ts) o por la página simulada.
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  BILLING_CURRENCIES,
  BillingCheckoutInput,
  BillingCurrencyInput,
  PLAN_IDS,
  PLAN_PRICES,
  PLANS,
  type BillingCurrency,
  type BillingOverview,
  type BillingProvider,
  type PlanId,
} from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors";
import { iso, randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import { recordAudit } from "../audit";
import { authenticate, clientInfo, type Services } from "../context";
import { mockPage, mockPageCsp } from "./mock-page";
import { tenantPlan, usageThisMonth } from "./plans";
import {
  ProviderError,
  mpCancelPreapproval,
  mpCreatePreapproval,
  providerConfigured,
  stripeCancelSubscription,
  stripeCreatePortal,
  stripeCreateSubscriptionCheckout,
} from "./providers";

function priceOf(plan: PlanId, currency: BillingCurrency): number | null {
  if (plan === "free") return 0;
  return PLAN_PRICES[plan][currency] ?? null;
}

function formatMoney(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("es", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** Aplica el resultado de una suscripción (webhook verificado o checkout simulado). */
export async function applySubscription(
  db: Db,
  tenantId: string,
  s: {
    plan: PlanId;
    provider: BillingProvider | null;
    customerId?: string | null;
    subscriptionId?: string | null;
    status: string;
    renewsAt?: string | null;
    source: string;
  },
) {
  const before = await db.one<any>(`SELECT billing_plan FROM tenants WHERE id = $1`, [tenantId]);
  if (!before) return;
  await db.query(
    `UPDATE tenants SET billing_plan = $2, plan = $2, billing_provider = $3,
       billing_customer_id = COALESCE($4, billing_customer_id), subscription_id = $5, subscription_status = $6,
       plan_renews_at = $7, plan_updated_at = now()
     WHERE id = $1`,
    [tenantId, s.plan, s.provider, s.customerId ?? null, s.subscriptionId ?? null, s.status, s.renewsAt ?? null],
  );
  if (before.billing_plan !== s.plan) {
    await recordAudit(db, {
      tenantId,
      action: "billing.plan_changed",
      actor: { type: "system", label: s.source },
      targetType: "tenant",
      targetId: tenantId,
      data: { from: before.billing_plan, to: s.plan, provider: s.provider, status: s.status },
    });
  }
}

export async function billingOverview(db: Db, tenantId: string): Promise<BillingOverview> {
  const t = await db.one<any>(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
  if (!t) throw notFound("Organización");
  const { plan, isDefault } = await tenantPlan(db, tenantId);
  const currency = ((BILLING_CURRENCIES as readonly string[]).includes(t.billing_currency) ? t.billing_currency : "USD") as BillingCurrency;
  return {
    plan,
    defaultPlan: isDefault,
    currency,
    subscription: {
      provider: t.billing_provider ?? null,
      status: t.subscription_status ?? null,
      renewsAt: iso(t.plan_renews_at),
      manageable: Boolean(t.subscription_id) || plan.id !== "free",
    },
    usage: await usageThisMonth(db, tenantId),
    plans: PLAN_IDS.map((id) => ({ ...PLANS[id], price: priceOf(id, currency) })),
    providers: (["stripe", "mercadopago", "mock"] as const)
      .filter((p) => p !== "mock" || config.billing.mockEnabled)
      .map((id) => ({ id, configured: providerConfigured(id) })),
  };
}

function pickProvider(requested: BillingProvider | undefined, currency: BillingCurrency): BillingProvider {
  if (requested) {
    if (!providerConfigured(requested)) throw badRequest("provider_not_configured", `El proveedor ${requested} no está configurado`);
    return requested;
  }
  // Monedas locales: Mercado Pago (Pix/PSE) si está; si no, Stripe; si no, el de prueba.
  const order: BillingProvider[] = currency === "USD" ? ["stripe", "mercadopago", "mock"] : ["mercadopago", "stripe", "mock"];
  const p = order.find((x) => providerConfigured(x));
  if (!p) throw badRequest("provider_not_configured", "No hay ningún proveedor de cobro configurado");
  return p;
}

export async function subscriptionRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.get("/v1/billing", { preHandler: auth }, async (req) => billingOverview(s.db, req.auth!.tenantId));

  app.patch("/v1/billing/currency", { preHandler: auth }, async (req) => {
    const input = BillingCurrencyInput.parse(req.body);
    await s.db.query(`UPDATE tenants SET billing_currency = $2 WHERE id = $1`, [req.auth!.tenantId, input.currency]);
    return billingOverview(s.db, req.auth!.tenantId);
  });

  app.post("/v1/billing/checkout", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const a = req.auth!;
    const input = BillingCheckoutInput.parse(req.body);
    const t = await s.db.one<any>(`SELECT * FROM tenants WHERE id = $1`, [a.tenantId]);
    const currency = (input.currency ?? t.billing_currency ?? "USD") as BillingCurrency;
    const amount = priceOf(input.plan, currency);
    if (!amount) throw badRequest("invalid_plan", "Ese plan no tiene precio en esa moneda");
    const provider = pickProvider(input.provider, currency);
    // Cambio de plan con una suscripción vigente: es un checkout nuevo. Cuando se confirma, el webhook cancela la
    // anterior (webhooks.ts), así no cobran las dos. El portal de Stripe no sirve para esto: los precios se crean en
    // cada checkout (price_data) y el portal solo cambia a productos del catálogo, así que mandar ahí dejaba al cliente
    // sin forma de subir de plan hasta que venciera el período.
    const current = t.subscription_id && ["stripe", "mercadopago"].includes(t.billing_provider) ? t.billing_provider : null;
    if (current && t.billing_plan === input.plan) throw conflict("already_subscribed", `La organización ya tiene el plan ${PLANS[input.plan].name}`);
    const checkoutId = uuidv7();
    const back = `${config.appUrl}/app/settings/billing`;
    const user = a.userId ? await s.db.one<any>(`SELECT email FROM users WHERE id = $1`, [a.userId]) : null;
    let url: string;
    let providerRef: string | null = null;
    let nonceHash: string | null = null;
    try {
      if (provider === "mock") {
        const nonce = randomToken(24);
        nonceHash = sha256Hex(nonce);
        url = `${config.appUrl}/v1/billing/mock/checkout/${checkoutId}?n=${nonce}`;
      } else if (provider === "stripe") {
        const c = await stripeCreateSubscriptionCheckout({
          planName: PLANS[input.plan].name,
          amount,
          currency,
          successUrl: `${back}?checkout=success`,
          cancelUrl: `${back}?checkout=cancel`,
          metadata: { tenantId: a.tenantId, plan: input.plan, checkoutId },
          customerId: t.billing_provider === "stripe" ? t.billing_customer_id : null,
          customerEmail: user?.email ?? null,
        });
        url = c.url;
        providerRef = c.id;
      } else {
        if (!user?.email) throw badRequest("email_required", "Mercado Pago necesita el correo de un usuario para la suscripción");
        const c = await mpCreatePreapproval({
          reason: `CalaSign ${PLANS[input.plan].name}`,
          externalReference: `sub:${a.tenantId}:${input.plan}`,
          payerEmail: user.email,
          amount,
          currency,
          backUrl: `${back}?checkout=success`,
        });
        url = c.url;
        providerRef = c.id;
      }
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(502, "billing_provider_error", `No se pudo iniciar el pago: ${err.message}`);
      throw err;
    }
    await s.db.query(
      `INSERT INTO billing_checkouts (id, tenant_id, provider, plan, currency, amount, provider_ref, nonce_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [checkoutId, a.tenantId, provider, input.plan, currency, amount, providerRef, nonceHash, a.userId],
    );
    const { ip, userAgent } = clientInfo(req);
    await recordAudit(s.db, {
      tenantId: a.tenantId,
      action: "billing.checkout_started",
      actor: { type: a.apiKeyId ? "api_key" : "user", id: a.userId ?? a.apiKeyId, label: a.actor.label },
      data: { plan: input.plan, provider, currency, amount },
      ip,
      userAgent,
    });
    return { url, provider };
  });

  app.post("/v1/billing/portal", { preHandler: auth }, async (req) => {
    const t = await s.db.one<any>(`SELECT * FROM tenants WHERE id = $1`, [req.auth!.tenantId]);
    if (t.billing_provider !== "stripe" || !t.billing_customer_id) {
      throw conflict("portal_not_available", "El portal de facturación está disponible para suscripciones de Stripe");
    }
    try {
      return { url: await stripeCreatePortal(t.billing_customer_id, `${config.appUrl}/app/settings/billing`) };
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(502, "billing_provider_error", err.message);
      throw err;
    }
  });

  /** Baja al plan Free (cancela la suscripción si hay). */
  app.post("/v1/billing/cancel", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const t = await s.db.one<any>(`SELECT * FROM tenants WHERE id = $1`, [a.tenantId]);
    try {
      if (t.subscription_id && t.billing_provider === "mercadopago") await mpCancelPreapproval(t.subscription_id);
      if (t.subscription_id && t.billing_provider === "stripe") {
        throw conflict("use_portal", "Las suscripciones de Stripe se cancelan desde el portal de facturación");
      }
    } catch (err) {
      if (err instanceof ProviderError) throw new AppError(502, "billing_provider_error", err.message);
      throw err;
    }
    await applySubscription(s.db, a.tenantId, { plan: "free", provider: null, subscriptionId: null, status: "canceled", source: a.actor.label ?? "usuario" });
    return billingOverview(s.db, a.tenantId);
  });

  // ───────── Checkout simulado (fuera de producción) ─────────
  type M = { Params: { id: string }; Querystring: { n?: string } };
  async function loadMock(id: string, nonce: string | undefined) {
    if (!config.billing.mockEnabled) throw notFound("Checkout");
    const c = await s.db.one<any>(`SELECT * FROM billing_checkouts WHERE id = $1 AND provider = 'mock'`, [id]);
    if (!c || !nonce || !c.nonce_hash || sha256Hex(nonce) !== c.nonce_hash) throw notFound("Checkout");
    return c;
  }

  await app.register(async (o) => {
    o.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    o.get<M>("/v1/billing/mock/checkout/:id", async (req, reply: FastifyReply) => {
      const c = await loadMock(req.params.id, req.query.n);
      reply.type("text/html; charset=utf-8").header("content-security-policy", mockPageCsp()).header("referrer-policy", "same-origin");
      return mockPage({
        title: "Suscripción simulada",
        lead: "Suscripción mensual",
        description: `CalaSign ${PLANS[c.plan as PlanId].name}`,
        amount: `${formatMoney(Number(c.amount), c.currency)} / mes`,
        action: `/v1/billing/mock/checkout/${encodeURIComponent(c.id)}/complete?n=${encodeURIComponent(req.query.n!)}`,
        paid: c.status === "completed",
        payLabel: "Suscribirme",
      });
    });
    o.post<M>("/v1/billing/mock/checkout/:id/complete", async (req, reply) => {
      const c = await loadMock(req.params.id, req.query.n);
      const outcome = ((req.body as any)?.outcome ?? "paid") as string;
      if (outcome === "paid" && c.status === "open") {
        // Igual que el webhook de un proveedor real: si había una suscripción real vigente, se cancela; si no, seguiría
        // cobrando y, al pisarse subscription_id, ya no se podría ver ni cancelar desde la app.
        const t = await s.db.one<any>(`SELECT billing_provider, subscription_id FROM tenants WHERE id = $1`, [c.tenant_id]);
        try {
          if (t?.subscription_id && t.billing_provider === "stripe") await stripeCancelSubscription(t.subscription_id);
          if (t?.subscription_id && t.billing_provider === "mercadopago") await mpCancelPreapproval(t.subscription_id);
        } catch (err) {
          if (err instanceof ProviderError) throw new AppError(502, "billing_provider_error", `No se pudo cancelar la suscripción anterior: ${err.message}`);
          throw err;
        }
        await s.db.query(`UPDATE billing_checkouts SET status = 'completed', completed_at = now() WHERE id = $1`, [c.id]);
        const renews = new Date(Date.now() + 30 * 86400_000).toISOString();
        await applySubscription(s.db, c.tenant_id, {
          plan: c.plan,
          provider: "mock",
          customerId: `mock_cus_${c.tenant_id.slice(-8)}`,
          subscriptionId: `mock_sub_${c.id.slice(-8)}`,
          status: "active",
          renewsAt: renews,
          source: "Suscripción simulada",
        });
      }
      const back = `${config.appUrl}/app/settings/billing?checkout=${outcome === "paid" ? "success" : "cancel"}`;
      if ((req.headers.accept ?? "").includes("application/json")) return { ok: true, outcome };
      return reply.redirect(back, 303);
    });
  });
}
