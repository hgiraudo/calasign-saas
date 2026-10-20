// Adaptadores REST de Stripe y Mercado Pago (sin SDKs: fetch + verificación de firma de webhooks).
// Las funciones de verificación son puras para poder probarlas con fixtures.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    /** Stripe: error.code y error.param (p. ej. resource_missing / "customer"). */
    readonly code?: string | null,
    readonly param?: string | null,
  ) {
    super(message);
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ───────────────────────────── Stripe ─────────────────────────────

/** Codifica objetos anidados como Stripe espera: a[b][0][c]=v. */
export function stripeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  walk("", params);
  return out.join("&");
}

async function stripe(path: string, params: Record<string, unknown> | null, method = "POST", idempotencyKey?: string): Promise<any> {
  const key = config.billing.stripe.secretKey;
  if (!key) throw new ProviderError("stripe", 503, "Stripe no está configurado (STRIPE_SECRET_KEY)");
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${config.billing.stripe.apiBase}${path}`, {
    method,
    headers,
    body: params ? stripeForm(params) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError("stripe", res.status, body?.error?.message ?? `Stripe HTTP ${res.status}`, body?.error?.code ?? null, body?.error?.param ?? null);
  return body;
}

/** Monto en unidades mínimas (centavos). Las monedas de la región usan 2 decimales en Stripe. */
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

export async function stripeCreatePaymentCheckout(p: {
  amount: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  customerEmail?: string | null;
  /** Pedidos simultáneos con la misma clave reciben la misma sesión (no dos sesiones cobrables). */
  idempotencyKey?: string;
}): Promise<{ id: string; url: string }> {
  // Sin payment_method_types: los medios (tarjeta, Pix en cuentas de Brasil, etc.) salen de la configuración de la cuenta.
  const s = await stripe("/v1/checkout/sessions", {
    mode: "payment",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    customer_email: p.customerEmail ?? undefined,
    client_reference_id: p.metadata.paymentId,
    metadata: p.metadata,
    payment_intent_data: { metadata: p.metadata, description: p.description },
    line_items: [{ quantity: 1, price_data: { currency: p.currency.toLowerCase(), unit_amount: toMinorUnits(p.amount), product_data: { name: p.description } } }],
  }, "POST", p.idempotencyKey);
  return { id: s.id, url: s.url };
}

/** Estado de una sesión de Checkout: open (cobrable), complete o expired. */
export async function stripeGetCheckoutSession(id: string): Promise<{ id: string; status: string; url: string | null }> {
  const s = await stripe(`/v1/checkout/sessions/${encodeURIComponent(id)}`, null, "GET");
  return { id: s.id, status: s.status, url: s.url ?? null };
}

/** Vence una sesión de Checkout abierta: deja de ser cobrable. Si ya no estaba abierta (completa o vencida), no hace nada. */
export async function stripeExpireCheckoutSession(id: string): Promise<"expired" | "complete" | "already_expired"> {
  try {
    await stripe(`/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
    return "expired";
  } catch (err) {
    // Stripe responde 400 si la sesión no está abierta: se mira en qué quedó.
    const s = await stripeGetCheckoutSession(id);
    if (s.status === "complete") return "complete";
    if (s.status === "expired") return "already_expired";
    throw err;
  }
}

export async function stripeCreateSubscriptionCheckout(p: {
  planName: string;
  amount: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  customerId?: string | null;
  customerEmail?: string | null;
}): Promise<{ id: string; url: string }> {
  const s = await stripe("/v1/checkout/sessions", {
    mode: "subscription",
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    customer: p.customerId ?? undefined,
    customer_email: p.customerId ? undefined : p.customerEmail ?? undefined,
    client_reference_id: p.metadata.tenantId,
    metadata: p.metadata,
    subscription_data: { metadata: p.metadata },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: p.currency.toLowerCase(),
          unit_amount: toMinorUnits(p.amount),
          recurring: { interval: "month" },
          product_data: { name: `CalaSign ${p.planName}` },
        },
      },
    ],
  });
  return { id: s.id, url: s.url };
}

/** Fin del período vigente de una suscripción (en API recientes viene en cada ítem). null si no se informa. */
export async function stripeGetSubscriptionPeriodEnd(id: string): Promise<string | null> {
  const s = await stripe(`/v1/subscriptions/${encodeURIComponent(id)}`, null, "GET");
  const end = s?.current_period_end ?? s?.items?.data?.[0]?.current_period_end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : null;
}

/** Cancela una suscripción de inmediato. Si ya estaba cancelada o no existe, no es un error (el webhook se reintenta). */
export async function stripeCancelSubscription(id: string) {
  const path = `/v1/subscriptions/${encodeURIComponent(id)}`;
  try {
    await stripe(path, null, "DELETE");
  } catch (err) {
    if (!(err instanceof ProviderError) || (err.status !== 404 && err.status !== 400)) throw err;
    if (err.status === 404) return;
    const s = await stripe(path, null, "GET").catch(() => null);
    if (s?.status !== "canceled") throw err;
  }
}

export async function stripeCreatePortal(customerId: string, returnUrl: string): Promise<string> {
  const s = await stripe("/v1/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
  return s.url;
}

/**
 * Verifica el encabezado Stripe-Signature (t=…,v1=…): HMAC-SHA256(secret, `${t}.${payload}`) y tolerancia de tiempo.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripeSignature(payload: string, header: string | undefined, secret: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(",").map((x) => x.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
  return sigs.some((s) => safeEqualHex(s, expected));
}

// ───────────────────────────── Mercado Pago ─────────────────────────────

async function mp(path: string, body: unknown | null, method = "POST", idempotencyKey?: string): Promise<any> {
  const token = config.billing.mercadopago.accessToken;
  if (!token) throw new ProviderError("mercadopago", 503, "Mercado Pago no está configurado (MP_ACCESS_TOKEN)");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${config.billing.mercadopago.apiBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError("mercadopago", res.status, data?.message ?? `Mercado Pago HTTP ${res.status}`);
  return data;
}

const isMpTest = () => (config.billing.mercadopago.accessToken ?? "").startsWith("TEST-");

/** Checkout Pro: preferencia de pago. Pix (Brasil) y PSE (Colombia) los ofrece Checkout Pro según el país de la cuenta. */
export async function mpCreatePreference(p: {
  title: string;
  amount: number;
  currency: string;
  externalReference: string;
  notificationUrl: string;
  successUrl: string;
  failureUrl: string;
  payerEmail?: string | null;
}): Promise<{ id: string; url: string }> {
  const r = await mp("/checkout/preferences", {
    items: [{ title: p.title, quantity: 1, unit_price: p.amount, currency_id: p.currency }],
    external_reference: p.externalReference,
    notification_url: p.notificationUrl,
    back_urls: { success: p.successUrl, failure: p.failureUrl, pending: p.successUrl },
    auto_return: "approved",
    payer: p.payerEmail ? { email: p.payerEmail } : undefined,
  });
  return { id: r.id, url: isMpTest() && r.sandbox_init_point ? r.sandbox_init_point : r.init_point };
}

/** Vence una preferencia de Checkout Pro: el link deja de aceptar pagos. */
export async function mpExpirePreference(id: string) {
  // Mercado Pago documenta las fechas con offset ("2026-10-18T05:35:00.000-03:00"): se manda "+00:00" en vez de "Z".
  await mp(`/checkout/preferences/${encodeURIComponent(id)}`, { expires: true, expiration_date_to: new Date().toISOString().replace("Z", "+00:00") }, "PUT");
}

/**
 * Reembolso total de un pago. Una preferencia vencida no frena un pago iniciado antes (Boleto, efectivo y PSE se
 * acreditan días después): si llega cuando el sobre ya está cerrado, se devuelve.
 */
export async function mpRefundPayment(paymentId: string, idempotencyKey: string) {
  await mp(`/v1/payments/${encodeURIComponent(paymentId)}/refunds`, {}, "POST", idempotencyKey);
}

/** Reembolso total de un PaymentIntent de Stripe. */
export async function stripeRefundPayment(paymentIntent: string, idempotencyKey: string) {
  await stripe("/v1/refunds", { payment_intent: paymentIntent }, "POST", idempotencyKey);
}

export async function mpGetPayment(id: string): Promise<{
  id: string;
  status: string;
  externalReference: string | null;
  amount: number;
  currency: string;
  approvedAt: string | null;
  method: string | null;
}> {
  const r = await mp(`/v1/payments/${encodeURIComponent(id)}`, null, "GET");
  return {
    id: String(r.id),
    status: r.status,
    externalReference: r.external_reference ?? null,
    amount: Number(r.transaction_amount),
    currency: r.currency_id,
    approvedAt: r.date_approved ?? null,
    method: r.payment_method_id ?? null,
  };
}

export async function mpCreatePreapproval(p: {
  reason: string;
  externalReference: string;
  payerEmail: string;
  amount: number;
  currency: string;
  backUrl: string;
}): Promise<{ id: string; url: string }> {
  const r = await mp("/preapproval", {
    reason: p.reason,
    external_reference: p.externalReference,
    payer_email: p.payerEmail,
    back_url: p.backUrl,
    status: "pending",
    auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: p.amount, currency_id: p.currency },
  });
  return { id: r.id, url: r.init_point };
}

export async function mpGetPreapproval(id: string): Promise<{ id: string; status: string; externalReference: string | null; nextPaymentDate: string | null }> {
  const r = await mp(`/preapproval/${encodeURIComponent(id)}`, null, "GET");
  return { id: r.id, status: r.status, externalReference: r.external_reference ?? null, nextPaymentDate: r.next_payment_date ?? null };
}

export async function mpCancelPreapproval(id: string) {
  await mp(`/preapproval/${encodeURIComponent(id)}`, { status: "cancelled" }, "PUT");
}

/**
 * Verifica x-signature de Mercado Pago (ts=…,v1=…): HMAC-SHA256(secret, "id:<data.id>;request-id:<x-request-id>;ts:<ts>;").
 * Si data.id es alfanumérico va en minúsculas. Las partes ausentes se omiten del manifiesto.
 * https://www.mercadopago.com/developers/es/docs/your-integrations/notifications/webhooks
 */
export function verifyMercadoPagoSignature(p: {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  secret: string;
  toleranceSec?: number;
  nowMs?: number;
}): boolean {
  if (!p.xSignature) return false;
  const parts = Object.fromEntries(p.xSignature.split(",").map((x) => x.trim().split("=").map((y) => y.trim())));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !/^\d+$/.test(ts)) return false;
  if (p.toleranceSec !== undefined) {
    // ts viene en milisegundos.
    const now = p.nowMs ?? Date.now();
    if (Math.abs(now - Number(ts)) > p.toleranceSec * 1000) return false;
  }
  let manifest = "";
  if (p.dataId) manifest += `id:${/^[a-z0-9]+$/i.test(p.dataId) ? p.dataId.toLowerCase() : p.dataId};`;
  if (p.xRequestId) manifest += `request-id:${p.xRequestId};`;
  manifest += `ts:${ts};`;
  const expected = createHmac("sha256", p.secret).update(manifest).digest("hex");
  return safeEqualHex(v1, expected);
}

export function providerConfigured(id: "stripe" | "mercadopago" | "mock"): boolean {
  if (id === "stripe") return Boolean(config.billing.stripe.secretKey);
  if (id === "mercadopago") return Boolean(config.billing.mercadopago.accessToken);
  return config.billing.mockEnabled;
}
