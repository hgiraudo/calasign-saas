# Verificación de identidad del firmante (KYC)

Código: `apps/api/src/modules/identity/` (`kyc.ts` rutas y resultado, `providers.ts` adaptadores, `namematch.ts`
comparación de nombres). El remitente la pide por destinatario (`idVerification: {provider, level}`); el firmante la
hace después del código (OTP) y antes de ver los documentos.

## Niveles y control del resultado

| Nivel | Exige |
| --- | --- |
| `document` | documento aprobado por el proveedor |
| `document_selfie` | además, coincidencia selfie / documento |
| `document_selfie_liveness` | además, prueba de vida aprobada (`liveness === true`) |

CalaSign no confía solo en el "aprobado" del proveedor: el flujo o la integración configurados en Veriff o Truora pueden
no incluir la selfie o la prueba de vida. Para un nivel con selfie hace falta la coincidencia facial (puntaje
`faceMatchScore` ≥ `IDV_FACE_MATCH_THRESHOLD`, o una decisión explícita del proveedor, p. ej. la validación
`face-recognition` de Truora en `success`) y para el de liveness la prueba de vida (`liveness === true`).

**Capacidades declaradas de la integración.** La decisión de Veriff no suele traer `faceMatch.similarity` ni un
booleano de prueba de vida. Por eso una aprobación se completa con lo que la integración declara hacer:

- **Veriff**: `VERIFF_INTEGRATION_LEVEL` (una sola integración para todos los sobres). Con `document_selfie` una
  aprobación cuenta como coincidencia facial; con `document_selfie_liveness`, además como prueba de vida.
- **Truora**: un flujo propio del nivel (`TRUORA_FLOW_ID_<NIVEL>`) se arma con las validaciones del nivel, así que una
  aprobación con ese flujo cumple el nivel. El flujo genérico (`TRUORA_FLOW_ID`) no declara nada: el resultado tiene que
  traer los datos.

Un dato contrario explícito siempre gana: puntaje facial bajo el umbral o `faceMatched` en false (`face_mismatch`),
`liveness` en false (`liveness_failed`). Esas son fallas del firmante y consumen un intento. Lo inferido queda en la
evidencia (`inferredFromIntegration` en `recipient.identity_verified`).

**`level_not_met`**: el proveedor aprobó pero el resultado no trae el control que pide el nivel y la integración no lo
declara. Es un problema de configuración, no del firmante: **no consume un intento**, el evento
`recipient.identity_failed` lleva `configurationIssue: true` y el remitente ve el motivo en el detalle del destinatario.
Repetir la verificación daría lo mismo y abriría otra sesión paga, así que el inicio queda bloqueado (409
`identity_provider_unavailable`) hasta que el remitente revise la configuración y reinicie la verificación.

Después se controlan el nombre (`name_mismatch`) y el número de documento (`document_number_mismatch`).

**Disponibilidad por nivel.** Un proveedor puede estar configurado y no poder hacer un nivel: Truora sin flujo para el
nivel, o un nivel por encima de `VERIFF_INTEGRATION_LEVEL`. Pedir ese nivel al armar el sobre responde 400
`identity_provider_unavailable` con el motivo, y el inicio de la verificación responde 503 (antes, un 500 al crear la
sesión).

## Configuración

| Variable | Default | Uso |
| --- | --- | --- |
| `VERIFF_API_KEY`, `VERIFF_SHARED_SECRET`, `VERIFF_BASE_URL` | — | integración de Veriff (una sola). |
| `VERIFF_INTEGRATION_LEVEL` | `document_selfie` | controles que hace la integración de Veriff (`document`, `document_selfie`, `document_selfie_liveness`). Una aprobación cumple hasta ese nivel salvo un dato contrario explícito; los niveles superiores no se pueden pedir con Veriff. Tiene que coincidir con lo configurado en el panel de Veriff. |
| `TRUORA_API_KEY`, `TRUORA_WEBHOOK_SECRET` | — | Truora (Digital Identity). |
| `TRUORA_FLOW_ID` | — | flujo por defecto. |
| `TRUORA_FLOW_ID_DOCUMENT`, `TRUORA_FLOW_ID_DOCUMENT_SELFIE`, `TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS` | `TRUORA_FLOW_ID` | flujo por nivel (documento; + reconocimiento facial; + prueba de vida). Truora queda configurado con `TRUORA_FLOW_ID` o con al menos uno de estos; un nivel sin flujo no puede pedirse ni iniciarse. Un flujo propio del nivel declara sus controles (una aprobación cumple el nivel salvo un dato contrario). |
| `IDV_FACE_MATCH_THRESHOLD` | `0.8` | similitud mínima (0..1) selfie / documento. Vacía o ilegible = `0.8`. |
| `IDV_PENDING_TIMEOUT_HOURS` | `24` | horas sin actividad del proveedor que una verificación de Veriff o Truora puede esperar el resultado. |
| `IDV_MOCK_ENABLED` | — | `1` habilita el proveedor de prueba en producción (no recomendado). |

## Ciclo de vida

- **Veriff `resubmission_requested`**: queda en revisión (la verificación sigue en curso y la página de Veriff sirve
  para reenviar las fotos); la decisión posterior de la misma sesión la reemplaza.
- **Truora**: el webhook (JWT HS256) puede traer varios eventos; se procesan todos. El resultado se consulta por
  `process_id`; mientras no llegó ningún webhook no hay consulta posible (la API no documenta una búsqueda por
  `account_id`). La referencia que queda en la evidencia y el certificado es el `process_id`.
- **Sin resultado**: el barrido periódico (`identity-stale`) da por vencidas las verificaciones de un proveedor
  externo sin actividad del proveedor hace más de `IDV_PENDING_TIMEOUT_HOURS` (estado `expired`, motivo
  `provider_timeout`, evento `recipient.identity_expired`). El plazo corre desde `updated_at` (inicio, webhooks,
  resultados en revisión); la consulta del firmante cada 5 s usa `polled_at` y no lo corre. No consume un intento: el
  firmante puede volver a empezar. Si la decisión llega después del vencimiento y la verificación sigue siendo la última
  del destinatario (sin verificar, de turno y con el sobre en curso), se registra normalmente (`lateAfterTimeout` en la
  evidencia).
- **Sobre cerrado**: al completarse, rechazarse, anularse o vencer el sobre (cualquier transición; disparador de la
  migración `0109`) se cancelan las verificaciones en curso. Las fotos y el envío exigen el sobre en curso y no vencido
  y el destinatario de turno, con el sobre bloqueado. Las fotos guardadas se borran con la retención del sobre.
- **Reinicio por el remitente**: `POST /v1/envelopes/{id}/recipients/{recipientId}/identity/reset` (botón en el
  detalle del sobre) anula las verificaciones anteriores y devuelve todos los intentos (`recipient.identity_reset`).
  Una corrección que cambia el nombre, el contacto o el número de documento (`idDocumentNumber`) hace lo mismo.
- **Uso del plan**: cuentan las verificaciones del mes salvo las reservas canceladas que nunca abrieron una sesión en el
  proveedor. Si la sesión se crea en el proveedor después de que la reserva se canceló (el sobre se cerró mientras
  tanto), `provider_ref` se guarda igual y cuenta.

## Comparación de nombres

Sin acentos ni mayúsculas, con partículas ("de", "da", "van"…) ignoradas y tolerancia a errores menores. Las letras
latinas sin descomposición se transliteran (ł→l, ı→i, ø→o, đ→d, æ→ae, ß→ss, œ→oe, þ→th); los nombres en cirílico o
griego se comparan en su escritura (no se transliteran entre escrituras).
