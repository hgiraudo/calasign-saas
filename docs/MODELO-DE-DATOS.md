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
| `envelopes` | El sobre / transacción. | Máquina de estados con `CHECK`. Concurrencia: `updated_at` es estrictamente creciente en las ediciones del borrador (cada cambio lo sube al menos 1 ms) y el cliente que manda `X-Expected-Updated-At` con el valor que leyó recibe `409 version_changed` si el borrador cambió mientras tanto (`version` se sigue incrementando, pero el control se hace con `updated_at`). `metadata` para el `external_id` del integrador (dynamic-form). `signature_level` preparado para Fase 5. |
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
| `0056_stale_checkout` | `envelope_payments.stale_checkout_id`: el checkout descartado al cambiar el pagador se cierra en el proveedor (reemplazada en 0063) |
| `0057_export_pdf_sha` | Hash del PDF subido en exportaciones (`storage_exports.pdf_sha256`) y conectores (`connector_links.signed_sha256`): el JSON de evidencia describe ese PDF aunque después se renueve el sello |
| `0058_ai_extract_retry` | `envelopes.ai_metadata_retry_at`: una extracción automática con IA que falló se reintenta después de esa fecha (1 h si fue algo transitorio, 6 h si el proveedor rechazó el pedido), durante 30 días desde el primer intento |
| `0059_webhook_origin` | `webhook_endpoints.created_by_api_key` y `oauth_client_id`: si se revoca la credencial que creó el webhook, se desactiva |
| `0060_ai_extract_idx` | Índice parcial para el barrido de extracción automática con IA |
| `0061_ai_extract_idx2` | Reemplaza los índices de 0011 y 0060 por uno por organización y más selectivo para ese barrido |
| `0062_ai_first_attempt` | `envelopes.ai_metadata_first_attempt_at`: primer intento de la extracción automática, para contar los 30 días de reintentos desde ahí (no desde que se completó el sobre) |
| `0063_payment_webhooks_checkouts` | `payment_webhook_events.processed_at` (el evento se marca procesado al terminar); `envelope_payments.stale_checkout_ids` (cola de checkouts descartados a cerrar, reemplaza `stale_checkout_id`), `discarded_checkout_refs` y `checkout_ref` (un pago por un checkout descartado se reembolsa), `disputed_at` (contracargo o disputa en el proveedor) e índice por `provider_payment_id` |
| `0064_subscription_cancellations_webhook_claims` | `subscription_cancellations` (suscripciones reemplazadas pendientes de cancelar en el proveedor; las reintenta el barrido) y `payment_webhook_events.claim_id` (quién tomó un evento en curso: solo esa toma suelta la marca). 0063 pasa a ser re-ejecutable |
| `0065_subscription_cancellations_done` | `subscription_cancellations.done_at`: la suscripción reemplazada ya no se borra al cancelarla en el proveedor; un alta atrasada o reprocesada de ella no la vuelve a aplicar. El barrido toma solo las pendientes, con backoff |
| `0066_download_links_issuer` | Links de descarga del MCP con la credencial que los pidió: al descargar se revalida que la API key o el token OAuth sigan vigentes (revocar al agente corta los links ya entregados) |
| `0067_oauth_clients_created_by_key` | `oauth_clients.created_by_api_key`: la key que creó una app OAuth puede seguir administrándola mientras esté vigente |
| `0068_webform_otp_limits` | Índices para contar los topes de formularios web por organización y de códigos de verificación por destino y por organización |
| `0069_downloads_bytes_webform_lock_bulk_round` | Descargas del MCP: las continuaciones con `Range` valen solo poco después de una descarga contada y suman `bytes_served` (no se puede bajar el archivo entero una y otra vez) |
| `0070_notification_feedback` | Rebotes y quejas de SES (`notifications.feedback_*`, `email_suppressions`), reintento por canal dentro del job, `telegram_link_tokens` y tope de recordatorios automáticos (`recipients.auto_reminders_sent`) |
| `0071_suppression_scope_webform_submitter` | Supresión de correos con alcance: una queja suprime solo para la organización; un rebote permanente, para toda la plataforma y con vencimiento (`EMAIL_BOUNCE_SUPPRESSION_DAYS`). Ver `CORREO-REBOTES.md` |
| `0072_evidence_append_only` | **Evidencia append-only en la base**: triggers que rechazan `UPDATE`/`DELETE`/`TRUNCATE` en `envelope_events` y `account_audit_log` (ver `EVIDENCIA-ROLES-BD.md`) |
| `0073_workflow_public_hardening` | Workflows de inicio público: huella (HMAC de workflow + correo + IP/64) de quien completó el formulario, para no aceptar el mismo envío repetido |
| `0074_signed_chain_head_draft_guard` | `files.chain_head`: hash final de la cadena impreso en el certificado de un PDF sellado (la verificación pública no parsea el PDF); un sobre no vuelve a borrador desde otro estado |
| `0075_ai_usage_recipient` | El cupo de consultas de IA del firmante se cuenta en `ai_usage`, con el destinatario, y se consume al reservar (antes de llamar al modelo) |
| `0076_chain_head_guard_public_runs` | `files.chain_head` una vez fijado no cambia (solo `NULL` → valor, salvo mantenimiento explícito) |
| `0077_identity_sso_scim_hardening` | SSO y SCIM: `scim_users.deleted_at`, `sso_configs.oidc_trust_unverified_email` y `session_ttl_hours` (1-336 h), `saml_assertion_ids` contra la reutilización de aserciones SAML |
| `0078_byok_key_history` | Historial de claves BYOK por organización: una falla de KMS se atribuye a la organización solo si la clave con que se cifró el archivo es o fue suya |
| `0079_identity_sso_compat` | Compatibilidad de 0077 con lo que ya estaba en uso: los OIDC existentes conservan la confianza en correos no verificados y las sesiones SSO abiertas, su vencimiento |
| `0080_oauth_sso_session_deadline` | Tokens OAuth autorizados desde una sesión SSO: el tope de la familia es el mínimo entre el vencimiento de esa sesión y la duración de la conexión |
| `0081_integrations_history_webhook_secret` | Desconectar un CRM o conector ya no borra el historial de ejecuciones (`connection_id` → `NULL`); `connector_flows.webhook_secret_enc` |
| `0082_white_label_texts_frame_ancestors` | Limpia configuraciones guardadas antes de dos validaciones nuevas: textos propios protegidos de la verificación pública y orígenes inválidos de `frame-ancestors` |
| `0083_signer_session_tokens` | `signer_session_tokens`: el canje de la URL embebida redirige a un token de sesión, no al token permanente del destinatario; `envelope_payments.checkout_return_token_enc` |
| `0084_signer_session_tokens_purge_return` | Índices para la purga de tokens de sesión del firmante vencidos o revocados (barrido, de a 5000) |
| `0085_jobs_maintenance` | `jobs.priority` y los índices de toma por prioridad, pendientes, en curso y terminados |
| `0086_jobs_purge_checked_connector_runs_idx` | `jobs.purge_checked_at` y su índice para `purgeFinishedJobs`; índice de reentregas de webhooks de conectores |
| `0087_webhook_health` | Webhooks salientes: `consecutive_failures`, `failing_since`, `last_success_at`, desactivación automática con motivo, idempotencia del fan-out y retención de entregas |
| `0088_agreements_title_trgm_templates_cursor` | Búsqueda de acuerdos por título con índice trigram sobre el título plegado (la expresión es exactamente la de `titleFoldSql`) |
| `0089_subscription_cancel_at` | Baja programada de la suscripción (`cancel_at`): la consola muestra «Termina el …» |
| `0090_agreements_title_fold_v2` | `pg_trgm` de nuevo (instancias creadas sin `postgresql-contrib`) y el índice trigram con la expresión nueva de `titleFoldSql` |
| `0091_identity_result_masked` | `identity_verifications.result` enmascarado: documento con asteriscos y los últimos 4, del nacimiento solo el año (también los existentes) |
| `0092_certsign_id_match_default` | Firma con certificado: «el certificado tiene que corresponder al documento» pasa a `false` por defecto; se apaga en los roles de plantilla |
| `0094_certsign_id_match_explicit` | Los sobres no terminados armados con la regla vieja conservan explícito (`true`) el control de documento que tenían (no existe la `0093`) |
| `0095_member_removals` | `member_removals`: una baja desde la consola se sostiene frente al alta JIT por SSO y la activación por SCIM, hasta una invitación nueva |
| `0096_sweep_backoff` | Barridos que no se traban con un sobre o archivo que falla siempre: intentos y error registrados, backoff (retención, `pending_file_deletions`). Sus índices pasaron a 0098-0100 |
| `0097_member_removals_user_idx` | Índice de `member_removals` por usuario (baja de la cuenta, liberación de bloqueos JIT/SCIM) |
| `0098_envelopes_finalizing_idx` | `-- no-transaction`: índice de sobres en `finalizing` para el barrido de finalizaciones agotadas |
| `0099_jobs_finalize_envelope_idx` | `-- no-transaction`: índice de jobs de finalización por sobre |
| `0100_envelopes_awaiting_cert_reminders_idx` | `-- no-transaction`: índice para recordatorios y vencimientos de sobres esperando firmas con certificado |
| `0101_ai_metadata_failures` | Extracción automática de metadatos: contador de fallas no clasificadas seguidas; pasado el tope no se reintenta (cada intento se cobra) |
| `0102_pending_file_deletions_storage_key` | Borrado de archivos en dos fases: la fila de `files` se borra en una transacción corta y la clave queda anotada para borrar el archivo después |
| `0103_bulk_items_retryable` | Envío masivo: si una fila fallida se puede reintentar (falla del momento) o no (sus datos o la plantilla) |
| `0104_bulk_items_line` | Envío masivo: línea del CSV de origen de cada fila, aparte del número de fila de datos |
| `0105_account_audit_log_tenant_id_idx` | `-- no-transaction`: índice de la auditoría por organización e id descendente (paginación por cursor) |
| `0106_account_audit_log_actor_action_idx` | `-- no-transaction`: índice por actor y acción para el bloqueo por intentos fallidos y la deduplicación de descargas |
| `0107_agreements_retention` | Retención de datos de workflows y negociaciones terminados; la IP del inicio público pasa a `started_by_ip` (solo la ve la auditoría) |
| `0108_email_domains_ses_identity_error` | El rechazo de SES por identidad sin verificar en su propia columna (un error de DNS ya no lo pisa) |
| `0109_identity_cancel_on_close` | Trigger: al cerrarse un sobre se cancelan sus verificaciones de identidad en curso, venga de donde venga el cierre |
| `0110_identity_polled_at_and_close_backfill` | `identity_verifications.polled_at` (consulta del firmante) separado de `updated_at` (actividad del proveedor, desde donde corre el plazo) |
| `0111_identity_verifications_active_envelope_idx` | Índice parcial de verificaciones en curso por sobre (lo usa el trigger de 0109) |
| `0112_identity_session_binding` | La verificación de identidad queda atada al token de sesión del canje embebido desde el que se inició |
| `0113_embed_sessions_replay_code` | Código de un solo uso de la URL de firma de la creación rápida, cifrado: repetir el pedido con la misma `Idempotency-Key` devuelve el mismo código |
| `0114_identity_verifications_stale_idx` | Índice parcial de verificaciones pendientes por última actividad (barrido de vencidas) |
| `0115_jobs_cell` | `jobs.cell`: cada job solo lo toma un worker que atiende la celda de su organización (`SERVED_CELLS`) |
| `0116_archive_renewed_at_tenant_alerts_storage_reason` | `envelopes.archive_renewed_at` (el intervalo del sello de archivo se mide desde la última renovación exitosa), `tenant_alerts`, `storage_connections.deactivated_reason` |
| `0117_identity_verifications_integration_level` | Nivel que declaraba la integración del proveedor de identidad al iniciar la verificación (un cambio de configuración no afecta a las en curso) |
| `0118_jobs_cell_agreements_backfill` | Celda de los jobs de acuerdos que llevan solo el id del run, la negociación o el acuerdo (0115 los había dejado sin celda) |
| `0119_jobs_cell_claim_idx` | Índice de toma de jobs por celda (`cell, run_at, id`), parcial sobre los pendientes |
| `0120_jobs_cell_claim_priority_idx` | Como 0119, para las prioridades altas (`cell, priority, run_at, id`) |
| `0121_storage_connections_account_sub` | `sub` de la cuenta de Google de una conexión de Drive: al desconectar se revoca en Google solo si ninguna otra conexión usa la misma cuenta |
| `0122_staff_auth_sessions_lockout` | Sesiones del personal: id visible, `authenticated_at` (re-autenticación), `last_seen_at` (cierre por inactividad), «recordarme»; bloqueo de login por red (`login_attempts.scope`, `password_resets.ip_key`) |

Reglas: una migración por bloque, solo aditiva salvo cuando se recrea un `CHECK` para sumar un valor; nunca se edita una
migración ya aplicada en un entorno.
Las reglas completas, con el porqué, están en [`estandares/codigo-sql-y-migraciones.md` §4](estandares/codigo-sql-y-migraciones.md#4-migraciones);
`node scripts/check-calidad.mjs` (en `qa.sh` y en el hook de pre-commit) verifica el nombre, que el número no se repita
y que no se edite una migración ya versionada. La `0052` está repetida desde antes (dos ramas en paralelo tomaron el
mismo número; ya se aplicaron, así que no se renombran). No existen la `0037`, la `0039` a la `0041` ni la `0093`: números
que quedaron sin usar (no hace falta llenarlos).

Cada migración corre entera en su propia transacción (`migrate` en `apps/api/src/infra/db.ts`, con un candado para que
dos procesos que arrancan juntos no la apliquen dos veces), salvo las que llevan `-- no-transaction` como primera
línea. Consecuencias:

- Un `CREATE INDEX` común bloquea las escrituras de la tabla mientras se construye, y en la misma transacción que un
  `ALTER TABLE` deja tomado el `ACCESS EXCLUSIVE` de la tabla (ni lecturas) hasta el commit. Índices sobre tablas
  grandes (`jobs`, `envelopes`, `envelope_events`…): una migración aparte, marcada `-- no-transaction`, con
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS <nombre> …` (un índice por migración; ej. 0098-0100). En Postgres corre
  sentencia por sentencia en una conexión fija, con el candado de migraciones de sesión y sin `statement_timeout`; si
  un intento anterior dejó el índice `INVALID` (CONCURRENTLY falló o se cortó), se borra con `DROP INDEX CONCURRENTLY`
  y se rehace. En PGlite (desarrollo, tests) se quita `CONCURRENTLY` y corre en una transacción. Tiene que ser
  re-ejecutable (`IF NOT EXISTS`): si falla a mitad, lo hecho queda y se reintenta entera en el próximo arranque. No
  mezclar en ella cambios de esquema que necesiten ser atómicos. Las columnas y tablas nuevas siguen en migraciones
  comunes (sin índices sobre tablas grandes en la misma).
- Excepción a "nunca se edita una migración aplicada": 0096 se aplicó en desarrollo con sus índices en la misma
  transacción; se le quitaron y pasaron a 0098-0100 (`IF NOT EXISTS`: donde ya existen no hacen nada). El runner
  compara por nombre, sin checksum.
- Sobre tablas grandes (`jobs`, `envelope_events`, `envelopes`…), la migración se limita al cambio de esquema (columnas
  nulables, índices). Los backfills se hacen de a lotes desde el barrido periódico (`sweep` en
  `apps/api/src/modules/jobs.ts`), no en la migración: un `UPDATE` masivo dentro de ella retiene los bloqueos durante
  todo el arranque.
