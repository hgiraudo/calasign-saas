// Operaciones de la plataforma (OAuth 2.0, Slack/Teams, almacenamiento, dominio propio) para el OpenAPI.
import { z } from "zod";
import {
  AuthorizeDecision,
  ConnectStorageOAuthInput,
  CreateNotificationIntegrationInput,
  CreateOAuthAppInput,
  CreateS3ConnectionInput,
  CreateScimTokenInput,
  NOTIFICATION_KINDS,
  OAUTH_SCOPES,
  SetCustomDomainInput,
  SSO_PROTOCOLS,
  SsoSettingsInput,
  UpdateNotificationIntegrationInput,
  UpdateOAuthAppInput,
  UpdateStorageConnectionInput,
} from "@calasign/shared";
import type { Op } from "./openapi-extra";
import { named } from "./openapi-schemas";

const iso = z.string().datetime();

const OAuthApp = named(
  "OAuthApp",
  z.object({
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
  canTakeOver: z.boolean().optional().describe("Si quien consulta puede rotar el secreto o cambiar las URI de redirección (la creó, es propietario o tiene los permisos de quien la creó)."),
  }),
);

const SsoSettingsSchema = named(
  "SsoSettings",
  z.object({
    enabled: z.boolean(),
    protocol: z.enum(SSO_PROTOCOLS),
    domains: z.array(z.string()),
    jitEnabled: z.boolean(),
    jitRole: z.enum(["admin", "member"]),
    enforce: z.boolean(),
    sessionTtlHours: z.number().int().describe("Duración absoluta de las sesiones abiertas por SSO (por defecto 24)."),
    oidc: z.object({ issuer: z.string(), clientId: z.string(), scopes: z.string(), hasClientSecret: z.boolean(), trustUnverifiedEmail: z.boolean() }).nullable(),
    saml: z.object({ entryPoint: z.string(), idpIssuer: z.string(), idpCertFingerprint: z.string().nullable(), emailAttribute: z.string().nullable() }).nullable(),
    serviceProvider: z
      .object({ oidcRedirectUri: z.string(), samlEntityId: z.string(), samlAcsUrl: z.string(), samlMetadataUrl: z.string(), loginUrl: z.string() })
      .describe("Datos para configurar el IdP."),
  }),
);

const ScimTokenSchema = named(
  "ScimToken",
  z.object({ id: z.string().uuid(), name: z.string(), prefix: z.string(), createdAt: iso, lastUsedAt: iso.nullable(), revokedAt: iso.nullable() }),
);

const ScimSettingsSchema = named(
  "ScimSettings",
  z.object({
    baseUrl: z.string().describe("Base de los endpoints SCIM para configurar en el IdP."),
    tokens: z.array(ScimTokenSchema),
    defaultRole: z.enum(["admin", "member"]).describe("Rol con el que se dan de alta los usuarios aprovisionados."),
  }),
);

const TokenResponse = named(
  "TokenResponse",
  z.object({
  access_token: z.string().describe("Opaco, prefijo csat_. Vence en 1 h."),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int(),
  refresh_token: z.string().optional().describe("Solo con offline_access (authorization_code). Rota en cada uso."),
  scope: z.string().describe("Scopes concedidos, separados por espacios."),
  }),
);

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
  kind: z.enum(NOTIFICATION_KINDS),
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

type PlatformOp = Op;

export const PLATFORM_OPS: PlatformOp[] = [
  {
    method: "post",
    path: "/oauth/token", operationId: "oauthToken",
    tag: "OAuth 2.0",
    summary: "Obtener tokens",
    description:
      "client_credentials (servidor a servidor), authorization_code con PKCE S256 obligatorio y refresh_token (rota: cada uso devuelve uno nuevo; reutilizar uno ya canjeado revoca toda la autorización). Cliente: HTTP Basic o client_id/client_secret en el cuerpo. Errores RFC 6749: { error, error_description }.",
    form: TokenRequest,
    response: TokenResponse,
    auth: "client",
  },
  {
    method: "post",
    path: "/oauth/register", operationId: "oauthRegister",
    tag: "OAuth 2.0",
    summary: "Registro dinámico de clientes (RFC 7591)",
    description:
      "Público, sin credenciales (así se conectan Claude, ChatGPT y las CLI): la app queda sin organización y no puede nada hasta que un usuario la autorice en la pantalla de consentimiento, donde figura como no verificada. Solo authorization_code (PKCE S256) y refresh_token; token_endpoint_auth_method none (por defecto), client_secret_post o client_secret_basic. redirect_uris: de 1 a 10, https o http en loopback. Sin scope recibe todos. Devuelve client_id `csdyn_…` y, si no es un cliente público, client_secret (una sola vez; no vence). Una app que nadie autorizó se borra a los 30 días. 20 registros por hora por IP. Errores RFC 7591: { error: invalid_client_metadata | invalid_redirect_uri, error_description }.",
    body: z.object({
      client_name: z.string().max(100),
      redirect_uris: z.array(z.string().max(500)).min(1).max(10),
      grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).optional(),
      response_types: z.array(z.literal("code")).optional(),
      token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional(),
      scope: z.string().max(1000).optional(),
      client_uri: z.string().optional(),
      logo_uri: z.string().optional(),
    }),
    status: 201,
    response: z.object({
      client_id: z.string(),
      client_secret: z.string().optional(),
      client_id_issued_at: z.number(),
      client_secret_expires_at: z.literal(0),
      client_name: z.string(),
      redirect_uris: z.array(z.string()),
      grant_types: z.array(z.string()),
      response_types: z.array(z.string()),
      token_endpoint_auth_method: z.string(),
      scope: z.string(),
      client_uri: z.string().optional(),
      logo_uri: z.string().optional(),
    }),
    auth: "none",
  },
  { method: "post", path: "/oauth/revoke", operationId: "oauthRevoke", tag: "OAuth 2.0", summary: "Revocar un token (RFC 7009)", description: "Revocar un refresh token revoca toda la familia. Responde 200 `{}` también si el token no existe o es de otra app (no revela nada); 400/401 solo por un pedido o cliente inválido.", form: z.object({ token: z.string(), token_type_hint: z.string().optional() }), response: z.object({}).strict(), auth: "client" },
  {
    method: "post",
    path: "/oauth/introspect", operationId: "oauthIntrospect",
    tag: "OAuth 2.0",
    summary: "Introspección (RFC 7662)",
    description: "Solo tokens emitidos para la misma app. Requiere cliente confidencial.",
    form: z.object({ token: z.string() }),
    response: z.object({ active: z.boolean(), scope: z.string().optional(), client_id: z.string().optional(), sub: z.string().optional(), tenant_id: z.string().optional(), exp: z.number().optional(), iat: z.number().optional() }),
    auth: "client",
  },
  {
    method: "get",
    path: "/oauth/authorize", operationId: "oauthAuthorize",
    tag: "OAuth 2.0",
    summary: "Pantalla de consentimiento (navegador)",
    description:
      "Redirigir al usuario con response_type=code, client_id, redirect_uri (exacta, registrada), scope, state, code_challenge y code_challenge_method=S256. Vuelve a redirect_uri con code y state (o error=access_denied).",
    response: "html",
    auth: "none",
  },
  { method: "post", path: "/v1/oauth/authorize/decision", operationId: "oauthAuthorizeDecision", tag: "OAuth 2.0", summary: "Aprobar o rechazar (lo usa la pantalla de consentimiento; solo sesión web)", body: AuthorizeDecision, response: z.object({ redirectTo: z.string() }), errors: ["session_required", "invalid_target"] },
  { method: "get", path: "/v1/oauth/apps", operationId: "listOAuthApps", tag: "OAuth 2.0", summary: "Apps OAuth de la organización", response: z.object({ items: z.array(OAuthApp) }) },
  { method: "post", path: "/v1/oauth/apps", operationId: "createOAuthApp", tag: "OAuth 2.0", summary: "Registrar una app (el secreto se devuelve una sola vez)", body: CreateOAuthAppInput, status: 201, response: z.object({ app: OAuthApp, clientSecret: z.string().nullable() }) },
  { method: "patch", path: "/v1/oauth/apps/{id}", operationId: "updateOAuthApp", tag: "OAuth 2.0", summary: "Modificar una app", body: UpdateOAuthAppInput, response: OAuthApp },
  { method: "get", path: "/v1/oauth/apps/{id}", operationId: "getOAuthApp", tag: "OAuth 2.0", summary: "Detalle de una app", response: OAuthApp },
  {
    method: "get",
    path: "/v1/oauth/connected-apps",
    operationId: "listConnectedApps",
    tag: "OAuth 2.0",
    summary: "Apps que el usuario autorizó (solo sesión web)",
    description: "Las apps OAuth a las que el usuario de la sesión dio consentimiento en esta organización. Con API key u OAuth, 403 session_required.",
    response: z.object({
      items: z.array(
        z.object({
          clientId: z.string(),
          name: z.string(),
          organizationName: z.string().describe("Organización que publica la app (vacío si se registró dinámicamente)."),
          scopes: z.array(z.enum(OAUTH_SCOPES)),
          authorizedAt: iso,
          unverified: z.boolean().describe("Registrada dinámicamente (conector MCP): sin organización que la publique."),
        }),
      ),
    }),
    errors: ["session_required"],
  },
  {
    method: "delete",
    path: "/v1/oauth/connected-apps/{clientId}",
    operationId: "disconnectApp",
    tag: "OAuth 2.0",
    summary: "Desconectar una app autorizada (solo sesión web)",
    description: "Borra el consentimiento y revoca los tokens y los códigos sin canjear que la app tiene del usuario en esta organización. Con API key u OAuth, 403 session_required.",
    response: "none",
    status: 204,
    errors: ["session_required"],
  },
  { method: "post", path: "/v1/oauth/apps/{id}/rotate-secret", operationId: "rotateOAuthAppSecret", tag: "OAuth 2.0", summary: "Rotar el secreto (el anterior deja de valer)", errors: ["public_client"], response: z.object({ app: OAuthApp, clientSecret: z.string() }) },
  { method: "delete", path: "/v1/oauth/apps/{id}", operationId: "deleteOAuthApp", tag: "OAuth 2.0", summary: "Revocar una app y todos sus tokens", response: "none", status: 204 },

  { method: "get", path: "/v1/notification-integrations", operationId: "listNotificationIntegrations", tag: "Avisos a canales", summary: "Integraciones de avisos", response: z.object({ items: z.array(NotificationIntegration) }) },
  { method: "post", path: "/v1/notification-integrations", operationId: "createNotificationIntegration", tag: "Avisos a canales", summary: "Conectar un canal (webhook entrante de Slack, Teams, Discord, Google Chat, Mattermost, Rocket.Chat o Webex)", body: CreateNotificationIntegrationInput, status: 201, response: NotificationIntegration },
  { method: "patch", path: "/v1/notification-integrations/{id}", operationId: "updateNotificationIntegration", tag: "Avisos a canales", summary: "Modificar", body: UpdateNotificationIntegrationInput, response: NotificationIntegration },
  { method: "delete", path: "/v1/notification-integrations/{id}", operationId: "deleteNotificationIntegration", tag: "Avisos a canales", summary: "Quitar", response: "none", status: 204 },
  { method: "post", path: "/v1/notification-integrations/{id}/test", operationId: "testNotificationIntegration", tag: "Avisos a canales", summary: "Enviar un mensaje de prueba", response: z.object({ ok: z.boolean(), status: z.number().nullable(), error: z.string().nullable() }) },

  { method: "get", path: "/v1/storage/providers", operationId: "listStorageProviders", tag: "Almacenamiento", summary: "Proveedores disponibles", response: z.object({ items: z.array(z.object({ provider: z.string(), configured: z.boolean() })) }) },
  { method: "get", path: "/v1/storage/connections", operationId: "listStorageConnections", tag: "Almacenamiento", summary: "Conexiones", response: z.object({ items: z.array(StorageConnection) }) },
  { method: "post", path: "/v1/storage/connections/s3", operationId: "createS3Connection", tag: "Almacenamiento", summary: "Conectar un bucket compatible con S3 (se prueba al crear)", body: CreateS3ConnectionInput, status: 201, response: StorageConnection },
  { method: "post", path: "/v1/storage/oauth/{provider}/start", operationId: "startStorageOAuth", tag: "Almacenamiento", summary: "Conectar Google Drive, Dropbox, OneDrive, SharePoint o Box: devuelve la URL de autorización (solo sesión web)", description: "provider: gdrive, dropbox, onedrive, sharepoint o box. Lo usa la web (Configuración → Almacenamiento): devuelve la URL a la que hay que llevar el navegador del usuario para que autorice; con API key u OAuth responde 403 session_required. SharePoint exige `siteUrl` (y opcionalmente `library`). Para conectar almacenamiento desde una integración, usar POST /v1/storage/connections/s3.", body: ConnectStorageOAuthInput, response: z.object({ authorizeUrl: z.string() }), errors: ["session_required", "storage_provider_not_configured", "site_required", "too_many_connections"] },
  { method: "patch", path: "/v1/storage/connections/{id}", operationId: "updateStorageConnection", tag: "Almacenamiento", summary: "Modificar (nombre, carpeta, activa)", body: UpdateStorageConnectionInput, response: StorageConnection },
  { method: "delete", path: "/v1/storage/connections/{id}", operationId: "deleteStorageConnection", tag: "Almacenamiento", summary: "Desconectar", response: "none", status: 204 },
  { method: "post", path: "/v1/storage/connections/{id}/test", operationId: "testStorageConnection", tag: "Almacenamiento", summary: "Probar escritura", response: z.object({ ok: z.boolean(), ref: z.string().nullable(), error: z.string().nullable() }) },
  {
    method: "get",
    path: "/v1/storage/exports",
    operationId: "listStorageExports",
    tag: "Almacenamiento",
    summary: "Exportaciones recientes",
    query: [{ name: "limit", description: "Cantidad máxima (1..200, por defecto 50).", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }],
  },
  {
    method: "post",
    path: "/v1/storage/exports/{id}/retry",
    operationId: "retryStorageExport",
    tag: "Almacenamiento",
    summary: "Reintentar una exportación fallida",
    description:
      "Solo una exportación fallida o una pendiente abandonada (sin avances en 15 minutos). Una que sigue en la cola o subiéndose responde 409 export_in_progress; una ya exportada, 409 already_exported.",
    status: 202,
    errors: ["export_in_progress"],
  },

  { method: "get", path: "/v1/domains", operationId: "getCustomDomain", tag: "Dominio propio", summary: "Dominio de la organización", response: z.object({ domain: CustomDomain.nullable() }) },
  { method: "put", path: "/v1/domains", operationId: "setCustomDomain", tag: "Dominio propio", summary: "Registrar o cambiar el dominio", description: "Exige el dominio propio en el plan (402). No se pueden reclamar los hosts de la plataforma (APP_URL, PLATFORM_HOSTS).", body: SetCustomDomainInput, response: z.object({ domain: CustomDomain }), errors: ["plan_limit_custom_domain"] },
  { method: "post", path: "/v1/domains/verify", operationId: "verifyCustomDomain", tag: "Dominio propio", summary: "Verificar el registro TXT", description: "Verificar (o re-verificar) exige el dominio propio en el plan (402); quitarlo no.", response: z.object({ domain: CustomDomain }), errors: ["plan_limit_custom_domain"] },
  { method: "delete", path: "/v1/domains", operationId: "deleteCustomDomain", tag: "Dominio propio", summary: "Quitar el dominio", response: "none", status: 204 },
  // SSO, SCIM y supresiones de correo (administración de la organización).
  {
    method: "get",
    path: "/v1/settings/sso",
    operationId: "getSsoSettings",
    tag: "Equipo",
    summary: "Configuración del inicio de sesión único (SSO)",
    description: "Exige settings:manage (también para leer). Sin secretos: el client secret de OIDC solo se informa como hasClientSecret.",
    response: SsoSettingsSchema,
  },
  {
    method: "put",
    path: "/v1/settings/sso",
    operationId: "putSsoSettings",
    tag: "Equipo",
    summary: "Configurar SSO (OIDC o SAML)",
    description:
      "Solo un propietario (403 forbidden). Exige SSO en el plan (402), salvo para deshabilitarlo (`enabled: false`). Errores 400 propios: invalid_issuer / invalid_entry_point (URL no https), invalid_certificate (certificado del IdP inválido), certificate_required (SAML sin certificado), client_secret_required y oidc_config_required (OIDC incompleto), oidc_discovery_failed (no se pudo leer la configuración del IdP), sso_disabled (`enforce` sin `enabled`); 409 domain_taken si un dominio ya lo verificó otra organización.",
    body: SsoSettingsInput,
    response: SsoSettingsSchema,
    errors: ["plan_limit_sso"],
  },
  {
    method: "get",
    path: "/v1/settings/scim",
    operationId: "getScimSettings",
    tag: "Equipo",
    summary: "Aprovisionamiento SCIM: URL base, tokens y rol por defecto",
    description: "Exige members:manage.",
    response: ScimSettingsSchema,
  },
  {
    method: "patch",
    path: "/v1/settings/scim",
    operationId: "updateScimSettings",
    tag: "Equipo",
    summary: "Cambiar el rol con que se dan de alta los usuarios aprovisionados",
    description: "Exige members:manage y settings:manage, poder otorgar ese rol, y SCIM en el plan (402).",
    body: z.object({ defaultRole: z.enum(["admin", "member"]) }),
    response: ScimSettingsSchema,
    errors: ["plan_limit_scim"],
  },
  {
    method: "post",
    path: "/v1/settings/scim/tokens",
    operationId: "createScimToken",
    tag: "Equipo",
    summary: "Crear un token SCIM (el secreto se devuelve una sola vez)",
    description: "Lo crea quien tiene todos los permisos de un administrador, o un propietario. Exige SCIM en el plan (402).",
    body: CreateScimTokenInput,
    status: 201,
    response: z.object({ token: ScimTokenSchema, secret: z.string().describe("cs_scim_…; se muestra una sola vez.") }),
    errors: ["plan_limit_scim"],
  },
  { method: "delete", path: "/v1/settings/scim/tokens/{id}", operationId: "revokeScimToken", tag: "Equipo", summary: "Revocar un token SCIM", description: "No exige el plan (se puede revocar tras bajar de plan).", response: "none", status: 204 },
  {
    method: "get",
    path: "/v1/settings/email-suppressions",
    operationId: "listEmailSuppressions",
    tag: "Equipo",
    summary: "Direcciones que se quejaron de los correos de la organización",
    description: "Las 500 más recientes. A esas direcciones no se les escribe (ni códigos OTP: 409 otp_destination_suppressed) hasta quitarlas. Exige settings:manage.",
    response: z.object({
      items: z.array(z.object({ address: z.string(), reason: z.string(), detail: z.string().nullable(), createdAt: iso, updatedAt: iso })),
    }),
  },
  {
    method: "delete",
    path: "/v1/settings/email-suppressions/{address}",
    operationId: "deleteEmailSuppression",
    tag: "Equipo",
    summary: "Volver a escribirle a una dirección",
    description: "Solo las quejas de la propia organización (los rebotes son globales y vencen solos): sin queja propia, 404.",
    response: "none",
    status: 204,
  },
  { method: "get", path: "/v1/public/host-branding", operationId: "getHostBranding", tag: "Dominio propio", summary: "Marca de la organización según el Host", auth: "none" },
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
