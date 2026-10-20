// Conectores out-of-the-box con sistemas de RR. HH. (HRIS) y gestión de contratos (CLM).
// Los gestores documentales (DMS: SharePoint, Box, Drive, Dropbox, OneDrive, S3) van por el archivado automático de
// platform.ts (STORAGE_PROVIDERS). Ver docs/CONECTORES.md.
import { z } from "zod";
import { CRM_STATUSES, CrmPrefillMapping, CrmRoleMapping } from "./crm";

export const CONNECTOR_PROVIDERS = ["bamboohr", "hibob", "factorial", "ironclad", "juro"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const CONNECTOR_CATEGORIES = ["hris", "clm"] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export const CONNECTOR_CATEGORY: Record<ConnectorProvider, ConnectorCategory> = {
  bamboohr: "hris",
  hibob: "hris",
  factorial: "hris",
  ironclad: "clm",
  juro: "clm",
};

export const CONNECTOR_OBJECT_TYPES = ["employee", "workflow", "record", "contract"] as const;
export type ConnectorObjectType = (typeof CONNECTOR_OBJECT_TYPES)[number];

/** Tipos de registro que admite cada proveedor. */
export const CONNECTOR_PROVIDER_OBJECTS: Record<ConnectorProvider, readonly ConnectorObjectType[]> = {
  bamboohr: ["employee"],
  hibob: ["employee"],
  factorial: ["employee"],
  ironclad: ["workflow", "record"],
  juro: ["contract"],
};

/** Campos de credenciales por proveedor (conexión por clave/token). Ironclad y Factorial también admiten OAuth. */
export const CONNECTOR_CREDENTIAL_FIELDS: Record<ConnectorProvider, readonly { key: string; secret: boolean; optional?: boolean }[]> = {
  bamboohr: [
    { key: "companyDomain", secret: false },
    { key: "apiKey", secret: true },
  ],
  hibob: [
    { key: "serviceUserId", secret: false },
    { key: "token", secret: true },
  ],
  factorial: [{ key: "apiKey", secret: true }],
  ironclad: [
    { key: "apiToken", secret: true },
    { key: "region", secret: false, optional: true },
    { key: "userEmail", secret: false, optional: true },
  ],
  juro: [{ key: "apiKey", secret: true }],
};

// ───────────────────────────── Conexiones ─────────────────────────────

export const CreateConnectorConnectionInput = z.object({
  provider: z.enum(CONNECTOR_PROVIDERS),
  name: z.string().trim().min(1).max(120),
  /** Valores según CONNECTOR_CREDENTIAL_FIELDS[provider]. */
  credentials: z.record(z.string().trim().max(500)),
});
export type CreateConnectorConnectionInput = z.infer<typeof CreateConnectorConnectionInput>;

export const StartConnectorOAuthInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** Ironclad: na1 (por defecto), eu1 o demo. */
  region: z.enum(["na1", "eu1", "demo"]).optional(),
});
export type StartConnectorOAuthInput = z.infer<typeof StartConnectorOAuthInput>;

export const UpdateConnectorConnectionInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  active: z.boolean().optional(),
});
export type UpdateConnectorConnectionInput = z.infer<typeof UpdateConnectorConnectionInput>;

export interface ConnectorProviderInfo {
  provider: ConnectorProvider;
  category: ConnectorCategory;
  objectTypes: readonly ConnectorObjectType[];
  /** OAuth disponible (app registrada en el servidor). */
  oauthConfigured: boolean;
  oauthSupported: boolean;
  credentialFields: readonly { key: string; secret: boolean; optional?: boolean }[];
}

export interface ConnectorConnection {
  id: string;
  provider: ConnectorProvider;
  category: ConnectorCategory;
  name: string;
  authType: "oauth" | "api_key";
  accountLabel: string | null;
  active: boolean;
  /** URL para que el sistema de origen dispare flujos (lleva un secreto: tratarla como contraseña). */
  webhookUrl: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

// ───────────────────────────── Flujos ─────────────────────────────

export const ConnectorWriteBack = z.object({
  /** Subir el PDF sellado al registro de origen (legajo del empleado, workflow o registro del CLM). */
  uploadSigned: z.boolean().default(true),
  /** Subir también el certificado de evidencia (JSON). */
  uploadEvidence: z.boolean().default(false),
  /**
   * Destino dentro del registro: BambooHR = id de la categoría (sección de archivos), HiBob = "confidential" o
   * "shared", Factorial = id de carpeta, Ironclad record = clave del adjunto (por defecto signedCopy).
   */
  folder: z.string().trim().max(200).optional().nullable(),
  /** Campo/propiedad donde se escribe el estado del sobre (BambooHR, Ironclad record). Vacío: no se escribe. */
  statusProperty: z.string().trim().max(200).optional().nullable(),
  statusValues: z.record(z.enum(CRM_STATUSES), z.string().max(200)).optional(),
});
export type ConnectorWriteBack = z.infer<typeof ConnectorWriteBack>;

export const CONNECTOR_TRIGGERS = ["manual", "webhook"] as const;

export const ConnectorFlowInput = z.object({
  connectionId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  objectType: z.enum(CONNECTOR_OBJECT_TYPES),
  templateId: z.string().uuid(),
  /**
   * template: los documentos de la plantilla. record: el documento del sistema de origen (el contrato del CLM) va
   * primero y la plantilla aporta la hoja de firmas (sus roles y campos).
   */
  documentSource: z.enum(["template", "record"]).default("template"),
  roles: z.array(CrmRoleMapping).max(20).default([]),
  prefill: z.array(CrmPrefillMapping).max(100).default([]),
  writeBack: ConnectorWriteBack.default({ uploadSigned: true, uploadEvidence: false }),
  trigger: z.enum(CONNECTOR_TRIGGERS).default("manual"),
  /** webhook: evento que dispara (vacío: cualquiera), ej. "Created" en BambooHR o "workflow_updated_on_sign_step". */
  triggerConfig: z.object({ event: z.string().trim().max(200).optional().nullable() }).default({}),
  /**
   * Secreto opcional para firmar el webhook entrante de este flujo (16 a 200 caracteres; null lo quita). Con secreto,
   * el flujo solo se dispara si la entrega trae X-CalaSign-Signature: sha256=<hex HMAC-SHA256(secreto, cuerpo)> (o la
   * firma propia de HiBob/Factorial, ver docs/CONECTORES.md). La API nunca lo devuelve (webhookSigned dice si hay).
   */
  webhookSecret: z.string().min(16).max(200).optional().nullable(),
  send: z.boolean().default(true),
  active: z.boolean().default(true),
});
export const CreateConnectorFlowInput = ConnectorFlowInput;
export type CreateConnectorFlowInput = z.input<typeof CreateConnectorFlowInput>;
export const UpdateConnectorFlowInput = ConnectorFlowInput.omit({ connectionId: true }).partial();
export type UpdateConnectorFlowInput = z.input<typeof UpdateConnectorFlowInput>;

export interface ConnectorFlow {
  id: string;
  connectionId: string;
  name: string;
  objectType: ConnectorObjectType;
  templateId: string | null;
  documentSource: "template" | "record";
  roles: CrmRoleMapping[];
  prefill: CrmPrefillMapping[];
  writeBack: ConnectorWriteBack;
  trigger: (typeof CONNECTOR_TRIGGERS)[number];
  triggerConfig: { event?: string | null };
  /** El webhook de este flujo exige firma (tiene webhookSecret). */
  webhookSigned: boolean;
  send: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export const SendFromConnectorInput = z.object({
  recordId: z.string().trim().min(1).max(200),
  send: z.boolean().optional(),
  subject: z.string().trim().min(1).max(300).optional(),
  message: z.string().max(5000).optional().nullable(),
});
export type SendFromConnectorInput = z.infer<typeof SendFromConnectorInput>;

export interface SendFromConnectorResponse {
  envelopeId: string;
  status: string;
  linkId: string;
  runId: string;
}

/** Resultado de buscar registros en el sistema de origen (para elegir desde la UI). */
export interface ConnectorRecordSummary {
  id: string;
  title: string;
  subtitle: string | null;
}

export interface ConnectorLink {
  id: string;
  connectionId: string;
  flowId: string | null;
  envelopeId: string;
  objectType: ConnectorObjectType;
  objectId: string;
  lastStatus: string | null;
  deliveredAt: string | null;
  remoteRef: string | null;
  createdAt: string;
}

export interface ConnectorRun {
  id: string;
  connectionId: string | null;
  connectionName: string | null;
  provider: ConnectorProvider | null;
  flowId: string | null;
  envelopeId: string | null;
  kind: "send" | "write_back";
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
