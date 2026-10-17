# @calasign/sdk — SDK de CalaSign para Node.js

Firma electrónica desde tu backend. Sin dependencias (usa `fetch` y `node:crypto`), Node ≥ 18, tipos completos.

```ts
import { CalaSign } from "@calasign/sdk";

const cs = new CalaSign({ apiKey: process.env.CALASIGN_KEY!, baseUrl: "https://dev.calasign.com" });

const { envelope } = await cs.envelopes.create({ subject: "Contrato de servicios", metadata: { externalId: "PED-1234" } });
const doc = await cs.envelopes.uploadDocument(envelope.id, await readFile("contrato.pdf"), "contrato.pdf");
const signerId = crypto.randomUUID();
await cs.envelopes.setRecipients(envelope.id, [
  { id: signerId, name: "Ana Pérez", email: "ana@cliente.com", phone: "+5511999990000", channels: ["email", "whatsapp"] },
]);
await cs.envelopes.setFields(envelope.id, [
  { recipientId: signerId, type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } },
]);
await cs.envelopes.send(envelope.id);
```

## Autenticación

| Opción | Uso |
|---|---|
| `apiKey` | API key de la organización (`cs_live_…`). |
| `oauth: { clientId, clientSecret, scope? }` | OAuth 2.0 client credentials: el SDK pide el token, lo cachea y lo renueva solo (también ante un 401). |
| `accessToken` | Un access token OAuth que obtuviste con authorization code + PKCE (actuar en nombre de un usuario). |

## Qué resuelve el SDK

- **Reintentos** ante errores de red, 429 (respetando `Retry-After`) y 5xx, con backoff exponencial y jitter
  (`maxRetries`, por defecto 3).
- **Idempotencia**: `envelopes.create`, `envelopes.fromTemplate` y `envelopes.send` mandan `Idempotency-Key` automática
  (o la tuya), así que un reintento nunca duplica un sobre ni un envío. Un POST sin idempotencia no se reintenta ante
  errores de red.
- **Paginación**: `for await (const e of cs.envelopes.iterate({ status: "completed" })) { … }`.
- **Errores** como `CalaSignError` con `status`, `code` y `details` (los mismos de la API).
- **Firma embebida**: `cs.envelopes.signingUrl(envelopeId, recipientId, { returnUrl })` → URL de 5 minutos para un iframe.
- **Descarga**: `cs.envelopes.downloadSigned(id)` → `Uint8Array` del PDF sellado.
- **Cualquier otro endpoint**: `cs.request("GET", "/v1/…")` con la misma autenticación y reintentos.

## Webhooks

```ts
import { constructWebhookEvent, WebhookSignatureError } from "@calasign/sdk";

app.post("/webhooks/calasign", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = constructWebhookEvent({
      payload: req.body, // cuerpo CRUDO
      header: req.header("CalaSign-Signature"),
      secret: process.env.CALASIGN_WEBHOOK_SECRET!,
    });
    if (event.type === "envelope.completed") { /* … */ }
    res.sendStatus(200);
  } catch (e) {
    if (e instanceof WebhookSignatureError) return res.sendStatus(400);
    throw e;
  }
});
```

La firma es `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`; se rechazan firmas de más de 5 minutos
(`toleranceSec`) para evitar repeticiones.

## Desarrollo

```bash
corepack pnpm --filter @calasign/sdk test                                   # unitarios
CALASIGN_TEST_BASE=http://localhost:4000 corepack pnpm --filter @calasign/sdk test   # + integración contra la API local
corepack pnpm --filter @calasign/sdk build                                  # dist/ (JS + .d.ts)
```

Para publicarlo en npm hay que publicar también `@calasign/shared` (los tipos) o empaquetar los `.d.ts`
(por ejemplo con `tsup --dts`).
