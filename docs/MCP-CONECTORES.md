# Conectores MCP: Claude, ChatGPT, Claude Code y Gemini CLI

El servidor MCP de CalaSign (`POST /mcp`, ver [PAGOS-Y-AGENTES.md](PAGOS-Y-AGENTES.md#3-servidor-mcp-para-agentes-de-ia))
se conecta pegando **una sola URL**: `https://dev.calasign.com/mcp` (en producción, la del entorno). El cliente descubre
el servidor de autorización, se registra solo (registro dinámico, RFC 7591), manda al usuario a la pantalla de
consentimiento de CalaSign y obtiene un token con PKCE. No hace falta crear una app OAuth a mano.

## Flujo

1. El cliente llama a `POST /mcp` sin credencial → `401` con
   `WWW-Authenticate: Bearer resource_metadata="<appUrl>/.well-known/oauth-protected-resource/mcp", scope="envelopes:read envelopes:write templates:read offline_access"`.
2. Lee los metadatos del recurso (RFC 9728) y del servidor de autorización (RFC 8414) en
   `/.well-known/oauth-authorization-server` (también responde con el sufijo `/mcp`). Ahí está `registration_endpoint`.
3. `POST /oauth/register` (JSON) con su nombre y sus `redirect_uris` → `201` con un `client_id` (`csdyn_…`).
4. Abre `GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=<appUrl>/mcp`.
   Si no hay sesión, pasa por el login. La pantalla muestra el nombre de la app con la marca **«aplicación no verificada»**
   (se registró sola: CalaSign no sabe quién la publica) y el host al que vuelve.
5. Al autorizar, vuelve a la `redirect_uri` con `code`, `state` e `iss` (RFC 9207). El cliente canjea en `POST /oauth/token`
   (`grant_type=authorization_code`, `code_verifier`, `resource`) y recibe access token (1 h) y refresh token (30 días,
   rota en cada uso; reutilizar uno revoca toda la autorización).
6. La app queda **atada a la organización del usuario que autorizó**: los tokens llevan esa organización y ese usuario
   (RBAC del usuario ∩ scopes). La misma app autorizada por usuarios de dos organizaciones da tokens separados.

## `POST /oauth/register`

Pedido (JSON):

| Campo | Obligatorio | Valores |
|---|---|---|
| `client_name` | sí | hasta 100 caracteres |
| `redirect_uris` | sí | 1 a 10; `https://…`, o `http://` solo en loopback (`127.0.0.1`, `[::1]`, `localhost`). Sin esquemas propios ni fragmento |
| `grant_types` | no | `["authorization_code","refresh_token"]` (por defecto ambos). `client_credentials` se rechaza siempre |
| `response_types` | no | `["code"]` |
| `token_endpoint_auth_method` | no | `none` (por defecto, cliente público), `client_secret_post`, `client_secret_basic` |
| `scope` | no | scopes separados por espacio; por defecto, todos los habilitables |
| `client_uri`, `logo_uri` | no | URL https |

Respuesta `201`: `client_id`, `client_secret` (solo si el método no es `none`), `client_id_issued_at`,
`client_secret_expires_at: 0`, `client_name`, `redirect_uris`, `grant_types`, `response_types`,
`token_endpoint_auth_method`, `scope`. Errores `400` `{ "error": "invalid_redirect_uri" | "invalid_client_metadata", "error_description": "…" }`.
Límite: 20 registros por hora por IP. Las apps registradas que nadie autorizó (sin consentimientos ni tokens) se borran a
los 30 días (barrido periódico del worker).

## Reglas

- **PKCE S256 obligatorio**, como para cualquier app.
- **Redirect URI**: coincidencia exacta, salvo en loopback `http`, donde el puerto puede ser cualquiera (RFC 8252 §7.3; se
  aplica a `127.0.0.1`, `[::1]` y `localhost`). Host, ruta y query tienen que coincidir.
- **`resource` (RFC 8707)**: opcional en `authorize` y `token`; si viene, tiene que ser `<appUrl>/mcp` o `<appUrl>`; si no,
  `invalid_target`. Hay un solo recurso protegido, así que el token no lleva audiencia aparte.
- **Scopes**: si el cliente no pide ninguno (o pide solo los que no existen, como `openid`/`profile`), se conceden
  `envelopes:read envelopes:write templates:read offline_access` (lo que usan las herramientas). Si pide scopes válidos,
  se concede la intersección con los de la app. Una app registrada con `refresh_token` recibe siempre `offline_access`
  (se muestra en la pantalla de consentimiento).
- **Nunca `client_credentials`**: daría acceso a una organización sin ningún usuario detrás. Un cliente dinámico público
  recibe `invalid_client`; uno confidencial, `unauthorized_client`.
- **Dónde se ven**: no aparecen en *Apps OAuth* de la organización (no son suyas). Aparecen en *Apps conectadas* del usuario
  que las autorizó, marcadas «aplicación no verificada», y desde ahí se desconectan (se revocan sus tokens en esa organización).
- **CORS** abierto (`*`, sin cookies) en `/.well-known/oauth-*`, `/oauth/register`, `/oauth/token`, `/oauth/revoke` y `/mcp`,
  para clientes que corren en el navegador (MCP Inspector).

## Cómo conectar cada cliente

| Cliente | Cómo | Redirect URI que registra |
|---|---|---|
| Claude (claude.ai, Desktop, móvil) | Ajustes → Conectores → *Agregar conector personalizado* → URL `https://dev.calasign.com/mcp` | `https://claude.ai/api/mcp/auth_callback` (Anthropic avisa que puede pasar a `https://claude.com/api/mcp/auth_callback`) |
| ChatGPT (modo desarrollador / Apps) | Ajustes → Apps y conectores → modo desarrollador → *Crear* → URL del MCP, autenticación OAuth | `https://chatgpt.com/connector_platform_oauth_redirect` (si el servidor anuncia RFC 9207, como este) o `https://chatgpt.com/connector/oauth/{callback_id}` |
| Claude Code | `claude mcp add --transport http calasign https://dev.calasign.com/mcp` y después `/mcp` para autenticar | loopback `http://localhost:<puerto>/callback` o `http://127.0.0.1:<puerto>/callback`, puerto efímero |
| Gemini CLI | en `settings.json`: `"mcpServers": { "calasign": { "httpUrl": "https://dev.calasign.com/mcp" } }` y `/mcp auth calasign` | `http://localhost:7777/oauth/callback` (según la documentación de Gemini CLI; si el puerto está ocupado o se configura otro, cambia) |

Como el registro es dinámico, cada cliente declara sus propias URIs: no hay que dar de alta nada en CalaSign. La tabla sirve
para diagnosticar.

### Qué se verificó (octubre de 2026)

- **Claude**: [claude.com/docs/connectors/building/authentication](https://claude.com/docs/connectors/building/authentication).
  Confirma `https://claude.ai/api/mcp/auth_callback`, que Claude Code usa loopback con puerto variable (`localhost` y
  `127.0.0.1`, hay que ignorar el puerto en ambos), DCR soportado por defecto (CIMD solo si el servidor anuncia
  `client_id_metadata_document_supported`; no lo anunciamos, así que usa DCR), `scope` del 401 o `scopes_supported` del
  recurso, `offline_access` agregado si figura en los metadatos del servidor de autorización, refresh con `invalid_grant` y
  rotación, `/token` en `x-www-form-urlencoded`. La URL `claude.com/api/mcp/auth_callback` figura como posible cambio futuro
  en el artículo de soporte de Anthropic.
- **ChatGPT**: [developers.openai.com/apps-sdk/build/auth](https://developers.openai.com/apps-sdk/build/auth). Confirma DCR
  (`registration_endpoint`), `resource` en authorize y token, PKCE S256, y las dos redirect URIs de la tabla
  (la estable si el servidor anuncia `authorization_response_iss_parameter_supported`, que este anuncia y cumple).
- **Gemini CLI**: `http://localhost:7777/oauth/callback` según su documentación de servidores MCP (vista por terceros:
  geminicli.com/docs/tools/mcp-server); algunas fuentes dicen que el puerto puede ser aleatorio. Con la regla de loopback
  da igual el puerto. No se probó con el cliente real.
- **Claude Code**: comando `claude mcp add --transport http …` de su documentación; no se probó con el cliente real.

## Pendiente / ideas

- CIMD (Client ID Metadata Documents): Claude y ChatGPT lo prefieren y evita acumular apps registradas. Hoy caen a DCR.
- Aviso extra en la pantalla de consentimiento cuando todas las redirect URIs son loopback (lo recomienda la especificación
  MCP: cualquier proceso local puede escuchar en ese puerto).
