# Conectores out-of-the-box

Todo lo que integra CalaSign con herramientas empresariales sin escribir código: qué hay, cómo funciona cada grupo, qué
falta para publicarlo y qué conviene construir después. La documentación pública está en `/developers/connectors`, que
agrupa las guías de cada conector.

## Catálogo actual

| Categoría | Conectores | Tipo | Código | Guía pública |
|---|---|---|---|---|
| Low-code / iPaaS | Power Automate / Logic Apps, Zapier, Make, n8n | Artefacto descargable (se importa en la plataforma) | `integrations/connectors/<id>/` | `/developers/connectors` |
| CRM / ERP | Dynamics 365 (sobre Power Automate) | Artefacto + script de Dataverse | `integrations/connectors/dynamics365/` | `/developers/connectors#dynamics365` |
| CRM / ERP | HubSpot, Salesforce (Opportunity), Zoho CRM y Bigin (Deals, Contacts, Pipelines), Pipedrive (Deal y Person), RD Station CRM (Negociação), Kommo (Lead), Siigo, Alegra | Nativo, se configura en Ajustes | `apps/api/src/modules/crm/` ([CRM.md](CRM.md)) | `/developers/guides/crm` |
| CRM / ERP | Zoho CRM: botón «Enviar a firmar con CalaSign» en Deals (sobre el conector nativo) | Artefacto: función Deluge + guía de la extensión de Zoho Marketplace | `integrations/connectors/zoho-crm/` | `/developers/guides/crm` |
| CRM / ERP | Pipedrive Marketplace: acción «Enviar a firmar con CalaSign» (sobre el conector nativo) | Artefacto (Link action) + guía del Developer Hub | `integrations/connectors/pipedrive/` | `/developers/guides/crm#pipedrive` |
| CRM / ERP | Kommo Marketplace: widget «Enviar a firmar con CalaSign» en Leads (sobre el conector nativo) | Artefacto (zip del widget) + página `send.html` + guía de la integración | `integrations/connectors/kommo/` | `/developers/guides/crm#kommo` |
| RR. HH. | BambooHR, HiBob, Factorial | Nativo | `apps/api/src/modules/connectors/` | `/developers/guides/hr-contracts` |
| Contratos (CLM) | Ironclad, Juro | Nativo | `apps/api/src/modules/connectors/` | `/developers/guides/hr-contracts` |
| Gestores documentales | SharePoint, OneDrive, Google Drive, Dropbox, Box, S3 | Nativo (archivado del firmado + evidencia) | `apps/api/src/modules/storage-export.ts` | `/developers/guides/hr-contracts#dms` |
| Avisos | Slack, Microsoft Teams (Workflows), Discord, Google Chat, Mattermost, Rocket.Chat y Webex (webhooks entrantes); Telegram, WhatsApp/SMS | Nativo | `notify-integrations.ts`, `notify-format.ts`, `telegram.ts` ([sección](#avisos-a-canales-webhooks-entrantes)) | Ajustes → Avisos a canales (`/app/settings/notifications`) |
| IA | MCP, skill de Claude, plugin de Claude Code, MCPB, Gemini CLI, ChatGPT | Artefacto descargable | `integrations/`, `apps/api/src/modules/mcp/` ([MCP-CONECTORES.md](MCP-CONECTORES.md)) | `/developers/ai` |
| Office | Complementos de Word y Outlook | Artefacto descargable | `integrations/office/` | `/integrations/office/` |
| Ofimática (Google) | Add-on de Google Workspace: Gmail, Docs y Drive | Artefacto descargable (proyecto de Apps Script para `clasp push`) | `integrations/connectors/google-workspace/` | `/developers/connectors#google-workspace` |

Los artefactos descargables los arma `integrations/build.mjs` (los conectores low-code, vía
`integrations/connectors/registry.mjs`) y se publican en **`<base>/integrations/...`**; el índice de conectores está en
`<base>/integrations/connectors/index.json`.

<!-- Cada sección es de un grupo de conectores; agregar grupos nuevos como secciones aparte. -->

## Low-code / iPaaS y CRM/ERP (Power Automate, Zapier, Make, n8n, Dynamics 365)

### Ranking investigado (octubre de 2026)

Criterios: base instalada, presencia de los competidores (DocuSign, Adobe Acrobat Sign y Dropbox Sign) en cada
marketplace, peso en los cuatro mercados (RD, HN, CO, BR) y costo de construir y mantener el conector.

| # | Plataforma | Datos | Competidores ahí | Estado en CalaSign |
|---|---|---|---|---|
| 1 | **Power Automate / Logic Apps / Power Apps / Copilot Studio** | Power Platform: 56 M de usuarios activos por mes en 2025 ([EPPC25](https://vladtalkstech.com/power-platform/from-power-platform-to-agent-platform-eppc-2025-recap-reactions/)). Power Automate solo pasaba los 10 M en 2023 ([Thurrott](https://www.thurrott.com/?p=270412)). Más de 1.400 conectores ([MS Learn](https://learn.microsoft.com/en-us/connectors/connector-reference/connector-reference-powerautomate-connectors)). | DocuSign y Adobe Sign con conectores **Standard** (sin licencia Premium). HelloSign/Dropbox Sign **Premium**, con 3 acciones ([DocuSign](https://learn.microsoft.com/en-us/connectors/docusign/), [Adobe](https://learn.microsoft.com/en-us/connectors/adobesign/), [HelloSign](https://learn.microsoft.com/en-us/connectors/hellosign/)). No se encontraron firmadores brasileños (Clicksign, D4Sign) en el catálogo. | **Hecho**: `power-automate` |
| 2 | **Zapier** | Más de 3,4 M de empresas y casi 8.000 apps ([Zapier](https://editor.vercel.zapier.com/press), [Sacra](https://sacra.com/c/zapier/)). Por su catálogo llega a Pipedrive, Zoho, RD Station, Alegra y Siigo. | Los tres. | **Hecho**: `zapier` |
| 3 | **Salesforce** | 20,0 % del mercado CRM, n.º 1 por 13.º año ([IDC 2025](https://www.salesforce.com/news/stories/idc-crm-market-share-ranking-2025/)). | Los tres (AppExchange). | Ya existía: conector nativo en `apps/api/src/modules/crm` ([CRM.md](CRM.md)). Falta el paquete de AppExchange. |
| 4 | **HubSpot** | 288.706 clientes a fin de 2025 ([HubSpot IR](https://ir.hubspot.com/static-files/461e2acd-de5d-46c5-bded-798f6190b42d)). | Adobe solo con Enterprise; Dropbox Sign es la firma nativa de Quotes; DocuSign sin app confirmada. | Ya existía (`crm/`). |
| 5 | **Dynamics 365** (Sales, Customer Service; Business Central, F&O) | 4,0 % del CRM ([IDC](https://www.salesforce.com/news/stories/idc-crm-market-share-ranking-2025/)). Business Central tiene unos 45–50 mil clientes ([MSDW](https://msdynamicsworld.com/story/microsoft-updates-dynamics-365-business-central-customer-count-passing-netsuite)) y canal de partners en CO y Centroamérica. | DocuSign y Adobe tienen solución en AppSource más conector de Power Platform. | **Hecho**: `dynamics365`, sobre el conector de Power Automate |
| 6 | **n8n** | Más de 200 mil usuarios activos y más de 3.000 clientes enterprise ([TechCrunch](https://techcrunch.com/2025/03/24/fair-code-pioneer-n8n-raises-60m-for-ai-powered-workflow-automation)). Serie C con valuación de USD 2.500 M ([Pulse2](https://pulse2.com/n8n-180-million-series-c-at-2-5-billion-valuation-raised-for-expanding-ai-orchestration-platform)). | **Ninguno con nodo oficial**: solo nodos de la comunidad ([foro](https://community.n8n.io/t/docusign-node/8059)). | **Hecho**: `n8n` |
| 7 | **Make** | 3,1 M de usuarios (+68 % en 2024) y más de 2.100 apps ([Make](https://www.make.com/en/blog/2024-automation-wrap-up)). Fuerte en LATAM y España. | DocuSign y Adobe Sign. | **Hecho**: `make` |
| 8 | **Odoo** | Más de 170 mil clientes ([Glorium](https://gloriumtech.com/odoo-statistics/)). Peso en pymes de CO, RD y HN. | Solo módulos de terceros para DocuSign; Odoo Enterprise trae su propio Sign. | Pendiente (módulo para apps.odoo.com) |
| 9 | **TOTVS + RD Station** (BR) | TOTVS tiene el 34 % del ERP brasileño, empatado con SAP ([FGV](https://convergenciadigital.com.br/mercado/sap-e-totvs-esto-empatadas-com-33-do-mercado-nacional-de-erp)). RD Station supera los 60 mil clientes. | Clicksign y D4Sign (locales). | RD Station CRM: **hecho** (conector nativo, `crm/rdstation.ts`). TOTVS: pendiente. |
| 10 | **SAP** (Business One; S/4HANA vía BTP) | 34 % del ERP en Brasil y líder en grandes empresas de CO. | DocuSign solo a través de partners en SAP Store. | Pendiente |
| — | Workato, Boomi (Leaders del Gartner MQ iPaaS 2025), MuleSoft, Tray, Pipedream, Apps Script | Enterprise o de nicho. | DocuSign y Adobe tienen conector en Workato. | Se pueden usar con la API REST y el OpenAPI. Construir conector cuando haya demanda. |
| — | Siigo, Alegra (CO) | Siigo: más de 1,2 M de clientes. Alegra: unos 476 mil usuarios ([GuíaDeSoftware](https://www.guiadesoftware.com/software/siigo)). | — | Ya existía: write-back en `crm/` |

Advertencias sobre los datos:
- Microsoft ya no desglosa usuarios de Power Automate.
- Las posiciones del Gartner MQ 2025 vienen de comunicados de los proveedores.
- Las cifras de Siigo y Alegra salen de guías comerciales.

### Qué hace cada conector

| Conector | Artefacto (`<base>/integrations/connectors/…`) | Triggers | Acciones | Autenticación |
|---|---|---|---|---|
| **Power Automate / Logic Apps / Power Apps / Copilot Studio** | `power-automate/calasign-power-automate-connector.zip`, que trae `apiDefinition.swagger.json` (OpenAPI 2.0), `apiProperties.json`, `apiProperties.oauth.json`, `icon.png`, `readme.md` e `intro.md` | *When an envelope event occurs* (webhook: `x-ms-notification-url`, el 201 trae `Location` y la plataforma borra la suscripción con DELETE ahí) | Enviar desde plantilla (desplegable de plantillas con `x-ms-dynamic-values`, destinatarios por rol y prellenado con `x-ms-dynamic-schema`), estado, descargar PDF firmado, listar sobres y plantillas, borrador + documento (`formData` file) + destinatarios + campos (ancla o coordenadas) + enviar, anular, recordar | API key (`Bearer cs_live_…`). Variante OAuth: ver *Pendiente* |
| **Zapier** | `zapier/calasign-zapier-app.zip` (proyecto Platform CLI, `zapier-platform-core` 19.2.1, Node 22) | REST hooks: Envelope Completed (incluye el PDF firmado como archivo), Envelope Sent, Envelope Declined, Recipient Signed y New Envelope Event (eventos a elección). `performList` usa `GET /v1/webhooks/samples` | Send Envelope From Template (campos dinámicos), Send Document for Signature, Void Envelope, Remind Recipients. Búsqueda: Find Envelope | API key. La key se agrega solo a pedidos a la API de CalaSign, nunca a URLs de archivos de terceros |
| **Make** | `make/calasign-make-app.zip` (contenido de cada pestaña del editor y `makecomapp.json` para la extensión de VS Code) y `make/calasign-make-app.json` | Watch Envelope Events (webhook dedicado con attach/detach) | Send an Envelope from a Template (formulario por `rpc://templateForm`), Send a Document for Signature (6 pedidos encadenados y funciones IML), Get an Envelope, Download the Signed Document, Void an Envelope, Search Envelopes | API key u OAuth 2.0 con PKCE S256 (armado en IML) |
| **n8n** | `n8n/n8n-nodes-calasign-<versión>.tgz` (paquete npm instalable, sin dependencias en runtime) y `n8n/n8n-nodes-calasign-source.zip` | CalaSign Trigger: crea el webhook al activar el workflow y lo borra al desactivarlo. Verifica la firma HMAC `CalaSign-Signature` | CalaSign: Send From Template (roles y campos con `loadOptions`), Send Document (binario), Get, Get Many, Download Signed PDF, Void, Remind; Template Get Many. `usableAsTool` (agentes de n8n) | API key u OAuth2 con PKCE (`grantType: pkce`) |
| **Dynamics 365** | `dynamics365/calasign-dynamics365.zip` | Flujo «CalaSign: sincronizar estado»: evento → `calasign_status` y `calasign_completedon`, y nota con el PDF firmado | Botón **Enviar a firmar** / **Ver en CalaSign** (web resource `calasign_/commands.js`). Flujo «CalaSign: enviar a firmar»: la plantilla va al contacto principal con `metadata.recordId`. `setup-dataverse.mjs` crea la solución, las columnas y el web resource | La conexión del conector de Power Automate. El navegador no guarda credenciales |

La lógica para «enviar un PDF» (crear, subir, destinatarios, un campo de firma por firmante en la última página o en
las anclas `\firma1\`, `\firma2\`…, y enviar) está en `integrations/connectors/_lib/quicksend.cjs`. La comparten
Zapier y n8n; Make la replica con funciones IML. Cuando exista `POST /v1/envelopes` con documentos, destinatarios y
campos en un solo pedido, los conectores pueden pasar a usarlo. Los endpoints actuales siguen sirviendo.

### Cambios de API para los conectores

| Endpoint | Para qué |
|---|---|
| `POST /v1/webhooks` responde con el header **`Location: <appUrl>/v1/webhooks/{id}`** | Triggers de Power Automate y Logic Apps: la plataforma hace DELETE a esa URL al borrar o editar el flujo. |
| `GET /v1/webhooks/samples?event=&limit=` | Eventos de ejemplo con la forma exacta de una entrega. Se arman con los últimos sobres de la organización y, si no hay, uno sintético. Lo usan `performList` de Zapier y los datos de prueba de Make y n8n. |
| `GET /v1/templates/{id}/input-schema` | Roles y campos prellenables de una plantilla, más el JSON Schema (draft-04 con `x-ms-summary`) de `roles` y `prefill`. Alimenta los campos dinámicos de las cuatro plataformas. |
| `POST /v1/envelopes/from-template/{templateId}` | Igual que `/v1/envelopes/from-template`, pero con `roles: { <id o nombre del rol>: { name, email, phone } }` y `prefill: { <id o etiqueta>: valor }`. Ignora los valores vacíos y pasa los números a texto. Envía el sobre salvo que venga `send: false`. |

**Idempotency-Key en los envíos.** Zapier, Make y n8n reintentan la acción entera (timeout, 5xx, ejecuciones
incompletas, *Retry On Fail*). Los tres mandan `Idempotency-Key`: en «Send from template», en una sola llamada; en «Send
document» (`_lib/quicksend.cjs`), como `<clave>:create` y `<clave>:send`, y un reintento que recibe el mismo sobre no
vuelve a subir el PDF ni a enviarlo. La clave es:
- **n8n:** ejecución + nodo + item (`$execution.id`, id del nodo, `itemIndex`).
- **Zapier y Make:** no exponen un id de ejecución, así que la clave es el Zap (en Zapier) + un hash de los datos de la
  acción (sin el PDF) + el día UTC. Un reintento el mismo día no duplica. El mismo envío con datos idénticos otro día sí
  crea un sobre nuevo. El campo opcional «Idempotency key» la reemplaza (por ejemplo, con el id del registro de origen).
- **Acción de Pipedrive y widget de Kommo:** `pd-`/`km-<cuenta>-<mapeo>-<registro>-<corrida>`, con la corrida guardada en
  `sessionStorage`. `POST /v1/crm/mappings/{id}/send` respeta la clave (helper `idempotent()`).

Código en `apps/api/src/modules/lowcode.ts` (OpenAPI: `lowcode-openapi.ts`; contrato: `packages/shared/src/lowcode.ts`).
Scopes OAuth: `templates:read`, `envelopes:write` y `webhooks:manage`, por prefijo de ruta. No hubo migraciones.

### Pruebas

- `corepack pnpm --filter @calasign/integrations test` corre `test/run.mjs` y `test/connectors.mjs`, sin red:
  - lint de OpenAPI 2.0 con las reglas de certificación de Microsoft (operationId en PascalCase, summary de hasta 80
    caracteres sin punto, descripciones con puntuación final, `x-ms-summary` en cada parámetro, `x-ms-visibility`,
    `$ref` y referencias dinámicas válidas, trigger con `x-ms-notification-url`);
  - `quicksend`;
  - la app de Zapier con un `z` simulado: REST hook, acciones, y que la API key no salga hacia terceros;
  - el paquete de n8n: tgz, nodos y credenciales cargados, trigger con firma HMAC, ejecución;
  - Make: referencias `rpc://`, webhook y funciones, IML balanceado, funciones IML en `vm`;
  - Dynamics: web resource con `Xrm` simulado, `setup-dataverse` idempotente y flujos que usan operaciones existentes
    del conector.
- `node scripts/e2e-lowcode.mjs` levanta su propia API (puerto 4117, PGlite) y prueba todo de punta a punta:
  - endpoints nuevos, y `Location` + DELETE como hace Power Automate;
  - la app de Zapier construida, con `z.request` real: suscripción, envío desde plantilla con prellenado, firma de
    los dos roles, entrega del webhook con HMAC verificado, PDF firmado, datos de prueba, envío de un PDF de 2
    páginas (firmas en la última) y desuscripción;
  - el trigger de n8n: crea, verifica y borra su webhook.
- `apps/api/test/lowcode.test.ts` prueba el formulario dinámico, la conversión de roles y prellenado, y los eventos
  sintéticos.
- Validaciones fuera del repo, sin agregar dependencias:
  - `apiDefinition.swagger.json` contra el JSON Schema oficial de Swagger 2.0: 0 errores;
  - la app de Zapier con `zapier-platform-schema` 19.2.1 (`validateAppDefinition`, lo mismo que corre
    `zapier-platform validate --without-style`): 0 errores;
  - `tsc --strict` de los nodos de n8n contra `n8n-workflow` 2.16.0: sin errores.

### Pendiente para publicar (cuentas, certificación y decisiones)

- **Power Automate (certificación de Microsoft)**:
  - Cuenta de Partner Center como *verified publisher*.
  - Armar una solución con el conector y un flujo de prueba, pasar Solution Checker y `ConnectorPackageValidator.ps1`,
    y enviar por Partner Center.
  - Hacer al menos 10 llamadas exitosas por operación.
  - Ícono de 230×230 con fondo `#1F4E79`.
  - Pedir clase **Standard**, como DocuSign y Adobe.
  - `paconn validate` necesita login: hay que correrlo con la cuenta de Microsoft.
- **Power Automate con OAuth**: el «Generic OAuth 2» de los conectores personalizados **no envía PKCE**, y CalaSign
  exige PKCE S256 en todas las apps. Usar `apiProperties.oauth.json` requiere decidir si se permite que una app OAuth
  **confidencial** canjee el código sin PKCE (RFC 9700 lo permite para confidenciales, que se autentican con el
  secreto). Es un cambio de seguridad en `oauth.ts` que **no se hizo**: hasta decidirlo, el conector usa API key.
  Si se hace, la redirect URI es la que Power Automate genera por conector
  (`https://global.consent.azure-apim.net/redirect/<id>`).
- **Zapier**:
  - Cuenta de Zapier Developer, y `zapier-platform register` y `push`.
  - `zapier-platform validate` con los style checks requiere login.
  - Usuarios de prueba y Zaps activos para pedir la publicación pública.
  - Para OAuth en vez de API key: app OAuth de CalaSign con la redirect de Zapier y `enablePkce: true`.
- **Make**:
  - Cuenta de Make: crear la app, copiar los componentes (o hacer *Deploy* desde VS Code con `makecomapp.json`,
    completando `origins`) y probar cada módulo.
  - Pedir la revisión.
  - Verificar en el editor las expresiones IML del PKCE (`sha256(…, 'base64')` y los reemplazos para base64url).
  - Crear la app OAuth de CalaSign con la redirect `https://www.make.com/oauth/cb/app` y cargar client_id y secret en
    *Common data*.
- **n8n**: el repo para npm se genera con `node integrations/connectors/n8n/export-repo.mjs [--base-url …] [--repo
  owner/nombre]` (por defecto en `../n8n-nodes-calasign`). Trae `@n8n/node-cli` (build y lint oficiales, que pasan sin
  errores ni avisos), pnpm con lockfile, MIT, CHANGELOG y los workflows de la plantilla de n8n: CI (lint + build) y
  `publish.yml` (al pushear un tag `x.y.z` publica en npm **con provenance**, requisito desde el 1-may-2026). Los pasos
  están en su `RELEASING.md`:
  - Crear el repo público (`gh repo create … --public --source . --push`).
  - Primera versión con un token `NPM_TOKEN` (npm solo permite Trusted Publishing sobre un paquete que ya existe);
    después configurar Trusted Publisher (`publish.yml`) y borrar el token.
  - `pnpm run release` para cada versión.
  - Pasar `npx @n8n/scan-community-package n8n-nodes-calasign` y pedir la verificación en el Creator Portal.
  - La URL base por defecto de las credenciales sale de `--base-url` (hoy `https://dev.calasign.com`): exportar con la
    de producción antes de la primera versión pública.
- **Dynamics 365**:
  - Probar en un entorno real.
  - Exportar la solución «CalaSign» (conector, columnas, web resource y los dos flujos) como **administrada** para
    clientes y AppSource.
  - Para AppSource: oferta en Partner Center y validación de Microsoft.
- **Zoho CRM / Bigin** (detalle en [CRM.md](CRM.md) y `integrations/connectors/zoho-crm/README.md`):
  - Registrar en api-console.zoho.com un cliente *Server-based Application* con la redirect
    `{APP_URL}/v1/crm/oauth/zoho/callback` y **Multi-DC** activado; cargar `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET`.
  - Probar con cuentas reales de Zoho CRM y Bigin (idealmente una en zoho.com y otra en zoho.eu): roles de contacto,
    adjunto, nota (`Parent_Id` en Bigin) y que el authorize acepte PKCE en todos los DC (si no, `ZOHO_OAUTH_PKCE=false`).
  - Extensión en Zoho Developer Console (conexión con API key, campo `CalaSign_Status`, variables y botón con la
    función Deluge), *Test your Extension* y publicación en Zoho Marketplace (revisión de Zoho).
- **Pipedrive** (conector nativo + acción del Marketplace, ver `integrations/connectors/pipedrive/README.md`):
  - App pública en el Developer Hub con la callback `{APP_URL}/v1/crm/oauth/pipedrive/callback` y los scopes `base`,
    `deals:full`, `contacts:full`, `users:read`; cargar `PIPEDRIVE_CLIENT_ID` y `PIPEDRIVE_CLIENT_SECRET` en el servidor.
  - Link action «Enviar a firmar con CalaSign» → `{APP_URL}/integrations/connectors/pipedrive/send.html` (Deals y Persons).
  - Probar en una cuenta sandbox (archivos y notas con `deals:full`, campo de opción única) y pedir la revisión del
    Marketplace con el listing en es/en/pt.
- **RD Station CRM** (conector nativo, `apps/api/src/modules/crm/rdstation.ts`):
  - App en la RD Station App Store (<https://appstore.rdstation.com/pt-BR/publisher>) con la URL de callback
    `{APP_URL}/v1/crm/oauth/rdstation/callback`; cargar `RDSTATION_CLIENT_ID` y `RDSTATION_CLIENT_SECRET`.
  - Probar con una cuenta real: que el authorize devuelva `state`, el header `Authorization: Bearer`, el upload
    multipart `data[file]` y que `PUT /deals/{id}` con `custom_fields` parcial no borre los otros campos. Publicar la
    app en la App Store (listing en pt-BR).
- **Kommo** (conector nativo + widget, ver `integrations/connectors/kommo/README.md`):
  - Integración en Kommo (Ajustes → Integraciones → Crear integración) con Redirect URL
    `{APP_URL}/v1/crm/oauth/kommo/callback` y los permisos CRM + **Access to files**; cargar `KOMMO_CLIENT_ID` y
    `KOMMO_CLIENT_SECRET`. Subir `calasign-kommo-widget.zip` a la misma integración (reemplazar las imágenes si el
    validador pide otros tamaños).
  - Probar con una cuenta real (subida en partes al drive, `PUT /leads/{id}/files`, nota) y pedir la revisión del
    Kommo Marketplace (cuenta de socio) con los textos en es/en/pt.
- **Siguientes conectores del ranking**: Odoo, TOTVS y SAP Business One.

## RR. HH. (HRIS), contratos (CLM) y gestores documentales (DMS)

Conectores out-of-the-box, configurables por cada organización desde la web y sin código:

- **HRIS:** BambooHR, HiBob y Factorial.
- **CLM:** Ironclad y Juro.
- **DMS:** archivado automático en SharePoint, Box, Google Drive, Dropbox, OneDrive y S3.

Desde las plataformas low-code (sección anterior) también se pueden disparar estos conectores con el webhook genérico
(ver más abajo).

**Dónde está el código**

| Parte | Ubicación |
|---|---|
| API | `apps/api/src/modules/connectors/` (`providers.ts`: clientes HTTP; `index.ts`: rutas, envío y trabajos; `evidence-file.ts`: certificado de evidencia; `openapi.ts`) |
| Archivado en DMS | `apps/api/src/modules/storage-export.ts`, extendido con SharePoint y Box |
| Web | Ajustes → **RR. HH. y contratos** (`/app/settings/connectors`) y Ajustes → **Almacenamiento** (`/app/settings/storage`) |
| Docs para integradores | `/developers/guides/hr-contracts` |
| Migraciones | `0042_connectors_hr_clm.sql` y `0043_storage_dms.sql` |

### Ranking de herramientas (investigación web, octubre de 2026)

Las cifras de cuota de mercado en LATAM, sobre todo en Centroamérica y el Caribe, son escasas. Lo que no tiene cifra
pública está marcado como inferencia.

#### HRIS / Recursos humanos

| # | Herramienta | Por qué | DocuSign / Adobe Sign |
|---|---|---|---|
| 1 | **Workday** | Líder del mercado HCM: 9,8 % de US$ 58,7 B en 2024 ([Apps Run The World](https://appsruntheworld.com/top-10-hcm-software-vendors-and-market-forecast/)). En la encuesta de Futurum 2025 lo usa el 27,9 % ([Futurum](https://futurumgroup.com/press-release/workday-sap-successfactors-oracle-hcm-dominate-hr-employee-experience-market)). | Ambos tienen integración nativa ([DocuSign](https://www.docusign.co.uk/integrations), [Adobe](https://www.adobe.com/acrobat/business/integrations)). |
| 2 | **SAP SuccessFactors** | 25,5 % en la encuesta de Futurum. Lo usan las grandes cuentas de toda la región. | Ambos ("SAP Signature Management by Docusign"). |
| 3 | **Gupy** (BR) | Domina reclutamiento y admisión en Brasil: 78,4 % del segmento por detección web ([wmtips](https://www.wmtips.com/technologies/hr-management/country/br)). | Integra DocuSign y Clicksign en Gupy Admissão ([Gupy](https://www.gupy.io/integracao/fluxo-integracao-contratos)). |
| 4 | **Buk** (CO/CL/PE/MX) | Más de 7.000 empresas, valuada en US$ 850 M y creció más de 50 % en Colombia en 2024 ([Forbes CO](https://forbes.co/2025/01/07/emprendedores/buk-plataforma-de-rrhh-alcanza-valuacion-de-us850-millones-tras-recaudar-us50-millones-en-ronda-de-inversion)). | Tiene firma propia: es competidor más que canal. |
| 5 | **BambooHR** | Referente pyme/mid-market global; aparece en filiales de multinacionales (inferencia). | DocuSign **no** tiene app nativa, solo vía Zapier, Workato o Make ([Zapier](https://zapier.com/apps/bamboohr/integrations/docusign)). |
| 6 | **Factorial** | Fuerte en España y LATAM (BR, MX, CO). | Sin integración nativa conocida. |
| 7 | **Sólides / TOTVS RH / Senior** (BR) | Sólides tiene 40–55 mil pymes ([Bloomberg Línea](https://www.bloomberglinea.com.br/startups/startup-de-rh-solides-mira-receitas-de-r-1-bi-ate-2028-com-apoio-do-warburg-pincus/)). TOTVS (vía Ahgora) más de 18 mil ([BP Money](https://bpmoney.com.br/mercado/totvs-tots3-adquire-ahgora-por-r-380-milhoes)). | Senior tiene firma propia (admissão digital). |
| 8 | **HiBob / Personio** | Mid-market europeo y global. | Sin app nativa de DocuSign ([comunidad de Personio](https://community.personio.com/integrations-workflows-75/how-to-integrate-docusign-into-personio-5148)). |
| 9 | **Oracle HCM / ADP** | Enterprise (Oracle tiene alrededor del 6,4 %). | Integraciones enterprise. |

**Elegidos para conector nativo:** BambooHR, HiBob y Factorial.

- Los tres tienen API REST pública, documentada y con subida de archivos al legajo del empleado.
- BambooHR y HiBob no tienen app nativa de DocuSign: es un hueco que CalaSign puede ocupar.
- Factorial tiene presencia en LATAM.

**Fase 2:**

- **Workday y SuccessFactors:** SOAP/OData, certificación del fabricante y costo alto.
- **Buk:** clave para Colombia, pero la documentación de la API requiere un tenant y la ruta de documentos no está confirmada.
- **Gupy:** API solo en planes Premium/Enterprise; lo práctico es una alianza como proveedor de firma de Gupy Admissão.

#### CLM / Gestión de contratos

| # | Herramienta | Por qué | DocuSign / Adobe Sign |
|---|---|---|---|
| 1 | **Ironclad** | Líder del Gartner MQ CLM de noviembre de 2025 ([Ironclad](https://ironcladapp.com/resources/reports/gartner-mq-2025)). Tiene la API más completa, incluido un endpoint explícito para subir el firmado. | Integra DocuSign, Adobe Sign y Dropbox Sign ([soporte](https://support.ironcladapp.com/hc/en-us/articles/12285339320727-Use-eSignature-Integrations)). |
| 2 | **Icertis** | Enterprise y compras. | Adobe la promociona ([Adobe](https://www.adobe.com/acrobat/business/integrations)). |
| 3 | **Agiloft** | Líder en Gartner. La API es por instancia (OAuth con token de unos 15 minutos). | DocuSign y Adobe. |
| 4 | **SAP Ariba** | Compras enterprise. | Adobe. |
| 5 | **Conga** | Challenger; tiene Conga Sign. | DocuSign y Adobe. |
| 6 | **Juro** | Mid-market; API con `x-api-key`. | Firma propia. |
| 7 | **DocuSign CLM / Sirion / Malbek / ContractWorks / Gatekeeper** | ContractWorks no publica API. | — |

En LATAM los CLM globales son poco comunes (inferencia); en Brasil compiten productos locales (Netlex, Juridoc).

**Elegidos:** Ironclad y Juro.

- **Ironclad:** su endpoint `upload-signed` cierra el paso de firma del workflow.
- **Juro:** API sencilla de leer, y el PDF se descarga directo.

Agiloft queda para una fase 2, porque cada instancia expone su propio esquema.

#### DMS / ECM

| # | Herramienta | Por qué | DocuSign / Adobe Sign |
|---|---|---|---|
| 1 | **SharePoint / OneDrive** | Dominante por volumen (M365), también en LATAM. | Archivado automático en el App Center de DocuSign ([DocuSign](https://www.docusign.com/blog/app-center-customize-extend-agreement-processes)). |
| 2 | **Google Drive** | Workspace. | Ídem. |
| 3 | **Dropbox** | — | Ídem. |
| 4 | **Box** | Líder del Gartner MQ Document Management 2024 y 2026 ([Box](https://www.nasdaq.com/press-release/box-named-leader-2026-gartnerr-magic-quadranttm-document-management-2026-04-28)). | DocuSign y Adobe. |
| 5 | **DocuWare** | Fuerte en pymes vía partners (inferencia). | — |
| 6 | **OpenText / Hyland (OnBase, Alfresco)** | Banca, gobierno y seguros. Hyland es líder en 2026 ([Hyland](https://hyland.com/en/resources/analyst-reports/gartner-magic-quadrant-document-management-report)). | Extensiones de DocuSign. |
| 7 | **M-Files** | Líder en 2026 ([M-Files](https://community.m-files.com/blogs-65091858/b/m-files-blog/posts/m-files-named-a-leader-in-2026-gartner-magic-quadrant-for-document-management)). | Extensión de DocuSign. |
| 8 | **Laserfiche / Egnyte** | — | — |

**Estado en CalaSign:**

- Ya existían Drive, Dropbox, OneDrive y S3.
- **Se agregaron SharePoint (sitio + biblioteca) y Box.** Con eso se cubre lo mínimo que espera el mercado, porque son los destinos que ofrece DocuSign.
- Fase 2, para segmentos regulados: DocuWare (OAuth desde la 7.11, `FileCabinets/{id}/Documents`), M-Files (metadata en lugar de carpetas) y Alfresco (`/nodes/{id}/children`).

### Qué hacen los conectores

| Conector | Conexión | Desde el registro | Al completarse |
|---|---|---|---|
| **BambooHR** | Subdominio + API key (Basic `key:x`) | Empleado + su supervisor (`supervisorEId`); campos para prellenar (`jobTitle`, `hireDate`…). | PDF sellado + evidencia en los archivos del empleado (categoría configurable; si no se configura, la primera del legajo; `share=no`). Estado en un campo (`POST /employees/{id}`). |
| **HiBob** | Service user (Basic `id:token`) | Empleado + `work.reportsTo`. | PDF + evidencia en `docs/people/{id}/confidential` (o `shared`). |
| **Factorial** | API key (`x-api-key`) u OAuth | Empleado + su manager. | PDF + evidencia en `documents/documents` (`employee_id`, `folder_id` opcional). |
| **Ironclad** | OAuth con PKCE, o token de API (región na1/eu1/demo; `x-as-user-email` opcional) | **Workflow:** el contrato en borrador (`document/{key}/download`) se firma junto con la hoja de firmas de la plantilla; los firmantes salen de los atributos `…Name`/`…Email` (la contraparte primero). **Registro:** sus propiedades. | **Workflow:** `upload-signed` (Ironclad lo toma como totalmente firmado y completa el paso). **Registro:** adjunto `signedCopy` (o la clave configurada), evidencia en `calasignEvidence` y estado como propiedad. |
| **Juro** | API key (`x-api-key`) | Contrato, campos y firmantes (`signingSides[].signatories`); PDF desde `pdf/binary`. | La copia firmada se sube como contrato nuevo (`/contracts/upload`). |
| **SharePoint** | OAuth de Entra ID (misma app que OneDrive, scope `Sites.ReadWrite.All`) | — | PDF (+ evidencia si `includeEvidence`) en sitio → biblioteca → carpeta. El sitio y la biblioteca se resuelven una vez con Graph y quedan guardados. |
| **Box** | OAuth | — | PDF (+ evidencia) en la carpeta indicada. Crea los segmentos que falten; si la carpeta ya existe (409), usa su id. Si el nombre está ocupado, agrega un sufijo. |

#### Piezas comunes (mismo diseño que CRM, ver `docs/CRM.md`)

**Flujos (`/v1/connectors/flows`)**

Un flujo define:

- La plantilla y el documento a firmar:
  - `template`: los documentos de la plantilla.
  - `record`: el contrato del CLM va primero y la plantilla aporta la hoja de firmas.
- Los destinatarios por rol:
  - persona del registro por orden;
  - persona con un rol, por ejemplo `manager` o la principal;
  - campos del registro;
  - datos fijos.
- El prellenado de campos.
- Qué se devuelve al completarse: `uploadSigned`, `uploadEvidence`, `folder`, `statusProperty` y `statusValues`.
- El disparo: `manual` o `webhook`, con filtro por evento.
- Si el sobre se envía enseguida o queda en borrador.

**Cómo se envía**

- Desde la UI: se busca el empleado o contrato (`GET /connections/{id}/records?q=`) y se pulsa "Crear sobre".
- Por API: `POST /v1/connectors/flows/{id}/send {recordId}`.
- Por el webhook de la conexión.

**Webhook**

- Cada conexión tiene una URL secreta: `/v1/integrations/connectors/hook/cshk_…`. En la base se guarda el hash; el secreto se guarda cifrado para mostrarlo a los admins. Se puede regenerar.
- Entiende los cuerpos de BambooHR (`employees[].id`/`action`), HiBob, Factorial, Ironclad (`payload.workflowID`/`recordId`) y Juro (`contract.id`).
- También acepta un cuerpo genérico `{recordId, event}`, útil para Power Automate, Zapier, Make o n8n.
- Las reentregas del mismo cuerpo no duplican. Un registro con un sobre en curso no genera otro: el flujo se bloquea mientras se crea el sobre.
- El sobre queda a nombre de quien creó el flujo. Si esa persona ya no puede crear sobres con la plantilla, no se envía.

**Devolución (write-back)**

- Cada evento del sobre (enviado, completado, rechazado, anulado, vencido) encola un trabajo `connector` en la cola `platform`, desde el mismo outbox que CRM.
- El PDF ya entregado no se vuelve a subir si un reintento falla después (por ejemplo, en la evidencia o en el estado).
- Las credenciales rechazadas, los datos inválidos y los 422 no se reintentan solos: el error queda visible en la conexión y en la actividad, y se reintenta a mano (`POST /v1/connectors/runs/{id}/retry`).
- Un 5xx se reintenta con backoff.

**Certificado de evidencia** (`evidence-file.ts`)

- Es un JSON `calasign.evidence-certificate` con: el SHA-256 del PDF sellado, los destinatarios (estado, método de autenticación, documento, IP y fechas) y la cadena de eventos con sus hashes.
- Va además del certificado de finalización que el PDF sellado ya lleva.
- Se sube con el mismo nombre del PDF más el sufijo ` - evidencia.json`.

**Seguridad**

- Credenciales y tokens cifrados en la base (`encrypt` de `lib/util`).
- Las URLs base salen de variables de entorno, nunca del usuario:
  - el subdominio de BambooHR se valida como subdominio;
  - la región de Ironclad se elige de una lista cerrada;
  - el sitio de SharePoint tiene que ser `*.sharepoint.com` con https.
- Permisos:
  - conexiones, flujos y búsqueda de registros (que expone datos de RR. HH.): `settings:manage`;
  - enviar desde un flujo y ver vínculos: `envelopes:create`;
  - con tokens OAuth: scopes `settings:*` y `envelopes:*`.

### Lo que tiene que hacer el operador

#### Variables de entorno

| Variable | Para qué |
|---|---|
| `IRONCLAD_CLIENT_ID`, `IRONCLAD_CLIENT_SECRET` | App OAuth de Ironclad. Sin ellas se conecta igual con un token de API. Cada entorno (na1, eu1, demo) necesita su propia app. |
| `FACTORIAL_CLIENT_ID`, `FACTORIAL_CLIENT_SECRET`, `FACTORIAL_SCOPE` | App OAuth de Factorial (opcional: se puede conectar con API key). |
| `FACTORIAL_API_VERSION` | Versión de la API por fecha (por defecto `2026-07-01`). |
| `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET` | App OAuth de Box (Custom App, User Authentication, permiso "Read and write all files and folders"). |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` | Ya existían para OneDrive. SharePoint usa la misma app. |
| `BAMBOOHR_API_BASE`, `HIBOB_API_BASE`, `FACTORIAL_API_BASE`, `IRONCLAD_BASE`, `JURO_API_BASE`, `BOX_API_BASE`, `BOX_UPLOAD_BASE`, `BOX_AUTHORIZE_URL`, `MS_LOGIN_BASE`, `MS_GRAPH_BASE` | Solo para pruebas con simuladores. |

BambooHR, HiBob y Juro no requieren nada del lado del servidor: cada organización pega su clave.

#### Apps a registrar

**Ironclad**

- Ir a Company Settings → API → *Create app*.
- Redirect URI: `{APP_URL}/v1/connectors/oauth/ironclad/callback`.
- Scopes:
  - `public.workflows.readWorkflows`
  - `public.workflows.readDocuments`
  - `public.workflows.uploadSignedDocuments`
  - `public.records.readRecords`
  - `public.records.updateRecords`
  - `public.records.createAttachments`
- Para recibir el webhook: suscribir `workflow_updated_on_sign_step` (o el evento que se quiera) a la URL de la conexión.

**Factorial**

- Ir a Settings → API → OAuth applications.
- Redirect URI: `{APP_URL}/v1/connectors/oauth/factorial/callback`.

**Box**

- Redirect URI: `{APP_URL}/v1/storage/oauth/box/callback`.

**Microsoft (Entra ID)**

- En la app de OneDrive:
  - agregar el permiso delegado `Sites.ReadWrite.All` (requiere el consentimiento del admin de cada tenant cliente);
  - agregar la redirect `{APP_URL}/v1/storage/oauth/sharepoint/callback`.

**BambooHR**

- Las apps del Marketplace creadas desde abril de 2025 deben usar OAuth2. Este conector usa la API key de cada cliente, que sigue vigente para integraciones privadas.
- Si se quiere publicar en el Marketplace, hay que sumar OAuth (`/authorize.php`, `/token.php`, `offline_access`).

### Supuestos a verificar contra cuentas reales

La documentación no es completamente pública en todos los casos: verificar en sandbox antes de anunciar.

- **BambooHR:**
  - La ruta de gateway que usamos es `api.bamboohr.com/api/gateway.php/{company}/v1`. Existe también la nueva `{company}.bamboohr.com/api/v1`.
  - Los campos del empleado tienen que estar habilitados para la clave.
  - El campo de estado tiene que existir (campo propio de texto).
- **HiBob:**
  - `GET /people/{id}?humanReadable=replace`.
  - El límite de tamaño de la subida (Workato menciona 1 MB).
- **Factorial:**
  - La ruta `resources/documents/documents` y sus campos (`employee_id`, `folder_id`, `file`).
  - Algunos endpoints de documentos podrían exigir OAuth en lugar de API key.
- **Ironclad:**
  - Que el documento del workflow esté en `attributes.draft[].key`.
  - Que el workflow esté en el paso de firma para `upload-signed`.
  - Que la clave del adjunto del registro exista en el tipo de registro.
- **Juro:**
  - La forma de `signingSides` y `fields`.
  - `/contracts/upload` como forma de dejar la copia firmada: Juro está pensado para su firma nativa.
- **Box:** el cuerpo del 409 de `POST /folders` (`context_info.conflicts`).
- **SharePoint:** el consentimiento de admin para `Sites.ReadWrite.All`. Alternativa más restrictiva: `Sites.Selected`.

### Pruebas

**E2E: `node scripts/e2e-connectors.mjs`**

Levanta simuladores de BambooHR, Ironclad, Juro, Box y Microsoft (login + Graph), y su propia API en el puerto 4117. Cubre:

- **Proveedores:** la lista de conectores y sus URIs de redirección.
- **DMS:**
  - Box y SharePoint por OAuth; SharePoint sin sitio responde 400.
  - Sitio y biblioteca resueltos con Graph.
  - Carpeta anidada creada en Box.
  - PDF y evidencia archivados en los dos destinos.
- **BambooHR:**
  - Clave inválida y dominio raro rechazados.
  - Búsqueda de empleados.
  - Sobre con el empleado y su jefe, y el cargo prellenado.
  - Estado `sent` y luego `Firmado`.
  - PDF y evidencia en el legajo, con la categoría correcta y sin compartir.
  - Webhook con URL secreta: token inválido responde 404; un evento repetido no duplica; un evento filtrado no dispara.
  - Clave revocada → `409 connector_reauth_required`, con el error visible.
  - URL de webhook regenerada.
- **Ironclad:**
  - OAuth con PKCE verificado por el simulador.
  - Contrato del workflow con la hoja de firmas de la plantilla.
  - `upload-signed` avanza el paso de firma.
- **Juro:** contrato y firmantes leídos de Juro; copia firmada subida.

**Unitarias: `apps/api/test/connectors.test.ts`**

Usan un fetch falso, sin red. Cubren:

- HiBob y Factorial: lectura de empleado y jefe, y subida.
- Ironclad record: estado y adjunto.
- Parsers de webhooks.
- Personas de un contrato.
- Validación de credenciales.
- Sitio de SharePoint.
- Carpetas de Box ante un 409.

## Google Workspace (Gmail, Docs y Drive)

Add-on de Apps Script (Card Service), como los de DocuSign, Dropbox Sign y Zoho Sign en el Workspace Marketplace.
Código y guía completa: `integrations/connectors/google-workspace/` ([README](../integrations/connectors/google-workspace/README.md)).
Artefacto: `<base>/integrations/connectors/google-workspace/calasign-google-workspace-addon.zip`, un proyecto listo
para `clasp push` con `{{BASE_URL}}` ya reemplazado.

- **Gmail**: en un correo con PDF adjunto, *Enviar a firmar con CalaSign*. Los firmantes vienen precargados con el
  remitente, Para y CC (sin el propio usuario ni las direcciones no-reply). La página de inicio muestra los sobres
  recientes.
- **Docs**: exporta el documento abierto a PDF, con la Drive API y `drive.file`. Si el texto tiene anclas
  `[[firma]]`/`[[firma_N]]`, cada firma va encima de la suya; si no, en la última página.
- **Drive**: envía un PDF o un documento de Docs seleccionado. Si se marca la opción, guarda el firmado en la misma
  carpeta cuando el sobre se completa.
- **API**: el envío con anclas es una sola llamada a `POST /v1/envelopes` (atómica, con `Idempotency-Key`). Para la
  última página hacen falta tres llamadas (borrador → `PUT fields` → `send`): la API no tiene «última página» y Apps
  Script no puede contar las páginas del PDF.
- **Autenticación**: OAuth 2.0 con PKCE S256, con la librería OAuth2 de Apps Script (v43). Es un cliente público
  registrado solo vía `POST /oauth/register`, con la redirect `https://script.google.com/macros/d/<SCRIPT_ID>/usercallback`.
  La alternativa es una API key. **No se cambió `oauth.ts`**.
- **Scopes de Google**: `gmail.addons.execute`, `gmail.addons.current.message.readonly` (el único sensible),
  `drive.addons.metadata.readonly`, `drive.file`, `script.external_request`, `script.locale` y `userinfo.email`.
  Ninguno es restringido, así que no hace falta la evaluación CASA.
- **Guardar el firmado**: se hace al abrir el add-on, consultando los sobres pendientes. Primero intenta la carpeta
  original; si `drive.file` no deja escribir ahí, hace una copia del PDF original (queda en la misma carpeta) con el
  contenido reemplazado; si tampoco se puede, usa la carpeta «CalaSign» de Mi unidad. La exportación a Google Drive de
  la organización (`storage-export.ts`) es automática y archiva todo, pero en una carpeta fija de una cuenta de la
  organización. Conviene usar las dos (ver la comparación en el README).
- **Pruebas**: `integrations/test/google-workspace.mjs`, sin red, con GmailApp, UrlFetchApp, CardService,
  PropertiesService y la librería OAuth2 simulados. Cubre:
  - el manifiesto (scopes exactos, allowlists y triggers existentes);
  - que no queden placeholders y que no se use `DriveApp`/`DocumentApp`;
  - los textos es/en/pt;
  - el parseo de destinatarios y anclas, y el pedido de una llamada;
  - los flujos de Gmail, Docs y Drive;
  - el guardado del firmado, el registro dinámico con PKCE, la API key y la sesión vencida.

### Pendiente para publicar

1. Proyecto de Google Cloud estándar asociado al script, con Marketplace SDK, Gmail API y Drive API habilitadas.
2. Pantalla de consentimiento de OAuth externa: dominio verificado en Search Console, política de privacidad
   (`<base>/privacy` todavía no existe), términos y los 7 scopes justificados.
3. Verificación de scopes sensibles por `gmail.addons.current.message.readonly`: video de demostración y
   justificación. Hasta que se apruebe, funciona con hasta 100 usuarios de prueba.
4. Implementación versionada y configuración de la app en el Marketplace SDK (ID de implementación, scopes y URLs).
5. Ficha de la tienda en es/en/pt: íconos de 32/48/96/128 (faltan 48, 96 y el banner de 220×140) y capturas de 1280×800.
6. Revisión del Marketplace.
7. Antes de todo esto, probarlo en Google real con una implementación de prueba. Hay que verificar:
   - la vuelta del consentimiento a `usercallback`;
   - si la página de consentimiento con COOP `same-origin` deja que el add-on se recargue al cerrar la ventana;
   - si `drive.file` deja crear el firmado en la carpeta del original.

## Avisos a canales (webhooks entrantes)

Ajustes → **Avisos a canales** (`/app/settings/notifications`, API `/v1/notification-integrations`). Cada integración
guarda la URL del webhook entrante **cifrada** (quien la tiene puede publicar en el canal; la API solo devuelve
`urlHint`), los eventos elegidos (`NOTIFICATION_EVENTS`) y el resultado del último envío. La URL pasa por
`validateIncomingWebhookUrl` (https, sin credenciales, sin destinos locales) y el envío por `postToCustomerUrl` (bloqueo
de IP privadas/metadata, plazo total de 10 s). No se restringe el host por plataforma: Mattermost y Rocket.Chat son
autoalojados y Teams/Workflows cambia de dominio según la región. Un 429 o 5xx hace reintentar el job.

El formato está en `apps/api/src/modules/notify-format.ts` (sin E/S, con tests en `apps/api/test/notify-format.test.ts`).
El asunto y los nombres vienen de afuera (p. ej. formularios web), así que en cada plataforma se neutralizan menciones
masivas y links con texto falso, y se cortan a 500 (asunto) y 300 (detalle) caracteres:

| Destino (`kind`) | Formato | Escape | Cómo se obtiene la URL |
|---|---|---|---|
| `slack` | Block Kit (sección + botón) | `&`, `<`, `>` como entidades | Apps → Incoming Webhooks → Add to Slack |
| `teams` | `{type:"message", attachments:[Adaptive Card 1.4]}` | se corta `[texto](url)`; las menciones exigen `entities` | Canal → ⋯ → Workflows → «Publicar en un canal cuando se recibe una solicitud de webhook» |
| `discord` | Embed con color por evento, título linkeado, `allowed_mentions: {parse: []}` | `\` ante la puntuación de markdown, `<`, `@`, `:` | Ajustes del servidor → Integraciones → Webhooks → Nuevo webhook |
| `google_chat` | `cardsV2` (encabezado, `textParagraph`, botón `openLink`) | HTML (`&`, `<`, `>`, `"`) | Espacio → Apps e integraciones → Webhooks |
| `mattermost`, `rocketchat` | `attachments` del formato de Slack (color, `title_link`, texto markdown); los dos los aceptan, no así los blocks | `\` ante la puntuación de markdown y `@` + espacio de ancho cero (no tienen `allowed_mentions`) | Integraciones → Webhooks entrantes (Mattermost: lo habilita un admin) / Administración → Integraciones → Webhook entrante |
| `webex` | `{markdown}` (app «Incoming Webhooks», `webexapis.com/v1/webhooks/incoming/…`) | `<`, `>`, `&` como entidades, `\` ante markdown, `@` + espacio de ancho cero; tope de Webex 7439 bytes | App Hub → Incoming Webhooks → Conectar |

**Microsoft Teams:** Microsoft retiró los conectores de Office 365 (el «Webhook entrante» clásico, URLs
`….webhook.office.com`, y su formato `MessageCard`). El reemplazo son los **Workflows** de Power Automate
(`….logic.azure.com/workflows/…` o `….powerplatform.com/powerautomate/automations/direct/workflows/…`), que solo
publican **Adaptive Cards** dentro de un mensaje (`type: "message"`, `contentType:
"application/vnd.microsoft.card.adaptive"`). CalaSign manda siempre ese formato, que también aceptaban los conectores
viejos, así que funcionan las URLs de los dos tipos sin migrar datos. El flujo del Workflow responde `202 Accepted`.

La migración `0050_notify_channels.sql` amplía el `CHECK` de `notification_integrations.kind`. El e2e es
`scripts/e2e-platform.mjs` (un receptor local por plataforma, sin red real).

**Pendiente:** apps interactivas (botones de aprobar/firmar dentro del chat) de Slack y Teams (prioridades #4 y #10 de
abajo); Zulip y Lark/Feishu tienen webhooks entrantes y se agregarían con el mismo patrón si hay demanda.

## Próximos conectores: qué ofrece el mercado (octubre de 2026)

Relevamiento de los catálogos de integraciones de DocuSign, Adobe Acrobat Sign, Dropbox Sign, PandaDoc, BoldSign y Zoho
Sign, y de los firmadores de LATAM Clicksign, ZapSign y D4Sign. Los catálogos de OneSpan, Lleida.net, Viafirma, Firmamex
y Validated ID no se revisaron en línea.

**Conclusión:** CalaSign cubre bien almacenamiento, iPaaS e IA, y con MCP va por delante de la mayoría. Faltan tres
cosas: apps dentro de las suites ofimáticas (Gmail/Docs, Teams, Slack con acciones), CRM de pymes y de LATAM
(Bitrix24, monday; Zoho CRM, Pipedrive, RD Station CRM y Kommo ya están hechos) y verificación de identidad local (Registraduría, gov.br/Serpro, RNP,
JCE).

### Brechas por categoría

| Categoría | Lo que tiene la mayoría de los competidores | CalaSign |
|---|---|---|
| CRM global | Salesforce (AppExchange), HubSpot, Dynamics 365 nativo, Zoho CRM, Pipedrive | Salesforce solo en Opportunity; HubSpot sí; Zoho CRM y Bigin sí (nativo + botón en Deals); Pipedrive sí (nativo + acción del Marketplace); Dynamics vía Power Automate |
| CRM LATAM | RD Station y Kommo (Clicksign y ZapSign vía Pluga), Bitrix24 (Clicksign, D4Sign) | RD Station CRM y Kommo sí (nativos; Kommo con widget); **sin Bitrix24** |
| Ofimática | Add-on de Gmail, Docs y Drive (DocuSign, Dropbox Sign, Zoho); app de Teams (Adobe, Zoho) | Word, Outlook y add-on de Google Workspace sí; **sin app de Teams** |
| Mensajería con acciones | App de Slack (DocuSign); firma por WhatsApp (BoldSign, ZapSign, Truora) | Solo avisos (Slack, Teams, Discord, Google Chat, Mattermost, Rocket.Chat, Webex, Telegram, WhatsApp) |
| Almacenamiento | Drive, Dropbox, OneDrive, Box, SharePoint | **Completo** |
| iPaaS | Zapier, Make, Power Automate, Pluga (BR) | Completo **salvo Pluga** |
| Gestión de trabajo | monday.com, Asana, Jira | **No** |
| RR. HH. enterprise | Workday, SuccessFactors, ServiceNow HR | **No** (sí BambooHR, HiBob, Factorial) |
| ERP | SAP, NetSuite, Xero, QuickBooks | Solo Siigo y Alegra |
| Compras / ITSM | Coupa, SAP Ariba, ServiceNow | No |
| Identidad | CLEAR, Onfido, IDV propio (DocuSign); Signicat (Zoho) | **No** |
| Pagos | Stripe, PayPal, Square (PandaDoc) | No como conector (hay cobro en la firma: ver guía de pagos) |
| Agentes de IA | DocuSign: 8 conectores MCP (Claude, ChatGPT, Gemini, Copilot Studio, GitHub Copilot, Perplexity) | Sí, salvo Copilot Studio y Perplexity |

### Prioridad

| # | Conector | Por qué | Esfuerzo | Cómo |
|---|---|---|---|---|
| 1 | Salesforce: paquete gestionado en AppExchange (cualquier objeto, plantillas, LWC, acciones de Flow, CPQ/Contract/Case) | Canal enterprise; DocuSign y BoldSign firman desde cualquier objeto | L | AppExchange (revisión de seguridad) |
| 2 | ~~Zoho CRM (después Bigin y Zoho Books)~~ **Hecho** (Zoho CRM y Bigin; falta Zoho Books) | Muy usado por pymes de CO, RD y HN; DocuSign no lo tiene | M | Conector nativo en `crm/` (OAuth multi-DC, Deals/Contacts/Pipelines, estado y PDF) + botón en Deals (`integrations/connectors/zoho-crm/`). Falta publicar la extensión en Zoho Marketplace |
| 3 | ~~Add-on de Google Workspace (Gmail, Docs, Drive)~~ **Hecho**: `google-workspace` (ver la sección de abajo) | Google domina en pymes de LATAM | M | Google Workspace Marketplace (Apps Script) |
| 4 | App de Microsoft Teams (enviar, aprobar, avisos con Adaptive Cards) | Completa Word y Outlook | M | AppSource, reutilizando el backend de Outlook |
| 5 | Pipedrive | Muy popular en BR y CO | S–M | **Hecho**: conector nativo (`apps/api/src/modules/crm/pipedrive.ts`) + acción del Marketplace (`integrations/connectors/pipedrive/`); falta publicar la app ([CRM.md](CRM.md)) |
| 6 | Verificación de identidad local (CO, BR, HN, RD) | Lo que más diferencia en LATAM | L | Nativo, con un agregador (Truora, unico, Metamap) |
| 7 | ~~RD Station CRM~~ **Hecho** | CRM líder en Brasil; Clicksign ya está | S–M | Conector nativo (`apps/api/src/modules/crm/rdstation.ts`: API v2 con OAuth de la App Store, Negociação con sus contatos, estado en un campo personalizado, PDF en Anexos + anotação). Falta publicar la app en la RD Station App Store ([CRM.md](CRM.md)) |
| 8 | ~~Kommo~~ **Hecho** | Ventas por WhatsApp en LATAM | S–M | Conector nativo (`apps/api/src/modules/crm/kommo.ts`: OAuth por subdominio, Lead con sus contactos, estado en un campo del lead, PDF por la Files API + nota) + widget (`integrations/connectors/kommo/`). Falta publicar en el Kommo Marketplace |
| 9 | Dynamics 365 nativo | Power Automate solo no compite con DocuSign | M–L | Solución gestionada en AppSource |
| 10 | App de Slack interactiva | Hoy solo hay webhook entrante | S | Slack Marketplace |
| 11 | monday.com | DocuSign y PandaDoc la tienen | S–M | monday Marketplace |
| 12 | Pluga | Vía barata a RD Station, Kommo y Omie en Brasil | S | Conector de Pluga |
| 13 | Bitrix24 | Muy usado en LATAM | S–M | Bitrix24 Market |
| 14 | Odoo | ERP en crecimiento en CO y LATAM | M | Módulo en Odoo Apps |
| 15 | Workday y SuccessFactors | Solo para cuentas enterprise | L | Partner o certificación con cada fabricante |

Quedaron afuera por ahora: Stripe, Mercado Pago o Wompi como conector; Gupy y Buk; TOTVS y Omie; Xero y QuickBooks;
Jotform y Typeform (se cubren con Zapier); Coupa y Ariba.

**Dropbox y OneDrive:** hoy CalaSign archiva ahí el firmado, pero no se puede *enviar a firmar* desde ellos. En
SharePoint/OneDrive conviene un SharePoint Framework Command Set («Enviar a firmar con CalaSign» en la biblioteca) más el
guardado en la carpeta de origen (M). En Dropbox rinde poco, porque Dropbox tiene su propia firma (Dropbox Sign). Para
Google Drive, la acción está en el add-on de Workspace (#3, hecho).

Fuentes: [DocuSign](https://www.docusign.com/en-us/integrations),
[Adobe Acrobat Sign](https://business.adobe.com/uk/products/acrobat-business/sign-solutions.html),
[Adobe + SuccessFactors](https://helpx.adobe.com/sign/integrations/release-notes/sap-successfactors.html),
[Adobe + Teams](https://helpx.adobe.com/vn_vi/sign/integrations/microsoft-teams-approvals.html),
[Dropbox Sign](https://sign.dropbox.com/integrations), [PandaDoc](https://hc.pandadoc.com/en/collections/10117650-integrations),
[BoldSign](https://boldsign.com/integrations/), [Zoho Sign](https://www.zoho.com/sign/integrations.html),
[Clicksign + RD Station](https://www.rdstation.com/integracoes/clicksign-by-pluga), [Clicksign](https://www.clicksign.com/en/integracao),
[D4Sign + Bitrix24](https://www.bitrix24.com/my/apps/app/crmthink.d4sign/), [ZapSign + Kommo](https://pluga.co/en/apps/kommo/integration/zapsign/),
[ZapSign + Make](https://zapsign.co/product/make), [Truora](https://www.truora.com/en/products/electronic-signature),
[MinTIC](https://gobiernodigital.mintic.gov.co/692/articles-79294_recurso_5.pdf).
