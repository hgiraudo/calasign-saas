import { useDocsText } from "../../../lib/i18n-docs";
import { BASE, SDK_INSTALL } from "../constants";
import { Callout, Code, CodeTabs, DataTable, DocPage, H2, H3, Md } from "../ui";

export function SdksPage() {
  const t = useDocsText();
  const py = `import os
from calasign import CalaSign, CalaSignError, ClientCredentials

cs = CalaSign(os.environ["CALASIGN_API_KEY"], base_url="${BASE}")
# CalaSign(access_token="csat_…")                                   # OAuth (authorization code)
# CalaSign(oauth=ClientCredentials("csapp_…", "cssec_…", scope="envelopes:read envelopes:write"))

try:
    # Sobre completo y enviado en UNA llamada (atómica, con Idempotency-Key automática).
    with open("contrato.pdf", "rb") as f:
        detail = cs.envelopes.create_and_send({
            "subject": "Contrato de servicios",
            "documents": [{"content": f.read(), "name": "contrato.pdf"}],
            "recipients": [{"name": "Ana Pérez", "email": "ana@example.com"}],
            "fields": [{"type": "signature", "anchor": {"text": "[[firma]]", "width": 150, "height": 40}}],
        })
    # Desde una plantilla, también en una llamada:
    cs.envelopes.from_template({
        "templateId": template_id, "send": True,
        "recipients": [{"role": "Cliente", "name": "Ana Pérez", "email": "ana@example.com"}],
    })
except CalaSignError as e:
    print(e.status, e.code, e.details)

for e in cs.envelopes.iterate(status="completed"):
    pdf = cs.envelopes.download_signed(e["id"])

me = cs.request("GET", "/v1/me")  # ${t("sdk.c.any")}`;

  const node = `import { readFile } from "node:fs/promises";
import { CalaSign, CalaSignError } from "@calasign/sdk";

const cs = new CalaSign({ apiKey: process.env.CALASIGN_API_KEY, baseUrl: "${BASE}" });
// new CalaSign({ oauth: { clientId, clientSecret, scope }, baseUrl })   // client credentials
// new CalaSign({ accessToken, baseUrl })                                // authorization code

try {
  // Sobre completo y enviado en UNA llamada (atómica, con Idempotency-Key automática).
  const { envelope } = await cs.envelopes.createAndSend({
    subject: "Contrato de servicios",
    documents: [{ content: await readFile("contrato.pdf"), name: "contrato.pdf" }],
    recipients: [{ name: "Ana Pérez", email: "ana@example.com" }],
    fields: [{ type: "signature", anchor: { text: "[[firma]]", width: 150, height: 40 } }],
  });
  // Desde una plantilla, también en una llamada:
  await cs.envelopes.fromTemplate({
    templateId,
    send: true,
    recipients: [{ role: "Cliente", name: "Ana Pérez", email: "ana@example.com" }],
  });
} catch (e) {
  if (e instanceof CalaSignError) console.error(e.status, e.code, e.details);
  else throw e;
}

for await (const e of cs.envelopes.iterate({ status: "completed" })) {
  const pdf = await cs.envelopes.downloadSigned(e.id); // Uint8Array
}

const me = await cs.request("GET", "/v1/me"); // ${t("sdk.c.any")}`;

  const methods: [string, string, string][] = [
    ["envelopes.create_and_send(data)", "envelopes.createAndSend(input)", "POST /v1/envelopes (send: true)"],
    ["envelopes.create(data)", "envelopes.create(input)", "POST /v1/envelopes"],
    ["envelopes.from_template(data)", "envelopes.fromTemplate(input)", "POST /v1/envelopes/from-template"],
    ["envelopes.upload_document(id, bytes, name)", "envelopes.uploadDocument(id, bytes, name)", "POST /v1/envelopes/{id}/documents"],
    ["envelopes.set_recipients(id, list)", "envelopes.setRecipients(id, list)", "PUT /v1/envelopes/{id}/recipients"],
    ["envelopes.set_fields(id, list)", "envelopes.setFields(id, list)", "PUT /v1/envelopes/{id}/fields"],
    ["envelopes.send(id)", "envelopes.send(id)", "POST /v1/envelopes/{id}/send"],
    ["envelopes.get / list / iterate", "envelopes.get / list / iterate", "GET /v1/envelopes…"],
    ["envelopes.void(id, reason)", "envelopes.void(id, reason)", "POST /v1/envelopes/{id}/void"],
    ["envelopes.remind(id)", "envelopes.remind(id)", "POST /v1/envelopes/{id}/remind"],
    ["envelopes.events(id)", "envelopes.events(id)", "GET /v1/envelopes/{id}/events"],
    ["envelopes.download_signed(id)", "envelopes.downloadSigned(id)", "GET /v1/envelopes/{id}/signed.pdf"],
    ["envelopes.signing_url(id, rid)", "envelopes.signingUrl(id, rid)", "POST …/signing-url"],
    ["templates.list / get", "templates.list / get", "GET /v1/templates…"],
    ["webhooks.list / create / delete / test", "webhooks.list / create / update / delete / deliveries / test", "/v1/webhooks…"],
    ["construct_event(body, header, secret)", "constructWebhookEvent({ payload, header, secret })", t("sdk.m.verify")],
  ];

  return (
    <DocPage title={t("sdk.title")} lead={t("sdk.lead")}>
      <Callout kind="info">{t("sdk.notPublished")}</Callout>
      <DataTable
        head={[t("sdk.col.feature"), "Python", "Node.js"]}
        rows={[
          [t("sdk.f.deps"), t("sdk.f.py.deps"), t("sdk.f.node.deps")],
          [t("sdk.f.auth"), "api_key · access_token · ClientCredentials", "apiKey · accessToken · oauth"],
          [t("sdk.f.retries"), t("sdk.f.retries.v"), t("sdk.f.retries.v")],
          [t("sdk.f.idem"), "create · send", "create · send"],
          [t("sdk.f.errors"), "CalaSignError(status, code, details)", "CalaSignError(status, code, details)"],
        ]}
      />

      <H2 id="python">{t("sdk.py.h")}</H2>
      <Code lang="bash" code={SDK_INSTALL.python} title={t("sdk.install")} />
      <Code lang="python" code={py} />

      <H2 id="node">{t("sdk.node.h")}</H2>
      <Code lang="bash" code={SDK_INSTALL.node} title={t("sdk.install")} />
      <Code lang="ts" code={node} />
      <H3 id="methods">{t("sdk.methods.h")}</H3>
      <DataTable head={["Python", "Node.js", "API"]} rows={methods.map(([a, b, c]) => [<code key="a">{a}</code>, <code key="b">{b}</code>, <code key="c">{c}</code>])} />

      <H2 id="openapi">{t("sdk.openapi.h")}</H2>
      <Md text={t("sdk.openapi.p")} />
      <CodeTabs
        tabs={[
          { id: "ts", label: "TypeScript", lang: "bash", code: `npx openapi-typescript ${BASE}/v1/openapi.json -o calasign.d.ts` },
          { id: "java", label: "Java / C# / Go / PHP", lang: "bash", code: `npx @openapitools/openapi-generator-cli generate \\\n  -i ${BASE}/v1/openapi.json \\\n  -g java \\\n  -o ./calasign-client        # csharp, go, php, ruby, kotlin…` },
          { id: "postman", label: "Postman / Insomnia", lang: "text", code: `${t("sdk.openapi.import")}\n${BASE}/v1/openapi.json` },
        ]}
      />
    </DocPage>
  );
}
