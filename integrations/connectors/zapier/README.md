# CalaSign para Zapier

App de Zapier Platform CLI (`zapier-platform-core` 19.2.1, Node 22). Base URL: `{{BASE_URL}}` (o la variable de entorno
`CALASIGN_BASE_URL` de la app en Zapier).

| Tipo | Clave | Qué hace |
|---|---|---|
| Trigger (REST hook) | `envelope_completed`, `envelope_sent`, `envelope_declined`, `recipient_signed`, `envelope_event` | Suscribe `POST /v1/webhooks` con `bundle.targetUrl`, desuscribe con `DELETE /v1/webhooks/{id}`; datos de prueba con `GET /v1/webhooks/samples`. La suscripción queda atada a la credencial del Zap: si se revoca la key o la app, el webhook se desactiva solo. Con `envelope.completed` trae el PDF firmado como archivo (`signed_pdf`). |
| Acción | `send_from_template` | Plantilla (desplegable) → campos dinámicos por rol y prellenado (`GET /v1/templates/{id}/input-schema`) → `POST /v1/envelopes/from-template/{id}`. |
| Acción | `send_document` | PDF + firmantes: crea, sube, destinatarios, campos de firma (última página o anclas `\firma1\`…) y envía. |
| Acción | `void_envelope`, `remind_recipients` | Anular / recordar. |
| Búsqueda | `find_envelope` | Sobre por id (con el PDF firmado si está completo). |

Autenticación: API key (`Authorization: Bearer cs_live_…`), solo hacia la API de CalaSign.

**Revocar o reconectar la cuenta.** Al revocar la API key con la que se creó la suscripción (o reconectar la cuenta con
otra key) CalaSign desactiva el webhook del Zap (`active: false`) y el trigger deja de dispararse sin error visible. La
solución es apagar y volver a prender el Zap: Zapier lo desuscribe (el `DELETE` con la key vieja no falla) y lo vuelve a
suscribir con la credencial actual.

Errores: un 429 del límite de tasa genérico (con `Retry-After`) se reintenta (`ThrottledError`); los 429 de negocio
(`reminded_recently`, etc.) son errores normales. Un 409 `idempotency_in_progress` (otra ejecución con la misma
Idempotency-Key en curso) se reintenta a los pocos segundos.

## Publicar (lo hace el dueño de la cuenta de Zapier de CalaSign)

```bash
npm install
npx zapier-platform validate --without-style   # validación de esquema, sin red
npx zapier-platform login
npx zapier-platform register "CalaSign"        # crea la integración (privada)
npx zapier-platform push
npx zapier-platform validate                   # con los style checks de Zapier (requiere login)
```

Después: invitar usuarios de prueba (`zapier-platform users:add`), conseguir los Zaps activos que pide Zapier y pedir
la publicación pública desde el Developer Platform.
