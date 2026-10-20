# calasign — SDK de CalaSign para Python

Python ≥ 3.8, sin dependencias (solo la biblioteca estándar).

```python
import os
from calasign import CalaSign

cs = CalaSign(os.environ["CALASIGN_KEY"], base_url="https://dev.calasign.com")

# Una sola llamada: crea el sobre con el PDF, el firmante y su campo, y lo envía (atómico e idempotente).
with open("contrato.pdf", "rb") as f:
    detail = cs.envelopes.create_and_send({
        "subject": "Contrato de servicios",
        "metadata": {"externalId": "PED-1234"},
        "documents": [{"content": f.read(), "name": "contrato.pdf"}],
        "recipients": [{"name": "Ana Pérez", "email": "ana@cliente.com"}],
        "fields": [{"recipient": 0, "type": "signature",
                    "anchor": {"text": "[[firma]]", "offsetY": -40, "width": 150, "height": 40}}],
    })

for e in cs.envelopes.iterate(status="completed"):
    pdf = cs.envelopes.download_signed(e["id"])
```

`envelopes.create(data)` hace lo mismo sin enviar (queda en borrador) o, con solo `{"subject": …}`, crea un borrador
vacío. Los documentos van con `content` (bytes: se suben como multipart, sin base64), `base64` o `url`; los campos citan
al destinatario con `recipient` (posición, `ref` o email) y al documento con `document` (posición o `ref`). Paso a
paso: `upload_document`, `set_recipients`, `set_fields` y `send`.

## Autenticación

```python
CalaSign("cs_live_…")                                              # API key
CalaSign(access_token="csat_…")                                    # token OAuth (authorization code + PKCE)
CalaSign(oauth=ClientCredentials("csapp_…", "cssec_…", scope="envelopes:read envelopes:write"))  # se renueva solo
```

## Comportamiento

- Reintentos ante errores de red, 429 (respeta `Retry-After`) y 5xx, con backoff exponencial (`max_retries=3`).
- Un 429 se reintenta solo si es el límite de pedidos por IP (trae `Retry-After`). Los 429 de topes de negocio, con
  código propio y sin `Retry-After` (`reminded_recently`, `form_rate_limited`, `ai_signer_limit`, …), se lanzan enseguida
  como `CalaSignError`: reintentarlos en un loop no sirve.
- `envelopes.create`, `envelopes.create_and_send`, `envelopes.from_template` y `envelopes.send` usan `Idempotency-Key` automática: un reintento
  no duplica nada. Los POST sin idempotencia no se reintentan ante errores de red. Si el pedido original con la misma
  clave sigue en curso (409 `idempotency_in_progress`), el cliente espera y repite hasta recibir la respuesta guardada,
  con un tope propio (`idempotency_wait=60.0` segundos) que no gasta `max_retries`. Las claves son por credencial (no
  por ruta) y quedan atadas al pedido (método, URL y cuerpo): la misma clave en dos llamadas distintas da 409
  `idempotency_mismatch`.
- Edición concurrente de borradores: `envelopes.update`, `set_recipients` y `set_fields` aceptan
  `expected_updated_at=detail["envelope"]["updatedAt"]` (header `X-Expected-Updated-At`). Si el borrador cambió desde
  que lo cargaste, 409 `version_changed` con `e.details["updatedAt"]` (el actual): recargá, reaplicá y reintentá.
  Con `expected_updated_at` el cliente no reintenta solo ante errores de red ni 5xx (sí ante 429 y 503, que la API
  responde sin procesar): si el primer intento se guardó y se perdió la respuesta, el reintento daría un
  `version_changed` falso. Ante un `network_error` o un 5xx, recargá el sobre y comprobá si el cambio quedó aplicado.
- `envelopes.void` se reintenta ante errores de red/5xx; si un reintento recibe 409 `not_voidable` porque el primer
  intento ya lo anuló (solo tras un reintento por red o 500/502/504, no por 429/503), el cliente lo confirma con un GET y devuelve el sobre anulado. Anular dos veces a propósito sigue
  dando 409 `not_voidable`.
- Errores como `CalaSignError` con `.status`, `.code`, `.details`, `.request_id` (header `X-Request-Id`, para soporte)
  e `.idempotency_key` (la del pedido, si tenía: reintentá con `idempotency_key=e.idempotency_key` sin riesgo de
  duplicar).
- `timeout=30.0` es por operación de socket (conectar y cada lectura), no un tope del pedido entero: una descarga
  grande que avanza de a poco puede tardar más. Si necesitás un tope total, controlalo desde tu código.
- `events.list(types=…)` y `envelopes.batch(action, ids)` aceptan una lista o un solo valor como `str`.
- `envelopes.download_attachment(id, field_id)` devuelve los bytes; `download_attachment_with_type` devuelve
  `{"bytes": …, "content_type": …}` (un adjunto puede ser PDF o imagen).
- `envelopes.signing_url(id, recipient_id, return_url=…, frame_ancestors=["https://app.tuempresa.com"])` →
  `{"url", "expiresAt", "tabOnly"?}`: URL de 5 minutos y un solo uso para destinatarios embebidos (iframe;
  `frame_ancestors` son los orígenes, de los autorizados de la organización, que pueden embeberla) o no embebidos que la
  página igual autentica (código OTP, firma presencial o verificación de identidad pendiente: abrirla en una pestaña o
  redirigir). Un destinatario no embebido que solo tiene el link por correo da 409 `not_embedded`. `tabOnly: True` (destinatarios con OTP) significa que no se puede embeber: pedir
  `frame_ancestors` para ellos da 409 `otp_not_embeddable`. En un iframe, la página de firma avisa por `postMessage`
  los eventos `viewed`, `signing_complete`, `declined`, `error` y `closed` (con `status`).
- `webhooks.update(id, **campos)` (PATCH parcial: `url`, `events`, `description`, `active`). Al revocar la API key o el
  token OAuth que creó una suscripción, esta se desactiva (`active: False`); `webhooks.update(id, active=True)` la
  reactiva y la ata a la credencial actual (conserva id y secreto).
- `cs.request(method, path, json_body=…, query=…, headers=…)` para cualquier otro endpoint.

## Webhooks

```python
from calasign import construct_event, WebhookSignatureError

@app.post("/webhooks/calasign")
def hook():
    try:
        event = construct_event(request.get_data(), request.headers.get("CalaSign-Signature"), os.environ["CALASIGN_WEBHOOK_SECRET"])
    except WebhookSignatureError:
        return "", 400
    if event["type"] == "envelope.completed":
        ...
    return "", 200
```

## Pruebas

```bash
python3 -I sdks/python/smoke_test.py                        # sin red
python3 -I sdks/python/smoke_test.py http://localhost:4000  # contra una API local
```
