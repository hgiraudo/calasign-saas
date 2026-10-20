# CalaSign SaaS — IA (Fase 6)

Funciones opcionales, **deshabilitadas por defecto** en cada organización. Para habilitarlas, un usuario con
`settings:manage` acepta el aviso de tratamiento de datos (`ai-notice-v2`) en Ajustes → Inteligencia artificial.
Cuando cambia la versión del aviso (`AI_NOTICE_VERSION`), la IA de las organizaciones que aceptaron una anterior queda
en pausa (403 `ai_notice_required`, sin asistencia al firmante ni extracción automática) hasta que alguien acepte la
vigente; la consola lo pide. v2 aclara que el texto del documento se envía tal cual (con los datos personales que
contenga) y que no se envía ningún otro dato del sobre.

| Función | Dónde | Qué se envía al modelo |
|---|---|---|
| Detección de campos | Editor → paso Campos → «Detectar campos» | Texto de los documentos con el id de cada línea. **Sin IA habilitada** corre igual con heurísticas y no sale nada del servidor. Con IA, si no queda presupuesto o el documento es demasiado largo para el modelo, también devuelve solo las heurísticas (en vez de fallar). |
| Revisión contra el playbook | Editor → paso Revisar y enviar | Texto de los documentos y las reglas de la organización |
| Resumen y preguntas del firmante | Página de firma (si el remitente lo habilita en el sobre; no se ofrece si los originales se purgaron por retención ni en un sobre vencido) | Texto de los documentos y la pregunta. Nunca firmas, imágenes ni datos de contacto. |
| Datos del contrato | Detalle del sobre completado (y automático al completarse, ver abajo) | Texto de los documentos |
| Alertas de renovación | Sweeper: correo al remitente N días antes del vencimiento/renovación (o del preaviso, si es mayor). No sale ninguna con la IA apagada o los días en 0 (aunque estuviera programada); al cambiar los días se reprograman las alertas pendientes | Nada (usa los datos ya extraídos) |

**Extracción automática** (barrido, hasta 5 sobres por pasada): solo sobres completados sin datos y con los
originales sin purgar; las organizaciones con la clave BYOK fallando o sin presupuesto este mes se saltean. Si falla
por algo transitorio (BYOK o almacenamiento caídos, proveedor de IA saturado o caído) se reintenta en una hora; si
el proveedor rechazó el pedido (clave revocada, modelo mal configurado, saldo agotado), en 6 horas. Los reintentos
siguen como mucho 30 días desde el primer intento (`ai_metadata_first_attempt_at`). Quedarse sin presupuesto del mes
no cuenta como intento ni abre esa ventana de 30 días: se reintenta el primer día del mes siguiente. Con la IA apagada,
el aviso sin aceptar o un plan sin IA, el sobre espera sin fecha. Un sobre que no entra en lo que queda del presupuesto
(o choca con llamadas en curso) y un timeout del proveedor esperan 6 horas.

- **Transparencia:** `GET /v1/envelopes/:id/ai/preview?feature=…` y el botón «Ver qué se envía» muestran el texto exacto.
- **Evidencia:** cada interacción agrega un evento `ai.<función>` con proveedor, modelo, tokens y SHA-256 del prompt (nunca el texto).
- **Presupuesto:** tokens por mes por organización (`ai_usage`); al agotarse, 429 `ai_budget_exceeded`. El efectivo es
  `min(presupuesto de la organización, tope del plan)` (ver abajo): una baja de plan baja el tope en el momento.
- **Llamadas fallidas:** un rechazo del modelo, una respuesta cortada (`max_tokens`) o inválida y un timeout se cobran:
  se registran en `ai_usage` y en la evidencia (`failed: true`; en un timeout, `estimated: true` con la entrada estimada
  y la salida al tope de 16 000) y descuentan presupuesto y cupo del firmante. Un error de conexión, 429 o 5xx del
  proveedor no se cobra: se reintenta (hasta 2 veces, con espera) y si sigue fallando se libera la reserva.
- **Cupo del firmante:** 30 consultas por día y 100 en total por sobre (resumen y preguntas). Se cuenta en `ai_usage`
  (`recipient_id`) al reservar, antes de llamar al modelo y con la organización bloqueada (dos consultas simultáneas
  no pasan juntas el tope), más los resúmenes servidos desde la caché.
- **Ids de línea (detección de campos):** `d{documento}-p{página}-l{línea}` (p. ej. `d2-p1-l14`): con varios documentos
  los ids de línea se repetían y una sugerencia caía en el primero.
- **Texto enviado:** `<` y `>` del texto y del nombre del documento se reemplazan por `‹` `›` (no pueden cerrar la
  etiqueta `<documento>`).

## Tope de tokens de IA por plan

La IA la paga la plataforma: el presupuesto que fija cada organización no puede superar el tope de su plan
(`PlanDefinition.aiTokensPerMonth`, `packages/shared/src/billing.ts`). `PATCH /v1/settings/ai` con un presupuesto mayor
responde 402 `plan_limit` (`limit: "ai_tokens_per_month"`, `max`, `suggestedPlan`); reenviar el valor ya guardado no
falla (tras bajar de plan se pueden guardar los demás ajustes; rige el mínimo). En un plan sin IA no se puede habilitar.

| Plan | Tokens de IA por mes (entrada + salida) | Referencia |
|---|---|---|
| Free | 0 (sin IA) | — |
| Starter | 2 000 000 | unos 130 resúmenes de un contrato de ~15 000 tokens |
| Business | 10 000 000 | unos 650 |
| Enterprise | 50 000 000 (configurable: `BILLING_ENTERPRISE_AI_TOKENS`, número o `unlimited`) | unos 3 300 |

La consola (Ajustes → IA) muestra el tope del plan y el presupuesto efectivo; Facturación, el tope de cada plan y el
consumo del mes contra el del plan vigente.
- **Citas:** el modelo devuelve citas literales con página; el servidor verifica que el texto exista en el documento (`verified`).

## Proveedor

`apps/api/src/modules/ai/provider.ts` define `AiProvider` con dos implementaciones:

- **anthropic** — Claude vía `@anthropic-ai/sdk`, salidas estructuradas (`betaZodOutputFormat`), caché de prompts sobre
  el bloque del documento (resumen y preguntas reutilizan el caché), `fallbacks: "default"` (beta
  `server-side-fallback-2026-07-01`) y manejo de `stop_reason: "refusal"` / `max_tokens`.
- **mock** — determinista y sin red (heurísticas en `heuristics.ts`). Se usa automáticamente si no hay clave; las pruebas
  usan siempre el mock.

| Variable | Default | Uso |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Sin clave (ni `ANTHROPIC_AUTH_TOKEN`) → proveedor mock. **En producción** (`NODE_ENV=production`) nunca se usa el mock: sin clave la IA queda deshabilitada (503 `ai_unavailable`, `provider: "none"` en la consola) y se loguea un error al arrancar |
| `ANTHROPIC_AUTH_TOKEN` | — | Alternativa a la API key (token Bearer; lo lee el SDK) |
| `AI_PROVIDER` | auto | `mock` o `anthropic` para forzar |
| `AI_MODEL` | `claude-opus-5-5` | Modelo |
| `AI_EFFORT` | `medium` | `low`/`medium`/`high`/`xhigh`/`max` |
| `AI_FALLBACKS` | on | `off` para no enviar `fallbacks` (modelos o plataformas que no lo soportan) |
| `AI_MAX_INPUT_TOKENS` | `150000` | Tope estimado de entrada por llamada (mínimo 1000); más → 413 `ai_input_too_large` |
| `AI_REQUEST_TOKEN_ESTIMATE` | `8000` | Tokens que reserva del presupuesto cada llamada en curso hasta registrar el consumo real |
| `BILLING_ENTERPRISE_AI_TOKENS` | `50000000` | Tope de tokens de IA por mes del plan Enterprise (`unlimited`: sin tope del plan) |

Timeout por llamada (sin streaming): 120 s más 1 s por cada 1000 tokens estimados de entrada, con tope de 10 min. El
SDK corre con `maxRetries: 0` (reintentaría también los timeouts, que se cobran): los reintentos son propios y solo
para errores de conexión, 408/409/429 y 5xx. Un timeout no se reintenta (504 `ai_timeout`).

En la nube la clave va en SSM (`/calasign-saas/<entorno>/ANTHROPIC_API_KEY`); `scripts/deploy-dev.sh` la copia a `secrets.env` junto con los demás secretos (sin ese parámetro, dev corre con el mock).
