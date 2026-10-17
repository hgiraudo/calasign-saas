// Contrato de la API v1. Fuente de verdad para apps/api y apps/web.
// Entradas: esquemas Zod (se validan en el servidor). Salidas: tipos TypeScript.
import { z } from "zod";

// ───────────────────────────── Enumeraciones ─────────────────────────────

export const LOCALES = ["es", "pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const ENVELOPE_STATUSES = ["draft", "sent", "finalizing", "completed", "declined", "voided", "expired"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

export const RECIPIENT_ROLES = ["signer", "cc"] as const;
export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

export const RECIPIENT_STATUSES = ["created", "sent", "viewed", "signed", "declined", "completed"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const CHANNELS = ["email", "whatsapp", "telegram"] as const;
export type Channel = (typeof CHANNELS)[number];

export const FIELD_TYPES = ["signature", "initials", "date_signed", "name", "email", "text", "checkbox"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Campos que el servidor completa solo (el firmante no los edita). */
export const AUTO_FIELD_TYPES: readonly FieldType[] = ["date_signed", "name", "email"];

export const ID_DOCUMENT_TYPES = ["cedula", "cpf", "dni", "passport", "other"] as const;

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
  expiresAt: z.string().datetime().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  })
  .refine((r) => r.email || r.phone, { message: "email o phone requerido" })
  .refine((r) => !r.channels.includes("email") || r.email, { message: "el canal email requiere email" })
  .refine((r) => !r.channels.includes("whatsapp") || r.phone, { message: "el canal whatsapp requiere phone" })
  .refine((r) => r.channels.some((c) => c !== "telegram") || r.telegramChatId, {
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
  })
  .refine((f) => f.x + f.width <= 1.0001 && f.y + f.height <= 1.0001, { message: "el campo se sale de la página" });
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
  idDocumentType: string | null;
  idDocumentNumber: string | null;
  status: RecipientStatus;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
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
}

export interface EnvelopeSummary {
  id: string;
  subject: string;
  status: EnvelopeStatus;
  createdAt: string;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
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
}

export interface EnvelopeDetail {
  envelope: Envelope;
  documents: Document[];
  recipients: Recipient[];
  fields: Field[];
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
  };
  documents: Document[];
  /** Solo los campos de este destinatario. */
  fields: Field[];
  /** true si es su turno de firmar (según routingOrder). */
  canSign: boolean;
  /** true cuando el PDF sellado está disponible para descargar. */
  signedAvailable: boolean;
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
