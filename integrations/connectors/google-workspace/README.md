# CalaSign para Google Workspace (Gmail, Docs y Drive)

Add-on de Google Workspace hecho con Apps Script y Card Service. Es el mismo tipo de add-on que usan DocuSign, Dropbox
Sign y Zoho Sign en el Google Workspace Marketplace.

| App | Qué hace |
|---|---|
| **Gmail** | En un correo con PDF adjunto: **Enviar a firmar con CalaSign**. Los firmantes vienen precargados con el remitente, Para y CC (sin vos ni las direcciones no-reply). Si hay varios PDF, se elige cuál. La página de inicio muestra el estado de los sobres recientes. |
| **Google Docs** | Exporta el documento abierto a PDF y lo envía a firmar. Si el texto tiene anclas `[[firma]]`, `[[firma_1]]`, `[[firma_2]]`… (también `[[signature_N]]` o `[[assinatura_N]]`), cada firma va encima de su ancla. Si no hay anclas, las firmas van en la última página. |
| **Google Drive** | Con un PDF o un documento de Google Docs seleccionado: lo envía a firmar. Opcionalmente, guarda el PDF firmado en la misma carpeta cuando el sobre se completa. |

En las tres apps, el formulario pide asunto, firmantes (uno por línea, `Nombre <correo>`), orden de firma, mensaje y
dónde se firma. Las opciones de ubicación son: automático, anclas, última página, o dejarlo en borrador para ubicar las
firmas en CalaSign. Las tarjetas salen en español, inglés o portugués según el idioma de la cuenta de Google.

## Cómo habla con CalaSign

- **Envío (anclas)**: **una sola llamada**, `POST {{BASE_URL}}/v1/envelopes`, con el PDF en base64, los firmantes,
  los campos de firma por ancla y `send: true`. Es atómica: si un ancla no está, no se crea nada. Lleva
  `Idempotency-Key`, armada con la tarjeta más un hash del pedido: un doble clic no duplica el sobre.
- **Última página**: la API todavía no acepta una página «última» sin conocer la cantidad de páginas, y Apps Script no
  puede leer el PDF. Por eso se crea el borrador en una llamada (la respuesta trae `pageCount`) y después van
  `PUT /v1/envelopes/{id}/fields` y `POST /v1/envelopes/{id}/send`.
- **Automático**: en Docs (y en documentos de Google seleccionados en Drive) busca las anclas en el texto exportado.
  En un PDF, que Apps Script no puede leer, prueba las anclas convencionales (`[[firma]]`/`[[firma_1]]`, `[[firma_2]]`…,
  con `ignoreIfNotPresent`). Si a algún firmante le falta su firma (`envelope_incomplete`), pasa a la última página.
- **Estado**: `GET /v1/envelopes?limit=8`. Cada sobre tiene un link a `{{BASE_URL}}/app/envelopes/<id>`.
- `metadata.source` va como `google-workspace-gmail`, `google-workspace-docs` o `google-workspace-drive`; desde Drive
  y Docs también va `metadata.driveFileId`.

## Autenticación

1. **OAuth 2.0 con PKCE (S256)**, con la librería [OAuth2 for Apps Script](https://github.com/googleworkspace/apps-script-oauth2)
   (ID `1B7FSrk5Zi6L1rSxxTDgDEUsPzlukDsi4KGuTMorsTQHhGBzBkMun4iDF`, versión 43 = v1.43.0, que trae
   `generateCodeVerifier()` y `setCodeChallengeMethod('S256')`). El verifier viaja dentro del *state token* de Apps
   Script y el canje lo hace el servidor de Google. El cliente es **público**: sin secreto, porque cualquiera que
   instala el add-on puede leer su código.
   - **client_id**: en el primer inicio de sesión, el add-on se registra solo con `POST /oauth/register` (RFC 7591).
     Usa la redirect URI del script, `https://script.google.com/macros/d/<SCRIPT_ID>/usercallback`, y los scopes
     `envelopes:read envelopes:write offline_access`. Lo guarda en las propiedades del script (`CALASIGN_CLIENT_ID`),
     que comparten todos los usuarios.
   - **App fija**: también se puede crear una app OAuth a mano en CalaSign, con esa redirect URI, y fijar su client_id
     en *Configuración del proyecto → Propiedades del script → `CALASIGN_CLIENT_ID`*.
   - Los tokens (con refresh y rotación) quedan en las propiedades **del usuario**. Ningún otro usuario ni otro script
     los ve. Cerrar sesión revoca el refresh token con `POST /oauth/revoke`.
2. **API key** (alternativa): se pega en la tarjeta de inicio de sesión (`cs_live_…` / `cs_test_…`). Se valida con
   `GET /v1/envelopes?limit=1` y queda en las propiedades del usuario.

## Scopes de Google (los mínimos)

| Scope | Para qué | Clasificación de Google |
|---|---|---|
| `gmail.addons.execute` | Correr el add-on en Gmail | No sensible (obligatorio en Gmail) |
| `gmail.addons.current.message.readonly` | Leer **solo el correo abierto**: encabezados (para los firmantes) y adjuntos PDF | Sensible |
| `drive.addons.metadata.readonly` | Ver qué archivo se seleccionó en Drive | No sensible |
| `drive.file` | Leer **solo** los archivos que el usuario habilita (`requestFileScope` / `requestFileScopeForActiveDocument`), exportar Docs a PDF y crear el PDF firmado | No sensible (el recomendado por Google) |
| `script.external_request` | Llamar a la API de CalaSign y a la API REST de Drive (`UrlFetchApp`) | No sensible |
| `script.locale` | Idioma del usuario para las tarjetas (`useLocaleFromApp`) | No sensible |
| `userinfo.email` | Sacar al propio usuario de los firmantes precargados | No sensible |

No se piden `drive`, `drive.readonly`, `gmail.readonly` ni `documents`: son scopes **restringidos** o amplios, y los
restringidos exigen una evaluación de seguridad anual (CASA). Drive y Docs se usan por REST con `ScriptApp.getOAuthToken()`,
no con `DriveApp`/`DocumentApp`. Así Apps Script no infiere scopes más amplios.

`urlFetchWhitelist`: `{{BASE_URL}}/` y `https://www.googleapis.com/`. `openLinkUrlPrefixes`: CalaSign, Drive y Docs.

## Guardar el firmado en la misma carpeta: qué conviene

Al enviar desde Drive o Docs con la casilla marcada, el add-on anota `{ sobre, archivo, carpeta }` en las propiedades
del usuario (hasta 25 pendientes). Cada vez que el usuario abre CalaSign en Drive, Docs o Gmail, revisa como mucho 5
pendientes, y lo hace cada 2 minutos como máximo. Por cada sobre completado, baja `GET /v1/envelopes/{id}/signed.pdf`
y lo guarda como `<nombre> (firmado).pdf`:

1. Primero intenta subirlo a la carpeta del original.
2. Si `drive.file` no lo deja (403/404, porque el add-on no abrió esa carpeta) y el original es un PDF, lo **copia**.
   La copia hereda la carpeta del original, y el add-on le reemplaza el contenido por el firmado.
3. Si tampoco se puede, lo guarda en la carpeta **CalaSign** de Mi unidad, que crea el add-on, y lo avisa.

Los sobres anulados, rechazados o vencidos salen de la lista.

| Opción | Ventajas | Límites |
|---|---|---|
| **Al abrir el add-on** (lo implementado) | Va a la carpeta del usuario, junto al original. No requiere configuración ni scopes nuevos. | Solo se guarda cuando el usuario vuelve a abrir el add-on. Apps Script no recibe webhooks por usuario, y un trigger por tiempo pediría `script.scriptapp` y corre como mucho una vez por hora. |
| **Exportación a Google Drive de la organización** (`storage-export.ts`, Ajustes → Integraciones) | Automática, de **todos** los sobres, en el momento en que se completan. Incluye el certificado de evidencia. | Usa **una** cuenta de Google de la organización y una carpeta fija (`drive.file`: solo ve lo que creó). No llega a la carpeta de cada usuario. |

**Recomendación**: para archivar todo, la exportación de la organización. La opción del add-on es para que el
firmado quede junto al original sin intervención de un administrador. Las dos se pueden usar a la vez.

## Instalación para pruebas (clasp)

Hace falta Node y [clasp](https://github.com/google/clasp) en la máquina de quien despliega, y la Apps Script API
habilitada en <https://script.google.com/home/usersettings>.

```bash
npm install -g @google/clasp && clasp login
curl -LO {{BASE_URL}}/integrations/connectors/google-workspace/calasign-google-workspace-addon.zip
unzip calasign-google-workspace-addon.zip -d calasign-gws && cd calasign-gws
clasp create --type standalone --title "CalaSign" --rootDir .
clasp push --force          # sube appsscript.json y src/*.js (ver .claspignore)
clasp open                  # abre el editor
```

En el editor de Apps Script, ir a **Implementar → Probar implementaciones → Google Workspace add-on → Instalar**. Después,
abrir Gmail, Docs o Drive: el ícono de CalaSign aparece en el panel lateral. El primer uso pide los permisos de Google y
después el inicio de sesión de CalaSign (o la API key).

Para otro entorno de CalaSign, hay que volver a compilar con `CALASIGN_BASE_URL=https://… corepack pnpm build:integrations`.
La URL queda fija en `src/Api.js` y en `appsscript.json`.

## Publicación en el Google Workspace Marketplace

1. **Proyecto de Google Cloud** (estándar, no el predeterminado de Apps Script):
   - Crearlo en console.cloud.google.com, por ejemplo con el nombre `calasign-workspace-addon`.
   - Habilitar la **Google Workspace Marketplace SDK**, la **Gmail API** y la **Google Drive API**.
   - En Apps Script, ir a *Configuración del proyecto → Proyecto de Google Cloud → Cambiar proyecto* y poner el número
     del proyecto.
2. **Pantalla de consentimiento de OAuth** (Google Auth Platform → Branding / Audience / Data access):
   - Tipo **Externo**, nombre «CalaSign» y logo de 120×120.
   - Dominio autorizado: el de CalaSign. Hay que verificarlo en Search Console.
   - Agregar las URLs de la página principal, la **política de privacidad** (hoy `{{BASE_URL}}/privacy` no existe; ver
     `integrations/README.md`) y los términos.
   - Declarar los 7 scopes del manifiesto, cada uno con su justificación (tabla de arriba).
3. **Verificación de scopes sensibles**: `gmail.addons.current.message.readonly` es sensible, así que Google pide:
   - un video en YouTube (no listado) que muestre el flujo completo y el pedido de permisos;
   - la justificación de cada scope;
   - el dominio verificado.

   Suele tardar de días a semanas. No hay scopes restringidos, así que **no** hace falta la evaluación CASA. Mientras no
   esté verificada, la app funciona para hasta 100 usuarios de prueba, que ven el aviso «app no verificada».
4. **Implementación versionada**: en Apps Script, *Implementar → Nueva implementación → Complemento* (o `clasp version`
   y `clasp deploy`). Anotar el **ID de implementación**.
5. **Marketplace SDK → Configuración de la app**:
   - Visibilidad **Pública** (o Privada, solo para el dominio).
   - Integración: **Complemento de Google Workspace → Proyecto de Apps Script**, con el ID de implementación.
   - Los mismos scopes del manifiesto.
   - Las URLs de soporte, privacidad y términos.
6. **Ficha de la tienda** (Store listing):
   - descripción en es/en/pt;
   - íconos de 32, 48, 96 y 128 px y banner de 220×140 (`integrations/assets/` tiene 32, 64 y 128: faltan 48, 96 y el
     banner);
   - 1 a 5 capturas de 1280×800;
   - categoría *Business tools / Productivity*.
7. **Enviar a revisión**. Google revisa la ficha y el funcionamiento, y la verificación OAuth del paso 3 tiene que estar
   aprobada. Una app interna (Privada) de un dominio se publica sin la revisión del Marketplace.

Un administrador de Google Workspace puede instalarla para toda la organización desde la consola de administración
(Apps → Google Workspace Marketplace apps). En ese caso, los usuarios no ven el pedido de permisos de Google.

## Pendiente / supuestos

- **Sin probar en Google real**: las pruebas (`integrations/test/connectors.mjs`) corren con GmailApp, UrlFetchApp,
  CardService, la librería OAuth2 y Drive simulados. Falta instalarlo con una implementación de prueba y verificar:
  - la redirección de vuelta de `/oauth/authorize` a `script.google.com/.../usercallback`;
  - el envío de un adjunto;
  - Docs con anclas;
  - Drive con la casilla de guardar (en particular, si `drive.file` deja crear el archivo en la carpeta del original o
    si cae en la copia).
- **COOP de la pantalla de consentimiento**: el botón de inicio de sesión abre la autorización en una ventana nueva y
  el add-on se recarga cuando esa ventana se cierra. Si la página de consentimiento (`Cross-Origin-Opener-Policy:
  same-origin`) corta el vínculo con la ventana de Google, el add-on puede no enterarse del cierre. En ese caso hay que
  volver a abrir el panel (la sesión ya quedó guardada). No se cambió el servidor OAuth.
- **Registro dinámico**: el add-on se registra con `token_endpoint_auth_method: "none"` y `grant_types`
  `authorization_code` + `refresh_token`. Si una instalación de CalaSign desactiva `/oauth/register`, hay que fijar
  `CALASIGN_CLIENT_ID` a mano.
- El PDF va en base64 dentro del JSON. El tope de la API alcanza para el máximo de subida, y el de UrlFetchApp es de 50 MB.
  Las acciones de Card Service tienen 30 s: con PDFs muy grandes o una red lenta, conviene subirlos desde CalaSign.
