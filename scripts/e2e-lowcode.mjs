#!/usr/bin/env node
// Prueba de punta a punta de los conectores low-code contra una API real (propia, puerto 4117, PGlite):
//   - endpoints nuevos: GET /v1/templates/{id}/input-schema, POST /v1/envelopes/from-template/{id},
//     GET /v1/webhooks/samples, Location en POST /v1/webhooks (DELETE a esa URL, como Power Automate),
//   - la app de Zapier construida por integrations/build.mjs, con un `z` real sobre fetch: REST hook (suscripción,
//     evento entregado por CalaSign, PDF firmado como archivo), datos de prueba, enviar desde plantilla con campos
//     dinámicos, enviar un PDF (orquestación quicksend), desuscripción,
//   - el trigger de n8n (create/delete del webhook) con el paquete .tgz construido.
// Uso: node scripts/e2e-lowcode.mjs
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { readTgz } from "../integrations/lib/tar.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.E2E_LOWCODE_PORT ?? 4117);
const RPORT = Number(process.env.E2E_LOWCODE_RECEIVER ?? 4293);
const BASE = `http://localhost:${PORT}`;
const RECV = `http://127.0.0.1:${RPORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`✓ ${m}`);
function assert(c, m) {
  if (!c) throw new Error(`falló: ${m}`);
}

function tinyPdf(pages = 1) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids = [];
  const pageObjs = [];
  for (let p = 0; p < pages; p++) {
    const content = `BT /F1 18 Tf 72 760 Td (Contrato low-code pagina ${p + 1}) Tj ET`;
    const pageId = 3 + p * 2;
    kids.push(`${pageId} 0 R`);
    pageObjs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> >>`);
    pageObjs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`, ...pageObjs, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ───────── Receptor de webhooks + servidor de archivos ─────────

const received = [];
const receiver = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/doc.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(tinyPdf(2));
    }
    received.push({ path: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => receiver.listen(RPORT, "127.0.0.1", r));

// ───────── Build de las integraciones para esta API ─────────

const TMP = mkdtempSync(join(tmpdir(), "calasign-lowcode-e2e-"));
const OUT = join(TMP, "out");
execFileSync(process.execPath, [join(ROOT, "integrations/build.mjs")], { env: { ...process.env, CALASIGN_BASE_URL: BASE, CALASIGN_INTEGRATIONS_OUT: OUT }, stdio: "pipe" });

function unzip(buf, dir) {
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8);
    const cs = buf.readUInt32LE(o + 18);
    const nl = buf.readUInt16LE(o + 26);
    const xl = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nl).toString();
    const data = buf.subarray(o + 30 + nl + xl, o + 30 + nl + xl + cs);
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), method === 8 ? inflateRawSync(data) : data);
    o += 30 + nl + xl + cs;
  }
}

// ───────── API propia ─────────

const dataDir = join(TMP, "data");
const api_ = spawn(join(ROOT, "apps/api/node_modules/.bin/tsx"), [join(ROOT, "scripts/e2e-api-entry.mts")], {
  cwd: join(ROOT, "apps/api"),
  env: { ...process.env, NODE_ENV: "development", APP_ENV: "local", PORT: String(PORT), HOST: "127.0.0.1", APP_URL: BASE, DATA_DIR: dataDir, DATABASE_URL: "", LOG_LEVEL: "warn", TSA_URL: "" },
  stdio: ["ignore", "inherit", "inherit"],
});
const cleanup = () => {
  try {
    api_.kill("SIGTERM");
  } catch {}
  receiver.close();
  if (process.env.E2E_KEEP_DATA !== "1") rmSync(TMP, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(sig, () => process.exit(128 + n));
for (let i = 0; i < 180; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await sleep(500);
}

let cookie = "";
async function api(method, path, body, opts = {}) {
  const h = { ...(opts.headers ?? {}) };
  if (opts.bearer) h.authorization = `Bearer ${opts.bearer}`;
  else if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set && /^(__Host-)?cs_session=/.test(set)) cookie = set.split(";")[0];
  if (opts.raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return data;
}
async function waitFor(fn, what, ms = 45_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timeout esperando ${what}`);
}

const stamp = Date.now();
await api("POST", "/v1/auth/signup", { name: "Admin Low-code", email: `lowcode+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Low-code ${stamp}` });
const { secret: KEY } = await api("POST", "/v1/api-keys", { name: `conectores ${stamp}`, role: "admin" });
step("organización y API key");

// Plantilla: Cliente (firma + Empresa + Monto) y Gerente (firma).
const { template } = await api("POST", "/v1/templates", { name: `Contrato low-code ${stamp}`, subject: "Contrato" });
const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const tdoc = await api("POST", `/v1/templates/${template.id}/documents`, fd);
const rC = crypto.randomUUID();
const rG = crypto.randomUUID();
await api("PUT", `/v1/templates/${template.id}/roles`, { roles: [{ id: rC, name: "Cliente", role: "signer", routingOrder: 1 }, { id: rG, name: "Gerente", role: "signer", routingOrder: 1 }] });
await api("PUT", `/v1/templates/${template.id}/fields`, {
  fields: [
    { documentId: tdoc.id, roleId: rC, type: "signature", page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.08 },
    { documentId: tdoc.id, roleId: rG, type: "signature", page: 0, x: 0.55, y: 0.8, width: 0.3, height: 0.08 },
    { documentId: tdoc.id, roleId: rC, type: "text", label: "Empresa", page: 0, x: 0.1, y: 0.3, width: 0.3, height: 0.05, required: false },
    { documentId: tdoc.id, roleId: rC, type: "number", label: "Monto", page: 0, x: 0.1, y: 0.4, width: 0.3, height: 0.05, required: false },
  ],
});

// ───────── 1. Endpoints nuevos ─────────

const schema = await api("GET", `/v1/templates/${template.id}/input-schema`, null, { bearer: KEY });
assert(schema.roles.length === 2 && schema.fields.length === 2, "input-schema: 2 roles y 2 campos prellenables");
assert(schema.rolesSchema.properties[rC].properties.email && schema.prefillSchema.properties[schema.fields.find((f) => f.label === "Monto").id].type === "number", "input-schema: JSON Schema");
step("GET /v1/templates/{id}/input-schema");

const bad = await api("POST", `/v1/envelopes/from-template/${template.id}`, { roles: { Socio: { name: "x", email: "x@x.com" } } }, { bearer: KEY, raw: true });
assert(bad.status === 400 && (await bad.json()).error.code === "unknown_role", "rol desconocido → 400 unknown_role");
const missing = await api("POST", `/v1/envelopes/from-template/${template.id}`, { roles: { Cliente: { name: "x", email: "x@x.com" } } }, { bearer: KEY, raw: true });
assert(missing.status === 422, "falta un rol → 422 roles_missing");
step("POST /v1/envelopes/from-template/{id}: errores");

const created = await api("POST", "/v1/webhooks", { url: `${RECV}/pa`, events: ["envelope.completed"] }, { bearer: KEY, raw: true });
const location = created.headers.get("location");
assert(created.status === 201 && location === `${BASE}/v1/webhooks/${(await created.json()).webhook.id}`, `Location absoluta (${location})`);
const del = await fetch(location, { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } });
assert(del.status === 204, "DELETE a la Location → 204");
step("POST /v1/webhooks devuelve Location; DELETE a esa URL la borra (Power Automate)");

const synthetic = await api("GET", "/v1/webhooks/samples?event=envelope.completed", null, { bearer: KEY });
assert(synthetic.items.length === 1 && synthetic.items[0].data.envelope.subject === "Contrato de ejemplo", "samples: sintético sin sobres");
step("GET /v1/webhooks/samples (sintético)");

// ───────── 2. Zapier (app construida, z real sobre fetch) ─────────

const ZDIR = join(TMP, "zapier");
unzip(readFileSync(join(OUT, "connectors/zapier/calasign-zapier-app.zip")), ZDIR);
mkdirSync(join(ZDIR, "node_modules/zapier-platform-core"), { recursive: true });
writeFileSync(join(ZDIR, "node_modules/zapier-platform-core/index.js"), 'module.exports = { version: "19.2.1" };\n');
const app = createRequire(join(ZDIR, "index.js"))("./index.js");

class ZError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const stashed = [];
function realZ(bundle) {
  const z = {
    errors: { Error: ZError, ThrottledError: ZError },
    dehydrateFile: (fn, data) => ({ hydrate: data }),
    stashFile: async (reqPromise) => {
      const res = await reqPromise;
      stashed.push(await res.buffer());
      return "https://zapier.test/stash/1";
    },
    request: async (opts) => {
      let req = { method: "GET", headers: {}, ...opts };
      if (req.params) req.url += `?${new URLSearchParams(req.params)}`;
      for (const mw of app.beforeRequest) req = mw(req, z, bundle);
      let body = req.body;
      if (body && !Buffer.isBuffer(body) && typeof body === "object") {
        body = JSON.stringify(body);
        req.headers["content-type"] ??= "application/json";
      }
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body });
      const buf = Buffer.from(await r.arrayBuffer());
      let data = null;
      try {
        data = JSON.parse(buf.toString());
      } catch {}
      let res = { status: r.status, data, json: data, content: buf.toString(), request: req, buffer: async () => buf, throwForStatus() {} };
      for (const mw of app.afterResponse) res = mw(res, z, bundle);
      return res;
    },
  };
  return z;
}
const bundle = { authData: { apiKey: KEY }, inputData: {} };
const z = realZ(bundle);

await app.authentication.test.url && (await z.request({ url: app.authentication.test.url }));
const sub = await app.triggers.envelope_completed.operation.performSubscribe(z, { ...bundle, targetUrl: `${RECV}/zapier` });
assert(sub.webhook.id && sub.secret, "Zapier: suscripción REST hook");
step("Zapier: test de autenticación y suscripción REST hook");

const dyn = app.creates.send_from_template.operation.inputFields.find((f) => typeof f === "function");
const fields = await dyn(z, { ...bundle, inputData: { templateId: template.id } });
assert(fields.length === 8, `Zapier: 6 campos de roles + 2 de prellenado (${fields.length})`);
const montoId = schema.fields.find((f) => f.label === "Monto").id;
const sent = await app.creates.send_from_template.operation.perform(z, {
  ...bundle,
  inputData: {
    templateId: template.id,
    subject: `Contrato Zapier ${stamp}`,
    [`role_${rC}_name`]: `Cliente Z ${stamp}`,
    [`role_${rC}_email`]: `cliente+${stamp}@example.com`,
    [`role_${rG}_name`]: `Gerente Z ${stamp}`,
    [`role_${rG}_email`]: `gerente+${stamp}@example.com`,
    [`prefill_${montoId}`]: 1500,
    external_id: "CRM-42",
  },
});
assert(sent.status === "sent" && sent.metadata.externalId === "CRM-42", "Zapier: sobre enviado desde plantilla con metadata");
const detail = await api("GET", `/v1/envelopes/${sent.id}`, null, { bearer: KEY });
assert(detail.fields.some((f) => f.label === "Monto" && f.value === "1500"), "prellenado aplicado");
step("Zapier: enviar desde plantilla (campos dinámicos por rol + prellenado)");

// Firmar todo desde el buzón de desarrollo.
for (const name of [`Cliente Z ${stamp}`, `Gerente Z ${stamp}`]) {
  const link = await waitFor(async () => {
    const { items } = await api("GET", "/dev/mailbox");
    return items.find((x) => x.text.includes(name) && x.link?.includes("/s/"))?.link;
  }, `invitación de ${name}`);
  const token = link.split("/s/")[1];
  let sess = await api("GET", `/v1/signing/${token}`);
  await api("POST", `/v1/signing/${token}/consent`);
  const values = sess.fields.filter((f) => ["text", "number"].includes(f.type) && !f.readOnly).map((f) => ({ id: f.id, value: f.value ?? "x" }));
  sess = await api("POST", `/v1/signing/${token}/complete`, { fields: values, signature: { kind: "drawn", imagePng: PNG } });
  assert(sess.recipient.status === "signed", `${name} firmó`);
}
await waitFor(async () => (await api("GET", `/v1/envelopes/${sent.id}`, null, { bearer: KEY })).envelope.status === "completed", "sobre completado");

const hit = await waitFor(() => received.find((r) => r.path === "/zapier"), "entrega del webhook a Zapier");
const sig = hit.headers["calasign-signature"];
const [, t, v1] = /t=(\d+),v1=([0-9a-f]+)/.exec(sig);
assert(createHmac("sha256", sub.secret).update(`${t}.${hit.raw}`).digest("hex") === v1, "firma HMAC de la entrega");
const ev = JSON.parse(hit.raw.toString());
const rows = app.triggers.envelope_completed.operation.perform(z, { ...bundle, cleanedRequest: ev });
assert(rows[0].envelope_id === sent.id && rows[0].metadata.externalId === "CRM-42" && rows[0].signed_pdf?.hydrate?.envelopeId === sent.id, "Zapier: evento aplanado con el PDF como archivo");
await app.hydrators.signedPdf(z, { ...bundle, inputData: rows[0].signed_pdf.hydrate });
assert(stashed[0]?.subarray(0, 5).toString() === "%PDF-", "Zapier: PDF firmado descargado");
step("Zapier: evento envelope.completed entregado, firmado, aplanado y PDF firmado descargado");

const list = await app.triggers.envelope_completed.operation.performList(z, bundle);
assert(list.some((r) => r.envelope_id === sent.id), "Zapier performList: sobre real en los datos de prueba");
step("Zapier: datos de prueba (GET /v1/webhooks/samples con sobres reales)");

const doc = await app.creates.send_document.operation.perform(z, {
  ...bundle,
  inputData: { file: `${RECV}/doc.pdf`, file_name: "acuerdo.pdf", subject: `PDF Zapier ${stamp}`, signers: [{ name: "Ana PDF", email: `ana+${stamp}@example.com` }, { name: "Beto PDF", email: `beto+${stamp}@example.com` }] },
});
const docDetail = await api("GET", `/v1/envelopes/${doc.id}`, null, { bearer: KEY });
assert(doc.status === "sent" && docDetail.documents[0].pageCount === 2, "Zapier: PDF enviado");
assert(docDetail.fields.filter((f) => f.type === "signature").every((f) => f.page === 1), "firmas en la última página");
step("Zapier: enviar un PDF (crear, subir, destinatarios, firmas en la última página, enviar)");

await app.triggers.envelope_completed.operation.performUnsubscribe(z, { ...bundle, subscribeData: sub });
assert((await api("GET", "/v1/webhooks", null, { bearer: KEY })).items.length === 0, "Zapier: desuscripción");
step("Zapier: desuscripción REST hook");

// ───────── 3. n8n (trigger del paquete .tgz) ─────────

const tgz = await readTgz(readFileSync(join(OUT, "connectors/n8n/n8n-nodes-calasign-1.0.0.tgz")));
const NDIR = join(TMP, "n8n");
for (const [name, data] of tgz) {
  mkdirSync(dirname(join(NDIR, name)), { recursive: true });
  writeFileSync(join(NDIR, name), data);
}
mkdirSync(join(NDIR, "package/node_modules/n8n-workflow"), { recursive: true });
writeFileSync(join(NDIR, "package/node_modules/n8n-workflow/index.js"), "module.exports = { NodeConnectionTypes: { Main: 'main' }, NodeOperationError: class extends Error {} };\n");
const { CalaSignTrigger } = createRequire(join(NDIR, "package/package.json"))("./dist/nodes/CalaSignTrigger/CalaSignTrigger.node.js");
const staticData = {};
const n8nThis = {
  getNodeParameter: (n) => ({ authentication: "apiKey", events: ["recipient.signed"] })[n],
  getCredentials: async () => ({ apiKey: KEY, baseUrl: BASE }),
  getWorkflowStaticData: () => staticData,
  getNodeWebhookUrl: () => `${RECV}/n8n`,
  getWorkflow: () => ({ id: "w1", name: "e2e" }),
  helpers: {
    httpRequestWithAuthentication: async (_cred, o) => {
      const r = await fetch(o.url, { method: o.method, headers: { ...o.headers, authorization: `Bearer ${KEY}`, ...(o.body ? { "content-type": "application/json" } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
      if (!r.ok) throw new Error(`n8n ${o.method} ${o.url} → ${r.status}`);
      const text = await r.text();
      return text ? JSON.parse(text) : "";
    },
  },
};
const trig = new CalaSignTrigger();
assert((await trig.webhookMethods.default.checkExists.call(n8nThis)) === false, "n8n: no existe al principio");
await trig.webhookMethods.default.create.call(n8nThis);
assert(staticData.webhookId && (await trig.webhookMethods.default.checkExists.call(n8nThis)) === true, "n8n: webhook creado y verificado");
const hooks = (await api("GET", "/v1/webhooks", null, { bearer: KEY })).items;
assert(hooks.length === 1 && hooks[0].events[0] === "recipient.signed" && hooks[0].url === `${RECV}/n8n`, "n8n: suscripción con los eventos elegidos");
await trig.webhookMethods.default.delete.call(n8nThis);
assert((await api("GET", "/v1/webhooks", null, { bearer: KEY })).items.length === 0, "n8n: webhook borrado");
step("n8n: el trigger crea, verifica y borra su webhook");

console.log("\nLow-code: todo OK");
process.exit(0);
