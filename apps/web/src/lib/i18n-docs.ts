// Textos del portal de desarrolladores (/developers). Mismo mecanismo que el resto de la web (useI18n + diccionarios
// planos es / pt-BR / en), con dos diferencias: los diccionarios de pt-BR y en son Record<DocsKey, string> completos
// (TypeScript avisa si falta una traducción) y los textos admiten un marcado mínimo que renderiza <Md>/<Inline>:
// `código`, **negrita**, [enlace](url), párrafos separados por línea en blanco y listas con "- " o "1. ".
// Variables: {{BASE}} (origen de la API) y {{MCP_URL}}.
import { useCallback } from "react";
import { useI18n } from "./i18n";
import { docsPt } from "./i18n-docs-pt";
import { docsEn } from "./i18n-docs-en";
import { connectorsDocsEs } from "./i18n-docs-connectors";

export const docsEs = {
  // ───────── Interfaz ─────────
  "ui.docs": "Docs",
  "ui.searchPlaceholder": "Buscar en la documentación…",
  "ui.searchLabel": "Buscar",
  "ui.searchEmpty": "Sin resultados para «{q}».",
  "ui.searchHint": "Páginas, secciones y endpoints",
  "ui.searchEndpoints": "Endpoints",
  "ui.searchPages": "Páginas",
  "ui.menu": "Menú de la documentación",
  "ui.closeMenu": "Cerrar menú",
  "ui.onThisPage": "En esta página",
  "ui.copy": "Copiar",
  "ui.copied": "Copiado",
  "ui.copyCode": "Copiar código",
  "ui.linkTo": "Enlace a esta sección",
  "ui.prev": "Anterior",
  "ui.next": "Siguiente",
  "ui.openApp": "Ir a la app",
  "ui.getKey": "Crear API key",
  "ui.theme": "Tema",
  "ui.themeAuto": "Automático",
  "ui.themeLight": "Claro",
  "ui.themeDark": "Oscuro",
  "ui.skip": "Saltar al contenido",
  "ui.notFound": "No encontramos esa página de la documentación.",
  "ui.backHome": "Volver al inicio de la documentación",
  "ui.new": "Nuevo",
  "ui.download": "Descargar",
  "ui.required": "obligatorio",
  "ui.optional": "opcional",
  "ui.yes": "Sí",
  "ui.no": "No",
  // ───────── Navegación ─────────
  "nav.start": "Empezar",
  "nav.guides": "Guías",
  "nav.platform": "Plataforma",
  "nav.reference": "Referencia de la API",
  "nav.ai": "IA y agentes",
  // ───────── Introducción ─────────
  "intro.title": "Documentación para desarrolladores",
  "intro.nav": "Introducción",
  "intro.lead":
    "La API REST de CalaSign te permite enviar documentos a firmar, seguir cada firma en tiempo real y descargar el PDF sellado con su evidencia, desde tu propio sistema. Es la misma API que usa la web de CalaSign: todo lo que se puede hacer en la app se puede automatizar.",
  "intro.build.h": "Qué podés construir",
  "intro.build.send.t": "Enviar a firmar desde tu sistema",
  "intro.build.send.d": "Creá un sobre con uno o más PDF, agregá firmantes por email, WhatsApp o Telegram y envialo con un par de pedidos HTTP.",
  "intro.build.embed.t": "Firma dentro de tu app",
  "intro.build.embed.d": "Mostrá la ceremonia de firma en un iframe de tu aplicación, sin que el firmante salga de tu producto.",
  "intro.build.webhooks.t": "Reaccionar a cada evento",
  "intro.build.webhooks.d": "Recibí un POST firmado con HMAC cuando alguien abre, firma o rechaza, y cuando el sobre se completa.",
  "intro.build.templates.t": "Plantillas, envíos masivos y formularios",
  "intro.build.templates.d": "Prepará el documento una vez y reutilizalo: desde la API, en lote por CSV o con un link público.",
  "intro.build.ai.t": "Agentes de IA",
  "intro.build.ai.d": "Conectá Claude, ChatGPT o Gemini al servidor MCP de CalaSign para consultar y enviar sobres conversando.",
  "intro.build.xml.t": "Firma de facturas electrónicas",
  "intro.build.xml.d": "Firmá XML con los perfiles de la DGII (e-CF), la DIAN y la SUNAT con el certificado de tu organización.",
  "intro.base.h": "URL base y formato",
  "intro.base.p": "Todos los pedidos van por HTTPS al mismo origen de la web. La API vive bajo `/v1`.",
  "intro.base.col.what": "Qué",
  "intro.base.col.url": "URL",
  "intro.base.api": "API REST v1",
  "intro.base.spec": "Especificación OpenAPI 3.1",
  "intro.base.mcp": "Servidor MCP (agentes de IA)",
  "intro.base.oauth": "OAuth 2.0",
  "intro.base.conventions":
    "- Cuerpos en JSON (UTF-8) con `Content-Type: application/json`; los PDF se suben como `multipart/form-data`.\n- Identificadores UUID, fechas ISO 8601 en UTC (`2026-03-01T14:30:00.000Z`).\n- Autenticación con `Authorization: Bearer <API key o access token>` (ver [Autenticación](/developers/authentication)).\n- Errores siempre con la misma forma: `{ \"error\": { \"code\", \"message\", \"details\" } }` (ver [Errores](/developers/errors)).\n\nUn primer pedido para probar tu credencial: devuelve tu organización.",
  "intro.env.h": "Entornos y pruebas",
  "intro.env.p":
    "**{{BASE}}** es el entorno de desarrollo y pruebas. Creá una cuenta gratis, generá una API key y probá sin costo: las organizaciones nuevas de este entorno tienen todas las funciones habilitadas (API, webhooks, envíos masivos, pagos simulados, verificación de identidad simulada).\n\nLas API keys de este entorno empiezan con `cs_test_`; las de producción, con `cs_live_`. Cada entorno tiene sus propias cuentas, credenciales y datos: nada se comparte entre ellos.",
  "intro.env.mailbox.t": "Buzón de desarrollo",
  "intro.env.mailbox.p":
    "En el entorno de pruebas los correos y mensajes de WhatsApp o SMS no salen a internet: quedan en el **Buzón dev** de la app (menú superior → *Buzón dev*, ruta `/app/dev-mailbox`), con el link de firma de cada destinatario. Así podés abrir el link, firmar como si fueras el destinatario y ver llegar los webhooks, usando direcciones inventadas.",
  "intro.version.h": "Versiones",
  "intro.version.p":
    "La versión va en la ruta (`/v1`). Dentro de v1 agregamos endpoints, campos opcionales, valores de enumeraciones y tipos de evento sin cambiar de versión, así que tu integración tiene que **ignorar los campos que no conoce** y no fallar ante un `status` o un tipo de evento nuevo. Un cambio incompatible iría en una versión nueva de la ruta.\n\nLa especificación [`/v1/openapi.json`](/v1/openapi.json) siempre refleja lo que está desplegado: podés generar clientes a partir de ella (ver [SDKs](/developers/sdks)).",
  "intro.next.h": "Siguientes pasos",
  "intro.next.p":
    "1. Seguí el [inicio rápido](/developers/quickstart) para enviar tu primer sobre en cinco minutos.\n2. Leé los [conceptos](/developers/concepts): ciclo de vida del sobre, destinatarios, campos y evidencia.\n3. Configurá [webhooks](/developers/webhooks) para enterarte de cada firma sin consultar la API.\n4. Explorá la [referencia completa](/developers/api) o conectá un [agente de IA](/developers/ai).",
  // ───────── Inicio rápido ─────────
  "qs.title": "Inicio rápido",
  "qs.lead":
    "Con **una sola llamada** creás el sobre con el PDF, la firmante y el campo de firma, y lo enviás. Después esperás la firma y descargás el documento firmado. Necesitás `curl` (y `jq`), Node.js 18+ o Python 3.8+, y un PDF de prueba que contenga el texto `[[firma]]`.",
  "qs.key.h": "1. Conseguí una API key",
  "qs.key.p":
    "Creá una cuenta en [{{BASE}}/signup]({{BASE}}/signup) (o entrá con la tuya), andá a **Ajustes → API keys** ([`/app/settings/api-keys`](/app/settings/api-keys)) y tocá **Crear**. El secreto se muestra **una sola vez**: guardalo en un gestor de secretos o en una variable de entorno, nunca en el código ni en el frontend.",
  "qs.one.h": "2. Creá y enviá el sobre en una sola llamada",
  "qs.one.p":
    "`POST /v1/envelopes` recibe todo junto: los **documentos** (`documents`: el PDF en `base64`, por `url` https pública o como parte de un `multipart/form-data`), los **destinatarios** (`recipients`, igual que en `PUT /recipients`), los **campos** (`fields`, con texto ancla o coordenadas) y `send: true` para enviarlo en el mismo pedido.\n\nEs **atómico**: si algo falla (un PDF inválido, un texto ancla que no aparece, un firmante sin campo de firma) responde el error y no queda ningún sobre a medias. Mandá una `Idempotency-Key` (p. ej. el id de tu pedido) para que un reintento no cree ni envíe un segundo sobre. Sin `send`, el sobre queda en borrador (`draft`) para revisarlo y enviarlo después con `POST /v1/envelopes/{id}/send`.",
  "qs.one.resp":
    "La respuesta es el sobre completo, con los `id` de los documentos, los destinatarios y los campos (los vas a ver en los webhooks). En el entorno de pruebas la invitación queda en el **Buzón dev** de la app: abrila y firmá vos mismo. Si no indicás `expiresAt`, el sobre vence a los 30 días.",
  "qs.one.multipart.t": "PDF grandes: multipart en vez de base64",
  "qs.one.multipart.p":
    "En `multipart/form-data` el JSON va en la parte `payload` y cada PDF en su propia parte; el documento la cita con `file` (sin `documents`, cada archivo es un documento, en orden). Así el PDF no crece un 33 % por el base64. Hasta 10 documentos por llamada.",
  "qs.one.refs.t": "Varios firmantes y documentos",
  "qs.one.refs.p":
    "Como los destinatarios y documentos todavía no tienen `id`, cada campo los cita con `recipient` (su posición en `recipients` empezando en 0, su `ref` o su email) y `document` (su posición en `documents` o su `ref`). Con un solo firmante o un solo documento se pueden omitir; un campo con `anchor` y sin `document` busca el texto en todos los documentos.",
  "qs.fields.coords.t": "¿Tu PDF no tiene texto ancla?",
  "qs.fields.coords.p":
    "Usá coordenadas normalizadas: `page` empieza en 0 y `x`, `y`, `width`, `height` van de 0 a 1 con origen arriba a la izquierda de la página. Con varios documentos, indicá `document`.",
  "qs.one.embedded.t": "Firma embebida en tu app",
  "qs.one.embedded.p":
    "Si un destinatario va con `embedded: true` (firma dentro de tu aplicación, sin invitación), la respuesta de un envío trae `signingUrls`: la URL de firma de un solo uso (5 minutos) de cada firmante embebido al que ya le toca, sin otra llamada. `embeddedSigning` acepta `returnUrl` y `frameAncestors`. Ver la [guía de firma embebida](/developers/guides/embedded-signing).",
  "qs.one.template.t": "Desde una plantilla, también en una llamada",
  "qs.one.template.p":
    "Si el documento y los campos ya están en una [plantilla](/developers/guides/templates), `POST /v1/envelopes/from-template` crea el sobre asignando una persona a cada rol y, con `send: true`, lo envía en el mismo pedido. También admite `Idempotency-Key`.",
  "qs.wait.h": "3. Esperá la firma",
  "qs.wait.p":
    "La forma recomendada es un [webhook](/developers/webhooks): registrá una URL https en **Ajustes → Integraciones** y CalaSign te avisa con un POST firmado en cada evento. Cuando firma la última persona el sobre pasa por `finalizing` (se arma y sella el PDF) y después llega `envelope.completed`.\n\nSi preferís consultar, pedí `GET /v1/envelopes/{id}` cada tanto (no más de una vez por minuto por sobre) hasta que `envelope.status` sea `completed`, `declined`, `voided` o `expired`.",
  "qs.download.h": "4. Descargá el PDF firmado",
  "qs.download.p":
    "Con el sobre en `completed`, `signed.pdf` devuelve el PDF final: los documentos con las firmas estampadas, el **certificado de finalización** al final y el sello PAdES de la plataforma. Antes de completarse responde 404. Guardá también `signedSha256` para verificarlo en el futuro.",
  "qs.full.h": "Script completo",
  "qs.full.p":
    "Todo junto, listo para copiar: una llamada para crear y enviar, la espera y la descarga. El PDF `contrato.pdf` tiene que contener el texto `[[firma]]`.",
  "qs.full.next":
    "¿Y ahora? Usá [plantillas](/developers/guides/templates) para no ubicar campos a mano, [firma embebida](/developers/guides/embedded-signing) para firmar dentro de tu app, o revisá los [conceptos](/developers/concepts).",
  "qs.steps.h": "Paso a paso (varias llamadas)",
  "qs.steps.p":
    "Si preferís armar el sobre de a poco (por ejemplo, para que una persona lo revise en la app antes de enviarlo), los mismos datos se pueden mandar en llamadas separadas: crear el borrador, subir cada PDF, definir los destinatarios, ubicar los campos y enviar. Cada paso valida lo suyo y el sobre queda en `draft` hasta el envío.",
  "qs.create.h": "a. Creá el borrador",
  "qs.create.p":
    "Un **sobre** agrupa los documentos, los destinatarios y los campos. Con solo `subject` (y opcionalmente `message`, `metadata`, `expiresAt`…) nace como borrador (`draft`) vacío. Usá `metadata` para guardar tus propios identificadores (te vuelven en cada webhook) y mandá una `Idempotency-Key` para que un reintento no cree un sobre duplicado.",
  "qs.create.resp": "Guardá `envelope.id`: lo vas a usar en los pasos siguientes.",
  "qs.upload.h": "b. Subí el PDF",
  "qs.upload.p":
    "Enviá el archivo como `multipart/form-data` en el campo `file`. Podés subir varios PDF al mismo sobre: se firman en el orden en que los subiste. La respuesta trae el `id` del documento, su cantidad de páginas y su SHA-256.",
  "qs.recipients.h": "c. Agregá la firmante",
  "qs.recipients.p":
    "`PUT /recipients` reemplaza la lista completa. Por defecto cada destinatario es `signer`, recibe la invitación por `email` y tiene `routingOrder: 1`. Con `phone` en formato E.164 también le podés avisar por WhatsApp. Podés mandar tu propio `id` (UUID) para referenciarlo desde los campos sin leer la respuesta; si no, tomalo de `recipients[].id`.",
  "qs.fields.h": "d. Ubicá los campos",
  "qs.fields.p":
    "Cada firmante necesita al menos un campo. La forma más simple es un **texto ancla**: escribí `[[firma]]` en el PDF (puede ir en blanco sobre blanco) y CalaSign pone el campo donde aparezca. `offsetX`, `offsetY`, `width` y `height` van en puntos PDF, relativos a la esquina superior izquierda del texto. Reemplazá `RECIPIENT_ID` por el id de la firmante.",
  "qs.send.h": "e. Envialo",
  "qs.send.p":
    "Al enviar se validan los documentos, los destinatarios y los campos; el sobre pasa a `sent` y les llega la invitación a los firmantes del primer turno. En el entorno de pruebas la invitación queda en el **Buzón dev** de la app: abrila y firmá vos mismo.",
  "qs.c.one": "Sobre completo en una llamada: PDF, firmante, campo de firma sobre [[firma]] y envío",
  "qs.c.multipart": "Lo mismo sin base64: el JSON en la parte payload y el PDF en su propia parte",
  "qs.c.noBase64": "el PDF va sin base64",
  "qs.c.wait": "Esperar la firma (mejor con un webhook)",
  "qs.c.download": "Descargar el PDF firmado",
  "qs.c.sdkIdem": "el SDK agrega la Idempotency-Key solo",
  // ───────── Autenticación ─────────
  "auth.title": "Autenticación",
  "auth.lead":
    "Todos los pedidos a la API llevan `Authorization: Bearer <credencial>`. La credencial puede ser una API key de tu organización o un access token OAuth 2.0. El acceso por API (keys, OAuth y MCP) está incluido desde el plan Starter.",
  "auth.cmp.method": "Credencial",
  "auth.cmp.when": "Cuándo usarla",
  "auth.cmp.format": "Formato",
  "auth.cmp.key": "Tu propio backend integrado con tu propia organización. Lo más simple.",
  "auth.cmp.cc": "Servicio a servicio con scopes acotados y tokens que vencen en 1 hora.",
  "auth.cmp.code": "Una app que actúa en nombre de usuarios de otras organizaciones (marketplace, agentes de IA).",
  "auth.keys.h": "API keys",
  "auth.keys.p":
    "Se crean en **Ajustes → API keys** ([`/app/settings/api-keys`](/app/settings/api-keys)) o con `POST /v1/api-keys` desde una sesión. El secreto completo se muestra **una sola vez**; después solo se ve su prefijo (los primeros 12 caracteres) y la fecha de último uso.\n\n- Formato: `cs_test_…` en el entorno de pruebas y `cs_live_…` en producción.\n- Cada key pertenece a la organización y tiene un **rol** (`admin`, `member` o un rol personalizado) que define qué puede hacer; nadie puede crear una key con más permisos que los propios.\n- Los sobres creados con una key quedan registrados como creados por la API (`createdVia: \"api\"`) y la evidencia nombra a la key como actor.",
  "auth.keys.rotate.h": "Rotación y revocación",
  "auth.keys.rotate.p":
    "Las keys no vencen. Para rotar una: creá una nueva, desplegala en tu sistema, verificá en la lista que la vieja dejó de usarse (*último uso*) y revocala con **Revocar** o `DELETE /v1/api-keys/{id}`. La revocación es inmediata: el próximo pedido con esa key recibe `401 unauthorized`.",
  "auth.keys.warn":
    "Una API key da acceso a toda la organización según su rol. Nunca la pongas en una app móvil, en JavaScript del navegador ni en un repositorio. Si una key se filtra, revocala enseguida.",
  "auth.oauth.h": "OAuth 2.0",
  "auth.oauth.p":
    "Registrá una aplicación en **Ajustes → Apps OAuth** ([`/app/settings/oauth-apps`](/app/settings/oauth-apps)) o con `POST /v1/oauth/apps`. Recibís un `client_id` (`csapp_…`) y, si la app es **confidencial**, un `client_secret` (`cssec_…`, se muestra una vez; se puede rotar). Una app **pública** (escritorio, móvil, SPA) no tiene secreto y solo puede usar authorization code con PKCE.\n\nLos tokens son opacos: access token `csat_…` válido por **1 hora**, refresh token `csrt_…` válido por **30 días** y código de autorización válido por **10 minutos**. Los errores de `/oauth/*` siguen RFC 6749: `{ \"error\": \"invalid_grant\", \"error_description\": \"…\" }`.",
  "auth.ep.endpoint": "Endpoint",
  "auth.ep.use": "Para qué",
  "auth.ep.authorize": "Pantalla de consentimiento en el navegador (authorization code + PKCE).",
  "auth.ep.token": "Emitir tokens: `authorization_code`, `client_credentials` y `refresh_token`. Cuerpo `application/x-www-form-urlencoded` (también acepta JSON).",
  "auth.ep.revoke": "Revocar un token (RFC 7009). Revocar un refresh token revoca toda la autorización. Un token desconocido o de otra app también responde 200.",
  "auth.ep.introspect": "Consultar si un token está vigente (RFC 7662). Solo clientes confidenciales y tokens de la misma app.",
  "auth.ep.register": "Registro dinámico de clientes (RFC 7591), pensado para agentes de IA y clientes MCP.",
  "auth.code.h": "Authorization code + PKCE",
  "auth.code.p":
    "Para actuar en nombre de una persona: la redirigís a la pantalla de consentimiento de CalaSign, inicia sesión si hace falta y aprueba los scopes, y vuelve a tu `redirect_uri` con `code` y `state`. **PKCE con S256 es obligatorio**, incluso para clientes confidenciales. La `redirect_uri` tiene que coincidir exactamente con una registrada.\n\nEl cliente se autentica con HTTP Basic (`client_id:client_secret`) o con `client_id` y `client_secret` en el cuerpo. Un cliente público manda solo `client_id`.",
  "auth.code.c.pkce": "PKCE: verifier aleatorio y su challenge S256",
  "auth.code.c.redirect": "Redirigir a la persona a la pantalla de consentimiento",
  "auth.code.c.exchange": "En tu callback: verificar state y canjear el código",
  "auth.code.c.callback": "que recibiste en el callback",
  "auth.code.c.public": "omitir en un cliente público",
  "auth.code.after":
    "Si la persona rechaza, vuelve con `error=access_denied`. Si pediste `offline_access` recibís además un `refresh_token`. Un código se puede canjear una sola vez: si se reutiliza, CalaSign revoca los tokens que se emitieron con él.",
  "auth.cc.h": "Client credentials",
  "auth.cc.p":
    "Para integraciones servidor a servidor sin una persona presente. Al registrar la app con el grant `client_credentials` se le asigna un rol (por defecto `member`) que funciona como una identidad de servicio. No hay refresh token: pedí uno nuevo cuando el actual venza (`expires_in` = 3600). Si omitís `scope` recibís todos los scopes habilitados para la app (sin `offline_access`).",
  "auth.refresh.h": "Renovación y rotación de tokens",
  "auth.refresh.p":
    "Cada uso de un refresh token devuelve un access token **y un refresh token nuevos**; el anterior deja de valer y el access token anterior de la misma autorización queda revocado. Guardá siempre el último refresh token que recibiste. Podés pedir menos scopes que los originales, nunca más.",
  "auth.refresh.warn":
    "Si un refresh token ya canjeado vuelve a aparecer, CalaSign lo trata como robado y revoca **toda** la autorización: la persona tiene que volver a aprobar la app. Evitá renovar en paralelo desde varios procesos con el mismo refresh token.",
  "auth.scopes.h": "Scopes",
  "auth.scopes.p":
    "Los scopes limitan lo que puede hacer un token, además del rol del usuario o de la app: un token nunca puede más que la persona que lo aprobó. Pedí solo los que necesites. Un endpoint fuera de los scopes del token responde `403 insufficient_scope` con `details.requiredScope`.",
  "auth.scopes.col.desc": "Permite",
  "auth.dcr.h": "Registro dinámico de clientes",
  "auth.dcr.p":
    "Los clientes MCP (Claude, ChatGPT, Gemini CLI, el MCP Inspector) se registran solos con `POST /oauth/register` (RFC 7591), sin que nadie tenga que crear una app a mano. El registro no requiere autenticación y crea un cliente que solo puede usar `authorization_code` + `refresh_token`.",
  "auth.dcr.req": "Pedido",
  "auth.dcr.resp": "Respuesta",
  "auth.dcr.rules":
    "- `token_endpoint_auth_method`: `none` (cliente público, lo normal en agentes y apps de escritorio), `client_secret_post` o `client_secret_basic`. Con los dos últimos la respuesta incluye `client_secret`, que se muestra una sola vez.\n- `redirect_uris`: solo `https://…` o direcciones de loopback (`http://127.0.0.1:<puerto>/…`, `http://localhost:<puerto>/…`).\n- PKCE con `S256` es obligatorio en todas las autorizaciones.\n- El cliente registrado no tiene acceso a nada hasta que una persona lo aprueba en la pantalla de consentimiento.",
  "auth.resource.h": "Indicadores de recurso (RFC 8707)",
  "auth.resource.p":
    "Los clientes MCP mandan el parámetro `resource` con la URL del servidor MCP (`{{MCP_URL}}`) en `/oauth/authorize` y en `/oauth/token`, para pedir un token destinado a ese recurso. CalaSign lo acepta en ambos pasos; no hace falta que lo mandes si llamás a la API REST directamente.",
  "auth.discovery.h": "Descubrimiento",
  "auth.discovery.p":
    "Los metadatos estándar permiten que un cliente configure OAuth solo a partir de la URL del servidor MCP. Cuando un pedido a `/mcp` llega sin credencial, la respuesta `401` trae `WWW-Authenticate: Bearer resource_metadata=\"…\"` apuntando a estos documentos.",
  "auth.disc.prm": "Metadatos del recurso protegido (RFC 9728): recurso, servidor de autorización y scopes.",
  "auth.disc.as": "Metadatos del servidor de autorización (RFC 8414): endpoints, grants, métodos de autenticación y PKCE.",
  // ───────── Conceptos ─────────
  "concepts.title": "Conceptos",
  "concepts.lead": "El modelo de CalaSign en una página: sobres, destinatarios, documentos, campos, plantillas y la evidencia que respalda cada firma.",
  "concepts.col.meaning": "Significado",
  "concepts.lifecycle.h": "Ciclo de vida del sobre",
  "concepts.lifecycle.p":
    "Un **sobre** (*envelope*) es la unidad que se envía a firmar: uno o más PDF, sus destinatarios y los campos de cada uno. Mientras está en `draft` se puede modificar todo; una vez enviado solo se puede [corregir](/developers/guides/reminders#corrections) dentro de ciertos límites.",
  "concepts.lifecycle.alt.t": "Estados del sobre",
  "concepts.lifecycle.alt.d":
    "draft pasa a sent al enviar. Desde sent puede pasar a finalizing cuando firman todos, a awaiting_certificates si hay firmas con certificado pendientes, o terminar en declined, expired o voided. finalizing termina en completed. awaiting_certificates vuelve a finalizing o puede anularse.",
  "concepts.lifecycle.caption": "Estados finales: completed, declined, voided y expired.",
  "concepts.status.draft": "Borrador. Se pueden cambiar documentos, destinatarios, campos y opciones. Se puede borrar.",
  "concepts.status.sent": "Enviado y en curso: los destinatarios del turno actual tienen su invitación.",
  "concepts.status.finalizing":
    "Firmaron todos. CalaSign está armando el PDF final, el certificado de finalización y el sello. Suele durar segundos; después pasa a `completed`. Si un cobro con `after_sign` está pendiente, el sobre espera al pago antes de este paso.",
  "concepts.status.completed": "Terminado. El PDF sellado está disponible en `GET /v1/envelopes/{id}/signed.pdf` y `signedSha256` tiene su hash.",
  "concepts.status.declined": "Un firmante o aprobador rechazó. El motivo queda en `recipients[].declineReason`.",
  "concepts.status.voided": "El remitente lo anuló (`POST /v1/envelopes/{id}/void`) con un motivo. Los pendientes reciben un aviso.",
  "concepts.status.expired": "Llegó `expiresAt` sin que firmaran todos. Por defecto un sobre vence a los 30 días de creado.",
  "concepts.status.awaiting_certificates":
    "Todos firmaron electrónicamente y faltan las [firmas con certificado digital](/developers/guides/certificate-signing). Se pueden anular.",
  "concepts.recipients.h": "Destinatarios y roles",
  "concepts.recipients.p":
    "Un destinatario (*recipient*) es una persona con un rol. No necesita cuenta en CalaSign: recibe un link personal por email, WhatsApp o Telegram (o firma dentro de tu app con [firma embebida](/developers/guides/embedded-signing)). Un sobre admite hasta 50 destinatarios.",
  "concepts.role.signer": "Firma y completa sus campos. Es el rol por defecto. Es el único rol que puede tener campos.",
  "concepts.role.approver": "Revisa y aprueba (o rechaza) sin campos en el documento. Genera el evento `recipient.approved`.",
  "concepts.role.cc": "Recibe una copia del documento firmado cuando el sobre se completa. No firma ni aprueba.",
  "concepts.rstatus.h": "Estado de cada destinatario",
  "concepts.rstatus.created": "Todavía no le toca (espera su turno de `routingOrder`) o el sobre está en borrador.",
  "concepts.rstatus.sent": "Recibió la invitación.",
  "concepts.rstatus.viewed": "Abrió el link.",
  "concepts.rstatus.signed": "Firmó (o aprobó, si es `approver`).",
  "concepts.rstatus.declined": "Rechazó; el sobre pasa a `declined`.",
  "concepts.rstatus.completed": "Copia (`cc`) que ya recibió el documento final.",
  "concepts.rstatus.delegated": "Delegó la firma en otra persona (si el sobre lo permite con `allowDelegation`). `replacedBy` apunta al nuevo destinatario.",
  "concepts.rstatus.reassigned": "El remitente lo reemplazó por otra persona. `replacedBy` apunta al nuevo destinatario.",
  "concepts.channels.h": "Canales de notificación",
  "concepts.channels.p":
    "`channels` define por dónde llega la invitación: {channels}. `email` necesita `email`; `whatsapp` necesita `phone` en formato E.164 (`+5491122334455`); `telegram` necesita `telegramChatId` o, si no lo tenés, otro canal para mandar el link de vinculación. Con `embedded: true` o `inPerson` el destinatario no recibe invitaciones. `locale` (`es`, `pt-BR`, `en`) define el idioma de los mensajes y de la página de firma.",
  "concepts.routing.h": "Orden de firma",
  "concepts.routing.p":
    "`routingOrder` (1 a 100) define los turnos. Todos los destinatarios con el mismo número reciben la invitación a la vez (firma en **paralelo**); el turno siguiente se activa recién cuando terminó el anterior (firma en **secuencia**). Combinando números armás flujos mixtos. Las copias (`cc`) reciben el documento al final, sin importar su número.",
  "concepts.routing.example": "Aprobación interna, después dos firmantes en paralelo y una copia",
  "concepts.documents.h": "Documentos",
  "concepts.documents.p":
    "Un sobre tiene uno o más PDF (`POST /v1/envelopes/{id}/documents`, multipart, campo `file`). CalaSign normaliza cada archivo al subirlo y guarda dos hashes en la evidencia: el del archivo original y el del normalizado, que es el que se muestra y se firma. Así lo que ve el firmante es exactamente lo que firma. El detalle del documento trae `pageCount`, el tamaño de cada página (`pages[]`, en puntos) y `sha256`.",
  "concepts.fields.h": "Campos",
  "concepts.fields.p":
    "Los campos se ubican en el documento con coordenadas normalizadas — `page` desde 0 y `x`, `y`, `width`, `height` entre 0 y 1 con origen arriba a la izquierda — o con un [texto ancla](/developers/guides/anchors). `PUT /v1/envelopes/{id}/fields` reemplaza todos los campos (hasta 500). Cada campo es de un firmante (`recipientId`) y es obligatorio salvo `required: false`. El remitente puede prellenarlo con `value` y bloquearlo con `readOnly: true`.",
  "concepts.field.signature": "Firma (dibujada o tipeada por el firmante).",
  "concepts.field.initials": "Iniciales.",
  "concepts.field.date_signed": "Fecha de firma. La completa CalaSign al firmar.",
  "concepts.field.name": "Nombre del destinatario. Lo completa CalaSign.",
  "concepts.field.email": "Email del destinatario. Lo completa CalaSign.",
  "concepts.field.text": "Texto libre. Se puede prellenar.",
  "concepts.field.checkbox": "Casilla de verificación.",
  "concepts.field.number": "Número, con rango opcional (`min`, `max`) o calculado con `formula`. Se puede prellenar.",
  "concepts.field.dropdown": "Lista desplegable: requiere `options` (hasta 50). Se puede prellenar.",
  "concepts.field.company": "Empresa. Se puede prellenar.",
  "concepts.field.title": "Cargo. Se puede prellenar.",
  "concepts.field.attachment": "El firmante adjunta un archivo (PDF, PNG o JPEG, hasta 10 MB).",
  "concepts.logic.h": "Campos condicionales y calculados",
  "concepts.logic.p":
    "`conditions` (hasta 10, se tienen que cumplir todas) muestra un campo —y lo exige, si es obligatorio— solo según el valor de otro: operadores `equals`, `not_equals`, `checked`, `unchecked` y `filled`, referenciando el `id` del otro campo (por eso conviene mandar ids propios). `formula` calcula un campo `number` a partir de otros campos número citados por etiqueta: `{Precio} * {Cantidad} * 1.18`.",
  "concepts.templates.h": "Plantillas",
  "concepts.templates.p":
    "Una **plantilla** guarda documentos, campos y **roles** (por ejemplo «Cliente» y «Empresa») sin personas concretas. Al usarla con `POST /v1/envelopes/from-template` asignás una persona a cada rol, podés prellenar campos por etiqueta y enviar en el mismo pedido. Es la base del [envío masivo](/developers/guides/bulk-send), los [formularios web](/developers/guides/web-forms), las integraciones con CRM y la herramienta MCP `create_envelope_from_template`. Ver la [guía de plantillas](/developers/guides/templates).",
  "concepts.evidence.h": "Evidencia y certificado de finalización",
  "concepts.evidence.p":
    "Cada acción sobre un sobre (creación, envío, apertura, consentimiento, firma, rechazo, anulación…) se registra como un evento con actor, IP, user agent y fecha, **encadenado por hash** con el anterior: si alguien alterara un evento, la cadena dejaría de verificar. Consultalo con `GET /v1/envelopes/{id}/events` (cada evento trae su `hash`).\n\nAl completarse, el PDF final incluye un **certificado de finalización**: participantes, método de autenticación, IPs y horarios de cada paso, hashes de los documentos y el resumen de la cadena de evidencia.",
  "concepts.evidence.agent":
    "Las acciones que hace un agente de IA a través del [servidor MCP](/developers/ai/mcp) quedan en la evidencia con el actor «agente IA (<nombre del cliente>)», seguido de la credencial que usó.",
  "concepts.pades.h": "Sello PAdES",
  "concepts.pades.p":
    "El PDF final lleva una firma digital de la plataforma en formato **PAdES** (firma CAdES dentro del PDF), con la clave del sello en un HSM/KMS. Cualquier lector de PDF puede comprobar que el archivo no cambió desde que se selló. El nivel se elige por organización (`PATCH /v1/settings/evidence`; por defecto `auto`) y una organización puede sumar su propio **sello de empresa** con su certificado (`PUT /v1/envelopes/{id}/seal-options`). Las capas posteriores se agregan como revisiones incrementales, sin tocar lo ya firmado.",
  "concepts.pades.col.level": "Nivel",
  "concepts.pades.col.adds": "Qué agrega",
  "concepts.pades.bb": "Firma básica con el certificado del sello.",
  "concepts.pades.bt": "Sello de tiempo RFC 3161 de una autoridad de sellado de tiempo: prueba cuándo se firmó.",
  "concepts.pades.blt": "Certificados, OCSP y CRL incrustados: se puede validar aunque la CA ya no responda.",
  "concepts.pades.blta": "Sello de tiempo de documento que protege todo lo anterior; se renueva antes de que venza para archivo de largo plazo.",
  "concepts.verify.h": "Verificación",
  "concepts.verify.p":
    "Cualquier persona puede comprobar un documento en la página pública [`/verify`](/verify), sin cuenta: CalaSign busca el SHA-256 del archivo entre los documentos que selló y muestra la organización, los participantes, el sello y el estado de la cadena de evidencia; además valida cada firma del PDF (integridad, sello de tiempo, cadena de certificados y revocación). Por API: `POST /v1/verify` (búsqueda por hash) y `POST /v1/validate` (validación de firmas), ambos públicos y con `multipart` campo `file`.",
  // ───────── Guía: plantillas ─────────
  "g.tpl.title": "Enviar con plantillas",
  "g.tpl.lead":
    "Si mandás siempre el mismo documento, armalo una vez como plantilla —en la app (**Plantillas**) o por API— y después creá cada sobre con un solo pedido, indicando solo las personas y los datos que cambian.",
  "g.tpl.roles.h": "Plantillas y roles",
  "g.tpl.roles.p":
    "Una plantilla se arma igual que un sobre: `POST /v1/templates` (nombre, asunto y mensaje por defecto), `POST /v1/templates/{id}/documents` para cada PDF, `PUT /v1/templates/{id}/roles` y `PUT /v1/templates/{id}/fields` (los campos van por `roleId` en lugar de `recipientId`). También podés convertir un sobre existente en plantilla con `POST /v1/templates/from-envelope/{envelopeId}`.\n\nLos **roles** son los lugares que después ocupan personas reales. Tienen `name`, `role` (`signer`, `approver` o `cc`) y `routingOrder`.",
  "g.tpl.roles.list": "Para usar una plantilla necesitás su `id` y el nombre de sus roles: los dos vienen en el listado.",
  "g.tpl.send.h": "Crear un sobre desde una plantilla",
  "g.tpl.send.p":
    "`POST /v1/envelopes/from-template` copia documentos, campos y roles, asigna cada destinatario a su rol (por `role`, el nombre, sin distinguir mayúsculas, o por `roleId`) y devuelve el detalle del sobre nuevo. Todos los roles tienen que tener una persona: si falta alguno, la respuesta es `422 roles_missing`. Con `send: true` el sobre se envía en el mismo pedido; sin él queda en borrador para que lo revises o le agregues un cobro.",
  "g.tpl.send.idem":
    "Este endpoint no aplica `Idempotency-Key`: un reintento después de un timeout puede crear un segundo sobre. Si necesitás reintentos seguros, creá el sobre sin `send`, guardá su `id` (o buscalo por `metadata`) y envialo con `POST /v1/envelopes/{id}/send`, que sí es idempotente.",
  "g.tpl.prefill.h": "Prellenar campos",
  "g.tpl.prefill.p":
    "`prefill` es un objeto `{ \"clave\": \"valor\" }` donde la clave es el `id` de un campo de la plantilla o su **etiqueta** (`label`, sin distinguir mayúsculas). Si varios campos comparten etiqueta, se completan todos. Una clave que no coincide con ningún campo devuelve `400 unknown_prefill`. Los campos con `readOnly` en la plantilla quedan bloqueados para el firmante.",
  // ───────── Guía: firma embebida ─────────
  "g.embed.title": "Firma embebida",
  "g.embed.lead":
    "Mostrá la firma dentro de tu aplicación, en un iframe, para personas que ya iniciaron sesión en tu producto. El destinatario no recibe correos: tu backend pide una URL de un solo uso cada vez que la persona va a firmar.",
  "g.embed.s1": "Autorizá los orígenes de tu app que pueden mostrar el iframe.",
  "g.embed.s2": "Marcá al destinatario con `embedded: true` y enviá el sobre.",
  "g.embed.s3": "Cuando la persona va a firmar, tu backend pide una URL de firma (vence en 5 minutos, sirve una vez).",
  "g.embed.s4": "Tu frontend la abre en un iframe y escucha los eventos por `postMessage`.",
  "g.embed.origins.h": "1. Autorizar orígenes",
  "g.embed.origins.p":
    "La página de firma solo se puede enmarcar desde los orígenes que autorice tu organización (se aplican como `frame-ancestors` del CSP). Cargalos en **Ajustes → Integraciones → Firma embebida** o por API: hasta 20 orígenes `https://dominio[:puerto]` sin ruta, con comodín de subdominio (`https://*.tuempresa.com`). En el entorno local se admite `http://localhost`.",
  "g.embed.recipient.h": "2. Destinatario embebido",
  "g.embed.recipient.p":
    "Con `embedded: true` el destinatario no recibe invitaciones ni recordatorios y no necesita `email` ni `phone` (podés mandarlos igual para que figuren en la evidencia). Enviá el sobre como siempre.",
  "g.embed.url.h": "3. Pedir la URL de firma",
  "g.embed.url.p":
    "Pedila **justo antes** de mostrarla: vence a los 5 minutos y se consume al abrirla. El sobre tiene que estar enviado (si no, `409 not_available`). Si todavía no es el turno del destinatario según `routingOrder`, puede abrir el documento pero firma recién cuando le toque. `returnUrl` (opcional, https) es adonde se redirige el iframe al terminar, con `?event=signing_complete|declined&envelopeId=…`. `frameAncestors` (opcional) restringe esta sesión a un subconjunto de los orígenes autorizados.",
  "g.embed.iframe.h": "4. Mostrarla en un iframe",
  "g.embed.iframe.p":
    "Verificá siempre el origen del mensaje. Usá el origen de la URL que recibiste: si tu organización tiene [dominio propio](/developers/guides/custom-domain), la URL usa ese dominio.",
  "g.embed.events.h": "Eventos postMessage",
  "g.embed.ev.viewed": "La persona abrió el documento.",
  "g.embed.ev.complete": "Firmó (o aprobó). Recibís también el webhook `recipient.signed`.",
  "g.embed.ev.declined": "Rechazó el documento.",
  "g.embed.ev.error": "El link no es válido o ya venció: pedí una URL nueva.",
  "g.embed.events.p":
    "Cada mensaje es `{ source: \"calasign\", type, envelopeId, recipientId }` y se envía una sola vez por tipo. Tratá los eventos del navegador como una señal para la interfaz: la confirmación de negocio son los [webhooks](/developers/webhooks), que van firmados.",
  "g.embed.security":
    "Con firma embebida, **tu aplicación** es la que autentica a la persona: la evidencia registra que la sesión la abrió tu integración («autenticada por el integrador»). Pedí la URL solo para la persona que inició sesión y que corresponde a ese destinatario.",
  // ───────── Guía: anclas ─────────
  "g.anchor.title": "Campos por texto ancla",
  "g.anchor.lead":
    "En lugar de calcular coordenadas, escribí marcadores en el documento (por ejemplo `[[firma_cliente]]`) y dejá que CalaSign ubique los campos. Ideal para PDF que genera tu sistema.",
  "g.anchor.how.h": "Cómo funciona",
  "g.anchor.how.p":
    "En `PUT /v1/envelopes/{id}/fields`, un campo puede llevar `anchor` en lugar de `page`/`x`/`y`. CalaSign busca el texto en los documentos y crea **un campo por cada aparición**. Podés mezclar campos por ancla y por coordenadas en el mismo pedido. Todas las propiedades del campo (`required`, `label`, `value`, `readOnly`, `options`, `min`, `max`, `conditions`, `formula`) se copian a cada campo generado.",
  "g.anchor.options.h": "Opciones",
  "g.anchor.col.prop": "Propiedad",
  "g.anchor.col.default": "Por defecto",
  "g.anchor.o.text": "Texto a buscar (1 a 100 caracteres).",
  "g.anchor.o.size": "Tamaño del campo en puntos PDF (1 pt = 1/72 de pulgada). Obligatorios.",
  "g.anchor.o.offset": "Desplazamiento en puntos desde la esquina superior izquierda del texto encontrado. Negativo = hacia arriba o a la izquierda.",
  "g.anchor.o.case": "Distinguir mayúsculas y minúsculas.",
  "g.anchor.o.ignore": "Si es `false` y el texto no aparece, el pedido falla con `400 anchor_not_found`. Con `true` el campo simplemente no se crea.",
  "g.anchor.o.alldocs": "todos",
  "g.anchor.o.doc": "Buscar solo en ese documento.",
  "g.anchor.tips.h": "Consejos",
  "g.anchor.tips.p":
    "- Usá marcadores únicos y difíciles de confundir: `[[firma_1]]`, `\\s1\\`. Un texto que aparece en el cuerpo del contrato crearía campos de más.\n- Podés escribir el marcador en blanco sobre fondo blanco o en un tamaño de letra muy chico: sigue siendo texto y se encuentra igual.\n- Un PDF escaneado (solo imagen) no tiene texto: ahí hay que usar coordenadas.\n- Los campos generados vuelven en la respuesta con sus coordenadas normalizadas: guardalas si querés reutilizarlas.\n- PDF muy pesados pueden responder `422 pdf_too_heavy`; si el lector está ocupado, `503 pdf_reader_busy` (reintentá).",
  // ───────── Guía: envío masivo ─────────
  "g.bulk.title": "Envío masivo",
  "g.bulk.lead":
    "Mandá la misma plantilla a cientos de personas —hasta 5.000 filas por envío— y CalaSign crea y envía un sobre por fila en segundo plano. Disponible desde el plan Business.",
  "g.bulk.csv.h": "Con un CSV",
  "g.bulk.csv.p":
    "Bajá el CSV de ejemplo de la plantilla: trae una columna por dato de cada rol (`Rol.name`, `Rol.email`, `Rol.phone`, `Rol.channels`) y una por campo prellenable (`field.Etiqueta`), más `subject` opcional por fila. En `channels` separá varios canales con `;`.",
  "g.bulk.validate":
    "Antes de enviar podés validar sin crear nada con `POST /v1/bulk-sends/validate` (mismo cuerpo): responde `{ total, valid, invalid, errors: [{ row, errors }], columns }`. Al crear, si hay filas inválidas la respuesta es `422 rows_invalid` con ese mismo detalle, salvo que mandes `skipInvalid: true`: entonces se envían las válidas y las otras quedan como fallidas.",
  "g.bulk.json.h": "Con filas JSON",
  "g.bulk.json.p": "En lugar de `csv` podés mandar `rows` (uno de los dos). Cada fila admite destinatarios por rol, `prefill`, un `subject` propio y `metadata`, que se guarda en el sobre y te vuelve en los webhooks.",
  "g.bulk.track.h": "Seguimiento",
  "g.bulk.track.p":
    "La respuesta es el envío masivo con su estado (`queued`, `running`, `completed`, `cancelled`) y contadores (`total`, `sent`, `failed`, `pending`). Consultá `GET /v1/bulk-sends/{id}`, el detalle por fila con `GET /v1/bulk-sends/{id}/items` (filtrable por `status`) o bajá `results.csv`. `POST /v1/bulk-sends/{id}/cancel` frena las filas que todavía no se procesaron. Cada sobre creado dispara sus propios webhooks.",
  // ───────── Guía: formularios web ─────────
  "g.forms.title": "Formularios web",
  "g.forms.lead":
    "Un link público (`/f/<slug>`) donde cualquier persona completa sus datos y firma un documento de una plantilla: altas de clientes, consentimientos, inscripciones. Cada uso crea un sobre. Disponible desde el plan Business.",
  "g.forms.create.h": "Crear el formulario",
  "g.forms.create.p":
    "Elegí la plantilla y el **rol que toma quien completa el formulario** (`signerRoleId`, tiene que ser firmante). Los demás roles se cubren con `fixedRecipients` (por ejemplo, el representante de tu empresa). Opciones: `prefill`, `maxUses`, `expiresAt`, `requireOtp` (pide un código por correo antes de mostrar el documento), `collectPhone` y `embeddable` (se puede mostrar en un iframe desde tus orígenes autorizados).",
  "g.forms.share.h": "Compartirlo y seguirlo",
  "g.forms.share.p":
    "La respuesta trae `url`, el link público para compartir. `GET /v1/web-forms/{id}/envelopes` lista los sobres que generó y `uses` cuenta los usos. Para pausarlo, `PATCH /v1/web-forms/{id}` con `active: false`. Si quien lo creó deja la organización o pierde acceso a la plantilla, el formulario deja de crear sobres y `ownerInactiveReason` explica por qué.",
  // ───────── Guía: recordatorios ─────────
  "g.rem.title": "Recordatorios, vencimiento y correcciones",
  "g.rem.lead": "Cómo insistir con quien no firmó, cuándo vence un sobre y qué se puede cambiar después de enviarlo.",
  "g.rem.auto.h": "Recordatorios automáticos",
  "g.rem.auto.p":
    "Al crear o editar el borrador: `reminderEveryDays` (1 a 60) reenvía la invitación cada N días a quienes tienen su turno pendiente; `expiryWarningDays` avisa N días antes del vencimiento; `allowDelegation` permite que el firmante delegue en otra persona. `null` desactiva cada opción.",
  "g.rem.manual.h": "Recordatorio manual",
  "g.rem.manual.p":
    "`POST /v1/envelopes/{id}/remind` reenvía ya mismo la invitación a los pendientes del turno actual y devuelve cuántos se notificaron. Si el sobre está en `awaiting_certificates`, le avisa al firmante con certificado al que le toca. Un sobre que no está en curso responde `409 not_in_progress`.",
  "g.rem.exp.h": "Vencimiento",
  "g.rem.exp.p":
    "`expiresAt` (ISO 8601 con zona horaria) define hasta cuándo se puede firmar. Si no lo indicás, el sobre vence **30 días** después de creado. Al vencer pasa a `expired` y se dispara `envelope.expired`. Para extenderlo en un sobre en curso, usá una corrección.",
  "g.rem.corr.h": "Correcciones y reasignación",
  "g.rem.corr.p":
    "`POST /v1/envelopes/{id}/corrections` cambia un sobre en curso sin anularlo: mensaje, vencimiento, datos de contacto (se revoca el link anterior y se manda uno nuevo), destinatarios y campos nuevos para turnos que no empezaron, y bajas de quienes todavía no abrieron el sobre. Quien ya firmó no se puede tocar. `reason` queda en la evidencia.",
  "g.rem.reassign":
    "Para reemplazar a un destinatario pendiente por otra persona, usá la reasignación: el original queda como `reassigned` y el nuevo recibe la invitación.",
  // ───────── Guía: certificado ─────────
  "g.cert.title": "Firma con certificado digital",
  "g.cert.lead":
    "Un firmante puede firmar además con **su propio certificado digital** —token USB o tarjeta (PKCS#11), certificado instalado en Windows o archivo `.p12/.pfx`— para los casos que exigen firma digital del titular: ICP-Brasil A1/A3, DNIe de Perú, certificados de entidades acreditadas por ONAC (Colombia), INDOTEL (República Dominicana) o el IP (Honduras).",
  "g.cert.setup.h": "Configurar al firmante",
  "g.cert.setup.p":
    "Agregá `signatureType: \"certificate\"` al destinatario (solo rol `signer`; también se puede definir en los roles de una plantilla). Un firmante con certificado no necesita campo de firma en el documento.",
  "g.cert.flow.h": "Cómo sigue el sobre",
  "g.cert.flow.p":
    "1. Todos firman electrónicamente, como siempre.\n2. CalaSign arma el PDF final con el certificado de finalización y el sobre pasa a `awaiting_certificates`. Al primer firmante con certificado le llega el pedido.\n3. Cada uno firma en orden con el **Firmador CalaSign**, una app de escritorio que se descarga desde [`/firmador`](/firmador). La clave privada nunca sale de su dispositivo: CalaSign manda un hash y recibe la firma (PAdES B-T, con sello de tiempo).\n4. Con la última firma el sobre pasa a `finalizing`, se agrega el sello de la plataforma y queda `completed`.\n\nEl progreso de cada firma con certificado se consulta así:",
  "g.cert.req.h": "Requisitos del certificado",
  "g.cert.req.p":
    "- `matchIdDocument`: el certificado tiene que corresponder al `idDocumentNumber` del firmante (CPF, cédula, DNI…). Se aplica solo si el destinatario tiene documento y exige que la cadena llegue a una raíz de confianza.\n- `allowedIssuers`: partes del nombre del emisor admitidas (por ejemplo `ICP-Brasil`, `RENIEC`). Vacío = cualquiera.\n- `requireQualified`: exigir una CA del almacén de confianza de la plataforma.\n\nAdemás se controla vigencia, uso de clave (`digitalSignature` o `nonRepudiation`) y que no sea un certificado de CA. Los intentos rechazados quedan en la evidencia.",
  // ───────── Guía: identidad ─────────
  "g.idv.title": "Autenticación y verificación de identidad",
  "g.idv.lead": "Por defecto, tener el link personal alcanza para firmar. Podés exigir más: un código de un solo uso o una verificación de identidad con documento y selfie.",
  "g.idv.auth.h": "Código de un solo uso",
  "g.idv.auth.p":
    "`authMethod` del destinatario: `link` (por defecto), `otp_email` (requiere `email`), `otp_sms` u `otp_whatsapp` (requieren `phone`) o `in_person` (firma en el dispositivo de un anfitrión de tu organización, configurada con `inPerson`). Con OTP, la persona tiene que ingresar un código de 6 dígitos antes de ver el documento, y el método queda en el certificado de finalización.",
  "g.idv.kyc.h": "Verificación de identidad (KYC)",
  "g.idv.kyc.p":
    "`idVerification` exige verificar la identidad antes de ver los documentos: `provider` (`truora`, `veriff` o `mock` para pruebas) y `level` (`document`, `document_selfie` o `document_selfie_liveness`). Se compara el nombre y el número del documento con lo que declaraste (`idDocumentType`, `idDocumentNumber`). Los valores por defecto (proveedor, nivel, umbral de coincidencia del nombre, intentos) se configuran en `PATCH /v1/settings/identity`. El resultado —nunca las imágenes— se consulta por destinatario. Disponible desde el plan Business.",
  // ───────── Guía: cobros ─────────
  "g.pay.title": "Cobrar al firmar",
  "g.pay.lead":
    "Un sobre puede cobrarle a uno de sus firmantes dentro de la misma ceremonia: señas, primeras cuotas, honorarios. El comprobante del pago va en el certificado de finalización. Disponible desde el plan Business.",
  "g.pay.conf.h": "Configurar el cobro",
  "g.pay.conf.p":
    "Solo en borrador. `amount` en unidades (con hasta 2 decimales), `currency` (`USD`, `BRL`, `COP`, `DOP`, `HNL`, `PEN`, `MXN`, `ARS`, `EUR`), `payerRecipientId` (un firmante del sobre) y `provider`: `stripe`, `mercadopago` o `mock` (solo en pruebas). `GET /v1/payments/providers` lista los proveedores configurados. Mercado Pago ofrece Pix y boleto en Brasil y PSE en Colombia; Stripe cobra con tarjeta (y Pix en cuentas de Brasil).",
  "g.pay.timing.h": "Antes o después de firmar",
  "g.pay.timing.p":
    "- `after_sign` (por defecto): la persona firma y después paga. El sobre **recién se completa y se sella cuando el pago se confirma**.\n- `before_sign`: no puede completar la firma hasta pagar; mientras tanto el intento de firma responde `402 payment_required`.\n\nLa confirmación llega solo por el webhook verificado del proveedor. Si un pago llega con el sobre ya cerrado, se marca para reembolso.",
  // ───────── Guía: CRM ─────────
  "g.crm.title": "CRM y ERP",
  "g.crm.lead":
    "Conectores nativos para enviar a firmar desde el CRM y devolver el resultado, y para dejar el PDF firmado en el ERP. Se configuran en **Ajustes → CRM y ERP** ([`/app/settings/crm`](/app/settings/crm)); toda la configuración también está en la API, sección [CRM y ERP](/developers/api/crm-y-erp).",
  "g.crm.providers.h": "Proveedores",
  "g.crm.col.provider": "Proveedor",
  "g.crm.col.does": "Qué hace",
  "g.crm.hubspot": "Enviar a firmar desde un Deal (contactos asociados + propiedades → plantilla), manualmente o por webhook al cambiar una propiedad. Al completarse actualiza una propiedad de estado y adjunta el PDF al deal.",
  "g.crm.salesforce": "Enviar desde una Opportunity (roles de contacto + campos). Actualiza un campo de estado y publica el PDF como ContentVersion en la oportunidad.",
  "g.crm.siigo": "Colombia: busca el cliente por la identificación de un firmante y le agrega la referencia del documento firmado.",
  "g.crm.alegra": "Busca el contacto por identificación y le adjunta el PDF; también se puede vincular una factura.",
  "g.crm.mappings.h": "Mapeos y vínculos",
  "g.crm.mappings.p":
    "Un **mapeo** une un tipo de registro con una plantilla: de dónde sale cada destinatario, qué propiedades prellenan qué campos, qué se escribe de vuelta en cada estado y cuándo se dispara (`manual`, `webhook` u `on_completion`). Cada sobre queda **vinculado** a su registro y cada evento (enviado, completado, rechazado, anulado, vencido) se escribe de vuelta. La actividad, con errores y reintentos, se consulta en `/v1/crm/runs`.",
  // ───────── Guía: dominio propio ─────────
  "g.domain.title": "Dominio propio",
  "g.domain.lead":
    "Firmá desde tu propio dominio (`firmas.tuempresa.com`): los links de los correos, WhatsApp y Telegram y las URLs de firma embebida usan ese dominio, y la página muestra tu marca. Disponible en el plan Enterprise.",
  "g.domain.dns.h": "Registrar el dominio y crear los registros DNS",
  "g.domain.dns.p":
    "La respuesta trae `txtName`, `txtValue` y `cnameTarget`. Creá en tu DNS un registro **TXT** para probar que el dominio es tuyo y un **CNAME** que apunte a la plataforma. El CNAME no puede pasar por un proxy (en Cloudflare, «solo DNS»).",
  "g.domain.verify.h": "Verificar",
  "g.domain.verify.p":
    "Cuando el TXT se propagó, verificá. El certificado TLS se emite automáticamente en el primer acceso. CalaSign vuelve a comprobar el dominio cada 6 horas: si el TXT o el CNAME desaparecen varias veces seguidas, el dominio vuelve a `pending` y los links pasan al dominio de la plataforma.",
  // ───────── Guía: marca ─────────
  "g.brand.title": "Marca propia",
  "g.brand.lead": "Tu logo, tu color y un pie propio en los correos y en la página de firma. Disponible desde el plan Starter.",
  "g.brand.api.h": "Por API",
  "g.brand.api.p":
    "`primaryColor` va en formato `#RRGGBB`; `emailFooter`, hasta 500 caracteres (`null` quita cada valor). El logo se sube como `multipart/form-data` en el campo `file`: PNG, SVG o JPEG de hasta 200 KB. `DELETE /v1/settings/branding/logo` lo quita. También se configura en **Ajustes → Marca**.",
  // ───────── Webhooks ─────────
  "wh.title": "Webhooks",
  "wh.lead":
    "CalaSign te avisa con un `POST` firmado a tu URL cada vez que pasa algo en un sobre: alguien lo abre, firma, rechaza, o el sobre se completa. Es la forma recomendada de enterarte, en lugar de consultar la API. Disponible desde el plan Starter.",
  "wh.setup.h": "Configurar un endpoint",
  "wh.setup.p":
    "Registrá la URL en **Ajustes → Integraciones** ([`/app/settings/integrations`](/app/settings/integrations)) o por API. La URL tiene que ser `https`, pública y sin credenciales; no se siguen redirecciones. `events` vacío o ausente = todos los eventos. La respuesta incluye el `secret` (`whsec_…`) para verificar las firmas: **se muestra una sola vez**. Podés tener varios endpoints, pausarlos (`active: false`) y cambiar sus eventos con `PATCH /v1/webhooks/{id}`.",
  "wh.setup.once": "se muestra una sola vez",
  "wh.events.h": "Eventos",
  "wh.events.p": "Suscribite solo a los que uses. Pueden aparecer tipos nuevos en el futuro: ignorá los que no conozcas respondiendo `2xx`.",
  "wh.col.event": "Evento",
  "wh.col.when": "Cuándo se envía",
  "wh.ev.envelope.sent": "El sobre se envió (por API, desde la web, un envío masivo, un formulario o un CRM).",
  "wh.ev.envelope.completed": "Firmaron todos y el PDF sellado está listo para descargar. `data.envelope.signedSha256` trae su hash.",
  "wh.ev.envelope.declined": "El sobre terminó porque alguien rechazó. Llega junto con `recipient.declined`; `data.reason` trae el motivo.",
  "wh.ev.envelope.voided": "El remitente anuló el sobre. `data.reason` trae el motivo.",
  "wh.ev.envelope.expired": "Venció `expiresAt` sin que firmaran todos.",
  "wh.ev.recipient.viewed": "Un destinatario abrió el documento. `data.recipientId` dice quién.",
  "wh.ev.recipient.signed": "Un firmante firmó. Si quedan turnos, los siguientes reciben su invitación.",
  "wh.ev.recipient.declined": "Un firmante o aprobador rechazó. `data.reason` trae el motivo.",
  "wh.ev.recipient.approved": "Un aprobador (`role: approver`) aprobó.",
  "wh.ev.webhook.test": "Evento de prueba enviado con **Enviar prueba** o `POST /v1/webhooks/{id}/test`. `data.envelope` es `null`.",
  "wh.payload.h": "Formato de la entrega",
  "wh.payload.p":
    "Cada entrega es un `POST` con cuerpo JSON y estos encabezados. El cuerpo trae una **foto del sobre** en el momento del evento, con tu `metadata` y el estado de cada destinatario, así que muchas veces no hace falta consultar la API.",
  "wh.payload.headers": "Encabezados",
  "wh.payload.body": "Cuerpo",
  "wh.col.field": "Campo",
  "wh.f.id": "Id único del evento. Es el mismo en todos tus endpoints y en los reintentos: usalo para no procesar dos veces.",
  "wh.f.type": "Tipo de evento.",
  "wh.f.createdAt": "Cuándo se generó el evento.",
  "wh.f.envelope": "Estado del sobre al generarse el evento (`null` en `webhook.test`).",
  "wh.f.recipientId": "Destinatario que originó el evento (`viewed`, `signed`, `approved`, `declined`), si corresponde.",
  "wh.f.reason": "Motivo del rechazo o de la anulación, si corresponde.",
  "wh.verify.h": "Verificar la firma",
  "wh.verify.p":
    "El encabezado `CalaSign-Signature` tiene la forma `t=<unix>,v1=<hex>`, donde `v1` es `HMAC-SHA256(secret, \"<t>.<cuerpo>\")` en hexadecimal. Para verificar:\n\n1. Separá `t` y `v1`.\n2. Calculá el HMAC con tu secreto sobre el texto `t`, un punto y el **cuerpo crudo**, byte por byte como llegó (no el JSON vuelto a serializar).\n3. Comparalo con `v1` en tiempo constante.\n4. Rechazá entregas con `t` de más de 5 minutos para evitar repeticiones.",
  "wh.verify.warn":
    "El error más común es verificar el cuerpo ya parseado: cualquier diferencia de espacios u orden de claves rompe la firma. Configurá tu framework para darte el cuerpo crudo en esta ruta (`express.raw`, `request.get_data()`, `request.body` sin parsear).",
  "wh.c.raw": "cuerpo CRUDO, exactamente como llegó",
  "wh.c.async": "procesar fuera del pedido",
  "wh.retries.h": "Reintentos",
  "wh.retries.p":
    "Una entrega cuenta como exitosa si tu servidor responde **2xx en menos de 10 segundos**. Cualquier otro código, una redirección, un error de red o un timeout es un fallo y se reintenta con espera creciente, hasta **8 intentos** en total:",
  "wh.col.attempt": "Intento",
  "wh.col.wait": "Espera desde el anterior",
  "wh.retries.immediate": "inmediato",
  "wh.retries.after":
    "Después del último intento la entrega queda `failed`. Podés ver cada entrega (código de respuesta, primeros caracteres de la respuesta, error, próximo intento) y reintentarla a mano desde **Ajustes → Integraciones** o con `POST /v1/webhook-deliveries/{id}/retry`. Si pausás un endpoint, las entregas pendientes se marcan como fallidas.",
  "wh.receive.h": "Buenas prácticas al recibir",
  "wh.receive.p":
    "- **Respondé rápido.** Verificá la firma, guardá el evento y respondé `200`; procesá después en una cola. Si tardás más de 10 segundos, CalaSign lo cuenta como fallo y reintenta.\n- **Idempotencia.** Un mismo evento puede llegar más de una vez (reintentos, redes inestables). Guardá `id` (también viene en `CalaSign-Event-Id`) y descartá los repetidos.\n- **Sin orden garantizado.** Los eventos se entregan de forma independiente: `recipient.signed` puede llegar después de `envelope.completed`. Usá `createdAt` y, ante la duda, consultá el estado actual con `GET /v1/envelopes/{id}`.\n- **Eventos desconocidos.** Respondé `2xx` a los tipos que no manejes.\n- **Rotación del secreto.** Para cambiarlo, creá un endpoint nuevo con la misma URL, aceptá ambos secretos durante la transición y borrá el anterior.",
  "wh.test.h": "Probar",
  "wh.test.p":
    "Mandá un evento `webhook.test` a un endpoint para comprobar la conectividad y la verificación de la firma. En desarrollo podés exponer tu servidor local con un túnel (ngrok, Cloudflare Tunnel) o usar un servicio de inspección de pedidos.",
  "wh.test.deliveries.h": "Historial de entregas",
  "wh.test.deliveries.p": "Las entregas recientes de cada endpoint, con su estado (`pending`, `succeeded`, `failed`), intentos, último código HTTP y error.",
  // ───────── Errores, idempotencia, paginación, límites ─────────
  "err.title": "Errores, idempotencia y límites",
  "err.lead": "Cómo responde la API cuando algo sale mal, cómo reintentar sin duplicar, cómo recorrer listas largas y cuántos pedidos podés hacer.",
  "err.format.h": "Formato de los errores",
  "err.format.p":
    "Todas las respuestas de error de `/v1` tienen el mismo formato: un `code` estable en inglés para tu código, un `message` legible y, a veces, `details` con información estructurada. Programá contra `code` y el status HTTP, nunca contra `message`.",
  "err.format.lang":
    "Los `message` están en español y pueden cambiar de redacción. Los endpoints OAuth (`/oauth/*`) usan el formato de RFC 6749 en su lugar: `{ \"error\": \"invalid_grant\", \"error_description\": \"…\" }`.",
  "err.codes.h": "Códigos frecuentes",
  "err.col.meaning": "Qué significa y qué hacer",
  "err.c.validation": "El cuerpo no cumple el esquema. `details[]` trae `path` y `message` de cada problema. No reintentes sin corregir.",
  "err.c.invalidId": "Un id de la ruta no es un UUID válido.",
  "err.c.bad": "Otros errores del pedido, con un `code` específico (cursor inválido, texto ancla no encontrado, campo fuera de la página…).",
  "err.c.unauthorized": "Falta la credencial, es inválida, venció o fue revocada.",
  "err.c.plan":
    "La organización llegó a un límite de su plan o la funcionalidad no está incluida. `details` trae `plan`, el límite o la funcionalidad, `suggestedPlan` y `upgradeUrl`. Las lecturas nunca se bloquean por plan.",
  "err.c.forbidden": "El rol de la credencial no tiene el permiso (`details.permission`) o al token OAuth le falta un scope (`details.requiredScope`).",
  "err.c.notFound": "El recurso no existe o pertenece a otra organización.",
  "err.c.conflict": "El estado del recurso no permite la operación: por ejemplo, modificar un sobre que ya no es borrador o anular uno terminado.",
  "err.c.idem": "Reutilizaste una `Idempotency-Key` con otro cuerpo, o el pedido original todavía se está procesando (reintentá en unos segundos).",
  "err.c.tooLarge": "El archivo supera el tamaño máximo.",
  "err.c.unprocessable": "El pedido es válido pero no se puede procesar con esos datos (faltan roles de la plantilla, filas inválidas, PDF demasiado pesado para buscar anclas).",
  "err.c.rate": "Superaste el límite de pedidos. Esperá lo que indica el encabezado `retry-after` (segundos).",
  "err.c.internal": "Error nuestro. Es seguro reintentar con espera creciente; si usás `Idempotency-Key`, no se duplica nada.",
  "err.codes.retry":
    "**Qué reintentar:** errores de red, `429` y `5xx`, con espera exponencial y algo de azar. **Qué no:** el resto de los `4xx`, que no van a cambiar si repetís el mismo pedido.",
  "err.idem.h": "Idempotencia",
  "err.idem.p":
    "Si un pedido de creación se corta (timeout, red), no sabés si llegó. Mandá el encabezado `Idempotency-Key` con un valor único por operación —por ejemplo, el id del pedido en tu sistema— y reintentá con el mismo valor: CalaSign ejecuta la operación una sola vez y a los reintentos les devuelve la respuesta guardada, con el encabezado `idempotent-replay: true`.",
  "err.idem.rules":
    "- Se aplica en `POST /v1/envelopes` y `POST /v1/envelopes/{id}/send`. En el resto de los endpoints el encabezado se ignora.\n- La clave vale por credencial (API key, app OAuth o usuario) y tiene hasta 200 caracteres.\n- Misma clave con otro cuerpo u otra ruta: `409 idempotency_mismatch`.\n- Si el primer pedido todavía se está procesando: `409 idempotency_in_progress`; reintentá en unos segundos.\n- Si el pedido original falló con error, la clave se libera y podés reintentar.\n- Los SDKs agregan una clave automáticamente.",
  "err.page.h": "Paginación",
  "err.page.p":
    "`GET /v1/envelopes` pagina por **cursor**, del más reciente al más antiguo. `limit` va de 1 a 100 (por defecto 25). Si hay más resultados, la respuesta trae `nextCursor`: pasalo como `cursor` para pedir la página siguiente; cuando es `null`, terminaste. El cursor es opaco: no lo construyas ni lo modifiques. Filtros: `status` (uno o varios separados por coma) y `q` (busca en el asunto y en el nombre o email de los destinatarios).",
  "err.page.iter.h": "Recorrer todas las páginas",
  "err.rate.h": "Límites de pedidos",
  "err.rate.p":
    "Los límites se cuentan **por dirección IP** en ventanas de un minuto. El límite general es de 600 pedidos por minuto para el conjunto de la API; algunos endpoints tienen un límite propio, que se cuenta aparte. Cada respuesta trae `x-ratelimit-limit`, `x-ratelimit-remaining` y `x-ratelimit-reset`; al superarlo, la respuesta es `429` con `retry-after`.",
  "err.col.route": "Ruta",
  "err.col.limit": "Límite por IP",
  "err.rate.tip":
    "Para seguir el estado de muchos sobres, usá [webhooks](/developers/webhooks) en lugar de consultar en bucle. Si necesitás límites más altos, escribinos.",
  // ───────── SDKs ─────────
  "sdk.title": "SDKs",
  "sdk.lead":
    "SDKs oficiales para Python y Node.js, sin dependencias externas. Resuelven lo tedioso: autenticación (incluida la renovación de tokens OAuth), reintentos seguros, paginación y verificación de webhooks. Para cualquier otro lenguaje, generá un cliente desde la especificación OpenAPI.",
  "sdk.notPublished":
    "Los SDKs todavía no están publicados en PyPI ni en npm: se instalan desde el código fuente de CalaSign (carpetas `sdks/python` y `packages/sdk-node`). La API es estable; cuando se publiquen solo cambia el comando de instalación.",
  "sdk.col.feature": "Característica",
  "sdk.f.deps": "Requisitos",
  "sdk.f.py.deps": "Python ≥ 3.8, solo biblioteca estándar",
  "sdk.f.node.deps": "Node.js ≥ 18 (fetch nativo), con tipos",
  "sdk.f.auth": "Autenticación",
  "sdk.f.retries": "Reintentos",
  "sdk.f.retries.v": "Red, 429 (respeta Retry-After) y 5xx, backoff exponencial, 3 por defecto",
  "sdk.f.idem": "Idempotency-Key automática",
  "sdk.f.errors": "Errores",
  "sdk.install": "Instalación",
  "sdk.py.h": "Python",
  "sdk.node.h": "Node.js",
  "sdk.c.any": "cualquier otro endpoint, con la misma autenticación y reintentos",
  "sdk.methods.h": "Métodos",
  "sdk.m.verify": "Verificar un webhook",
  "sdk.openapi.h": "Cualquier lenguaje con OpenAPI",
  "sdk.openapi.p":
    "La especificación OpenAPI 3.1 en [`/v1/openapi.json`](/v1/openapi.json) describe todos los endpoints con sus esquemas de pedido y respuesta, parámetros, errores y scopes. Usala con cualquier generador de clientes, para importar la API en Postman o Insomnia, o para validar tus pedidos en las pruebas.",
  "sdk.openapi.import": "Importar → Link / URL:",
  // ───────── IA y agentes ─────────
  "ai.title": "IA y agentes",
  "ai.lead":
    "Conectá asistentes de IA a CalaSign para consultar el estado de tus sobres, preparar envíos desde una plantilla y descargar documentos firmados conversando. Todo pasa por el **servidor MCP** de CalaSign (Model Context Protocol), con los mismos permisos, límites y evidencia que la API.",
  "ai.cards.h": "Integraciones",
  "ai.card.mcp.t": "Servidor MCP",
  "ai.card.mcp.d": "Una URL para cualquier cliente MCP: OAuth automático o API key.",
  "ai.card.mcp.a": "Ver herramientas",
  "ai.card.claude.d": "Conector personalizado en claude.ai y Claude Desktop, con inicio de sesión OAuth.",
  "ai.card.claude.a": "Agregar conector",
  "ai.card.desktop.t": "Extensión de Claude Desktop",
  "ai.card.desktop.d": "Archivo `.mcpb`: doble clic, pegás tu API key y listo.",
  "ai.card.code.d": "Un comando para agregar el servidor, o el plugin con la skill incluida.",
  "ai.card.code.a": "Ver comandos",
  "ai.card.skill.t": "Agent Skill",
  "ai.card.skill.d": "Le enseña a Claude el flujo de CalaSign: plantillas, confirmaciones y buenas prácticas.",
  "ai.card.gpt.d": "Servidor MCP personalizado en ChatGPT y herramienta MCP en la API de Responses.",
  "ai.card.gpt.a": "Conectar ChatGPT",
  "ai.card.gem.d": "Gemini CLI (comando o extensión) y la API de Gemini con una sesión MCP.",
  "ai.card.gem.a": "Extensión .zip",
  "ai.card.office.t": "Word y Outlook",
  "ai.card.office.d": "Complemento para enviar a firmar el documento abierto en Word o un PDF adjunto en Outlook.",
  "ai.how.h": "Cómo funciona",
  "ai.how.p":
    "El agente habla con `{{MCP_URL}}` y CalaSign ejecuta cada herramienta llamando a su propia API con **la credencial del agente**. Por eso:\n\n- El agente puede exactamente lo que puede su credencial: el rol de la API key o, con OAuth, los scopes que aprobó la persona y su propio rol.\n- Valen los mismos límites del plan y las mismas validaciones que en la API.\n- Cada acción queda en la evidencia del sobre con el actor «agente IA (<cliente>)».\n- Enviar y anular exigen `confirm: true`: sin eso la herramienta devuelve un resumen para que la persona apruebe.",
  "ai.how.tip":
    "Para probar, usá el entorno de pruebas: los correos y WhatsApp que dispare el agente quedan en el Buzón dev, sin llegarle a nadie.",
  "ai.c.prompt": "¿Qué sobres tengo pendientes de firma?",
  // ───────── Servidor MCP ─────────
  "mcp.title": "Servidor MCP",
  "mcp.lead":
    "Servidor remoto de [Model Context Protocol](https://modelcontextprotocol.io) para que agentes de IA trabajen con CalaSign. Funciona con Claude, ChatGPT, Gemini, el MCP Inspector y cualquier cliente que hable Streamable HTTP.",
  "mcp.connect.h": "Conexión",
  "mcp.col.prop": "Propiedad",
  "mcp.col.value": "Valor",
  "mcp.transport": "Transporte",
  "mcp.transport.v": "Streamable HTTP, sin sesión: cada `POST` es independiente y la respuesta es JSON. `GET` y `DELETE` responden 405.",
  "mcp.auth.row": "Autenticación",
  "mcp.auth.row.v": "OAuth 2.1 (descubrimiento + registro dinámico) o `Authorization: Bearer <API key>`",
  "mcp.plan": "Plan",
  "mcp.plan.v": "Starter o superior (acceso por API). Sin él, `402 plan_limit`.",
  "mcp.connect.p": "Límite: 300 pedidos por minuto por IP.",
  "mcp.auth.h": "Autenticación",
  "mcp.auth.p":
    "**OAuth (recomendado para personas).** El cliente descubre todo solo: el primer pedido sin credencial recibe `401` con el enlace a los metadatos, el cliente se registra con [registro dinámico](/developers/authentication#dynamic-registration), abre la pantalla de consentimiento de CalaSign y la persona elige qué permitir. Pedí `offline_access` para no tener que volver a iniciar sesión cada hora.\n\n**API key (scripts y entornos sin navegador).** Mandá `Authorization: Bearer cs_test_…`. El agente actúa con el rol de esa key: para un agente conviene una key con rol `member` o un rol personalizado, no `admin`.",
  "mcp.auth.401": "Respuesta sin credencial",
  "mcp.tools.h": "Herramientas",
  "mcp.tools.p": "Todas devuelven JSON resumido pensado para un modelo (ids, estados, nombres) en lugar del detalle completo de la API.",
  "mcp.col.tool": "Herramienta",
  "mcp.col.does": "Qué hace",
  "mcp.col.confirm": "Confirmación",
  "mcp.tool.list_envelopes": "Lista los sobres, del más reciente al más antiguo. Filtros: `status`, `query` (asunto o destinatario), `limit` (hasta 50) y `cursor`.",
  "mcp.tool.get_envelope": "Detalle de un sobre: documentos, destinatarios y su estado.",
  "mcp.tool.get_signing_status": "Quién firmó, quién falta, quién rechazó y los últimos eventos de la evidencia.",
  "mcp.tool.list_templates": "Plantillas disponibles con sus roles (para crear sobres desde plantilla).",
  "mcp.tool.create_envelope_from_template": "Crea un sobre en **borrador** desde una plantilla, con una persona por rol y valores de campos opcionales. No envía nada.",
  "mcp.tool.send_envelope": "Envía un borrador: les llegan las invitaciones a los firmantes.",
  "mcp.tool.void_envelope": "Anula un sobre en curso con un motivo; los firmantes reciben el aviso.",
  "mcp.tool.download_signed_pdf": "Devuelve una URL temporal (15 minutos) para descargar el PDF sellado de un sobre completado, con su SHA-256.",
  "mcp.tool.create_envelope": "Crea un sobre en **borrador** a partir de un PDF (en base64 o desde una URL https), con sus destinatarios. No envía nada.",
  "mcp.tool.remind_recipients": "Reenvía la invitación a los firmantes pendientes del turno actual.",
  "mcp.tool.get_account": "Datos de la cuenta: organización, usuario o credencial, plan y uso del mes.",
  "mcp.safety.h": "Modelo de seguridad",
  "mcp.safety.p":
    "- **Confirmación explícita.** Las herramientas con efecto hacia afuera (enviar, anular, recordar) exigen `confirm: true`. Sin ese parámetro no hacen nada y devuelven un resumen (asunto, destinatarios) con la instrucción de mostrárselo a la persona y pedirle aprobación. Las instrucciones del servidor le piden lo mismo al modelo.\n- **Borradores primero.** Crear un sobre nunca envía: la persona revisa antes.\n- **Permisos acotados.** El agente nunca puede más que su credencial. Con OAuth, la persona ve y aprueba los scopes; podés revocar el acceso en cualquier momento desde **Ajustes → Apps OAuth** (apps conectadas).\n- **Evidencia.** Cada acción queda registrada como «agente IA (<nombre del cliente>) — <credencial>» en la cadena de evidencia del sobre y en el certificado de finalización.\n- **Descargas temporales.** El PDF firmado se entrega con un link que vence a los 15 minutos, no como contenido en la conversación.\n- **Contenido no confiable.** El texto de un documento o un asunto puede contener instrucciones maliciosas. Pedile a tu agente que no ejecute acciones a partir del contenido de los documentos sin confirmar con la persona.",
  "mcp.inspector.h": "Probar con MCP Inspector",
  "mcp.inspector.p":
    "El [MCP Inspector](https://github.com/modelcontextprotocol/inspector) es la herramienta oficial para probar un servidor MCP: lista las herramientas, las ejecuta y muestra los mensajes. Necesita Node.js 22 o superior. En la interfaz web elegí el transporte **Streamable HTTP**, pegá la URL y agregá el encabezado `Authorization`, o seguí el flujo OAuth. `--header` va después de la URL.",
  "mcp.inspector.c.ui": "Interfaz web (http://localhost:6274) con la conexión precargada",
  "mcp.inspector.c.cli": "Modo línea de comandos: listar herramientas",
  "mcp.sdk.h": "Desde tu propio agente",
  "mcp.sdk.p": "Con el SDK oficial de MCP para TypeScript (`@modelcontextprotocol/sdk`). Hay SDKs equivalentes para Python, Java, C#, Go y otros lenguajes.",
  "mcp.sdk.c.approve": "…mostrarle el resumen a la persona y, si aprueba:",
  // ───────── Claude ─────────
  "claude.title": "Claude",
  "claude.lead":
    "Usá CalaSign desde claude.ai, Claude Desktop, Claude Code o tu propia app con la API de Claude. Elegí la opción según dónde trabajes; todas usan el mismo [servidor MCP](/developers/ai/mcp).",
  "claude.connector.h": "Conector en claude.ai y Claude Desktop",
  "claude.connector.p":
    "Los conectores personalizados están disponibles en todos los planes de Claude (en Free, hasta uno). Se agregan una vez y quedan disponibles en la web, en Claude Desktop y en la app móvil.",
  "claude.connector.s1": "En Claude, abrí **Personalizar → Conectores** (*Customize → Connectors*) y elegí **Agregar conector personalizado** (*Add custom connector*).",
  "claude.connector.s2": "Escribí un nombre (CalaSign) y pegá la URL del servidor:",
  "claude.connector.s3":
    "En autenticación dejá el inicio de sesión con OAuth. Si te pide elegir el cliente OAuth, elegí **Registrar automáticamente** (*Register automatically*). Tocá **Agregar** y después **Conectar**.",
  "claude.connector.s4": "Se abre la pantalla de consentimiento de CalaSign: iniciá sesión, revisá los permisos y aprobá. En cada chat, activá el conector desde el botón **+ → Conectores**.",
  "claude.connector.team":
    "**Team y Enterprise:** primero un propietario de la organización lo agrega en **Configuración de la organización → Conectores → Agregar → Personalizado** (*Organization settings → Connectors → Add → Custom*). Después cada persona lo encuentra en **Personalizar → Conectores** con la etiqueta *Custom*, toca **Conectar** e inicia sesión con su propia cuenta de CalaSign.",
  "claude.connector.key":
    "¿Preferís una API key en lugar de OAuth? Algunas organizaciones ven la opción *Sin inicio de sesión* con **Encabezados del pedido** (*Request headers*, beta): agregá `Authorization` con el valor `Bearer cs_test_…` (incluyendo «Bearer »). La autenticación no se puede cambiar después: para cambiarla, quitá el conector y agregalo de nuevo.",
  "claude.desktop.h": "Extensión de Claude Desktop (.mcpb)",
  "claude.desktop.p":
    "Si trabajás en Claude Desktop con una API key (por ejemplo, una cuenta de servicio), la extensión `.mcpb` es lo más rápido: se instala con un doble clic y guarda la key en el almacén seguro del sistema operativo.",
  "claude.desktop.s1": "Descargá `calasign.mcpb` y abrilo con doble clic (o arrastralo a **Configuración → Extensiones** en Claude Desktop).",
  "claude.desktop.s2": "En la pantalla de instalación revisá los permisos y pegá tu API key de CalaSign cuando te la pida.",
  "claude.desktop.s3": "Tocá **Instalar** y activala. Si tu organización desactivó las extensiones, la sección no aparece: usá el conector.",
  "claude.code.h": "Claude Code",
  "claude.code.p":
    "Agregá el servidor con un comando. Con OAuth, la primera vez ejecutá `/mcp` dentro de Claude Code y seguí el inicio de sesión en el navegador (también `claude mcp login calasign` desde la terminal). `--scope user` lo deja disponible en todos tus proyectos; `--scope project` lo guarda en `.mcp.json` para compartirlo con tu equipo.",
  "claude.code.c.login": "dentro de Claude Code, para iniciar sesión:",
  "claude.plugin.h": "Plugin de CalaSign",
  "claude.plugin.p":
    "El plugin instala de una vez el servidor MCP y la skill de CalaSign. Escribí esto dentro de Claude Code:",
  "claude.skill.h": "Agent Skill",
  "claude.skill.p":
    "La skill le enseña a Claude cómo trabajar con CalaSign: usar plantillas, ubicar campos con anclas, pedir confirmación antes de enviar, interpretar estados y webhooks. Combinala con el conector o con el servidor MCP.",
  "claude.skill.install":
    "**En claude.ai:** **Personalizar → Skills → + → Crear skill → Subir una skill** (*Customize → Skills → Upload a skill*), elegí el ZIP y activala. Requiere tener habilitada la ejecución de código (**Configuración → Capacidades**; en Enterprise la habilita un propietario).\n\n**En Claude Code:** descomprimila en `~/.claude/skills/` (para vos) o en `.claude/skills/` de tu proyecto (para tu equipo). Si instalaste el plugin, ya la tenés.",
  "claude.api.h": "API de Claude (conector MCP)",
  "claude.api.p":
    "Con la API de Mensajes, Claude se conecta directamente al servidor MCP sin que implementes un cliente. Hace falta el encabezado beta `mcp-client-2025-11-20`, el servidor en `mcp_servers` y un `mcp_toolset` en `tools`. En `authorization_token` mandá un access token OAuth de CalaSign o una API key. Tu aplicación es responsable de pedir confirmación antes de enviar o anular.",
  // ───────── ChatGPT ─────────
  "gpt.title": "ChatGPT",
  "gpt.lead": "Agregá CalaSign como servidor MCP personalizado en ChatGPT, o usalo desde la API de Responses de OpenAI.",
  "gpt.connector.h": "Servidor MCP personalizado en ChatGPT",
  "gpt.connector.p":
    "Los servidores MCP personalizados se agregan desde la web de ChatGPT. Según el plan, el administrador del espacio de trabajo puede tener que habilitarlos o crearlos (en Business y Enterprise/Edu, por ejemplo). Los nombres de los menús cambian seguido: si no los encontrás, buscá «MCP» en la configuración o en el centro de ayuda de OpenAI.",
  "gpt.connector.s1": "Abrí la sección de **Plugins** de ChatGPT (*chatgpt.com/plugins*), tocá **+** y elegí **Agregar servidor MCP personalizado** (*Add custom MCP server*).",
  "gpt.connector.s2": "Nombre: CalaSign. En **Conexión**, pegá la URL del servidor:",
  "gpt.connector.s3": "Autenticación: **OAuth**. ChatGPT se registra solo en CalaSign; aceptá la advertencia y crealo.",
  "gpt.connector.s4": "Instalalo, iniciá sesión en CalaSign cuando te lo pida y aprobá los permisos.",
  "gpt.connector.note":
    "ChatGPT pide confirmación antes de usar herramientas que modifican datos. Además, CalaSign exige `confirm: true` para enviar o anular, así que nada sale sin que lo apruebes.",
  "gpt.api.h": "API de Responses de OpenAI",
  "gpt.api.p":
    "La herramienta `mcp` de la API de Responses conecta el modelo al servidor de CalaSign. En `authorization` mandá un access token OAuth o una API key de CalaSign (no se guarda: mandala en cada pedido).",
  // ───────── Gemini ─────────
  "gem.title": "Gemini",
  "gem.lead": "Usá CalaSign desde Gemini CLI —con un comando o con la extensión— o desde la API de Gemini con una sesión MCP.",
  "gem.cli.h": "Gemini CLI",
  "gem.cli.p":
    "`gemini mcp add` guarda el servidor en `settings.json` (`--scope user` para todos tus proyectos; por defecto, el proyecto actual). Con OAuth, Gemini CLI detecta que hace falta iniciar sesión, se registra solo y abre el navegador; también podés forzarlo con `/mcp auth calasign`.",
  "gem.cli.c.login": "dentro de Gemini CLI, para iniciar sesión:",
  "gem.cli.note":
    "Google reemplazó Gemini CLI por Antigravity CLI para cuentas gratuitas y de Google One. Los pasos de esta página aplican a Gemini CLI; en otras herramientas, usá la misma URL con transporte HTTP.",
  "gem.ext.h": "Extensión de Gemini CLI",
  "gem.ext.p":
    "La extensión de CalaSign suma el servidor MCP y un archivo de contexto con instrucciones para trabajar con sobres y plantillas. Descargala, descomprimila e instalala desde la carpeta (Gemini CLI instala extensiones desde un repositorio git o una carpeta local, no desde un ZIP).",
  "gem.api.h": "API de Gemini (google-genai)",
  "gem.api.p":
    "El SDK `google-genai` para Python acepta una sesión MCP como herramienta (función experimental). Este ejemplo usa el cliente Streamable HTTP del SDK `mcp` 2.x; con `mcp` 1.x, el equivalente es `streamablehttp_client(url, headers={…})`.",
  // ───────── Office ─────────
  "office.title": "Complemento de Word y Outlook",
  "office.lead":
    "Enviá a firmar sin salir de Microsoft 365: el documento que estás escribiendo en Word o un PDF que te llegó por correo en Outlook.",
  "office.what.h": "Qué hace",
  "office.what.p":
    "- **Word:** envía a firmar el documento que tenés abierto: elegís los destinatarios desde el panel lateral y CalaSign crea y envía el sobre.\n- **Outlook:** al leer un correo, elegís un PDF adjunto y lo enviás a firmar sin descargarlo.\n- En los dos casos iniciás sesión con tu cuenta de CalaSign, y todo queda en tu organización como cualquier otro sobre.",
  "office.word.h": "Instalar en Word",
  "office.word.p":
    "Descargá `manifest.xml` y cargalo como complemento propio:\n\n- **Word en la web:** **Inicio → Complementos → Más configuraciones → Cargar mi complemento** (*Home → Add-ins → More Settings → Upload My Add-in*), elegí el archivo y tocá **Cargar**. Queda guardado en el navegador: si borrás los datos del sitio, hay que cargarlo de nuevo.\n- **Word para Mac:** copiá el manifiesto a `~/Library/Containers/com.microsoft.Word/Data/Documents/wef` (creá la carpeta si no existe), reiniciá Word y abrilo desde **Inicio → Complementos**.\n- **Word para Windows:** la carga individual requiere una carpeta compartida configurada como catálogo de confianza (**Archivo → Opciones → Centro de confianza → Catálogos de complementos de confianza**). Para equipos, es más simple la instalación centralizada (abajo).",
  "office.outlook.h": "Instalar en Outlook",
  "office.outlook.p":
    "En Outlook en la web, el nuevo Outlook para Windows, el Outlook clásico o Mac: abrí [aka.ms/olksideload](https://aka.ms/olksideload), andá a **Mis complementos** (*My add-ins*), y al final, en **Complementos personalizados**, elegí **Agregar un complemento personalizado → Agregar desde archivo** (*Add a custom add-in → Add from File*) y elegí `manifest-outlook.xml`. En el Outlook clásico puede tardar en aparecer.",
  "office.admin.h": "Instalación centralizada (administradores)",
  "office.admin.p":
    "Un administrador de Microsoft 365 puede instalarlo para toda la organización o para grupos: **Centro de administración de Microsoft 365 → Configuración → Aplicaciones integradas** (*Settings → Integrated apps*) → cargar una aplicación personalizada con el archivo del manifiesto o con su URL, elegir a quién se asigna y **Implementar**. Puede tardar entre 24 y 72 horas en aparecerles a todos.",
  "office.admin.url": "URL del manifiesto",
  // ───────── Referencia ─────────
  "ref.title": "Referencia de la API",
  "ref.lead":
    "Todos los endpoints de la API v1, generados en vivo desde la especificación OpenAPI que sirve el entorno. Cada operación muestra sus parámetros, el cuerpo del pedido, las respuestas y ejemplos listos para copiar.",
  "ref.overview": "Visión general",
  "ref.spanishNote": "Las descripciones de la referencia vienen de la especificación OpenAPI, que está en español.",
  "ref.loadError": "No se pudo cargar la especificación. Probá recargar la página o abrí /v1/openapi.json.",
  "ref.oneOf": "Valores:",
  "ref.default": "Por defecto:",
  "ref.chars": "caracteres",
  "ref.items": "elementos",
  "ref.anyOf": "Acepta una de estas formas:",
  "ref.option": "Opción",
  "ref.freeObject": "Objeto libre (claves y valores a elección).",
  "ref.showChildren": "Ver propiedades",
  "ref.public": "Público",
  "ref.sessionOnly": "Solo sesión web",
  "ref.example": "Ejemplo",
  "ref.header": "Encabezado",
  "ref.description": "Descripción",
  "ref.copyUrl": "Copiar URL",
  "ref.params": "Parámetros",
  "ref.name": "Nombre",
  "ref.in": "En",
  "ref.type": "Tipo",
  "ref.body": "Cuerpo del pedido",
  "ref.responses": "Respuestas",
  "ref.examples": "Ejemplos",
  ...connectorsDocsEs,
  // @@END
};

export type DocsKey = keyof typeof docsEs;

const DICTS: Record<string, Record<DocsKey, string>> = { es: docsEs, "pt-BR": docsPt, en: docsEn };

export function fillVars(s: string, vars: Record<string, string>) {
  return s.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}

const origin = typeof window !== "undefined" ? window.location.origin : "https://dev.calasign.com";
const VARS = { BASE: origin, MCP_URL: `${origin}/mcp` };

/** t(clave, { q: "…" }) — reemplaza {{BASE}}, {{MCP_URL}} y los parámetros {nombre}. */
export function useDocsText() {
  const { locale } = useI18n();
  const d = DICTS[locale] ?? docsEs;
  return useCallback(
    (k: DocsKey, params?: Record<string, string | number>) => {
      let s = fillVars(d[k] ?? docsEs[k] ?? k, VARS);
      if (params) for (const [p, v] of Object.entries(params)) s = s.split(`{${p}}`).join(String(v));
      return s;
    },
    [d],
  );
}

export type DocsT = ReturnType<typeof useDocsText>;
