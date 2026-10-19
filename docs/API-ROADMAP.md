# API de CalaSign — matriz de brechas y roadmap

> Octubre 2026. Comparación de la API pública REST de CalaSign (`/v1`, OpenAPI en `/v1/openapi.json`) con DocuSign
> eSignature v2.1 (+ Connect, Agreement Manager/ex-Navigator, MCP), Adobe Acrobat Sign v6, Dropbox Sign v3, BoldSign v1,
> Zoho Sign, OneSpan Sign y PandaDoc. Fuentes: referencias de API y changelogs 2025–2026 (lista al final). Lo marcado
> "s/v" no se pudo verificar en la fuente.

Abreviaturas: DS = DocuSign · AS = Adobe Sign · DBX = Dropbox Sign · BS = BoldSign · ZS = Zoho Sign · OSS = OneSpan Sign ·
PD = PandaDoc. ✓ = lo tiene · ◐ = parcial · ✗ = no.

## 1. Inventario de la API actual (resumen)

| Área | Endpoints principales |
|---|---|
| Sobres | `GET/POST /v1/envelopes` (cursor), detalle, `PATCH`, borrar borrador, documentos (subir/quitar/descargar), `PUT recipients`, `PUT fields` (coordenadas o anclas), `send`, `void`, `remind`, `retry-finalize`, `events` (cadena de hashes), `signed.pdf`, `corrections`, `reassign`, `resend-copy`, `signing-url`, `shares`, `payment`, `seal-options`, `archive`. **POST /v1/envelopes acepta el sobre completo en una llamada** (documentos, destinatarios, campos y envío inline). |
| Plantillas | CRUD, documentos, roles, campos, `from-envelope`, `shares`, `bulk-csv`, `from-template` (roles también como objeto), `GET /v1/templates/{id}/input-schema` (low-code). |
| Envío masivo y formularios | `bulk-sends` (validate, items, results.csv, cancel), `web-forms` (públicos, con antibots y límite de usos). |
| Firmante | Sesión por token, consentimiento, completar, rechazar, copia en curso, adjuntos, OTP (email/SMS/WhatsApp), KYC, firma en persona, firma con certificado (Firmador), IA (resumen y preguntas). |
| Webhooks | CRUD, filtro por evento, HMAC-SHA256 `CalaSign-Signature`, reintentos con backoff (8), log de entregas, reenvío manual, prueba, `GET /v1/webhooks/samples`, `Location` en el alta. |
| Plataforma | API keys con roles, OAuth 2.0 (code + PKCE, client credentials, refresh, DCR RFC 7591, RFC 8707/9728/8414), MCP (Streamable HTTP), Slack/Teams, almacenamiento externo, CRM/ERP, conectores. |
| Administración | Miembros, invitaciones, roles personalizados, grupos, SSO SAML/OIDC, SCIM, 2FA obligatoria, auditoría (`audit-log` + CSV), retención, BYOK, regiones de datos, dominio propio, branding; **marca blanca en curso** (brands, `brandId` en sobres, plantillas y dominios de correo). |
| Evidencia | PAdES B-LTA, TSA, sello de empresa, validación pública (`/v1/validate`, `/v1/verify`), firma XML (DGII/DIAN/SUNAT). |
| Acuerdos e IA | Repositorio con metadatos y vistas, documentos generados (DOCX/HTML→PDF con variables y cláusulas), workflows, negociación/redlining, IA (detección de campos, extracción de metadatos, revisión contra playbook). |
| Calidad | `Idempotency-Key` (por credencial), paginación por cursor, errores `{error:{code,message,details}}` con catálogo, `X-RateLimit-*` y `Retry-After`, claves `cs_test_`/`cs_live_`, OpenAPI 3.1 con webhooks, SDK Node y Python. |

## 2. Matriz de brechas

| # | Capacidad | DS | AS | DBX | BS | ZS | OSS | PD | CalaSign (antes) | CalaSign (ahora) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Búsqueda de sobres por rango de fechas / `updated since` | ✓ from_date/to_date | ✓ (servicio de búsqueda, 500/pág.) | ◐ query | ✓ start/endDate | ◐ | ✓ | ✓ created_from/modified_from | ✗ (solo estado y texto) | ✓ **nuevo** `created_*`, `updated_*`, `sent_*`, `completed_*` |
| 2 | Filtro por metadata / custom fields, destinatario, plantilla | ✓ custom_field | ◐ | ◐ | ✓ labels | ◐ | ◐ | ✓ `metadata_*`, template_id | ✗ | ✓ **nuevo** `metadata`, `recipient`, `template_id`, `created_via` |
| 3 | Paginación por cursor | ✗ offset | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| 4 | API de eventos de la cuenta (polling/reconciliación) | ◐ listStatusChanges + Connect failures | ◐ por acuerdo | ✗ | ◐ | ✗ | ◐ | ✓ webhook-events | ✗ (solo por sobre) | ✓ **nuevo** `GET /v1/events` con cursor |
| 5 | Streaming de eventos (SSE) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ **nuevo** `GET /v1/events/stream` (diferencial) |
| 6 | Exportar valores de campos (form data) | ✓ form_data | ✓ formData | ✓ response_data | ✓ | ◐ s/v | ✓ fieldSummary | ✓ | ◐ (dentro del detalle) | ✓ **nuevo** `GET /v1/envelopes/{id}/form-data` |
| 7 | Descargar adjuntos del firmante | ✓ | ✓ | ◐ | ✓ | ◐ | ✓ | ✓ | ◐ (solo anexados al PDF final) | ✓ **nuevo** `GET …/attachments/{fieldId}` |
| 8 | Clonar sobre | ◐ | ✗ | ✗ | ✓ (GA jul-26) | ✗ | ✗ | ✓ copy | ✗ (solo a plantilla) | ✓ **nuevo** `POST …/clone` |
| 9 | Operaciones en lote (void/remind/delete/status) | ✓ bulk batch actions | ◐ MegaSign | ✗ | ◐ | ✗ | ◐ | ✗ | ✗ | ✓ **nuevo** `POST /v1/envelopes/batch` |
| 10 | Rotación del secreto de webhooks con gracia (multi-HMAC) | ✓ varias claves | ✗ (sin HMAC) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ **nuevo** `POST /v1/webhooks/{id}/rotate-secret` |
| 11 | Webhooks: filtro, HMAC, reintentos, log, replay, prueba | ✓ | ◐ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ |
| 12 | Webhooks: scope por recurso/grupo, mTLS, OAuth al receptor | ✓ | ✓ (scopes, mTLS) | ◐ por app | ✗ | ◐ headers custom | ✓ OAuth | ✗ | ✗ | ✗ (P2) |
| 13 | Idempotency-Key | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ (diferencial) |
| 14 | Rate limit documentado con headers | ✓ | ✓ | ✓ | ✓ | ◐ créditos | ◐ | ✓ | ✓ (por IP) | ✓ — falta por credencial (P2) |
| 15 | Sandbox / test mode | ✓ demo | ✓ | ✓ test_mode | ✓ | ◐ | ✓ | ✓ | ◐ (entorno dev + `cs_test_`) | ◐ — falta `test_mode` por pedido (P1) |
| 16 | Void / correct / resend / reassign / delegate | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ |
| 17 | Extender vencimiento de un sobre en curso | ✓ | ◐ | ✓ (oct-26) | ✓ extendExpiry | s/v | ✓ | ✓ | ✓ (vía `corrections.expiresAt`) | ✓ |
| 18 | Purge de documentos de un sobre (a pedido) | ✓ purge_state | ✗ s/v | ✗ | ◐ delete | ✓ delete | ✓ trash | ✓ | ◐ (retención por política) | ◐ (P2) |
| 19 | Plantillas con roles, campos condicionales y fórmulas | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 20 | Cobros en el flujo | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ Stripe/Mercado Pago | ✓ |
| 21 | Envío y OTP por SMS/WhatsApp | ✓ | ◐ SMS | ◐ SMS | ✓ SMS | ✓ SMS | ✓ SMS | ✗ | ✓ (WhatsApp nativo) | ✓ |
| 22 | Verificación de identidad (IDV/KYC) | ✓ | ✓ | ✗ | ✓ | ◐ | ✓ | ✗ | ✓ | ✓ |
| 23 | Firma en persona | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |
| 24 | PowerForms / web forms | ✓ | ✓ | ✗ | ✓ | ✓ | ◐ | ◐ | ✓ | ✓ |
| 25 | Firma embebida (recipient view) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 26 | Envío/edición embebidos (sender view, template editor) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ alpha | ✗ | ✗ (P1) |
| 27 | Sobre completo en una llamada | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ (envelope-oneshot) | ✓ |
| 28 | Usuarios, grupos, SCIM, roles | ✓ | ✓ | ◐ | ✓ | ◐ | ✓ | ◐ | ✓ | ✓ |
| 29 | Marcas (brands) y plantillas de correo por API | ✓ | ◐ | ◐ | ✓ | ✗ | ✓ | ✗ | ✓ (marca blanca en curso) | ✓ |
| 30 | Contactos / libreta de destinatarios | ◐ | ✗ | ✗ | ✓ (GA mar-26) | ✗ | ✗ | ✓ | ✗ | ✗ (P2) |
| 31 | Reportes / exportación | ✓ | ✓ | ◐ | ◐ | ◐ | ◐ | ✓ logs | ✓ summary + CSV + auditoría | ✓ |
| 32 | Combined PDF / ZIP / certificado y audit trail por separado | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ◐ | ◐ (PDF sellado con certificado; eventos JSON) | ◐ — falta ZIP y certificado aparte (P1) |
| 33 | Document generation (DOCX/HTML → PDF con datos) | ✓ | ◐ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ |
| 34 | IA: detección/extracción de campos y metadatos | ✓ Iris | ✗ s/v | ✓ detect_fields (oct-26) | ✓ | ✗ | ✗ | ◐ | ✓ | ✓ |
| 35 | Servidor MCP para agentes | ✓ (beta→GA) | ✗ s/v | s/v | s/v | ✓ vía Zoho MCP | ✗ | ✓ | ✓ | ✓ |
| 36 | Logs de pedidos a la API (por credencial) | ◐ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ /public/v2/logs | ✗ (solo auditoría admin) | ✗ (P2) |

## 3. Priorización

Impacto: cuánto destraba integraciones y ventas (1–5). Esfuerzo: S (≤ 1 día), M (2–4 días), L (≥ 1 semana).

| Prioridad | Brecha | Impacto | Esfuerzo | Estado |
|---|---|---|---|---|
| P0 | API de eventos con cursor (`GET /v1/events`) — reconciliación sin depender de los webhooks | 5 | S | **Hecho** |
| P0 | Búsqueda avanzada (fechas, `updated_from`, metadata, destinatario, plantilla) | 5 | S | **Hecho** |
| P0 | Datos de formulario (`form-data`) y descarga de adjuntos del firmante | 4 | S | **Hecho** |
| P0 | Rotación del secreto de webhooks con período de gracia | 4 | S | **Hecho** |
| P1 | Clonado de sobres | 4 | S | **Hecho** |
| P1 | Operaciones en lote (get/void/remind/delete) | 3 | S | **Hecho** |
| P1 | Eventos en vivo por SSE (`/v1/events/stream`) | 3 | S | **Hecho** |
| P1 | Envío y edición embebidos (sender view / template editor en iframe con URL de un solo uso) | 5 | L | Pendiente |
| P1 | `test_mode` por pedido (sobres de prueba sin consumir cupo, marca de agua, sin validez) en producción | 4 | M | Pendiente |
| P1 | Descargas: ZIP de originales + sellado, certificado de finalización y audit trail PDF por separado | 3 | M | Pendiente |
| P2 | Webhooks con scope (por sobre/plantilla/grupo), mTLS y OAuth hacia el receptor | 3 | M | Pendiente |
| P2 | Rate limit por credencial (no solo por IP) y cupos por plan | 3 | S | Pendiente |
| P2 | Purge a pedido de los documentos de un sobre (dejando la evidencia) | 3 | S | Pendiente |
| P2 | Contactos / libreta de destinatarios por API | 2 | M | Pendiente |
| P2 | Logs de pedidos a la API por credencial (debug para integradores) | 2 | M | Pendiente |
| P3 | Más SDKs (Java, .NET, PHP, Go) generados desde OpenAPI + colección Postman | 3 | M | Pendiente |

## 4. Lo implementado (esta ronda)

| Endpoint | Qué hace |
|---|---|
| `GET /v1/envelopes?…` | Nuevos filtros: `created_from/to`, `updated_from/to` (alias `updated_since`), `sent_from/to`, `completed_from/to`, `metadata=clave:valor` o `metadata[clave]=valor` (repetible, contención jsonb con índice GIN), `recipient` (correo o teléfono), `template_id`, `created_via`. El resumen trae `updatedAt` y `metadata`. |
| `GET /v1/events` | Eventos de la organización del más viejo al más nuevo, con cursor (`after`), `since`, `types`, `envelope_id`, `scope=webhook|all`. Respeta la visibilidad (una API key sin `envelopes:view_all` solo ve sus sobres). Margen de 2 s para que ningún evento quede detrás del cursor. |
| `GET /v1/events/stream` | Server-Sent Events con los mismos filtros; retoma por `Last-Event-ID`; se cierra a los `max_seconds`; máx. 5 por organización. |
| `GET /v1/envelopes/{id}/form-data` | Valores por destinatario y vista plana `etiqueta → valor`; firmas solo `filled`; adjuntos con hash y ruta. |
| `GET /v1/envelopes/{id}/attachments/{fieldId}` | Archivo original que subió el firmante. |
| `POST /v1/envelopes/{id}/clone` | Borrador nuevo con documentos, destinatarios (configuración), campos y lógica; `includeRecipients`, `includeFields`, `includeValues`, `metadata.clonedFrom`. |
| `POST /v1/envelopes/batch` | `get|void|remind|delete` sobre ≤ 100 ids; cada uno corre como su pedido individual (política, auditoría y validaciones), resultado por elemento. |
| `POST /v1/webhooks/{id}/rotate-secret` | Secreto nuevo; durante `graceHours` (24 por defecto, máx. 168) `CalaSign-Signature: t=…,v1=<nuevo>,v1=<anterior>`. Auditado (`webhook.secret_rotated`). Los SDK aceptan cualquier `v1` que coincida. |

Código: `apps/api/src/modules/devapi/` (rutas, búsqueda, OpenAPI), `packages/shared/src/devapi.ts` (contrato),
migración `0038_api_events.sql`, SDK Node (`cs.events`, `envelopes.formData/clone/batch/downloadAttachment`,
`webhooks.rotateSecret`) y Python (mismos nombres en snake_case), e2e `scripts/e2e-api.mjs`, guía
`/developers/guides/api-plus`.

## 5. Fuentes

- DocuSign Momentum '26 (Agreement Manager API, MCP): https://www.docusign.com/blog/developers/momentum-26-agentic-agreement-workflows
- Adobe Acrobat Sign release notes (throttling, búsqueda, webhooks): https://developer.adobe.com/acrobat-sign/docs/overview/releasenotes/acrobatsignreleasenotes
- BoldSign changelog (clone, edit, teams, contactos, extend expiry): https://developers.boldsign.com/api-overview/changelog · https://developers.boldsign.com/documents/extend-document-expiry
- Dropbox Sign changelog (detect_fields, update con vencimiento): https://developers.hellosign.com/changelog
- PandaDoc (MCP, logs de API): https://pandadoc.com/blog/whats-new-in-pandadoc-december-2025
- Zoho Sign release notes y Zoho MCP: https://www.zoho.com/sign/release-notes-whats-new.html
