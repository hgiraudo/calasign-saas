# Conectores out-of-the-box

Conectores listos para importar o publicar, para integrar CalaSign con herramientas empresariales sin escribir código.
El código está en `integrations/connectors/<id>/`. El build (`integrations/build.mjs` → `connectors/registry.mjs`) los
publica en **`<base>/integrations/connectors/<id>/`** y los lista en `<base>/integrations/connectors/index.json`. La
documentación pública está en `/developers/connectors`.

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
| 9 | **TOTVS + RD Station** (BR) | TOTVS tiene el 34 % del ERP brasileño, empatado con SAP ([FGV](https://convergenciadigital.com.br/mercado/sap-e-totvs-esto-empatadas-com-33-do-mercado-nacional-de-erp)). RD Station supera los 60 mil clientes. | Clicksign y D4Sign (locales). | Pendiente. RD Station se cubre por ahora vía Zapier/Make. |
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
- **n8n**:
  - Repo público en GitHub y publicación en npm **desde GitHub Actions con provenance**, obligatorio desde el
    1-may-2026, usando `@n8n/node-cli`.
  - Pasar `npx @n8n/scan-community-package n8n-nodes-calasign` y pedir la verificación en el Creator Portal.
- **Dynamics 365**:
  - Probar en un entorno real.
  - Exportar la solución «CalaSign» (conector, columnas, web resource y los dos flujos) como **administrada** para
    clientes y AppSource.
  - Para AppSource: oferta en Partner Center y validación de Microsoft.
- **Siguientes conectores del ranking**: Odoo, TOTVS/RD Station y SAP Business One.
