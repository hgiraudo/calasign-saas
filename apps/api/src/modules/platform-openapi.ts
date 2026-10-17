// Operaciones de la plataforma (OAuth 2.0, Slack/Teams, almacenamiento, dominio propio) para el OpenAPI.
import { z } from "zod";
import {
  AuthorizeDecision,
  ConnectStorageOAuthInput,
  CreateNotificationIntegrationInput,
  CreateOAuthAppInput,
  CreateS3ConnectionInput,
  OAUTH_SCOPES,
  SetCustomDomainInput,
  UpdateNotificationIntegrationInput,
  UpdateOAuthAppInput,
  UpdateStorageConnectionInput,
} from "@calasign/shared";

const iso = z.string().datetime();

const OAuthApp = z.object({
  id: z.string().uuid(),
  clientId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  confidential: z.boolean(),
  secretPrefix: z.string().nullable(),
  grantTypes: z.array(z.enum(["client_credentials", "authorization_code"])),
  redirectUris: z.array(z.string()),
  scopes: z.array(z.enum(OAUTH_SCOPES)),
  role: z.string().nullable(),
  roleId: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  revokedAt: iso.nullable(),
  activeTokens: z.number().int(),
});

const TokenResponse = z.object({
  access_token: z.string().describe("Opaco, prefijo csat_. Vence en 1 h."),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int(),
  refresh_token: z.string().optional().describe("Solo con offline_access (authorization_code). Rota en cada uso."),
  scope: z.string(),
});

const TokenRequest = z.object({
  grant_type: z.enum(["client_credentials", "authorization_code", "refresh_token"]),
  scope: z.string().optional().describe("Scopes separados por espacios"),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional().describe("PKCE (S256), obligatorio con authorization_code"),
  refresh_token: z.string().optional(),
  client_id: z.string().optional().describe("Si no se usa HTTP Basic"),
  client_secret: z.string().optional().describe("Si no se usa HTTP Basic"),
});

const NotificationIntegration = z.object({
  id: z.string().uuid(),
  kind: z.enum(["slack", "teams"]),
  name: z.string(),
  urlHint: z.string(),
  events: z.array(z.string()),
  active: z.boolean(),
  createdAt: iso,
  lastSentAt: iso.nullable(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
});

const StorageConnection = z.object({
  id: z.string().uuid(),
  provider: z.enum(["gdrive", "dropbox", "onedrive", "s3"]),
  name: z.string(),
  target: z.string(),
  accountLabel: z.string().nullable(),
  active: z.boolean(),
  createdAt: iso,
  lastSuccessAt: iso.nullable(),
  lastError: z.string().nullable(),
});

const CustomDomain = z.object({
  domain: z.string(),
  status: z.enum(["pending", "verified"]),
  txtName: z.string(),
  txtValue: z.string(),
  cnameTarget: z.string(),
  verifiedAt: iso.nullable(),
  lastCheckedAt: iso.nullable(),
  lastError: z.string().nullable(),
});

type PlatformOp = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: z.ZodTypeAny;
  form?: z.ZodTypeAny;
  response?: z.ZodTypeAny | "none";
  status?: number;
  auth?: "key" | "none" | "client";
};

export const PLATFORM_OPS: PlatformOp[] = [
  {
    method: "post",
    path: "/oauth/token",
    tag: "OAuth 2.0",
    summary: "Obtener tokens",
    description:
      "client_credentials (servidor a servidor), authorization_code con PKCE S256 obligatorio y refresh_token (rota: cada uso devuelve uno nuevo; reutilizar uno ya canjeado revoca toda la autorización). Cliente: HTTP Basic o client_id/client_secret en el cuerpo. Errores RFC 6749: { error, error_description }.",
    form: TokenRequest,
    response: TokenResponse,
    auth: "client",
  },
  { method: "post", path: "/oauth/revoke", tag: "OAuth 2.0", summary: "Revocar un token (RFC 7009)", description: "Revocar un refresh token revoca toda la familia. Siempre 200.", form: z.object({ token: z.string(), token_type_hint: z.string().optional() }), auth: "client" },
  {
    method: "post",
    path: "/oauth/introspect",
    tag: "OAuth 2.0",
    summary: "Introspección (RFC 7662)",
    description: "Solo tokens emitidos para la misma app. Requiere cliente confidencial.",
    form: z.object({ token: z.string() }),
    response: z.object({ active: z.boolean(), scope: z.string().optional(), client_id: z.string().optional(), sub: z.string().optional(), tenant_id: z.string().optional(), exp: z.number().optional(), iat: z.number().optional() }),
    auth: "client",
  },
  {
    method: "get",
    path: "/oauth/authorize",
    tag: "OAuth 2.0",
    summary: "Pantalla de consentimiento (navegador)",
    description:
      "Redirigir al usuario con response_type=code, client_id, redirect_uri (exacta, registrada), scope, state, code_challenge y code_challenge_method=S256. Vuelve a redirect_uri con code y state (o error=access_denied).",
    auth: "none",
  },
  { method: "post", path: "/v1/oauth/authorize/decision", tag: "OAuth 2.0", summary: "Aprobar o rechazar (lo usa la pantalla de consentimiento; solo sesión web)", body: AuthorizeDecision, response: z.object({ redirectTo: z.string() }) },
  { method: "get", path: "/v1/oauth/apps", tag: "OAuth 2.0", summary: "Apps OAuth de la organización", response: z.object({ items: z.array(OAuthApp) }) },
  { method: "post", path: "/v1/oauth/apps", tag: "OAuth 2.0", summary: "Registrar una app (el secreto se devuelve una sola vez)", body: CreateOAuthAppInput, status: 201, response: z.object({ app: OAuthApp, clientSecret: z.string().nullable() }) },
  { method: "patch", path: "/v1/oauth/apps/{id}", tag: "OAuth 2.0", summary: "Modificar una app", body: UpdateOAuthAppInput, response: OAuthApp },
  { method: "post", path: "/v1/oauth/apps/{id}/rotate-secret", tag: "OAuth 2.0", summary: "Rotar el secreto (el anterior deja de valer)", response: z.object({ app: OAuthApp, clientSecret: z.string() }) },
  { method: "delete", path: "/v1/oauth/apps/{id}", tag: "OAuth 2.0", summary: "Revocar una app y todos sus tokens", response: "none", status: 204 },

  { method: "get", path: "/v1/notification-integrations", tag: "Slack y Teams", summary: "Integraciones de avisos", response: z.object({ items: z.array(NotificationIntegration) }) },
  { method: "post", path: "/v1/notification-integrations", tag: "Slack y Teams", summary: "Conectar un canal (webhook entrante de Slack o Teams)", body: CreateNotificationIntegrationInput, status: 201, response: NotificationIntegration },
  { method: "patch", path: "/v1/notification-integrations/{id}", tag: "Slack y Teams", summary: "Modificar", body: UpdateNotificationIntegrationInput, response: NotificationIntegration },
  { method: "delete", path: "/v1/notification-integrations/{id}", tag: "Slack y Teams", summary: "Quitar", response: "none", status: 204 },
  { method: "post", path: "/v1/notification-integrations/{id}/test", tag: "Slack y Teams", summary: "Enviar un mensaje de prueba", response: z.object({ ok: z.boolean(), status: z.number().nullable(), error: z.string().nullable() }) },

  { method: "get", path: "/v1/storage/providers", tag: "Almacenamiento", summary: "Proveedores disponibles", response: z.object({ items: z.array(z.object({ provider: z.string(), configured: z.boolean() })) }) },
  { method: "get", path: "/v1/storage/connections", tag: "Almacenamiento", summary: "Conexiones", response: z.object({ items: z.array(StorageConnection) }) },
  { method: "post", path: "/v1/storage/connections/s3", tag: "Almacenamiento", summary: "Conectar un bucket compatible con S3 (se prueba al crear)", body: CreateS3ConnectionInput, status: 201, response: StorageConnection },
  { method: "post", path: "/v1/storage/oauth/{provider}/start", tag: "Almacenamiento", summary: "Conectar Google Drive, Dropbox u OneDrive: devuelve la URL de autorización", body: ConnectStorageOAuthInput, response: z.object({ authorizeUrl: z.string() }) },
  { method: "patch", path: "/v1/storage/connections/{id}", tag: "Almacenamiento", summary: "Modificar (nombre, carpeta, activa)", body: UpdateStorageConnectionInput, response: StorageConnection },
  { method: "delete", path: "/v1/storage/connections/{id}", tag: "Almacenamiento", summary: "Desconectar", response: "none", status: 204 },
  { method: "post", path: "/v1/storage/connections/{id}/test", tag: "Almacenamiento", summary: "Probar escritura", response: z.object({ ok: z.boolean(), ref: z.string().nullable(), error: z.string().nullable() }) },
  { method: "get", path: "/v1/storage/exports", tag: "Almacenamiento", summary: "Exportaciones recientes" },
  { method: "post", path: "/v1/storage/exports/{id}/retry", tag: "Almacenamiento", summary: "Reintentar una exportación fallida", status: 202 },

  { method: "get", path: "/v1/domains", tag: "Dominio propio", summary: "Dominio de la organización", response: z.object({ domain: CustomDomain.nullable() }) },
  { method: "put", path: "/v1/domains", tag: "Dominio propio", summary: "Registrar o cambiar el dominio", body: SetCustomDomainInput, response: z.object({ domain: CustomDomain }) },
  { method: "post", path: "/v1/domains/verify", tag: "Dominio propio", summary: "Verificar el registro TXT", response: z.object({ domain: CustomDomain }) },
  { method: "delete", path: "/v1/domains", tag: "Dominio propio", summary: "Quitar el dominio", response: "none", status: 204 },
  { method: "get", path: "/v1/public/host-branding", tag: "Dominio propio", summary: "Marca de la organización según el Host", auth: "none" },
];

export const OAUTH2_SECURITY_SCHEME = {
  type: "oauth2",
  description: "OAuth 2.0. Tokens opacos (csat_…) de 1 h. PKCE S256 obligatorio en authorization_code.",
  flows: {
    clientCredentials: { tokenUrl: "/oauth/token", scopes: Object.fromEntries(OAUTH_SCOPES.filter((s) => s !== "offline_access").map((s) => [s, s])) },
    authorizationCode: {
      authorizationUrl: "/oauth/authorize",
      tokenUrl: "/oauth/token",
      refreshUrl: "/oauth/token",
      scopes: Object.fromEntries(OAUTH_SCOPES.map((s) => [s, s === "offline_access" ? "Refresh token (acceso sin la persona presente)" : s])),
    },
  },
};
