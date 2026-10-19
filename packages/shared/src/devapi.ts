// Contrato de las ampliaciones de la API para integradores (docs/API-ROADMAP.md): API de eventos (polling y SSE),
// datos de formulario, clonado de sobres, operaciones en lote y rotación del secreto de un webhook.
import { z } from "zod";

// ───────────── Eventos ─────────────

/** Evento de la organización tal como lo devuelven GET /v1/events y /v1/events/stream. */
export interface ApiEvent {
  /** Único por evento (un registro de evidencia puede producir más de un evento, p. ej. recipient.declined + envelope.declined). */
  id: string;
  /** Tipo público (el mismo de los webhooks) o, con `scope=all`, el tipo de evidencia. */
  type: string;
  occurredAt: string;
  envelopeId: string;
  recipientId: string | null;
  /** Estado actual del sobre (no el del momento del evento). */
  envelope: { id: string; subject: string; status: string; metadata: Record<string, unknown> };
  data: Record<string, unknown>;
  /** Cursor para seguir desde este evento (`after`). */
  cursor: string;
}

export interface ListEventsResponse {
  items: ApiEvent[];
  /** Pasar como `after` en el próximo pedido. Siempre presente: si no hubo eventos nuevos, es el mismo que se envió. */
  nextCursor: string | null;
  /** true si hay más eventos ya disponibles (pedir de nuevo sin esperar). */
  hasMore: boolean;
}

// ───────────── Datos de formulario ─────────────

export interface FormDataField {
  id: string;
  label: string | null;
  type: string;
  documentId: string;
  page: number;
  value: string | null;
  /** Para firma e iniciales: si se completó (el valor es la imagen, no se devuelve). */
  filled: boolean;
  /** Oculto por la lógica condicional: no se estampó. */
  hidden: boolean;
  readOnly: boolean;
  attachment: { name: string | null; contentType: string; sizeBytes: number; sha256: string; downloadPath: string } | null;
}

export interface EnvelopeFormData {
  envelopeId: string;
  status: string;
  completedAt: string | null;
  recipients: {
    id: string;
    name: string;
    email: string | null;
    role: string;
    status: string;
    signedAt: string | null;
    fields: FormDataField[];
  }[];
  /** Vista plana etiqueta → valor (campos con valor y visibles; si dos campos comparten etiqueta, gana el primero con valor). */
  values: Record<string, string>;
}

// ───────────── Clonado ─────────────

export const CloneEnvelopeInput = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  message: z.string().max(5000).optional().nullable(),
  /** Reemplaza la metadata copiada (por defecto se copia la del original, con `clonedFrom`). */
  metadata: z.record(z.unknown()).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /** false = solo documentos (sin destinatarios ni campos). Por defecto true. */
  includeRecipients: z.boolean().optional(),
  /** false = sin campos. Por defecto true (requiere includeRecipients). */
  includeFields: z.boolean().optional(),
  /** Copiar también los valores que escribieron los firmantes (no solo los fijados por el remitente). Por defecto false. */
  includeValues: z.boolean().optional(),
});
export type CloneEnvelopeInput = z.infer<typeof CloneEnvelopeInput>;

// ───────────── Lote ─────────────

export const BATCH_ACTIONS = ["get", "void", "remind", "delete"] as const;

export const EnvelopeBatchInput = z
  .object({
    action: z.enum(BATCH_ACTIONS),
    ids: z.array(z.string().uuid()).min(1).max(100),
    /** Obligatorio con action=void. */
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((v) => v.action !== "void" || Boolean(v.reason), { message: "reason es obligatorio para anular", path: ["reason"] })
  .refine((v) => new Set(v.ids).size === v.ids.length, { message: "ids repetidos", path: ["ids"] });
export type EnvelopeBatchInput = z.infer<typeof EnvelopeBatchInput>;

export interface EnvelopeBatchResult {
  id: string;
  ok: boolean;
  status: number;
  /** Respuesta de la operación individual (get/void: detalle del sobre; remind: { notified }). */
  data?: unknown;
  error?: { code: string; message: string };
}

export interface EnvelopeBatchResponse {
  action: (typeof BATCH_ACTIONS)[number];
  succeeded: number;
  failed: number;
  results: EnvelopeBatchResult[];
}

// ───────────── Rotación del secreto de un webhook ─────────────

export const RotateWebhookSecretInput = z.object({
  /** Horas durante las que se sigue firmando también con el secreto anterior (0..168, por defecto 24). */
  graceHours: z.number().int().min(0).max(168).optional(),
});
export type RotateWebhookSecretInput = z.infer<typeof RotateWebhookSecretInput>;
