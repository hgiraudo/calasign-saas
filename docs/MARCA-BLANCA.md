# Marca blanca (white-label)

Objetivo: que un cliente (o un revendedor con varios clientes) integre la firma electrónica con **su** marca y que
ningún firmante, remitente ni tercero vea "CalaSign" (ni otra marca de proveedor) si la organización activa la marca
blanca total.

- Configuración: **Ajustes → Marca** (`/app/settings/branding`) o la API `/v1/settings/brands` (OpenAPI, tag "Marca";
  SDK Node `cs.brands.*`, SDK Python `client.brands.*`).
- Plan: colores y logo = funcionalidad `branding`; todo lo que es marca blanca (ocultar la plataforma, nombre de
  producto, textos, plantillas, remitente propio, CSS propio, sub-marcas, dominios de correo/sub-marca) = `white_label`
  (Enterprise). Registrar y también verificar (o re-verificar) un dominio de correo o de sub-marca exige `white_label`
  (402); quitarlo no. Fuera de producción el plan por defecto es Enterprise.
- Prueba: `node scripts/e2e-white-label.mjs http://localhost:4000` (entorno local) y `apps/api/test/white-label.test.ts`.

## 1. Auditoría (octubre 2026)

Dónde veía un firmante, remitente o tercero la marca de la plataforma (o de otro proveedor), y cómo queda.

### El caso "onespan" después de firmar

**No sale de este repositorio**: en `calasign-saas` no hay ninguna referencia a OneSpan en código que se ejecute (solo en
`ROADMAP.md` y `docs/ARQUITECTURA.md`). Sale de **dynamic-form** (`/home/hernan/cala/dynamic-form`), que todavía firma
con **OneSpan Sign**:

- `frontend/src/components/EsignFrame.jsx` enmarca la ceremonia de OneSpan en un iframe (`title="OneSpan Sign"`, hosts
  permitidos `*.esignlive.com`, `*.onespan.com`). Al terminar, la página de "firma completada" y sus redirecciones las
  sirve **OneSpan** dentro del iframe, con su marca; en los paquetes con certificado la ceremonia va directa a OneSpan
  (`backend/server.js`, "¿Esta ceremonia va enmarcada en /esign o directa a OneSpan?").
- Los correos de OneSpan usan las plantillas de cuenta de `white-label/onespan/*` con links
  `https://onespan.formularios.biz/esign?url=…` — el subdominio mismo dice "onespan".

Solución: migrar dynamic-form a CalaSign como cliente de la API (como prevé `docs/ARQUITECTURA.md`): crear el sobre con
`brandId`, firma embebida (`POST /v1/envelopes/{id}/recipients/{recipientId}/signing-url`) y webhooks. Con la marca
blanca de este documento, la pantalla final, los correos y el PDF quedan con la marca del cliente. Mientras tanto,
renombrar el subdominio `onespan.formularios.biz` y configurar en OneSpan la URL de retorno ("handover URL") hacia una
página propia reduce lo que se ve, pero el iframe de OneSpan sigue mostrando su marca hasta migrar.

### Inventario

| Lugar | Antes | Ahora |
|---|---|---|
| Página de firma `/s/:token`: barra, pie "Firma electrónica segura con CalaSign" + logo | fijo | Tema completo; pie oculto con marca blanca total (o "… con *Producto*"), links propios de soporte/privacidad/términos |
| Título de la pestaña, favicon, `theme-color`, `apple-mobile-web-app-title`, manifest PWA | "CalaSign" fijo en `index.html` | El servidor inyecta la marca en `index.html` (por token, formulario, `?b=` o dominio): título, favicon, color, CSS y datos (`#brand-data`), sin parpadeo; manifest y favicon propios en el dominio de la marca |
| Pantalla de finalización y textos ("Gracias…", OTP, consentimiento, etc.) | diccionarios fijos | Nombre del producto en todos los diccionarios + textos propios por idioma (`config.texts`) |
| Página sin conexión (service worker) `offline.html` | "CalaSign" | En el dominio de una marca, página con su nombre/color |
| Verificación `/verify` y `POST /v1/verify` | logo y pie de la plataforma; organización = nombre legal | `?b=<marca>` en el link del certificado: página con la marca; la respuesta trae el nombre visible de la marca |
| Firma embebida (iframe) | misma página de firma; página de "link vencido" con `<title>CalaSign` | Misma marca que la página de firma; título neutro; la URL embebida usa el dominio de la marca del sobre |
| Correos (invitación, recordatorio, vencimiento, certificado, completado, rechazo, anulación, avisos al remitente, error de sellado) | encabezado "CalaSign", pie "Enviado con CalaSign…", "contacto@calasign.com", remitente `CalaSign <no-reply@calasign.com>`, logo servido desde el dominio de la plataforma | Plantillas editables por evento e idioma con variables y vista previa; colores, botón, tipografía, logo **desde el dominio de la marca**; pie propio; sin pie de la plataforma; remitente propio con DKIM |
| Código de verificación (correo/SMS/WhatsApp) | "Tu código de verificación de CalaSign" | Plantilla `otp_code` de la marca; nombre del producto; remitente propio; remitente alfanumérico de SMS (Twilio, opcional) |
| Telegram | "CalaSign: link inválido…" | Texto neutro; links con el dominio de la marca |
| Certificado de finalización (PDF) | "firmado electrónicamente mediante CalaSign", pie "CalaSign · Sobre", eventos con actor "CalaSign" | Producto de la marca (o sin nombrar ninguno), color y logo de la marca, actor del sistema con el nombre del producto, link de verificación con el dominio y `?b=` de la marca |
| Metadatos del PDF firmado | Producer/Creator "CalaSign", campo de firma `SelloIntegridad`, Reason "Sello de integridad CalaSign", ContactInfo `https://calasign.com`, Location "Cloud" (sello de empresa y firma con certificado) | Producer/Creator y Reason con el producto de la marca, campo `SelloIntegridad`, ContactInfo = soporte o dominio de la marca, Location neutra |
| Copia en curso (`copy.pdf`) | Producer "CalaSign" | Producto de la marca |
| Asistente de IA del firmante | prompt "Sos el asistente de documentos de CalaSign" | No nombra la plataforma |
| Sesión de firma (`GET /v1/signing/:token`) | `senderName` de respaldo "CalaSign" | Nombre de la marca; trae `theme` (tema público completo) |
| OAuth consent, login y app del remitente en un dominio propio | logo y textos "CalaSign" | Con el dominio de la marca: logo y nombre del producto en toda la web (mismos diccionarios) |

### Lo que todavía nombra a la plataforma (no lo ve un firmante, o requiere configuración del operador)

| Lugar | Por qué / qué hacer |
|---|---|
| **Certificado X.509 del sello de la plataforma** (panel de firmas de Acrobat) | Es la identidad del operador (KMS/CA). En local se llama "CalaSign Local Dev Root CA". En producción, emitir el certificado del sello con un nombre neutro, o que cada cliente use su **sello de empresa** (Ajustes → Evidencia), que firma con su propio certificado. La e2e excluye los certificados DER de la búsqueda. |
| Dirección del remitente sin dominio propio | Sin dominio de correo verificado, la dirección es la de la plataforma (`MAIL_FROM`, p. ej. `no-reply@calasign.com`) con el nombre de la marca. Configurar `MAIL_FROM_WHITE_LABEL` con una dirección de un dominio neutro, o verificar el dominio del cliente. |
| WhatsApp | El nombre visible es el de la cuenta de WhatsApp Business de la plataforma y las plantillas aprobadas en Meta son de la plataforma (`calasign_signature_request`). Para una marca propia: número/WABA propio (no implementado por marca). |
| Telegram | El bot es el de la plataforma (`TELEGRAM_BOT_USERNAME`). Un bot por marca no está implementado. |
| Firmador (app de escritorio para firmar con certificado/token) | La app se llama "Firmador CalaSign"; el texto del correo ya dice "Firmador *Producto*", pero el instalador es el de la plataforma. Requiere un build por revendedor. |
| Correos al equipo del cliente que no dependen de un sobre: restablecer contraseña, invitación al equipo (`teams.ts`) | Son de la cuenta (usuario), no de una marca; siguen con la marca de la plataforma. |
| Portal de desarrolladores (`/developers`), OpenAPI (`info.title`), SDKs (`@calasign/sdk`, `calasign`), headers de webhooks (`CalaSign-Signature`, `User-Agent: CalaSign-Webhooks/1.0`) | Los ve el integrador, no el firmante. Un revendedor publica su propia documentación; renombrar headers rompería integraciones existentes. |
| `integrations/` (skill de Claude, MCPB, add-in de Office, Gemini, ChatGPT, sitio) | Artefactos estáticos con la marca de la plataforma, para usuarios del remitente. Un revendedor necesitaría builds propios (`integrations/build.mjs` con nombre/íconos parametrizados): pendiente. |
| Proveedores de KYC, pagos y TSA | Sus pantallas/recibos llevan su marca (Truora, Veriff, Stripe, Mercado Pago). El proveedor de prueba se llama "CalaSign (prueba)". |
| Registros DNS de dominios propios de organizaciones (`_calasign-challenge`) | Solo los ve el administrador del cliente. Los nuevos (dominios de correo y de sub-marcas) usan nombres neutros (`_mail-verify`, `_brand-verify`). |

## 2. Modelo

- **Marca de la organización** (`id = "default"`): `tenants.branding.whiteLabel` (+ `whiteLabelAssets`). Los campos
  históricos (`primaryColor`, `emailFooter`, `logoFileId`) se siguen leyendo y se mantienen sincronizados: `/v1/settings/branding`
  sigue funcionando igual.
- **Sub-marcas** (tabla `brands`, migración 0044): una organización revendedora crea una por cliente. **Heredan** de la
  marca de la organización todo lo que no definen (colores, textos, plantillas, remitente, archivos).
- **Sobre**: `envelopes.brand_id` (`brandId` en `POST/PATCH /v1/envelopes`). Sin `brandId`, la marca de la organización.
  Elegir una sub-marca distinta de la que ya tiene el sobre exige `white_label` en el plan (402 si bajó de plan; la
  que ya tenía un borrador se acepta igual) y un `brandId` ajeno responde 400 `invalid_brand`. Al clonar sin ese
  plan, el clon sale con la marca de la organización.
  Todo lo del sobre usa su marca: correos, links, página de firma, embebido, OTP, certificado, verificación.
- **Dominios** (migración 0045): `email_domains` (remitente con DKIM) y `brand_domains` (dominio web de una sub-marca; la
  marca de la organización usa `custom_domains`, ver [CUSTOM-DOMAINS.md](CUSTOM-DOMAINS.md)).

### Configuración (`BrandConfigInput`)

```jsonc
{
  "displayName": "Seguros Andinos",          // nombre que ven los firmantes
  "productName": "FirmaAndina",              // reemplaza a "CalaSign" en textos, correos, PDF, título
  "hidePoweredBy": true,                     // marca blanca total
  "theme": {
    "primaryColor": "#123456", "secondaryColor": "#aa5500", "backgroundColor": "#fafafa", "textColor": "#111111",
    "buttonColor": "#00aa55", "buttonTextColor": "#ffffff", "headerTextColor": "#ffffff",
    "borderRadius": 4, "fontFamily": "Montserrat", "fontSource": "google"   // system | google | upload
  },
  "customCss": ".signer-bar{letter-spacing:.02em}",   // sin url(), @import, \ ni "<"
  "links": { "websiteUrl": "…", "supportUrl": "https://ayuda…", "privacyUrl": "…", "termsUrl": "…" },
  "email": { "fromName": "Firmas Andinos", "fromEmail": "firmas@andinos.com", "replyTo": "ayuda@andinos.com", "footer": "…" },
  "templates": { "invite": { "es": { "subject": "{{organizationName}} necesita tu firma: {{subject}}", "body": "Hola {{recipientName}}:\n\n…", "cta": "Firmar ahora" } } },
  "texts": { "es": { "sign.doneTitle": "¡Listo, gracias por firmar!" } },
  "sms": { "senderId": "ANDINOS" }
}
```

- Eventos de plantilla: `invite, reminder, expiry_warning, certificate_request, completed, declined, voided,
  sender_completed, sender_declined, finalize_failed, otp_code`. Variables: `{{recipientName}} {{senderName}}
  {{organizationName}} {{subject}} {{message}} {{link}} {{reason}} {{declinedBy}} {{productName}} {{supportUrl}} {{code}}`.
  El cuerpo es texto (una línea en blanco separa párrafos); el HTML base (colores, logo, botón, pie) lo arma la plataforma:
  no se aceptan plantillas HTML completas (seguridad y entregabilidad).
- Textos: cualquier clave de los diccionarios de la web (p. ej. `sign.doneTitle`, `otp.title`), por idioma (es, pt-BR, en).
  Excepto los de la verificación pública: las claves `verify.*` (salvo `verify.title` y `verify.text`) y `val.*` (veredicto,
  cadena, reporte técnico) se descartan al guardar (sin error: la consola reenvía la configuración completa), no se
  devuelven y no se aplican nunca (la migración 0082 borró las guardadas antes). En `/verify` (también `/verify/`) tampoco
  se aplica el CSS propio ni el fondo/color de texto del tema: solo la barra (color, logo), los botones y la fuente; al
  salir de `/verify` navegando dentro de la web se restaura el CSS completo de la marca.
- Archivos: `logo`, `logoDark` (fondos oscuros: login, verificación), `favicon` (PNG/SVG/ICO), `font` (WOFF2/WOFF/TTF/OTF).
  Se sirven en `/v1/public/brand-assets/<marca>/<tipo>` y, en correos y PDF, con el dominio de la marca.

### API

| Método | Ruta | |
|---|---|---|
| GET | `/v1/settings/brands` | Marcas (default + sub-marcas) con la configuración propia, la efectiva y el remitente resultante |
| POST | `/v1/settings/brands` | Crear sub-marca |
| GET / PUT / DELETE | `/v1/settings/brands/{id}` | `id` = `default` o uuid. PUT reemplaza la configuración |
| POST | `/v1/settings/brands/{id}/preview` | `{kind:"email", event, locale, config?}` → asunto/HTML/texto/remitente; `{kind:"theme"}` → tema |
| POST / DELETE | `/v1/settings/brands/{id}/assets/{kind}` | Archivos (multipart `file`) |
| PUT / DELETE, POST …/verify | `/v1/settings/brands/{id}/domain` | Dominio web de una sub-marca |
| GET / POST, POST …/verify, DELETE | `/v1/settings/email-domains[/{domain}]` | Dominios de correo |
| GET | `/v1/public/brand-theme?b=` | Tema público (por `?b=` o por el Host) |
| POST / PATCH | `/v1/envelopes` | `brandId` (aditivo) |

## 3. Configuración que tiene que hacer el operador / el cliente

### Correo con dominio propio (SPF / DKIM / DMARC)

1. Cliente: **Ajustes → Marca → Dominios → Dominios de correo**, agrega `andinos.com` y publica:
   - TXT `_mail-verify.andinos.com` = `mail-verify=<token>` (propiedad, obligatorio);
   - TXT `<selector>._domainkey.andinos.com` = `v=DKIM1; k=rsa; p=<clave pública>` (obligatorio; la clave privada se
     guarda cifrada y los correos se firman con ella);
   - SPF `v=spf1 include:<MAIL_SPF_INCLUDE> ~all` y DMARC `_dmarc` (recomendados).
2. Verifica; luego pone `email.fromEmail` en una dirección de ese dominio. Hasta verificar, los correos salen de la
   dirección de la plataforma con el nombre de la marca (y `Reply-To` a la del cliente).
3. **Operador** (no aplicado): el proveedor SMTP tiene que aceptar remitentes de otros dominios.
   - **Amazon SES**: exige identidades verificadas. Opciones: (a) verificar cada dominio de cliente también en SES
     (Easy DKIM con sus CNAME; automatizable con `CreateEmailIdentity` — pendiente), o (b) usar BYODKIM de SES con la
     misma clave que genera la plataforma. Definir `MAIL_SPF_INCLUDE=amazonses.com`.
   - Un relay propio (Postfix) o proveedores que permiten cualquier remitente con SPF/DKIM del cliente funcionan tal cual.
   - `MAIL_FROM_WHITE_LABEL="Notificaciones <no-reply@notificaciones-firma.com>"`: dirección neutra para marcas con
     marca blanca total sin dominio propio (dominio del operador sin su marca, con SPF/DKIM/DMARC propios).
4. SMS: el remitente alfanumérico `sms.senderId` se usa solo si (a) la organización está en
   `SMS_ALPHANUMERIC_ALLOWED_TENANTS` (ids de organización separados por coma) y (b) `TWILIO_ALLOW_ALPHANUMERIC=true`.
   Si no, los SMS salen con el número por defecto (`TWILIO_FROM`), aunque la marca tenga un `senderId` guardado.
   Motivo: un remitente alfanumérico no se verifica (cualquiera podía mandar los códigos como "BANCO" o con el nombre de
   otra marca). Antes de agregar una organización a la lista: verificar que el nombre le pertenece y registrar el
   remitente en Twilio para los países donde se usa (algunos exigen registro previo; otros no lo admiten).

### Dominio web

- Marca de la organización: [CUSTOM-DOMAINS.md](CUSTOM-DOMAINS.md).
- Sub-marca: `PUT /v1/settings/brands/{id}/domain`, TXT `_brand-verify.<dominio>` + CNAME al host de la plataforma.
- **Caddy**: cambiar el `ask` de TLS bajo demanda a `http://127.0.0.1:4000/internal/tls-allowed-brand`, que autoriza los
  dominios de organizaciones **y** de sub-marcas (el `/internal/tls-allowed` original solo conoce los de organizaciones).
- La re-verificación de dominios de sub-marca y de correo corre cada 6 h (tarea periódica `white-label-domains`). Un
  registro que falta suma 2 puntos y un error de DNS (SERVFAIL, timeout) suma 1; con 4 el dominio vuelve a pendiente.
  Un error de DNS nunca despublica un dominio de correo.
- Igual que los dominios propios, un dominio de sub-marca **no sirve la cuenta**: login y `/app` redirigen a la
  plataforma y la cookie de sesión se ignora (ver [CUSTOM-DOMAINS.md](CUSTOM-DOMAINS.md)). Lo ve el firmante
  (`/s`, formularios, verificación) con la marca; quien administra entra por el dominio de la plataforma.
- Un mismo dominio no puede estar verificado a la vez como dominio propio de una organización y como dominio de sub-marca.

### CSP

La API agrega `https://fonts.googleapis.com` (estilos) y `https://fonts.gstatic.com` (fuentes) para Google Fonts. Para no
compartir la IP del firmante con Google, el cliente puede subir su fuente (`fontSource: "upload"`).

## 4. Pendiente

- Verificación automática del dominio de correo en Amazon SES (identidades) y WhatsApp/Telegram por marca.
- Builds con marca de `integrations/` y del Firmador por revendedor.
- Correos de cuenta (contraseña, invitaciones) con la marca del dominio desde el que se piden.
- Formularios web (`/f/:slug`) por sub-marca (hoy usan la marca de la organización).
