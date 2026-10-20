# CRM y ERP (Fase 6)

Conectores por organización (HubSpot, Salesforce, Zoho CRM / Bigin, Pipedrive, RD Station CRM, Kommo, Siigo, Alegra)
para enviar a firmar desde un CRM y devolver el resultado, y para dejar el documento firmado en el ERP. Código:
`apps/api/src/modules/crm/` (`providers.ts` clientes HTTP y despacho, `mapping.ts` mapeo puro, `index.ts` rutas y
trabajos, `pipedrive.ts`, `rdstation.ts` y `kommo.ts` un cliente por proveedor). Web: Ajustes → **CRM y ERP**
(`/app/settings/crm`). Migraciones `0015_crm.sql`, `0046_crm_zoho.sql` (agrega `zoho` a los proveedores),
`0047_crm_pipedrive.sql` (redefine el CHECK de proveedor con `zoho` y `pipedrive`) y `0051_crm_rdstation_kommo.sql`
(redefine el CHECK con todos: `hubspot`, `salesforce`, `siigo`, `alegra`, `zoho`, `pipedrive`, `rdstation`, `kommo`).

## Qué hace

| Proveedor | Tipo | Conexión | Desde el registro | Al completarse |
|---|---|---|---|---|
| **HubSpot** | CRM | OAuth (app pública) o token de app privada | "Enviar a firmar" desde un **Deal**: contactos asociados + propiedades del deal → plantilla. También por **webhook** cuando cambia una propiedad (ej. `dealstage = contractsent`). | Estado en una propiedad del deal (`calasign_status` u otra) y **PDF firmado** subido a Files (`/CalaSign`) + **nota** asociada al deal con el adjunto. |
| **Salesforce** | CRM | OAuth web server flow **con PKCE S256** | Desde una **Opportunity**: contactos de `OpportunityContactRole` (por rol o el principal) + campos de la oportunidad. | Estado en un campo (`CalaSign_Status__c` u otro) y **ContentVersion** con el PDF, publicado en la oportunidad (`FirstPublishLocationId`). |
| **Zoho CRM** / **Bigin** | CRM | OAuth 2.0 **con PKCE S256**, multi-DC (com, eu, in, com.au, jp, ca, sa, uk, com.cn). Se elige el producto (CRM o Bigin) al conectar | Desde un **Deal** (contacto principal `Contact_Name` + `Contact_Roles` por rol) o un **Contact** (el propio contacto). En Bigin, desde un **Pipeline** (contacto principal) o un Contact. Botón «Enviar a firmar con CalaSign» en Deals con la extensión de `integrations/connectors/zoho-crm/`. | Estado en un campo (`CalaSign_Status` u otro, con `trigger: []` para no disparar reglas de flujo) y **PDF firmado** como adjunto del registro (`/Attachments`) + **nota** con hash y enlace (`/Notes`, `Parent_Id`). |
| **Siigo** (CO) | ERP | Usuario de API + access key | — | Busca el **cliente** por la identificación de un firmante y agrega la referencia del documento firmado a `comments`. |
| **Alegra** | ERP | Correo + token (Basic) | — | Busca el **contacto** por identificación y le adjunta el PDF; también se puede vincular una **factura** con `POST /v1/crm/links` y se le adjunta el PDF. |
| **RD Station CRM** (BR) | CRM | OAuth 2.0 de la **RD Station App Store** (API v2 del CRM; sin PKCE documentado) | Desde una **Negociação** (`deal`): sus **contatos** en el orden de `contact_ids` (el primero es el principal, contacto 0). Campos de la negociação y **personalizados** por su `slug` o por su nombre. | Estado en un **campo personalizado** de la negociação (texto, u opción: se valida contra las opciones del campo). **PDF firmado** en los **Anexos** (`POST /deals/{id}/files`) + **anotação** con el SHA-256 y el link (`POST /deals/{id}/notes`). |
| **Kommo** (ex amoCRM) | CRM | OAuth 2.0 **por cuenta**: el token se pide al subdominio (`<cuenta>.kommo.com`) que vuelve en `referer`; refresh token que rota | Desde un **Lead** (`deal`): el **contacto principal** del lead (contacto 0) y los demás en orden. Campos del lead y **personalizados** por nombre, código o id (los de lista se leen como texto). Botón «Enviar a firmar con CalaSign» con el widget de `integrations/connectors/kommo/`. | Estado en un **campo del lead** (texto, o lista: se busca la opción y se escribe su `enum_id`). **PDF firmado** al drive de la cuenta (Files API: sesión + partes) **vinculado al lead**, más una **nota** con el SHA-256 y el link. Sin el permiso «Access to files», solo la nota. |
| **Pipedrive** | CRM | OAuth (app del Marketplace); se guarda el `api_domain` de la compañía | Desde un **Deal** (`deal`): la persona del deal es el contacto principal (contacto 0) y los **participantes** siguen en orden; o desde una **Person** (`contact`). Campos del registro, también **personalizados** por su key hash (40 caracteres) o por su nombre; los de opción única se leen como su etiqueta. También con la acción **Enviar a firmar con CalaSign** de la app (`integrations/connectors/pipedrive/`). | Estado en un **campo del deal** (o de la persona): texto, o opción única (se busca la opción por su etiqueta y se escribe su id). **PDF firmado** con la Files API (`deal_id` / `person_id`) y una **nota** con el SHA-256 y el link al sobre. |

Piezas comunes:

- **Mapeos** (`/v1/crm/mappings`): tipo de registro, plantilla, destinatarios por rol (contacto por orden, contacto con
  rol / principal, propiedades del registro o datos fijos; canales email/WhatsApp), prellenado campo ← propiedad, qué
  devolver (propiedad de estado, valores por estado, adjuntar PDF), disparo (`manual`, `webhook`, `on_completion`).
- **Vínculo** sobre ↔ registro (`crm_links`): lo crea el envío desde un registro, la búsqueda en el ERP o
  `POST /v1/crm/links`. La búsqueda por identificación usa el documento de los firmantes que **firmaron** (no el de
  quien delegó o fue reemplazado: el contrato terminaba en el registro de alguien que no lo firmó). Cada evento del sobre (enviado, completado, rechazado, anulado, vencido) encola un write-back.
  Los write-backs de un vínculo pueden correr en paralelo: un compare-and-set del rango sobre `crm_links.last_status`
  (`sent` < estados finales) hace que un `sent` nunca pise un estado final, y si otro trabajo reclamó un estado final
  mientras se escribía `sent`, se reescribe el final (`apps/api/test/crm-writeback-race.test.ts`).
- **Write-back que falla para siempre:** si la escritura del estado falla de forma definitiva (error permanente o
  último intento de la cola), `last_status` vuelve al valor de antes del primer reclamo, solo si nadie lo cambió.
  La ejecución lo registra en `detail.lastStatusRestored`. Lo mismo vale para los conectores de RR. HH./CLM.
- **Varias cuentas del mismo CRM** (Pipedrive, Kommo): la acción y el widget mandan la cuenta desde la que se abrieron
  (`companyId`). `GET /v1/crm/mappings?provider=…&companyId=` lista solo los mapeos de las conexiones de esa cuenta
  (`config.companyId` de Pipedrive, sacado de `/users/me`; `config.accountId` de Kommo, sacado de `/api/v4/account`).
  `POST /v1/crm/mappings/{id}/send` con otra cuenta responde 409 `company_mismatch`; si no, se leería el registro con el
  mismo id en la cuenta equivocada. El envío acepta `Idempotency-Key`.
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
| `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET` | App de Pipedrive (Developer Hub → OAuth & access scopes). Sin ellas la tarjeta de Pipedrive muestra "OAuth no configurado" (Pipedrive no se conecta por token). |
| `RDSTATION_CLIENT_ID`, `RDSTATION_CLIENT_SECRET` | App de la RD Station App Store (OAuth del CRM v2). Sin ellas la tarjeta muestra "OAuth no configurado". |
| `RDSTATION_OAUTH_PKCE` | `true` agrega PKCE S256 al authorize de RD Station (por defecto apagado: RD no lo documenta). |
| `KOMMO_CLIENT_ID`, `KOMMO_CLIENT_SECRET` | ID y clave secreta de la integración de Kommo (Ajustes → Integraciones). Sin ellas la tarjeta muestra "OAuth no configurado". |
| `HUBSPOT_API_BASE`, `HUBSPOT_AUTHORIZE_URL`, `SIIGO_API_BASE`, `ALEGRA_API_BASE`, `ZOHO_ACCOUNTS_URL`, `PIPEDRIVE_OAUTH_BASE`, `RDSTATION_API_BASE`, `RDSTATION_AUTHORIZE_URL`, `KOMMO_AUTHORIZE_URL` | Solo para pruebas (simuladores). |

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
- Pipedrive → Developer Hub, app pública, *OAuth & access scopes*: Callback URL
  `{APP_URL}/v1/crm/oauth/pipedrive/callback`; scopes `base`, `deals:full`, `contacts:full`, `users:read`.
  *App extensions → Link actions*: «Enviar a firmar con CalaSign» → `{APP_URL}/integrations/connectors/pipedrive/send.html`
  en Deal details/list y Person details/list. Guía completa y textos para el Marketplace:
  `integrations/connectors/pipedrive/README.md`. Una instalación iniciada desde el Marketplace vuelve al callback sin
  `state`: no se canjea el código (ataría una cuenta que nadie eligió desde CalaSign) y se lleva al usuario a
  Ajustes → CRM y ERP para conectar.

- RD Station CRM → [RD Station App Store, área de publisher](https://appstore.rdstation.com/pt-BR/publisher):
  crear el app y sus credenciales (`client_id`, `client_secret`) con la URL de callback
  `{APP_URL}/v1/crm/oauth/rdstation/callback`. El authorize es `https://accounts.rdstation.com/oauth/authorize`.
- Kommo → en una cuenta de Kommo, **Ajustes → Integraciones → Crear integración**: *Redirect URL*
  `{APP_URL}/v1/crm/oauth/kommo/callback`, permisos **CRM** y **Access to files**. El *ID de integración* y la *clave
  secreta* van a `KOMMO_CLIENT_ID` / `KOMMO_CLIENT_SECRET`. En la misma integración se sube el widget
  (`integrations/connectors/kommo/calasign-kommo-widget.zip`, ver su README). Como en Pipedrive, una instalación hecha
  desde Kommo vuelve sin `state`: no se canjea y se lleva al usuario a Ajustes → CRM y ERP (`kommo_install=1`).

En dev: `https://dev.calasign.com/v1/crm/oauth/{hubspot|salesforce|zoho|pipedrive|rdstation|kommo}/callback`.

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
- **RD Station CRM** (`crm/rdstation.ts`): se eligió la **API v2** (`https://api.rd.services/crm/v2`), la vigente en
  2026: la v1 (`crm.rdstation.com/api/v1`) se autentica con el token del usuario en la URL y no tiene adjuntos; la v2
  tiene OAuth de la App Store, archivos y anotações. OAuth: authorize en `accounts.rdstation.com/oauth/authorize`
  (`response_type=code`, `client_id`, `redirect_uri`; se manda `state` y **se asume que RD lo devuelve**), token en
  `POST https://api.rd.services/oauth2/token` (form con `client_id`, `client_secret`, `code`/`refresh_token`,
  `redirect_uri`, `grant_type`). El access token dura 2 h; cada refresh devuelve un refresh token nuevo (se guarda).
  Se asume `Authorization: Bearer`. API: respuestas `{ data }`, errores `{ errors: [{ detail }] }`, ids de 24 hex
  (otro id → 404 sin llamar a RD). `GET /deals/{id}` (`contact_ids`, `custom_fields` = `{ slug: valor }`),
  `GET /contacts/{id}` (`emails[].email`, `phones[]` con `type` — se prefiere `mobile`), `GET /custom_fields?filter=entity:deal`
  (solo para escribir el estado o si el mapeo pide un campo por nombre), `PUT /deals/{id}` con
  `{ data: { custom_fields: { slug: valor } } }` (**verificar** que un `custom_fields` parcial no borre los demás),
  `POST /deals/{id}/files` (multipart, campo `data[file]`) y `POST /deals/{id}/notes` `{ data: { description } }` (si
  la anotação falla, el PDF queda igual). `GET /users` para probar la conexión (la v2 no tiene "yo": la etiqueta es el
  dominio del correo del primer usuario). Límite: 120 pedidos/min (429 → reintento de la cola). La base es fija: no hay
  URL del proveedor que validar. Sin dominio por cuenta.
- **Kommo** (`crm/kommo.ts`): OAuth con authorize global `https://www.kommo.com/oauth?client_id…&state…&mode=post_message`
  (la vuelta es en la misma ventana); el callback trae `code`, `state` y `referer` (host de la cuenta). El `referer` se
  valida (`<subdominio>.kommo.com` o `<subdominio>.amocrm.com` de cuentas viejas, un solo nivel, https, sin puerto ni
  credenciales, ni `www`/`drive-*`) **antes** de mandarle el client secret, y se guarda en `config.baseDomain`. Token:
  `POST https://<cuenta>.kommo.com/oauth2/access_token` con **JSON** (`client_id`, `client_secret`, `grant_type`,
  `code`/`refresh_token`, `redirect_uri` también en el refresh); access token de 24 h, refresh de 3 meses que rota. API
  v4: `GET /api/v4/leads/{id}?with=contacts` (204 sin cuerpo = no existe → 404; ids no numéricos → 404),
  `GET /api/v4/contacts?filter[id][]=…` (correo y teléfono de los `custom_fields_values` con `field_code` `EMAIL` /
  `PHONE`, se prefiere `WORK` y `MOB`), `GET /api/v4/leads/custom_fields`, `PATCH /api/v4/leads/{id}` con
  `custom_fields_values: [{ field_id, values: [{ value }] | [{ enum_id }] }]`, `POST /api/v4/leads/notes`
  `[{ entity_id, note_type: "common", params: { text } }]`. Files API: `GET /api/v4/account?with=drive_url`, el
  `drive_url` se valida (`drive-<x>.kommo.com`, https) y cada URL de subida tiene que ser del **mismo** drive;
  `POST {drive}/v1.0/sessions` `{ file_name, file_size, content_type }`, partes en crudo a `upload_url` / `next_url`
  (la última devuelve `uuid`), `PUT /api/v4/leads/{id}/files` `[{ file_uuid }]`. Un 403/404 del drive (sin el permiso
  «Access to files» o sin drive) deja solo la nota; **verificar** con una cuenta real si las partes llevan el Bearer y
  el formato exacto de `PUT …/files`.
- **Acción de Pipedrive** (`integrations/connectors/pipedrive/send.html`): Link action que Pipedrive abre en una
  pestaña nueva con `resource` y `selectedIds`; usa la sesión de CalaSign del navegador (sin API keys), lista
  `GET /v1/crm/mappings?provider=pipedrive` (alcanza con `envelopes:create`) y llama a
  `POST /v1/crm/mappings/{id}/send` por registro (máximo 20).
- **Widget de Kommo** (`integrations/connectors/kommo/`): `manifest.json` (interface_version 2, `lcard-1`, `llist-1`),
  `script.js` (botón en el panel de la ficha del lead con `APP.data.current_card.id`; en la lista, `leads.selected`) que
  abre `send.html?ids=…` del dominio de CalaSign con la sesión del navegador (`GET /v1/crm/mappings?provider=kommo`).
  Verificar los tamaños de las imágenes que pide el validador de Kommo.

## Pruebas

`node scripts/e2e-crm.mjs` levanta simuladores de todos los proveedores y su propia API en el puerto 4115 (no usa la
API que esté corriendo). Cubre: OAuth de HubSpot, Salesforce y Zoho (PKCE verificado por el simulador), envío desde un
deal y una oportunidad con contactos y prellenado, write-back de estado, refresh por vencimiento y por 401, PDF adjunto
(Files + nota, ContentVersion, Attachments + Notes de Zoho), webhook firmado (firma inválida, eventos repetidos), ERP
con búsqueda por identificación y reintento tras un 500, vínculo manual a una factura con credenciales rechazadas y
reintento manual, y token revocado → `409 crm_reauth_required`. En Zoho, además: OAuth iniciado en `zoho.com` con la
cuenta en otro centro de datos (el código solo se canjea en el `accounts-server` del callback), roles de contacto,
envío desde un Contact, error `INVALID_DATA` visible en la actividad, Deal inexistente → 404 y Bigin (`/bigin/v2`,
Pipelines). En Pipedrive: OAuth con Basic y `api_domain`, instalación desde el Marketplace sin `state`, envío desde un
deal (persona principal + participante), write-back en un campo de opción única, refresh ante 401, PDF por Files API +
nota con hash y link, filtro `?provider=pipedrive`, envío desde una Person y registro inexistente → 404. En RD Station
CRM: OAuth sin PKCE, envío desde una negociação (contatos en orden), write-back en un campo de opción, refresh ante 401
con el refresh token rotado guardado, PDF en Anexos (`data[file]`) + anotação, ids inválidos → 404. En Kommo: OAuth con
`referer` (token en el subdominio, JSON), instalación sin `state`, `referer` ajeno rechazado sin pedir token, envío
desde un lead (contacto principal primero), campo de lista (`enum_id`), refresh, PDF por la Files API vinculado al lead
+ nota, lead inexistente (204) → 404.
Unitarias: `apps/api/test/crm-mapping.test.ts` (mapeo), `apps/api/test/crm-zoho.test.ts` (Zoho con un fetch falso:
dominios aceptados, refresh en el DC de la cuenta, registros, write-back y adjuntos) y
`apps/api/test/crm-pipedrive.test.ts` (Pipedrive con un fetch falso), `apps/api/test/crm-rdstation.test.ts` y
`apps/api/test/crm-kommo.test.ts` (RD Station y Kommo con un fetch falso: dominios de Kommo y del drive validados,
refresh, registros, write-back, adjunto en partes, nota). `apps/api/test/crm-writeback-race.test.ts` cubre también a
los dos. El widget de Kommo se prueba en `integrations/test/connectors.mjs`. La acción del Marketplace de Pipedrive se prueba
en `integrations/test/connectors.mjs`.
