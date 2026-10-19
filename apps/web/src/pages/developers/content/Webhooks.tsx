import { WEBHOOK_EVENT_TYPES } from "@calasign/shared";
import { useDocsText, type DocsKey } from "../../../lib/i18n-docs";
import { apiTabs, sdkNode, sdkPy } from "../samples";
import { Callout, Code, CodeTabs, DataTable, DocPage, H2, H3, Md } from "../ui";

const PAYLOAD = `{
  "id": "0192f3b0-7c1e-7a4d-9e2f-5b8c0d1e2f3a",
  "type": "recipient.signed",
  "createdAt": "2026-10-18T15:01:47.120Z",
  "tenantId": "0192e000-1111-7222-8333-444455556666",
  "data": {
    "envelope": {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
      "subject": "Contrato de servicios",
      "status": "sent",
      "metadata": { "externalId": "PED-1234" },
      "sentAt": "2026-10-18T14:31:02.000Z",
      "completedAt": null,
      "signedSha256": null,
      "recipients": [
        { "id": "9b2d1c7e-4a8f-4e1b-9c3d-2f6a8b0c1d2e", "name": "Ana Pérez", "email": "ana@example.com",
          "role": "signer", "status": "signed", "routingOrder": 1 },
        { "id": "1f0e2d3c-4b5a-4968-8776-655443322110", "name": "Bruno Costa", "email": "bruno@example.com",
          "role": "signer", "status": "sent", "routingOrder": 2 }
      ]
    },
    "recipientId": "9b2d1c7e-4a8f-4e1b-9c3d-2f6a8b0c1d2e",
    "reason": null
  }
}`;

const HEADERS = `POST /webhooks/calasign HTTP/1.1
Content-Type: application/json
User-Agent: CalaSign-Webhooks/1.0
CalaSign-Signature: t=1792335707,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
CalaSign-Event-Id: 0192f3b0-7c1e-7a4d-9e2f-5b8c0d1e2f3a
CalaSign-Event-Type: recipient.signed
CalaSign-Delivery-Id: 0192f3b0-8d2f-7b5e-af30-6c9d1e2f3a4b`;

const verifyNode = (c: (k: DocsKey) => string) => `import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

const app = express();

function verifyCalaSign(rawBody, header, secret, toleranceSec = 300) {
  const m = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(\`\${m[1]}.\`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(m[2], "hex"));
}

// ${c("wh.c.raw")}
app.post("/webhooks/calasign", express.raw({ type: "application/json" }), async (req, res) => {
  if (!verifyCalaSign(req.body, req.get("CalaSign-Signature"), process.env.CALASIGN_WEBHOOK_SECRET)) {
    return res.sendStatus(400);
  }
  const event = JSON.parse(req.body.toString("utf8"));
  if (await alreadyProcessed(event.id)) return res.sendStatus(200);
  await queue.add(event); // ${c("wh.c.async")}
  res.sendStatus(200);
});`;

const verifyPy = (c: (k: DocsKey) => string) => `import hashlib, hmac, json, os, re, time
from flask import Flask, request

app = Flask(__name__)

def verify_calasign(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    m = re.fullmatch(r"t=(\\d+),v1=([0-9a-f]{64})", header or "")
    if not m or abs(time.time() - int(m.group(1))) > tolerance:
        return False
    expected = hmac.new(secret.encode(), m.group(1).encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, m.group(2))

@app.post("/webhooks/calasign")
def calasign_webhook():
    raw = request.get_data()  # ${c("wh.c.raw")}
    if not verify_calasign(raw, request.headers.get("CalaSign-Signature"), os.environ["CALASIGN_WEBHOOK_SECRET"]):
        return "", 400
    event = json.loads(raw)
    if already_processed(event["id"]):
        return "", 200
    enqueue(event)
    return "", 200`;

const SDK_PY = `from calasign import construct_event, WebhookSignatureError

try:
    event = construct_event(request.get_data(), request.headers.get("CalaSign-Signature"),
                            os.environ["CALASIGN_WEBHOOK_SECRET"])
except WebhookSignatureError:
    return "", 400`;

const sdkNodeVerify = (c: (k: DocsKey) => string) => `import { constructWebhookEvent, WebhookSignatureError } from "@calasign/sdk";

try {
  const event = constructWebhookEvent({
    payload: req.body, // ${c("wh.c.raw")}
    header: req.get("CalaSign-Signature"),
    secret: process.env.CALASIGN_WEBHOOK_SECRET,
  });
} catch (e) {
  if (e instanceof WebhookSignatureError) return res.sendStatus(400);
  throw e;
}`;

/** Esperas entre intentos: 5 s × 2^(n-1), con tope de 1 h, 8 intentos en total. */
const DELAYS = [5, 10, 20, 40, 80, 160, 320];

export function WebhooksPage() {
  const t = useDocsText();
  const k = (s: string) => s as DocsKey;
  return (
    <DocPage title={t("wh.title")} lead={t("wh.lead")}>
      <H2 id="setup">{t("wh.setup.h")}</H2>
      <Md text={t("wh.setup.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/webhooks",
          body: { url: "https://api.tuempresa.com/webhooks/calasign", description: "Producción", events: ["envelope.completed", "envelope.declined", "recipient.signed"] },
          extra: [
            sdkPy(`r = cs.webhooks.create("https://api.tuempresa.com/webhooks/calasign", events=["envelope.completed"])\nsecret = r["secret"]  # whsec_… ${t("wh.setup.once")}`),
            sdkNode(`const { webhook, secret } = await cs.webhooks.create({ url: "https://api.tuempresa.com/webhooks/calasign", events: ["envelope.completed"] });`),
          ],
        })}
      />

      <H2 id="events">{t("wh.events.h")}</H2>
      <Md text={t("wh.events.p")} />
      <DataTable
        head={[t("wh.col.event"), t("wh.col.when")]}
        rows={[...WEBHOOK_EVENT_TYPES, "webhook.test"].map((e) => [<code key={e}>{e}</code>, <Md key="d" text={t(k(`wh.ev.${e}`))} />])}
      />

      <H2 id="payload">{t("wh.payload.h")}</H2>
      <Md text={t("wh.payload.p")} />
      <Code lang="http" code={HEADERS} title={t("wh.payload.headers")} />
      <Code lang="json" code={PAYLOAD} title={t("wh.payload.body")} />
      <DataTable
        head={[t("wh.col.field"), t("concepts.col.meaning")]}
        rows={[
          [<code key="1">id</code>, t("wh.f.id")],
          [<code key="2">type</code>, t("wh.f.type")],
          [<code key="3">createdAt</code>, t("wh.f.createdAt")],
          [<code key="4">data.envelope</code>, t("wh.f.envelope")],
          [<code key="5">data.recipientId</code>, t("wh.f.recipientId")],
          [<code key="6">data.reason</code>, t("wh.f.reason")],
        ]}
      />

      <H2 id="verify">{t("wh.verify.h")}</H2>
      <Md text={t("wh.verify.p")} />
      <CodeTabs
        tabs={[
          { id: "node", label: "Node.js", lang: "js", code: verifyNode(t) },
          { id: "python", label: "Python", lang: "python", code: verifyPy(t) },
          sdkPy(SDK_PY),
          sdkNode(sdkNodeVerify(t)),
        ]}
      />
      <Callout kind="warn">{t("wh.verify.warn")}</Callout>

      <H2 id="retries">{t("wh.retries.h")}</H2>
      <Md text={t("wh.retries.p")} />
      <DataTable
        head={[t("wh.col.attempt"), t("wh.col.wait")]}
        rows={[["1", t("wh.retries.immediate")], ...DELAYS.map((d, i) => [String(i + 2), d < 60 ? `${d} s` : `${Math.round((d / 60) * 10) / 10} min`])]}
      />
      <Md text={t("wh.retries.after")} />

      <H2 id="receiving">{t("wh.receive.h")}</H2>
      <Md text={t("wh.receive.p")} />

      <H2 id="testing">{t("wh.test.h")}</H2>
      <Md text={t("wh.test.p")} />
      <CodeTabs tabs={apiTabs({ method: "POST", path: "/v1/webhooks/{webhookId}/test" })} />
      <H3 id="deliveries">{t("wh.test.deliveries.h")}</H3>
      <Md text={t("wh.test.deliveries.p")} />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/v1/webhooks/{webhookId}/deliveries" })} />
    </DocPage>
  );
}
