# CRM y ERP (Fase 6)

Conectores por organización para enviar a firmar desde un CRM y devolver el resultado, y para dejar el documento
firmado en el ERP. Código: `apps/api/src/modules/crm/` (`providers.ts` clientes HTTP, `mapping.ts` mapeo puro,
`index.ts` rutas y trabajos). Web: Ajustes → **CRM y ERP** (`/app/settings/crm`). Migraciones `0015_crm.sql` y
`0046_crm_zoho.sql` (agrega `zoho` a los proveedores).

## Qué hace

| Proveedor | Tipo | Conexión | Desde el registro | Al completarse |
|---|---|---|---|---|
| **HubSpot** | CRM | OAuth (app pública) o token de app privada | "Enviar a firmar" desde un **Deal**: contactos asociados + propiedades del deal → plantilla. También por **webhook** cuando cambia una propiedad (ej. `dealstage = contractsent`). | Estado en una propiedad del deal (`calasign_status` u otra) y **PDF firmado** subido a Files (`/CalaSign`) + **nota** asociada al deal con el adjunto. |
| **Salesforce** | CRM | OAuth web server flow **con PKCE S256** | Desde una **Opportunity**: contactos de `OpportunityContactRole` (por rol o el principal) + campos de la oportunidad. | Estado en un campo (`CalaSign_Status__c` u otro) y **ContentVersion** con el PDF, publicado en la oportunidad (`FirstPublishLocationId`). |
| **Zoho CRM** / **Bigin** | CRM | OAuth 2.0 **con PKCE S256**, multi-DC (com, eu, in, com.au, jp, ca, sa, uk, com.cn). Se elige el producto (CRM o Bigin) al conectar | Desde un **Deal** (contacto principal `Contact_Name` + `Contact_Roles` por rol) o un **Contact** (el propio contacto). En Bigin, desde un **Pipeline** (contacto principal) o un Contact. Botón «Enviar a firmar con CalaSign» en Deals con la extensión de `integrations/connectors/zoho-crm/`. | Estado en un campo (`CalaSign_Status` u otro, con `trigger: []` para no disparar reglas de flujo) y **PDF firmado** como adjunto del registro (`/Attachments`) + **nota** con hash y enlace (`/Notes`, `Parent_Id`). |
| **Siigo** (CO) | ERP | Usuario de API + access key | — | Busca el **cliente** por la identificación de un firmante y agrega la referencia del documento firmado a `comments`. |
| **Alegra** | ERP | Correo + token (Basic) | — | Busca el **contacto** por identificación y le adjunta el PDF; también se puede vincular una **factura** con `POST /v1/crm/links` y se le adjunta el PDF. |

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
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | Cliente *Server-based Application* de Zoho (api-console.zoho.com) con **multi-DC** activado. Sirve para Zoho CRM y Bigin. Sin ellas la tarjeta de Zoho muestra "OAuth no configurado" (Zoho no tiene conexión por token). |
| `ZOHO_SCOPE`, `ZOHO_BIGIN_SCOPE` | Opcionales: reemplazan los scopes por defecto (`ZohoCRM.modules.ALL,ZohoCRM.org.READ,ZohoCRM.users.READ` y `ZohoBigin.modules.ALL,ZohoBigin.org.READ,ZohoBigin.users.READ`), p. ej. para pedir solo `ZohoCRM.modules.deals.ALL,ZohoCRM.modules.contacts.READ,…`. |
| `ZOHO_OAUTH_PKCE` | `false` apaga PKCE en el authorize de Zoho (por defecto encendido). |
| `SIIGO_PARTNER_ID` | Nombre de la aplicación que Siigo exige en el header `Partner-Id` (por defecto `CalaSign`). |
| `HUBSPOT_API_BASE`, `HUBSPOT_AUTHORIZE_URL`, `SIIGO_API_BASE`, `ALEGRA_API_BASE`, `ZOHO_ACCOUNTS_URL` | Solo para pruebas (simuladores). |

Sin credenciales OAuth, la tarjeta del proveedor muestra "OAuth no configurado"; los conectores por token funcionan igual.

### URIs a registrar en cada proveedor

- HubSpot → *Auth → Redirect URL*: `{APP_URL}/v1/crm/oauth/hubspot/callback`.
  Scopes: `crm.objects.deals.read crm.objects.deals.write crm.objects.contacts.read files oauth`.
  Webhooks → *Target URL*: `{APP_URL}/v1/integrations/crm/hubspot/webhook`, suscripción `deal.propertyChange` a la
  propiedad que dispara el envío.
- Salesforce → Connected App, *Callback URL*: `{APP_URL}/v1/crm/oauth/salesforce/callback`, scopes `api` y
  `refresh_token`, "Require PKCE" activado.
- Zoho → [api-console.zoho.com](https://api-console.zoho.com) → *Add Client* → **Server-based Applications**:
  *Homepage URL* `{APP_URL}`, *Authorized Redirect URIs* `{APP_URL}/v1/crm/oauth/zoho/callback`. En *Settings* del
  cliente, activar **Multi-DC** (y los centros de datos que se quieran atender: US, EU, IN, AU, JP, CA, SA, UK, CN):
  sin eso las cuentas de fuera de zoho.com reciben `invalid_client`. El mismo cliente sirve para Zoho CRM y Bigin.
- Siigo y Alegra: no usan redirect (token).

En dev: `https://dev.calasign.com/v1/crm/oauth/{hubspot|salesforce|zoho}/callback`.

### Zoho: centros de datos

Cada cuenta de Zoho vive en un centro de datos. El usuario elige uno en la tarjeta (por defecto `zoho.com`); si su
cuenta está en otro, Zoho lo redirige y el callback trae `accounts-server` (p. ej. `https://accounts.zoho.eu`). El
código se canjea **ahí** y el token trae `api_domain` (p. ej. `https://www.zohoapis.eu`): los dos se validan contra los
dominios de Zoho (`accounts.zoho.<tld>`, `accounts.zohocloud.ca`, `www.zohoapis.<tld>`; solo https) y se guardan en
`config` de la conexión (`accountsServer`, `apiDomain`, `product`). El refresh va siempre al `accountsServer` guardado.

### Extensión de Zoho Marketplace

`integrations/connectors/zoho-crm/` (se publica en `/integrations/connectors/zoho-crm/`): botón **«Enviar a firmar con
CalaSign»** en Deals con una función Deluge que llama a `POST /v1/crm/mappings/{id}/send` con el id del Deal, más el
campo `CalaSign_Status` y una *connection* de Zoho que guarda la API key. Ver el README de la carpeta para instalarla
en una organización (sin publicar) y para empaquetarla y publicarla en Zoho Marketplace.

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
- **Zoho CRM:** API `v7` con header `Authorization: Zoho-oauthtoken …`; `GET /crm/v7/org` (etiqueta = `company_name`);
  `GET /crm/v7/{Deals|Contacts}/{id}` (204 sin cuerpo si no existe → `404 crm_record_not_found`); contacto principal por
  el lookup `Contact_Name` y roles con `GET /crm/v7/Deals/{id}/Contact_Roles?fields=…` (`Contact_Role.name`; si la
  lista no está disponible —400/403/404— alcanza con el principal); estado con
  `PUT /crm/v7/{módulo}/{id}` `{ data: [{ campo: valor }], trigger: [] }` (un `status: "error"` en `data[0]` se informa
  como error); PDF con `POST /crm/v7/{módulo}/{id}/Attachments` (multipart `file`, hasta 20 MB) y nota con
  `POST /crm/v7/Notes` `{ Note_Title, Note_Content, Parent_Id: { module: { api_name }, id } }` (si la nota falla, el
  adjunto queda igual). Token: `POST {accounts}/oauth/v2/token` (los errores vienen con HTTP 200 y `error`, p. ej.
  `invalid_code` → reconectar); el refresh no devuelve refresh token nuevo; el access token dura 1 h. El campo de
  estado (`CalaSign_Status`, texto o lista) hay que crearlo en el módulo.
- **Bigin:** igual que Zoho CRM sobre `/bigin/v2` con el módulo `Pipelines` para los negocios (sin `Contact_Roles`) y
  scopes `ZohoBigin.*`. Verificar con una cuenta real el formato de `Parent_Id` de notas en Bigin.

## Pruebas

`node scripts/e2e-crm.mjs` levanta simuladores de los cinco proveedores y su propia API en el puerto 4115 (no usa la
API que esté corriendo). Cubre: OAuth de HubSpot, Salesforce y Zoho (PKCE verificado por el simulador), envío desde un
deal y una oportunidad con contactos y prellenado, write-back de estado, refresh por vencimiento y por 401, PDF adjunto
(Files + nota, ContentVersion, Attachments + Notes de Zoho), webhook firmado (firma inválida, eventos repetidos), ERP
con búsqueda por identificación y reintento tras un 500, vínculo manual a una factura con credenciales rechazadas y
reintento manual, y token revocado → `409 crm_reauth_required`. En Zoho, además: OAuth iniciado en `zoho.com` con la
cuenta en otro centro de datos (el código solo se canjea en el `accounts-server` del callback), roles de contacto,
envío desde un Contact, error `INVALID_DATA` visible en la actividad, Deal inexistente → 404 y Bigin (`/bigin/v2`,
Pipelines). Unitarias: `apps/api/test/crm-mapping.test.ts` (mapeo) y `apps/api/test/crm-zoho.test.ts` (Zoho con un
fetch falso: dominios aceptados, refresh en el DC de la cuenta, registros, write-back y adjuntos).
