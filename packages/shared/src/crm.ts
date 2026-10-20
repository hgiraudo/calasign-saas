// CRM y ERP (Fase 6): conexiones, mapeos registro → plantilla, envíos desde un registro y write-backs.
import { z } from "zod";
import { CHANNELS } from "./api";

export const CRM_PROVIDERS = [
  "hubspot",
  "salesforce",
  "zoho",
  "siigo",
  "alegra",
  // Pipedrive: Deal (persona principal + participantes) y Person (objectType "contact").
  "pipedrive",
  // RD Station CRM (API v2, OAuth de la RD Station App Store): Negociação (deal) con sus contatos.
  "rdstation",
  // Kommo (ex amoCRM; API v4, OAuth por cuenta/subdominio): Lead (objectType "deal") con sus contactos.
  "kommo",
] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

export const CRM_OBJECT_TYPES = ["deal", "opportunity", "customer", "contact", "invoice"] as const;
export type CrmObjectType = (typeof CRM_OBJECT_TYPES)[number];

/** Tipos de registro que admite cada proveedor. */
export const CRM_PROVIDER_OBJECTS: Record<CrmProvider, readonly CrmObjectType[]> = {
  hubspot: ["deal"],
  salesforce: ["opportunity"],
  zoho: ["deal", "contact"],
  siigo: ["customer"],
  alegra: ["contact", "invoice"],
  pipedrive: ["deal", "contact"],
  rdstation: ["deal"],
  kommo: ["deal"],
};

/** CRM (envían desde un registro) vs ERP (reciben el documento firmado al completarse). */
export const CRM_KIND: Record<CrmProvider, "crm" | "erp"> = {
  hubspot: "crm",
  salesforce: "crm",
  zoho: "crm",
  siigo: "erp",
  alegra: "erp",
  pipedrive: "crm",
  rdstation: "crm",
  kommo: "crm",
};

/**
 * Centros de datos de Zoho (cada cuenta vive en uno: accounts.zoho.com, .eu, .in, .com.au, .jp, .ca, .sa, .uk,
 * .com.cn). El usuario puede iniciar en cualquiera: Zoho lo redirige al suyo y el callback trae `accounts-server`.
 */
export const ZOHO_REGIONS = ["com", "eu", "in", "com.au", "jp", "ca", "sa", "uk", "com.cn"] as const;
export type ZohoRegion = (typeof ZOHO_REGIONS)[number];

/** Producto de Zoho: Zoho CRM (Deals y Contacts) o Bigin (Pipelines y Contacts). */
export const ZOHO_PRODUCTS = ["crm", "bigin"] as const;
export type ZohoProduct = (typeof ZOHO_PRODUCTS)[number];

export const CRM_STATUSES = ["sent", "completed", "declined", "voided", "expired"] as const;
export type CrmEnvelopeStatus = (typeof CRM_STATUSES)[number];

// ───────────────────────────── Conexiones ─────────────────────────────

export const CreateCrmTokenConnectionInput = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("hubspot"), name: z.string().trim().min(1).max(120), accessToken: z.string().trim().min(10).max(500) }),
  z.object({
    provider: z.literal("siigo"),
    name: z.string().trim().min(1).max(120),
    username: z.string().trim().min(3).max(200),
    accessKey: z.string().trim().min(8).max(500),
  }),
  z.object({
    provider: z.literal("alegra"),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(320),
    token: z.string().trim().min(8).max(500),
  }),
]);
export type CreateCrmTokenConnectionInput = z.infer<typeof CreateCrmTokenConnectionInput>;

export const StartCrmOAuthInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** Solo Zoho: centro de datos donde iniciar sesión (por defecto, el de zoho.com, que redirige al de la cuenta). */
  region: z.enum(ZOHO_REGIONS).optional(),
  /** Solo Zoho: Zoho CRM (por defecto) o Bigin. */
  product: z.enum(ZOHO_PRODUCTS).optional(),
});
export type StartCrmOAuthInput = z.infer<typeof StartCrmOAuthInput>;

export const UpdateCrmConnectionInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
});
export type UpdateCrmConnectionInput = z.infer<typeof UpdateCrmConnectionInput>;

export interface CrmProviderInfo {
  provider: CrmProvider;
  kind: "crm" | "erp";
  /** OAuth disponible (credenciales de la app cargadas en el servidor). */
  oauthConfigured: boolean;
  /** Se puede conectar pegando un token / clave de API. */
  tokenSupported: boolean;
  objectTypes: readonly CrmObjectType[];
}

export interface CrmConnection {
  id: string;
  provider: CrmProvider;
  name: string;
  authType: "oauth" | "token";
  accountLabel: string | null;
  active: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

// ───────────────────────────── Mapeos ─────────────────────────────

/**
 * De dónde sale cada destinatario de la plantilla:
 * - contact: el contacto asociado número `index` (0 = el primero) del registro.
 * - contact_role: el contacto con ese rol en el registro (Salesforce OpportunityContactRole.Role); `primary` toma el principal.
 * - property: nombre/correo/teléfono tomados de propiedades del propio registro.
 * - fixed: datos fijos (ej. el firmante interno de la empresa).
 */
export const CrmRoleSource = z.discriminatedUnion("source", [
  z.object({ source: z.literal("contact"), index: z.number().int().min(0).max(50).default(0) }),
  z.object({ source: z.literal("contact_role"), contactRole: z.string().trim().max(120).optional().nullable(), primary: z.boolean().optional() }),
  z.object({
    source: z.literal("property"),
    nameProperty: z.string().trim().min(1).max(200),
    emailProperty: z.string().trim().max(200).optional().nullable(),
    phoneProperty: z.string().trim().max(200).optional().nullable(),
  }),
  z.object({
    source: z.literal("fixed"),
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().optional().nullable(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/)
      .optional()
      .nullable(),
  }),
]);
export type CrmRoleSource = z.infer<typeof CrmRoleSource>;

export const CrmRoleMapping = z.intersection(
  z.object({
    /** Rol de la plantilla (nombre o id). */
    role: z.string().trim().min(1).max(200),
    channels: z.array(z.enum(CHANNELS)).min(1).default(["email"]),
  }),
  CrmRoleSource,
);
export type CrmRoleMapping = z.infer<typeof CrmRoleMapping>;

export const CrmPrefillMapping = z.object({
  /** Campo de la plantilla (etiqueta o id). */
  field: z.string().trim().min(1).max(200),
  /** Propiedad del registro en el CRM (ej. amount, dealname, Amount, CloseDate). */
  property: z.string().trim().min(1).max(200),
});
export type CrmPrefillMapping = z.infer<typeof CrmPrefillMapping>;

export const CrmWriteBack = z.object({
  /** Propiedad del registro donde se escribe el estado del sobre (vacío: no se escribe). */
  statusProperty: z.string().trim().max(200).optional().nullable(),
  /** Valor a escribir por estado; por defecto el nombre del estado. */
  statusValues: z.record(z.enum(CRM_STATUSES), z.string().max(200)).optional(),
  /** Adjuntar el PDF sellado al registro al completarse. */
  attachPdf: z.boolean().default(true),
});
export type CrmWriteBack = z.infer<typeof CrmWriteBack>;

export const CRM_TRIGGERS = ["manual", "webhook", "on_completion"] as const;

export const CrmTriggerConfig = z.object({
  /** webhook (HubSpot): propiedad y valor del registro que disparan el envío (ej. dealstage = contractsent). */
  property: z.string().trim().max(200).optional().nullable(),
  value: z.string().trim().max(200).optional().nullable(),
  /** on_completion (ERP): cómo se encuentra el registro. Por ahora, por el documento de identidad de un firmante. */
  matchBy: z.enum(["recipient_id_document"]).optional(),
  /** on_completion: solo sobres creados desde esta plantilla (vacío: todos). */
  templateId: z.string().uuid().optional().nullable(),
});
export type CrmTriggerConfig = z.infer<typeof CrmTriggerConfig>;

export const CreateCrmMappingInput = z.object({
  connectionId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  objectType: z.enum(CRM_OBJECT_TYPES),
  templateId: z.string().uuid().optional().nullable(),
  roles: z.array(CrmRoleMapping).max(20).default([]),
  prefill: z.array(CrmPrefillMapping).max(100).default([]),
  writeBack: CrmWriteBack.default({ attachPdf: true }),
  trigger: z.enum(CRM_TRIGGERS).default("manual"),
  triggerConfig: CrmTriggerConfig.default({}),
  send: z.boolean().default(true),
  active: z.boolean().default(true),
});
export type CreateCrmMappingInput = z.input<typeof CreateCrmMappingInput>;

export const UpdateCrmMappingInput = CreateCrmMappingInput.omit({ connectionId: true }).partial();
export type UpdateCrmMappingInput = z.input<typeof UpdateCrmMappingInput>;

export interface CrmMapping {
  id: string;
  connectionId: string;
  name: string;
  objectType: CrmObjectType;
  templateId: string | null;
  roles: CrmRoleMapping[];
  prefill: CrmPrefillMapping[];
  writeBack: CrmWriteBack;
  trigger: (typeof CRM_TRIGGERS)[number];
  triggerConfig: CrmTriggerConfig;
  send: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /v1/crm/mappings. connectionsWithoutAccount: conexiones activas de Pipedrive/Kommo sin su cuenta guardada
 *  (conexiones viejas): sus mapeos no se pueden enviar (409 crm_account_unknown) hasta probar la conexión. */
export interface CrmMappingList {
  items: CrmMapping[];
  connectionsWithoutAccount: { id: string; name: string; provider: CrmProvider }[];
}

// ───────────────────────────── Envío desde un registro, vínculos y ejecuciones ─────────────────────────────

export const SendFromCrmRecordInput = z.object({
  objectId: z.string().trim().min(1).max(100),
  /** Por defecto, lo que diga el mapeo. */
  send: z.boolean().optional(),
  subject: z.string().trim().min(1).max(300).optional(),
  message: z.string().max(5000).optional().nullable(),
  /**
   * Cuenta del CRM desde la que se envía (Pipedrive: company_id; Kommo: id de la cuenta). Opcional: lo mandan la
   * acción de Pipedrive y el widget de Kommo y, si la conexión del mapeo es de otra cuenta, 409 company_mismatch (con
   * dos cuentas conectadas, el mismo id de registro existe en las dos y se leería el de la otra). Sin él se usa la
   * cuenta guardada en la conexión (si no tiene, 409 crm_account_unknown).
   */
  companyId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});
export type SendFromCrmRecordInput = z.infer<typeof SendFromCrmRecordInput>;

export interface SendFromCrmRecordResponse {
  envelopeId: string;
  status: string;
  linkId: string;
  runId: string;
}

export const CreateCrmLinkInput = z.object({
  connectionId: z.string().uuid(),
  envelopeId: z.string().uuid(),
  objectType: z.enum(CRM_OBJECT_TYPES),
  objectId: z.string().trim().min(1).max(100),
});
export type CreateCrmLinkInput = z.infer<typeof CreateCrmLinkInput>;

export interface CrmLink {
  id: string;
  connectionId: string;
  envelopeId: string;
  objectType: CrmObjectType;
  objectId: string;
  lastStatus: string | null;
  pdfAttachedAt: string | null;
  remoteRef: string | null;
  createdAt: string;
}

export interface CrmRun {
  id: string;
  connectionId: string | null;
  connectionName: string | null;
  provider: CrmProvider | null;
  mappingId: string | null;
  envelopeId: string | null;
  kind: "send" | "write_back" | "attach" | "match" | "test";
  event: string | null;
  objectType: string | null;
  objectId: string | null;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  detail: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Registro del CRM normalizado (lo que usan los mapeos). */
export interface CrmRecord {
  id: string;
  objectType: CrmObjectType;
  /** Título del registro para el asunto por defecto (si el proveedor no usa dealname / Name). */
  title?: string | null;
  properties: Record<string, unknown>;
  contacts: { id: string; name: string; email: string | null; phone: string | null; role: string | null; primary: boolean }[];
}
