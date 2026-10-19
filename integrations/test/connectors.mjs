#!/usr/bin/env node
// Pruebas de los conectores out-of-the-box (sin red): corre el build en una carpeta temporal y verifica
//   1. el registro (connectors/index.json, artefactos en index.json, sin {{PLACEHOLDER}}),
//   2. Power Automate: lint de OpenAPI 2.0 con las reglas de certificación de Microsoft,
//   3. quicksend (orquestación de "enviar PDF") contra un request simulado,
//   4. Zapier: estructura de la app, REST hooks y acciones con un `z` simulado (sin zapier-platform-core),
//   5. n8n: paquete npm (.tgz), carga de nodos con n8n-workflow simulado, trigger y firma HMAC,
//   6. Make: referencias rpc/webhook/funciones, IML balanceado, funciones IML,
//   7. Dynamics 365: web resource con Xrm simulado y setup-dataverse idempotente,
//   8. Zoho CRM: función Deluge del botón (endpoint del conector nativo y sintaxis básica).
//
//   node integrations/test/connectors.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { inflateRawSync } from "node:zlib";
import { readTgz } from "../lib/tar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "calasign-connectors-"));
const OUT = join(TMP, "out");
const BASE = "https://example.calasign.test";
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✘ ${name}\n  ${e?.stack ?? e}`);
  }
}

function readZip(buf) {
  const files = new Map();
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const method = buf.readUInt16LE(o + 8);
    const csize = buf.readUInt32LE(o + 18);
    const nlen = buf.readUInt16LE(o + 26);
    const xlen = buf.readUInt16LE(o + 28);
    const name = buf.subarray(o + 30, o + 30 + nlen).toString("utf8");
    const data = buf.subarray(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    o += 30 + nlen + xlen + csize;
  }
  return files;
}

/** Extrae un zip a una carpeta. */
function unzipTo(buf, dir) {
  for (const [name, data] of readZip(buf)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  return dir;
}

execFileSync(process.execPath, [join(HERE, "../build.mjs")], {
  env: { ...process.env, CALASIGN_BASE_URL: BASE, CALASIGN_INTEGRATIONS_OUT: OUT },
  stdio: "pipe",
});
const C = (p) => join(OUT, "connectors", p);

// ───────── 1. Registro ─────────

await test("registro: connectors/index.json y artefactos en index.json", () => {
  const idx = JSON.parse(readFileSync(C("index.json"), "utf8"));
  const ids = idx.connectors.map((c) => c.id);
  for (const id of ["dynamics365", "make", "n8n", "power-automate", "zapier"]) assert.ok(ids.includes(id), id);
  const all = JSON.parse(readFileSync(join(OUT, "index.json"), "utf8")).artifacts.map((a) => a.path);
  for (const c of idx.connectors) for (const a of c.artifacts) assert.ok(all.includes(a), a);
  for (const c of idx.connectors) for (const a of c.artifacts) assert.ok(existsSync(join(OUT, a.replace("/integrations/", ""))), a);
});

await test("registro: ningún {{PLACEHOLDER}} sin reemplazar en los conectores", () => {
  const idx = JSON.parse(readFileSync(C("index.json"), "utf8"));
  for (const c of idx.connectors) {
    for (const a of c.artifacts.filter((x) => x.endsWith(".zip"))) {
      for (const [name, data] of readZip(readFileSync(join(OUT, a.replace("/integrations/", ""))))) {
        assert.doesNotMatch(data.toString("utf8"), /\{\{[A-Z_]+\}\}/, `${a}:${name}`);
      }
    }
  }
});

// ───────── 2. Power Automate ─────────

const swagger = JSON.parse(readFileSync(C("power-automate/apiDefinition.swagger.json"), "utf8"));

await test("power automate: OpenAPI 2.0 con host, esquema https y seguridad", () => {
  assert.equal(swagger.swagger, "2.0");
  assert.equal(swagger.host, "example.calasign.test");
  assert.deepEqual(swagger.schemes, ["https"]);
  assert.ok(swagger.info.title.length <= 30 && !/\b(API|Connector|Power Automate)\b/i.test(swagger.info.title), "título de certificación");
  assert.ok(swagger.info.description.length >= 30 && swagger.info.description.length <= 500);
  assert.equal(swagger.securityDefinitions.api_key.in, "header");
  const props = JSON.parse(readFileSync(C("power-automate/apiProperties.json"), "utf8")).properties;
  assert.equal(props.connectionParameters.api_key.type, "securestring");
  assert.ok(!["#ffffff", "#007ee5"].includes(props.iconBrandColor.toLowerCase()));
  const oauth = JSON.parse(readFileSync(C("power-automate/apiProperties.oauth.json"), "utf8")).properties;
  assert.equal(oauth.connectionParameters.token.oAuthSettings.customParameters.tokenUrl.value, `${BASE}/oauth/token`);
});

await test("power automate: reglas de certificación en cada operación y parámetro", () => {
  const ids = new Set();
  const refs = [];
  (function collect(n) {
    if (Array.isArray(n)) n.forEach(collect);
    else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) k === "$ref" ? refs.push(v) : collect(v);
  })(swagger);
  for (const r of refs) assert.ok(swagger.definitions[r.replace("#/definitions/", "")], `$ref roto ${r}`);
  for (const [path, item] of Object.entries(swagger.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method.startsWith("x-ms")) continue;
      const where = `${method.toUpperCase()} ${path}`;
      assert.match(op.operationId, /^[A-Z][A-Za-z0-9]+$/, `${where}: operationId PascalCase`);
      assert.ok(!ids.has(op.operationId), `${where}: operationId repetido`);
      ids.add(op.operationId);
      assert.ok(op.summary && op.summary.length <= 80 && !/[.\s]$/.test(op.summary) && /^[A-Za-z0-9 ()-]+$/.test(op.summary), `${where}: summary`);
      assert.ok(op.description && /[.!?]$/.test(op.description), `${where}: description termina con puntuación`);
      assert.ok(["important", "advanced", "internal"].includes(op["x-ms-visibility"]), `${where}: x-ms-visibility`);
      assert.ok(!op.responses.default, `${where}: sin respuesta default`);
      for (const p of op.parameters ?? []) {
        if (p.in === "body") continue;
        assert.ok(p["x-ms-summary"] && p.description, `${where}: parámetro ${p.name} sin x-ms-summary/description`);
        if (p.required && p["x-ms-visibility"] === "internal") assert.ok(p.default !== undefined, `${where}: ${p.name} interno y obligatorio sin default`);
      }
      for (const p of (path.match(/\{(\w+)\}/g) ?? []).map((x) => x.slice(1, -1))) {
        assert.ok((op.parameters ?? []).some((q) => q.in === "path" && q.name === p && q.required), `${where}: falta el parámetro de ruta ${p}`);
      }
    }
  }
  // Extensiones dinámicas: apuntan a operaciones existentes.
  const dyn = JSON.stringify(swagger).matchAll(/"operationId":"(\w+)","parameters"/g);
  for (const [, id] of dyn) assert.ok(ids.has(id), `x-ms-dynamic-* → ${id} no existe`);
  assert.ok(ids.has(swagger["x-ms-capabilities"].testConnection.operationId));
});

await test("power automate: trigger por webhook (notification-url, Location → DeleteWebhook)", () => {
  const hook = swagger.paths["/v1/webhooks"];
  assert.ok(hook["x-ms-notification-content"].schema.$ref);
  const op = hook.post;
  assert.equal(op["x-ms-trigger"], "single");
  const props = op.parameters.find((p) => p.in === "body").schema.properties;
  assert.equal(props.url["x-ms-notification-url"], true);
  assert.equal(props.url["x-ms-visibility"], "internal");
  assert.ok(props.events.default.includes("envelope.completed"));
  assert.ok(op.responses["201"]);
  assert.ok(swagger.paths["/v1/webhooks/{id}"].delete);
  const send = swagger.paths["/v1/envelopes/from-template/{templateId}"].post;
  const body = send.parameters.find((p) => p.in === "body").schema.properties;
  assert.equal(body.roles["x-ms-dynamic-schema"]["value-path"], "rolesSchema");
  assert.equal(body.prefill["x-ms-dynamic-schema"]["value-path"], "prefillSchema");
});

// ───────── 3. quicksend ─────────

const require = createRequire(import.meta.url);
const qs = require("../connectors/_lib/quicksend.cjs");

function fakeApi() {
  const calls = [];
  const request = async (method, path, opts = {}) => {
    calls.push({ method, path, opts });
    if (method === "POST" && path === "/v1/envelopes") return { envelope: { id: "env1", status: "draft" } };
    if (path.endsWith("/documents")) return { id: "doc1", pageCount: 3 };
    if (path.endsWith("/recipients")) return { envelope: { id: "env1" }, recipients: opts.json.recipients.map((r, i) => ({ ...r, id: `r${i}` })) };
    if (path.endsWith("/fields")) return { envelope: { id: "env1" } };
    if (path.endsWith("/send")) return { envelope: { id: "env1", status: "sent" } };
    if (method === "GET") return { envelope: { id: "env1", status: "sent" }, recipients: [] };
    throw new Error(`inesperado ${method} ${path}`);
  };
  return { calls, request };
}

await test("quicksend: crea, sube, destinatarios, firmas en la última página y envía", async () => {
  const { calls, request } = fakeApi();
  const pdf = Buffer.from("%PDF-1.7 prueba");
  const res = await qs.quickSend(request, {
    subject: "Contrato",
    fileName: 'con"trato.pdf',
    fileBytes: pdf,
    signers: [{ name: "Ana", email: "ana@x.com" }, { name: "Beto", phone: "+18095551234" }, { name: "Cami", email: "c@x.com" }],
    metadata: { externalId: "X1" },
  });
  assert.equal(res.envelope.status, "sent");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "POST /v1/envelopes",
    "POST /v1/envelopes/env1/documents",
    "PUT /v1/envelopes/env1/recipients",
    "PUT /v1/envelopes/env1/fields",
    "POST /v1/envelopes/env1/send",
    "GET /v1/envelopes/env1",
  ]);
  assert.deepEqual(calls[0].opts.json.metadata, { externalId: "X1" });
  const up = calls[1].opts;
  assert.match(up.headers["content-type"], /^multipart\/form-data; boundary=/);
  const boundary = up.headers["content-type"].split("boundary=")[1];
  assert.ok(up.body.includes(pdf) && up.body.toString().includes(`--${boundary}--`) && up.body.toString().includes('filename="con_trato.pdf"'));
  assert.deepEqual(calls[2].opts.json.recipients.map((r) => r.channels), [["email"], ["whatsapp"], ["email"]]);
  const fields = calls[3].opts.json.fields;
  assert.equal(fields.length, 3);
  for (const f of fields) {
    assert.equal(f.page, 2);
    assert.ok(f.x >= 0 && f.y >= 0 && f.x + f.width <= 1 && f.y + f.height <= 1, JSON.stringify(f));
  }
  assert.notDeepEqual([fields[0].x, fields[0].y], [fields[2].x, fields[2].y]);
});

await test("quicksend: anclas \\firmaN\\, borrador sin enviar y validaciones", async () => {
  const { calls, request } = fakeApi();
  await qs.quickSend(request, { subject: "S", fileName: "a.pdf", fileBytes: Buffer.from("%PDF"), signers: [{ name: "A", email: "a@x.com" }, { name: "B", email: "b@x.com" }], placement: "anchors", sequential: true, send: false });
  assert.deepEqual(calls[2].opts.json.recipients.map((r) => r.routingOrder), [1, 2]);
  assert.deepEqual(calls[3].opts.json.fields.map((f) => f.anchor.text), ["\\firma1\\", "\\firma2\\"]);
  assert.ok(!calls.some((c) => c.path.endsWith("/send")));
  await assert.rejects(qs.quickSend(request, { subject: "S", fileBytes: Buffer.from("%PDF"), signers: [] }), /firmante/);
  await assert.rejects(qs.quickSend(request, { subject: "S", fileBytes: Buffer.from("%PDF"), signers: [{ name: "A" }] }), /email o teléfono/);
  await assert.rejects(qs.quickSend(request, { subject: "S", signers: [{ name: "A", email: "a@x.com" }] }), /PDF/);
});

await test("quicksend: flattenEvent", () => {
  const f = qs.flattenEvent({ id: "e1", type: "recipient.signed", createdAt: "t", data: { envelope: { id: "env1", status: "sent", recipients: [{ id: "r1", name: "Ana", email: "a@x.com" }] }, recipientId: "r1" } });
  assert.equal(f.envelope_id, "env1");
  assert.equal(f.recipient_email, "a@x.com");
});

// ───────── 4. Zapier ─────────

const ZDIR = unzipTo(readFileSync(C("zapier/calasign-zapier-app.zip")), join(TMP, "zapier"));
mkdirSync(join(ZDIR, "node_modules/zapier-platform-core"), { recursive: true });
writeFileSync(join(ZDIR, "node_modules/zapier-platform-core/index.js"), 'module.exports = { version: "19.2.1" };\n');
const zapApp = createRequire(join(ZDIR, "index.js"))("./index.js");

class ZError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** `z` simulado: aplica beforeRequest/afterResponse de la app y responde con `routes`. */
function fakeZ(routes, bundle) {
  const log = [];
  const z = {
    errors: { Error: ZError, ThrottledError: ZError },
    dehydrateFile: (fn, data) => `hydrate:${data.envelopeId}`,
    stashFile: async () => "stashed",
    request: async (opts) => {
      let req = { method: "GET", headers: {}, ...opts };
      if (req.params) req.url += `?${new URLSearchParams(req.params)}`;
      for (const mw of zapApp.beforeRequest) req = mw(req, z, bundle);
      log.push(req);
      const key = `${req.method} ${req.url.replace(BASE, "")}`;
      const route = routes[key] ?? routes[`${req.method} ${req.url}`];
      if (!route) throw new Error(`zapier: sin ruta para ${key}`);
      const [status, data] = typeof route === "function" ? route(req) : route;
      let res = { status, data, json: data, content: JSON.stringify(data), request: req, throwForStatus() {}, buffer: async () => Buffer.from("%PDF-zap") };
      for (const mw of zapApp.afterResponse) res = mw(res, z, bundle);
      return res;
    },
  };
  return { z, log };
}

await test("zapier: estructura de la app (REST hooks, acciones, búsqueda, autenticación)", () => {
  assert.equal(zapApp.version, "1.0.0");
  assert.equal(zapApp.authentication.type, "custom");
  assert.equal(zapApp.authentication.test.url, `${BASE}/v1/me`);
  for (const k of ["envelope_completed", "envelope_sent", "envelope_declined", "recipient_signed", "envelope_event"]) {
    const op = zapApp.triggers[k].operation;
    assert.equal(op.type, "hook", k);
    for (const fn of ["performSubscribe", "performUnsubscribe", "perform", "performList"]) assert.equal(typeof op[fn], "function", `${k}.${fn}`);
    assert.ok(op.sample?.id, `${k}: sample`);
  }
  assert.ok(zapApp.triggers.template_list.display.hidden);
  for (const k of ["send_from_template", "send_document", "void_envelope", "remind_recipients"]) assert.ok(zapApp.creates[k].operation.sample, k);
  assert.ok(zapApp.searches.find_envelope);
  for (const group of ["triggers", "creates", "searches"]) {
    for (const [k, v] of Object.entries(zapApp[group])) {
      assert.equal(v.key, k);
      assert.ok(v.display.label && v.display.description, `${k}: display`);
    }
  }
});

await test("zapier: suscripción, evento, datos de prueba y desuscripción", async () => {
  const bundle = { authData: { apiKey: "cs_test_k" }, targetUrl: "https://hooks.zapier.com/x", inputData: {} };
  let subscribed;
  const { z, log } = fakeZ(
    {
      "POST /v1/webhooks": (req) => {
        subscribed = req.body;
        return [201, { webhook: { id: "wh1" }, secret: "whsec_x" }];
      },
      "DELETE /v1/webhooks/wh1": [204, null],
      "GET /v1/webhooks/samples?event=envelope.completed&limit=3": [200, { items: [{ id: "s1", type: "envelope.completed", data: { envelope: { id: "env9", status: "completed", recipients: [] } } }] }],
    },
    bundle,
  );
  const op = zapApp.triggers.envelope_completed.operation;
  const sub = await op.performSubscribe(z, bundle);
  assert.deepEqual(subscribed.events, ["envelope.completed"]);
  assert.equal(subscribed.url, bundle.targetUrl);
  assert.equal(log[0].headers.Authorization, "Bearer cs_test_k");
  const rows = op.perform(z, { ...bundle, cleanedRequest: { id: "e1", type: "envelope.completed", data: { envelope: { id: "env1", status: "completed", recipients: [] } } } });
  assert.equal(rows[0].envelope_id, "env1");
  assert.equal(rows[0].signed_pdf, "hydrate:env1");
  assert.deepEqual(op.perform(z, { ...bundle, cleanedRequest: { type: "webhook.test" } }), []);
  assert.deepEqual(op.perform(z, { ...bundle, cleanedRequest: { id: "e2", type: "envelope.sent", data: { envelope: {} } } }), []);
  const list = await op.performList(z, bundle);
  assert.equal(list[0].envelope_id, "env9");
  await op.performUnsubscribe(z, { ...bundle, subscribeData: sub });
  assert.equal(log.at(-1).method, "DELETE");
});

await test("zapier: enviar desde plantilla con campos dinámicos y enviar PDF (sin filtrar la API key a terceros)", async () => {
  const bundle = { authData: { apiKey: "cs_test_k" }, inputData: {} };
  const T = "0190a000-0000-7000-8000-0000000000aa";
  const R = "0190a000-0000-7000-8000-000000000001";
  const F = "0190a000-0000-7000-8000-0000000000f2";
  let sentBody;
  const { z, log } = fakeZ(
    {
      [`GET /v1/templates/${T}/input-schema`]: [200, { roles: [{ id: R, name: "Cliente" }], fields: [{ id: F, label: "Monto", type: "number" }] }],
      [`POST /v1/envelopes/from-template/${T}`]: (req) => {
        sentBody = req.body;
        return [201, { envelope: { id: "env1", status: "sent" }, recipients: [] }];
      },
      "GET https://files.example.org/a.pdf": [200, null],
      "POST /v1/envelopes": [201, { envelope: { id: "env2" } }],
      "POST /v1/envelopes/env2/documents": [201, { id: "d1", pageCount: 1 }],
      "PUT /v1/envelopes/env2/recipients": (req) => [200, { recipients: req.body.recipients.map((r, i) => ({ ...r, id: `r${i}` })) }],
      "PUT /v1/envelopes/env2/fields": [200, {}],
      "POST /v1/envelopes/env2/send": [200, {}],
      "GET /v1/envelopes/env2": [200, { envelope: { id: "env2", status: "sent" }, recipients: [] }],
      "POST /v1/envelopes/bad/void": [422, { error: { code: "not_sent", message: "El sobre no está enviado" } }],
    },
    bundle,
  );
  const dyn = zapApp.creates.send_from_template.operation.inputFields.find((f) => typeof f === "function");
  const fields = await dyn(z, { ...bundle, inputData: { templateId: T } });
  assert.deepEqual(fields.map((f) => f.key), [`role_${R}_name`, `role_${R}_email`, `role_${R}_phone`, `prefill_${F}`]);
  const out = await zapApp.creates.send_from_template.operation.perform(z, {
    ...bundle,
    inputData: { templateId: T, subject: "Hola", [`role_${R}_name`]: "Ana", [`role_${R}_email`]: "ana@x.com", [`role_${R}_phone`]: "", [`prefill_${F}`]: 150, external_id: "CRM-1" },
  });
  assert.equal(out.envelope_id, "env1");
  assert.deepEqual(sentBody, { subject: "Hola", roles: { [R]: { name: "Ana", email: "ana@x.com", phone: null } }, prefill: { [F]: "150" }, metadata: { externalId: "CRM-1" }, send: true });

  const doc = await zapApp.creates.send_document.operation.perform(z, { ...bundle, inputData: { file: "https://files.example.org/a.pdf", subject: "PDF", signers: [{ name: "Ana", email: "a@x.com" }] } });
  assert.equal(doc.status, "sent");
  const fileReq = log.find((r) => r.url === "https://files.example.org/a.pdf");
  assert.equal(fileReq.headers.Authorization, undefined, "la API key no va a URLs de terceros");
  await assert.rejects(zapApp.creates.void_envelope.operation.perform(z, { ...bundle, inputData: { envelope_id: "bad", reason: "x" } }), /no está enviado/);
});

// ───────── 5. n8n ─────────

const tgz = await readTgz(readFileSync(C("n8n/n8n-nodes-calasign-1.0.0.tgz")));
const n8nPkg = JSON.parse(tgz.get("package/package.json").toString());
const NDIR = join(TMP, "n8n");
for (const [name, data] of tgz) {
  mkdirSync(dirname(join(NDIR, name)), { recursive: true });
  writeFileSync(join(NDIR, name), data);
}
mkdirSync(join(NDIR, "package/node_modules/n8n-workflow"), { recursive: true });
writeFileSync(
  join(NDIR, "package/node_modules/n8n-workflow/index.js"),
  "class NodeOperationError extends Error {}\nmodule.exports = { NodeConnectionTypes: { Main: 'main' }, NodeOperationError };\n",
);
const nreq = createRequire(join(NDIR, "package/package.json"));

await test("n8n: paquete npm con keyword, n8n.nodes/credentials existentes y sin dependencias", () => {
  assert.ok(n8nPkg.keywords.includes("n8n-community-node-package"));
  assert.equal(n8nPkg.n8n.n8nNodesApiVersion, 1);
  assert.ok(!n8nPkg.dependencies, "sin dependencias en runtime");
  for (const f of [...n8nPkg.n8n.nodes, ...n8nPkg.n8n.credentials]) assert.ok(tgz.has(`package/${f}`), f);
  assert.ok(tgz.has("package/dist/nodes/CalaSign/calasign.svg"));
  for (const f of n8nPkg.n8n.nodes) assert.doesNotMatch(tgz.get(`package/${f}`).toString(), /require\("[^n.][^"]*quicksend/);
});

const { CalaSign } = nreq("./dist/nodes/CalaSign/CalaSign.node.js");
const { CalaSignTrigger } = nreq("./dist/nodes/CalaSignTrigger/CalaSignTrigger.node.js");
const { CalaSignApi } = nreq("./dist/credentials/CalaSignApi.credentials.js");
const { CalaSignOAuth2Api } = nreq("./dist/credentials/CalaSignOAuth2Api.credentials.js");

await test("n8n: descripciones de nodos y credenciales", () => {
  const n = new CalaSign().description;
  assert.equal(n.name, "calaSign");
  const ops = n.properties.filter((p) => p.name === "operation").flatMap((p) => p.options.map((o) => o.value));
  for (const op of ["sendFromTemplate", "sendDocument", "get", "getAll", "downloadSigned", "void", "remind"]) assert.ok(ops.includes(op), op);
  const t = new CalaSignTrigger().description;
  assert.equal(t.webhooks[0].httpMethod, "POST");
  const api = new CalaSignApi();
  assert.equal(api.properties.find((p) => p.name === "baseUrl").default, BASE);
  assert.equal(api.authenticate.properties.headers.Authorization, "=Bearer {{$credentials.apiKey}}");
  const oauth = new CalaSignOAuth2Api();
  assert.equal(oauth.properties.find((p) => p.name === "grantType").default, "pkce");
});

/** `this` simulado para n8n: parámetros fijos y helpers que registran los pedidos. */
function n8nCtx(params, routes, extra = {}) {
  const calls = [];
  const staticData = {};
  const ctx = {
    calls,
    staticData,
    getNodeParameter: (name, _i, def) => (name in params ? params[name] : def),
    getCurrentNodeParameter: (name) => params[name],
    getCredentials: async () => ({ apiKey: "cs_test_k", baseUrl: BASE }),
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => "https://n8n.example.org/webhook/abc",
    getWorkflow: () => ({ id: "w1", name: "Flujo" }),
    getNode: () => ({ name: "CalaSign" }),
    getInputData: () => [{ json: {}, binary: { data: { fileName: "doc.pdf" } } }],
    continueOnFail: () => false,
    logs: [],
    // En n8n real, this.logger existe en todos los contextos (los catch de los webhooks lo usan).
    logger: { debug(msg, meta) { ctx.logs.push(["debug", msg, meta]); }, warn(msg, meta) { ctx.logs.push(["warn", msg, meta]); } },
    helpers: {
      httpRequestWithAuthentication: async (cred, opts) => {
        calls.push({ cred, ...opts });
        const key = `${opts.method} ${opts.url.replace(BASE, "")}`;
        // `in`, no `!r`: una ruta que responde "" (DELETE) es válida.
        if (!(key in routes)) throw new Error(`n8n: sin ruta ${key}`);
        const r = routes[key];
        return typeof r === "function" ? r(opts) : r;
      },
      assertBinaryData: () => ({ fileName: "doc.pdf" }),
      getBinaryDataBuffer: async () => Buffer.from("%PDF-n8n"),
      prepareBinaryData: async (buf, name, mime) => ({ data: buf.toString("base64"), fileName: name, mimeType: mime }),
      returnJsonArray: (x) => [{ json: x }],
    },
    ...extra,
  };
  return ctx;
}

await test("n8n: trigger crea y borra el webhook y verifica la firma HMAC", async () => {
  const node = new CalaSignTrigger();
  const ctx = n8nCtx(
    { authentication: "apiKey", events: ["envelope.completed"], simplify: true },
    { "POST /v1/webhooks": { webhook: { id: "wh7" }, secret: "whsec_s" }, "DELETE /v1/webhooks/wh7": "" },
  );
  assert.equal(await node.webhookMethods.default.checkExists.call(ctx), false);
  await node.webhookMethods.default.create.call(ctx);
  assert.deepEqual(ctx.calls[0].body.events, ["envelope.completed"]);
  assert.equal(ctx.calls[0].cred, "calaSignApi");
  assert.equal(ctx.staticData.webhookId, "wh7");

  const body = { id: "e1", type: "envelope.completed", data: { envelope: { id: "env1", status: "completed", recipients: [] } } };
  const raw = Buffer.from(JSON.stringify(body));
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", "whsec_s").update(`${t}.${raw}`).digest("hex")}`;
  let status = 0;
  const hookCtx = (signature) => ({
    ...ctx,
    getRequestObject: () => ({ rawBody: raw, headers: { "calasign-signature": signature } }),
    getResponseObject: () => ({ status: (s) => ((status = s), { json: () => {} }) }),
    getBodyData: () => body,
  });
  const ok = await node.webhook.call(hookCtx(sig));
  assert.equal(ok.workflowData[0][0].json.envelope_id, "env1");
  const bad = await node.webhook.call(hookCtx(`t=${t},v1=${"0".repeat(64)}`));
  assert.equal(bad.noWebhookResponse, true);
  assert.equal(status, 401);
  await node.webhookMethods.default.delete.call(ctx);
  assert.equal(ctx.calls.at(-1).method, "DELETE");
  assert.equal(ctx.staticData.webhookId, undefined);
  assert.deepEqual(ctx.logs.filter(([, m]) => /borrar/.test(m)), [], `el borrado no debe fallar: ${JSON.stringify(ctx.logs)}`);
});

await test("n8n: enviar desde plantilla, enviar PDF y descargar el firmado", async () => {
  const node = new CalaSign();
  let body;
  const ctx = n8nCtx(
    {
      authentication: "oAuth2",
      resource: "envelope",
      operation: "sendFromTemplate",
      templateId: "tpl1",
      roles: { role: [{ role: "r1", name: "Ana", email: "ana@x.com", phone: "" }] },
      prefill: { field: [{ field: "f1", value: "ACME" }] },
      additionalFields: { externalId: "X9" },
    },
    { "POST /v1/envelopes/from-template/tpl1": (o) => ((body = o.body), { envelope: { id: "env1" } }) },
  );
  const [out] = await node.execute.call(ctx);
  assert.equal(out[0].json.envelope.id, "env1");
  assert.equal(ctx.calls[0].cred, "calaSignOAuth2Api");
  assert.deepEqual(body, { roles: { r1: { name: "Ana", email: "ana@x.com", phone: null } }, prefill: { f1: "ACME" }, send: true, metadata: { externalId: "X9" } });

  const ctx2 = n8nCtx(
    { authentication: "apiKey", resource: "envelope", operation: "sendDocument", binaryPropertyName: "data", subject: "PDF", signers: { signer: [{ name: "Ana", email: "a@x.com" }] }, placement: "auto", additionalFields: {} },
    {
      "POST /v1/envelopes": { envelope: { id: "e2" } },
      "POST /v1/envelopes/e2/documents": (o) => (assert.ok(Buffer.isBuffer(o.body) && o.json === false), { id: "d", pageCount: 2 }),
      "PUT /v1/envelopes/e2/recipients": (o) => ({ recipients: o.body.recipients.map((r) => ({ ...r, id: "r1" })) }),
      "PUT /v1/envelopes/e2/fields": {},
      "POST /v1/envelopes/e2/send": {},
      "GET /v1/envelopes/e2": { envelope: { id: "e2", status: "sent" } },
    },
  );
  const [out2] = await node.execute.call(ctx2);
  assert.equal(out2[0].json.envelope.status, "sent");

  const ctx3 = n8nCtx(
    { authentication: "apiKey", resource: "envelope", operation: "downloadSigned", envelopeId: "e2", outputBinaryPropertyName: "pdf" },
    { "GET /v1/envelopes/e2/signed.pdf": Buffer.from("%PDF-signed") },
  );
  const [out3] = await node.execute.call(ctx3);
  assert.equal(out3[0].binary.pdf.mimeType, "application/pdf");
  assert.equal(ctx3.calls[0].encoding, "arraybuffer");
});

// ───────── 6. Make ─────────

const make = JSON.parse(readFileSync(C("make/calasign-make-app.json"), "utf8"));
const makeZip = readZip(readFileSync(C("make/calasign-make-app.zip")));

await test("make: componentes, referencias rpc/webhook/funciones e IML balanceado", () => {
  assert.ok(makeZip.has("makecomapp.json") && makeZip.has("base.imljson"));
  const text = JSON.stringify(make);
  for (const [, rpc] of text.matchAll(/rpc:\/\/(\w+)/g)) assert.ok(make.rpcs[rpc], `rpc ${rpc}`);
  for (const m of Object.values(make.modules)) {
    if (m.webhook) assert.ok(make.webhooks[m.webhook], m.webhook);
    for (const k of ["connection", "altConnection"]) assert.ok(make.connections[m[k]], `${m.label}: ${k}`);
    assert.ok(["action", "search", "instant_trigger", "trigger"].includes(m.typeId));
    assert.ok(Array.isArray(m.interface) && m.interface.length, `${m.label}: interface`);
  }
  for (const [, fn] of text.matchAll(/\{\{[^}]*?\b(calasign\w+)\(/g)) assert.ok(make.functions.includes(fn), `función ${fn}`);
  (function walk(n, where) {
    if (typeof n === "string") {
      const open = (n.match(/\{\{/g) ?? []).length;
      const close = (n.match(/\}\}/g) ?? []).length;
      assert.equal(open, close, `IML desbalanceado en ${where}: ${n}`);
    } else if (Array.isArray(n)) n.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) if (k !== "functionsCode") walk(v, `${where}.${k}`);
  })(make, "app");
  assert.equal(make.base.baseUrl, BASE);
  assert.match(make.connections["calasign-oauth"].communication.authorize.qs.code_challenge_method, /^S256$/);
});

await test("make: funciones IML (formulario de plantilla, destinatarios y campos)", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  for (const code of Object.values(make.functionsCode)) vm.runInContext(code, sandbox);
  const form = sandbox.calasignTemplateForm({ roles: [{ id: "r1", name: "Cliente" }], fields: [{ id: "f1", label: "Plan", type: "dropdown", options: ["A", "B"], roleName: "Cliente" }] });
  assert.equal(form[0].name, "roles");
  assert.equal(form[0].spec[0].name, "r1");
  assert.equal(form[1].spec[0].type, "select");
  const recips = sandbox.calasignRecipients([{ name: "A", email: "a@x.com" }, { name: "B", phone: "+18095551234" }], true);
  assert.deepEqual(JSON.parse(JSON.stringify(recips.map((r) => [r.routingOrder, r.channels]))), [[1, ["email"]], [2, ["whatsapp"]]]);
  const fields = sandbox.calasignFields([{ id: "r1", role: "signer" }, { id: "c", role: "cc" }, { id: "r2", role: "signer" }], "d1", 4, "auto");
  assert.equal(fields.length, 2);
  assert.ok(fields.every((f) => f.page === 3 && f.x + f.width <= 1 && f.y + f.height <= 1));
  assert.equal(sandbox.calasignFields([{ id: "r1", role: "signer" }], "d1", 1, "anchors")[0].anchor.text, "\\firma1\\");
  assert.equal(sandbox.calasignFlattenEvent({ id: "e", type: "envelope.completed", data: { envelope: { id: "x", recipients: [] } } }).envelope_id, "x");
});

// ───────── 7. Dynamics 365 ─────────

await test("dynamics 365: web resource (enviar a firmar / ver en CalaSign) con Xrm simulado", async () => {
  const code = readFileSync(C("dynamics365/webresources/calasign_commands.js"), "utf8");
  const opened = [];
  const sandbox = { Xrm: { Navigation: { openUrl: (u) => opened.push(u) } }, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const CS = sandbox.module.exports;
  const values = { calasign_sendforsignature: false, calasign_status: null, calasign_envelopeid: null };
  const notes = [];
  let saved = 0;
  const form = {
    getAttribute: (n) => (n in values ? { getValue: () => values[n], setValue: (v) => (values[n] = v) } : null),
    ui: { getFormType: () => 2, setFormNotification: (t, l) => notes.push(l) },
    data: { save: async () => saved++ },
  };
  assert.equal(CS.canSend(form), true);
  assert.equal(CS.canOpen(form), false);
  assert.equal(await CS.sendForSignature(form), true);
  assert.equal(values.calasign_sendforsignature, true);
  assert.equal(values.calasign_status, "requested");
  assert.equal(saved, 1);
  assert.equal(CS.canSend(form), false, "no se reenvía con un sobre en curso");
  assert.equal(await CS.sendForSignature(form), false);
  values.calasign_envelopeid = "env1";
  assert.equal(CS.openEnvelope(form), true);
  assert.equal(opened[0], `${BASE}/app/envelopes/env1`);
  values.calasign_status = "declined";
  assert.equal(CS.canSend(form), true);
  const noCols = { getAttribute: () => null, ui: form.ui, data: form.data };
  assert.equal(CS.canSend(noCols), false);
});

await test("dynamics 365: setup-dataverse crea publicador, solución, columnas y web resource (idempotente)", async () => {
  const mod = await import(pathToFileURL(C("dynamics365/setup-dataverse.mjs")).href);
  const state = { publisher: false, solution: false, attrs: new Set(), wr: false };
  const calls = [];
  const call = async (method, path, body, headers) => {
    calls.push({ method, path, body, headers });
    if (method === "GET" && path.startsWith("/publishers")) return { value: state.publisher ? [{ publisherid: "p1" }] : [] };
    if (method === "GET" && path.startsWith("/solutions")) return { value: state.solution ? [{ solutionid: "s1" }] : [] };
    if (method === "GET" && path.includes("/Attributes(")) return state.attrs.has(path.match(/Attributes\(LogicalName='(\w+)'\)/)[1]) ? { LogicalName: "x" } : null;
    if (method === "GET" && path.startsWith("/webresourceset")) return { value: state.wr ? [{ webresourceid: "w1" }] : [] };
    if (method === "POST" && path === "/publishers") return (state.publisher = true), {};
    if (method === "POST" && path === "/solutions") return (state.solution = true), {};
    if (method === "POST" && path.endsWith("/Attributes")) return state.attrs.add(body.SchemaName.toLowerCase()), {};
    if (method === "POST" && path === "/webresourceset") return (state.wr = true), {};
    if (method === "PATCH" || path === "/PublishXml") return {};
    throw new Error(`dataverse: ${method} ${path}`);
  };
  const done = await mod.setup({ call, tables: ["opportunity"], webResource: "var CalaSign = 1;", log: () => {} });
  assert.ok(done.includes("columna opportunity.calasign_sendforsignature"));
  assert.equal(state.attrs.size, 5);
  const attrPost = calls.find((c) => c.method === "POST" && c.path.endsWith("/Attributes"));
  assert.equal(attrPost.headers["MSCRM.SolutionUniqueName"], "CalaSign");
  assert.equal(calls.find((c) => c.path === "/solutions" && c.method === "POST").body["publisherid@odata.bind"], "/publishers(p1)");
  const wr = calls.find((c) => c.path === "/webresourceset" && c.method === "POST").body;
  assert.equal(wr.webresourcetype, 3);
  assert.equal(Buffer.from(wr.content, "base64").toString(), "var CalaSign = 1;");
  calls.length = 0;
  const again = await mod.setup({ call, tables: ["opportunity"], webResource: "v2", log: () => {} });
  assert.ok(!calls.some((c) => c.method === "POST" && c.path !== "/PublishXml"), "segunda corrida sin altas");
  assert.ok(again.some((x) => x.includes("actualizado")));
});

await test("dynamics 365: flujos con JSON válido que usan las operaciones del conector", () => {
  const ops = new Set(Object.values(swagger.paths).flatMap((p) => Object.values(p).map((o) => o.operationId).filter(Boolean)));
  for (const f of ["calasign-send-on-request.json", "calasign-sync-status.json"]) {
    const flow = JSON.parse(readFileSync(C(`dynamics365/flows/${f}`), "utf8"));
    const used = [...JSON.stringify(flow).matchAll(/"apiId":"[^"]*shared_calasign","connectionName":"shared_calasign","operationId":"(\w+)"/g)].map((m) => m[1]);
    assert.ok(used.length > 0, f);
    for (const op of used) assert.ok(ops.has(op), `${f}: ${op}`);
  }
});

// ───────── 8. Pipedrive (acción de app sobre el conector nativo) ─────────

await test("pipedrive: registrado, zip con la acción y app-extensions.json con las URLs de esta base", () => {
  const idx = JSON.parse(readFileSync(C("index.json"), "utf8"));
  const pd = idx.connectors.find((c) => c.id === "pipedrive");
  assert.ok(pd, "pipedrive en connectors/index.json");
  assert.deepEqual(pd.artifacts, ["/integrations/connectors/pipedrive/calasign-pipedrive.zip"]);
  const zip = readZip(readFileSync(C("pipedrive/calasign-pipedrive.zip")));
  for (const f of ["README.md", "app-extensions.json", "send.html", "send.js", "send.css"]) assert.ok(zip.has(f), f);
  const ext = JSON.parse(readFileSync(C("pipedrive/app-extensions.json"), "utf8"));
  assert.equal(ext.app.callbackUrl, `${BASE}/v1/crm/oauth/pipedrive/callback`);
  assert.equal(ext.appExtensions.linkActions[0].url, `${BASE}/integrations/connectors/pipedrive/send.html`);
  const html = readFileSync(C("pipedrive/send.html"), "utf8");
  assert.match(html, /<script src="send\.js\?v=[^"]+" defer><\/script>/);
  assert.doesNotMatch(html, /<script>|<style>|style="/, "sin scripts ni estilos en línea (CSP de helmet)");
});

await test("pipedrive: la acción lee los ids, filtra mapeos y envía uno por registro con la sesión", async () => {
  const PD = require(C("pipedrive/send.js"));
  assert.deepEqual(PD.parseParams("?resource=deal&view=list&selectedIds=42,43,42,x1&companyId=5150&token=jwt"), {
    resource: "deal",
    objectType: "deal",
    ids: ["42", "43"],
    truncated: false,
    companyId: "5150",
  });
  assert.equal(PD.parseParams("?resource=person&selectedIds=8").objectType, "contact");
  assert.equal(PD.parseParams("?resource=organization&selectedIds=8").objectType, null);
  assert.equal(PD.parseParams(`?resource=deal&selectedIds=${Array.from({ length: 25 }, (_, i) => i + 1).join(",")}`).ids.length, 20);
  assert.equal(PD.lang({ language: "pt-BR" }), "pt");
  assert.equal(PD.lang({ language: "en-US" }), "en");

  const calls = [];
  const mappings = [
    { id: "m1", name: "Deals", objectType: "deal", templateId: "t1", active: true, send: true },
    { id: "m2", name: "Inactivo", objectType: "deal", templateId: "t1", active: false, send: true },
    { id: "m3", name: "Personas", objectType: "contact", templateId: "t1", active: true, send: false },
    { id: "m4", name: "Sin plantilla", objectType: "deal", templateId: null, active: true, send: true },
  ];
  let loggedIn = true;
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, credentials: init.credentials, body: init.body ? JSON.parse(init.body) : null });
    const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (!loggedIn) return res(401, { error: { code: "unauthorized", message: "Sin sesión" } });
    if (url === `${BASE}/v1/crm/mappings?provider=pipedrive`) return res(200, { items: mappings });
    const m = url.match(/\/v1\/crm\/mappings\/(\w+)\/send$/);
    if (m && init.body) {
      const b = JSON.parse(init.body);
      if (b.objectId === "43") return res(404, { error: { code: "crm_record_not_found", message: "Deal not found" } });
      return res(201, { envelopeId: `env-${b.objectId}`, status: b.send ? "sent" : "draft" });
    }
    return res(404, { error: { message: "?" } });
  };
  const api = PD.apiFactory(fakeFetch, BASE);
  const ready = await PD.load(api, PD.parseParams("?resource=deal&selectedIds=42,43"));
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.mappings.map((x) => x.id), ["m1"]);
  assert.equal(calls[0].credentials, "include");
  const out = await PD.sendAll(api, "m1", ["42", "43"], true);
  assert.deepEqual(out, [
    { id: "42", ok: true, envelopeId: "env-42", status: "sent" },
    { id: "43", ok: false, error: "Deal not found", code: "crm_record_not_found" },
  ]);
  assert.deepEqual(calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body]), [
    [`${BASE}/v1/crm/mappings/m1/send`, { objectId: "42", send: true }],
    [`${BASE}/v1/crm/mappings/m1/send`, { objectId: "43", send: true }],
  ]);
  assert.equal((await PD.load(api, PD.parseParams("?resource=person&selectedIds=8"))).mappings[0].id, "m3");
  assert.equal((await PD.load(api, PD.parseParams("?resource=deal"))).key, "noRecords");
  assert.equal((await PD.load(api, PD.parseParams("?resource=lead&selectedIds=1"))).key, "badResource");
  mappings.length = 0;
  assert.equal((await PD.load(api, PD.parseParams("?resource=deal&selectedIds=42"))).key, "noMappings");
  loggedIn = false;
  assert.equal((await PD.load(api, PD.parseParams("?resource=deal&selectedIds=42"))).state, "login");
});

// ───────── Zoho CRM ─────────

await test("zoho crm: zip con la función Deluge del botón (endpoint del conector nativo, bloques balanceados)", () => {
  const zip = readZip(readFileSync(C("zoho-crm/calasign-zoho-crm.zip")));
  const names = [...zip.keys()];
  for (const f of ["README.md", "deluge/enviar_a_firmar.deluge.txt"]) assert.ok(names.includes(f), f);
  const dg = readFileSync(C("zoho-crm/deluge/enviar_a_firmar.deluge.txt"), "utf8");
  assert.ok(!dg.includes("{{"), "sin variables sin reemplazar");
  assert.ok(dg.includes(`baseUrl = "${BASE}";`), "URL de CalaSign por defecto");
  assert.match(dg, /url :baseUrl \+ "\/v1\/crm\/mappings\/" \+ mappingId \+ "\/send"/);
  assert.match(dg, /connection:"calasign"/);
  assert.match(dg, /body\.put\("objectId",dealId\.toString\(\)\)/);
  // Primero los textos (pueden traer "//", como las URLs) y después los comentarios.
  const code = dg.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\/.*$/gm, "");
  for (const [o, c] of [["{", "}"], ["(", ")"], ["[", "]"]]) assert.equal(code.split(o).length, code.split(c).length, `${o}${c} balanceados`);
  for (const line of code.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (/^(if|else|url|type|parameters|headers|connection|detailed)\b|^[{}[\]];?$|[{[]$|= invokeurl$/.test(line)) continue;
    assert.ok(line.endsWith(";"), `sentencia sin ";": ${line}`);
  }
});

await test("web: los enlaces de /developers/connectors y de /integrations/ apuntan a artefactos construidos", () => {
  const constants = readFileSync(join(HERE, "../../apps/web/src/pages/developers/constants.ts"), "utf8");
  const block = /CONNECTOR_ARTIFACTS = \{([\s\S]*?)\} as const/.exec(constants)[1];
  const paths = [...block.matchAll(/"(\/integrations\/connectors\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length >= 7);
  const site = readFileSync(join(OUT, "index.html"), "utf8");
  for (const [, p] of site.matchAll(/href="(\/integrations\/connectors\/[^"]+)"/g)) paths.push(p);
  for (const p of paths) assert.ok(existsSync(join(OUT, p.replace("/integrations/", ""))), p);
});

rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} prueba(s) de conectores fallaron`);
  process.exit(1);
}
console.log("\nConectores: todas las pruebas pasaron");
