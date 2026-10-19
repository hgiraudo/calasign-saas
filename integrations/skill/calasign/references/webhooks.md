# Webhooks

Create an endpoint (scope `webhooks:manage`); the secret is returned **once**:

```bash
curl -s {{BASE_URL}}/v1/webhooks -H "Authorization: Bearer $CALASIGN_API_KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/webhooks/calasign","events":["envelope.completed","recipient.signed"]}'
# → {"webhook": {...}, "secret": "…"}   (empty/absent events = all events)
```

Events: `envelope.sent`, `envelope.completed`, `envelope.declined`, `envelope.voided`, `envelope.expired`,
`recipient.viewed`, `recipient.signed`, `recipient.declined`, `recipient.approved` (+ `webhook.test` from
`POST /v1/webhooks/{id}/test`).

## Request

`POST` with JSON body and headers:

```
Content-Type: application/json
CalaSign-Signature: t=1760000000,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
CalaSign-Event-Id: <uuid>        (same across retries — use it to deduplicate)
CalaSign-Event-Type: envelope.completed
CalaSign-Delivery-Id: <uuid>
```

```json
{ "id": "<event id>", "type": "envelope.completed", "createdAt": "…", "tenantId": "…",
  "data": { "envelope": { "id": "…", "subject": "…", "status": "completed", "metadata": {}, "sentAt": "…",
            "completedAt": "…", "recipients": [ … ] },
            "recipientId": null, "reason": null } }
```

Respond 2xx within 10 s. Non-2xx, timeouts and redirects are retried with backoff (up to 8 attempts).
Process asynchronously and deduplicate by `CalaSign-Event-Id`.

## Verifying the signature

Always verify against the **raw** body bytes, and reject timestamps older than ~5 minutes.

Node:

```js
import crypto from "node:crypto";
function verify(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=").map((s) => s.trim())));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return parts.v1?.length === expected.length && crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
}
```

Python:

```python
import hashlib, hmac, time
def verify(raw: bytes, header: str, secret: str, tolerance=300) -> bool:
    p = dict(kv.strip().split("=", 1) for kv in header.split(","))
    t = int(p.get("t", 0))
    if abs(time.time() - t) > tolerance:
        return False
    exp = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(exp, p.get("v1", ""))
```

SDKs: Python `calasign.construct_event(raw, header, secret)`; Node `constructWebhookEvent({...})`.

After `envelope.completed`, download the PDF with `GET /v1/envelopes/{id}/signed.pdf`.
