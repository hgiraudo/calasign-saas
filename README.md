# CalaSign SaaS

Firma electrónica en la nube (web + API) para República Dominicana, Honduras, Colombia y Brasil.

| Documento | Qué tiene |
|---|---|
| [`ROADMAP.md`](ROADMAP.md) | Análisis de mercado, marco legal por país y roadmap de features por fases |
| [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) | Arquitectura para escalar (celdas, monolito modular, outbox, `SignatureProvider`) y contrato de la API v1 |
| [`docs/MODELO-DE-DATOS.md`](docs/MODELO-DE-DATOS.md) | Modelo de datos y evidencia encadenada |

## Qué hace el MVP (Fase 1)

- Alta de cuenta y organización, sesión web y **API keys**.
- Sobres con varios PDF, firmantes en **secuencia, paralelo o mixto** (`routingOrder`) y copias.
- Editor de campos sobre el PDF: firma, iniciales, fecha de firma, nombre, correo, texto, casilla.
- Invitaciones por **email, WhatsApp y Telegram**, en **español, portugués e inglés**.
- Firmante sin cuenta: consentimiento, firma dibujada o tipeada, rechazo con motivo, descarga final.
- Al completar: campos estampados, **certificado de finalización** y **sello PAdES B-T** (sello de tiempo RFC 3161) con la clave de la plataforma en **KMS**.
- Registro de eventos **encadenado por hash**, idempotencia (`Idempotency-Key`), vencimientos, recordatorios, anulación.

## Desarrollo local

```bash
corepack pnpm install
corepack pnpm --filter @calasign/web build      # la API sirve la web compilada
corepack pnpm --filter @calasign/api dev         # http://localhost:4000
# o, para trabajar en la web con recarga: corepack pnpm --filter @calasign/web dev  (http://localhost:5173)
node scripts/e2e.mjs http://localhost:4000       # prueba de punta a punta
```

Sin variables de entorno usa **PGlite** (Postgres embebido) en `var/`, archivos en disco, un sello autogenerado y el
**buzón de desarrollo** (`/app/dev-mailbox`) donde caen los correos y mensajes con sus links. Configuración: `apps/api/src/config.ts`.

## Entorno dev — https://dev.calasign.com

Cuenta AWS `calasign-sandbox` (us-east-1), un EC2 con Postgres y Caddy, archivos en S3, sello en KMS, sin SSH (SSM).

```bash
cd infra/dev && terraform apply          # infraestructura (una vez)
./scripts/deploy-dev.sh                  # despliega el working tree actual
./scripts/setup-telegram-dev.sh          # activa el bot de Telegram (pide el token de @BotFather)
```

El certificado del sello lo emite `scripts/issue-dev-seal-cert.ts` con una CA raíz de desarrollo que queda solo en
`var/dev-ca/` (no se versiona). En dev los mensajes van al buzón de desarrollo (SES de la cuenta sigue en sandbox).

## Estructura

```
apps/api        Fastify: API v1, worker de jobs, notificaciones, evidencia (TypeScript)
apps/web        React + Vite: remitente (/app) y firmante (/s/:token)
packages/pdf    Estampado, certificado de finalización, PAdES + RFC 3161, SignatureProvider
packages/shared Contrato de la API (Zod + tipos) compartido por api y web
infra/dev       Terraform del entorno dev
scripts/        e2e, deploy, emisión del certificado del sello, Telegram
```
