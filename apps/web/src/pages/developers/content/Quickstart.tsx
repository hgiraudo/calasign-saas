import { useDocsText } from "../../../lib/i18n-docs";
import { BASE } from "../constants";
import { apiTabs, sdkNode, sdkPy } from "../samples";
import { Callout, Code, CodeTabs, DocPage, H2, Md } from "../ui";

const ANCHOR = { text: "[[firma]]", offsetY: -40, width: 150, height: 40 };

export function QuickstartPage() {
  const t = useDocsText();
  const c = (k: Parameters<typeof t>[0]) => t(k);

  const curlScript = `export CALASIGN_API_KEY="cs_test_…"
BASE=${BASE}
AUTH="Authorization: Bearer $CALASIGN_API_KEY"

# ${c("qs.c.create")}
ENVELOPE_ID=$(curl -s -X POST "$BASE/v1/envelopes" -H "$AUTH" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: pedido-1234" \\
  -d '{"subject":"Contrato de servicios","metadata":{"externalId":"PED-1234"}}' | jq -r .envelope.id)

# ${c("qs.c.upload")}
curl -s -X POST "$BASE/v1/envelopes/$ENVELOPE_ID/documents" -H "$AUTH" -F file=@contrato.pdf > /dev/null

# ${c("qs.c.recipient")}
RECIPIENT_ID=$(curl -s -X PUT "$BASE/v1/envelopes/$ENVELOPE_ID/recipients" -H "$AUTH" \\
  -H "Content-Type: application/json" \\
  -d '{"recipients":[{"name":"Ana Pérez","email":"ana@example.com"}]}' | jq -r '.recipients[0].id')

# ${c("qs.c.fields")}
curl -s -X PUT "$BASE/v1/envelopes/$ENVELOPE_ID/fields" -H "$AUTH" -H "Content-Type: application/json" \\
  -d '{"fields":[{"recipientId":"'"$RECIPIENT_ID"'","type":"signature",
       "anchor":{"text":"[[firma]]","offsetY":-40,"width":150,"height":40}}]}' > /dev/null

# ${c("qs.c.send")}
curl -s -X POST "$BASE/v1/envelopes/$ENVELOPE_ID/send" -H "$AUTH" \\
  -H "Idempotency-Key: envio-PED-1234" | jq -r .envelope.status   # sent`;

  const nodeScript = `import { readFile } from "node:fs/promises";

const BASE = "${BASE}";

async function api(method, path, body, headers = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: \`Bearer \${process.env.CALASIGN_API_KEY}\`,
      ...(body && !isForm ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(\`\${data.error.code}: \${data.error.message}\`);
  return data;
}

// ${c("qs.c.create")}
const { envelope } = await api("POST", "/v1/envelopes",
  { subject: "Contrato de servicios", metadata: { externalId: "PED-1234" } },
  { "Idempotency-Key": "pedido-1234" });

// ${c("qs.c.upload")}
const form = new FormData();
form.append("file", new Blob([await readFile("contrato.pdf")], { type: "application/pdf" }), "contrato.pdf");
await api("POST", \`/v1/envelopes/\${envelope.id}/documents\`, form);

// ${c("qs.c.recipient")}
const { recipients } = await api("PUT", \`/v1/envelopes/\${envelope.id}/recipients\`, {
  recipients: [{ name: "Ana Pérez", email: "ana@example.com" }],
});

// ${c("qs.c.fields")}
await api("PUT", \`/v1/envelopes/\${envelope.id}/fields\`, {
  fields: [{ recipientId: recipients[0].id, type: "signature",
             anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } }],
});

// ${c("qs.c.send")}
const sent = await api("POST", \`/v1/envelopes/\${envelope.id}/send\`, undefined,
  { "Idempotency-Key": \`envio-\${envelope.id}\` });
console.log(sent.envelope.status); // "sent"`;

  const pyScript = `import os
import requests

BASE = "${BASE}"
s = requests.Session()
s.headers["Authorization"] = f"Bearer {os.environ['CALASIGN_API_KEY']}"

def api(method, path, **kw):
    r = s.request(method, BASE + path, **kw)
    if not r.ok:
        err = r.json()["error"]
        raise RuntimeError(f"{err['code']}: {err['message']}")
    return r.json() if r.content else None

# ${c("qs.c.create")}
env = api("POST", "/v1/envelopes",
          json={"subject": "Contrato de servicios", "metadata": {"externalId": "PED-1234"}},
          headers={"Idempotency-Key": "pedido-1234"})["envelope"]

# ${c("qs.c.upload")}
with open("contrato.pdf", "rb") as f:
    api("POST", f"/v1/envelopes/{env['id']}/documents", files={"file": ("contrato.pdf", f, "application/pdf")})

# ${c("qs.c.recipient")}
recipients = api("PUT", f"/v1/envelopes/{env['id']}/recipients",
                 json={"recipients": [{"name": "Ana Pérez", "email": "ana@example.com"}]})["recipients"]

# ${c("qs.c.fields")}
api("PUT", f"/v1/envelopes/{env['id']}/fields", json={"fields": [{
    "recipientId": recipients[0]["id"], "type": "signature",
    "anchor": {"text": "[[firma]]", "offsetY": -40, "width": 150, "height": 40},
}]})

# ${c("qs.c.send")}
sent = api("POST", f"/v1/envelopes/{env['id']}/send", headers={"Idempotency-Key": f"envio-{env['id']}"})
print(sent["envelope"]["status"])  # "sent"`;

  const sdkPyScript = `import os
from calasign import CalaSign

cs = CalaSign(os.environ["CALASIGN_API_KEY"], base_url="${BASE}")

env = cs.envelopes.create({"subject": "Contrato de servicios", "metadata": {"externalId": "PED-1234"}})["envelope"]
with open("contrato.pdf", "rb") as f:
    cs.envelopes.upload_document(env["id"], f.read(), "contrato.pdf")
detail = cs.envelopes.set_recipients(env["id"], [{"name": "Ana Pérez", "email": "ana@example.com"}])
cs.envelopes.set_fields(env["id"], [{
    "recipientId": detail["recipients"][0]["id"], "type": "signature",
    "anchor": {"text": "[[firma]]", "offsetY": -40, "width": 150, "height": 40},
}])
cs.envelopes.send(env["id"])  # ${c("qs.c.sdkIdem")}`;

  const sdkNodeScript = `import { readFile } from "node:fs/promises";
import { CalaSign } from "@calasign/sdk";

const cs = new CalaSign({ apiKey: process.env.CALASIGN_API_KEY, baseUrl: "${BASE}" });

const { envelope } = await cs.envelopes.create({ subject: "Contrato de servicios", metadata: { externalId: "PED-1234" } });
await cs.envelopes.uploadDocument(envelope.id, await readFile("contrato.pdf"), "contrato.pdf");
const { recipients } = await cs.envelopes.setRecipients(envelope.id, [{ name: "Ana Pérez", email: "ana@example.com" }]);
await cs.envelopes.setFields(envelope.id, [
  { recipientId: recipients[0].id, type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } },
]);
await cs.envelopes.send(envelope.id); // ${c("qs.c.sdkIdem")}`;

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

      <H2 id="create">{t("qs.create.h")}</H2>
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

      <H2 id="upload">{t("qs.upload.h")}</H2>
      <Md text={t("qs.upload.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/documents",
          multipart: { field: "file", file: "contrato.pdf" },
          extra: [sdkPy(`doc = cs.envelopes.upload_document(envelope_id, open("contrato.pdf", "rb").read(), "contrato.pdf")`)],
        })}
      />

      <H2 id="recipients">{t("qs.recipients.h")}</H2>
      <Md text={t("qs.recipients.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "PUT",
          path: "/v1/envelopes/{envelopeId}/recipients",
          body: { recipients: [{ name: "Ana Pérez", email: "ana@example.com", phone: "+5491122334455", channels: ["email", "whatsapp"], routingOrder: 1 }] },
          extra: [sdkPy(`detail = cs.envelopes.set_recipients(envelope_id, [\n    {"name": "Ana Pérez", "email": "ana@example.com", "channels": ["email"]},\n])\nrecipient_id = detail["recipients"][0]["id"]`)],
        })}
      />

      <H2 id="fields">{t("qs.fields.h")}</H2>
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
      <Callout kind="tip" title={t("qs.fields.coords.t")}>
        {t("qs.fields.coords.p")}
      </Callout>
      <Code
        lang="json"
        code={`{ "fields": [ { "documentId": "DOCUMENT_ID", "recipientId": "RECIPIENT_ID", "type": "signature",
                "page": 0, "x": 0.55, "y": 0.82, "width": 0.3, "height": 0.06 } ] }`}
      />

      <H2 id="send">{t("qs.send.h")}</H2>
      <Md text={t("qs.send.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/send",
          idempotencyKey: "envio-PED-1234",
          extra: [sdkPy(`cs.envelopes.send(envelope_id)`)],
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
        tabs={[
          { id: "curl", label: "curl + jq", lang: "bash", code: curlScript },
          { id: "node", label: "Node.js", lang: "js", code: nodeScript },
          { id: "python", label: "Python", lang: "python", code: pyScript },
          sdkPy(sdkPyScript),
          sdkNode(sdkNodeScript),
        ]}
      />
      <Md text={t("qs.full.next")} />
    </DocPage>
  );
}
