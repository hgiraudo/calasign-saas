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
- `envelopes.create`, `envelopes.create_and_send`, `envelopes.from_template` y `envelopes.send` usan `Idempotency-Key` automática: un reintento
  no duplica nada. Los POST sin idempotencia no se reintentan ante errores de red.
- Errores como `CalaSignError` con `.status`, `.code` y `.details`.
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
