// Fase 2 — productividad: plantillas y branding.
import { z } from "zod";
import { FieldConditions, FieldFormula, type FieldCondition } from "./scale-logic";
import { CertificateRequirementsInput, SIGNATURE_TYPES, type CertificateRequirements, type SignatureType } from "./certsign";
import {
  CHANNELS,
  FIELD_TYPES,
  ID_DOCUMENT_TYPES,
  LOCALES,
  RECIPIENT_ROLES,
  type Document,
  type FieldType,
  type Locale,
  type RecipientRole,
  UserMetadata,
} from "./api";

/** Tipos que el firmante completa escribiendo y que el remitente puede prellenar. */
export const PREFILLABLE_FIELD_TYPES: readonly FieldType[] = ["text", "number", "dropdown", "company", "title"];

/** Formato de los adjuntos que puede subir un firmante. */
export const ATTACHMENT_CONTENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

// ───────────────────────────── Plantillas ─────────────────────────────

export const CreateTemplateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  subject: z.string().max(300).optional().nullable(),
  message: z.string().max(5000).optional().nullable(),
  locale: z.enum(LOCALES).optional(),
});
export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;

export const UpdateTemplateInput = CreateTemplateInput.partial();
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInput>;

export const TemplateRoleInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100),
  role: z.enum(RECIPIENT_ROLES).default("signer"),
  routingOrder: z.number().int().min(1).max(100).default(1),
  /** Los destinatarios de este rol firman además con su certificado digital. */
  signatureType: z.enum(SIGNATURE_TYPES).optional(),
  certificateRequirements: CertificateRequirementsInput.optional().nullable(),
});
export type TemplateRoleInput = z.input<typeof TemplateRoleInput>;

export const PutTemplateRolesInput = z.object({ roles: z.array(TemplateRoleInput).max(50) });
export type PutTemplateRolesInput = z.input<typeof PutTemplateRolesInput>;

export const TemplateFieldInput = z
  .object({
    id: z.string().uuid().optional(),
    documentId: z.string().uuid(),
    roleId: z.string().uuid(),
    type: z.enum(FIELD_TYPES),
    page: z.number().int().min(0),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().gt(0).max(1),
    height: z.number().gt(0).max(1),
    required: z.boolean().default(true),
    label: z.string().max(200).optional().nullable(),
    value: z.string().max(2000).optional().nullable(),
    readOnly: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional().nullable(),
    min: z.number().finite().optional().nullable(),
    max: z.number().finite().optional().nullable(),
    conditions: FieldConditions.optional().nullable(),
    formula: FieldFormula.optional().nullable(),
  })
  .refine((f) => f.x + f.width <= 1.0001 && f.y + f.height <= 1.0001, { message: "el campo se sale de la página" })
  .refine((f) => f.type !== "dropdown" || (f.options && f.options.length > 0), { message: "el desplegable necesita opciones" })
  // Como FieldInput: sin esto la plantilla guardaba un rango vacío y cada sobre creado desde ella heredaba un campo
  // número que ningún valor cumple (si es obligatorio, el firmante no puede terminar).
  .refine((f) => f.min == null || f.max == null || f.min <= f.max, { message: "min no puede ser mayor que max" })
  .refine((f) => !f.formula || f.type === "number", { message: "solo un campo número puede tener fórmula" });
export type TemplateFieldInput = z.input<typeof TemplateFieldInput>;

export const PutTemplateFieldsInput = z.object({ fields: z.array(TemplateFieldInput).max(500) });
export type PutTemplateFieldsInput = z.input<typeof PutTemplateFieldsInput>;

export const TemplateFromEnvelopeInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
});
export type TemplateFromEnvelopeInput = z.infer<typeof TemplateFromEnvelopeInput>;

/** Destinatario real para un rol de la plantilla (se identifica el rol por id o por nombre). */
export const TemplateRecipientInput = z
  .object({
    roleId: z.string().uuid().optional(),
    role: z.string().trim().max(100).optional(),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/)
      .optional()
      .nullable(),
    locale: z.enum(LOCALES).optional().nullable(),
    channels: z.array(z.enum(CHANNELS)).min(1).default(["email"]),
    telegramChatId: z
      .string()
      .trim()
      .regex(/^-?\d{1,20}$/)
      .optional()
      .nullable(),
    idDocumentType: z.enum(ID_DOCUMENT_TYPES).optional().nullable(),
    idDocumentNumber: z.string().trim().max(50).optional().nullable(),
  })
  .refine((r) => r.roleId || r.role, { message: "roleId o role requerido" })
  .refine((r) => r.email || r.phone, { message: "email o phone requerido" })
  .refine((r) => !r.channels.includes("email") || r.email, { message: "el canal email requiere email" })
  .refine((r) => !r.channels.includes("whatsapp") || r.phone, { message: "el canal whatsapp requiere phone" })
  .refine((r) => r.channels.some((c) => c !== "telegram") || r.telegramChatId, {
    message: "con solo Telegram hace falta telegramChatId",
  });
export type TemplateRecipientInput = z.input<typeof TemplateRecipientInput>;

export const EnvelopeFromTemplateInput = z.object({
  templateId: z.string().uuid(),
  subject: z.string().trim().min(1).max(300).optional(),
  message: z.string().max(5000).optional().nullable(),
  locale: z.enum(LOCALES).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  metadata: UserMetadata.optional(),
  recipients: z.array(TemplateRecipientInput).min(1).max(50),
  /** Valores para campos de la plantilla, por id de campo o por etiqueta. */
  prefill: z.record(z.string(), z.string().max(2000)).optional(),
  /** true: envía el sobre en el mismo pedido. */
  send: z.boolean().optional(),
});
export type EnvelopeFromTemplateInput = z.input<typeof EnvelopeFromTemplateInput>;

export interface TemplateRole {
  id: string;
  name: string;
  role: RecipientRole;
  routingOrder: number;
  signatureType?: SignatureType;
  certificateRequirements?: CertificateRequirements | null;
}

export interface TemplateField {
  id: string;
  documentId: string;
  roleId: string;
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

export interface Template {
  id: string;
  name: string;
  description: string | null;
  subject: string | null;
  message: string | null;
  locale: Locale;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateSummary extends Template {
  documentCount: number;
  roles: { name: string; role: RecipientRole }[];
  /** Si quien consulta puede editarla, borrarla o compartirla (templates:manage o quien la creó). */
  canManage?: boolean;
}

export interface TemplateDetail {
  template: Template;
  documents: Document[];
  roles: TemplateRole[];
  fields: TemplateField[];
  /** Solo en GET /v1/templates/{id}: si quien consulta puede modificarla. */
  canManage?: boolean;
}

// ───────────────────────────── Branding ─────────────────────────────

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const UpdateBrandingInput = z.object({
  primaryColor: z.string().regex(HEX_COLOR, "color en formato #RRGGBB").optional().nullable(),
  emailFooter: z.string().max(500).optional().nullable(),
  /** Nombre de la organización: lo ven los firmantes en la página de firma, los correos y el certificado. */
  organizationName: z.string().trim().min(2, "mínimo 2 caracteres").max(120).optional(),
});
export type UpdateBrandingInput = z.infer<typeof UpdateBrandingInput>;

export const LOGO_CONTENT_TYPES = ["image/png", "image/svg+xml", "image/jpeg"] as const;
export const LOGO_MAX_BYTES = 200 * 1024;

export interface Branding {
  primaryColor: string | null;
  emailFooter: string | null;
  /** URL pública del logo (null si no hay). */
  logoUrl: string | null;
  logoContentType: string | null;
}
