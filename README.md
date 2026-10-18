# CalaSign SaaS

Firma electrónica en la nube (web + API) para **República Dominicana, Honduras, Colombia, Brasil y Perú**.
Entorno de desarrollo: **https://dev.calasign.com**.

| Documento | Qué tiene |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | Análisis de mercado, marco legal por país, roadmap por fases y **estado de implementación** |
| [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) | Arquitectura (celdas, monolito modular, outbox, `SignatureProvider`) y mapa de módulos |
| [`docs/MODELO-DE-DATOS.md`](docs/MODELO-DE-DATOS.md) | Modelo de datos, evidencia encadenada y migraciones |
| [`docs/EVIDENCIA.md`](docs/EVIDENCIA.md) | PAdES B-T/B-LT/B-LTA, validación, firma XML (DGII, DIAN, SUNAT), custodia de certificados, CSC |
| [`docs/IA.md`](docs/IA.md) | Funciones de IA, opt-in, presupuesto y proveedor (Claude o mock) |
| [`docs/PAGOS-Y-AGENTES.md`](docs/PAGOS-Y-AGENTES.md) | Servidor MCP, cobro dentro de la firma, planes y facturación, medios de pago por país |
| [`docs/CUSTOM-DOMAINS.md`](docs/CUSTOM-DOMAINS.md) | Dominio propio por cliente y TLS bajo demanda |
| [`docs/VIDEO.md`](docs/VIDEO.md) | Sala de firma por videollamada, TURN y escalado |
| [`docs/CRM.md`](docs/CRM.md) | Conectores HubSpot, Salesforce, Siigo y Alegra |
| [`docs/DATOS.md`](docs/DATOS.md) | BYOK, celdas de residencia de datos y renovación de sellos de archivo |

La API completa y vigente está en `GET /v1/openapi.json` y en la página `/developers`.

## Qué hace

| Área | Funcionalidades |
|---|---|
| Firma | Sobres con varios PDF, firmantes en secuencia/paralelo/mixto, copias y aprobadores, editor de campos (firma, iniciales, fecha, nombre, correo, texto, número, desplegable, empresa, cargo, casilla, adjunto), campos condicionales y calculados, plantillas con roles, envío masivo por CSV, formularios web públicos, firma en persona, corrección en vuelo, delegación y reasignación, recordatorios automáticos |
| Firmante | Sin cuenta, por email, WhatsApp o Telegram, en ES/PT-BR/EN; OTP por email/SMS/WhatsApp; verificación de identidad (documento + selfie, mock/Truora/Veriff); firma dibujada o tipeada; resumen y preguntas con IA; pago dentro de la firma; PWA accesible |
| Evidencia | Registro de eventos encadenado por hash, certificado de finalización, sello PAdES B-T/B-LT/B-LTA con clave en KMS, verificación pública (`/verify`) y validador de firmas, sello de empresa, nivel de firma |
| Facturación electrónica | Firma XML por API: DGII e-CF (RD), DIAN (CO, XAdES-EPES), SUNAT CPE (PE), XAdES-BES/EPES genéricos, con certificados de la organización en custodia cifrada |
| API e integraciones | API REST v1 + OpenAPI, API keys y OAuth 2.0 (client credentials, authorization code + PKCE), firma embebida en iframe, webhooks HMAC con reintentos, anclas de texto, idempotencia, SDKs Node y Python, servidor MCP para agentes de IA, Slack/Teams, exportación a Google Drive/Dropbox/OneDrive/S3, dominio propio |
| Equipos y empresa | Miembros e invitaciones, roles y permisos personalizados, grupos, auditoría de cuenta, retención, 2FA, SSO OIDC/SAML, SCIM, branding, reportes |
| Acuerdos e IA | Repositorio con búsqueda, generación de documentos desde plantillas, workflows sin código, negociación con versiones, detección de campos, metadatos y alertas de renovación, revisión contra playbook |
| Video y CRM | Firma por videollamada con co-navegación y grabación; enviar a firmar desde HubSpot y Salesforce con write-back y PDF adjunto; Siigo y Alegra |
| Datos | BYOK con KMS del cliente, residencia de datos por celdas, renovación automática de sellos de archivo |
| Cobro | Planes Free/Starter/Business/Enterprise con límites, uso mensual, precios en USD/BRL/COP/DOP/HNL/PEN, Stripe y Mercado Pago |

## Desarrollo local

```bash
corepack pnpm install
corepack pnpm --filter @calasign/web build      # la API sirve la web compilada
corepack pnpm --filter @calasign/api dev         # http://localhost:4000
# o, para trabajar en la web con recarga: corepack pnpm --filter @calasign/web dev  (http://localhost:5173)
```

Sin variables de entorno usa **PGlite** (Postgres embebido) en `var/`, archivos en disco, un sello autogenerado, IA y
pagos simulados, y el **buzón de desarrollo** (`/app/dev-mailbox`) donde caen correos y mensajes con sus links.
Configuración: `apps/api/src/config.ts` y las variables de cada documento de `docs/`.

### Pruebas

```bash
for t in e2e e2e-integrations e2e-signer e2e-productivity e2e-teams e2e-experience e2e-scale \
         e2e-platform e2e-identity e2e-evidence e2e-mcp e2e-billing e2e-ai e2e-agreements e2e-video e2e-data; do
  node scripts/$t.mjs http://localhost:4000
done
node scripts/e2e-crm.mjs                 # levanta su propia API y simuladores de los proveedores
(cd apps/api && ./node_modules/.bin/vitest run)
(cd packages/pdf && ./node_modules/.bin/vitest run)
(cd packages/xades && ../../apps/api/node_modules/.bin/vitest run)
```

`e2e-integrations`, `e2e-teams`, `e2e-identity`, `e2e-ai`, `e2e-agreements` y `e2e-data` usan funciones que solo existen en el entorno
local (buzón sin sesión, barridos manuales, receptores en 127.0.0.1); el resto también corre contra
`https://dev.calasign.com`.

## Entorno dev — https://dev.calasign.com

Cuenta AWS `calasign-sandbox` (us-east-1), un EC2 con Postgres y Caddy, archivos en S3, sello en KMS, sin SSH (SSM).

```bash
cd infra/dev && terraform apply          # infraestructura (una vez)
./scripts/deploy-dev.sh                  # despliega el working tree actual
./scripts/setup-telegram-dev.sh          # activa el bot de Telegram (pide el token de @BotFather)
```

Las credenciales opcionales de proveedores (Anthropic, Twilio, Truora, Veriff, Google, Dropbox, Microsoft, Stripe, Mercado
Pago, WhatsApp, Telegram, SMTP) se cargan como parámetros SSM `/calasign-saas/dev/<VARIABLE>` y las lee
`deploy-dev.sh`. El certificado del sello lo emite `scripts/issue-dev-seal-cert.ts` con una CA raíz de desarrollo que queda
solo en `var/dev-ca/` (no se versiona). En dev los mensajes van al buzón de desarrollo (SES de la cuenta en sandbox).

## Estructura

```
apps/api         Fastify: API v1, worker de jobs, notificaciones, evidencia, módulos por área (TypeScript)
apps/web         React + Vite: remitente (/app), firmante (/s/:token), páginas públicas
packages/pdf     Estampado, certificado de finalización, PAdES + RFC 3161 + LTV, validador, CSC, texto y docgen
packages/xades   Firma XML: XMLDSig, XAdES-BES/EPES, perfiles DGII, DIAN y SUNAT
packages/shared  Contrato de la API (Zod + tipos) y lógica compartida (condiciones, fórmulas, plantillas)
packages/sdk-node SDK de Node (@calasign/sdk)
sdks/python      SDK de Python
infra/dev        Terraform del entorno dev
scripts/         Pruebas e2e, deploy, PKI de desarrollo, sello, Telegram
```
