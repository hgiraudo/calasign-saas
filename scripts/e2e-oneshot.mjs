#!/usr/bin/env node
// Prueba de punta a punta del sobre completo en UNA llamada (POST /v1/envelopes con documentos, destinatarios, campos y
// send): JSON con base64, multipart/form-data con varios PDF, documento por URL (solo contra una API local), anclas,
// refs por posición/ref/email, firmante embebido con su URL de firma en la respuesta, Idempotency-Key (también en
// multipart), atomicidad (PDF inválido, ancla que no aparece, sobre incompleto, parte faltante: no queda nada),
// compatibilidad con el borrador vacío de siempre, plantilla + envío en una llamada con Idempotency-Key, la herramienta
// MCP create_envelope con send + confirm, y que el firmante pueda completar la firma.
// Uso: node scripts/e2e-oneshot.mjs [baseUrl]   (requiere el buzón de desarrollo)
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
const stamp = Date.now();
const ok = (m) => console.log(`✓ ${m}`);
function assert(c, m) {
  if (!c) throw new Error(`FALLÓ: ${m}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
let key = null;
/** Pedido a la API. Con `key` usa la API key (como un integrador); si no, la sesión. Devuelve { status, data, headers }. */
async function call(method, path, body, { headers = {}, session = false } = {}) {
  const h = { ...headers };
  if (key && !session) h.authorization = `Bearer ${key}`;
  else if (cookie) h.cookie = cookie;
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set && !h.authorization) cookie = set.split(";")[0];
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
async function api(method, path, body, opts) {
  const r = await call(method, path, body, opts);
  if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}

function pdf(lines) {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = lines.map(([t, y]) => `BT /F1 14 Tf 72 ${y} Td (${t}) Tj ET`).join("\n");
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const contract = pdf([
  ["Contrato de servicios E2E", 760],
  ["Firma del cliente: [[firma]]", 300],
  ["Firma del proveedor: [[firma2]]", 200],
]);
const annex = pdf([["Anexo E2E", 760]]);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function linkFor(name) {
  for (let i = 0; i < 60; i++) {
    const { items } = await api("GET", "/dev/mailbox", undefined, { session: true });
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1].split("?")[0];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

/** Sobres de la cuenta con ese asunto (para verificar que un pedido fallido no dejó nada). */
async function countBySubject(subject) {
  const { items } = await api("GET", `/v1/envelopes?q=${encodeURIComponent(subject)}&limit=100`);
  return items.filter((e) => e.subject === subject).length;
}

// ───────── Cuenta y API key ─────────
await api("POST", "/v1/auth/signup", {
  name: "Oscar Oneshot",
  email: `oneshot+${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `Oneshot ${stamp}`,
  locale: "es",
});
await api("PATCH", "/v1/settings/embed", { frameAncestors: ["http://localhost:5199"] }, { session: true });
const created = await api("POST", "/v1/api-keys", { name: "e2e oneshot" }, { session: true });
key = created.secret;
ok("alta de cuenta, orígenes embebidos y API key");

// ───────── 1. Compatibilidad: el borrador vacío de siempre ─────────
{
  const r = await call("POST", "/v1/envelopes", { subject: `Vacío ${stamp}` });
  assert(r.status === 201 && r.data.envelope.status === "draft" && r.data.documents.length === 0 && !("signingUrls" in r.data), `borrador vacío: ${JSON.stringify(r.data).slice(0, 200)}`);
  ok("POST /v1/envelopes sin agregados: borrador vacío (formato de siempre)");
}

// ───────── 2. JSON + base64, anclas, refs, embebido y envío en UNA llamada ─────────
const subject1 = `Oneshot JSON ${stamp}`;
const body1 = {
  subject: subject1,
  message: "Hola, te comparto el contrato.",
  metadata: { externalId: `PED-${stamp}` },
  documents: [{ ref: "contrato", name: "contrato.pdf", base64: contract.toString("base64") }],
  recipients: [
    { ref: "cliente", name: `Cliente ${stamp}`, email: `cliente+${stamp}@example.com` },
    { ref: "app", name: `Embebido ${stamp}`, embedded: true },
    { name: `Copia ${stamp}`, email: `copia+${stamp}@example.com`, role: "cc" },
  ],
  fields: [
    { recipient: "cliente", type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } },
    { recipient: `cliente+${stamp}@example.com`, type: "date_signed", document: "contrato", anchor: { text: "[[firma]]", offsetX: 160, width: 90, height: 14 } },
    { recipient: 1, type: "signature", anchor: { text: "[[firma2]]", offsetY: -40, width: 150, height: 40 } },
    { recipient: 1, type: "text", label: "Comentario", required: false, page: 0, x: 0.1, y: 0.05, width: 0.3, height: 0.03 },
  ],
  send: true,
  embeddedSigning: { returnUrl: "http://localhost:5199/listo", frameAncestors: ["http://localhost:5199"] },
};
const idem1 = `oneshot-${stamp}`;
const r1 = await call("POST", "/v1/envelopes", body1, { headers: { "Idempotency-Key": idem1 } });
assert(r1.status === 201, `sobre completo: ${r1.status} ${JSON.stringify(r1.data).slice(0, 400)}`);
const d1 = r1.data;
assert(d1.envelope.status === "sent", `queda enviado: ${d1.envelope.status}`);
assert(d1.documents.length === 1 && d1.documents[0].name === "contrato.pdf", "un documento con su nombre");
assert(d1.recipients.length === 3 && d1.recipients.every((r) => r.id), "tres destinatarios con id");
const cliente = d1.recipients.find((r) => r.name === `Cliente ${stamp}`);
const embebido = d1.recipients.find((r) => r.name === `Embebido ${stamp}`);
assert(cliente.status === "sent" && embebido.status === "sent" && embebido.embedded, `destinatarios activos: ${JSON.stringify(d1.recipients.map((r) => [r.name, r.status]))}`);
assert(d1.fields.length === 4 && d1.fields.every((f) => f.id && f.documentId === d1.documents[0].id), "cuatro campos con id en el documento");
assert(d1.fields.filter((f) => f.recipientId === cliente.id).length === 2 && d1.fields.filter((f) => f.recipientId === embebido.id).length === 2, "campos asignados por ref, email y posición");
const sigCliente = d1.fields.find((f) => f.recipientId === cliente.id && f.type === "signature");
assert(sigCliente.y > 0.5 && sigCliente.y < 0.75, `el ancla ubicó la firma cerca del texto (y=${sigCliente.y})`);
assert(Array.isArray(d1.signingUrls) && d1.signingUrls.length === 1 && d1.signingUrls[0].recipientId === embebido.id, `URL de firma del embebido: ${JSON.stringify(d1.signingUrls)}`);
assert(/\/embed\/[A-Za-z0-9_-]+$/.test(d1.signingUrls[0].url) && d1.signingUrls[0].expiresAt, "URL embebida de un solo uso");
ok("JSON + base64: documento, 3 destinatarios, 4 campos (anclas y coordenadas) y envío en UNA llamada");

// La URL embebida funciona (redirige a la ceremonia del firmante).
{
  const code = d1.signingUrls[0].url.split("/embed/")[1];
  const res = await fetch(`${BASE}/embed/${code}`, { redirect: "manual" });
  assert(res.status === 302 && /\/s\/[^?]+\?embed=1/.test(res.headers.get("location") ?? ""), `/embed redirige a la ceremonia (HTTP ${res.status})`);
  ok("la URL de firma embebida de la respuesta abre la ceremonia");
}

// Idempotencia: mismo cuerpo y clave → la misma respuesta, sin otro sobre; otro cuerpo → 409.
{
  const again = await call("POST", "/v1/envelopes", body1, { headers: { "Idempotency-Key": idem1 } });
  assert(again.status === 201 && again.headers.get("idempotent-replay") === "true" && again.data.envelope.id === d1.envelope.id, "replay con la misma clave");
  const other = await call("POST", "/v1/envelopes", { ...body1, subject: `${subject1} bis` }, { headers: { "Idempotency-Key": idem1 } });
  assert(other.status === 409 && other.data.error.code === "idempotency_mismatch", `otra petición con la misma clave: ${other.status}`);
  assert((await countBySubject(subject1)) === 1, "un solo sobre con ese asunto");
  ok("Idempotency-Key: replay sin duplicar y 409 con otro cuerpo");
}

// El firmante por email recibe la invitación y puede firmar (el sobre sigue su curso normal).
{
  const token = await linkFor(`Cliente ${stamp}`);
  const sess = await api("GET", `/v1/signing/${token}`);
  assert(sess.canSign, "el firmante puede firmar");
  await api("POST", `/v1/signing/${token}/consent`);
  const done = await api("POST", `/v1/signing/${token}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
  assert(done.recipient.status === "signed", `el firmante completa: ${done.recipient.status}`);
  ok("el firmante invitado por email firma el sobre creado en una llamada");
}

// ───────── 3. multipart/form-data: JSON en `payload` y varios PDF ─────────
const subject2 = `Oneshot multipart ${stamp}`;
const multipartBody = () => {
  const fd = new FormData();
  fd.append(
    "payload",
    JSON.stringify({
      subject: subject2,
      documents: [
        { ref: "c", file: "contrato" },
        { ref: "a", file: "anexo", name: "Anexo A.pdf" },
      ],
      recipients: [{ name: `Multi ${stamp}`, email: `multi+${stamp}@example.com` }],
      fields: [
        { type: "signature", anchor: { text: "[[firma]]", offsetY: -40, width: 150, height: 40 } },
        { type: "initials", document: "a", page: 0, x: 0.8, y: 0.9, width: 0.1, height: 0.05 },
      ],
      status: "sent",
    }),
  );
  fd.append("contrato", new Blob([contract], { type: "application/pdf" }), "contrato.pdf");
  fd.append("anexo", new Blob([annex], { type: "application/pdf" }), "anexo.pdf");
  return fd;
};
const idem2 = `oneshot-mp-${stamp}`;
const r2 = await call("POST", "/v1/envelopes", multipartBody(), { headers: { "Idempotency-Key": idem2 } });
assert(r2.status === 201, `multipart: ${r2.status} ${JSON.stringify(r2.data).slice(0, 400)}`);
assert(r2.data.envelope.status === "sent" && r2.data.documents.length === 2, "enviado con 2 documentos");
assert(r2.data.documents[0].name === "contrato.pdf" && r2.data.documents[1].name === "Anexo A.pdf", "nombres: el de la parte o el indicado");
assert(r2.data.fields.length === 2 && r2.data.fields.find((f) => f.type === "initials").documentId === r2.data.documents[1].id, "campo en el anexo por ref");
assert(!r2.data.signingUrls, "sin embebidos no hay signingUrls");
const r2b = await call("POST", "/v1/envelopes", multipartBody(), { headers: { "Idempotency-Key": idem2 } });
assert(r2b.headers.get("idempotent-replay") === "true" && r2b.data.envelope.id === r2.data.envelope.id, "replay multipart");
ok("multipart/form-data: payload JSON + 2 PDF, campo por ref de documento, firmante único implícito, idempotente");

// Sin `documents`: cada archivo es un documento, en orden.
{
  const fd = new FormData();
  fd.append("payload", JSON.stringify({ subject: `Oneshot implícito ${stamp}`, recipients: [{ name: "Implícito", email: `impl+${stamp}@example.com` }] }));
  fd.append("file", new Blob([contract], { type: "application/pdf" }), "uno.pdf");
  fd.append("file2", new Blob([annex], { type: "application/pdf" }), "dos.pdf");
  const r = await call("POST", "/v1/envelopes", fd);
  assert(r.status === 201 && r.data.envelope.status === "draft" && r.data.documents.map((d) => d.name).join(",") === "uno.pdf,dos.pdf", `archivos sin documents: ${JSON.stringify(r.data).slice(0, 300)}`);
  ok("multipart sin documents: cada archivo es un documento (queda en borrador sin send)");
}

// ───────── 4. Documento por URL (solo con la API local: descarga de un servidor de la prueba) ─────────
if (LOCAL) {
  const srv = createServer((req, res) => {
    if (req.url === "/contrato.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(contract);
    } else if (req.url === "/redirige.pdf") {
      res.writeHead(302, { location: "/contrato.pdf" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>no es un pdf</html>");
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const r = await call("POST", "/v1/envelopes", {
    subject: `Oneshot URL ${stamp}`,
    documents: [{ url: `http://127.0.0.1:${port}/contrato.pdf` }],
    recipients: [{ name: "Por URL", email: `url+${stamp}@example.com` }],
    fields: [{ type: "signature", anchor: { text: "[[firma]]", width: 150, height: 40 } }],
    send: true,
  });
  assert(r.status === 201 && r.data.envelope.status === "sent" && r.data.documents[0].name === "contrato.pdf", `documento por URL: ${JSON.stringify(r.data).slice(0, 300)}`);
  for (const [path, what] of [
    ["/redirige.pdf", "redirige"],
    ["/pagina.html", "no es un PDF"],
  ]) {
    const bad = await call("POST", "/v1/envelopes", { subject: `Oneshot URL mala ${stamp}`, documents: [{ url: `http://127.0.0.1:${port}${path}` }] });
    assert(bad.status === 400 && ["document_fetch_failed", "invalid_pdf"].includes(bad.data.error.code), `URL que ${what}: ${bad.status} ${JSON.stringify(bad.data)}`);
  }
  srv.close();
  assert((await countBySubject(`Oneshot URL mala ${stamp}`)) === 0, "las URL malas no dejan sobres");
  ok("documento por URL (descarga), y URL que redirige o no es PDF rechazadas sin dejar sobre");
} else {
  const bad = await call("POST", "/v1/envelopes", { subject: `Oneshot SSRF ${stamp}`, documents: [{ url: "https://169.254.169.254/latest/meta-data.pdf" }] });
  assert(bad.status === 400 && bad.data.error.code === "document_fetch_failed", `URL interna bloqueada: ${bad.status} ${JSON.stringify(bad.data)}`);
  ok("documento por URL interna bloqueado (SSRF)");
}

// ───────── 5. Atomicidad: nada queda a medias ─────────
const subjectBad = `Oneshot fallido ${stamp}`;
const failures = [
  [
    "PDF inválido",
    { subject: subjectBad, documents: [{ base64: Buffer.from("%PDF-1.4 esto no es un pdf").toString("base64") }], recipients: [{ name: "X", email: `x+${stamp}@example.com` }] },
    400,
  ],
  ["base64 que no es PDF", { subject: subjectBad, documents: [{ base64: Buffer.from("hola").toString("base64") }] }, 400, "invalid_pdf"],
  [
    "ancla que no aparece",
    {
      subject: subjectBad,
      documents: [{ base64: contract.toString("base64") }],
      recipients: [{ name: "X", email: `x+${stamp}@example.com` }],
      fields: [{ type: "signature", anchor: { text: "[[no-existe]]", width: 100, height: 30 } }],
      send: true,
    },
    400,
    "anchor_not_found",
  ],
  [
    "sobre incompleto para enviar (firmante sin campo de firma)",
    { subject: subjectBad, documents: [{ base64: contract.toString("base64") }], recipients: [{ name: "X", email: `x+${stamp}@example.com` }], send: true },
    422,
    "envelope_incomplete",
  ],
  [
    "referencia a un destinatario que no existe",
    {
      subject: subjectBad,
      documents: [{ base64: contract.toString("base64") }],
      recipients: [{ name: "X", email: `x+${stamp}@example.com` }],
      fields: [{ recipient: "nadie", type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
    },
    400,
    "invalid_field",
  ],
  [
    "campo sin destinatario con dos firmantes",
    {
      subject: subjectBad,
      documents: [{ base64: contract.toString("base64") }],
      recipients: [
        { name: "X", email: `x+${stamp}@example.com` },
        { name: "Y", email: `y+${stamp}@example.com` },
      ],
      fields: [{ type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
    },
    400,
    "invalid_field",
  ],
  ["documento con base64 y url a la vez", { subject: subjectBad, documents: [{ base64: "JVBERi0=", url: "https://example.com/x.pdf" }] }, 400, "validation_error"],
  ["send y status contradictorios", { subject: subjectBad, send: true, status: "draft" }, 400, "validation_error"],
  [
    "origen embebido no autorizado",
    {
      subject: subjectBad,
      documents: [{ base64: contract.toString("base64") }],
      recipients: [{ name: "E", embedded: true }],
      fields: [{ type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }],
      send: true,
      embeddedSigning: { frameAncestors: ["https://otra.app"] },
    },
    400,
    "frame_ancestor_not_allowed",
  ],
];
for (const [what, body, status, code] of failures) {
  const r = await call("POST", "/v1/envelopes", body, { headers: { "Idempotency-Key": `fallo-${what}-${stamp}` } });
  assert(r.status === status && (!code || r.data.error.code === code), `${what}: esperaba ${status} ${code ?? ""}, llegó ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
}
{
  const fd = new FormData();
  fd.append("payload", JSON.stringify({ subject: subjectBad, documents: [{ file: "falta" }] }));
  fd.append("otro", new Blob([contract], { type: "application/pdf" }), "otro.pdf");
  const r = await call("POST", "/v1/envelopes", fd);
  assert(r.status === 400 && r.data.error.code === "file_part_missing", `parte faltante: ${r.status} ${JSON.stringify(r.data)}`);
  const fd2 = new FormData();
  fd2.append("contrato", new Blob([contract], { type: "application/pdf" }), "c.pdf");
  const r2 = await call("POST", "/v1/envelopes", fd2);
  assert(r2.status === 400 && r2.data.error.code === "payload_required", `sin payload: ${r2.status} ${JSON.stringify(r2.data)}`);
}
assert((await countBySubject(subjectBad)) === 0, "ningún pedido fallido dejó un sobre");
// La clave de un pedido fallido se libera: el reintento corregido funciona.
{
  const fixed = await call(
    "POST",
    "/v1/envelopes",
    {
      subject: `Oneshot corregido ${stamp}`,
      documents: [{ base64: contract.toString("base64") }],
      recipients: [{ name: "X", email: `x+${stamp}@example.com` }],
      fields: [{ type: "signature", anchor: { text: "[[firma]]", width: 100, height: 30 } }],
      send: true,
    },
    { headers: { "Idempotency-Key": `fallo-ancla que no aparece-${stamp}` } },
  );
  assert(fixed.status === 201 && fixed.data.envelope.status === "sent", `reintento corregido con la misma clave: ${fixed.status}`);
}
ok(`atomicidad: ${failures.length + 2} pedidos inválidos no dejan sobres a medias; la clave de un fallo se puede reusar`);

// ───────── 6. Plantilla + envío en una llamada, con Idempotency-Key ─────────
{
  const tpl = await api("POST", "/v1/templates", { name: `Plantilla oneshot ${stamp}`, subject: "Desde plantilla" });
  const tplId = tpl.template.id;
  const fd = new FormData();
  fd.append("file", new Blob([contract], { type: "application/pdf" }), "contrato.pdf");
  const doc = await api("POST", `/v1/templates/${tplId}/documents`, fd);
  const roles = await api("PUT", `/v1/templates/${tplId}/roles`, { roles: [{ name: "Cliente", role: "signer", routingOrder: 1 }] });
  await api("PUT", `/v1/templates/${tplId}/fields`, {
    fields: [{ documentId: doc.id, roleId: roles.roles[0].id, type: "signature", page: 0, x: 0.1, y: 0.6, width: 0.3, height: 0.06 }],
  });
  const body = { templateId: tplId, subject: `Desde plantilla ${stamp}`, recipients: [{ role: "Cliente", name: "Tpl", email: `tpl+${stamp}@example.com` }], send: true };
  const a = await call("POST", "/v1/envelopes/from-template", body, { headers: { "Idempotency-Key": `tpl-${stamp}` } });
  assert(a.status === 201 && a.data.envelope.status === "sent", `plantilla + envío: ${a.status} ${JSON.stringify(a.data).slice(0, 300)}`);
  const b = await call("POST", "/v1/envelopes/from-template", body, { headers: { "Idempotency-Key": `tpl-${stamp}` } });
  assert(b.headers.get("idempotent-replay") === "true" && b.data.envelope.id === a.data.envelope.id, "replay de from-template");
  assert((await countBySubject(`Desde plantilla ${stamp}`)) === 1, "un solo sobre desde la plantilla");
  ok("plantilla + envío en una llamada, idempotente");
}

// ───────── 7. MCP: create_envelope en una llamada, con send + confirm ─────────
{
  const client = new Client({ name: "e2e-oneshot", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const args = {
    subject: `MCP oneshot ${stamp}`,
    recipients: [{ name: `Agente ${stamp}`, email: `agente+${stamp}@example.com` }],
    document: { base64: contract.toString("base64"), name: "contrato.pdf" },
    fields: [{ recipientIndex: 0, anchorText: "[[firma]]", offsetY: -40 }],
    send: true,
  };
  const noConfirm = await client.callTool({ name: "create_envelope", arguments: args });
  assert(noConfirm.isError && /Confirmación requerida/.test(noConfirm.content[0].text), "send sin confirm pide confirmación");
  assert((await countBySubject(`MCP oneshot ${stamp}`)) === 0, "sin confirm no crea nada");
  const sent = await client.callTool({ name: "create_envelope", arguments: { ...args, confirm: true } });
  assert(!sent.isError, `create_envelope con send: ${sent.content?.[0]?.text}`);
  const out = JSON.parse(sent.content[0].text);
  assert(out.status === "sent" && out.documents.length === 1 && out.fields === 1, `MCP enviado: ${JSON.stringify(out)}`);
  const bad = await client.callTool({ name: "create_envelope", arguments: { ...args, subject: `MCP oneshot malo ${stamp}`, fields: [{ recipientIndex: 0, anchorText: "[[nada]]" }], confirm: true } });
  assert(bad.isError && /anchor_not_found/.test(bad.content[0].text), "ancla inexistente: error");
  assert((await countBySubject(`MCP oneshot malo ${stamp}`)) === 0, "el fallo del MCP no deja borrador");
  await client.close();
  ok("MCP create_envelope: crea y envía en una llamada con confirm; atómico");
}

// ───────── 8. OpenAPI documenta el sobre completo ─────────
{
  const spec = await api("GET", "/v1/openapi.json");
  const op = spec.paths["/v1/envelopes"].post;
  const json = op.requestBody.content["application/json"].schema;
  assert(json.properties.documents && json.properties.recipients && json.properties.fields && json.properties.send, "OpenAPI: documents/recipients/fields/send");
  assert(op.requestBody.content["multipart/form-data"], "OpenAPI: multipart");
  ok("OpenAPI de POST /v1/envelopes con el sobre completo (JSON y multipart)");
}

console.log("\nE2E sobre en una llamada: OK");
