# calasign — SDK de CalaSign para Python

Python ≥ 3.8, sin dependencias (solo la biblioteca estándar).

```python
import os, uuid
from calasign import CalaSign

cs = CalaSign(os.environ["CALASIGN_KEY"], base_url="https://dev.calasign.com")

detail = cs.envelopes.create({"subject": "Contrato de servicios", "metadata": {"externalId": "PED-1234"}})
eid = detail["envelope"]["id"]
doc = cs.envelopes.upload_document(eid, open("contrato.pdf", "rb").read(), "contrato.pdf")
signer = str(uuid.uuid4())
cs.envelopes.set_recipients(eid, [{"id": signer, "name": "Ana Pérez", "email": "ana@cliente.com", "channels": ["email"]}])
cs.envelopes.set_fields(eid, [{"recipientId": signer, "type": "signature",
                               "anchor": {"text": "[[firma]]", "offsetY": -40, "width": 150, "height": 40}}])
cs.envelopes.send(eid)

for e in cs.envelopes.iterate(status="completed"):
    pdf = cs.envelopes.download_signed(e["id"])
```

## Autenticación

```python
CalaSign("cs_live_…")                                              # API key
CalaSign(access_token="csat_…")                                    # token OAuth (authorization code + PKCE)
CalaSign(oauth=ClientCredentials("csapp_…", "cssec_…", scope="envelopes:read envelopes:write"))  # se renueva solo
```

## Comportamiento

- Reintentos ante errores de red, 429 (respeta `Retry-After`) y 5xx, con backoff exponencial (`max_retries=3`).
- `envelopes.create`, `envelopes.from_template` y `envelopes.send` usan `Idempotency-Key` automática: un reintento
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
