#!/usr/bin/env node
// Prueba de punta a punta de Fase 6 (plataforma de acuerdos):
//  - documentos: cláusulas, plantilla con variables/condicionales/bucles/marcas → PDF → sobre con campos → completado
//  - repositorio: ingesta automática, búsqueda sin acentos, carga externa, campos propios, vistas, CSV, aviso de vencimiento
//  - workflow: link público → datos → aprobación → documento → firma → espera → HTTP firmado (con reintento) → repositorio
//  - negociación: comentario, propuestas (aceptada/rechazada), versiones con diff, aceptar → sobre
// Uso: node scripts/e2e-agreements.mjs [baseUrl]   (entorno local: usa /dev/mailbox, /dev/agreements/sweep y un receptor en 127.0.0.1)
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


// Temporales del script (PDFs y claves de prueba): se borran al salir, aunque una aserción falle.
const tempDirs = [];
process.on("exit", () => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});
// SIGINT/SIGTERM/SIGHUP (Ctrl+C, `timeout`, cierre de terminal) terminan sin el evento "exit": se convierten en
// process.exit para que la limpieza corra también en esos casos.
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(sig, () => process.exit(128 + n));
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
let cookie = "";

async function api(method, path, body, { raw = false, expect, anon = false, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie && !anon) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set && /^(__Host-)?cs_session=/.test(set) && !anon) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (expect !== undefined) {
    if (res.status !== expect) throw new Error(`${method} ${path} → esperaba ${expect}, vino ${res.status} ${text.slice(0, 500)}`);
    return data;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 500)}`);
  return data;
}

const step = (m) => console.log(`✓ ${m}`);
const assert = (c, m) => {
  if (!c) throw new Error(`falló: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function tinyPdf(text) {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = `BT /F1 14 Tf 72 760 Td (${text}) Tj ET`;
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);
  add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
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

async function mail(pred, what, secs = 30) {
  for (let i = 0; i < secs * 2; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find(pred);
    if (m) return m;
    await sleep(500);
  }
  throw new Error(`no llegó el mensaje: ${what}`);
}
/**
 * Link de firma de la invitación más reciente a `to` cuyo asunto incluye `subject`. Con `envelopeId`, solo una del sobre
 * indicado: dos sobres seguidos con el mismo asunto y destinatarios (uno anulado) hacían que, bajo carga, se tomara la
 * invitación del anterior.
 */
async function signLink(to, subject = "", envelopeId = null) {
  const rejected = new Set(); // tokens de otros sobres: no se vuelven a consultar (el límite por IP)
  for (let i = 0; i < 60; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    for (const x of items.filter((x) => x.to === to && x.subject.includes(subject) && x.subject.includes("para firmar") && x.link?.includes("/s/"))) {
      const token = x.link.split("/s/")[1];
      if (!envelopeId) return token;
      if (rejected.has(token)) continue;
      const s = await api("GET", `/v1/signing/${token}`, null, { anon: true }).catch(() => null);
      if (s?.envelope?.id === envelopeId) return token;
      if (s) rejected.add(token);
    }
    await sleep(500);
  }
  throw new Error(`no llegó la invitación a ${to}`);
}

async function sign(token) {
  let s = await api("GET", `/v1/signing/${token}`, null, { anon: true });
  assert(s.canSign, "el firmante puede firmar");
  await api("POST", `/v1/signing/${token}/consent`, {}, { anon: true });
  s = await api("POST", `/v1/signing/${token}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } }, { anon: true });
  assert(s.recipient.status === "signed", "firmado");
  return s;
}

async function waitFor(fn, what, secs = 60) {
  for (let i = 0; i < secs * 2; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout: ${what}`);
}

function pdfText(bytes) {
  const dir = tempDir("agr-");
  const f = join(dir, "x.pdf");
  writeFileSync(f, bytes);
  return execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" });
}

// Receptor HTTP local para el paso "llamar a un servicio" (el primer pedido responde 500 para probar el reintento).
const received = [];
let failNext = 1;
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    if (failNext > 0) {
      failNext--;
      res.writeHead(500).end("caído");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ crmId: "CRM-778", ok: true }));
  });
});
await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
const RECEIVER = `http://127.0.0.1:${receiver.address().port}/hook`;

const stamp = Date.now();
const me = await api("POST", "/v1/auth/signup", {
  name: "Ana Gómez",
  email: `ana+agr${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `Servicios Andinos ${stamp}`,
  locale: "es",
});
step("alta de cuenta");

// ───────────────────────────── Documentos ─────────────────────────────

await api("POST", "/v1/clauses", { slug: "confidencialidad", title: "Confidencialidad", body: "## Confidencialidad\nLas partes guardan **reserva** sobre la información de {{empresa}}." });
await api("POST", "/v1/clauses", { slug: "confidencialidad", title: "x", body: "y" }, { expect: 409 });
await api("POST", "/v1/clauses", { slug: "rota", title: "Rota", body: "{{#if a}}sin cierre" }, { expect: 400 });

const SOURCE = `# Contrato de servicios
Entre **{{empresa}}** y **{{cliente.nombre}}** (documento {{cliente.documento}}), se acuerda:
{{#if cliente.esEmpresa}}
El cliente actúa como persona jurídica.
{{else}}
El cliente actúa como persona humana.
{{/if}}
| Servicio | Horas | Importe |
|---|---|---|
{{#each servicios as s}}
| {{@index}}. {{s.nombre}} | {{s.horas}} | {{s.importe | money:USD}} |
{{/each}}
- Plazo: {{plazo}} meses{{#if plazo > 12}} (contrato de largo plazo){{/if}}
- Vencimiento: {{vencimiento | date:long}}
{{clausula:confidencialidad}}
{{salto}}
## Firmas
{{firma:Cliente}}    {{firma:Empresa}}
{{fecha_firma:Cliente}}    {{fecha_firma:Empresa}}`;

const tpl = await api("POST", "/v1/document-templates", {
  name: `Contrato de servicios ${stamp}`,
  locale: "es",
  source: SOURCE,
  sampleData: { empresa: "Servicios Andinos", cliente: { nombre: "Ejemplo" } },
  agreementMapping: { title: "Servicios para {{cliente.nombre}}", value: "total", currency: "USD", expiryDate: "vencimiento", tags: ["servicios"] },
});
assert(tpl.analysis.roles.join() === "Cliente,Empresa", `roles ${tpl.analysis.roles}`);
assert(tpl.analysis.loops[0].path === "servicios" && tpl.analysis.loops[0].fields.join() === "horas,importe,nombre", "bucle analizado");
assert(tpl.analysis.clauses.join() === "confidencialidad", "cláusula detectada");

const cliente = `José Ñandú ${stamp}`;
const data = {
  empresa: "Servicios Andinos",
  cliente: { nombre: cliente, documento: "001-1234567-8", esEmpresa: false },
  plazo: 24,
  vencimiento: new Date(Date.now() + 300 * 86400_000).toISOString().slice(0, 10),
  total: 1525.5,
  servicios: Array.from({ length: 30 }, (_, i) => ({ nombre: `Consultoría módulo ${i + 1}`, horas: 10 + i, importe: 100 * (i + 1) })),
};
const prev = await api("POST", `/v1/document-templates/${tpl.id}/preview`, { data: { empresa: "X" } });
assert(prev.missing.includes("cliente.nombre") && prev.missing.includes("servicios"), `faltantes en la vista previa: ${prev.missing}`);
const pdfRes = await api("POST", "/v1/document-templates/render", { templateId: tpl.id, data }, { raw: true });
assert(pdfRes.status === 200 && pdfRes.headers.get("content-type") === "application/pdf", "PDF de prueba");
const txt = pdfText(Buffer.from(await pdfRes.arrayBuffer()));
assert(txt.includes(cliente) && txt.includes("persona humana") && !txt.includes("persona jurídica"), "variables y condicional en el PDF");
assert(txt.includes("30. Consultoría módulo 30") && txt.includes("3000,00 US$"), "tabla repetida con formato de moneda");
assert(txt.includes("contrato de largo plazo") && txt.includes("Confidencialidad") && txt.includes("Firma — Cliente"), "condicional en línea, cláusula y marcas");
step("plantilla con variables, condicionales, tabla repetida (30 filas), cláusula y marcas → PDF verificado con pdftotext");

await api("POST", `/v1/document-templates/${tpl.id}/generate`, { data: { empresa: "X" }, recipients: [{ role: "Cliente", name: "a", email: "a@example.com" }] }, { expect: 422 });
await api("POST", `/v1/document-templates/${tpl.id}/generate`, { data, recipients: [{ role: "Cliente", name: cliente, email: `jose+${stamp}@example.com` }] }, { expect: 422 });
await api(
  "POST",
  `/v1/document-templates/${tpl.id}/generate`,
  { data, recipients: [{ role: "Cliente", name: cliente, email: `jose+${stamp}@example.com` }, { role: "Empresa", name: "Ana", email: me.user.email }, { role: "Testigo", name: "T", email: "t@example.com" }] },
  { expect: 422 },
);
{
  // Dos firmantes con el mismo rol: antes las marcas iban todas al último y el otro quedaba sin campos.
  const dup = await api(
    "POST",
    `/v1/document-templates/${tpl.id}/generate`,
    { data, recipients: [{ role: "Cliente", name: cliente, email: `jose+${stamp}@example.com` }, { role: "cliente", name: "Otro", email: `otro+${stamp}@example.com` }, { role: "Empresa", name: "Ana", email: me.user.email }] },
    { expect: 422 },
  );
  assert(dup?.error?.code === "duplicate_roles" || dup?.code === "duplicate_roles", `rol repetido → duplicate_roles (${JSON.stringify(dup).slice(0, 200)})`);
  // Una copia con el mismo nombre de rol que un firmante no se queda con sus campos de firma.
  const ccSame = await api("POST", `/v1/document-templates/${tpl.id}/generate`, {
    data,
    recipients: [
      { role: "Cliente", name: cliente, email: `jose+${stamp}@example.com` },
      { role: "Empresa", name: "Ana Gómez", email: me.user.email },
      { role: "Cliente", name: "Copia", email: `copia+${stamp}@example.com`, cc: true },
    ],
  });
  const ccDet = await api("GET", `/v1/envelopes/${ccSame.envelopeId}`);
  const ccRec = ccDet.recipients.find((r) => r.role === "cc");
  assert(ccSame.status === "sent" && ccRec && !ccDet.fields.some((f) => f.recipientId === ccRec.id), "la copia con el mismo rol no recibe campos y el sobre se envía");
  await api("POST", `/v1/envelopes/${ccSame.envelopeId}/void`, { reason: "prueba" }, { raw: true });
}
const gen = await api("POST", `/v1/document-templates/${tpl.id}/generate`, {
  data,
  recipients: [
    { role: "Cliente", name: cliente, email: `jose+${stamp}@example.com` },
    { role: "Empresa", name: "Ana Gómez", email: me.user.email },
    { role: "Legales", name: "Legales", email: `legales+${stamp}@example.com`, cc: true },
  ],
});
assert(gen.status === "sent" && gen.pages >= 2, `sobre generado y enviado (${gen.status}, ${gen.pages} páginas)`);
const det = await api("GET", `/v1/envelopes/${gen.envelopeId}`);
const types = det.fields.map((f) => f.type).sort().join(",");
assert(types === "date_signed,date_signed,signature,signature", `campos en las marcas: ${types}`);
assert(det.envelope.metadata.agreement.value === 1525.5 && det.envelope.metadata.agreement.expiryDate === data.vencimiento, "metadatos para el repositorio");
step("generar: faltantes → 422, roles sin firmante o sin espacio de firma → 422; sobre con 4 campos ubicados en las marcas");

await sign(await signLink(`jose+${stamp}@example.com`, cliente, gen.envelopeId));
await sign(await signLink(me.user.email, cliente, gen.envelopeId));
await waitFor(async () => (await api("GET", `/v1/envelopes/${gen.envelopeId}`)).envelope.status === "completed", "sobre completado");
step("sobre generado firmado por las dos partes y completado");

// ───────────────────────────── Repositorio ─────────────────────────────

const ag = await waitFor(async () => (await api("GET", `/v1/agreements?q=${encodeURIComponent("jose nandu")}`)).items[0], "acuerdo en el repositorio");
assert(ag.envelopeId === gen.envelopeId && ag.title === `Servicios para ${cliente}`, `título del mapeo: ${ag.title}`);
assert(ag.value === 1525.5 && ag.currency === "USD" && ag.expiryDate === data.vencimiento && ag.tags.includes("servicios"), "valor, moneda, vencimiento y etiquetas");
assert(ag.counterparties.length === 2 && ag.signatures >= 1, "contrapartes (sin la copia) y firmas del PDF");
const byText = await api("GET", `/v1/agreements?q=${encodeURIComponent("consultoria modulo")}`);
assert(byText.items.some((x) => x.id === ag.id) && byText.items[0].excerpt?.includes("«"), "búsqueda en el texto del PDF, sin acentos, con fragmento");
const byStem = await api("GET", `/v1/agreements?q=${encodeURIComponent("confidencial")}`);
assert(byStem.items.some((x) => x.id === ag.id), "búsqueda con raíz (confidencial → confidencialidad)");
step("ingesta automática: título/valor/vencimiento desde la plantilla; búsqueda sin acentos y por raíz en el texto del PDF");

await api("POST", "/v1/agreement-fields", { key: "region", label: "Región", type: "select", options: ["Caribe", "Andina"] });
await api("POST", "/v1/agreement-fields", { key: "region", label: "x", type: "text" }, { expect: 409 });
await api("PATCH", `/v1/agreements/${ag.id}`, { metadata: { region: "Patagonia" } }, { expect: 400 });
// Una fecha con formato válido que no existe es 400 (antes: 500 al guardarla como date).
await api("PATCH", `/v1/agreements/${ag.id}`, { expiryDate: "2027-02-31" }, { expect: 400 });
const upd = await api("PATCH", `/v1/agreements/${ag.id}`, { metadata: { region: "Andina" }, tags: ["servicios", "clave"], noticeDays: 15 });
assert(upd.metadata.region === "Andina" && upd.tags.length === 2 && upd.noticeDays === 15, "metadatos propios validados");

const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
const extTitle = `Acuerdo de distribución Ñuñoa ${stamp}`;
const fd = new FormData();
fd.append("meta", JSON.stringify({ title: extTitle, counterparties: [{ name: "Distribuidora Caribe SRL", email: "legal@caribe.example" }], expiryDate: soon, value: 9000, currency: "DOP", tags: ["distribucion"], metadata: { region: "Caribe" } }));
fd.append("file", new Blob([tinyPdf(`Contrato de distribucion exclusiva ${stamp}`)], { type: "application/pdf" }), "distribucion.pdf");
const ext = await api("POST", "/v1/agreements/upload", fd);
assert(ext.source === "external" && ext.sha256.length === 64 && ext.signatures === 0, "acuerdo externo con hash");
const fd2 = new FormData();
fd2.append("meta", JSON.stringify({ title: "dup" }));
fd2.append("file", new Blob([tinyPdf(`Contrato de distribucion exclusiva ${stamp}`)], { type: "application/pdf" }), "dup.pdf");
await api("POST", "/v1/agreements/upload", fd2, { expect: 409 });
const fd3 = new FormData();
fd3.append("meta", JSON.stringify({ title: "no pdf" }));
fd3.append("file", new Blob([Buffer.from("hola")], { type: "application/pdf" }), "x.pdf");
await api("POST", "/v1/agreements/upload", fd3, { expect: 400 });
const extSearch = await api("GET", `/v1/agreements?q=${encodeURIComponent(`distribucion exclusiva ${stamp}`)}`);
assert(extSearch.items.length === 1 && extSearch.items[0].id === ext.id, "búsqueda en el PDF externo");
const byField = await api("GET", "/v1/agreements?f.region=Caribe");
assert(byField.items.length === 1 && byField.items[0].id === ext.id, "filtro por campo propio");
const expiring = await api("GET", "/v1/agreements?expiresWithinDays=30");
assert(expiring.items.map((x) => x.id).join() === ext.id, "filtro: vencen en 30 días");
const view = await api("POST", "/v1/agreement-views", { name: "Caribe", filters: { fields: { region: "Caribe" } } });
const viaView = await api("GET", `/v1/agreements?viewId=${view.id}`);
assert(viaView.total === 1 && viaView.items[0].id === ext.id, "vista guardada");
// Los campos propios de la URL se combinan con los de la vista (antes los reemplazaban todos), y un filtro vacío
// en la URL quita ese filtro de la vista.
const view2 = await api("POST", "/v1/agreement-views", { name: "Caribe oro", filters: { fields: { region: "Caribe", tier: "Oro" } } });
assert((await api("GET", `/v1/agreements?viewId=${view2.id}`)).total === 0, "vista con todos sus filtros");
assert((await api("GET", `/v1/agreements?viewId=${view2.id}&f.region=Andina`)).total === 0, "un campo de la URL no borra los otros campos de la vista");
const clearedField = await api("GET", `/v1/agreements?viewId=${view2.id}&f.tier=`);
assert(clearedField.total === 1 && clearedField.items[0].id === ext.id, "f.tier= vacío quita ese campo de la vista");
const view3 = await api("POST", "/v1/agreement-views", { name: "Caribe terminados", filters: { status: "terminated", fields: { region: "Caribe" } } });
assert((await api("GET", `/v1/agreements?viewId=${view3.id}`)).total === 0, "vista con estado");
const clearedStatus = await api("GET", `/v1/agreements?viewId=${view3.id}&status=`);
assert(clearedStatus.total === 1 && clearedStatus.items[0].id === ext.id, "status= vacío quita el estado de la vista");
{
  // Una API key de miembro no borra la vista privada de otra key (antes null === null la hacía "dueña").
  const k1 = await api("POST", "/v1/api-keys", { name: `vistas 1 ${stamp}`, role: "member" });
  const k2 = await api("POST", "/v1/api-keys", { name: `vistas 2 ${stamp}`, role: "member" });
  const as1 = { anon: true, headers: { authorization: `Bearer ${k1.secret}` } };
  const as2 = { anon: true, headers: { authorization: `Bearer ${k2.secret}` } };
  const kv = await api("POST", "/v1/agreement-views", { name: `de la key 1 ${stamp}`, filters: {} }, as1);
  await api("DELETE", `/v1/agreement-views/${kv.id}`, null, { ...as2, expect: 403 });
  // La vista privada de una key es de esa key: la lista, la usa y la borra (antes quedaba con user_id NULL y no la
  // veía nadie). Otra key no la ve ni la puede usar.
  const mineK1 = (await api("GET", "/v1/agreement-views", null, as1)).items.find((x) => x.id === kv.id);
  assert(mineK1 && mineK1.mine === true, "la key ve su vista privada como propia");
  assert(!(await api("GET", "/v1/agreement-views", null, as2)).items.some((x) => x.id === kv.id), "otra key no ve la vista privada");
  await api("GET", `/v1/agreements?viewId=${kv.id}`, null, as1);
  await api("GET", `/v1/agreements?viewId=${kv.id}`, null, { ...as2, expect: 404 });
  await api("DELETE", `/v1/agreement-views/${kv.id}`, null, { ...as1, expect: 204 });
  const kv2 = await api("POST", "/v1/agreement-views", { name: `de la key 1 (2) ${stamp}`, filters: {} }, as1);
  await api("DELETE", `/v1/agreement-views/${kv2.id}`, null, { expect: 204 });
}
const csvBytes = Buffer.from(await (await api("GET", "/v1/agreements/export.csv", null, { raw: true })).arrayBuffer());
const csv = csvBytes.toString("utf8");
assert(csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, "CSV con BOM (Excel)");
assert(csv.includes(extTitle) && csv.includes("Región") && csv.includes("Andina"), "CSV con campos propios");
step("carga externa (hash, duplicado 409, PDF inválido 400), campos propios validados, filtros, vista guardada y CSV");

const sw = await api("POST", "/dev/agreements/sweep", {});
assert(sw.notified >= 1, "aviso de vencimiento enviado");
await mail((x) => x.subject.includes("Vence el") && x.subject.includes(extTitle), "aviso de vencimiento");
await api("POST", "/dev/agreements/sweep", {});
const { items: mbox } = await api("GET", "/dev/mailbox");
assert(mbox.filter((x) => x.subject.includes(extTitle)).length === 1, "el aviso se manda una sola vez por fecha");
step("aviso de vencimiento al responsable (una vez por fecha de vencimiento)");

// ───────────────────────────── Workflow ─────────────────────────────

const altaTpl = await api("POST", "/v1/document-templates", {
  name: `Alta de cliente ${stamp}`,
  source: "# Alta de cliente\nCliente: **{{cliente.nombre}}** ({{cliente.email}})\nPlazo: {{cliente.plazo}} meses\n{{firma:Cliente}}    {{firma:Empresa}}",
  agreementMapping: { title: "Alta {{cliente.nombre}}" },
});
const ids = Array.from({ length: 7 }, () => randomUUID());
const wfInput = {
  name: `Alta de clientes ${stamp}`,
  publicStart: true,
  steps: [
    { id: ids[0], name: "Datos del cliente", type: "collect_data", config: { title: "Tus datos", target: "cliente", fields: [
      { key: "nombre", label: "Nombre", type: "text", required: true },
      { key: "email", label: "Correo", type: "email", required: true },
      { key: "plazo", label: "Plazo (meses)", type: "number", required: true },
      { key: "inicio", label: "Inicio", type: "date", required: false },
    ] } },
    { id: ids[1], name: "Aprobación comercial", type: "approval", config: { approverUserId: me.user.id, message: "Revisá el alta" } },
    { id: ids[2], name: "Generar contrato", type: "generate_document", config: { documentTemplateId: altaTpl.id, output: "contrato" } },
    { id: ids[3], name: "Enviar a firmar", type: "send_for_signature", config: { document: "contrato", envelopeKey: "firma", subject: "Alta de {{cliente.nombre}}", recipients: [
      { role: "Cliente", name: "{{cliente.nombre}}", email: "{{cliente.email}}" },
      { role: "Empresa", name: "Ana Gómez", email: me.user.email },
    ] } },
    { id: ids[4], name: "Esperar firmas", type: "wait_for_completion", config: { envelopeKey: "firma" } },
    { id: ids[5], name: "Avisar al CRM", type: "http_request", config: { url: RECEIVER, method: "POST", bodyTemplate: '{"nombre": {{cliente.nombre}}, "plazo": {{cliente.plazo}}, "sobre": {{envelopes.firma.envelopeId}}}', saveAs: "crm" } },
    { id: ids[6], name: "Repositorio", type: "update_repository", config: { envelopeKey: "firma", tags: ["workflow"], metadata: { origen: "workflow {{cliente.plazo}}m" } } },
  ],
};
await api("POST", "/v1/workflows", { ...wfInput, steps: [wfInput.steps[3]] }, { expect: 400 }); // envía un documento que no se generó
const wf = await api("POST", "/v1/workflows", wfInput);
assert(wf.publicUrl?.includes("/wf/") && wf.signingSecret?.startsWith("wfsec_"), "link público y secreto de firma");
const slug = wf.publicUrl.split("/wf/")[1];
const pub = await api("GET", `/v1/public/workflows/${slug}`, null, { anon: true });
assert(pub.workflowName === wfInput.name, "inicio público");
await api("POST", `/v1/public/workflows/${slug}/start`, { website: "spam" }, { anon: true, expect: 400 });
const started = await api("POST", `/v1/public/workflows/${slug}/start`, {}, { anon: true });
let pv = await api("GET", `/v1/public/workflow-runs/${started.token}`, null, { anon: true });
assert(pv.status === "waiting" && pv.step?.fields.length === 4, "el run espera los datos");
await api("POST", `/v1/public/workflow-runs/${started.token}/steps/0`, { values: { nombre: "x" } }, { anon: true, expect: 400 });
// 31/02 no existe: se rechaza en el formulario (antes pasaba y el repositorio fallaba al guardarla como date).
await api("POST", `/v1/public/workflow-runs/${started.token}/steps/0`, { values: { nombre: "x", email: "x@example.com", plazo: "1", inicio: "31/02/2027" } }, { anon: true, expect: 400 });
// Tiempo mínimo de llenado del formulario público (public-intake.ts MIN_FILL_MS): un envío inmediato es de un bot.
await sleep(2600);
const wfClient = `María Gonçalves ${stamp}`;
const wfEmail = `maria+${stamp}@example.com`;
pv = await api("POST", `/v1/public/workflow-runs/${started.token}/steps/0`, { values: { nombre: wfClient, email: wfEmail.toUpperCase(), plazo: "18" } }, { anon: true });
assert(pv.status === "waiting" && pv.step === null, "datos recibidos; espera la aprobación");
await api("POST", `/v1/public/workflow-runs/${started.token}/steps/0`, { values: { nombre: "otra", email: "o@x.com", plazo: "1" } }, { anon: true, expect: 409 });
await mail((x) => x.subject.includes("Aprobación pendiente") && x.link?.includes(`/app/workflow-runs/${pv.runId}`), "pedido de aprobación");
let run = await api("GET", `/v1/workflow-runs/${pv.runId}`);
assert(run.steps[1].status === "waiting" && run.steps[1].canDecide, "aprobación pendiente para la aprobadora");
run = await api("POST", `/v1/workflow-runs/${pv.runId}/steps/1/decision`, { approve: true, comment: "OK" });
assert(run.status === "waiting" && run.steps[2].status === "completed" && run.steps[3].status === "completed" && run.steps[4].status === "waiting", `generó, envió y espera la firma (${run.status})`);
pv = await api("GET", `/v1/public/workflow-runs/${started.token}`, null, { anon: true });
assert(pv.signingUrl?.includes("/s/"), "quien completó el formulario recibe su link de firma");
const envId = run.context.envelopes.firma.envelopeId;
await sign(pv.signingUrl.split("/s/")[1]);
await sign(await signLink(me.user.email, `Alta de ${wfClient}`));
run = await waitFor(async () => {
  const r = await api("GET", `/v1/workflow-runs/${pv.runId}`);
  return r.status === "completed" || r.status === "failed" ? r : null;
}, "workflow completado", 90);
assert(run.status === "completed", `workflow: ${run.status} ${JSON.stringify(run.steps.map((x) => [x.name, x.status, x.error]))}`);
assert(run.steps[5].attempts === 2 && received.length === 2, `HTTP reintentado tras un 500 (${run.steps[5].attempts} intentos, ${received.length} pedidos)`);
const hook = received[1];
const sig = /t=(\d+),v1=([0-9a-f]+)/.exec(hook.headers["calasign-signature"]);
assert(sig && createHmac("sha256", wf.signingSecret).update(`${sig[1]}.${hook.body}`).digest("hex") === sig[2], "llamada firmada con el secreto del workflow");
assert(JSON.parse(hook.body).nombre === wfClient && JSON.parse(hook.body).sobre === envId && JSON.parse(hook.body).plazo === 18, "cuerpo con variables como valores JSON");
assert(run.context.http.crm.crmId === "CRM-778", "respuesta guardada en el contexto");
const wfAg = await waitFor(async () => (await api("GET", `/v1/agreements?q=${encodeURIComponent(wfClient.normalize("NFD").replace(/[̀-ͯ]/g, ""))}`)).items[0], "acuerdo del workflow");
assert(wfAg.tags.includes("workflow") && wfAg.metadata.origen === "workflow 18m" && wfAg.title === `Alta ${wfClient}`, "repositorio actualizado por el workflow");
step("workflow: link público → datos (validados) → aprobación → contrato → firma (link para quien completó) → espera → HTTP firmado con reintento → repositorio");

// Un visitante que tipea el correo del firmante fijo de la empresa no recibe el link de la empresa.
const st2 = await api("POST", `/v1/public/workflows/${slug}/start`, {}, { anon: true });
await sleep(2600);
let pv2 = await api("POST", `/v1/public/workflow-runs/${st2.token}/steps/0`, { values: { nombre: `Intruso ${stamp}`, email: me.user.email, plazo: "1" } }, { anon: true });
let run2 = await api("POST", `/v1/workflow-runs/${pv2.runId}/steps/1/decision`, { approve: true });
assert(run2.steps[3].status === "completed", `el sobre del segundo run se envió (${run2.steps[3].status})`);
pv2 = await api("GET", `/v1/public/workflow-runs/${st2.token}`, null, { anon: true });
assert(!pv2.signingUrl, "con el correo del firmante fijo no se entrega ningún link de firma");
await api("POST", `/v1/workflow-runs/${pv2.runId}/cancel`, {}).catch(() => {});
step("workflow público: el correo de un firmante fijo no da acceso a su link");

const wf2 = await api("POST", "/v1/workflows", { name: `Solo aprobación ${stamp}`, steps: [{ id: randomUUID(), name: "Aprobar", type: "approval", config: { approverUserId: me.user.id } }] });
let r2 = await api("POST", `/v1/workflows/${wf2.id}/runs`, { data: { x: 1 } });
assert(r2.status === "waiting", "run por API esperando aprobación");
r2 = await api("POST", `/v1/workflow-runs/${r2.id}/steps/0/decision`, { approve: false, comment: "No" });
assert(r2.status === "rejected", "aprobación rechazada");
let r3 = await api("POST", `/v1/workflows/${wf2.id}/runs`, {});
r3 = await api("POST", `/v1/workflow-runs/${r3.id}/cancel`, {});
assert(r3.status === "cancelled" && r3.steps[0].status === "cancelled", "run cancelado");
await api("POST", `/v1/workflow-runs/${r3.id}/steps/0/decision`, { approve: true }, { expect: 409 });
step("workflow por API: rechazo y cancelación");

// Una API key de miembro no "coincide" con las ejecuciones del link público (ambas sin usuario): no las ve ni las cancela.
{
  const { secret } = await api("POST", "/v1/api-keys", { name: `wf miembro ${stamp}`, role: "member" });
  const asKey = { anon: true, headers: { authorization: `Bearer ${secret}` } };
  await api("GET", `/v1/workflow-runs/${pv.runId}`, null, { ...asKey, expect: 404 });
  await api("POST", `/v1/workflow-runs/${pv.runId}/cancel`, {}, { ...asKey, expect: 404 });
  const listed = await api("GET", "/v1/workflow-runs", null, asKey);
  assert(!listed.items.some((x) => x.id === pv.runId), "el run público no aparece en la lista de la key");
  // La ejecución que inicia la propia key sí es suya: la ve, la lista y la cancela.
  const own = await api("POST", `/v1/workflows/${wf2.id}/runs`, { data: {} }, asKey);
  assert((await api("GET", "/v1/workflow-runs", null, asKey)).items.some((x) => x.id === own.id), "la key ve su propio run");
  const cancelled = await api("POST", `/v1/workflow-runs/${own.id}/cancel`, {}, asKey);
  assert(cancelled.status === "cancelled", "la key cancela su propio run");
  step("workflow: una API key de miembro solo ve y cancela sus propias ejecuciones (no las del link público)");
}

// Workflow público creado con una API key: los sobres salen a nombre de la key y, si se revoca, el link deja de
// ofrecerse y los runs en curso no envían (antes seguían enviando en nombre de quien ya no puede crear sobres).
{
  const key = await api("POST", "/v1/api-keys", { name: `wf público ${stamp}`, role: "admin" });
  const asKey = { anon: true, headers: { authorization: `Bearer ${key.secret}` } };
  const kIds = Array.from({ length: 3 }, () => randomUUID());
  const kwf = await api("POST", "/v1/workflows", {
    name: `Público por key ${stamp}`,
    publicStart: true,
    steps: [
      { id: kIds[0], name: "Datos", type: "collect_data", config: { title: "Datos", target: "cliente", fields: [
        { key: "nombre", label: "Nombre", type: "text", required: true },
        { key: "email", label: "Correo", type: "email", required: true },
        { key: "plazo", label: "Plazo", type: "number", required: true },
      ] } },
      { id: kIds[1], name: "Contrato", type: "generate_document", config: { documentTemplateId: altaTpl.id, output: "contrato" } },
      { id: kIds[2], name: "Firmar", type: "send_for_signature", config: { document: "contrato", envelopeKey: "firma", subject: "Key {{cliente.nombre}}", recipients: [
        { role: "Cliente", name: "{{cliente.nombre}}", email: "{{cliente.email}}" },
        { role: "Empresa", name: "Ana Gómez", email: me.user.email },
      ] } },
    ],
  }, asKey);
  const kslug = kwf.publicUrl.split("/wf/")[1];
  const values = { nombre: `Key ${stamp}`, email: `key+${stamp}@example.com`, plazo: "6" };
  const s1 = await api("POST", `/v1/public/workflows/${kslug}/start`, {}, { anon: true });
  await sleep(2600);
  const v1 = await api("POST", `/v1/public/workflow-runs/${s1.token}/steps/0`, { values }, { anon: true });
  const kr1 = await api("GET", `/v1/workflow-runs/${v1.runId}`);
  assert(kr1.status === "completed", `run público de la key enviado (${kr1.status} ${JSON.stringify(kr1.steps.map((x) => x.error))})`);
  await api("GET", `/v1/envelopes/${kr1.context.envelopes.firma.envelopeId}`, null, asKey); // el sobre es de la key
  const s2 = await api("POST", `/v1/public/workflows/${kslug}/start`, {}, { anon: true });
  await sleep(2600);
  await api("DELETE", `/v1/api-keys/${key.apiKey.id}`, null, { expect: 204 });
  await api("GET", `/v1/public/workflows/${kslug}`, null, { anon: true, expect: 404 });
  await api("POST", `/v1/public/workflows/${kslug}/start`, {}, { anon: true, expect: 404 });
  // Otro correo: el mismo correo desde la misma IP en minutos se deduplica (form_recent_submission).
  const v2 = await api("POST", `/v1/public/workflow-runs/${s2.token}/steps/0`, { values: { ...values, email: `key2+${stamp}@example.com` } }, { anon: true });
  const kr2 = await api("GET", `/v1/workflow-runs/${v2.runId}`);
  assert(kr2.status === "failed" && !kr2.context.envelopes.firma && /revocada/.test(kr2.steps[2].error ?? ""), `con la key revocada no se envía (${kr2.status})`);
  step("workflow público de una API key: sobres a su nombre; revocada, el link no se ofrece y los runs en curso no envían");
}

// ───────────────────────────── Negociación ─────────────────────────────

const negSrc = "# Propuesta comercial\nCliente: {{cliente.nombre}}\nPlazo: {{plazo}} meses. Precio mensual: {{precio | money:USD}}.\n{{clausula:confidencialidad}}\n{{firma:Cliente}}    {{firma:Empresa}}";
const negTpl = await api("POST", "/v1/document-templates", { name: `Propuesta ${stamp}`, source: negSrc });
const negClient = `Lucía Pereira ${stamp}`;
const neg = await api("POST", "/v1/negotiations", {
  title: `Propuesta para ${negClient}`,
  documentTemplateId: negTpl.id,
  data: { cliente: { nombre: negClient }, plazo: 12, precio: 800, empresa: "Servicios Andinos" },
  negotiableVariables: ["plazo", "precio"],
  participants: [{ name: negClient, email: `lucia+${stamp}@example.com`, role: "Cliente" }],
});
assert(neg.negotiation.currentVersion === 1 && neg.text.includes("Plazo: 12 meses"), "negociación creada (versión 1)");
const nlink = (await mail((x) => x.link?.includes("/n/") && x.text.includes(negClient), "invitación a negociar")).link.split("/n/")[1];
let pview = await api("GET", `/v1/public/negotiations/${nlink}`, null, { anon: true });
assert(pview.me.name === negClient && pview.variables.map((v) => v.path).join() === "plazo,precio", "vista de la contraparte con variables negociables");
const quote = "Precio mensual";
const start = pview.text.indexOf(quote);
pview = await api("POST", `/v1/public/negotiations/${nlink}/comments`, { body: "¿Incluye soporte?", quote, start, end: start + quote.length }, { anon: true });
assert(pview.comments.length === 1 && pview.comments[0].quote === quote, "comentario anclado al texto");
await api("POST", `/v1/public/negotiations/${nlink}/proposals`, { kind: "variable", key: "cliente.nombre", newValue: "Otro" }, { anon: true, expect: 400 });
await api("POST", `/v1/public/negotiations/${nlink}/proposals`, { kind: "variable", key: "plazo", newValue: "12" }, { anon: true, expect: 400 });
pview = await api("POST", `/v1/public/negotiations/${nlink}/proposals`, { kind: "variable", key: "plazo", newValue: "24", comment: "Preferimos 2 años" }, { anon: true });
pview = await api(
  "POST",
  `/v1/public/negotiations/${nlink}/proposals`,
  { kind: "clause", key: "confidencialidad", newValue: "## Confidencialidad\nSin reserva." },
  { anon: true },
);
const props = pview.proposals;
assert(props.length === 2 && props.every((p) => p.status === "pending"), "dos propuestas pendientes");
await api("POST", `/v1/negotiations/${neg.negotiation.id}/accept`, {}, { expect: 409 });
let sview = await api("POST", `/v1/negotiations/${neg.negotiation.id}/proposals/${props[0].id}/decision`, { accept: true });
sview = await api("POST", `/v1/negotiations/${neg.negotiation.id}/proposals/${props[1].id}/decision`, { accept: false });
assert(sview.negotiation.currentVersion === 2 && sview.text.includes("Plazo: 24 meses") && sview.text.includes("reserva"), "propuesta aceptada → versión 2; la rechazada no cambia la cláusula");
const diff = await api("GET", `/v1/public/negotiations/${nlink}/diff?from=1&to=2`, null, { anon: true });
assert(diff.parts.some((p) => p.op === "del" && p.text.includes("12")) && diff.parts.some((p) => p.op === "ins" && p.text.includes("24")), "diff entre versiones");
await mail((x) => x.subject.includes("Nueva versión") && x.text.includes(negClient), "aviso de nueva versión");
// Una cláusula editada con sintaxis inválida es 400 (antes 500) y no crea versión.
await api("PATCH", `/v1/negotiations/${neg.negotiation.id}`, { clauseOverrides: { confidencialidad: "{{#if x}}sin cierre" } }, { expect: 400 });
assert((await api("GET", `/v1/negotiations/${neg.negotiation.id}`)).negotiation.currentVersion === 2, "la edición inválida no crea versión");
const acc = await api("POST", `/v1/negotiations/${neg.negotiation.id}/accept`, { subject: "Propuesta final" });
assert(acc.negotiation.status === "accepted" && acc.envelope.status === "sent", "aceptada: sobre enviado");
const accEnv = await api("GET", `/v1/envelopes/${acc.envelope.id}`);
assert(accEnv.recipients.length === 2 && accEnv.recipients.some((r) => r.email === me.user.email), "firman la contraparte y la remitente (rol sin contraparte)");
await api("POST", `/v1/negotiations/${neg.negotiation.id}/accept`, {}, { expect: 409 });
await api("POST", `/v1/public/negotiations/${nlink}/comments`, { body: "tarde" }, { anon: true, expect: 409 });
const docx = new FormData();
docx.append("meta", JSON.stringify({ title: "Word", participants: [{ name: "X", email: "x@example.com" }] }));
docx.append("file", new Blob([Buffer.from("PK..")], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "borrador.docx");
await api("POST", "/v1/negotiations/upload", docx, { expect: 415 });
step("negociación: comentario anclado, propuestas aceptada/rechazada, versiones con diff, aceptar → sobre; Word → 415");

receiver.close();
console.log("\nE2E ACUERDOS OK");
