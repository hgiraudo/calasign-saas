# CalaSign SaaS — IA (Fase 6)

Funciones opcionales, **deshabilitadas por defecto** en cada organización. Para habilitarlas, un usuario con
`settings:manage` acepta el aviso de tratamiento de datos (`ai-notice-v1`) en Ajustes → Inteligencia artificial.

| Función | Dónde | Qué se envía al modelo |
|---|---|---|
| Detección de campos | Editor → paso Campos → «Detectar campos» | Texto de los documentos con el id de cada línea. **Sin IA habilitada** corre igual con heurísticas y no sale nada del servidor. |
| Revisión contra el playbook | Editor → paso Revisar y enviar | Texto de los documentos y las reglas de la organización |
| Resumen y preguntas del firmante | Página de firma (si el remitente lo habilita en el sobre) | Texto de los documentos y la pregunta. Nunca firmas, imágenes ni datos de contacto. |
| Datos del contrato | Detalle del sobre completado (y automático al completarse; si falla por algo transitorio —BYOK o almacenamiento caídos— se reintenta en una hora, y las organizaciones con la clave BYOK fallando se saltean) | Texto de los documentos |
| Alertas de renovación | Sweeper: correo al remitente N días antes del vencimiento/renovación (o del preaviso, si es mayor) | Nada (usa los datos ya extraídos) |

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
| `ANTHROPIC_API_KEY` | — | Sin clave → proveedor mock |
| `AI_PROVIDER` | auto | `mock` o `anthropic` para forzar |
| `AI_MODEL` | `claude-opus-5-5` | Modelo |
| `AI_EFFORT` | `medium` | `low`/`medium`/`high`/`xhigh`/`max` |
| `AI_FALLBACKS` | on | `off` para no enviar `fallbacks` (modelos o plataformas que no lo soportan) |

En la nube la clave va en SSM (`/calasign-saas/<entorno>/ANTHROPIC_API_KEY`). Pendiente: sumar `ANTHROPIC_API_KEY` a la lista de secretos que `scripts/deploy-dev.sh` copia a `secrets.env` (hoy dev corre con el mock).
