#!/usr/bin/env node
// Prueba de punta a punta de Fase 4 (escala): lógica condicional y campos calculados (validados en el servidor,
// incluso con valores adulterados), envío masivo desde CSV (25 filas, 2 inválidas, progreso, resultados,
// cancelación) y formularios web públicos (antibots, firma en la misma sesión, límite de usos, OTP, embebido).
// Uso: node scripts/e2e-scale.mjs [baseUrl]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
// Fuera de local la API solo acepta orígenes https para embeber.
const EMBED_ORIGIN = BASE.startsWith("https://") ? "https://partner.example.com" : "http://localhost:5199";
let cookie = "";

async function api(method, path, body, { raw = false, expect, anon = false } = {}) {
  const h = {};
  if (cookie && !anon) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set && set.startsWith("cs_session") && !anon) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (expect !== undefined) {
    if (res.status !== expect) throw new Error(`${method} ${path} → esperaba ${expect}, vino ${res.status} ${text.slice(0, 400)}`);
    return data;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return data;
}

const step = (m) => console.log(`✓ ${m}`);
const assert = (c, m) => {
  if (!c) throw new Error(`falló: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function tinyPdf(pages, label) {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  const fontObj = 3 + pages * 2;
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 18 Tf 72 760 Td (${label} - pagina ${i + 1}) Tj ET`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
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

async function linkFor(text) {
  for (let i = 0; i < 60; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(text) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${text}`);
}

async function waitStatus(envelopeId, status, secs = 60) {
  let d;
  for (let i = 0; i < secs * 2; i++) {
    d = await api("GET", `/v1/envelopes/${envelopeId}`);
    if (d.envelope.status === status) return d;
    await sleep(500);
  }
  throw new Error(`el sobre ${envelopeId} no llegó a ${status} (quedó ${d?.envelope.status})`);
}

const stamp = Date.now();
await api("POST", "/v1/auth/signup", {
  name: "Ana Remitente",
  email: `ana+scale${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `Financiera Demo ${stamp}`,
  locale: "es",
});
step("alta de cuenta");

// ───────────────────────────── Plantilla con lógica ─────────────────────────────

const { template } = await api("POST", "/v1/templates", { name: `Solicitud de crédito ${stamp}`, subject: "Solicitud de crédito" });
const tfd = new FormData();
tfd.append("file", new Blob([tinyPdf(2, "Solicitud")], { type: "application/pdf" }), "solicitud.pdf");
const tdoc = await api("POST", `/v1/templates/${template.id}/documents`, tfd);
const rCliente = randomUUID();
const rEmpresa = randomUUID();
await api("PUT", `/v1/templates/${template.id}/roles`, {
  roles: [
    { id: rCliente, name: "Cliente", role: "signer", routingOrder: 1 },
    { id: rEmpresa, name: "Empresa", role: "signer", routingOrder: 2 },
  ],
});
const id = {
  garante: randomUUID(),
  nombreGarante: randomUUID(),
  precio: randomUUID(),
  cantidad: randomUUID(),
  total: randomUUID(),
  plan: randomUUID(),
  detalleAnual: randomUUID(),
  firmaCliente: randomUUID(),
  firmaEmpresa: randomUUID(),
};
const F = (o) => ({ documentId: tdoc.id, page: 0, width: 0.3, height: 0.03, x: 0.1, ...o });
const baseFields = [
  F({ id: id.garante, roleId: rCliente, type: "checkbox", y: 0.1, width: 0.03, height: 0.02, label: "Tiene garante", required: false }),
  F({ id: id.nombreGarante, roleId: rCliente, type: "text", y: 0.15, label: "Nombre del garante", conditions: [{ fieldId: id.garante, operator: "checked" }] }),
  F({ id: id.precio, roleId: rCliente, type: "number", y: 0.2, label: "Precio" }),
  F({ id: id.cantidad, roleId: rCliente, type: "number", y: 0.25, label: "Cantidad" }),
  F({ id: id.total, roleId: rCliente, type: "number", y: 0.3, label: "Total", formula: "({Precio} * {Cantidad}) * 1,21" }),
  F({ id: id.plan, roleId: rCliente, type: "dropdown", y: 0.35, label: "Plan", options: ["Mensual", "Anual"] }),
  F({ id: id.detalleAnual, roleId: rCliente, type: "text", y: 0.4, label: "Detalle anual", conditions: [{ fieldId: id.plan, operator: "equals", value: "Anual" }] }),
  F({ id: id.firmaCliente, roleId: rCliente, type: "signature", page: 1, y: 0.7, height: 0.08 }),
  F({ id: id.firmaEmpresa, roleId: rEmpresa, type: "signature", page: 1, x: 0.55, y: 0.7, height: 0.08 }),
];

// Validaciones de la lógica al guardar.
await api("PUT", `/v1/templates/${template.id}/fields`, { fields: [...baseFields.filter((f) => f.id !== id.total), F({ id: id.total, roleId: rCliente, type: "number", y: 0.3, label: "Total", formula: "{Precio} * {Inexistente}" })] }, { expect: 400 });
await api("PUT", `/v1/templates/${template.id}/fields`, { fields: [...baseFields.filter((f) => f.id !== id.total), F({ id: id.total, roleId: rCliente, type: "number", y: 0.3, label: "Total", formula: "{Total} + 1" })] }, { expect: 400 });
await api("PUT", `/v1/templates/${template.id}/fields`, { fields: [...baseFields.filter((f) => f.id !== id.total), F({ id: id.total, roleId: rCliente, type: "number", y: 0.3, label: "Total", formula: "{Precio} * (2" })] }, { expect: 400 });
await api(
  "PUT",
  `/v1/templates/${template.id}/fields`,
  {
    fields: baseFields.map((f) =>
      f.id === id.garante ? { ...f, conditions: [{ fieldId: id.nombreGarante, operator: "filled" }] } : f,
    ),
  },
  { expect: 400 }, // ciclo garante ↔ nombre del garante
);
await api("PUT", `/v1/templates/${template.id}/fields`, { fields: [F({ id: id.garante, roleId: rCliente, type: "checkbox", y: 0.1, width: 0.03, height: 0.02, conditions: [{ fieldId: id.garante, operator: "checked" }] })] }, { expect: 400 });
const tpl = await api("PUT", `/v1/templates/${template.id}/fields`, { fields: baseFields });
const tTotal = tpl.fields.find((f) => f.id === id.total);
assert(tTotal.formula && tTotal.required === false, "el campo calculado no es obligatorio para el firmante");
assert(tpl.fields.find((f) => f.id === id.nombreGarante).conditions[0].fieldId === id.garante, "condición guardada");
step("plantilla con condiciones y fórmula; fórmulas inválidas, autorreferencias y ciclos rechazados (400)");

// ───────────────────────────── Envío masivo ─────────────────────────────

const skeleton = await (await api("GET", `/v1/templates/${template.id}/bulk-csv`, null, { raw: true })).text();
const header = skeleton.replace(/^﻿/, "").split("\r\n")[0];
assert(header.includes("Cliente.email") && header.includes("Empresa.name") && header.includes("field.Precio") && !header.includes("field.Total"), `CSV de ejemplo: ${header}`);

const ROWS = 25;
const lines = ["subject;Cliente.name;Cliente.email;Cliente.channels;Empresa.name;Empresa.email;field.Precio;field.Cantidad;field.Plan"];
for (let i = 1; i <= ROWS; i++) {
  let email = `cliente${i}.${stamp}@example.com`;
  let name = `Cliente ${i} ${stamp}`;
  if (i === 7) email = "no-es-un-correo";
  if (i === 19) name = "";
  lines.push(`Solicitud ${i};"${name}";${email};email;"Empresa, Rep ${stamp}";empresa.${stamp}@example.com;${100 + i};${i % 5 === 0 ? "" : 2};Mensual`);
}
const csv = "﻿" + lines.join("\r\n") + "\r\n";

const val = await api("POST", "/v1/bulk-sends/validate", { templateId: template.id, csv });
assert(val.total === ROWS && val.invalid === 2 && val.errors.map((e) => e.row).join(",") === "7,19", `validación: ${JSON.stringify(val.errors)}`);
const rejected = await api("POST", "/v1/bulk-sends", { templateId: template.id, csv }, { expect: 422 });
assert(rejected.error.details.invalid === 2, "sin skipInvalid → 422 con el detalle");
await api("POST", "/v1/bulk-sends/validate", { templateId: template.id, csv: "Cliente.email;Desconocido.name\r\na@b.com;x\r\n" }, { expect: 422 });
step(`CSV de ejemplo y validación previa: ${val.valid} filas válidas, filas 7 y 19 con error; columnas desconocidas → 422`);

let bulk = await api("POST", "/v1/bulk-sends", { templateId: template.id, csv, skipInvalid: true, name: "Campaña octubre", message: "Firmá tu solicitud" });
assert(bulk.total === ROWS && bulk.failed === 2, "creado con 2 filas fallidas");
for (let i = 0; i < 120 && bulk.status !== "completed"; i++) {
  await sleep(500);
  bulk = await api("GET", `/v1/bulk-sends/${bulk.id}`);
}
assert(bulk.status === "completed" && bulk.sent === ROWS - 2 && bulk.failed === 2 && bulk.pending === 0, `progreso final: ${JSON.stringify(bulk)}`);
const { items: failedItems } = await api("GET", `/v1/bulk-sends/${bulk.id}/items?status=failed`);
assert(failedItems.length === 2 && failedItems.every((x) => x.error), "filas fallidas con motivo");
const { items: sentItems, total: sentTotal } = await api("GET", `/v1/bulk-sends/${bulk.id}/items?status=sent&limit=100`);
assert(sentTotal === ROWS - 2 && new Set(sentItems.map((x) => x.envelopeId)).size === ROWS - 2, "un sobre distinto por fila");
const results = await (await api("GET", `/v1/bulk-sends/${bulk.id}/results.csv`, null, { raw: true })).text();
assert(results.trim().split("\r\n").length === ROWS + 1 && results.includes("failed"), "CSV de resultados");
const env1 = await api("GET", `/v1/envelopes/${sentItems[0].envelopeId}`);
assert(env1.envelope.status === "sent" && env1.envelope.metadata.bulkSendId === bulk.id && env1.envelope.subject === "Solicitud 1", "sobre del envío masivo enviado, con asunto por fila");
assert(env1.fields.find((f) => f.label === "Precio").value === "101", "prellenado por fila");
step(`envío masivo: ${bulk.sent} sobres enviados por la cola, 2 fallidos, resultados en CSV`);

// Cancelación: el lote grande se corta y el resto queda cancelado.
const bigRows = Array.from({ length: 60 }, (_, i) => ({
  recipients: [
    { role: "Cliente", name: `Masivo ${i} ${stamp}`, email: `m${i}.${stamp}@example.com` },
    { role: "Empresa", name: "Empresa", email: `empresa.${stamp}@example.com` },
  ],
  prefill: { Precio: "10", Cantidad: "1", Plan: "Anual" },
}));
let big = await api("POST", "/v1/bulk-sends", { templateId: template.id, rows: bigRows });
big = await api("POST", `/v1/bulk-sends/${big.id}/cancel`);
assert(big.status === "cancelled", "cancelado");
await sleep(2500);
big = await api("GET", `/v1/bulk-sends/${big.id}`);
assert(big.status === "cancelled" && big.sent + big.cancelled + big.failed === 60 && big.cancelled > 0, `cancelación: ${JSON.stringify(big)}`);
await api("POST", `/v1/bulk-sends/${big.id}/cancel`, null, { expect: 409 });
step(`cancelación de un envío de 60 filas: ${big.sent} alcanzaron a salir, ${big.cancelled} cancelados`);

// Una API key con rol miembro (sin envelopes:view_all) ve y opera los sobres de SU envío masivo.
{
  const { secret } = await api("POST", "/v1/api-keys", { name: `masivo miembro ${stamp}`, role: "member" });
  const keyApi = async (method, path, body, expect = 200) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.status !== expect) throw new Error(`${method} ${path} (API key) → esperaba ${expect}, vino ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  let kb = await keyApi("POST", "/v1/bulk-sends", { templateId: template.id, rows: bigRows.slice(0, 1) }, 201);
  for (let i = 0; i < 60 && kb.status !== "completed"; i++) {
    await sleep(500);
    kb = await keyApi("GET", `/v1/bulk-sends/${kb.id}`);
  }
  assert(kb.status === "completed" && kb.sent === 1, `envío masivo por API key: ${JSON.stringify(kb)}`);
  const { items: keyItems } = await keyApi("GET", `/v1/bulk-sends/${kb.id}/items?status=sent`);
  const keyEnv = await keyApi("GET", `/v1/envelopes/${keyItems[0].envelopeId}`);
  assert(keyEnv.envelope.metadata.bulkSendId === kb.id, "la API key ve el sobre de su envío masivo");
  const keyList = await keyApi("GET", "/v1/envelopes?limit=100");
  assert(keyList.items.some((x) => x.id === keyEnv.envelope.id), "el sobre aparece en el listado de la API key");
  await keyApi("POST", `/v1/envelopes/${keyEnv.envelope.id}/void`, { reason: "prueba" });
  step("API key con rol miembro: ve, lista y anula los sobres de su propio envío masivo");
}

// ───────────────────────────── Lógica en /complete ─────────────────────────────

const e1 = sentItems[0].envelopeId;
const tok1 = await linkFor(`Cliente 1 ${stamp}`);
let sess = await api("GET", `/v1/signing/${tok1}`, null, { anon: true });
const byLabel = (s, l) => s.fields.find((f) => f.label === l);
await api("POST", `/v1/signing/${tok1}/consent`, null, { anon: true });
// Garante marcado pero sin nombre → 422 (la condición lo vuelve obligatorio).
await api(
  "POST",
  `/v1/signing/${tok1}/complete`,
  {
    fields: [
      { id: byLabel(sess, "Tiene garante").id, value: "true" },
      { id: byLabel(sess, "Precio").id, value: "100" },
      { id: byLabel(sess, "Cantidad").id, value: "3" },
      { id: byLabel(sess, "Plan").id, value: "Mensual" },
    ],
    signature: { kind: "drawn", imagePng: PNG },
  },
  { expect: 422, anon: true },
);
// Sin garante: el nombre no se exige. Valores adulterados: Total (calculado) y Detalle anual (oculto) se ignoran.
sess = await api(
  "POST",
  `/v1/signing/${tok1}/complete`,
  {
    fields: [
      { id: byLabel(sess, "Tiene garante").id, value: "false" },
      { id: byLabel(sess, "Precio").id, value: "100" },
      { id: byLabel(sess, "Cantidad").id, value: "3" },
      { id: byLabel(sess, "Total").id, value: "1" },
      { id: byLabel(sess, "Plan").id, value: "Mensual" },
      { id: byLabel(sess, "Detalle anual").id, value: "ADULTERADO" },
    ],
    signature: { kind: "drawn", imagePng: PNG },
  },
  { anon: true },
);
assert(sess.recipient.status === "signed", "cliente firmó");
let d1 = await api("GET", `/v1/envelopes/${e1}`);
assert(d1.fields.find((f) => f.label === "Total").value === "363", `fórmula calculada en el servidor: ${d1.fields.find((f) => f.label === "Total").value}`);
assert(d1.fields.find((f) => f.label === "Detalle anual").value === null, "campo oculto sin valor");
assert(d1.fields.find((f) => f.label === "Nombre del garante").value === null, "campo condicional oculto vacío");

// La invitación de la Empresa del sobre 1 (todas las filas comparten la Empresa: se busca la de este sobre).
const recEmp = d1.recipients.find((r) => r.routingOrder === 2);
let tokE = null;
for (let i = 0; i < 40 && !tokE; i++) {
  const { items } = await api("GET", "/dev/mailbox");
  for (const m of items.filter((x) => x.link?.includes("/s/") && x.text.includes(`Oficial`) === false && x.to === `empresa.${stamp}@example.com`)) {
    const t = m.link.split("/s/")[1];
    const s = await api("GET", `/v1/signing/${t}`, null, { anon: true });
    if (s.envelope.id === e1 && s.recipient.id === recEmp.id) tokE = t;
  }
  if (!tokE) await sleep(500);
}
assert(tokE, "invitación de la empresa");
await api("POST", `/v1/signing/${tokE}/consent`, null, { anon: true });
await api("POST", `/v1/signing/${tokE}/complete`, { fields: [], signature: { kind: "typed", imagePng: PNG, text: "Empresa" } }, { anon: true });
d1 = await waitStatus(e1, "completed");
const pdf = Buffer.from(await (await api("GET", `/v1/envelopes/${e1}/signed.pdf`, null, { raw: true })).arrayBuffer());
mkdirSync("var", { recursive: true });
writeFileSync("var/e2e-scale-signed.pdf", pdf);
let pdfText = "";
try {
  pdfText = execFileSync("pdftotext", ["var/e2e-scale-signed.pdf", "-"], { encoding: "utf8" });
} catch {
  pdfText = "";
}
if (pdfText) assert(pdfText.includes("363") && !pdfText.includes("ADULTERADO"), "el PDF tiene el total calculado y no el valor adulterado");
step("lógica en el servidor: condición exige el garante; total calculado (363) pese al valor adulterado; campo oculto no se estampa");

// ───────────────────────────── Formularios web ─────────────────────────────

await api("PATCH", "/v1/settings/embed", { frameAncestors: [EMBED_ORIGIN] });
await api(
  "POST",
  "/v1/web-forms",
  { templateId: template.id, name: "Mal", signerRoleId: rCliente, fixedRecipients: [] },
  { expect: 400 }, // falta la Empresa
);
let form = await api("POST", "/v1/web-forms", {
  templateId: template.id,
  name: `Solicitud online ${stamp}`,
  description: "Completá tus datos para firmar la solicitud.",
  signerRoleId: rCliente,
  fixedRecipients: [{ roleId: rEmpresa, name: `Oficial ${stamp}`, email: `oficial.${stamp}@example.com` }],
  prefill: { Plan: "Anual" },
  maxUses: 1,
  embeddable: true,
});
assert(form.url.endsWith(`/f/${form.slug}`) && form.uses === 0, "formulario creado");
let pub = await api("GET", `/v1/public/forms/${form.slug}`, null, { anon: true });
assert(pub.available && pub.organizationName.includes("Financiera Demo"), "formulario público");
const frame = await api("GET", `/f/${form.slug}?embed=1`, null, { raw: true, anon: true });
const csp = frame.headers.get("content-security-policy") ?? "";
assert(csp.includes(EMBED_ORIGIN) && /frame-ancestors/.test(csp), `frame-ancestors del formulario embebible: ${csp}`);
const plain = await api("GET", `/f/${form.slug}`, null, { raw: true, anon: true });
assert(/frame-ancestors 'none'/.test(plain.headers.get("content-security-policy") ?? ""), "sin embed=1 no se puede enmarcar");

const me = { name: `Público ${stamp}`, email: `publico.${stamp}@example.com` };
await api("POST", `/v1/public/forms/${form.slug}/submit`, { ...me, formToken: pub.formToken }, { expect: 422, anon: true }); // demasiado rápido
await api("POST", `/v1/public/forms/${form.slug}/submit`, { ...me, formToken: pub.formToken, website: "http://spam" }, { expect: 422, anon: true });
await api("POST", `/v1/public/forms/${form.slug}/submit`, { ...me, formToken: "x".repeat(40) }, { expect: 400, anon: true });
await sleep(2700);
const sub = await api("POST", `/v1/public/forms/${form.slug}/submit`, { ...me, formToken: pub.formToken, embed: true }, { expect: 201, anon: true });
assert(sub.signingPath.startsWith("/s/") && sub.signingPath.endsWith("?embed=1"), "va directo a firmar");
const tokF = sub.signingPath.slice(3).replace("?embed=1", "");
sess = await api("GET", `/v1/signing/${tokF}`, null, { anon: true });
assert(sess.canSign && sess.recipient.name === me.name, "la persona del formulario puede firmar en la misma sesión");
assert(sess.canDelegate === false, "quien se autoregistró sin validar el correo no ve la opción de delegar");
await api("POST", `/v1/signing/${tokF}/delegate`, { name: "Tercero", email: `tercero.${stamp}@example.com`, reason: "x" }, { expect: 403, anon: true });
assert(byLabel(sess, "Plan").value === "Anual", "prellenado del formulario");
assert(byLabel(sess, "Detalle anual") && sess.logicFields !== undefined, "sesión con campos de lógica");
await api("POST", `/v1/signing/${tokF}/consent`, null, { anon: true });
// Plan = Anual → "Detalle anual" visible y obligatorio.
await api(
  "POST",
  `/v1/signing/${tokF}/complete`,
  {
    fields: [
      { id: byLabel(sess, "Precio").id, value: "50" },
      { id: byLabel(sess, "Cantidad").id, value: "2" },
    ],
    signature: { kind: "drawn", imagePng: PNG },
  },
  { expect: 422, anon: true },
);
sess = await api(
  "POST",
  `/v1/signing/${tokF}/complete`,
  {
    fields: [
      { id: byLabel(sess, "Precio").id, value: "50" },
      { id: byLabel(sess, "Cantidad").id, value: "2" },
      { id: byLabel(sess, "Detalle anual").id, value: "Pago en 12 cuotas" },
    ],
    signature: { kind: "drawn", imagePng: PNG },
  },
  { anon: true },
);
assert(sess.recipient.status === "signed", "firmó desde el formulario");
// Sin código por correo, el correo autorregistrado no recibe la invitación de respaldo (no se puede usar para spam).
await sleep(1500);
{
  const { items } = await api("GET", "/dev/mailbox");
  assert(!items.some((x) => x.to === me.email && /para firmar/.test(x.subject ?? "")), "sin OTP no se envía la invitación al correo autorregistrado");
}
const { items: formEnvs } = await api("GET", `/v1/web-forms/${form.id}/envelopes`);
assert(formEnvs.length === 1 && formEnvs[0].id === sub.envelopeId, "sobres creados desde el formulario");
const fd = await api("GET", `/v1/envelopes/${sub.envelopeId}`);
assert(fd.envelope.metadata.webFormId === form.id && fd.fields.find((f) => f.label === "Total").value === "121", "metadata y total del formulario");
const { items: evs } = await api("GET", `/v1/envelopes/${sub.envelopeId}/events`);
assert(evs.some((e) => e.type === "recipient.self_registered"), "evidencia del autorregistro");
form = await api("GET", `/v1/web-forms/${form.id}`);
assert(form.uses === 1, "uso contado");
pub = await api("GET", `/v1/public/forms/${form.slug}`, null, { anon: true });
assert(!pub.available && pub.unavailableReason === "exhausted", "agotado tras maxUses");
await sleep(2700);
await api("POST", `/v1/public/forms/${form.slug}/submit`, { name: "Otra persona", email: `otra.${stamp}@example.com`, formToken: pub.formToken }, { expect: 410, anon: true });
step("formulario web: antibots (rápido, trampa, token), firma en la misma sesión, embebible, límite de usos");

// Formulario con OTP: la persona tiene que validar su correo antes de ver el documento.
const otpForm = await api("POST", "/v1/web-forms", {
  templateId: template.id,
  name: `Con código ${stamp}`,
  signerRoleId: rCliente,
  fixedRecipients: [{ roleId: rEmpresa, name: `Oficial ${stamp}`, email: `oficial.${stamp}@example.com` }],
  requireOtp: true,
});
const pub2 = await api("GET", `/v1/public/forms/${otpForm.slug}`, null, { anon: true });
await sleep(2700);
const sub2 = await api("POST", `/v1/public/forms/${otpForm.slug}/submit`, { name: "Con Código", email: `otp.${stamp}@example.com`, formToken: pub2.formToken }, { expect: 201, anon: true });
const s2 = await api("GET", `/v1/signing/${sub2.signingPath.slice(3)}`, null, { anon: true });
assert(s2.otpRequired && s2.documents.length === 0, "con OTP no se ven documentos sin el código");
// Con OTP: la invitación de respaldo sale recién después de validar el correo.
{
  const otpEmail = `otp.${stamp}@example.com`;
  const tok2 = sub2.signingPath.slice(3);
  await sleep(1500);
  let { items } = await api("GET", "/dev/mailbox");
  assert(!items.some((x) => x.to === otpEmail && /para firmar/.test(x.subject ?? "")), "sin validar el código no hay invitación");
  await api("POST", `/v1/signing/${tok2}/otp/send`, {}, { anon: true });
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    ({ items } = await api("GET", "/dev/mailbox"));
    const m = items.find((x) => x.to === otpEmail && /\b\d{6}\b/.test(x.text));
    if (m) code = m.text.match(/\b(\d{6})\b/)[1];
    else await sleep(500);
  }
  assert(code, "llegó el código por correo");
  await api("POST", `/v1/signing/${tok2}/otp/verify`, { code }, { anon: true });
  let invited = false;
  for (let i = 0; i < 40 && !invited; i++) {
    ({ items } = await api("GET", "/dev/mailbox"));
    invited = items.some((x) => x.to === otpEmail && /para firmar/.test(x.subject ?? ""));
    if (!invited) await sleep(500);
  }
  assert(invited, "con el correo validado sale la invitación de respaldo");
}
await api("PATCH", `/v1/web-forms/${otpForm.id}`, { active: false });
const pub3 = await api("GET", `/v1/public/forms/${otpForm.slug}`, null, { anon: true });
assert(!pub3.available && pub3.unavailableReason === "inactive", "desactivado");
step("formulario con código por correo y desactivación");

// Un miembro (con envelopes:create, sin ver ni administrar todos los sobres) no opera los envíos ni los formularios de otro.
{
  const inv = await api("POST", "/v1/invitations", { email: `beto+scale${stamp}@example.com`, role: "member" }, { expect: 201 });
  const token = inv.acceptUrl.split("/invite/")[1];
  const acc = await fetch(`${BASE}/v1/invite/${token}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Beto Miembro", password: "otra-clave-segura-456" }),
  });
  assert(acc.ok, `aceptar invitación: ${acc.status}`);
  const memberCookie = acc.headers.get("set-cookie").split(";")[0];
  const asMember = async (method, path, body) =>
    fetch(BASE + path, { method, headers: { cookie: memberCookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let r = await asMember("PATCH", `/v1/web-forms/${form.id}`, { fixedRecipients: [{ roleId: rEmpresa, name: "Beto", email: `beto+scale${stamp}@example.com` }] });
  assert(r.status === 403, `un miembro no cambia el formulario de otro: ${r.status}`);
  r = await asMember("DELETE", `/v1/web-forms/${form.id}`);
  assert(r.status === 403, `un miembro no borra el formulario de otro: ${r.status}`);
  r = await asMember("POST", `/v1/bulk-sends/${bulk.id}/cancel`);
  assert(r.status === 404, `un miembro no cancela el envío masivo de otro: ${r.status}`);
  r = await asMember("GET", `/v1/bulk-sends/${bulk.id}/items`);
  assert(r.status === 404, `un miembro no ve las filas del envío masivo de otro: ${r.status}`);
  const list = await (await asMember("GET", "/v1/bulk-sends")).json();
  assert(!list.items.some((b) => b.id === bulk.id), "el listado del miembro no muestra envíos ajenos");
  const own = await api("GET", "/v1/bulk-sends");
  assert(own.items.some((b) => b.id === bulk.id), "quien lo lanzó sigue viendo su envío");
  const f2 = await api("GET", `/v1/web-forms/${form.id}`);
  assert(f2.fixedRecipients[0].email === `oficial.${stamp}@example.com`, "el firmante fijo no cambió");

  // El formulario del miembro deja de crear sobres cuando sale de la organización.
  const formBody = (name) => ({
    templateId: template.id,
    name,
    signerRoleId: rCliente,
    fixedRecipients: [{ roleId: rEmpresa, name: `Oficial ${stamp}`, email: `oficial.${stamp}@example.com` }],
  });
  r = await asMember("POST", "/v1/web-forms", formBody(`Del miembro ${stamp}`));
  assert(r.status === 201, `el miembro crea su formulario: ${r.status}`);
  const memberForm = await r.json();
  let mp = await api("GET", `/v1/public/forms/${memberForm.slug}`, null, { anon: true });
  assert(mp.available, "el formulario del miembro está disponible");
  const { items: members } = await api("GET", "/v1/members");
  const beto = members.find((m) => m.email === `beto+scale${stamp}@example.com`);
  await api("DELETE", `/v1/members/${beto.userId}`, null, { expect: 204 });
  mp = await api("GET", `/v1/public/forms/${memberForm.slug}`, null, { anon: true });
  assert(!mp.available && mp.unavailableReason === "inactive", `sin su creador el formulario no se ofrece: ${JSON.stringify(mp)}`);
  await sleep(2600);
  await api("POST", `/v1/public/forms/${memberForm.slug}/submit`, { name: "Tercero", email: `tercero.${stamp}@example.com`, formToken: mp.formToken }, { expect: 410, anon: true });

  // Un formulario creado por API key es de la key: la key lo edita y, revocada, el formulario deja de crear sobres.
  const key = await api("POST", "/v1/api-keys", { name: `formularios ${stamp}`, role: "member" });
  const asKey = (method, path, body) =>
    fetch(BASE + path, { method, headers: { authorization: `Bearer ${key.secret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  r = await asKey("POST", "/v1/web-forms", formBody(`De la key ${stamp}`));
  assert(r.status === 201, `la key crea su formulario: ${r.status}`);
  const keyForm = await r.json();
  r = await asKey("PATCH", `/v1/web-forms/${keyForm.id}`, { name: `De la key (editado) ${stamp}` });
  assert(r.status === 200, `la key edita su propio formulario: ${r.status}`);
  let kp = await api("GET", `/v1/public/forms/${keyForm.slug}`, null, { anon: true });
  await sleep(2600);
  const ks = await api("POST", `/v1/public/forms/${keyForm.slug}/submit`, { name: "Cliente Key", email: `cliente.key.${stamp}@example.com`, formToken: kp.formToken }, { expect: 201, anon: true });
  r = await asKey("GET", `/v1/envelopes/${ks.envelopeId}`);
  assert(r.status === 200, `la key ve el sobre de su formulario: ${r.status}`);
  // El remitente corrige el correo de quien lo completó: ese correo ya lo cargó el remitente, así que la invitación sale.
  const kd = await api("GET", `/v1/envelopes/${ks.envelopeId}`);
  const selfReg = kd.recipients.find((x) => x.email === `cliente.key.${stamp}@example.com`);
  const fixed = `cliente.corregido.${stamp}@example.com`;
  await api("POST", `/v1/envelopes/${ks.envelopeId}/corrections`, { updateRecipients: [{ id: selfReg.id, email: fixed }], reason: "correo mal escrito" });
  let gotInvite = false;
  for (let i = 0; i < 40 && !gotInvite; i++) {
    gotInvite = (await api("GET", "/dev/mailbox")).items.some((x) => x.to === fixed && /para firmar/.test(x.subject ?? ""));
    if (!gotInvite) await sleep(500);
  }
  assert(gotInvite, "el contacto corregido por el remitente recibe la invitación");
  await api("DELETE", `/v1/api-keys/${key.apiKey.id}`, null, { expect: 204 });
  kp = await api("GET", `/v1/public/forms/${keyForm.slug}`, null, { anon: true });
  assert(!kp.available, "con la key revocada el formulario no se ofrece");
}
step("un miembro no modifica formularios ni envíos masivos ajenos; un formulario sin dueño habilitado no crea sobres");

console.log("\nE2E ESCALA OK");
