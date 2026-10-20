// Contrato de la API v1. Fuente de verdad para apps/api y apps/web.
// Entradas: esquemas Zod (se validan en el servidor). Salidas: tipos TypeScript.
import { z } from "zod";
import { AUTH_METHODS, EnvelopeReminderSettings, type AuthMethod } from "./signer";
import { InPersonInput, type InPersonHost, type SigningInPerson } from "./experience";
import { FieldConditions, FieldFormula, type FieldCondition } from "./scale-logic";
import { IdVerificationInput, type RecipientIdentity, type SigningIdentity } from "./identity";
import {
  CertificateRequirementsInput,
  SIGNATURE_TYPES,
  type CertificateRequirements,
  type RecipientCertificateSignature,
  type SignatureType,
  type SigningCertificateStep,
} from "./certsign";

// ───────────────────────────── Enumeraciones ─────────────────────────────


/**
 * Claves de metadatos que pone el sistema (workflows, formularios, envío masivo, CRM, conectores, negociaciones,
 * repositorio): no las puede fijar quien crea o clona un sobre. Si no, un sobre propio con workflowRunId ajeno se
 * anulaba al cancelar esa ejecución, o uno con webFormId consumía el tope por hora de un formulario.
 */
export const RESERVED_METADATA_KEYS = [
  "workflowId",
  "workflowRunId",
  "webFormId",
  "webFormName",
  "bulkSendId",
  "bulkRow",
  "crm",
  "connector",
  "negotiationId",
  "negotiationVersion",
  "documentTemplateId",
  "agreement",
  "templateId",
  "clonedFrom",
] as const;

export function stripReservedMetadata(m: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(m ?? {}) };
  for (const k of RESERVED_METADATA_KEYS) delete out[k];
  return out;
}

/** Metadatos que manda el cliente: sin las claves reservadas del sistema. */
export const UserMetadata = z.record(z.string(), z.unknown()).transform((m) => stripReservedMetadata(m));

export const LOCALES = ["es", "pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const ENVELOPE_STATUSES = ["draft", "sent", "finalizing", "completed", "declined", "voided", "expired", "awaiting_certificates"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const RECIPIENT_ROLES = ["signer", "cc", "approver"] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

export const RECIPIENT_STATUSES = ["created", "sent", "viewed", "signed", "declined", "completed", "delegated", "reassigned"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const CHANNELS = ["email", "whatsapp", "telegram"] as const;
export type Channel = (typeof CHANNELS)[number];

export const FIELD_TYPES = ["signature", "initials", "date_signed", "name", "email", "text", "checkbox", "number", "dropdown", "company", "title", "attachment"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Campos que el servidor completa solo (el firmante no los edita). */
export const AUTO_FIELD_TYPES: readonly FieldType[] = ["date_signed", "name", "email"];

/** cedula (RD, CO), cpf (BR), dni (HN, PE), ce = carné de extranjería (PE, CO), passport, other. */
export const ID_DOCUMENT_TYPES = ["cedula", "cpf", "dni", "passport", "other", "ce"] as const;

// ───────────────────────────── Errores ─────────────────────────────

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ───────────────────────────── Identidad ─────────────────────────────

export const SignupInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(10).max(200),
  organization: z.string().trim().min(1).max(200),
  locale: z.enum(LOCALES).optional(),
  /** Celda donde se guardan los datos (ver GET /v1/public/cells). Sin valor: la celda por defecto. */
  cell: z.string().trim().regex(/^[a-z0-9-]{1,40}$/).optional(),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

export interface User {
  id: string;
  email: string;
  name: string;
  locale: Locale;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: string;
  defaultLocale: Locale;
}

export interface MeResponse {
  user: User;
  tenant: Tenant;
}

export const CreateApiKeyInput = z.object({ name: z.string().trim().min(1).max(100) });
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInput>;

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiKeyResponse {
  apiKey: ApiKey;
  /** Se muestra una sola vez. */
  secret: string;
}

// ───────────────────────────── Sobres ─────────────────────────────

export const CreateEnvelopeInput = z.object({
  subject: z.string().trim().min(1).max(300),
  message: z.string().max(5000).optional().nullable(),
  locale: z.enum(LOCALES).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  metadata: UserMetadata.optional(),
  /** Sub-marca (marca blanca) con la que salen correos, página de firma y certificado. null: la de la organización. */
  brandId: z.string().uuid().optional().nullable(),
  ...EnvelopeReminderSettings,
});
export type CreateEnvelopeInput = z.infer<typeof CreateEnvelopeInput>;

export const UpdateEnvelopeInput = CreateEnvelopeInput.partial();
export type UpdateEnvelopeInput = z.infer<typeof UpdateEnvelopeInput>;

export const RecipientInput = z
  .object({
    id: z.string().uuid().optional(),
    role: z.enum(RECIPIENT_ROLES).default("signer"),
    routingOrder: z.number().int().min(1).max(100).default(1),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
    /** E.164, ej. +5491122334455 */
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/)
      .optional()
      .nullable(),
    locale: z.enum(LOCALES).optional().nullable(),
    channels: z.array(z.enum(CHANNELS)).min(1).default(["email"]),
    /** chat_id de Telegram, si el integrador ya lo conoce. Si no, el firmante se vincula desde el link del bot. */
    telegramChatId: z
      .string()
      .trim()
      .regex(/^-?\d{1,20}$/)
      .optional()
      .nullable(),
    idDocumentType: z.enum(ID_DOCUMENT_TYPES).optional().nullable(),
    idDocumentNumber: z.string().trim().max(50).optional().nullable(),
    /** Firma dentro de la app del integrador (URL de firma embebida): no recibe invitaciones. */
    embedded: z.boolean().optional(),
    /** Autenticación previa a ver los documentos. Default "link". */
    authMethod: z.enum(AUTH_METHODS).optional(),
    /** Firma en persona en el dispositivo del anfitrión: no recibe invitaciones (null = quitar). */
    inPerson: InPersonInput.optional().nullable(),
    /** Verificación de identidad (KYC) antes de ver los documentos (null = quitar). */
    idVerification: IdVerificationInput.optional().nullable(),
    /** "certificate": además firma con su certificado digital (token, Windows o .p12) con el Firmador CalaSign. */
    signatureType: z.enum(SIGNATURE_TYPES).optional(),
    /** Requisitos del certificado (solo con signatureType "certificate"). */
    certificateRequirements: CertificateRequirementsInput.optional().nullable(),
  })
  .refine((r) => r.signatureType !== "certificate" || (r.role ?? "signer") === "signer", {
    message: "solo un firmante puede firmar con certificado",
  })
  .refine((r) => r.embedded || r.inPerson || r.email || r.phone, { message: "email o phone requerido" })
  .refine((r) => r.authMethod !== "in_person" || r.inPerson, { message: "la firma en persona se configura con inPerson" })
  .refine((r) => r.authMethod !== "otp_email" || r.email, { message: "el código por email requiere email" })
  .refine((r) => !(r.authMethod === "otp_sms" || r.authMethod === "otp_whatsapp") || r.phone, {
    message: "el código por SMS/WhatsApp requiere phone",
  })
  .refine((r) => r.embedded || r.inPerson || !r.channels.includes("email") || r.email, { message: "el canal email requiere email" })
  .refine((r) => r.embedded || r.inPerson || !r.channels.includes("whatsapp") || r.phone, { message: "el canal whatsapp requiere phone" })
  .refine((r) => r.embedded || r.inPerson || r.channels.some((c) => c !== "telegram") || r.telegramChatId, {
    message: "con solo Telegram hace falta telegramChatId (o agregar email/WhatsApp para enviar el link de vinculación)",
  });
export type RecipientInput = z.input<typeof RecipientInput>;

export const PutRecipientsInput = z.object({ recipients: z.array(RecipientInput).max(50) });
export type PutRecipientsInput = z.input<typeof PutRecipientsInput>;

export const FieldInput = z
  .object({
    id: z.string().uuid().optional(),
    documentId: z.string().uuid(),
    recipientId: z.string().uuid(),
    type: z.enum(FIELD_TYPES),
    page: z.number().int().min(0),
    /** Coordenadas normalizadas 0..1, origen arriba a la izquierda. */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
    required: z.boolean().default(true),
    label: z.string().max(200).optional().nullable(),
    /** Valor fijado por el remitente (prellenado). Con readOnly el firmante no lo puede cambiar. */
    value: z.string().max(2000).optional().nullable(),
    readOnly: z.boolean().optional(),
    /** Desplegable: opciones posibles. */
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional().nullable(),
    /** Número: rango permitido. */
    min: z.number().finite().optional().nullable(),
    max: z.number().finite().optional().nullable(),
    /** Se muestra (y exige) solo si se cumplen todas las condiciones. */
    conditions: FieldConditions.optional().nullable(),
    /** Campo número calculado: p. ej. `{Precio} * {Cantidad}`. */
    formula: FieldFormula.optional().nullable(),
  })
  .refine((f) => f.x + f.width <= 1.0001 && f.y + f.height <= 1.0001, { message: "el campo se sale de la página" })
  .refine((f) => f.type !== "dropdown" || (f.options && f.options.length > 0), { message: "el desplegable necesita opciones" })
  .refine((f) => f.min == null || f.max == null || f.min <= f.max, { message: "min no puede ser mayor que max" })
  .refine((f) => !f.formula || f.type === "number", { message: "solo un campo número puede tener fórmula" })
  .refine((f) => !f.readOnly || (f.value != null && f.value !== ""), { message: "un campo de solo lectura necesita valor" });
export type FieldInput = z.input<typeof FieldInput>;

export const PutFieldsInput = z.object({ fields: z.array(FieldInput).max(500) });
export type PutFieldsInput = z.input<typeof PutFieldsInput>;

export const VoidEnvelopeInput = z.object({ reason: z.string().trim().min(1).max(1000) });
export type VoidEnvelopeInput = z.infer<typeof VoidEnvelopeInput>;

export interface PageSize {
  width: number;
  height: number;
}

export interface Document {
  id: string;
  name: string;
  position: number;
  pageCount: number;
  pages: PageSize[];
  sha256: string;
  sizeBytes: number;
}

export interface Recipient {
  id: string;
  role: RecipientRole;
  routingOrder: number;
  name: string;
  email: string | null;
  phone: string | null;
  locale: Locale | null;
  channels: Channel[];
  /** true si el destinatario ya vinculó su chat de Telegram. */
  telegramLinked: boolean;
  /** Firma embebida (sin invitaciones). */
  embedded: boolean;
  idDocumentType: string | null;
  idDocumentNumber: string | null;
  status: RecipientStatus;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  authMethod: AuthMethod;
  /** Si fue delegado o reasignado: id del destinatario que lo reemplaza. */
  replacedBy: string | null;
  /** Firma en persona: anfitrión que presenta al firmante. */
  inPersonHost?: InPersonHost | null;
  /** Verificación de identidad requerida y su estado. */
  identity?: RecipientIdentity | null;
  /** Firma electrónica o con certificado propio. */
  signatureType?: SignatureType;
  certificateRequirements?: CertificateRequirements | null;
  /** Estado de su firma con certificado (cuando el sobre llegó a esa etapa). */
  certificateSignature?: RecipientCertificateSignature | null;
}

export interface Field {
  id: string;
  documentId: string;
  recipientId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  label: string | null;
  value: string | null;
  readOnly: boolean;
  options: string[] | null;
  min: number | null;
  max: number | null;
  conditions: FieldCondition[] | null;
  formula: string | null;
}

export interface EnvelopeSummary {
  id: string;
  subject: string;
  status: EnvelopeStatus;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  /** Última modificación (sirve para sincronizar con `updated_from`). */
  updatedAt?: string;
  metadata?: Record<string, unknown>;
  recipients: { name: string; status: RecipientStatus; role: RecipientRole }[];
}

export interface Envelope {
  id: string;
  subject: string;
  message: string | null;
  locale: Locale;
  status: EnvelopeStatus;
  createdVia: "web" | "api";
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  completedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
  signedSha256: string | null;
  reminderEveryDays: number | null;
  expiryWarningDays: number | null;
  allowDelegation: boolean;
  /** Sub-marca del sobre (null: la marca de la organización). */
  brandId?: string | null;
}

export interface EnvelopeDetail {
  envelope: Envelope;
  documents: Document[];
  recipients: Recipient[];
  fields: Field[];
  /** Si quien consulta puede modificar el sobre (anular, corregir, reasignar, compartir). Solo en GET /v1/envelopes/{id}. */
  canManage?: boolean;
}

export interface ListEnvelopesResponse {
  items: EnvelopeSummary[];
  nextCursor: string | null;
}

export interface EnvelopeEvent {
  seq: number;
  type: string;
  actorType: "user" | "api_key" | "recipient" | "system";
  actorLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  data: Record<string, unknown>;
  occurredAt: string;
  hash: string;
}

// ───────────────────────────── Firma ─────────────────────────────

export const SignatureImageInput = z.object({
  kind: z.enum(["drawn", "typed"]),
  /** PNG en base64 (sin prefijo data:), máx ~700 KB. */
  imagePng: z.string().min(16).max(1_000_000),
  text: z.string().max(200).optional().nullable(),
});
export type SignatureImageInput = z.infer<typeof SignatureImageInput>;

export const CompleteSigningInput = z.object({
  fields: z.array(z.object({ id: z.string().uuid(), value: z.string().max(2000) })).max(500),
  signature: SignatureImageInput.optional(),
  initials: SignatureImageInput.optional(),
});
export type CompleteSigningInput = z.infer<typeof CompleteSigningInput>;

export const DeclineInput = z.object({ reason: z.string().trim().min(1).max(1000) });
export type DeclineInput = z.infer<typeof DeclineInput>;

export interface SigningSession {
  envelope: {
    id: string;
    subject: string;
    message: string | null;
    status: EnvelopeStatus;
    senderName: string;
    organizationName: string;
    expiresAt: string | null;
  };
  recipient: {
    id: string;
    name: string;
    email: string | null;
    role: RecipientRole;
    status: RecipientStatus;
    locale: Locale;
    consented: boolean;
    /** Link t.me para recibir avisos por Telegram (null si el bot no está configurado o ya está vinculado). */
    telegramLink: string | null;
    authMethod: AuthMethod;
  };
  documents: Document[];
  /** Solo los campos de este destinatario. */
  fields: Field[];
  /** true si es su turno de firmar (según routingOrder). */
  canSign: boolean;
  /** true cuando el PDF sellado está disponible para descargar. */
  signedAvailable: boolean;
  /** Ya firmó (o es copia) y el sobre sigue en curso: puede bajar una copia con lo firmado hasta ahora. */
  copyAvailable: boolean;
  /** true si falta validar el código (OTP): documentos y campos vienen vacíos hasta verificarlo. */
  otpRequired: boolean;
  /** Destino enmascarado del código (ej. jo***@mail.com). */
  otpDestination: string | null;
  /** Si este destinatario puede delegar la firma. */
  canDelegate: boolean;
  /** Logo y color de la organización remitente (null: estilo por defecto). */
  branding?: { primaryColor: string | null; logoUrl: string | null } | null;
  /** Marca blanca completa (tema, textos, nombre del producto). */
  theme?: import("./white-label").PublicBrandTheme | null;
  /** Firma en persona (modo anfitrión). */
  inPerson?: SigningInPerson | null;
  /** Campos de otros destinatarios citados por las condiciones o fórmulas de este firmante. */
  logicFields?: { id: string; label: string | null; type: string; value: string | null }[];
  /** Verificación de identidad (KYC): si `required` y no está verificada, documentos y campos vienen vacíos. */
  identity?: SigningIdentity | null;
  /** Firma con certificado propio: presente si el destinatario firma con certificado. */
  certificateSigning?: SigningCertificateStep | null;
}

// ───────────────────────────── Desarrollo ─────────────────────────────

export interface DevMailboxItem {
  id: string;
  channel: Channel | "sms";
  to: string;
  subject: string;
  text: string;
  link: string | null;
  createdAt: string;
}
