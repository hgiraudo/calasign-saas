// Plataforma: OAuth 2.0, avisos a Slack/Teams, exportación a la nube y dominio propio.
import { z } from "zod";

// ───────────────────────────── OAuth 2.0 ─────────────────────────────

/**
 * Scopes de la API. Cada uno habilita rutas y, como mucho, los permisos RBAC indicados en
 * OAUTH_SCOPE_PERMISSIONS: el token nunca puede más que el usuario (o el rol de la app) que lo emite.
 */
export const OAUTH_SCOPES = [
  "envelopes:read",
  "envelopes:write",
  "templates:read",
  "templates:write",
  "webhooks:manage",
  "settings:read",
  "settings:write",
  "members:read",
  "members:write",
  "audit:read",
  "offline_access",
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const OAUTH_SCOPE_PERMISSIONS: Record<OAuthScope, readonly string[]> = {
  "envelopes:read": ["envelopes:view_all"],
  "envelopes:write": ["envelopes:create", "envelopes:manage_all"],
  "templates:read": [],
  "templates:write": ["templates:manage"],
  "webhooks:manage": ["webhooks:manage"],
  "settings:read": [],
  "settings:write": ["settings:manage"],
  "members:read": [],
  "members:write": ["members:manage"],
  "audit:read": ["audit:view"],
  offline_access: [],
};

/**
 * Scopes que se conceden por defecto a una app registrada dinámicamente (conectores MCP de Claude, ChatGPT, etc.)
 * cuando no pide ninguno: lo que usan las herramientas del servidor MCP (leer y crear sobres, enviarlos, anularlos,
 * recordar a los firmantes, leer plantillas) y offline_access para que el conector no pida autorizar cada hora.
 */
export const MCP_DEFAULT_SCOPES = ["envelopes:read", "envelopes:write", "templates:read", "offline_access"] as const satisfies readonly OAuthScope[];

export const OAUTH_GRANT_TYPES = ["client_credentials", "authorization_code"] as const;
export type OAuthGrantType = (typeof OAUTH_GRANT_TYPES)[number];

/** Esquemas que no son un destino de redirección (ejecutan código o leen archivos locales). */
const FORBIDDEN_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "filesystem:"]);

const RedirectUri = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => !u.includes("#"), { message: "la URI de redirección no puede tener fragmento (#)" })
  // La pantalla de consentimiento navega a esta URI (también al rechazar): `javascript:` ejecutaría código en el
  // origen de CalaSign para cualquier usuario al que le llegue el link. Se admiten https, http y esquemas propios
  // de apps de escritorio o móviles (RFC 8252).
  .refine((u) => !FORBIDDEN_REDIRECT_SCHEMES.has(new URL(u).protocol.toLowerCase()), {
    message: "esquema de URI de redirección no permitido",
  });

export const CreateOAuthAppInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional().nullable(),
    grantTypes: z.array(z.enum(OAUTH_GRANT_TYPES)).min(1),
    redirectUris: z.array(RedirectUri).max(10).default([]),
    scopes: z.array(z.enum(OAUTH_SCOPES)).min(1),
    /** false: cliente público (app de escritorio / SPA): sin secreto, solo authorization_code + PKCE. */
    confidential: z.boolean().default(true),
    /** Rol de la identidad de servicio (solo client_credentials). Por defecto "member". */
    role: z.enum(["admin", "member", "custom"]).optional(),
    roleId: z.string().uuid().optional().nullable(),
  })
  .refine((a) => !a.grantTypes.includes("authorization_code") || a.redirectUris.length > 0, {
    message: "authorization_code requiere al menos una URI de redirección",
  })
  .refine((a) => a.confidential || !a.grantTypes.includes("client_credentials"), {
    message: "un cliente público no puede usar client_credentials",
  })
  .refine((a) => (a.role === "custom") === Boolean(a.roleId) || (!a.role && !a.roleId), { message: "roleId es obligatorio solo con role=custom" });
export type CreateOAuthAppInput = z.input<typeof CreateOAuthAppInput>;

export const UpdateOAuthAppInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional().nullable(),
  redirectUris: z.array(RedirectUri).max(10).optional(),
  scopes: z.array(z.enum(OAUTH_SCOPES)).min(1).optional(),
});
export type UpdateOAuthAppInput = z.infer<typeof UpdateOAuthAppInput>;

export interface OAuthApp {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  confidential: boolean;
  secretPrefix: string | null;
  grantTypes: OAuthGrantType[];
  redirectUris: string[];
  scopes: OAuthScope[];
  role: string | null;
  roleId: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  activeTokens: number;
}

export interface CreateOAuthAppResponse {
  app: OAuthApp;
  /** Solo para clientes confidenciales. Se muestra una sola vez. */
  clientSecret: string | null;
}

/** Parámetros del pedido de autorización (los mismos de GET /oauth/authorize). */
export const AuthorizeRequest = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(100),
  redirect_uri: z.string().min(1).max(500),
  scope: z.string().max(1000).optional().default(""),
  state: z.string().max(500).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/, "code_challenge inválido"),
  code_challenge_method: z.literal("S256"),
  /** RFC 8707: el recurso para el que se pide el token (los conectores MCP mandan la URL de /mcp). */
  resource: z.string().max(500).optional(),
});
export type AuthorizeRequest = z.input<typeof AuthorizeRequest>;

export const AuthorizeDecision = AuthorizeRequest.and(z.object({ approve: z.boolean() }));
export type AuthorizeDecision = z.input<typeof AuthorizeDecision>;

export interface AuthorizeInfo {
  /**
   * `unverified`: la app se registró sola (registro dinámico, RFC 7591; p. ej. un conector de Claude o ChatGPT): no la
   * publica ninguna organización y CalaSign no verificó quién es (organizationName viene vacío).
   */
  client: { name: string; description: string | null; organizationName: string; clientId: string; unverified: boolean };
  scopes: { scope: OAuthScope; granted: boolean }[];
  user: { name: string; email: string };
  organization: { name: string };
  redirectUri: string;
  /** El usuario ya había autorizado estos scopes a la app (se puede saltear la pantalla). */
  previouslyApproved: boolean;
}

export interface AuthorizeResult {
  redirectTo: string;
}

export interface ConnectedApp {
  clientId: string;
  name: string;
  organizationName: string;
  scopes: OAuthScope[];
  authorizedAt: string;
  /** Registrada dinámicamente (conector MCP): sin organización que la publique. */
  unverified: boolean;
}

// ───────────────── Avisos a canales: Slack, Teams, Discord, Google Chat, Mattermost, Rocket.Chat, Webex ─────────────────

/** Destinos con webhook entrante (la URL la genera la plataforma de chat y es un secreto). */
export const NOTIFICATION_KINDS = ["slack", "teams", "discord", "google_chat", "mattermost", "rocketchat", "webex"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Eventos que se pueden avisar a un canal. */
export const NOTIFICATION_EVENTS = [
  "envelope.sent",
  "envelope.completed",
  "envelope.declined",
  "envelope.voided",
  "envelope.expired",
  "recipient.signed",
  "recipient.approved",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const CreateNotificationIntegrationInput = z.object({
  kind: z.enum(NOTIFICATION_KINDS),
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().url().max(1000),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1),
});
export type CreateNotificationIntegrationInput = z.infer<typeof CreateNotificationIntegrationInput>;

export const UpdateNotificationIntegrationInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().trim().url().max(1000).optional(),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1).optional(),
  active: z.boolean().optional(),
});
export type UpdateNotificationIntegrationInput = z.infer<typeof UpdateNotificationIntegrationInput>;

export interface NotificationIntegration {
  id: string;
  kind: NotificationKind;
  name: string;
  urlHint: string;
  events: NotificationEvent[];
  active: boolean;
  createdAt: string;
  lastSentAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
}

// ───────────────────────────── Almacenamiento en la nube ─────────────────────────────

/** box y sharepoint: gestores documentales (conectores HR/CLM/DMS, docs/CONECTORES.md). */
export const STORAGE_PROVIDERS = ["gdrive", "dropbox", "onedrive", "sharepoint", "box", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export interface StorageProviderInfo {
  provider: StorageProvider;
  /** false: faltan las credenciales de la app OAuth en el servidor (no se puede conectar). */
  configured: boolean;
}

export const ConnectStorageOAuthInput = z.object({
  name: z.string().trim().min(1).max(100),
  /** Carpeta de destino (ruta, o id de carpeta en Google Drive). Vacía: raíz / carpeta de la app. */
  folder: z.string().trim().max(300).optional().default(""),
  /** SharePoint: URL del sitio (https://empresa.sharepoint.com/sites/Legal). Obligatoria para sharepoint. */
  siteUrl: z.string().trim().url().max(400).optional(),
  /** SharePoint: biblioteca de documentos (por defecto, la del sitio: "Documentos" / "Shared Documents"). */
  library: z.string().trim().max(200).optional(),
  /** Además del PDF sellado, subir el certificado de evidencia (JSON con la cadena de eventos). */
  includeEvidence: z.boolean().optional().default(false),
});
export type ConnectStorageOAuthInput = z.input<typeof ConnectStorageOAuthInput>;

export const CreateS3ConnectionInput = z.object({
  name: z.string().trim().min(1).max(100),
  endpoint: z.string().trim().url().max(300),
  region: z.string().trim().min(1).max(50).default("us-east-1"),
  bucket: z.string().trim().min(3).max(63),
  prefix: z.string().trim().max(200).optional().default(""),
  accessKeyId: z.string().trim().min(1).max(200),
  secretAccessKey: z.string().min(1).max(200),
  forcePathStyle: z.boolean().default(true),
  includeEvidence: z.boolean().optional().default(false),
});
export type CreateS3ConnectionInput = z.input<typeof CreateS3ConnectionInput>;

export const UpdateStorageConnectionInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  folder: z.string().trim().max(300).optional(),
  prefix: z.string().trim().max(200).optional(),
  active: z.boolean().optional(),
  includeEvidence: z.boolean().optional(),
});
export type UpdateStorageConnectionInput = z.infer<typeof UpdateStorageConnectionInput>;

export interface StorageConnection {
  id: string;
  provider: StorageProvider;
  name: string;
  /** Carpeta (OAuth) o bucket/prefijo (S3); sin secretos. */
  target: string;
  accountLabel: string | null;
  active: boolean;
  /** También se sube el certificado de evidencia junto al PDF. */
  includeEvidence: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface StorageExport {
  id: string;
  connectionId: string;
  connectionName: string;
  envelopeId: string;
  envelopeSubject: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  remoteRef: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────── Dominio propio ─────────────────────────────

export const SetCustomDomainInput = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "dominio inválido"),
});
export type SetCustomDomainInput = z.infer<typeof SetCustomDomainInput>;

export interface CustomDomain {
  domain: string;
  status: "pending" | "verified";
  /** Registro TXT a crear para verificar. */
  txtName: string;
  txtValue: string;
  /** Registro CNAME recomendado para que el dominio llegue a CalaSign. */
  cnameTarget: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

/** Marca de la organización dueña del dominio por el que se entra (Host). */
export interface HostBranding {
  organizationName: string;
  primaryColor: string | null;
  logoUrl: string | null;
}
