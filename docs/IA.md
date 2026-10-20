# CalaSign SaaS — IA (Fase 6)

Funciones opcionales, **deshabilitadas por defecto** en cada organización. Para habilitarlas, un usuario con
`settings:manage` acepta el aviso de tratamiento de datos (`ai-notice-v1`) en Ajustes → Inteligencia artificial.

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
(o con la IA apagada) no cuenta como intento ni abre esa ventana de 30 días: el sobre queda para cuando vuelva a haber.

- **Transparencia:** `GET /v1/envelopes/:id/ai/preview?feature=…` y el botón «Ver qué se envía» muestran el texto exacto.
- **Evidencia:** cada interacción agrega un evento `ai.<función>` con proveedor, modelo, tokens y SHA-256 del prompt (nunca el texto).
- **Presupuesto:** tokens por mes por organización (`ai_usage`); al agotarse, 429 `ai_budget_exceeded`.
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
| `ANTHROPIC_API_KEY` | — | Sin clave (ni `ANTHROPIC_AUTH_TOKEN`) → proveedor mock |
| `ANTHROPIC_AUTH_TOKEN` | — | Alternativa a la API key (token Bearer; lo lee el SDK) |
| `AI_PROVIDER` | auto | `mock` o `anthropic` para forzar |
| `AI_MODEL` | `claude-opus-5-5` | Modelo |
| `AI_EFFORT` | `medium` | `low`/`medium`/`high`/`xhigh`/`max` |
| `AI_FALLBACKS` | on | `off` para no enviar `fallbacks` (modelos o plataformas que no lo soportan) |
| `AI_MAX_INPUT_TOKENS` | `150000` | Tope estimado de entrada por llamada (mínimo 1000); más → 413 `ai_input_too_large` |
| `AI_REQUEST_TOKEN_ESTIMATE` | `8000` | Tokens que reserva del presupuesto cada llamada en curso hasta registrar el consumo real |

En la nube la clave va en SSM (`/calasign-saas/<entorno>/ANTHROPIC_API_KEY`); `scripts/deploy-dev.sh` la copia a `secrets.env` junto con los demás secretos (sin ese parámetro, dev corre con el mock).
