# CRM y ERP (Fase 6)

Conectores por organización (HubSpot, Salesforce, Pipedrive, Siigo, Alegra) para enviar a firmar desde un CRM y devolver el resultado, y para dejar el documento
firmado en el ERP. Código: `apps/api/src/modules/crm/` (`providers.ts` clientes HTTP, `mapping.ts` mapeo puro,
`index.ts` rutas y trabajos, `pipedrive.ts` cliente de Pipedrive). Web: Ajustes → **CRM y ERP** (`/app/settings/crm`).
Migraciones `0015_crm.sql` y `0047_crm_pipedrive.sql` (amplía el CHECK de proveedor con `zoho` y `pipedrive`).

## Qué hace

| Proveedor | Tipo | Conexión | Desde el registro | Al completarse |
|---|---|---|---|---|
| **HubSpot** | CRM | OAuth (app pública) o token de app privada | "Enviar a firmar" desde un **Deal**: contactos asociados + propiedades del deal → plantilla. También por **webhook** cuando cambia una propiedad (ej. `dealstage = contractsent`). | Estado en una propiedad del deal (`calasign_status` u otra) y **PDF firmado** subido a Files (`/CalaSign`) + **nota** asociada al deal con el adjunto. |
| **Salesforce** | CRM | OAuth web server flow **con PKCE S256** | Desde una **Opportunity**: contactos de `OpportunityContactRole` (por rol o el principal) + campos de la oportunidad. | Estado en un campo (`CalaSign_Status__c` u otro) y **ContentVersion** con el PDF, publicado en la oportunidad (`FirstPublishLocationId`). |
| **Siigo** (CO) | ERP | Usuario de API + access key | — | Busca el **cliente** por la identificación de un firmante y agrega la referencia del documento firmado a `comments`. |
| **Alegra** | ERP | Correo + token (Basic) | — | Busca el **contacto** por identificación y le adjunta el PDF; también se puede vincular una **factura** con `POST /v1/crm/links` y se le adjunta el PDF. |
| **Pipedrive** | CRM | OAuth (app del Marketplace); se guarda el `api_domain` de la compañía | Desde un **Deal** (`deal`): la persona del deal es el contacto principal (contacto 0) y los **participantes** siguen en orden; o desde una **Person** (`contact`). Campos del registro, también **personalizados** por su key hash (40 caracteres) o por su nombre; los de opción única se leen como su etiqueta. También con la acción **Enviar a firmar con CalaSign** de la app (`integrations/connectors/pipedrive/`). | Estado en un **campo del deal** (o de la persona): texto, o opción única (se busca la opción por su etiqueta y se escribe su id). **PDF firmado** con la Files API (`deal_id` / `person_id`) y una **nota** con el SHA-256 y el link al sobre. |

Piezas comunes:

- **Mapeos** (`/v1/crm/mappings`): tipo de registro, plantilla, destinatarios por rol (contacto por orden, contacto con
  rol / principal, propiedades del registro o datos fijos; canales email/WhatsApp), prellenado campo ← propiedad, qué
  devolver (propiedad de estado, valores por estado, adjuntar PDF), disparo (`manual`, `webhook`, `on_completion`).
- **Vínculo** sobre ↔ registro (`crm_links`): lo crea el envío desde un registro, la búsqueda en el ERP o
  `POST /v1/crm/links`. Cada evento del sobre (enviado, completado, rechazado, anulado, vencido) encola un write-back.
- **Actividad** (`/v1/crm/runs`): cada envío, write-back y búsqueda queda registrado con intentos y error. Los errores
  transitorios se reintentan con el backoff de la cola; un **token revocado** o datos que no cierran no se reintentan
  solos (quedan como fallidos con el error visible, también en la conexión) y se reintentan a mano
  (`POST /v1/crm/runs/:id/retry`). Un envío manual fallido se rehace desde el registro.
- Tokens cifrados en la base; OAuth con refresh automático (por vencimiento y ante un 401); Siigo renueva su token
  de 24 h solo.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | App pública de HubSpot (OAuth + firma de webhooks). Sin ellas solo se puede conectar con token de app privada y el webhook responde 503. |
| `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | Connected App de Salesforce (OAuth con PKCE). |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` (por defecto) o `https://test.salesforce.com` para sandboxes. |
| `SIIGO_PARTNER_ID` | Nombre de la aplicación que Siigo exige en el header `Partner-Id` (por defecto `CalaSign`). |
| `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET` | App de Pipedrive (Developer Hub → OAuth & access scopes). Sin ellas la tarjeta de Pipedrive muestra "OAuth no configurado" (Pipedrive no se conecta por token). |
| `HUBSPOT_API_BASE`, `HUBSPOT_AUTHORIZE_URL`, `SIIGO_API_BASE`, `ALEGRA_API_BASE`, `PIPEDRIVE_OAUTH_BASE` | Solo para pruebas (simuladores). |

Sin credenciales OAuth, la tarjeta del proveedor muestra "OAuth no configurado"; los conectores por token funcionan igual.

### URIs a registrar en cada proveedor

- HubSpot → *Auth → Redirect URL*: `{APP_URL}/v1/crm/oauth/hubspot/callback`.
  Scopes: `crm.objects.deals.read crm.objects.deals.write crm.objects.contacts.read files oauth`.
  Webhooks → *Target URL*: `{APP_URL}/v1/integrations/crm/hubspot/webhook`, suscripción `deal.propertyChange` a la
  propiedad que dispara el envío.
- Salesforce → Connected App, *Callback URL*: `{APP_URL}/v1/crm/oauth/salesforce/callback`, scopes `api` y
  `refresh_token`, "Require PKCE" activado.
- Siigo y Alegra: no usan redirect (token).
- Pipedrive → Developer Hub, app pública, *OAuth & access scopes*: Callback URL
  `{APP_URL}/v1/crm/oauth/pipedrive/callback`; scopes `base`, `deals:full`, `contacts:full`, `users:read`.
  *App extensions → Link actions*: «Enviar a firmar con CalaSign» → `{APP_URL}/integrations/connectors/pipedrive/send.html`
  en Deal details/list y Person details/list. Guía completa y textos para el Marketplace:
  `integrations/connectors/pipedrive/README.md`. Una instalación iniciada desde el Marketplace vuelve al callback sin
  `state`: no se canjea el código (ataría una cuenta que nadie eligió desde CalaSign) y se lleva al usuario a
  Ajustes → CRM y ERP para conectar.

En dev: `https://dev.calasign.com/v1/crm/oauth/{hubspot|salesforce|pipedrive}/callback`.

## Supuestos tomados de la documentación pública (verificar contra la cuenta real)

- **HubSpot:** CRM v3 (`/crm/v3/objects/deals/{id}?associations=contacts`, `contacts/batch/read`, `PATCH` del deal),
  Files v3 (`POST /files/v3/files` multipart con `folderPath` y `options`), notes con `hs_attachment_ids` y asociación
  nota→deal `associationTypeId 214`, info del token en `/oauth/v1/access-tokens/{token}` (`hub_id` = portal), firma de
  webhooks v3 (`base64(HMAC-SHA256(client secret, método + URI + cuerpo + timestamp))`, timestamp ≤ 5 min). La
  propiedad de estado tiene que existir en el portal (crearla como texto o enumeración).
- **Salesforce:** REST `v60.0`, SOQL sobre `OpportunityContactRole`, `ContentVersion` con `FirstPublishLocationId`.
  Salesforce no informa vencimiento del access token: se refresca ante `401 INVALID_SESSION_ID`. El `instance_url` se
  valida contra `*.salesforce.com`, `*.force.com` y `*.salesforce-setup.com`. El campo de estado (`CalaSign_Status__c`)
  hay que crearlo en la oportunidad.
- **Siigo:** `POST /auth` con `username` + `access_key` y header `Partner-Id`; `GET /v1/customers?identification=`;
  `GET`/`PUT /v1/customers/{id}`. No hay endpoint de adjuntos: se agrega una línea a `comments` conservando lo que
  había (se envía el objeto completo leído, sin `id` ni `metadata`). Confirmar con la cuenta que `PUT` acepta ese cuerpo.
- **Alegra:** API v1 con Basic `email:token`; `GET /contacts?identification=`; adjuntos con
  `POST /invoices/{id}/attachment` y `POST /contacts/{id}/attachment` (multipart `file`).
- **Pipedrive** (`crm/pipedrive.ts`): OAuth en `oauth.pipedrive.com` (`/oauth/authorize` sin `scope`, los scopes salen
  de la app; `/oauth/token` con `Authorization: Basic client_id:client_secret`). El token trae `api_domain`
  (`https://<compañía>.pipedrive.com`), que se valida contra `*.pipedrive.com` (un solo nivel, https) y se guarda en
  la conexión; vence en ~1 h y se refresca por vencimiento y ante un 401. API v1 (`{ success, data }`):
  `GET /api/v1/deals/{id}` (`person_id`, `org_id` y `user_id` expandidos, con `value` = id),
  `GET /api/v1/deals/{id}/participants` (también con `related_objects.person`), `GET /api/v1/persons/{id}`,
  `GET /api/v1/dealFields` / `personFields` (solo si el mapeo pide un campo personalizado o por nombre),
  `PUT /api/v1/deals/{id}` con `{ <key>: valor }`, `POST /api/v1/files` (multipart `file` + `deal_id` / `person_id`),
  `POST /api/v1/notes` (`content` HTML + `deal_id` / `person_id`) y `GET /api/v1/users/me` (etiqueta
  `<company_domain>.pipedrive.com`, `companyId` en la config). Un campo de estado inexistente o una opción que no existe
  en un campo de opción única es un error del mapeo (no se reintenta solo). Verificar con una cuenta sandbox que
  `deals:full` alcance para archivos y notas del deal.
- **Acción de Pipedrive** (`integrations/connectors/pipedrive/send.html`): Link action que Pipedrive abre en una
  pestaña nueva con `resource` y `selectedIds`; usa la sesión de CalaSign del navegador (sin API keys), lista
  `GET /v1/crm/mappings?provider=pipedrive` (alcanza con `envelopes:create`) y llama a
  `POST /v1/crm/mappings/{id}/send` por registro (máximo 20).

## Pruebas

`node scripts/e2e-crm.mjs` levanta simuladores de los cinco proveedores y su propia API en el puerto 4115 (no usa la
API que esté corriendo). Cubre: OAuth de HubSpot y Salesforce (PKCE verificado por el simulador), envío desde un deal y
una oportunidad con contactos y prellenado, write-back de estado, refresh por vencimiento y por 401, PDF adjunto
(Files + nota, ContentVersion), webhook firmado (firma inválida, eventos repetidos), ERP con búsqueda por
identificación y reintento tras un 500, vínculo manual a una factura con credenciales rechazadas y reintento manual,
y token revocado → `409 crm_reauth_required`. Pipedrive: OAuth con Basic y `api_domain`, instalación desde el
Marketplace sin `state`, envío desde un deal (persona principal + participante), write-back en un campo de opción
única, refresh ante 401, PDF por Files API + nota con hash y link, envío desde una Person y registro inexistente → 404.
Unitarias: `apps/api/test/crm-mapping.test.ts` (mapeo) y `apps/api/test/crm-pipedrive.test.ts` (Pipedrive con un
`fetch` falso). La acción del Marketplace se prueba en `integrations/test/connectors.mjs`.
