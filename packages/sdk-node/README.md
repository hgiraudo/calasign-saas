# @calasign/sdk — SDK de CalaSign para Node.js

Firma electrónica desde tu backend. Sin dependencias (usa `fetch` y `node:crypto`), Node ≥ 18, tipos completos.

```ts
import { readFile } from "node:fs/promises";
import { CalaSign } from "@calasign/sdk";

const cs = new CalaSign({ apiKey: process.env.CALASIGN_KEY!, baseUrl: "https://dev.calasign.com" });

// Una sola llamada: crea el sobre con el PDF, el firmante y su campo, y lo envía (atómico e idempotente).
const { envelope, recipients } = await cs.envelopes.createAndSend({
  subject: "Contrato de servicios",
  metadata: { externalId: "PED-1234" },
  documents: [{ content: await readFile("contrato.pdf"), name: "contrato.pdf" }],
  recipients: [{ name: "Ana Pérez", email: "ana@cliente.com", phone: "+5511999990000", channels: ["email", "whatsapp"] }],
  fields: [{ recipient: 0, type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } }],
});
```

`envelopes.create(input)` hace lo mismo sin enviar (queda en borrador) o, con solo `{ subject }`, crea un borrador vacío.
Los documentos van con `content` (bytes: el SDK los sube como multipart, sin base64), `base64` o `url`. Los campos
citan al destinatario con `recipient` (posición, `ref` o email) y al documento con `document` (posición o `ref`); con un
solo firmante o un solo documento se pueden omitir. Con firmantes `embedded: true`, la respuesta trae `signingUrls`.

Paso a paso (sobre que se arma de a poco): `uploadDocument`, `setRecipients`, `setFields` y `send`.

## Autenticación

| Opción | Uso |
|---|---|
| `apiKey` | API key de la organización (`cs_live_…`). |
| `oauth: { clientId, clientSecret, scope? }` | OAuth 2.0 client credentials: el SDK pide el token, lo cachea y lo renueva solo (también ante un 401). |
| `accessToken` | Un access token OAuth que obtuviste con authorization code + PKCE (actuar en nombre de un usuario). |

## Qué resuelve el SDK

- **Reintentos** ante errores de red, 429 (respetando `Retry-After`) y 5xx, con backoff exponencial y jitter
  (`maxRetries`, por defecto 3). Un 429 de un tope de negocio (código propio y sin `Retry-After`, p. ej.
  `reminded_recently`) no se reintenta: se lanza enseguida como `CalaSignError`.
- **Idempotencia**: `envelopes.create`, `envelopes.createAndSend`, `envelopes.fromTemplate` y `envelopes.send` mandan `Idempotency-Key` automática
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
