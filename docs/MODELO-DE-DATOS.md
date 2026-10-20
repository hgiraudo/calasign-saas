# CalaSign SaaS — Modelo de datos

La fuente de verdad es [`apps/api/migrations/`](../apps/api/migrations). Este documento explica el porqué.

## Diagrama

```
tenants 1─N memberships N─1 users
   │  1─N api_keys                 users 1─N sessions
   │
   └─1─N envelopes ─1─N documents ──1─1 files (original)
            │   │                     │
            │   ├─1─N recipients ─────┼──1─N adopted_signatures ─1─1 files (signature_image)
            │   │        │            │
            │   └─1─N fields ─────────┘  (cada campo: 1 documento + 1 destinatario)
            │
            ├─1─N envelope_events   (append-only, cadena de hashes)
            ├─1─N notifications
            └─0─1 files (signed: PDF final sellado)

jobs · idempotency_keys   (infraestructura, sin FK al negocio)
```

## Entidades

| Tabla | Qué es | Decisiones |
|---|---|---|
| `tenants` | La organización cliente. | `cell` indica la celda regional (residencia de datos). `branding` en JSON para no migrar por cada opción visual. |
| `users`, `memberships` | Personas que envían y administran. Un usuario puede pertenecer a varias organizaciones. | Email único sin distinguir mayúsculas. Roles simples (`owner/admin/member`); RBAC fino en Fase 4. |
| `sessions` | Sesiones web. | Se guarda el **hash** del token, nunca el token. |
| `api_keys` | Credenciales de integración. | Hash + prefijo visible para identificarla; scopes; revocación lógica. |
| `files` | Todo binario (en S3/disco). | SHA-256 obligatorio: es evidencia. `kind` separa originales, finales e imágenes de firma (distintas políticas de retención). |
| `envelopes` | El sobre / transacción. | Máquina de estados con `CHECK`. Concurrencia: `updated_at` es estrictamente creciente (cada cambio lo sube al menos 1 ms) y el cliente que manda `X-Expected-Updated-At` con el valor que leyó recibe `409 version_changed` si el borrador cambió mientras tanto (`version` se sigue incrementando, pero el control se hace con `updated_at`). `metadata` para el `external_id` del integrador (dynamic-form). `signature_level` preparado para Fase 5. |
| `documents` | PDF dentro del sobre, ordenados. | Se guardan las dimensiones de cada página para validar y ubicar campos sin abrir el PDF. |
| `recipients` | Firmantes y copias. | `routing_order` modela secuencial, paralelo y mixto con un solo número. `channels` (email, WhatsApp). Documento de identidad declarado (cédula, CPF…). Token del link en hash (búsqueda) y cifrado (reenvío). Evidencia del momento de firma (IP, user agent). |
| `fields` | Campos ubicados en una página. | Coordenadas **normalizadas 0–1** desde arriba a la izquierda (como las ve el navegador); se convierten a puntos PDF solo al estampar. |
| `adopted_signatures` | La firma (dibujada o tipeada) que adoptó cada firmante. | Se guarda como imagen PNG; una de firma y una de iniciales por firmante. |
| `envelope_events` | Registro de auditoría del sobre. | `seq` + `prev_hash` + `hash`. Sin FK a propósito: el registro sobrevive aunque se purguen datos del sobre por retención. Particionado mensual en producción. |
| `jobs` | Cola de trabajos en Postgres. | `SKIP LOCKED`, reintentos con backoff, `dedupe_key` para que un mismo trabajo no se encole dos veces. Reemplazable por SQS. |
| `notifications` | Cada mensaje enviado. | Estado y id del proveedor: sirve para soporte ("¿le llegó el correo?") y como evidencia de entrega. |
| `idempotency_keys` | Respuestas guardadas por `Idempotency-Key`. | Reintentos seguros desde integraciones. |

## Eventos de evidencia (tipos)

`envelope.created`, `envelope.updated`, `document.added`, `document.removed`, `envelope.sent`,
`notification.sent`, `recipient.viewed`, `recipient.consented`, `recipient.signed`, `recipient.declined`,
`envelope.reminded`, `envelope.voided`, `envelope.expired`, `envelope.finalizing`, `envelope.completed`.

Cada evento: actor (`user`, `api_key`, `recipient`, `system`), IP, user agent, datos propios y la marca de tiempo del servidor.

**Cálculo del hash**: `hash = SHA-256(prev_hash + "\n" + JSON canónico de {seq, type, actor_type, actor_id, ip, user_agent, data, occurred_at})`, con claves ordenadas. El primer evento usa `prev_hash = "0" × 64`. El último hash queda impreso en el certificado de finalización: con eso se puede probar que el registro no se alteró después.

## Retención

- Originales, adjuntos, imágenes de firma y fotos de identidad: se borran al vencer la retención configurada por la
  organización (`tenants.retention_days`, días desde que el sobre terminó: completado, anulado, rechazado o vencido). La política se vuelve a leer al purgar cada sobre:
  si se extiende o se quita durante una pasada, el resto del lote no se borra. Un original compartido con una
  plantilla, otro sobre sin purgar, un acuerdo o una negociación se conserva; cuando ya solo lo usan sobres purgados
  (por ejemplo, el PDF de una plantilla borrada), un barrido de huérfanos lo borra. Un original purgado responde
  `410 purged` (descarga del original, plantilla desde el sobre, operaciones de IA); clonar un sobre purgado responde
  `409 purged`. El firmante de un sobre anulado o vencido que ya se purgó ve "sobre cerrado", no "original borrado".
- PDF final sellado y `envelope_events`: se conservan siempre (la retención no los toca). Hoy no hay Object Lock en el
  almacenamiento ni un bloqueo a nivel base de datos: la inmutabilidad la da la cadena de hashes (cualquier cambio se
  detecta al verificar). Un bucket con Object Lock para los PDF finales queda como trabajo pendiente.
- Datos personales de destinatarios: todavía no hay una función de anonimización a pedido (LGPD / Ley 1581 / Ley
  172-13 / Ley 29733). Hasta que exista, un pedido de supresión se atiende con la retención (originales, adjuntos,
  imágenes y fotos) y lo que la evidencia legal exige conservar se mantiene.

## Migraciones

El diagrama de arriba es el núcleo (0001). Cada bloque funcional agrega su propia migración:

| Migración | Qué agrega |
|---|---|
| `0001_init` | Organizaciones, usuarios, sesiones, API keys, archivos, sobres, documentos, destinatarios, campos, firmas adoptadas, eventos encadenados, jobs, notificaciones, idempotencia |
| `0002_integrations` | Webhooks y entregas, firma embebida (códigos de un solo uso, orígenes permitidos), destinatarios `embedded` |
| `0003_productivity` | Plantillas (documentos, roles, campos), campos número/desplegable/empresa/cargo/adjunto con valores de solo lectura, branding |
| `0004_signer` | OTP del firmante, aprobador, delegación y reasignación, recordatorios automáticos |
| `0005_teams` | Roles personalizados, invitaciones, grupos, compartir sobres y plantillas, auditoría de cuenta, retención, 2FA TOTP |
| `0006_scale` | Envíos masivos, formularios web, condiciones y fórmulas de campos |
| `0007_experience` | Firma en persona, confirmación de identidad del anfitrión, índices de reportes |
| `0008_platform` | Servidor OAuth 2.0, integraciones de notificaciones, exportación a almacenamiento, dominios propios |
| `0009_evidence` | Nivel de sello por organización, certificados en custodia, sello de empresa |
| `0010_identity` | Verificación de identidad (KYC), SSO OIDC/SAML, SCIM |
| `0011_ai` | Opt-in y presupuesto de IA, metadatos y revisión, uso de tokens |
| `0012_agreements` | Repositorio de acuerdos, plantillas de documentos, cláusulas, workflows, negociaciones |
| `0013_agents_billing` | Links de descarga para agentes, pagos en la firma, webhooks de pago, planes y suscripciones |
| `0014_video` | Salas de video (función descartada; las tablas se eliminan en `0017`) |
| `0015_crm` | Conexiones CRM/ERP, mapeos, vínculos y registro de ejecuciones |
| `0016_data` | BYOK, directorio de celdas, versiones de PDF firmado (renovación de archivo), dominios SSO verificados |
| `0017_drop_video` | Elimina las tablas de video: la firma por videollamada se descartó del producto |
| `0018_certificate_signing` | Firma con certificado propio: `signature_type` y `certificate_requirements` en destinatarios y roles, estado `awaiting_certificates`, `envelope_certsign`, `certificate_signatures`, `certsign_sessions` |
| `0019_password_reset` | `password_resets`: tokens de recuperación de contraseña de un solo uso (se guarda el SHA-256), válidos 30 minutos |
| `0020_r3_identity` | Una sola verificación de identidad en curso por destinatario (índice único parcial); `recipients.self_registered`: quien se registró en un formulario web público no recibe invitaciones ni recordatorios hasta validar su correo con el código del formulario (la copia final después de firmar sí); `template_roles` admite el rol aprobador |
| `0021_r6_custom_domains` | La unicidad de `custom_domains.domain` vale solo para dominios verificados: un dominio pendiente ya no bloquea a su dueño |
| `0022_r9_identity` | `web_forms.created_by_api_key`: un formulario creado con una API key tiene dueño (la key lo edita y ve sus sobres; si se revoca, el formulario deja de crear sobres) |
| `0023_r9_evidence` | `workflow_runs.started_by_api_key`: una ejecución iniciada por API queda a nombre de su key; las del link público ya no las ve cualquier key |
| `0024_r10_core` | `templates.created_by_api_key`: una plantilla creada con una API key es de esa key (la completa y ve las restringidas que creó) |
| `0025_r10_integrations` | `crm_mappings.created_by_api_key`: un mapeo de CRM creado con una API key tiene dueño; si la key se revoca, el webhook deja de enviar |
| `0026_r10_evidence` | `workflows.created_by_api_key`: un workflow creado con una API key queda a su nombre; los envíos del link público se revisan contra esa key |
| `0027_r11_identity` | `memberships.password_allowed`: las membresías creadas por alta JIT de SSO o por SCIM no aceptan sesiones con contraseña hasta que el dueño del correo la restablezca (evita el pre-secuestro de cuentas) |
| `0028_r12_integrations` | Quita de `oauth_clients.redirect_uris` las URIs con esquemas peligrosos (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`, `filesystem:`) guardadas antes de que el alta las rechazara |
| `0029_r12_identity` | `users.password_reset_at`: canjear un token de recuperación válido desbloquea la cuenta aunque no tenga organizaciones |
| `0030_r13_integrations` | `auth_method` y `sso_tenant_id` en códigos de autorización y tokens OAuth: los tokens heredan cómo se autenticó la sesión y respetan el SSO obligatorio y la membresía vigente |
| `0031_r14_evidence` | `agreement_views.created_by_api_key`: una vista de acuerdos creada con una API key es de esa key (la ve, la usa y la borra; otra key no la toma como propia) |
| `0032_r14_checkout_closed` | `envelope_payments.checkout_closed_at`: un sobre anulado, rechazado o vencido cierra su checkout abierto en Stripe o Mercado Pago (barrido periódico) |
| `0033_r15_integrations` | `envelope_payments.refund_required_at` y `refund_error`: un pago que se acredita con el sobre ya cerrado (anulado, rechazado o vencido) queda marcado y el barrido lo reembolsa en el proveedor |
| `0034_r16_identity` | `login_challenges.invitation_id`: aceptar una invitación con contraseña y 2FA crea la membresía recién después de verificar el segundo factor |
| `0035_r17_integrations` | `custom_domains.recheck_failures`: puntos de la re-verificación periódica (TXT ausente o el dominio ya no apunta a la plataforma: 2; error de DNS: 1); con 4 el dominio vuelve a pendiente |
| `0036_mcp_connectors` | Registro dinámico de clientes OAuth (RFC 7591) para conectores MCP: `oauth_clients.tenant_id` admite null solo con `registration = 'dynamic'` (CHECK: sin organización, sin identidad de servicio y sin `client_credentials`); `client_uri`, `logo_uri`, `token_endpoint_auth_method` |
| `0038_api_events` | Índices para la API de eventos (`/v1/events`, stream), búsqueda de sobres por fecha y metadatos, rotación del secreto de webhooks con período de gracia |
| `0042_connectors_hr_clm` | Conectores de RR. HH. y gestión de contratos (BambooHR, HiBob, Factorial, Ironclad, Juro): conexiones, flujos, vínculos sobre ↔ registro y ejecuciones (ver `CONECTORES.md`) |
| `0043_storage_dms` | Almacenamiento también en SharePoint y Box; `storage_exports.pdf_ref`: el PDF ya subido no se duplica en un reintento |
| `0044_white_label_brands` | Sub-marcas (`brands`) y `envelopes.brand_id` (ver `MARCA-BLANCA.md`) |
| `0045_white_label_domains` | Dominios de correo propios (SPF/DKIM) y dominios web de las sub-marcas |
| `0046_crm_zoho` / `0047_crm_pipedrive` / `0051_crm_rdstation_kommo` | Proveedores de CRM nuevos (el CHECK se redefine completo en cada una) |
| `0048_events_watermark` / `0049_events_position` | Cursor de la API de eventos por orden de confirmación: `envelope_events.pos` de un secuenciador único (0048 usaba el id de transacción, que no sobrevive a un dump/restore) |
| `0050_notify_channels` | Avisos también a Discord, Google Chat, Mattermost, Rocket.Chat y Webex |
| `0052_idempotency_keys_created_at` | Índice para la purga de claves de idempotencia de más de 7 días |
| `0052_storage_export_claim` | `storage_exports.claimed_until`: un solo trabajo a la vez por exportación (sin doble subida) |
| `0053_web_form_token_uses` | Cada token de formulario web sirve para un solo envío |
| `0054_login_attempts` | Intentos de contraseña por cuenta contados antes de verificar (bloqueo que resiste pedidos en paralelo) |
| `0055_archive_renewal_claim` | `envelopes.archive_renewing_until`: una renovación del sello de archivo a la vez por sobre |
| `0056_stale_checkout` | `envelope_payments.stale_checkout_id`: el checkout descartado al cambiar el pagador se cierra en el proveedor |
| `0057_export_pdf_sha` | Hash del PDF subido en exportaciones (`storage_exports.pdf_sha256`) y conectores (`connector_links.signed_sha256`): el JSON de evidencia describe ese PDF aunque después se renueve el sello |
| `0058_ai_extract_retry` | `envelopes.ai_metadata_retry_at`: una extracción automática con IA que falló se reintenta después de esa fecha (1 h si fue algo transitorio, 6 h si el proveedor rechazó el pedido), durante 30 días desde el primer intento |
| `0059_webhook_origin` | `webhook_endpoints.created_by_api_key` y `oauth_client_id`: si se revoca la credencial que creó el webhook, se desactiva |
| `0060_ai_extract_idx` | Índice parcial para el barrido de extracción automática con IA |
| `0061_ai_extract_idx2` | Reemplaza los índices de 0011 y 0060 por uno por organización y más selectivo para ese barrido |
| `0062_ai_first_attempt` | `envelopes.ai_metadata_first_attempt_at`: primer intento de la extracción automática, para contar los 30 días de reintentos desde ahí (no desde que se completó el sobre) |

Reglas: una migración por bloque, solo aditiva salvo cuando se recrea un `CHECK` para sumar un valor; nunca se edita una
migración ya aplicada en un entorno.
