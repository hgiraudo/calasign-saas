import { useDocsText } from "../../../lib/i18n-docs";
import { BASE } from "../constants";
import { apiTabs, sdkNode, sdkPy } from "../samples";
import { Callout, Code, CodeTabs, DocPage, H2, H3, Md } from "../ui";

const ANCHOR = { text: "[[firma]]", offsetY: -40, width: 150, height: 40 };

export function QuickstartPage() {
  const t = useDocsText();
  const c = (k: Parameters<typeof t>[0]) => t(k);

  // ───────── Una sola llamada: el camino principal ─────────

  // El base64 entra a jq por stdin (-Rs): como argumento (--arg pdf "$(base64 …)") superaba el límite de 128 KB por
  // argumento de Linux con cualquier PDF de más de ~96 KB ("Argument list too long"), y `base64 -w0` no existe en macOS.
  const oneCurl = `# ${c("qs.c.one")}
base64 < contrato.pdf | tr -d '\\n' | jq -Rs '{
  subject: "Contrato de servicios",
  message: "Hola Ana, te comparto el contrato para firmar.",
  metadata: { externalId: "PED-1234" },
  documents: [ { name: "contrato.pdf", base64: . } ],
  recipients: [ { name: "Ana Pérez", email: "ana@example.com" } ],
  fields: [ { recipient: 0, type: "signature",
              anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } } ],
  send: true
}' | curl -s -X POST "${BASE}/v1/envelopes" \\
  -H "Authorization: Bearer $CALASIGN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: pedido-1234" \\
  -d @- | jq '{id: .envelope.id, status: .envelope.status}'   # "sent"`;

  const oneMultipart = `# ${c("qs.c.multipart")}
curl -s -X POST "${BASE}/v1/envelopes" \\
  -H "Authorization: Bearer $CALASIGN_API_KEY" \\
  -H "Idempotency-Key: pedido-1234" \\
  -F 'payload={"subject":"Contrato de servicios","metadata":{"externalId":"PED-1234"},
      "documents":[{"file":"contrato"}],
      "recipients":[{"name":"Ana Pérez","email":"ana@example.com"}],
      "fields":[{"type":"signature","anchor":{"text":"[[firma]]","offsetY":-40,"width":150,"height":40}}],
      "send":true};type=application/json' \\
  -F "contrato=@contrato.pdf;type=application/pdf"`;

  const oneNode = `import { readFile } from "node:fs/promises";

// ${c("qs.c.one")} (multipart: ${c("qs.c.noBase64")})
const form = new FormData();
form.append("payload", JSON.stringify({
  subject: "Contrato de servicios",
  metadata: { externalId: "PED-1234" },
  documents: [{ file: "contrato" }],
  recipients: [{ name: "Ana Pérez", email: "ana@example.com" }],
  fields: [{ recipient: 0, type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } }],
  send: true,
}));
form.append("contrato", new Blob([await readFile("contrato.pdf")], { type: "application/pdf" }), "contrato.pdf");

const res = await fetch("${BASE}/v1/envelopes", {
  method: "POST",
  headers: { Authorization: \`Bearer \${process.env.CALASIGN_API_KEY}\`, "Idempotency-Key": "pedido-1234" },
  body: form,
});
const data = await res.json();
if (!res.ok) throw new Error(\`\${data.error.code}: \${data.error.message}\`);
console.log(data.envelope.id, data.envelope.status); // "sent"`;

  const onePy = `import json, os
import requests

# ${c("qs.c.one")} (multipart: ${c("qs.c.noBase64")})
payload = {
    "subject": "Contrato de servicios",
    "metadata": {"externalId": "PED-1234"},
    "documents": [{"file": "contrato"}],
    "recipients": [{"name": "Ana Pérez", "email": "ana@example.com"}],
    "fields": [{"recipient": 0, "type": "signature",
                "anchor": {"text": "[[firma]]", "offsetY": -40, "width": 150, "height": 40}}],
    "send": True,
}
with open("contrato.pdf", "rb") as f:
    r = requests.post(
        "${BASE}/v1/envelopes",
        headers={"Authorization": f"Bearer {os.environ['CALASIGN_API_KEY']}", "Idempotency-Key": "pedido-1234"},
        files={"payload": (None, json.dumps(payload), "application/json"),
               "contrato": ("contrato.pdf", f, "application/pdf")},
    )
if not r.ok:
    err = r.json()["error"]
    raise RuntimeError(f"{err['code']}: {err['message']}")
env = r.json()["envelope"]
print(env["id"], env["status"])  # "sent"`;

  const oneSdkPy = `import os
from calasign import CalaSign

cs = CalaSign(os.environ["CALASIGN_API_KEY"], base_url="${BASE}")

with open("contrato.pdf", "rb") as f:
    detail = cs.envelopes.create_and_send({  # ${c("qs.c.sdkIdem")}
        "subject": "Contrato de servicios",
        "metadata": {"externalId": "PED-1234"},
        "documents": [{"content": f.read(), "name": "contrato.pdf"}],
        "recipients": [{"name": "Ana Pérez", "email": "ana@example.com"}],
        "fields": [{"recipient": 0, "type": "signature",
                    "anchor": {"text": "[[firma]]", "offsetY": -40, "width": 150, "height": 40}}],
    })
print(detail["envelope"]["status"])  # "sent"`;

  const oneSdkNode = `import { readFile } from "node:fs/promises";
import { CalaSign } from "@calasign/sdk";

const cs = new CalaSign({ apiKey: process.env.CALASIGN_API_KEY, baseUrl: "${BASE}" });

// ${c("qs.c.sdkIdem")}
const { envelope } = await cs.envelopes.createAndSend({
  subject: "Contrato de servicios",
  metadata: { externalId: "PED-1234" },
  documents: [{ content: await readFile("contrato.pdf"), name: "contrato.pdf" }],
  recipients: [{ name: "Ana Pérez", email: "ana@example.com" }],
  fields: [{ recipient: 0, type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } }],
});
console.log(envelope.status); // "sent"`;

  const oneResponse = `{
  "envelope": {
    "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
    "subject": "Contrato de servicios",
    "status": "sent",
    "sentAt": "2026-10-18T14:30:01.000Z",
    "metadata": { "externalId": "PED-1234" },
    "…": "…"
  },
  "documents": [ { "id": "0192f3a4-…", "name": "contrato.pdf", "pageCount": 2, "sha256": "…", "…": "…" } ],
  "recipients": [ { "id": "0192f3a5-…", "name": "Ana Pérez", "email": "ana@example.com", "status": "sent", "…": "…" } ],
  "fields": [ { "id": "0192f3a5-…", "recipientId": "0192f3a5-…", "type": "signature", "page": 1, "x": 0.12, "y": 0.71, "…": "…" } ]
}`;

  const coordsExample = `{ "fields": [ { "recipient": 0, "document": 0, "type": "signature",
                "page": 0, "x": 0.55, "y": 0.82, "width": 0.3, "height": 0.06 } ] }`;

  const refsExample = `{
  "documents": [ { "ref": "contrato", "file": "contrato" }, { "ref": "anexo", "url": "https://tu-servidor.com/anexo.pdf" } ],
  "recipients": [
    { "ref": "cliente", "name": "Ana Pérez", "email": "ana@example.com", "routingOrder": 1 },
    { "ref": "empresa", "name": "Luis Gómez", "email": "luis@acme.com", "routingOrder": 2 },
    { "name": "Legales", "email": "legales@acme.com", "role": "cc" }
  ],
  "fields": [
    { "recipient": "cliente", "type": "signature", "anchor": { "text": "[[firma_cliente]]", "width": 150, "height": 40 } },
    { "recipient": "luis@acme.com", "type": "signature", "document": "anexo",
      "page": 0, "x": 0.55, "y": 0.82, "width": 0.3, "height": 0.06 }
  ],
  "send": true
}`;

  // ───────── Script completo (una llamada + esperar + descargar) ─────────

  const fullCurl = `export CALASIGN_API_KEY="cs_test_…"
BASE=${BASE}
AUTH="Authorization: Bearer $CALASIGN_API_KEY"

# ${c("qs.c.one")}
ENVELOPE_ID=$(curl -s -X POST "$BASE/v1/envelopes" -H "$AUTH" -H "Idempotency-Key: pedido-1234" \\
  -F 'payload={"subject":"Contrato de servicios","metadata":{"externalId":"PED-1234"},
      "documents":[{"file":"contrato"}],"recipients":[{"name":"Ana Pérez","email":"ana@example.com"}],
      "fields":[{"type":"signature","anchor":{"text":"[[firma]]","offsetY":-40,"width":150,"height":40}}],
      "send":true};type=application/json' \\
  -F "contrato=@contrato.pdf;type=application/pdf" | jq -r .envelope.id)
[ "$ENVELOPE_ID" != "null" ] || exit 1

# ${c("qs.c.wait")}
while :; do
  STATUS=$(curl -s "$BASE/v1/envelopes/$ENVELOPE_ID" -H "$AUTH" | jq -r .envelope.status)
  case "$STATUS" in
    completed) break ;;
    declined|voided|expired) echo "$STATUS" >&2; exit 1 ;;
  esac
  sleep 60
done

# ${c("qs.c.download")}
curl -s "$BASE/v1/envelopes/$ENVELOPE_ID/signed.pdf" -H "$AUTH" -o contrato-firmado.pdf`;

  const fullSdkNode = `import { readFile, writeFile } from "node:fs/promises";
import { CalaSign } from "@calasign/sdk";

const cs = new CalaSign({ apiKey: process.env.CALASIGN_API_KEY, baseUrl: "${BASE}" });

// ${c("qs.c.one")}
const { envelope } = await cs.envelopes.createAndSend({
  subject: "Contrato de servicios",
  metadata: { externalId: "PED-1234" },
  documents: [{ content: await readFile("contrato.pdf"), name: "contrato.pdf" }],
  recipients: [{ name: "Ana Pérez", email: "ana@example.com" }],
  fields: [{ recipient: 0, type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } }],
});

// ${c("qs.c.wait")}
let status = envelope.status;
while (status !== "completed") {
  if (["declined", "voided", "expired"].includes(status)) throw new Error(\`envelope \${status}\`);
  await new Promise((r) => setTimeout(r, 60_000));
  status = (await cs.envelopes.get(envelope.id)).envelope.status;
}

// ${c("qs.c.download")}
await writeFile("contrato-firmado.pdf", await cs.envelopes.downloadSigned(envelope.id));`;

  const fullSdkPy = `import os, time
from calasign import CalaSign

cs = CalaSign(os.environ["CALASIGN_API_KEY"], base_url="${BASE}")

# ${c("qs.c.one")}
with open("contrato.pdf", "rb") as f:
    env = cs.envelopes.create_and_send({
        "subject": "Contrato de servicios",
        "metadata": {"externalId": "PED-1234"},
        "documents": [{"content": f.read(), "name": "contrato.pdf"}],
        "recipients": [{"name": "Ana Pérez", "email": "ana@example.com"}],
        "fields": [{"recipient": 0, "type": "signature",
                    "anchor": {"text": "[[firma]]", "offsetY": -40, "width": 150, "height": 40}}],
    })["envelope"]

# ${c("qs.c.wait")}
status = env["status"]
while status != "completed":
    if status in ("declined", "voided", "expired"):
        raise RuntimeError(f"envelope {status}")
    time.sleep(60)
    status = cs.envelopes.get(env["id"])["envelope"]["status"]

# ${c("qs.c.download")}
with open("contrato-firmado.pdf", "wb") as out:
    out.write(cs.envelopes.download_signed(env["id"]))`;

  // ───────── Paso a paso (secundario) ─────────

  const createResponse = `{
  "envelope": {
    "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
    "subject": "Contrato de servicios",
    "status": "draft",
    "createdVia": "api",
    "locale": "es",
    "expiresAt": "2026-11-17T14:30:00.000Z",
    "metadata": { "externalId": "PED-1234" },
    "…": "…"
  },
  "documents": [],
  "recipients": [],
  "fields": []
}`;

  return (
    <DocPage title={t("qs.title")} lead={t("qs.lead")}>
      <H2 id="api-key">{t("qs.key.h")}</H2>
      <Md text={t("qs.key.p")} />
      <Code lang="bash" code={`export CALASIGN_API_KEY="cs_test_…"`} />

      <H2 id="one-call">{t("qs.one.h")}</H2>
      <Md text={t("qs.one.p")} />
      <CodeTabs
        tabs={[
          { id: "curl", label: "curl", lang: "bash", code: oneCurl },
          { id: "curl-multipart", label: "curl (multipart)", lang: "bash", code: oneMultipart },
          { id: "node", label: "Node.js", lang: "js", code: oneNode },
          { id: "python", label: "Python", lang: "python", code: onePy },
          sdkPy(oneSdkPy),
          sdkNode(oneSdkNode),
        ]}
      />
      <Md text={t("qs.one.resp")} />
      <Code lang="json" code={oneResponse} title="201 Created" />
      <Callout kind="tip" title={t("qs.one.multipart.t")}>
        {t("qs.one.multipart.p")}
      </Callout>

      <H3 id="references">{t("qs.one.refs.t")}</H3>
      <Md text={t("qs.one.refs.p")} />
      <Code lang="json" code={refsExample} />
      <Callout kind="tip" title={t("qs.fields.coords.t")}>
        {t("qs.fields.coords.p")}
      </Callout>
      <Code lang="json" code={coordsExample} />

      <H3 id="embedded">{t("qs.one.embedded.t")}</H3>
      <Md text={t("qs.one.embedded.p")} />

      <H3 id="from-template">{t("qs.one.template.t")}</H3>
      <Md text={t("qs.one.template.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/from-template",
          idempotencyKey: "pedido-1234",
          body: {
            templateId: "TEMPLATE_ID",
            subject: "NDA – ACME",
            recipients: [{ role: "Cliente", name: "Ana Pérez", email: "ana@example.com" }],
            prefill: { Empresa: "ACME S.A." },
            send: true,
          },
          extra: [
            sdkPy(`cs.envelopes.from_template({"templateId": template_id, "subject": "NDA – ACME", "send": True,\n    "recipients": [{"role": "Cliente", "name": "Ana Pérez", "email": "ana@example.com"}]})`),
            sdkNode(`await cs.envelopes.fromTemplate({ templateId, subject: "NDA – ACME", send: true,\n  recipients: [{ role: "Cliente", name: "Ana Pérez", email: "ana@example.com" }] });`),
          ],
        })}
      />

      <H2 id="wait">{t("qs.wait.h")}</H2>
      <Md text={t("qs.wait.p")} />
      <Code
        lang="json"
        title="POST https://tu-servidor.com/webhooks/calasign"
        code={`{
  "id": "0192f3b0-0000-7000-8000-000000000001",
  "type": "envelope.completed",
  "createdAt": "2026-10-18T15:02:11.000Z",
  "tenantId": "0192e000-…",
  "data": {
    "envelope": {
      "id": "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
      "subject": "Contrato de servicios",
      "status": "completed",
      "metadata": { "externalId": "PED-1234" },
      "signedSha256": "9f2c…",
      "recipients": [ { "id": "…", "name": "Ana Pérez", "status": "signed", "role": "signer", "routingOrder": 1, "email": "ana@example.com" } ],
      "…": "…"
    },
    "recipientId": null,
    "reason": null
  }
}`}
      />

      <H2 id="download">{t("qs.download.h")}</H2>
      <Md text={t("qs.download.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "GET",
          path: "/v1/envelopes/{envelopeId}/signed.pdf",
          saveAs: "contrato-firmado.pdf",
          extra: [sdkPy(`open("contrato-firmado.pdf", "wb").write(cs.envelopes.download_signed(envelope_id))`)],
        })}
      />

      <H2 id="full-script">{t("qs.full.h")}</H2>
      <Md text={t("qs.full.p")} />
      <CodeTabs
        tabs={[{ id: "curl", label: "curl + jq", lang: "bash", code: fullCurl }, sdkPy(fullSdkPy), sdkNode(fullSdkNode)]}
      />
      <Md text={t("qs.full.next")} />

      <H2 id="step-by-step">{t("qs.steps.h")}</H2>
      <Md text={t("qs.steps.p")} />

      <H3 id="create">{t("qs.create.h")}</H3>
      <Md text={t("qs.create.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes",
          idempotencyKey: "pedido-1234",
          body: { subject: "Contrato de servicios", message: "Hola Ana, te comparto el contrato para firmar.", metadata: { externalId: "PED-1234" } },
          extra: [
            sdkPy(`detail = cs.envelopes.create({"subject": "Contrato de servicios", "metadata": {"externalId": "PED-1234"}})\nenvelope_id = detail["envelope"]["id"]`),
            sdkNode(`const { envelope } = await cs.envelopes.create({ subject: "Contrato de servicios", metadata: { externalId: "PED-1234" } });`),
          ],
        })}
      />
      <Md text={t("qs.create.resp")} />
      <Code lang="json" code={createResponse} title="201 Created" />

      <H3 id="upload">{t("qs.upload.h")}</H3>
      <Md text={t("qs.upload.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/documents",
          multipart: { field: "file", file: "contrato.pdf" },
          extra: [sdkPy(`doc = cs.envelopes.upload_document(envelope_id, open("contrato.pdf", "rb").read(), "contrato.pdf")`)],
        })}
      />

      <H3 id="recipients">{t("qs.recipients.h")}</H3>
      <Md text={t("qs.recipients.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "PUT",
          path: "/v1/envelopes/{envelopeId}/recipients",
          body: { recipients: [{ name: "Ana Pérez", email: "ana@example.com", phone: "+5491122334455", channels: ["email", "whatsapp"], routingOrder: 1 }] },
          extra: [sdkPy(`detail = cs.envelopes.set_recipients(envelope_id, [\n    {"name": "Ana Pérez", "email": "ana@example.com", "channels": ["email"]},\n])\nrecipient_id = detail["recipients"][0]["id"]`)],
        })}
      />

      <H3 id="fields">{t("qs.fields.h")}</H3>
      <Md text={t("qs.fields.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "PUT",
          path: "/v1/envelopes/{envelopeId}/fields",
          body: {
            fields: [
              { recipientId: "RECIPIENT_ID", type: "signature", anchor: ANCHOR },
              { recipientId: "RECIPIENT_ID", type: "date_signed", anchor: { text: "[[fecha]]", width: 90, height: 14, ignoreIfNotPresent: true } },
            ],
          },
        })}
      />

      <H3 id="send">{t("qs.send.h")}</H3>
      <Md text={t("qs.send.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/send",
          idempotencyKey: "envio-PED-1234",
          extra: [sdkPy(`cs.envelopes.send(envelope_id)`)],
        })}
      />
    </DocPage>
  );
}
