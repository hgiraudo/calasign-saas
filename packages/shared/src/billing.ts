// Fase 6 + facturación: planes, uso, cobros dentro del flujo de firma y servidor MCP para agentes de IA.
import { z } from "zod";

// ───────────────────────────── Planes ─────────────────────────────

export const PLAN_IDS = ["free", "starter", "business", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Funcionalidades que dependen del plan. */
export const PLAN_FEATURES = [
  "api", // API keys, OAuth y servidor MCP
  "webhooks",
  "branding",
  "payments", // cobrar al firmar
  "bulk_send",
  "web_forms",
  "kyc",
  "sso",
  "scim",
  "custom_domain",
  "white_label", // marca blanca: sin la marca de la plataforma, textos/plantillas, remitente propio, sub-marcas
] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** null = ilimitado */
  envelopesPerMonth: number | null;
  users: number | null;
  features: readonly PlanFeature[];
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: { id: "free", name: "Free", envelopesPerMonth: 5, users: 1, features: [] },
  starter: { id: "starter", name: "Starter", envelopesPerMonth: 50, users: 3, features: ["api", "webhooks", "branding"] },
  business: {
    id: "business",
    name: "Business",
    envelopesPerMonth: 1000,
    users: 50,
    features: ["api", "webhooks", "branding", "payments", "bulk_send", "web_forms", "kyc"],
  },
  enterprise: { id: "enterprise", name: "Enterprise", envelopesPerMonth: null, users: null, features: PLAN_FEATURES },
};

export const BILLING_CURRENCIES = ["USD", "BRL", "COP", "DOP", "HNL", "PEN"] as const;
export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];

/** Precio mensual por plan y moneda (lista de precios local, no conversión al tipo de cambio del día). */
export const PLAN_PRICES: Record<Exclude<PlanId, "free">, Record<BillingCurrency, number>> = {
  starter: { USD: 15, BRL: 79, COP: 59000, DOP: 890, HNL: 370, PEN: 55 },
  business: { USD: 49, BRL: 249, COP: 199000, DOP: 2890, HNL: 1210, PEN: 179 },
  enterprise: { USD: 199, BRL: 990, COP: 790000, DOP: 11500, HNL: 4900, PEN: 729 },
};

export const BILLING_PROVIDERS = ["stripe", "mercadopago", "mock"] as const;
export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export interface BillingUsage {
  period: string; // YYYY-MM
  envelopesSent: number;
  users: number;
  messages: { whatsapp: number; sms: number; email: number; telegram: number };
  kycChecks: number;
  /** null si la funcionalidad de IA no está instalada. */
  aiTokens: number | null;
}

export interface BillingOverview {
  plan: PlanDefinition;
  /** true si el plan sale del valor por defecto del entorno (sin suscripción). */
  defaultPlan: boolean;
  currency: BillingCurrency;
  subscription: {
    provider: BillingProvider | null;
    status: string | null;
    renewsAt: string | null;
    manageable: boolean;
  };
  usage: BillingUsage;
  plans: (PlanDefinition & { price: number | null })[];
  providers: { id: BillingProvider; configured: boolean }[];
}

export const BillingCheckoutInput = z.object({
  plan: z.enum(["starter", "business", "enterprise"]),
  currency: z.enum(BILLING_CURRENCIES).optional(),
  provider: z.enum(BILLING_PROVIDERS).optional(),
});
export type BillingCheckoutInput = z.infer<typeof BillingCheckoutInput>;

export const BillingCurrencyInput = z.object({ currency: z.enum(BILLING_CURRENCIES) });
export type BillingCurrencyInput = z.infer<typeof BillingCurrencyInput>;

/** Detalle del error 402 plan_limit. */
export interface PlanLimitDetails {
  plan: PlanId;
  limit?: "envelopes_per_month" | "users";
  feature?: PlanFeature;
  used?: number;
  max?: number | null;
  suggestedPlan: PlanId | null;
  upgradeUrl: string;
}

// ───────────────────────────── Cobro al firmar ─────────────────────────────

export const PAYMENT_PROVIDERS = ["stripe", "mercadopago", "mock"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export const PAYMENT_TIMINGS = ["before_sign", "after_sign"] as const;
export type PaymentTiming = (typeof PAYMENT_TIMINGS)[number];
export const PAYMENT_CURRENCIES = ["USD", "BRL", "COP", "DOP", "HNL", "PEN", "MXN", "ARS", "EUR"] as const;

export const EnvelopePaymentInput = z.object({
  amount: z.number().positive().max(100_000_000).multipleOf(0.01),
  currency: z.enum(PAYMENT_CURRENCIES),
  description: z.string().trim().min(1).max(200),
  /** Destinatario (firmante) que paga. */
  payerRecipientId: z.string().uuid(),
  timing: z.enum(PAYMENT_TIMINGS).default("after_sign"),
  provider: z.enum(PAYMENT_PROVIDERS),
});
export type EnvelopePaymentInput = z.input<typeof EnvelopePaymentInput>;

export type PaymentStatus = "pending" | "checkout_created" | "paid" | "failed" | "refunded";

export interface EnvelopePayment {
  id: string;
  amount: number;
  currency: string;
  description: string;
  payerRecipientId: string;
  timing: PaymentTiming;
  provider: PaymentProvider;
  status: PaymentStatus;
  paidAt: string | null;
  providerPaymentId: string | null;
  /**
   * El pago llegó con el sobre ya cerrado (anulado, rechazado o vencido) y se tiene que devolver. Mientras
   * `refundRequiredAt` tenga valor y `refundedAt` no, el reembolso está pendiente; `refundError` es el último error
   * del proveedor al intentarlo (el barrido lo reintenta).
   */
  refundRequiredAt: string | null;
  refundedAt: string | null;
  refundError: string | null;
}

/** Lo que ve el firmante. `required` = este destinatario es quien paga. */
export interface SignerPaymentInfo {
  required: boolean;
  amount: number | null;
  currency: string | null;
  description: string | null;
  timing: PaymentTiming | null;
  status: PaymentStatus | null;
  /** true si ahora puede pagar (before_sign: antes de firmar; after_sign: después). */
  canPay: boolean;
  /** true si la firma está bloqueada hasta pagar. */
  blocksSigning: boolean;
}

export interface PaymentProviderInfo {
  id: PaymentProvider;
  configured: boolean;
  /** Medios locales que ofrece el proveedor (documental, en español). */
  methods: string[];
  /** Los mismos medios como códigos estables, en el mismo orden que `methods`: la interfaz los traduce. */
  methodCodes: PaymentMethodCode[];
}

export const PAYMENT_METHOD_CODES = ["card", "pix", "wallet", "pse", "boleto", "cash", "simulated"] as const;
export type PaymentMethodCode = (typeof PAYMENT_METHOD_CODES)[number];

// ───────────────────────────── MCP ─────────────────────────────

export const MCP_TOOLS = [
  "list_envelopes",
  "get_envelope",
  "get_signing_status",
  "list_templates",
  "create_envelope_from_template",
  "send_envelope",
  "void_envelope",
  "download_signed_pdf",
  "create_envelope",
  "remind_recipients",
  "get_account",
] as const;
export type McpToolName = (typeof MCP_TOOLS)[number];

/** Herramientas que requieren `confirm: true` (acciones con efecto hacia afuera). */
export const MCP_CONFIRM_TOOLS: readonly McpToolName[] = ["send_envelope", "void_envelope", "remind_recipients"];
