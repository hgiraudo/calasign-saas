# Proveedores que reciben datos (SEG-30)

Catálogo único de los terceros a los que CalaSign les manda datos de una organización, de sus usuarios o de sus
firmantes: qué reciben, para qué, dónde y cómo se apaga. Es lo que piden la LGPD (art. 37, registro de operaciones), la
Ley 25.326 y los cuestionarios de seguridad de los clientes. Relevado del código el 3-Nov-2026; cada fila cita dónde se
arma el pedido.

🔴 **Un proveedor nuevo se suma acá antes de integrarlo**, en el mismo PR que el código
([`seguridad-y-cumplimiento.md`](estandares/seguridad-y-cumplimiento.md) SEG-30).

Las variables de entorno se cargan en dev como parámetros SSM `/calasign-saas/dev/<VARIABLE>` (las lee
`scripts/deploy-dev.sh`): para apagar un proveedor de la plataforma se borra el parámetro y se vuelve a desplegar.
Rutas de código relativas a `apps/api/src/` salvo que digan otra cosa.

## 1. Los contrata la plataforma

CalaSign es el responsable del contrato (y del acuerdo de tratamiento de datos) con cada uno.

| Proveedor | Para qué | Qué datos recibe | Dónde | Cómo se activa / apaga | Código · doc |
|---|---|---|---|---|---|
| **Amazon SES** (SMTP) | Todo el correo: invitaciones, códigos, avisos, alertas | Email y nombre del destinatario, asunto, cuerpo con el remitente, el mensaje y el **link de firma** o el código. Sin adjuntos. Etiqueta `tenant=<id>` | **us-east-2**, cuenta personal 006121953992 (fuera de la organización AWS) | `SMTP_URL` (+ `SES_CONFIGURATION_SET`, `SES_SNS_TOPIC_ARNS`). Sin él, en producción el envío falla | `notifications/channels.ts` · [`CORREO-REBOTES.md`](CORREO-REBOTES.md) |
| **AWS S3** | Archivos: originales, PDF sellados, adjuntos, imágenes de firma, backups | Todos los archivos de la organización | Dev: **us-east-1**. Por organización, la región de su **celda** | `S3_BUCKET`, `AWS_REGION`, `CELLS` (sin bucket, disco local) | `infra/storage.ts` · [`DATOS.md`](DATOS.md) §2 |
| **AWS KMS** | Sello de la plataforma, custodia de certificados, cifrado de archivos | Sello: sólo el **hash** a firmar. Custodia: claves de datos (Encrypt/Decrypt/GenerateDataKey) | La del ARN (dev: us-east-1) | `KMS_KEY_ID`, `CUSTODY_KMS_KEY_ID` | `infra/kms.ts`, `infra/seal.ts` · [`EVIDENCIA.md`](EVIDENCIA.md) §5 |
| **Anthropic** (Claude) | IA: detección de campos, resumen y preguntas del firmante, metadatos, revisión contra el playbook | **Texto completo** de los PDF (con página y línea) y el nombre del documento; la pregunta del firmante; las reglas del playbook. No van firmas, imágenes ni datos de contacto | No determinada (`api.anthropic.com`, sin región fijada) | Plataforma: `ANTHROPIC_API_KEY`; sin clave, mock en dev y apagada en prod (`APP_ENV=prod`). **Organización: opt-in** en Ajustes → IA (`ai_enabled` + aviso aceptado); por sobre, `ai_signer_assist` y `ai_auto_extract`. Plan Free sin IA | `modules/ai/provider.ts`, `ai/heuristics.ts` · [`IA.md`](IA.md) |
| **Twilio** (SMS) | Código OTP por SMS y link para firmar en el celular (`/h/…`) | Teléfono del firmante y el texto: código o **link de firma** | No determinada (`api.twilio.com`) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. Por destinatario: método `otp_sms`. Sin interruptor por organización | `notifications/sms.ts` |
| **Meta** (WhatsApp Cloud API) | Avisos (para firmar, completado, anulado, rechazado) y OTP | Teléfono; plantilla con el nombre del remitente, el asunto y el **link de firma**, o el código | No determinada (`graph.facebook.com`) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` y una plantilla por aviso (sin plantilla, ese aviso no sale). Por destinatario: canal `whatsapp` u `otp_whatsapp`. Sin interruptor por organización | `notifications/channels.ts` |
| **Telegram** (Bot API) | Avisos al firmante que vinculó su chat | `chat_id`, asunto, remitente y botón con el **link de firma**. La vinculación usa un token propio de un solo uso | No determinada (`api.telegram.org`) | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`. El firmante decide si vincula | `notifications/channels.ts`, `modules/telegram.ts` |
| **Veriff** (KYC) | Verificación de identidad del firmante | Nombre y apellido, número de documento declarado, id de la verificación. Documento, selfie y prueba de vida los sube el firmante **directo** en Veriff; vuelven nombre, nacimiento, documento, país y resultado facial | No determinada (`stationapi.veriff.com`) | `VERIFF_API_KEY`, `VERIFF_SHARED_SECRET`. Organización: proveedor por defecto en Identidad; por destinatario | `modules/identity/providers.ts` · [`VERIFICACION-IDENTIDAD.md`](VERIFICACION-IDENTIDAD.md) |
| **Truora** (KYC) | Ídem, LatAm | Sólo el id de la verificación, la URL de vuelta y el flujo. El firmante sube documento y selfie en Truora; vuelven los datos del documento y la validación | No determinada (`*.truora.com`) | `TRUORA_API_KEY`, `TRUORA_WEBHOOK_SECRET`, `TRUORA_FLOW_ID`. Se elige igual que Veriff | ídem |
| **Stripe** | Cobro al firmante dentro del sobre; suscripción de la organización | Monto, moneda, descripción del remitente, ids (pago, sobre, organización, destinatario) y **email del firmante**; en la suscripción, el plan y el email del administrador. La tarjeta la carga la persona en Stripe | No determinada (`api.stripe.com`) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Por sobre, el remitente configura el cobro. Una sola cuenta de la plataforma (sin Stripe Connect) | `modules/billing/` · [`PAGOS-Y-AGENTES.md`](PAGOS-Y-AGENTES.md) |
| **Mercado Pago** | Ídem | Título, precio, moneda, referencia y **email del firmante**; en la suscripción, email del administrador y monto | Según el país de la cuenta | `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET` | ídem |
| **TSA** (hoy `freetsa.org`) | Sello de tiempo RFC 3161 de cada firma y renovación B-LTA | Sólo el **hash** de la firma y un nonce | Alemania (freetsa); sin acuerdo de servicio (SEG-04) | `TSA_URL` (vacío = sin sello de tiempo, nivel B-B), `TSA_REQUIRED`; la organización puede elegir B-B | `packages/pdf/src/cms.ts`, `modules/evidence-seal.ts` |
| **OCSP / CRL de cada CA** | Revocación al sellar B-LT/B-LTA y, opcionalmente, al validar | Número de serie y emisor de cada certificado de la firma (sello, firmante con certificado, custodia) | La URL del propio certificado | Nivel de sello (`SEAL_LEVEL`, `seal_level` de la organización); en `/v1/validate`, `VALIDATE_ONLINE_REVOCATION` (apagado por defecto) | `packages/pdf/src/ltv.ts` · [`EVIDENCIA.md`](EVIDENCIA.md) |
| **Cloudflare Turnstile** | Antibots de los formularios públicos `/f/…` | Navegador: el script de Cloudflare (IP y huella del visitante). API: el token y la **IP del visitante** | No determinada | `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`; sin ellas, apagado | `modules/webforms.ts`, `apps/web/src/pages/PublicForm.tsx` |
| **DNS sobre HTTPS** (Cloudflare; Google de respaldo) | Verificar dominios propios, de correo y SSO | Nombres de dominio y registros TXT. Sin datos personales | `cloudflare-dns.com`, `dns.google` | Siempre, al verificar un dominio | `modules/custom-domains.ts` |
| **Let's Encrypt** | Certificados TLS (Caddy) | Nombres de dominio | — | Caddy, automático | `infra/dev/host/Caddyfile` · [`CUSTOM-DOMAINS.md`](CUSTOM-DOMAINS.md) |
| **Proveedores CSC** (firma remota) | Probar un conector de firma remota | Hashes y el PIN/OTP del conector | La URL de cada conector | `CSC_CONNECTORS`. Hoy sólo lo usa la prueba `POST /v1/signature-providers/:id/test`, no el sellado de sobres | `packages/pdf/src/csc.ts` · [`EVIDENCIA.md`](EVIDENCIA.md) §6 |

## 2. Los conecta la organización, con su propia cuenta

La cuenta y el contrato con el proveedor son de la organización; CalaSign actúa como encargado y manda sólo lo que la
organización configuró. Las integraciones OAuth usan una app registrada por la plataforma (`<PROVEEDOR>_CLIENT_ID` /
`_SECRET`): sin esas variables, el proveedor no se ofrece. Se apagan desconectando en la consola (con revocación del
token donde el proveedor la admite).

| Proveedor | Qué datos recibe | Dónde | Cómo se conecta / apaga | Código · doc |
|---|---|---|---|---|
| **Google Drive, Dropbox, OneDrive / SharePoint, Box, S3 compatible** (archivado) | **PDF sellado** (asunto e id en el nombre); con `includeEvidence`, el **JSON de evidencia** (nombre, email, teléfono, documento, IP y user-agent de cada firmante y los eventos) | APIs globales; S3, el endpoint de la organización | Ajustes → Almacenamiento | `modules/storage-export.ts` · [`CONECTORES.md`](CONECTORES.md) |
| **CRM / ERP**: HubSpot, Salesforce, Zoho CRM / Bigin, Pipedrive, RD Station, Kommo, Siigo, Alegra | Estado del sobre en el registro y, al completarse, el **PDF sellado** con una nota; lee el registro para prellenar | Zoho: el centro de datos elegido; Kommo, Pipedrive: el subdominio; Salesforce: la instancia | Ajustes → CRM (OAuth, o token/clave de la organización en Siigo, Alegra y HubSpot) | `modules/crm/` · [`CRM.md`](CRM.md) |
| **RR. HH. y contratos**: BambooHR, HiBob, Factorial, Ironclad, Juro | PDF sellado; con `uploadEvidence`, el JSON de evidencia; estado. Lee la persona o el contrato | Ironclad: la región elegida (na1/eu1); BambooHR: el subdominio | Clave de API de la organización u OAuth (Ironclad, Factorial) | `modules/connectors/` · [`CONECTORES.md`](CONECTORES.md) |
| **Avisos a canales**: Slack, Teams, Discord, Google Chat, Mattermost, Rocket.Chat, Webex | Evento, **asunto del sobre**, **nombre del firmante**, organización y link a la consola | La URL del webhook entrante | Ajustes → Avisos a canales (URL cifrada) | `modules/notify-integrations.ts` |
| **Webhooks de la organización** (incluye Zapier, Make, Power Automate, n8n) | Datos del sobre: id, asunto, estado, `metadata`, fechas, hash del PDF y destinatarios con nombre, **email**, rol y estado | El destino elegido (con la protección SSRF, SEG-31) | Ajustes → Webhooks o la API; se desactiva solo si falla seguido | `modules/webhooks.ts` · [`CONECTORES.md`](CONECTORES.md) |
| **IdP de SSO** (Entra ID, Google Workspace, Okta…) | Pedido de login; el IdP devuelve email y nombre | El de la organización | Ajustes → Identidad | `modules/identity/sso.ts` |
| **Agentes de IA de la organización** (MCP: Claude, ChatGPT, Gemini) | Lo que el agente pida con el token del usuario: sobres, PDF, links de descarga | El del proveedor de IA | El usuario conecta por OAuth o API key; se revoca el token o la key | [`MCP-CONECTORES.md`](MCP-CONECTORES.md) |
| **AWS KMS del cliente** (BYOK) | Cifrado de los archivos nuevos y de las claves de custodia | La región del ARN | Ajustes → Datos | `modules/data/byok.ts` · [`DATOS.md`](DATOS.md) §1 |

## 3. Desde el navegador o el cliente de correo

- **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`): Google recibe la IP y el navegador de quien mira.
  La app no carga fuentes externas (la base es `@fontsource`, local): sólo pasa cuando la marca de la organización
  elige una fuente de Google (`fontSource: "google"`), en la página de firma, las vistas previas y el **HTML de los
  correos** (el cliente de correo del firmante le pide la fuente a Google). Se apaga eligiendo una fuente del sistema
  o subida, en Marca. Código: `modules/white-label/brand.ts`, `notifications/templates.ts`.
- **Microsoft Office** (CDN de office.js y MSAL, con su telemetría): sólo con el complemento de Word/Outlook instalado.
- **Checkout de Stripe / Mercado Pago y páginas de Veriff / Truora**: el navegador va al proveedor (§1).

## 4. Lo que no hay

- **Ni analítica ni seguimiento de errores**: no hay Sentry, Google Analytics, PostHog, Datadog, Mixpanel ni similares.
  CloudWatch recibe sólo métricas del backup y de SES (sin datos personales).
- El **Firmador** sólo habla con la API de CalaSign y con el token o almacén de certificados local.

## 5. A tener en cuenta

- 🟡 **El link de firma pasa por SES, Twilio, Meta y Telegram**: quien lo tiene puede firmar (hasta que venza o se use
  el OTP). Es inherente a mandarlo por ese canal; por eso el OTP es configurable por destinatario.
- 🟡 **SMS, WhatsApp y Telegram no tienen un interruptor por organización**: se eligen por destinatario y los habilita
  la plataforma. Una organización que no los quiera hoy depende de que nadie los elija.
- 🟡 **La celda de residencia fija dónde se guardan los archivos** (y la base, con un despliegue por celda): SES (us-east-2), Anthropic, Twilio, Meta, Stripe,
  Mercado Pago y los KYC procesan donde procesa cada proveedor, sea cual sea la celda.
- 💲 **Región de procesamiento sin confirmar** para Anthropic, Twilio, Meta, Telegram, Veriff, Truora, Stripe,
  Mercado Pago, Google, Dropbox, Microsoft y Box: el código usa sus endpoints globales. Se confirma con el acuerdo de
  tratamiento de datos (DPA) de cada uno al contratar la cuenta de producción.
