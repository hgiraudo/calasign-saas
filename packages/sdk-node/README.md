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
  errores de red. Si el pedido original con la misma clave sigue en curso (409 `idempotency_in_progress`, típico del
  reintento tras un timeout), el SDK espera y repite hasta recibir la respuesta guardada, con un tope propio
  (`idempotencyWaitMs`, por defecto 60 s) que no gasta `maxRetries`. Todo `CalaSignError` de un pedido con clave trae
  `err.idempotencyKey`: reintentá con `{ idempotencyKey: err.idempotencyKey }` sin riesgo de duplicar. Las claves son
  por credencial (no por ruta) y quedan atadas al pedido (método, URL y cuerpo): usar la misma clave para dos llamadas
  distintas da 409 `idempotency_mismatch`.
- **Edición concurrente de borradores**: `envelopes.update`, `setRecipients` y `setFields` aceptan
  `{ expectedUpdatedAt: envelope.updatedAt }` (header `X-Expected-Updated-At`). Si el borrador cambió desde que lo
  cargaste, la API responde 409 `version_changed` con `err.details.updatedAt` (el valor actual): recargá, reaplicá el
  cambio y reintentá. Con `expectedUpdatedAt` el SDK no reintenta solo ante errores de red ni 5xx (sí ante 429 y 503,
  que la API responde sin procesar): si el primer intento se guardó y se perdió la respuesta, el reintento daría un
  `version_changed` falso. Ante un `network_error` o un 5xx, recargá el sobre y comprobá si el cambio quedó aplicado.
- **Anular**: `envelopes.void` se reintenta ante errores de red/5xx; si un reintento recibe 409 `not_voidable` porque el
  primer intento ya lo anuló (solo tras un reintento por red o 500/502/504, no por 429/503), el SDK lo confirma con un GET y devuelve el sobre anulado. Anular dos veces a propósito
  sigue dando 409 `not_voidable`.
- **Paginación**: `for await (const e of cs.envelopes.iterate({ status: "completed" })) { … }`.
- **Errores** como `CalaSignError` con `status`, `code`, `details` (los mismos de la API) y `requestId` (header
  `X-Request-Id`, para soporte). Errores de red y cortes a mitad del cuerpo (también en las descargas): `network_error`
  (en los GET se reintentan); un 2xx que no es JSON: `invalid_response`.
- **URL de firma**: `cs.envelopes.signingUrl(envelopeId, recipientId, { returnUrl })` → `{ url, expiresAt, tabOnly? }`,
  URL de 5 minutos y un solo uso, para destinatarios embebidos (iframe, con `frameAncestors`) o no embebidos que la
  página igual autentica (código OTP, firma presencial o verificación de identidad pendiente: abrirla en una pestaña o
  redirigir). Para un destinatario no embebido que solo tiene el link por correo responde 409 `not_embedded` (crealo con
  `embedded: true` o exigí un código). `tabOnly: true` (destinatarios con OTP) significa que no se puede embeber: abrila en una pestaña
  o redirigí; pedir `frameAncestors` para ellos da 409 `otp_not_embeddable`. En un iframe, la página de firma avisa por
  `postMessage` los eventos `viewed`, `signing_complete`, `declined`, `error` y `closed` (con `status`).
- **Descarga**: `cs.envelopes.downloadSigned(id)` → `Uint8Array` del PDF sellado.
- **Eventos**: `for await (const ev of cs.events.poll({ after, signal }))`; al abortar `signal` se cancelan la espera
  y el pedido en curso y el iterador termina sin lanzar.
- **Cualquier otro endpoint**: `cs.request("GET", "/v1/…")` con la misma autenticación y reintentos (`{ raw: true }` devuelve
  `{ bytes, headers }`; `{ signal }` lo cancela; `{ headers }` agrega headers).

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
corepack pnpm --filter @calasign/sdk build                                  # dist/ (JS ESM + .d.ts)
```

`build` compila con `tsc` y después `scripts/bundle-types.mjs` expande en `dist/shared-types.d.ts` los tipos que
vienen de `@calasign/shared` (privado, no se publica): el paquete publicado no depende de él ni de zod. Dentro del
monorepo el paquete apunta a `src/index.ts`; al empaquetar (`pnpm pack`/`pnpm publish`), `publishConfig` cambia
`main`, `types` y `exports` a `dist/`. Solo ESM (`import`; desde CommonJS, `await import("@calasign/sdk")`).

### Instalar desde el código fuente (mientras no esté en npm)

```bash
corepack pnpm install
corepack pnpm -C packages/sdk-node pack --pack-destination /tmp   # corre el build (prepack) y arma el .tgz
# y en tu proyecto:
npm install /tmp/calasign-sdk-0.1.0.tgz
```

No instales la carpeta `packages/sdk-node` directo (`npm install ../packages/sdk-node`): sin empaquetar, apunta al
código TypeScript de `src/` y a `@calasign/shared`.
