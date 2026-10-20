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
| [`docs/CRM.md`](docs/CRM.md) | Conectores HubSpot, Salesforce, Zoho CRM / Bigin, Pipedrive, RD Station CRM, Kommo, Siigo y Alegra |
| [`docs/CONECTORES.md`](docs/CONECTORES.md) | Conectores sin código: Power Automate, Zapier, Make, n8n, Dynamics 365, RR. HH. y CLM (BambooHR, Ironclad, Juro, Box, SharePoint) |
| [`docs/MARCA-BLANCA.md`](docs/MARCA-BLANCA.md) | Marca blanca: sub-marcas, textos y plantillas propios, remitente y dominios de correo/sub-marca |
| [`docs/API-ROADMAP.md`](docs/API-ROADMAP.md) | Comparación de la API con la de otros proveedores de firma, brechas y roadmap |
| [`docs/DATOS.md`](docs/DATOS.md) | BYOK, celdas de residencia de datos y renovación de sellos de archivo |
| [`docs/FIRMA-CON-CERTIFICADO.md`](docs/FIRMA-CON-CERTIFICADO.md) | Firma con el certificado del titular (token PKCS#11, almacén de Windows, .p12) y el Firmador CalaSign |
| [`docs/MCP-CONECTORES.md`](docs/MCP-CONECTORES.md) | Conectores MCP para Claude, ChatGPT, Claude Code y Gemini: registro dinámico de clientes OAuth (RFC 7591), `resource` (RFC 8707), herramientas |
| [`integrations/README.md`](integrations/README.md) | Skill de Claude, plugin de Claude Code, extensión MCPB, Gemini CLI, ChatGPT y complemento de Word/Outlook (`/integrations/`) |

La API completa y vigente está en `GET /v1/openapi.json` y en el portal de desarrolladores `/developers` (guías, referencia generada del OpenAPI, webhooks, SDKs e IA y agentes, en ES/PT-BR/EN).

## Qué hace

| Área | Funcionalidades |
|---|---|
| Firma | Sobres con varios PDF, firmantes en secuencia/paralelo/mixto, copias y aprobadores, editor de campos (firma, iniciales, fecha, nombre, correo, texto, número, desplegable, empresa, cargo, casilla, adjunto), campos condicionales y calculados, plantillas con roles, envío masivo por CSV, formularios web públicos (el correo autorregistrado recibe la invitación de respaldo solo si se valida con código), firma en persona, corrección en vuelo, delegación y reasignación, recordatorios automáticos |
| Firmante | Sin cuenta, por email, WhatsApp o Telegram, en ES/PT-BR/EN; OTP por email/SMS/WhatsApp; verificación de identidad (documento + selfie, mock/Truora/Veriff); firma dibujada o tipeada; descarga del PDF sellado apenas termina el sellado y, mientras faltan firmas, de una copia en curso con lo firmado; resumen y preguntas con IA; pago dentro de la firma; PWA accesible |
| Evidencia | Registro de eventos encadenado por hash, certificado de finalización, sello PAdES B-T/B-LT/B-LTA con clave en KMS, verificación pública (`/verify`) y validador de firmas, sello de empresa, nivel de firma, firma con el certificado del titular (token, Windows o .p12) con el Firmador CalaSign |
| Facturación electrónica | Firma XML por API: DGII e-CF (RD), DIAN (CO, XAdES-EPES), SUNAT CPE (PE), XAdES-BES/EPES genéricos, con certificados de la organización en custodia cifrada |
| API e integraciones | API REST v1 + OpenAPI, API keys y OAuth 2.0 (client credentials, authorization code + PKCE), firma embebida en iframe, webhooks HMAC con reintentos, anclas de texto, idempotencia, SDKs Node y Python, servidor MCP para agentes de IA (conectores de Claude, ChatGPT y Gemini con registro dinámico OAuth, skill, plugin de Claude Code, extensión MCPB, complemento de Word/Outlook), Slack/Teams, exportación a Google Drive/Dropbox/OneDrive/S3, dominio propio |
| Equipos y empresa | Miembros e invitaciones, roles y permisos personalizados, grupos, auditoría de cuenta, retención, 2FA, SSO OIDC/SAML, SCIM, branding, reportes |
| Acuerdos e IA | Repositorio con búsqueda, generación de documentos desde plantillas, workflows sin código, negociación con versiones, detección de campos, metadatos y alertas de renovación, revisión contra playbook |
| CRM y ERP | Enviar a firmar desde HubSpot, Salesforce, Zoho CRM / Bigin, Pipedrive, RD Station CRM y Kommo con write-back y PDF adjunto; Siigo y Alegra |
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
Configuración: `apps/api/src/config.ts` y las variables de cada documento de `docs/`. Las principales:

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT`, `HOST` | `4000`, `0.0.0.0` | Dónde escucha la API |
| `APP_URL` | `http://localhost:5173` | URL pública (links de firma, correos); la cuenta solo existe en su host |
| `APP_ENV` | `prod` con `NODE_ENV=production`, si no `local` | Nombre del entorno (`local`, `dev`, `prod`); las herramientas de prueba solo existen en `local` |
| `PLATFORM_HOSTS` | — | Otros hosts de la plataforma donde existe la cuenta, separados por coma |
| `TRUST_PROXY_HOPS` | `1` | Proxies delante de la API cuyo `X-Forwarded-For` se cree |
| `DATABASE_URL` | — | Postgres; sin ella, PGlite en `DATA_DIR` |
| `DATA_DIR` | `var/` | Datos locales (PGlite, archivos, clave generada) |
| `SECRET_KEY` | generada en `var/` fuera de producción | 32 bytes en base64 (cifra tokens de firmante); obligatoria en producción |
| `COOKIE_SECURE` | `true` en producción | Cookie de sesión solo por https |
| `LOG_LEVEL` | `info` | Nivel de log |
| `STORAGE_DRIVER` | `s3` si hay `S3_BUCKET`, si no `local` | Almacenamiento de archivos |
| `S3_BUCKET`, `S3_PREFIX`, `AWS_REGION` | —, —, `us-east-1` | Bucket, prefijo de las claves y región |
| `WORKER_INLINE` | `true` fuera de producción | Corre el worker de jobs dentro del proceso de la API |
| `WORKER_CONCURRENCY` | `4` | Jobs en paralelo por worker |
| `DB_POOL_MAX` | `10` | Conexiones del pool de Postgres |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | Espera máxima para obtener/abrir una conexión de Postgres |
| `DB_STATEMENT_TIMEOUT_MS` | `60000` | `statement_timeout` de la sesión (0 = sin límite; las migraciones lo desactivan con `SET LOCAL`) |
| `DB_IDLE_IN_TX_TIMEOUT_MS` | `300000` | `idle_in_transaction_session_timeout` de la sesión (0 = sin límite; algunas transacciones esperan llamadas externas como S3 o la TSA) |
| `JOBS_RETENTION_DAYS` | `30` | Días que se guardan los jobs terminados; los que todavía deduplican (sobre sin terminar) se retienen (ver `purgeFinishedJobs`) |
| `WEBHOOK_MAX_CONSECUTIVE_FAILURES` | `50` | Entregas de webhook fallidas definitivas seguidas que desactivan el endpoint (motivo `failing`, con aviso a quienes tienen `webhooks:manage`) |
| `WEBHOOK_FAILING_DAYS` | `7` | Días fallando sin ninguna entrega exitosa que también desactivan el endpoint |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `90` | Días que se guardan las entregas de webhooks (con el payload del sobre) |
| `MIGRATE_ON_START` | — | `1` aplica las migraciones al arrancar en producción (fuera de producción siempre) |
| `DEV_MAILBOX` | `true` fuera de producción | Buzón de desarrollo (`/app/dev-mailbox`, API `/dev/mailbox`) |
| `MAX_UPLOAD_MB` | `25` | Tamaño máximo de subida |
| `WEB_DIST` | `apps/web/dist` | Web compilada que sirve la API |

### Pruebas

```bash
for t in e2e e2e-integrations e2e-signer e2e-productivity e2e-teams e2e-experience e2e-scale \
         e2e-platform e2e-identity e2e-evidence e2e-mcp e2e-billing e2e-ai e2e-agreements e2e-data e2e-oneshot \
         e2e-white-label e2e-api e2e-password; do
  node scripts/$t.mjs http://localhost:4000
done
node scripts/e2e-crm.mjs                 # levanta su propia API y simuladores de los proveedores
node scripts/e2e-connectors.mjs          # ídem: BambooHR, Ironclad, Juro, Box y SharePoint (docs/CONECTORES.md)
node scripts/e2e-lowcode.mjs             # ídem (puerto 4117): endpoints low-code, app de Zapier y trigger de n8n
node scripts/e2e-certsign.mjs            # ídem, con su PKI de laboratorio y el Firmador (docs/FIRMA-CON-CERTIFICADO.md)
(cd apps/api && ./node_modules/.bin/vitest run)
(cd packages/pdf && ./node_modules/.bin/vitest run)
(cd packages/xades && ../../apps/api/node_modules/.bin/vitest run)
```

`e2e-integrations`, `e2e-teams`, `e2e-identity`, `e2e-ai`, `e2e-agreements`, `e2e-data`, `e2e-white-label`, `e2e-api` y `e2e-password` usan funciones que solo existen en el entorno
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

Operación del host (lo aplica cada `deploy-dev.sh`, desde `infra/dev/host/`):
- **Backup previo y rollback:** antes de cambiar de versión el deploy hace un backup de Postgres (si falla, aborta sin
  tocar la versión activa). Si la versión nueva no responde `/healthz`, vuelve al código anterior y termina con error.
  El rollback **no deshace migraciones**: casi todas son aditivas, pero algunas no (`0016` cambia una clave primaria,
  `0017` borra tablas). Si el código anterior no anda con la base migrada, restaurar el backup previo (abajo).
- **Backups:** `pg_dump` diario a `s3://<bucket>/backups/postgres/` (`calasign-backup.timer`) y uno en cada deploy, con
  35 días de retención por regla de ciclo de vida (con el bucket versionado, la versión anterior vive 35 días más: unos 70 en total). Cada backup exitoso publica la métrica `CalaSign/Backup`
  `LastSuccess`; la alarma `calasign-saas-dev-backup-missing` avisa por correo (topic SNS `calasign-saas-dev-alerts`,
  variable `alert_email`) si pasan 24 horas sin un backup exitoso, y avisa de nuevo al recuperarse. La suscripción por
  correo hay que confirmarla desde el mensaje de AWS después del `terraform apply`. Para investigar:
  `systemctl status calasign-backup` / `journalctl -u calasign-backup` (cada deploy igual hace uno y aborta si falla).
- **Restaurar un backup** (en el EC2, como root por SSM; deja la base exactamente como en el dump):

  ```bash
  systemctl stop calasign
  aws s3 ls s3://<bucket>/backups/postgres/                       # elegir el dump
  umask 077   # el dump tiene todos los datos: que no quede legible para otros usuarios del host
  aws s3 cp s3://<bucket>/backups/postgres/calasign-<TS>.dump /var/tmp/restore.dump
  chown calasign /var/tmp/restore.dump
  # Se recrea la base: --clean no borraría tablas que una migración posterior al dump haya creado.
  runuser -u postgres -- dropdb calasign
  runuser -u postgres -- createdb -O calasign calasign
  # El dump se restaura como calasign (el dueño de la base), nunca como postgres: el rol de la instancia —el mismo
  # que usa la app— puede escribir en backups/, así que un dump podría estar armado por la app comprometida, y
  # restaurado por un superusuario ejecutaría su SQL con todos los privilegios (COPY ... FROM PROGRAM corre comandos
  # como el usuario postgres del sistema; un SET ROLE no alcanza, el dump podría hacer RESET ROLE). La base no usa
  # extensiones: las entradas EXTENSION del dump (plpgsql) se sacan de la lista porque solo postgres puede tocarlas.
  runuser -u calasign -- pg_restore -l /var/tmp/restore.dump | grep -vE ' EXTENSION - | COMMENT - EXTENSION ' > /var/tmp/restore.list
  runuser -u calasign -- pg_restore --single-transaction --no-owner --no-privileges -L /var/tmp/restore.list \
    -d calasign /var/tmp/restore.dump
  rm -f /var/tmp/restore.dump /var/tmp/restore.list
  ln -sfn /opt/calasign/releases/<versión del código de ese momento> /opt/calasign/current   # si hace falta
  systemctl start calasign && curl -sf localhost:4000/healthz
  ```

  Los archivos (PDF, imágenes) viven en S3 con versionado y no se tocan al restaurar la base.
- **Logs de Caddy:** las rutas y queries con secretos (links de firma, invitaciones, descargas, callbacks OAuth) se
  escriben como `[redacted]`.
- **Estado de Terraform:** es local (`infra/dev/terraform.tfstate`) y contiene `SECRET_KEY` en claro: no se versiona,
  `deploy-dev.sh` lo deja en `chmod 600`, y no hay que compartirlo. Para un entorno compartido, migrarlo a un backend S3
  cifrado.
- **IP del cliente detrás de proxies:** `TRUST_PROXY_HOPS` (por defecto `1`, Caddy) es la cantidad de proxies delante de
  la API cuyo `X-Forwarded-For` se cree. Detrás de CloudFront + ALB va `2`; si no coincide, la IP de los límites por IP,
  la auditoría y la evidencia es la del proxy (de menos) o la que elige el cliente (de más).

## Estructura

```
apps/api         Fastify: API v1, worker de jobs, notificaciones, evidencia, módulos por área (TypeScript)
apps/web         React + Vite: remitente (/app), firmante (/s/:token), páginas públicas
packages/pdf     Estampado, certificado de finalización, PAdES + RFC 3161 + LTV, validador, CSC, texto y docgen
packages/firmador Firmador CalaSign: agente de escritorio para firmar con token PKCS#11, almacén de Windows o .p12
packages/xades   Firma XML: XMLDSig, XAdES-BES/EPES, perfiles DGII, DIAN y SUNAT
packages/shared  Contrato de la API (Zod + tipos) y lógica compartida (condiciones, fórmulas, plantillas)
packages/sdk-node SDK de Node (@calasign/sdk)
sdks/python      SDK de Python
integrations/    Skill, plugin de Claude Code, MCPB, extensión de Gemini CLI y complemento de Office (se compilan a /integrations/)
infra/dev        Terraform del entorno dev
scripts/         Pruebas e2e, deploy, PKI de desarrollo, sello, Telegram
```
