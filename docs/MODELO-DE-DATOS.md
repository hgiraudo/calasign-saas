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
| `envelopes` | El sobre / transacción. | Máquina de estados con `CHECK`. `version` para concurrencia optimista. `metadata` para el `external_id` del integrador (dynamic-form). `signature_level` preparado para Fase 5. |
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

- Originales e imágenes de firma: se pueden borrar al vencer la retención del plan.
- PDF final sellado y `envelope_events`: se conservan durante todo el plazo legal (Object Lock).
- Datos personales de destinatarios: anonimizables a pedido (LGPD / Ley 1581 / Ley 172-13) salvo lo que la evidencia legal exige conservar.

## Tablas previstas para fases siguientes

| Fase | Tablas |
|---|---|
| 2 | `templates`, `template_recipients`, `template_fields`, `otp_challenges`, `subscriptions`, `usage_records` |
| 3 | `webhook_endpoints`, `webhook_deliveries`, `oauth_clients` |
| 4 | `groups`, `group_members`, `bulk_sends`, `bulk_send_items`, `web_forms`, `account_audit_log` |
| 5 | `identity_verifications`, `certificate_signatures` (proveedor, certificado, nivel), `retention_policies` |
