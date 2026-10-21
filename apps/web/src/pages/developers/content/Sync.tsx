// Guía "Sincronización y operaciones avanzadas": búsqueda avanzada, API de eventos (polling y SSE), datos de
// formulario, clonado, lote y rotación del secreto de webhooks. Textos en lib/i18n-docs-api.ts.
import { useDocsText } from "../../../lib/i18n-docs";
import { apiTabs, sdkNode, sdkPy } from "../samples";
import { Callout, Code, CodeTabs, DocPage, H2, Md } from "../ui";

const SSE_BROWSER = `// En el navegador, EventSource no manda headers: pedí el stream desde tu backend
// (con la API key) y reenvialo, o usá fetch con un lector de streams:
const res = await fetch(\`\${BASE}/v1/events/stream?types=envelope.completed\`, {
  headers: { authorization: \`Bearer \${process.env.CALASIGN_KEY}\`, "last-event-id": savedCursor ?? "" },
});
const reader = res.body.getReader();
const decoder = new TextDecoder(); // stream: true no corta un carácter UTF-8 partido entre dos lecturas
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break; // se cerró (max_seconds): reconectar con el último id
  buf += decoder.decode(value, { stream: true });
  const blocks = buf.split("\\n\\n");
  buf = blocks.pop();
  for (const b of blocks) {
    const lines = b.split("\\n");
    if (lines.includes("event: end")) continue; // aviso de cierre ({"reason":"max_seconds"}), no es un evento
    const data = lines.find((l) => l.startsWith("data: "));
    if (data) handle(JSON.parse(data.slice(6))); // ApiEvent; guardá ev.cursor
  }
}`;

const VERIFY_MANUAL = `import hmac, hashlib

def valid(header: str, body: bytes, secret: str) -> bool:
    parts = [p.split("=", 1) for p in header.split(",")]
    t = next(v for k, v in parts if k == "t")
    expected = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    # Durante una rotación llegan dos v1: vale si coincide cualquiera.
    return any(hmac.compare_digest(expected, v) for k, v in parts if k == "v1")`;

export function SyncGuide() {
  const t = useDocsText();
  return (
    <DocPage title={t("g.sync.title")} lead={t("g.sync.lead")}>
      <H2 id="search">{t("g.sync.search.h")}</H2>
      <Md text={t("g.sync.search.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "GET",
          path: "/v1/envelopes",
          query: { updated_from: "2026-10-01T00:00:00Z", "metadata[orderId]": "ORD-1001", status: "completed" },
          extra: [
            sdkPy(`page = cs.envelopes.list(updated_from=last_sync, metadata={"orderId": "ORD-1001"}, status="completed")`),
            sdkNode(`const page = await cs.envelopes.list({ updatedFrom: lastSync, metadata: { orderId: "ORD-1001" }, status: "completed" });`),
          ],
        })}
      />

      <H2 id="events">{t("g.sync.events.h")}</H2>
      <Md text={t("g.sync.events.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "GET",
          path: "/v1/events",
          query: { after: "CURSOR", types: "envelope.completed,recipient.signed" },
          extra: [
            sdkPy(`for ev in cs.events.poll(after=load_cursor(), types=["envelope.completed"]):
    handle(ev)
    save_cursor(ev["cursor"])`),
            sdkNode(`for await (const ev of cs.events.poll({ after: await loadCursor(), types: ["envelope.completed"] })) {
  await handle(ev);
  await saveCursor(ev.cursor);
}`),
          ],
        })}
      />
      <Callout kind="tip">{t("g.sync.events.note")}</Callout>
      <Callout kind="warn">
        <Md text={t("g.sync.events.ids")} />
      </Callout>

      <H2 id="stream">{t("g.sync.stream.h")}</H2>
      <Md text={t("g.sync.stream.p")} />
      <Code lang="ts" title="GET /v1/events/stream" code={SSE_BROWSER} />

      <H2 id="form-data">{t("g.sync.form.h")}</H2>
      <Md text={t("g.sync.form.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "GET",
          path: "/v1/envelopes/{envelopeId}/form-data",
          extra: [
            sdkPy(`data = cs.envelopes.form_data(envelope_id)
empresa = data["values"].get("Empresa")
pdf = cs.envelopes.download_attachment(envelope_id, field_id)`),
            sdkNode(`const data = await cs.envelopes.formData(envelopeId);
const empresa = data.values["Empresa"];
const { bytes, contentType } = await cs.envelopes.downloadAttachment(envelopeId, fieldId);`),
          ],
        })}
      />

      <H2 id="clone">{t("g.sync.clone.h")}</H2>
      <Md text={t("g.sync.clone.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/{envelopeId}/clone",
          body: { subject: "Renovación — Contrato 2027", metadata: { contractId: "C-2027-0042" }, includeValues: false },
          extra: [
            sdkPy(`draft = cs.envelopes.clone(envelope_id, {"subject": "Renovación — Contrato 2027"})`),
            sdkNode(`const draft = await cs.envelopes.clone(envelopeId, { subject: "Renovación — Contrato 2027" });`),
          ],
        })}
      />

      <H2 id="batch">{t("g.sync.batch.h")}</H2>
      <Md text={t("g.sync.batch.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/envelopes/batch",
          body: { action: "void", ids: ["ENVELOPE_ID_1", "ENVELOPE_ID_2"], reason: "Campaña cancelada" },
          extra: [
            sdkPy(`res = cs.envelopes.batch("remind", ids)
failed = [r for r in res["results"] if not r["ok"]]`),
            sdkNode(`const res = await cs.envelopes.batch({ action: "remind", ids });
const failed = res.results.filter((r) => !r.ok);`),
          ],
        })}
      />

      <H2 id="rotate-secret">{t("g.sync.rotate.h")}</H2>
      <Md text={t("g.sync.rotate.p")} />
      <CodeTabs
        tabs={apiTabs({
          method: "POST",
          path: "/v1/webhooks/{webhookId}/rotate-secret",
          body: { graceHours: 24 },
          extra: [
            sdkPy(`new_secret = cs.webhooks.rotate_secret(webhook_id, grace_hours=24)["secret"]`),
            sdkNode(`const { secret } = await cs.webhooks.rotateSecret(webhookId, { graceHours: 24 });`),
          ],
        })}
      />
      <Code lang="python" title="CalaSign-Signature: t=…,v1=…,v1=…" code={VERIFY_MANUAL} />
    </DocPage>
  );
}
