// Contrato de la API v1 — integraciones (Fase 3): webhooks, firma embebida, anclas de texto.
import { z } from "zod";
import { FIELD_TYPES } from "./api";
import { FieldConditions, FieldFormula } from "./scale-logic";

// ───────────────────────────── Webhooks ─────────────────────────────

export const WEBHOOK_EVENT_TYPES = [
  "envelope.sent",
  "envelope.completed",
  "envelope.declined",
  "envelope.voided",
  "envelope.expired",
  "recipient.viewed",
  "recipient.signed",
  "recipient.declined",
  "recipient.approved",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number] | "webhook.test";

export const CreateWebhookInput = z.object({
  url: z.string().trim().url().max(2000),
  description: z.string().trim().max(200).optional().nullable(),
  /** Vacío o ausente = todos los eventos. */
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).max(WEBHOOK_EVENT_TYPES.length).optional(),
  active: z.boolean().optional(),
});
export type CreateWebhookInput = z.infer<typeof CreateWebhookInput>;

export const UpdateWebhookInput = CreateWebhookInput.partial();
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookInput>;

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  active: boolean;
  secretPrefix: string;
  /** Hasta cuándo se firma también con el secreto anterior (después de rotarlo). */
  previousSecretExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebhookResponse {
  webhook: WebhookEndpoint;
  /** Secreto para verificar la firma HMAC. Se muestra una sola vez. */
  secret: string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  envelopeId: string | null;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  lastStatusCode: number | null;
  lastResponse: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/** Cuerpo de cada entrega. Se firma con `CalaSign-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
export interface WebhookEventPayload {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  tenantId: string;
  data: {
    envelope: {
      id: string;
      subject: string;
      status: string;
      metadata: Record<string, unknown>;
      sentAt: string | null;
      completedAt: string | null;
      signedSha256: string | null;
      recipients: { id: string; name: string; email: string | null; role: string; status: string; routingOrder: number }[];
    } | null;
    /** Destinatario que originó el evento (viewed/signed/declined). */
    recipientId?: string | null;
    reason?: string | null;
  };
}

// ───────────────────────────── Firma embebida ─────────────────────────────

/** Orígenes https completos, sin ruta: https://app.cliente.com o https://*.cliente.com */
export const FrameAncestor = z
  .string()
  .trim()
  .max(300)
  .regex(/^(https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i, {
    message: "origen inválido (https://dominio[:puerto], sin ruta)",
  });

export const EmbedSettingsInput = z.object({ frameAncestors: z.array(FrameAncestor).max(20) });
export type EmbedSettingsInput = z.infer<typeof EmbedSettingsInput>;

export interface EmbedSettings {
  frameAncestors: string[];
}

export const CreateSigningUrlInput = z.object({
  /** A dónde volver al terminar (https; http solo para localhost). Recibe ?event=signing_complete|declined. */
  returnUrl: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u), {
      message: "returnUrl debe ser https",
    })
    .optional()
    .nullable(),
  /** Subconjunto de los orígenes autorizados de la organización (por defecto, todos). */
  frameAncestors: z.array(FrameAncestor).max(20).optional(),
});
export type CreateSigningUrlInput = z.infer<typeof CreateSigningUrlInput>;

export interface SigningUrlResponse {
  /** URL de un solo uso para el iframe o la redirección. */
  url: string;
  expiresAt: string;
  /** true: el firmante tiene código OTP y la URL solo se abre en una pestaña o redirección (no dentro de un iframe). */
  tabOnly?: boolean;
}

/** GET /v1/signing/:token/embed — configuración de la ceremonia embebida para la página del firmante. */
export interface SigningEmbedInfo {
  embedded: boolean;
  returnUrl: string | null;
}

/** Mensajes que la página del firmante envía a window.parent (postMessage) en modo embebido. */
export interface EmbedMessage {
  source: "calasign";
  /** "closed": el sobre terminó sin que este firmante firmara ni rechazara (anulado, vencido, rechazado por otro, completado). */
  type: "viewed" | "signing_complete" | "declined" | "error" | "closed";
  envelopeId: string | null;
  recipientId: string | null;
  /** Con "closed": estado del sobre. */
  status?: string;
}

// ───────────────────────────── Anclas de texto ─────────────────────────────

/**
 * Campo ubicado por un texto del PDF (p. ej. "\\firma1\\"). Se expande a un campo por cada aparición.
 * Offsets y tamaños en puntos PDF; offset relativo a la esquina superior izquierda del texto encontrado.
 */
export const AnchorFieldInput = z.object({
  id: z.string().uuid().optional(),
  /** Si se omite, se busca en todos los documentos del sobre. */
  documentId: z.string().uuid().optional(),
  recipientId: z.string().uuid(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(true),
  label: z.string().max(200).optional().nullable(),
  // Las mismas propiedades que un campo con coordenadas: sin declararlas acá, zod las descartaba en silencio
  // (un campo "solo lectura" con valor quedaba vacío y editable; un desplegable, sin opciones).
  value: z.string().max(2000).optional().nullable(),
  readOnly: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(100)).max(50).optional().nullable(),
  min: z.number().finite().optional().nullable(),
  max: z.number().finite().optional().nullable(),
  conditions: FieldConditions.optional().nullable(),
  formula: FieldFormula.optional().nullable(),
  anchor: z.object({
    text: z.string().min(1).max(100),
    offsetX: z.number().min(-2000).max(2000).default(0),
    offsetY: z.number().min(-2000).max(2000).default(0),
    width: z.number().positive().max(2000),
    height: z.number().positive().max(2000),
    caseSensitive: z.boolean().default(true),
    /** Si es false (por defecto) y el texto no aparece, la petición falla. */
    ignoreIfNotPresent: z.boolean().default(false),
  }),
});
export type AnchorFieldInput = z.input<typeof AnchorFieldInput>;
