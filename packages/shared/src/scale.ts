// Fase 4 — escala: envío masivo, formularios web públicos, lógica condicional y campos calculados.
import { z } from "zod";
import { CHANNELS, ID_DOCUMENT_TYPES, LOCALES, type Locale, UserMetadata } from "./api";

export * from "./scale-logic";

// ───────────────────────────── Envío masivo ─────────────────────────────

export const BULK_SEND_STATUSES = ["queued", "running", "completed", "cancelled"] as const;
export type BulkSendStatus = (typeof BULK_SEND_STATUSES)[number];

export const BULK_ITEM_STATUSES = ["pending", "processing", "sent", "failed", "cancelled"] as const;
export type BulkItemStatus = (typeof BULK_ITEM_STATUSES)[number];

export const BULK_MAX_ROWS = 5000;

/** Destinatario de una fila: se asigna a un rol de la plantilla por nombre o por id. */
export const BulkRecipientInput = z.object({
  role: z.string().trim().max(100).optional(),
  roleId: z.string().uuid().optional(),
  name: z.string().trim().max(200).optional().nullable(),
  email: z.string().trim().max(320).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  locale: z.enum(LOCALES).optional().nullable(),
  channels: z.array(z.enum(CHANNELS)).optional(),
  idDocumentType: z.enum(ID_DOCUMENT_TYPES).optional().nullable(),
  idDocumentNumber: z.string().trim().max(50).optional().nullable(),
});
export type BulkRecipientInput = z.input<typeof BulkRecipientInput>;

export const BulkRowInput = z.object({
  recipients: z.array(BulkRecipientInput).max(50),
  /** Valores por id o etiqueta de campo, como en /v1/envelopes/from-template. */
  prefill: z.record(z.string(), z.string().max(2000)).optional(),
  subject: z.string().trim().max(300).optional().nullable(),
  /** Datos libres del integrador para esta fila (se guardan en metadata del sobre). */
  metadata: UserMetadata.optional(),
});
export type BulkRowInput = z.input<typeof BulkRowInput>;

export const CreateBulkSendInput = z
  .object({
    templateId: z.string().uuid(),
    name: z.string().trim().max(200).optional().nullable(),
    subject: z.string().trim().max(300).optional().nullable(),
    message: z.string().max(5000).optional().nullable(),
    locale: z.enum(LOCALES).optional(),
    /**
     * Vencimiento de cada sobre del envío. Ausente o null: 30 días (a diferencia de los sobres sueltos y desde
     * plantilla, donde null es sin vencimiento: un envío masivo siempre vence).
     */
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
    /** Filas en JSON… */
    rows: z.array(BulkRowInput).max(BULK_MAX_ROWS).optional(),
    /** …o un CSV (encabezados: `Rol.name`, `Rol.email`, `Rol.phone`, `Rol.channels`, `field.Etiqueta`, `subject`). */
    csv: z.string().max(10_000_000).optional(),
    /** true: las filas inválidas se registran como fallidas y se envían las demás. false: 422 con el detalle. */
    skipInvalid: z.boolean().default(false),
  })
  .refine((b) => Boolean(b.rows) !== Boolean(b.csv), { message: "mandá rows o csv (uno de los dos)" });
export type CreateBulkSendInput = z.input<typeof CreateBulkSendInput>;

export interface BulkRowError {
  /** Número de fila de datos (1 = la primera después del encabezado, o el primer elemento de `rows`). */
  row: number;
  /** Línea del archivo donde empieza la fila (sólo CSV: cuenta el encabezado, líneas vacías y saltos entre comillas). */
  line?: number;
  errors: string[];
}

export interface BulkValidationResult {
  total: number;
  valid: number;
  invalid: number;
  errors: BulkRowError[];
  /** Encabezados reconocidos del CSV (vacío si vino en JSON). */
  columns: string[];
  /** Filas válidas iguales a una anterior (mismos destinatarios y prellenado): se crearía un sobre repetido. */
  duplicates?: { row: number; sameAs: number }[];
  /**
   * Sobres que quedan en el cupo del mes del plan (null: sin tope). Si las filas válidas lo superan, crear el envío
   * responde 402 plan_limit.
   */
  quotaRemaining?: number | null;
  /** Avisos que no impiden enviar (texto en español): filas repetidas, cupo insuficiente. */
  warnings?: string[];
}

export interface BulkSend {
  id: string;
  name: string | null;
  templateId: string | null;
  templateName: string;
  status: BulkSendStatus;
  total: number;
  sent: number;
  failed: number;
  /** Fallidas que POST /v1/bulk-sends/:id/retry-failed volvería a encolar (las que fallaron por sus datos no). */
  retryable: number;
  cancelled: number;
  pending: number;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface BulkSendItem {
  id: string;
  /** Número de fila de datos (1, 2, …). */
  row: number;
  /** Línea del CSV de origen (null si las filas vinieron en JSON o el envío es anterior a este dato). */
  line?: number | null;
  status: BulkItemStatus;
  envelopeId: string | null;
  recipients: string[];
  error: string | null;
  processedAt: string | null;
}

// ───────────────────────────── Formularios web ─────────────────────────────

export const WebFormFixedRecipient = z.object({
  roleId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/)
    .optional()
    .nullable(),
  channels: z.array(z.enum(CHANNELS)).min(1).default(["email"]),
  locale: z.enum(LOCALES).optional().nullable(),
});
export type WebFormFixedRecipient = z.input<typeof WebFormFixedRecipient>;

export const WebFormInput = z.object({
  templateId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  /** Texto de bienvenida para quien abre el formulario. */
  description: z.string().max(2000).optional().nullable(),
  /** Rol de la plantilla que toma la persona que completa el formulario (tiene que ser firmante). */
  signerRoleId: z.string().uuid(),
  /** Destinatarios fijos para los demás roles (p. ej. el representante de la empresa). */
  fixedRecipients: z.array(WebFormFixedRecipient).max(50).default([]),
  prefill: z.record(z.string(), z.string().max(2000)).optional(),
  /**
   * Los valores prellenados de los campos de quien completa el formulario quedan de solo lectura (no los puede cambiar).
   * Por defecto no: son valores sugeridos que la persona puede corregir.
   */
  lockPrefill: z.boolean().default(false),
  active: z.boolean().default(true),
  maxUses: z.number().int().min(1).max(1_000_000).optional().nullable(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  /** Pide un código por correo antes de mostrar el documento. */
  requireOtp: z.boolean().default(false),
  /** Permite mostrarlo en un iframe desde los orígenes autorizados de la organización. */
  embeddable: z.boolean().default(false),
  /** Pide teléfono además del correo. */
  collectPhone: z.boolean().default(false),
});
export type WebFormInput = z.input<typeof WebFormInput>;

export const UpdateWebFormInput = WebFormInput.partial().omit({ templateId: true });
export type UpdateWebFormInput = z.input<typeof UpdateWebFormInput>;

export interface WebForm {
  id: string;
  slug: string;
  url: string;
  name: string;
  description: string | null;
  templateId: string;
  templateName: string;
  signerRoleId: string;
  fixedRecipients: { roleId: string; name: string; email: string | null; phone: string | null; channels: string[]; locale: Locale | null }[];
  prefill: Record<string, string>;
  /** Los valores prellenados de los campos de quien completa el formulario son de solo lectura. */
  lockPrefill: boolean;
  active: boolean;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  requireOtp: boolean;
  embeddable: boolean;
  collectPhone: boolean;
  /**
   * Motivo por el que el formulario no crea sobres aunque esté activo: quien lo creó dejó la organización, perdió el
   * permiso o el acceso a la plantilla, se revocó su API key, el plan ya no lo permite o la plantilla cambió. null si su dueño sigue habilitado. Mientras tenga
   * motivo, la página pública lo muestra como no disponible.
   */
  ownerInactiveReason: string | null;
  /**
   * Código estable del motivo (para traducirlo; `ownerInactiveReason` viene en español). null si no hay motivo.
   * - `not_member`: quien lo configuró ya no es miembro de la organización.
   * - `missing_permission`: ya no tiene permiso para crear sobres.
   * - `template_access`: ya no tiene acceso a la plantilla.
   * - `key_revoked`: la API key que lo configuró fue revocada.
   * - `plan_feature`: el plan actual de la organización no incluye formularios web.
   * - `plan_api`: lo configuró una API key y el plan ya no incluye el acceso por API.
   * - `misconfigured`: la plantilla cambió después de publicarlo y el formulario ya no cierra con ella.
   */
  ownerInactiveCode: WebFormInactiveCode | null;
  createdAt: string;
  updatedAt: string;
}

export type WebFormInactiveCode = "not_member" | "missing_permission" | "template_access" | "key_revoked" | "plan_feature" | "plan_api" | "misconfigured";

/** Lo que ve el público al abrir /f/:slug. */
export interface PublicWebForm {
  slug: string;
  name: string;
  description: string | null;
  organizationName: string;
  branding: { primaryColor: string | null; logoUrl: string | null } | null;
  available: boolean;
  /** Motivo si no está disponible: inactive | expired | exhausted. */
  unavailableReason: "inactive" | "expired" | "exhausted" | null;
  requireOtp: boolean;
  collectPhone: boolean;
  locale: Locale;
  /** Token anti-bots: se devuelve en el envío. */
  formToken: string;
  /**
   * Clave pública de Cloudflare Turnstile si la plataforma exige el desafío (TURNSTILE_SITE_KEY y TURNSTILE_SECRET_KEY):
   * el envío tiene que traer `captchaToken`. null: sin desafío.
   */
  captchaSiteKey?: string | null;
}

export const SubmitWebFormInput = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/)
    .optional()
    .nullable(),
  locale: z.enum(LOCALES).optional(),
  formToken: z.string().min(10).max(2000),
  /** Trampa para bots: tiene que llegar vacío. */
  website: z.string().max(500).optional().nullable(),
  embed: z.boolean().optional(),
  /** Token de Cloudflare Turnstile (solo si el formulario público trae `captchaSiteKey`). */
  captchaToken: z.string().max(4096).optional().nullable(),
});
export type SubmitWebFormInput = z.input<typeof SubmitWebFormInput>;

export interface SubmitWebFormResponse {
  envelopeId: string;
  /** Ruta relativa a la página de firma (con ?embed=1 si corresponde). */
  signingPath: string;
}

/** Valores de campos de otros destinatarios que necesita la lógica (condiciones/fórmulas) del firmante. */
export interface SigningLogicField {
  id: string;
  label: string | null;
  type: string;
  value: string | null;
}
