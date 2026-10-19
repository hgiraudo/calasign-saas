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
  con un tope propio (`idempotency_wait=60.0` segundos) que no gasta `max_retries`.
- Errores como `CalaSignError` con `.status`, `.code`, `.details`, `.request_id` (header `X-Request-Id`, para soporte)
  e `.idempotency_key` (la del pedido, si tenía: reintentá con `idempotency_key=e.idempotency_key` sin riesgo de
  duplicar).
- `timeout=30.0` es por operación de socket (conectar y cada lectura), no un tope del pedido entero: una descarga
  grande que avanza de a poco puede tardar más. Si necesitás un tope total, controlalo desde tu código.
- `events.list(types=…)` y `envelopes.batch(action, ids)` aceptan una lista o un solo valor como `str`.
- `envelopes.download_attachment(id, field_id)` devuelve los bytes; `download_attachment_with_type` devuelve
  `{"bytes": …, "content_type": …}` (un adjunto puede ser PDF o imagen).
- `envelopes.signing_url(id, recipient_id, return_url=…, frame_ancestors=["https://app.tuempresa.com"])`: los orígenes
  (de los autorizados de la organización) que pueden embeber la firma.
- `cs.request(method, path, json_body=…, query=…)` para cualquier otro endpoint.

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
