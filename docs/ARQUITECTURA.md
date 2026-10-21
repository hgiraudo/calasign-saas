# CalaSign SaaS — Arquitectura

> Octubre 2026. Producto standalone. Se integrará después con *dynamic-form* (como cliente de la API) y con la
> Autoridad Certificante de Calasign (como proveedor de firma con certificado), sin depender de ninguno.
> Mercados: República Dominicana, Honduras, Colombia, Brasil y Perú.

## Estado actual (2026-10-17)

El roadmap de las fases 1 a 6 está implementado (ver la tabla de estado en [`ROADMAP.md`](../ROADMAP.md)). La arquitectura
de abajo se mantiene: un monolito modular en `apps/api` con un módulo por área, todos registrados en `src/app.ts` y
protegidos por una única política de permisos (`modules/access.ts`, RBAC + scopes OAuth + límites de plan):

| Área | Módulos (`apps/api/src/modules/`) | Documento |
|---|---|---|
| Núcleo | `envelopes`, `signing`, `mappers`, `jobs`, `templates`, `participants`, `reminders` | este |
| Integraciones | `webhooks`, `embed`, `anchors`, `openapi`, `oauth*`, `notify-integrations`, `storage-export`, `custom-domains`, `mcp/` | [`CUSTOM-DOMAINS.md`](CUSTOM-DOMAINS.md), [`PAGOS-Y-AGENTES.md`](PAGOS-Y-AGENTES.md) |
| Firmante | `otp`, `signer-features`, `experience`, `identity/` (KYC, SSO, SCIM) | — |
| Equipos | `teams`, `access`, `audit`, `retention` | — |
| Escala | `bulk`, `webforms`, `logic`, `scale` | — |
| Evidencia | `evidence`, `evidence-seal`, `custody`, `verify` + `packages/pdf`, `packages/xades` | [`EVIDENCIA.md`](EVIDENCIA.md) |
| Acuerdos e IA | `agreements/`, `ai/` | [`IA.md`](IA.md) |
| Cobro | `billing/` | [`PAGOS-Y-AGENTES.md`](PAGOS-Y-AGENTES.md) |

Cada área tiene su prueba de punta a punta en `scripts/e2e-*.mjs`; el contrato completo y vigente de la API se publica en
`GET /v1/openapi.json` y en la página `/developers`. La §12 de abajo es el contrato original del MVP y queda como referencia.

## 1. Requisitos que mandan sobre el diseño

| Requisito | Consecuencia en la arquitectura |
|---|---|
| **Evidencia legal** que tiene que resistir años y un peritaje | Registro de eventos *append-only* encadenado por hash, archivos inmutables (S3 Object Lock), sello PAdES con sello de tiempo, claves en KMS/HSM. |
| **Residencia de datos** (LGPD en Brasil; contratos bancarios en CO/RD/HN) | **Celdas regionales**: cada región es un despliegue completo e independiente. El dato del cliente nunca sale de su celda. |
| **Escala desigual**: la API es liviana, el procesamiento de PDF es pesado y en ráfagas (envío masivo) | API sin estado separada de los **workers**; colas entre ambos; cada parte escala por su propia métrica. |
| **Equipo chico al principio** | **Monolito modular** (un repo, un deployable de API, módulos con fronteras claras), no microservicios. Se separa un módulo solo cuando lo pide la carga o el aislamiento. |
| **API como producto** | La web usa exactamente la misma API pública `/v1` que los clientes. Nada privado. |
| **Firma con certificados de terceros por país** | Interfaz `SignatureProvider` con conectores intercambiables (sello de plataforma, CA de Calasign, ICP-Brasil, ONAC, INDOTEL…). |

## 2. Vista general

```
                          ┌────────────────────────── Plano de control global ──────────────────────────┐
                          │  Directorio de tenants (tenant → celda) · facturación · alta de cuentas     │
                          └─────────────────────────────────────────────────────────────────────────────┘
                                                         │
  Navegador / App cliente / dynamic-form                 │ (resolución de celda por subdominio o API key)
          │                                              ▼
   CloudFront + WAF ──► API Gateway/ALB de la celda ─────────────────────────────────────────────────────┐
                                                                                                        │
  ┌──────────────────────────────── Celda (ej. "br" sa-east-1, "us" us-east-1) ─────────────────────────┤
  │                                                                                                     │
  │   ┌────────────────┐   SQL    ┌──────────────────────┐                                              │
  │   │  API (Fastify) │────────► │ PostgreSQL (Aurora)  │◄──────────┐                                  │
  │   │  sin estado    │          │ + outbox + jobs      │           │                                  │
  │   └──────┬─────────┘          └──────────┬───────────┘           │                                  │
  │          │ archivos                      │ eventos/jobs          │                                  │
  │          ▼                               ▼                       │                                  │
  │   ┌────────────────┐          ┌──────────────────────┐   ┌───────┴────────┐    ┌────────────────┐   │
  │   │ S3 (SSE-KMS,   │◄────────►│ Workers              │──►│ Signing service│──► │ KMS / CloudHSM │   │
  │   │ Object Lock)   │          │ pdf · seal · notify  │   │ (aislado)      │    └────────────────┘   │
  │   └────────────────┘          │ webhooks · sweeper   │   └───────┬────────┘                         │
  │                               └──────────┬───────────┘           │ RFC 3161                         │
  │                                          │                       ▼                                  │
  │                         SES · WhatsApp Cloud API · SMS        TSA                                   │
  └─────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Componentes

### 3.1 API (`apps/api`, proceso `server`)
- Node 22 + TypeScript + **Fastify** (alto rendimiento, validación por esquema) + **Zod** (los mismos esquemas en `packages/shared` que usa la web).
- Sin estado: sesiones y rate limits en Postgres/Redis, nunca en memoria. Escala horizontal detrás del balanceador.
- Autenticación:
  - **Remitentes (web)**: sesión por cookie `HttpOnly; Secure; SameSite=Lax`, token opaco guardado como SHA-256.
  - **Integraciones (API)**: `Authorization: Bearer cs_live_…`, API keys guardadas como hash, con scopes. OAuth 2.0 *client credentials* en Fase 3.
  - **Firmantes**: token de 256 bits en el link, guardado como hash (búsqueda) y cifrado con AES-256-GCM (para poder reenviarlo). Sin cuenta.
- Módulos con fronteras explícitas (cada uno tiene sus tablas y solo se habla con otros por servicios o eventos): `identity`, `envelopes`, `documents`, `signing`, `evidence`, `notifications`, `webhooks` (Fase 3), `billing` (Fase 2).

### 3.2 Workers (`apps/api`, proceso `worker`)
Mismo código que la API, otro *entrypoint*. Consumen trabajos de la cola:

| Cola | Qué hace | Escala por |
|---|---|---|
| `notify` | Envía invitaciones, recordatorios y copias finales (email, WhatsApp, SMS). | Profundidad de cola |
| `finalize` | Estampa los campos en el PDF, arma el certificado de finalización, sella (PAdES) y guarda. | CPU / profundidad |
| `webhook` | Entrega eventos firmados con HMAC, reintentos con backoff exponencial (Fase 3). | Profundidad |
| `sweeper` | Vencimientos, recordatorios programados, limpieza. | Tarea programada |

**Cola**: en el MVP, tabla `jobs` en Postgres con `FOR UPDATE SKIP LOCKED` (transaccional con el dato, cero infraestructura extra, aguanta miles de trabajos por segundo). Detrás de una interfaz `JobQueue`: al crecer se cambia por **SQS** sin tocar los módulos.

Reintentos: hasta 8 intentos con backoff exponencial (tope 1 h); un job sin latido por 10 minutos vuelve a la cola. Un
error `byok_key_unavailable` (la clave KMS del cliente caída) no gasta intentos: el job se pospone 10 minutos, hasta 7
días desde que se encoló (`isLastAttempt` evita que los handlers corran su lógica de «último intento» mientras tanto).

**Outbox transaccional**: todo cambio de estado escribe en la misma transacción el evento de evidencia y los trabajos que dispara. No hay "se guardó pero no se notificó".

### 3.3 Signing service (`packages/pdf` + `SignatureProvider`)
- Es el **único** componente con permiso `kms:Sign`. En producción corre como servicio aparte en subred privada sin salida a internet (solo a KMS y a la TSA vía endpoint permitido). En el MVP corre dentro del worker detrás de la misma interfaz.
- Recibe un **hash**, no el documento: el worker arma el PDF y el `ByteRange`, y el servicio devuelve la firma CMS.
- `SignatureProvider` (interfaz única para todos los tipos de firma):

```ts
interface SignatureProvider {
  id: string;                                   // "platform-seal", "calasign-ca", "icp-brasil:<ac>", ...
  level: "simple" | "advanced" | "qualified";
  certificateChain(): Promise<Uint8Array[]>;    // DER, del firmante a la raíz
  signDigest(digest: Uint8Array, alg: "SHA-256"): Promise<Uint8Array>;
}
```

  Conectores previstos: `platform-seal` (MVP: sello de la plataforma en KMS), `calasign-ca` (certificado del firmante emitido por la CA de Calasign), `csc-remote` (cualquier prestador que hable **CSC API v2**: ICP-Brasil en la nube, ECD de ONAC, INDOTEL…), `local-agent` (token del firmante vía agente de escritorio).
- Formatos: **PAdES Baseline** B-B → B-T (MVP, con TSA RFC 3161) → B-LT/B-LTA (Fase 5, agrega OCSP/CRL y sello de archivo). **XAdES** para facturación electrónica (Fase 5).
- Fase 5: si hace falta validación avanzada (políticas ICP-Brasil, LTV completo), se agrega un servicio de validación con **EU DSS** (Java). La interfaz no cambia.

### 3.4 Web (`apps/web`)
- React + Vite + TypeScript, SPA servida por CloudFront.
- Dos experiencias: **remitente** (`/app`) y **firmante** (`/s/:token`, liviana, mobile-first, ES / PT-BR).
- Renderiza los PDF con **pdf.js** en el navegador; las coordenadas de los campos se guardan **normalizadas (0–1)** respecto de la página, independientes de la resolución.

## 4. Datos

- **PostgreSQL** (Aurora en producción) por celda. Ver [`MODELO-DE-DATOS.md`](MODELO-DE-DATOS.md).
- **Multi-tenant en tablas compartidas** con `tenant_id` en todas las tablas de negocio. Defensa en profundidad: **Row Level Security** con `SET LOCAL app.tenant_id` por transacción (producción). Clientes enterprise: celda dedicada con el mismo código.
- IDs **UUIDv7** (ordenados por tiempo: buena localidad de índice a gran escala, no exponen volumen como un serial).
- `envelope_events` crece rápido: se particiona por mes y se archiva a S3 (Parquet) después del período caliente, sin perder la cadena de hashes.
- **Archivos en S3**, nunca en la base. Clave `tenant/<tenant_id>/envelopes/<envelope_id>/<file_id>`. Cifrado SSE-KMS con clave por celda (BYOK por tenant en Fase 5). Diseño previsto: los PDF finales en un bucket con **Object Lock en modo compliance**. Estado actual: un solo bucket, versionado, sin Object Lock (en `infra/dev` está apagado); la integridad la garantiza la cadena de hashes de la evidencia y el sello PAdES. Ver `MODELO-DE-DATOS.md` (Retención).
- Escala de referencia por celda: 10 M de sobres/año ≈ 0,3 sobres/s de media y picos de 50–100/s en envíos masivos. Postgres con réplicas de lectura lo resuelve con margen; el cuello de botella real es la CPU de los workers de PDF, que escalan solos.

## 5. Flujo de un sobre

```
draft ──send──► sent ──(todos los firmantes firman)──► finalizing ──(sellado OK)──► completed
  │               │ ├─ un firmante rechaza ─────────► declined
  │               │ ├─ el remitente anula ──────────► voided
  │               │ └─ vence ───────────────────────► expired
  └─ delete (solo borrador)
```

1. **Borrador**: se suben PDF (se validan, se sanean, se calcula SHA-256, se guardan; ver «Saneamiento de los PDF subidos» abajo), se cargan destinatarios con `routingOrder` (mismo número = en paralelo; distinto = secuencial) y se ubican campos.
2. **Envío**: valida (≥1 documento, ≥1 firmante, cada firmante con ≥1 campo de firma), genera tokens, notifica al primer grupo. Evento `envelope.sent`.
3. **Firma**: el firmante abre el link (`recipient.viewed`), acepta el uso de medios electrónicos (`recipient.consented`), completa campos y adopta su firma (`recipient.signed`, con IP, user agent, hash de los documentos que vio). Si su grupo terminó, se notifica al siguiente.
4. **Finalización** (worker `finalize`): estampa valores y firmas en los PDF, une los documentos, agrega el **certificado de finalización** (datos del sobre, hash de cada original, cada firmante con evidencia, línea de tiempo completa, cabeza de la cadena de hashes) y **sella con PAdES B-T**. Guarda el resultado y su hash. Evento `envelope.completed`.
5. **Copias**: se envía el documento final a todos los participantes y al remitente.

### Saneamiento de los PDF subidos

Todo PDF que se sube como documento (sobres, plantillas, `POST /v1/envelopes` con documentos, conectores, adjuntos
PDF de los firmantes) pasa por `preparePdfUpload` (`packages/pdf/src/inspect.ts` + `sanitize.ts`), que lo reescribe
para que lo guardado sea exactamente lo que ve el firmante y lo que se sella:

- **Formularios aplanados**: los campos se fijan en la página tal como se ven (sin widgets ocultos, apariencia según
  `/AS`, regenerada si el PDF pide `NeedAppearances`) y se elimina el `/AcroForm` (con XFA). Si un formulario no se
  puede fijar tal como se ve, se rechaza con `400 pdf_form_unsupported`.
- **Contenido activo y adjuntos eliminados**: JavaScript de documento, acciones que no sean URI/GoTo/Named (lanzar
  programas, enviar formularios…), acciones automáticas (`/AA`), archivos adjuntos embebidos (también los asociados
  `/AF` de PDF/A-3 o Factur-X) y multimedia.
- **Capas ocultas rechazadas**: si alguna capa (contenido opcional) está apagada al abrir, como lo evalúa pdf.js
  (`/D` BaseState/ON/OFF, `/Usage /View` apagado, OCMD que oculta), `400 pdf_hidden_layers`; con todas encendidas se
  quita `/OCProperties`. No cuentan `/Print` apagado ni `/RBGroups`, ni capas que no están en `/OCGs`.
- **Firmas previas perdidas**: al reescribirlo, las firmas digitales que traía el archivo dejan de existir (ni la
  copia guardada ni el PDF final las conservan). La respuesta de la subida lo avisa con `hadSignatures: true`, la
  consola se lo muestra al remitente y el evento `document.added` lo registra.
- Otros rechazos: con contraseña (`encrypted`), cifrado solo con restricciones de permisos (`pdf_restricted`),
  ambiguo (`ambiguous_pdf`), sin páginas, ilegible o con demasiadas páginas.
- El hash del archivo subido (`uploadedSha256`) y el del guardado (`sha256`) quedan en el evento `document.added`.

Los originales guardados antes de este saneamiento se sanean también al sellar. Si uno tiene capas ocultas, el PDF
final lleva `/OCProperties` con el mismo estado (capas de todos los documentos, las apagadas en `/D /OFF`), así se ve
lo mismo que vio el firmante. Si otro saneamiento falla con `InvalidPdfError`, el job `finalize` no lo reintenta,
registra `envelope.finalize_failed` con el `code` y avisa al remitente y a los administradores (el sobre queda en
`finalizing`).

## 6. Evidencia (lo que hace que la firma valga)

- **Cadena de eventos**: cada evento guarda `prev_hash` y `hash = SHA-256(prev_hash ‖ JSON canónico del evento)`. El orden se serializa con un `SELECT … FOR UPDATE` sobre el sobre. Alterar o borrar un evento rompe todos los siguientes.
- **Hash de cada documento** original y final, impresos en el certificado de finalización.
- **Sello PAdES** de la plataforma: cualquier modificación posterior del PDF invalida la firma en Adobe Reader o en cualquier validador.
- **Sello de tiempo** RFC 3161 de una TSA externa: prueba que el documento existía así en esa fecha, independientemente de nuestro reloj.
- Datos del firmante: IP, user agent, método de autenticación, canal de entrega, documento de identidad declarado, consentimiento.

## 7. Seguridad

- Subida de archivos: límite de tamaño, verificación de que es PDF, rechazo de PDF cifrados, escaneo de malware (GuardDuty Malware Protection for S3 en producción). El PDF final se reescribe completo, así que JavaScript embebido no sobrevive al sellado. Fase 2: quitar JavaScript y acciones del original al subirlo.
- Tokens de firmante: 256 bits, hasheados, vencen con el sobre, rate limit por IP en `/v1/signing`.
- Contraseñas con **scrypt**; 2FA (TOTP / passkeys) en Fase 2; SSO SAML/OIDC en Fase 5.
- CORS cerrado, CSP estricta en la web, `helmet`, verificación de `Origin` en peticiones con cookie.
- Secretos en AWS Secrets Manager; ninguna clave de firma fuera de KMS/HSM en producción.
- Auditoría de cuenta (quién hizo qué en la consola) en Fase 4.

## 8. Infraestructura (producción)

| Pieza | Elección | Por qué |
|---|---|---|
| Cómputo | **ECS Fargate** (API, workers, signing service como servicios separados) | Sin gestionar nodos; escala por servicio. EKS solo si un día hay muchos servicios. |
| Base | **Aurora PostgreSQL** Multi-AZ + réplica de lectura | Failover automático, crecimiento de almacenamiento sin intervención. |
| Archivos | **S3** con SSE-KMS, versionado, Object Lock para finales, replicación entre AZ (y entre regiones de la misma jurisdicción si aplica) | Durabilidad e inmutabilidad. |
| Claves | **KMS** (MVP de producción) → **CloudHSM** cuando un regulador o un certificado cualificado lo exija | Costo: KMS cuesta centavos; CloudHSM ~USD 1.500/mes por HSM. |
| Correo | **SES** con dominio propio, DKIM, configuración por tenant (Fase 4) | Costo y entregabilidad. |
| WhatsApp | **WhatsApp Business Cloud API** (Meta) con plantillas aprobadas por idioma: `WHATSAPP_TEMPLATE` (invitación, default `calasign_signature_request`) y `WHATSAPP_OTP_TEMPLATE` (código de verificación, un solo parámetro `{{1}}`, default `calasign_verification_code`; **hay que aprobarla en Meta** para que funcione el OTP por WhatsApp; `WHATSAPP_OTP_TEMPLATE_KIND` = `authentication` (default: plantilla de categoría Autenticación de Meta, se envía además el botón de copiar código con el código como parámetro) o `utility` (solo el cuerpo con `{{1}}`)). `WHATSAPP_TEMPLATE_LANGS` (default `es,en,pt_BR`; `pt-BR` se acepta como `pt_BR`): idiomas aprobados en Meta para las plantillas; un destinatario en un idioma no listado recibe la versión en español, o la del primer idioma de la lista si el español no está. Avisos de cierre (opcionales): `WHATSAPP_COMPLETED_TEMPLATE` (completado), `WHATSAPP_VOIDED_TEMPLATE` (anulado) y `WHATSAPP_DECLINED_TEMPLATE` (rechazado), con parámetros `{{1}}` remitente, `{{2}}` asunto y `{{3}}` link (o `-` si no hay); sin la variable, ese aviso no sale por WhatsApp | Canal principal en los cuatro países. |
| Borde | CloudFront + WAF + Shield Standard | TLS, cache de la SPA, protección. |
| Observabilidad | OpenTelemetry → CloudWatch (o Grafana Cloud); logs JSON con `request_id`, `tenant_id`, `envelope_id` | Trazabilidad de punta a punta. |
| IaC / CI | Terraform; GitHub Actions con OIDC (sin claves de larga vida) | Reproducible y auditable. |

**Celdas iniciales**: `br` en sa-east-1 (São Paulo, LGPD) y `us` en us-east-1 (Colombia, República Dominicana y Honduras: la mejor latencia al Caribe y a los Andes; evaluar mx-central-1). Una celda nueva = un `terraform apply` del mismo módulo con otra región.

## 9. Integraciones previstas (no son dependencias)

- **dynamic-form**: pasa a ser un cliente de la API. Crea sobres por API con el PDF ya llenado, usa **firma embebida** (URL de firma con vencimiento corto para un iframe, eventos por `postMessage`) y recibe **webhooks** al completarse. Reemplaza a OneSpan sin cambiar su experiencia.
- **Autoridad Certificante de Calasign**: conector `calasign-ca` del `SignatureProvider`. El firmante elige "firmar con certificado" y la firma se arma con un certificado emitido por la CA en vez del sello de la plataforma.

## 10. Cómo evoluciona sin reescribir

| Señal | Cambio |
|---|---|
| Más de ~1.000 jobs/s o necesidad de *fan-out* | `JobQueue` → SQS (+ EventBridge para eventos de negocio). |
| La API y los workers compiten por la base | Réplicas de lectura para listados y búsqueda; mover búsqueda a OpenSearch. |
| Un módulo necesita otro ritmo de despliegue o aislamiento (firma, webhooks) | Se extrae como servicio: ya tiene interfaz y tablas propias. |
| Cliente enterprise o regulador pide aislamiento | Celda dedicada. |
| Firma cualificada / LTV completo | Servicio de validación EU DSS; CloudHSM; conectores CSC por país. |

## 11. Desarrollo local

`pnpm dev` levanta todo sin Docker: Postgres embebido (**PGlite**) si no hay `DATABASE_URL`, almacenamiento en disco (`var/`), un certificado de sello de desarrollo autogenerado, y un **buzón de desarrollo** (la página `/app/dev-mailbox` de la web, que lee la API `GET /dev/mailbox`) donde caen los correos y mensajes de WhatsApp con sus links de firma. Con `DATABASE_URL`, `S3_BUCKET`, `KMS_KEY_ID` y `SMTP_URL` configurados, el mismo código usa la infraestructura real.

## 12. Contrato de la API v1 (MVP, referencia histórica: el vigente es `/v1/openapi.json`)

Todas las respuestas son JSON. Errores: `{ "error": { "code": "string", "message": "string", "details"?: any } }`. Autenticación: cookie de sesión o `Authorization: Bearer <api key>` (excepto `/v1/auth/*` y `/v1/signing/*`). `Idempotency-Key` opcional en `POST /v1/envelopes` y `POST /v1/envelopes/:id/send`.

### Identidad
| Método | Ruta | Cuerpo → Respuesta |
|---|---|---|
| POST | `/v1/auth/signup` | `{name, email, password, organization, locale?}` → `{user, tenant}` + cookie |
| POST | `/v1/auth/login` | `{email, password}` → `{user, tenant}` + cookie |
| POST | `/v1/auth/logout` | → `204` |
| GET | `/v1/me` | → `{user, tenant}` |
| GET | `/v1/api-keys` | → `{items: ApiKey[]}` |
| POST | `/v1/api-keys` | `{name}` → `{apiKey, secret}` (el secreto se muestra una sola vez) |
| DELETE | `/v1/api-keys/:id` | → `204` |

### Sobres (remitente)
| Método | Ruta | Cuerpo → Respuesta |
|---|---|---|
| GET | `/v1/envelopes?status=&q=&cursor=&limit=` | → `{items: EnvelopeSummary[], nextCursor}` |
| POST | `/v1/envelopes` | `{subject, message?, locale?, expiresAt?}` → `EnvelopeDetail` |
| GET | `/v1/envelopes/:id` | → `EnvelopeDetail` |
| PATCH | `/v1/envelopes/:id` | `{subject?, message?, locale?, expiresAt?}` (solo borrador) → `EnvelopeDetail` |
| DELETE | `/v1/envelopes/:id` | (solo borrador) → `204` |
| POST | `/v1/envelopes/:id/documents` | multipart `file` (PDF) → `Document` |
| DELETE | `/v1/envelopes/:id/documents/:documentId` | → `204` |
| GET | `/v1/envelopes/:id/documents/:documentId/file` | → PDF original |
| PUT | `/v1/envelopes/:id/recipients` | `{recipients: RecipientInput[]}` reemplaza la lista (ids opcionales, generados por el cliente para poder referenciarlos desde los campos) → `EnvelopeDetail` |
| PUT | `/v1/envelopes/:id/fields` | `{fields: FieldInput[]}` reemplaza la lista → `EnvelopeDetail` |
| POST | `/v1/envelopes/:id/send` | → `EnvelopeDetail` |
| POST | `/v1/envelopes/:id/void` | `{reason}` → `EnvelopeDetail` |
| POST | `/v1/envelopes/:id/remind` | → `{notified: number}` |
| GET | `/v1/envelopes/:id/events` | → `{items: EnvelopeEvent[]}` |
| GET | `/v1/envelopes/:id/signed.pdf` | → PDF sellado (solo `completed`) |

### Firma (firmante, autenticado por token)
| Método | Ruta | Cuerpo → Respuesta |
|---|---|---|
| GET | `/v1/signing/:token` | → `SigningSession` (registra `recipient.viewed` la primera vez) |
| GET | `/v1/signing/:token/documents/:documentId/file` | → PDF original |
| POST | `/v1/signing/:token/consent` | → `SigningSession` |
| POST | `/v1/signing/:token/complete` | `{fields: [{id, value}], signature: {kind: "drawn"\|"typed", imagePng: base64, text?}, initials?: {…}}` → `SigningSession` |
| POST | `/v1/signing/:token/decline` | `{reason}` → `SigningSession` |
| GET | `/v1/signing/:token/signed.pdf` | → PDF sellado (si el sobre está `completed`) |
| GET | `/v1/signing/:token/copy.pdf` | → copia en curso (ya firmó o es copia y el sobre no terminó): campos completados hasta ahora, marcada en cada página, sin certificado ni sello |

### Desarrollo
| GET | `/dev/mailbox` | → `{items: [{id, channel, to, subject, text, link, createdAt}]}` (solo fuera de producción) |
|---|---|---|

Los tipos exactos (`EnvelopeDetail`, `RecipientInput`, `FieldInput`, `SigningSession`, …) están en `packages/shared/src/api.ts` y son la fuente de verdad para la API y la web.

## Seguridad de la cuenta (reglas que no son obvias)

Resultado de las rondas de revisión de código de octubre de 2026; cada una tiene su prueba e2e o unitaria.

- **Sesiones solo en el dominio de la plataforma.** La cuenta (login, páginas de `/app`, APIs de sesión) existe solo en
  el host de `APP_URL` y en los de `PLATFORM_HOSTS` (en local, también `localhost`, `127.0.0.1` y `[::1]`), por lista
  blanca: en cualquier otro host las páginas de la cuenta redirigen a la plataforma, las APIs de sesión responden
  401 `use_platform_host` y se ignora la cookie de sesión. Los dominios propios y de sub-marca sirven al firmante, no
  la cuenta (ver [CUSTOM-DOMAINS.md](CUSTOM-DOMAINS.md)).
- **Tokens OAuth**: nunca cuentan como propietario (un propietario autoriza → admin limitado a scopes); refresh tokens
  solo con el grant correspondiente; ver [MCP-CONECTORES.md](MCP-CONECTORES.md).
- **Apps OAuth de servicio** (`client_credentials`): rotar el secreto, ampliar scopes o borrarlas exige tener todos los
  permisos de su rol.
- **SCIM**: crear un token SCIM exige permisos de admin (o ser propietario), sea cual sea el rol por defecto: un token
  SCIM puede sumar gente a grupos y dar de baja administradores.
- **SSO**: una sesión abierta por SSO queda atada a esa organización (`/v1/me/access` solo la muestra a ella), no puede
  activar 2FA de la cuenta (`sso_session_2fa`) y se cierra si se apaga el SSO o cambia el proveedor de identidad.
  Dura `sso_configs.session_ttl_hours` horas absolutas desde que se abre (1 a 336; por defecto 24, configurable en
  Ajustes → SSO); bajarlo acorta también las sesiones SSO abiertas. Las sesiones con contraseña siguen en 14 días.
  Los tokens OAuth autorizados desde una sesión SSO tampoco pasan de esa sesión: el código guarda cuándo vence
  (`oauth_authorization_codes.sso_session_expires_at`, 0080) y la familia tiene como tope el menor entre ese
  vencimiento y la creación del código + la duración de la conexión (`oauth_tokens.sso_deadline`; sin él, el primer
  token + la duración). El refresh vence con ella y, vencida, `/oauth/token` responde `invalid_grant` (también al canjear
  un código cuya sesión ya venció).
  OIDC exige `email_verified` = `true` (o `"true"`) salvo que la conexión tenga `trustUnverifiedEmail` (para IdP que
  no mandan el claim, como Microsoft Entra ID por defecto; la 0079 lo activó en las conexiones OIDC ya existentes y la
  consola avisa al configurar un issuer de Entra, `login.microsoftonline.com` o `sts.windows.net`). Al cambiar el issuer
  sin mandar `trustUnverifiedEmail` vuelve a `false`: la confianza era en el IdP anterior. SAML guarda el ID de cada Assertion
  (`saml_assertion_ids`, hasta su `NotOnOrAfter`) y rechaza las repetidas (`sso_assertion_replay`).
- **SCIM DELETE** conserva la fila de `scim_users` (`active = false`, `deleted_at`): GET y listados devuelven 404, y el
  alta JIT por SSO no vuelve a sumar a quien el IdP desactivó o borró (`sso_scim_deactivated`), mientras la
  organización tenga algún token SCIM activo. Un POST posterior lo reactiva. Al revocar el último token SCIM se borran
  las filas desactivadas o borradas (dejan de bloquear el JIT).
- **Cuentas pre-registradas con un correo ajeno** (riesgo residual aceptado): el registro no verifica el correo, así
  que alguien puede crear la cuenta `ana@empresa.com` antes que Ana, con su contraseña y su 2FA. Si después la
  organización de Ana la vincula por JIT (SSO) o SCIM, la cuenta se vincula TAL CUAL: no se borran su 2FA, sus
  sesiones ni sus tokens OAuth (ni en esa organización ni en otras), tampoco al suspender y reactivar por SCIM. Lo que
  acota el riesgo: la membresía creada por JIT/SCIM tiene `password_allowed = false` (la contraseña que eligió quien
  registró la cuenta no sirve para entrar a esa organización; solo el SSO, que el IdP sí prueba) y un SSO exitoso
  sigue funcionando. Lo que queda: quien pre-registró la cuenta conserva lo que ya tenía en la cuenta global (sus
  sesiones y tokens abiertos, la organización propia del registro) y la 2FA que puso, que Ana no necesita para entrar
  por SSO pero que le impide usar contraseña hasta que se borre manualmente. Hubo una limpieza automática al vincular (borraba 2FA y sesiones de
  cuentas "no probadas"), y se quitó: los criterios para decidir qué cuenta es "huérfana" fallaban en los dos sentidos
  (borraba la 2FA de empleados legítimos, p. ej. al suspender y reactivar por SCIM, y un atacante la esquivaba
  sumando la cuenta a otra organización o restableciendo la contraseña). Restablecer la contraseña NO borra la 2FA
  (controlar el correo no alcanza para saltearla) ni revoca por defecto las credenciales que creó la persona: la
  respuesta (200) lista las activas por organización y, con `revokeCreatedCredentials: true`, revoca sus API keys e
  invitaciones pendientes (nunca tokens SCIM ni apps de servicio, que son de la organización). Se audita en cada
  organización de la que es miembro y, en las que ya no lo es, solo si ahí se le revocó algo. Activar o desactivar la 2FA cierra las otras sesiones y revoca los tokens OAuth de la cuenta.
  La redirección después del login acepta solo rutas propias (empiezan con `/`, sin `//`, hasta 4000 caracteres; si
  no, `/app`: nunca una URL cortada, para que la vuelta a `/oauth/authorize` de un conector MCP llegue entera).
- **Invitaciones**: revocar o reemplazar una invitación pendiente exige poder otorgar su rol. Quien acepta una
  invitación a una organización con SSO obligatorio (y no es propietario) recibe 403 `sso_required` con
  `details.joined: true` y `startUrl`: tiene que ingresar por SSO (una sesión con contraseña no le serviría).
- **Links de firma**: ver, aceptar, firmar, rechazar, delegar, adjuntar, OTP, identidad y pago exigen bajo el lock que el
  link siga vigente (una corrección de contacto en vuelo no deja actuar al titular anterior), y la evidencia no registra
  eventos de sobres anulados, rechazados o vencidos.
- **Destinos salientes** (webhooks, pasos HTTP de workflows, documentos por URL): solo https y nunca direcciones internas
  ni rangos reservados (`isPrivateAddress`).

