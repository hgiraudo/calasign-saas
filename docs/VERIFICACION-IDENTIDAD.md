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
no incluir la selfie o la prueba de vida. Un resultado aprobado que no trae la coincidencia facial (puntaje
`faceMatchScore` ≥ `IDV_FACE_MATCH_THRESHOLD`, o una decisión explícita del proveedor, p. ej. la validación
`face-recognition` de Truora en `success`) o la prueba de vida que pide el nivel termina como fallido con
`level_not_met` (consume un intento). Después se controlan el nombre (`name_mismatch`) y el número de documento
(`document_number_mismatch`).

## Configuración

| Variable | Default | Uso |
| --- | --- | --- |
| `VERIFF_API_KEY`, `VERIFF_SHARED_SECRET`, `VERIFF_BASE_URL` | — | integración de Veriff (una sola). La integración tiene que devolver los datos biométricos en la decisión (`faceMatch.similarity`, `liveness`) para los niveles con selfie; si no, esos niveles terminan en `level_not_met`. |
| `TRUORA_API_KEY`, `TRUORA_WEBHOOK_SECRET` | — | Truora (Digital Identity). |
| `TRUORA_FLOW_ID` | — | flujo por defecto. |
| `TRUORA_FLOW_ID_DOCUMENT`, `TRUORA_FLOW_ID_DOCUMENT_SELFIE`, `TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS` | `TRUORA_FLOW_ID` | flujo por nivel (documento; + reconocimiento facial; + prueba de vida). Truora queda configurado con `TRUORA_FLOW_ID` o con al menos uno de estos; un nivel sin flujo no puede iniciarse. |
| `IDV_FACE_MATCH_THRESHOLD` | `0.8` | similitud mínima (0..1) selfie / documento. |
| `IDV_PENDING_TIMEOUT_HOURS` | `24` | horas que una verificación de Veriff o Truora puede esperar el resultado. |
| `IDV_MOCK_ENABLED` | — | `1` habilita el proveedor de prueba en producción (no recomendado). |

## Ciclo de vida

- **Veriff `resubmission_requested`**: queda en revisión (la verificación sigue en curso y la página de Veriff sirve
  para reenviar las fotos); la decisión posterior de la misma sesión la reemplaza.
- **Truora**: el webhook (JWT HS256) puede traer varios eventos; se procesan todos. El resultado se consulta por
  `process_id`; mientras no llegó ningún webhook no hay consulta posible (la API no documenta una búsqueda por
  `account_id`). La referencia que queda en la evidencia y el certificado es el `process_id`.
- **Sin resultado**: el barrido periódico (`identity-stale`) da por vencidas las verificaciones de un proveedor
  externo que esperan hace más de `IDV_PENDING_TIMEOUT_HOURS` (estado `expired`, motivo `provider_timeout`, evento
  `recipient.identity_expired`). No consume un intento: el firmante puede volver a empezar.
- **Sobre cerrado**: al completarse, rechazarse, anularse o vencer el sobre (cualquier transición; disparador de la
  migración `0109`) se cancelan las verificaciones en curso. Las fotos y el envío exigen el sobre en curso y no vencido
  y el destinatario de turno, con el sobre bloqueado. Las fotos guardadas se borran con la retención del sobre.
- **Reinicio por el remitente**: `POST /v1/envelopes/{id}/recipients/{recipientId}/identity/reset` (botón en el
  detalle del sobre) anula las verificaciones anteriores y devuelve todos los intentos (`recipient.identity_reset`).
  Una corrección que cambia el nombre, el contacto o el número de documento (`idDocumentNumber`) hace lo mismo.
- **Uso del plan**: cuentan las verificaciones del mes salvo las reservas canceladas que nunca abrieron una sesión en el
  proveedor.

## Comparación de nombres

Sin acentos ni mayúsculas, con partículas ("de", "da", "van"…) ignoradas y tolerancia a errores menores. Las letras
latinas sin descomposición se transliteran (ł→l, ı→i, ø→o, đ→d, æ→ae, ß→ss, œ→oe, þ→th); los nombres en cirílico o
griego se comparan en su escritura (no se transliteran entre escrituras).
