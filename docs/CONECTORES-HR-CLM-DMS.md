# Conectores con RR. HH. (HRIS), gestión de contratos (CLM) y gestores documentales (DMS)

Conectores out-of-the-box, configurables por cada organización desde la web y sin código:

- **HRIS:** BambooHR, HiBob y Factorial.
- **CLM:** Ironclad y Juro.
- **DMS:** archivado automático en SharePoint, Box, Google Drive, Dropbox, OneDrive y S3.

Las plataformas low-code/iPaaS (Power Automate, Zapier, Make, n8n) y Dynamics 365 tienen su propio documento. Desde
esas plataformas también se pueden disparar estos conectores con el webhook genérico (ver más abajo).

**Dónde está el código**

| Parte | Ubicación |
|---|---|
| API | `apps/api/src/modules/connectors/` (`providers.ts`: clientes HTTP; `index.ts`: rutas, envío y trabajos; `evidence-file.ts`: certificado de evidencia; `openapi.ts`) |
| Archivado en DMS | `apps/api/src/modules/storage-export.ts`, extendido con SharePoint y Box |
| Web | Ajustes → **RR. HH. y contratos** (`/app/settings/connectors`) y Ajustes → **Almacenamiento** (`/app/settings/storage`) |
| Docs para integradores | `/developers/guides/hr-contracts` |
| Migraciones | `0042_connectors_hr_clm.sql` y `0043_storage_dms.sql` |

## 1. Ranking de herramientas (investigación web, octubre de 2026)

Las cifras de cuota de mercado en LATAM, sobre todo en Centroamérica y el Caribe, son escasas. Lo que no tiene cifra
pública está marcado como inferencia.

### HRIS / Recursos humanos

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

### CLM / Gestión de contratos

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

### DMS / ECM

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

## 2. Qué hacen los conectores

| Conector | Conexión | Desde el registro | Al completarse |
|---|---|---|---|
| **BambooHR** | Subdominio + API key (Basic `key:x`) | Empleado + su supervisor (`supervisorEId`); campos para prellenar (`jobTitle`, `hireDate`…). | PDF sellado + evidencia en los archivos del empleado (categoría configurable; si no se configura, la primera del legajo; `share=no`). Estado en un campo (`POST /employees/{id}`). |
| **HiBob** | Service user (Basic `id:token`) | Empleado + `work.reportsTo`. | PDF + evidencia en `docs/people/{id}/confidential` (o `shared`). |
| **Factorial** | API key (`x-api-key`) u OAuth | Empleado + su manager. | PDF + evidencia en `documents/documents` (`employee_id`, `folder_id` opcional). |
| **Ironclad** | OAuth con PKCE, o token de API (región na1/eu1/demo; `x-as-user-email` opcional) | **Workflow:** el contrato en borrador (`document/{key}/download`) se firma junto con la hoja de firmas de la plantilla; los firmantes salen de los atributos `…Name`/`…Email` (la contraparte primero). **Registro:** sus propiedades. | **Workflow:** `upload-signed` (Ironclad lo toma como totalmente firmado y completa el paso). **Registro:** adjunto `signedCopy` (o la clave configurada), evidencia en `calasignEvidence` y estado como propiedad. |
| **Juro** | API key (`x-api-key`) | Contrato, campos y firmantes (`signingSides[].signatories`); PDF desde `pdf/binary`. | La copia firmada se sube como contrato nuevo (`/contracts/upload`). |
| **SharePoint** | OAuth de Entra ID (misma app que OneDrive, scope `Sites.ReadWrite.All`) | — | PDF (+ evidencia si `includeEvidence`) en sitio → biblioteca → carpeta. El sitio y la biblioteca se resuelven una vez con Graph y quedan guardados. |
| **Box** | OAuth | — | PDF (+ evidencia) en la carpeta indicada. Crea los segmentos que falten; si la carpeta ya existe (409), usa su id. Si el nombre está ocupado, agrega un sufijo. |

### Piezas comunes (mismo diseño que CRM, ver `docs/CRM.md`)

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

## 3. Lo que tiene que hacer el operador

### Variables de entorno

| Variable | Para qué |
|---|---|
| `IRONCLAD_CLIENT_ID`, `IRONCLAD_CLIENT_SECRET` | App OAuth de Ironclad. Sin ellas se conecta igual con un token de API. Cada entorno (na1, eu1, demo) necesita su propia app. |
| `FACTORIAL_CLIENT_ID`, `FACTORIAL_CLIENT_SECRET`, `FACTORIAL_SCOPE` | App OAuth de Factorial (opcional: se puede conectar con API key). |
| `FACTORIAL_API_VERSION` | Versión de la API por fecha (por defecto `2026-07-01`). |
| `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET` | App OAuth de Box (Custom App, User Authentication, permiso "Read and write all files and folders"). |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` | Ya existían para OneDrive. SharePoint usa la misma app. |
| `BAMBOOHR_API_BASE`, `HIBOB_API_BASE`, `FACTORIAL_API_BASE`, `IRONCLAD_BASE`, `JURO_API_BASE`, `BOX_API_BASE`, `BOX_UPLOAD_BASE`, `BOX_AUTHORIZE_URL`, `MS_LOGIN_BASE`, `MS_GRAPH_BASE` | Solo para pruebas con simuladores. |

BambooHR, HiBob y Juro no requieren nada del lado del servidor: cada organización pega su clave.

### Apps a registrar

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

## 4. Supuestos a verificar contra cuentas reales

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

## 5. Pruebas

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
