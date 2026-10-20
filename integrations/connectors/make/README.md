# CalaSign para Make

App personalizada de Make (Custom Apps). Cada archivo del zip es el contenido de una pestaña del editor de apps de Make:

| Componente | Archivos | Pestañas |
|---|---|---|
| Base | `base.imljson`, `common.imljson` | Base, Common data (client_id/secret de la app OAuth de CalaSign) |
| Conexión API key | `connections/calasign-apikey/` | Communication, Parameters |
| Conexión OAuth 2.0 (PKCE S256) | `connections/calasign-oauth/` | Communication, Parameters, Default scope |
| Webhook (dedicado, attach/detach) | `webhooks/envelope-event/` | Communication, Parameters, Attach, Detach |
| Módulos | `modules/<id>/` | Communication (`api`), Static parameters, Mappable parameters (`expect`), Interface, Samples |
| RPC | `rpcs/listTemplates`, `rpcs/templateForm` | Communication, Parameters |
| Funciones IML | `functions/*.js` | Functions |

Módulos: **Watch Envelope Events** (instantáneo), **Send an Envelope from a Template** (los destinatarios por rol y los
campos prellenables salen de la plantilla por `rpc://templateForm`), **Send a Document for Signature** (crea, sube el
PDF, destinatarios, campos de firma y envía), **Get an Envelope**, **Download the Signed Document**, **Void an
Envelope**, **Search Envelopes**.

`calasign-make-app.json` tiene todo junto para revisarlo. `makecomapp.json` es el manifiesto para la extensión
**Make Apps Editor** de VS Code (desarrollo local): completar `origins` con la zona y el id de la app creada, poner la
API key de Make (scopes `sdk-apps:read`, `sdk-apps:write`) en `.secrets/apikey` y hacer *Deploy*.

**Webhook firmado.** El *attach* guarda el `secret` que devuelve `POST /v1/webhooks` y la condición del webhook
(`calasignAcceptEvent`) verifica `CalaSign-Signature` (HMAC-SHA256 sobre `"<t>.<cuerpo>"`, se acepta cualquier `v1`).
No se controla la antigüedad de `t` (a diferencia de Zapier y n8n): Make puede evaluar la condición al procesar la cola
del webhook, mucho después de recibir la entrega, y descartaría eventos en silencio que la API ya contó como entregados.
Make no expone el cuerpo crudo: se re-serializa con `JSON.stringify` (la API firma el `JSON.stringify` compacto del
mismo objeto).

- **Rotar el secreto rompe la verificación.** El escenario guarda el secreto del *attach*; si se rota
  (`POST /v1/webhooks/{id}/rotate-secret` o desde el panel), después de la ventana en que la API firma con los dos
  secretos las entregas dejan de verificar y se descartan. Para tomar el secreto nuevo, apagar y prender el escenario
  (Make hace *detach* y *attach*, que crea un webhook nuevo con su secreto).
- **Webhooks sin secreto guardado se aceptan sin verificar.** Los adjuntados antes de que el *attach* guardara el
  secreto no lo tienen: por compatibilidad la condición los acepta sin verificar la firma (no los rechaza). Apagar y
  prender el escenario los pasa a verificados.

**Revocar o reconectar la conexión.** Al revocar la API key (o el token OAuth) con la que se creó el webhook, CalaSign lo
desactiva (`active: false`) y el escenario deja de recibir eventos. La solución es apagar y volver a prender el escenario
(Make hace *detach* y *attach* con la conexión actual).

**Errores.** Solo el 429 del límite de tasa genérico (con `Retry-After`, código `rate_limited`/`bad_request`) es
`RateLimitError`; los 429 de negocio (`reminded_recently`, etc.) son `RuntimeError`. Un 409 `idempotency_in_progress` es
`ConnectionError` (reintentable). Ver `calasignErrorType`.

## Pasos para publicar (cuenta de Make de CalaSign)

1. Make → **Custom apps → Create a new app** (`calasign`, color `#1F4E79`, ícono de 512×512).
2. Copiar cada archivo en su pestaña (o *Deploy* desde VS Code).
3. OAuth: crear en CalaSign (Ajustes → Apps OAuth) una app confidencial con redirect URI
   `https://www.make.com/oauth/cb/app` y scopes `envelopes:read envelopes:write templates:read webhooks:manage
   offline_access`; poner client_id y secret en *Common data*.
4. Probar cada módulo en un escenario y pedir la revisión de Make para publicarla ("Request review").
