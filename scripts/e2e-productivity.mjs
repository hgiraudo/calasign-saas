#!/usr/bin/env node
// Prueba de punta a punta de Fase 2 (productividad): branding, plantilla con roles, sobre desde plantilla con
// prellenado, tipos de campo nuevos (número, desplegable, empresa, cargo, adjunto) y PDF final con adjuntos.
// Uso: node scripts/e2e-productivity.mjs [baseUrl]      Deja el PDF en ./var/e2e-productivity-signed.pdf
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
let cookie = "";

async function api(method, path, body, { raw = false, headers = {}, expect } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set && set.startsWith("cs_session")) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (expect !== undefined) {
    if (res.status !== expect) throw new Error(`${method} ${path} → esperaba ${expect}, vino ${res.status} ${text}`);
    return data;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}

const step = (m) => console.log(`✓ ${m}`);
const assert = (c, m) => {
  if (!c) throw new Error(`falló: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function linkFor(name) {
  for (let i = 0; i < 40; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return { token: m.link.split("/s/")[1], text: m.text };
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

const stamp = Date.now();
await api("POST", "/v1/auth/signup", {
  name: "Ana Remitente",
  email: `ana+prod${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `Banco Demo ${stamp}`,
  locale: "es",
});
step("alta de cuenta");

// ── Branding ──
let brand = await api("PATCH", "/v1/settings/branding", { primaryColor: "#7C3AED", emailFooter: "Banco Demo S.A. · Atención 0800-123" });
assert(brand.primaryColor === "#7c3aed", "color normalizado");
await api("PATCH", "/v1/settings/branding", { primaryColor: "rojo" }, { expect: 400 });
const logoFd = new FormData();
logoFd.append("file", new Blob([Buffer.from(PNG, "base64")], { type: "image/png" }), "logo.png");
brand = await api("POST", "/v1/settings/branding/logo", logoFd);
assert(brand.logoUrl?.startsWith("/v1/branding/logo/"), "url del logo");
const logoRes = await fetch(BASE + brand.logoUrl);
assert(logoRes.status === 200 && logoRes.headers.get("content-type") === "image/png", "logo público");
const evilSvg = new FormData();
evilSvg.append("file", new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: "image/svg+xml" }), "x.svg");
await api("POST", "/v1/settings/branding/logo", evilSvg, { expect: 400 });
step("branding: color, pie de correo, logo PNG público; SVG con script rechazado");

// ── Plantilla ──
const { template } = await api("POST", "/v1/templates", { name: `Contrato de servicios ${stamp}`, subject: "Contrato de servicios", message: "Firmá por favor" });
const tfd = new FormData();
tfd.append("file", new Blob([tinyPdf(2, "Contrato")], { type: "application/pdf" }), "contrato.pdf");
const tdoc = await api("POST", `/v1/templates/${template.id}/documents`, tfd);
const rCliente = randomUUID();
const rGerente = randomUUID();
const rArchivo = randomUUID();
await api("PUT", `/v1/templates/${template.id}/roles`, {
  roles: [
    { id: rCliente, name: "Cliente", role: "signer", routingOrder: 1 },
    { id: rGerente, name: "Gerente", role: "signer", routingOrder: 2 },
    { id: rArchivo, name: "Archivo", role: "cc", routingOrder: 3 },
  ],
});
const F = (o) => ({ documentId: tdoc.id, page: 0, width: 0.25, height: 0.03, ...o });
await api(
  "PUT",
  `/v1/templates/${template.id}/fields`,
  { fields: [F({ roleId: rCliente, type: "dropdown", x: 0.1, y: 0.1, label: "Plan" })] },
  { expect: 400 }, // desplegable sin opciones
);
const tpl = await api("PUT", `/v1/templates/${template.id}/fields`, {
  fields: [
    F({ roleId: rCliente, type: "signature", page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }),
    F({ roleId: rCliente, type: "number", x: 0.1, y: 0.1, label: "Monto", min: 1, max: 100000 }),
    F({ roleId: rCliente, type: "dropdown", x: 0.1, y: 0.15, label: "Plan", options: ["Mensual", "Anual"] }),
    F({ roleId: rCliente, type: "company", x: 0.1, y: 0.2, label: "Empresa" }),
    F({ roleId: rCliente, type: "title", x: 0.1, y: 0.25, label: "Cargo" }),
    F({ roleId: rCliente, type: "attachment", x: 0.1, y: 0.3, width: 0.4, label: "Cédula" }),
    F({ roleId: rCliente, type: "text", x: 0.1, y: 0.35, label: "Nro de contrato" }),
    F({ roleId: rCliente, type: "text", x: 0.1, y: 0.4, label: "Versión", value: "Condiciones v3", readOnly: true }),
    F({ roleId: rGerente, type: "signature", page: 1, x: 0.55, y: 0.7, width: 0.3, height: 0.08 }),
    F({ roleId: rGerente, type: "text", page: 1, x: 0.55, y: 0.8, label: "Observaciones", required: false }),
  ],
});
assert(tpl.fields.length === 10 && tpl.roles.length === 3, "plantilla con 10 campos y 3 roles");
const { items: tplList } = await api("GET", "/v1/templates");
assert(tplList.some((t) => t.id === template.id && t.documentCount === 1 && t.roles.length === 3), "listado de plantillas");
step("plantilla: documento, 3 roles, 10 campos (validación de desplegable sin opciones)");

// ── Sobre desde plantilla ──
const cliente = `Carla Cliente ${stamp}`;
const gerente = `Gustavo Gerente ${stamp}`;
const recips = [
  { role: "Cliente", name: cliente, email: `carla+${stamp}@example.com`, idDocumentType: "cedula", idDocumentNumber: "001-0000001-1" },
  { role: "gerente", name: gerente, email: `gus+${stamp}@example.com` },
  { roleId: rArchivo, name: `Archivo ${stamp}`, email: `archivo+${stamp}@example.com` },
];
await api("POST", "/v1/envelopes/from-template", { templateId: template.id, recipients: recips.slice(0, 2) }, { expect: 422 });
await api("POST", "/v1/envelopes/from-template", { templateId: template.id, recipients: recips, prefill: { Versión: "otra" } }, { expect: 400 });
await api("POST", "/v1/envelopes/from-template", { templateId: template.id, recipients: recips, prefill: { Monto: "mucho" } }, { expect: 400 });
const env = await api("POST", "/v1/envelopes/from-template", {
  templateId: template.id,
  recipients: recips,
  prefill: { "Nro de contrato": "C-001", Monto: "2500" },
  send: true,
});
assert(env.envelope.status === "sent", "enviado en el mismo pedido");
assert(env.envelope.subject === "Contrato de servicios", "asunto de la plantilla");
assert(env.fields.find((f) => f.label === "Nro de contrato")?.value === "C-001", "prellenado por etiqueta");
assert(env.fields.find((f) => f.label === "Versión")?.readOnly === true, "solo lectura heredado");
step("sobre desde plantilla: roles por nombre e id, faltantes 422, prellenado validado, enviado");

// ── Firmante 1: tipos nuevos y adjunto ──
const inv = await linkFor(cliente);
assert(inv.text.includes("Banco Demo S.A."), "pie de correo del branding en la invitación");
const t1 = inv.token;
let sess = await api("GET", `/v1/signing/${t1}`);
assert(sess.branding?.primaryColor === "#7c3aed" && sess.branding.logoUrl, "branding en la sesión del firmante");
await api("POST", `/v1/signing/${t1}/consent`);
const byLabel = (l) => sess.fields.find((f) => f.label === l);
const att = byLabel("Cédula");
const afd = new FormData();
afd.append("file", new Blob([Buffer.from("no soy un pdf")], { type: "application/pdf" }), "x.pdf");
await api("POST", `/v1/signing/${t1}/fields/${att.id}/attachment`, afd, { expect: 400 });
// Primero sube otro archivo y después lo reemplaza: el anterior se descarta (no queda guardado).
const afd0 = new FormData();
afd0.append("file", new Blob([tinyPdf(1, "Archivo equivocado")], { type: "application/pdf" }), "equivocado.pdf");
await api("POST", `/v1/signing/${t1}/fields/${att.id}/attachment`, afd0);
const afd2 = new FormData();
afd2.append("file", new Blob([tinyPdf(1, "Cedula escaneada")], { type: "application/pdf" }), "cedula.pdf");
const attField = await api("POST", `/v1/signing/${t1}/fields/${att.id}/attachment`, afd2);
assert(attField.value === "cedula.pdf", "adjunto registrado");
const vals = (o) => Object.entries(o).map(([l, value]) => ({ id: byLabel(l).id, value }));
const sig = { kind: "drawn", imagePng: PNG };
await api("POST", `/v1/signing/${t1}/complete`, { fields: vals({ Monto: "abc", Plan: "Anual", Empresa: "ACME", Cargo: "CEO" }), signature: sig }, { expect: 422 });
await api("POST", `/v1/signing/${t1}/complete`, { fields: vals({ Monto: "999999", Plan: "Anual", Empresa: "ACME", Cargo: "CEO" }), signature: sig }, { expect: 422 });
await api("POST", `/v1/signing/${t1}/complete`, { fields: vals({ Monto: "10", Plan: "Semanal", Empresa: "ACME", Cargo: "CEO" }), signature: sig }, { expect: 422 });
sess = await api("POST", `/v1/signing/${t1}/complete`, {
  fields: vals({ Monto: "1.500,50", Plan: "Anual", Empresa: "ACME Dominicana S.R.L.", Cargo: "Directora", Versión: "manipulado" }),
  signature: sig,
});
assert(sess.recipient.status === "signed", "firmante 1 firmó");
step("firmante 1: adjunto PDF (inválido rechazado), número/desplegable validados, solo lectura respetado");

// ── Firmante 2 ──
const t2 = (await linkFor(gerente)).token;
await api("POST", `/v1/signing/${t2}/consent`);
await api("POST", `/v1/signing/${t2}/complete`, { fields: [], signature: { kind: "typed", imagePng: PNG, text: "Gustavo" } });
step("firmante 2 firmó (observaciones opcional vacío)");

let detail;
for (let i = 0; i < 60; i++) {
  detail = await api("GET", `/v1/envelopes/${env.envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(detail.envelope.status === "completed", `completado (estado ${detail.envelope.status})`);
const pdfRes = await api("GET", `/v1/envelopes/${env.envelope.id}/signed.pdf`, null, { raw: true });
const pdf = Buffer.from(await pdfRes.arrayBuffer());
mkdirSync("var", { recursive: true });
const out = "var/e2e-productivity-signed.pdf";
writeFileSync(out, pdf);
const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [out], { encoding: "utf8" }))[1]);
assert(pages >= 4, `2 del contrato + 1 del adjunto + certificado (vino ${pages})`);
const text = execFileSync("pdftotext", [out, "-"], { encoding: "utf8" });
for (const s of ["1.500,50", "Anual", "ACME Dominicana S.R.L.", "Directora", "C-001", "Condiciones v3", "Adjunto: cedula.pdf", "Cedula escaneada", "Adjuntos"]) {
  assert(text.includes(s), `el PDF final contiene "${s}"`);
}
assert(!text.includes("manipulado"), "el valor de solo lectura no cambió");
let sigReport = "";
try {
  sigReport = execFileSync("pdfsig", [out], { encoding: "utf8" });
} catch (e) {
  sigReport = String(e.stdout ?? e);
}
assert(/Signature is Valid/.test(sigReport), "sello válido");
step(`PDF final: ${pages} páginas, valores estampados, adjunto agregado, sello válido → ${out}`);

// ── Plantilla desde sobre ──
const fromEnv = await api("POST", `/v1/templates/from-envelope/${env.envelope.id}`, { name: `Copia ${stamp}` });
assert(fromEnv.roles.length === 3 && fromEnv.fields.length === 10, "roles y campos copiados");
assert(fromEnv.fields.find((f) => f.label === "Monto")?.value === null, "no copia lo que escribieron los firmantes");
assert(fromEnv.fields.find((f) => f.label === "Versión")?.value === "Condiciones v3", "conserva el valor fijo");
step("plantilla creada desde el sobre (sin datos de los firmantes)");

// ── Rol que pasa a aprobador: pierde sus campos (como en los sobres) ──
const rolesNow = fromEnv.roles.map((r) => ({ id: r.id, name: r.name, role: r.role, routingOrder: r.routingOrder }));
const second = rolesNow.find((r) => r.name === "Firmante 2");
second.role = "approver";
const afterRoles = await api("PUT", `/v1/templates/${fromEnv.template.id}/roles`, { roles: rolesNow });
assert(!afterRoles.fields.some((f) => f.roleId === second.id), "el aprobador no conserva campos de la plantilla");
const envAp = await api("POST", "/v1/envelopes/from-template", {
  templateId: fromEnv.template.id,
  recipients: [
    { roleId: rolesNow[0].id, name: `Uno ${stamp}`, email: `uno+${stamp}@example.com` },
    { roleId: second.id, name: `Aprueba ${stamp}`, email: `aprueba+${stamp}@example.com` },
    { roleId: rolesNow[2].id, name: `Copia ${stamp}`, email: `copia+${stamp}@example.com` },
  ],
});
const apRecipient = envAp.recipients.find((r) => r.role === "approver");
assert(apRecipient && !envAp.fields.some((f) => f.recipientId === apRecipient.id), "el sobre no le da campos al aprobador");
step("rol de plantilla cambiado a aprobador: sin campos en la plantilla ni en el sobre");

// ── Plantilla con aprobador de punta a punta: firma, aprueba y se completa ──
const apTpl = (await api("POST", "/v1/templates", { name: `Con aprobador ${stamp}`, subject: `Aprobación ${stamp}` })).template;
const apFd = new FormData();
apFd.append("file", new Blob([tinyPdf(1, "Orden de compra")], { type: "application/pdf" }), "orden.pdf");
const apDoc = await api("POST", `/v1/templates/${apTpl.id}/documents`, apFd);
const apRoles = (
  await api("PUT", `/v1/templates/${apTpl.id}/roles`, {
    roles: [
      { name: "Solicitante", role: "signer", routingOrder: 1 },
      { name: "Gerencia", role: "approver", routingOrder: 2 },
    ],
  })
).roles;
const solicitante = apRoles.find((r) => r.name === "Solicitante");
const gerencia = apRoles.find((r) => r.name === "Gerencia");
assert(gerencia.role === "approver", "el rol aprobador se guarda en la plantilla");
await api("PUT", `/v1/templates/${apTpl.id}/fields`, {
  fields: [{ documentId: apDoc.id, roleId: gerencia.id, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.25, height: 0.06 }],
}, { expect: 400 });
await api("PUT", `/v1/templates/${apTpl.id}/fields`, {
  fields: [{ documentId: apDoc.id, roleId: solicitante.id, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.25, height: 0.06 }],
});
const solName = `Solicita ${stamp}`;
const gerName = `Gerente aprueba ${stamp}`;
const apEnv = await api("POST", "/v1/envelopes/from-template", {
  templateId: apTpl.id,
  recipients: [
    { role: "Solicitante", name: solName, email: `solicita+${stamp}@example.com` },
    { role: "Gerencia", name: gerName, email: `gerencia+${stamp}@example.com` },
  ],
  send: true,
});
assert(apEnv.envelope.status === "sent", "sobre con aprobador enviado");
const tSol = (await linkFor(solName)).token;
await api("POST", `/v1/signing/${tSol}/consent`);
const solSess = await api("GET", `/v1/signing/${tSol}`);
await api("POST", `/v1/signing/${tSol}/complete`, { fields: [], signature: { kind: "typed", imagePng: PNG, text: "Solicita" } });
assert(solSess.fields.length === 1, "el solicitante tiene su campo de firma");
const tGer = (await linkFor(gerName)).token;
const gerSess = await api("POST", `/v1/signing/${tGer}/consent`);
assert(gerSess.recipient.role === "approver" && gerSess.canSign && gerSess.fields.length === 0, "el aprobador puede aprobar y no tiene campos");
await api("POST", `/v1/signing/${tGer}/complete`, { fields: [] });
let apDetail;
for (let i = 0; i < 60; i++) {
  apDetail = await api("GET", `/v1/envelopes/${apEnv.envelope.id}`);
  if (apDetail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(apDetail.envelope.status === "completed", `sobre con aprobador completado (estado ${apDetail.envelope.status})`);
const apEvents = (await api("GET", `/v1/envelopes/${apEnv.envelope.id}/events`)).items;
assert(apEvents.some((e) => e.type === "recipient.approved"), "la evidencia registra la aprobación");
step("plantilla con aprobador: el solicitante firma, gerencia aprueba sin campos y el sobre se completa");

// ── Condición que cita un campo borrado: se quita, no deja el campo oculto para siempre ──
const cEnv = (await api("POST", "/v1/envelopes", { subject: `Condición huérfana ${stamp}` })).envelope;
const cFd = new FormData();
cFd.append("file", new Blob([tinyPdf(1, "Anexo")], { type: "application/pdf" }), "anexo.pdf");
const cDoc = await api("POST", `/v1/envelopes/${cEnv.id}/documents`, cFd);
const ctrlId = randomUUID();
const firmaId = randomUUID();
const [rCtrl, rFirma] = [randomUUID(), randomUUID()];
const cName = `Firma condicional ${stamp}`;
const cRecips = [
  { id: rCtrl, role: "signer", routingOrder: 1, name: `Controla ${stamp}`, email: `controla+${stamp}@example.com` },
  // Firma después de quien controla la condición (una condición sobre un campo de alguien que firma al mismo tiempo se
  // rechaza al guardar los campos: se decidiría con un valor que todavía no existe).
  { id: rFirma, role: "signer", routingOrder: 2, name: cName, email: `condicional+${stamp}@example.com` },
];
await api("PUT", `/v1/envelopes/${cEnv.id}/recipients`, { recipients: cRecips });
await api("PUT", `/v1/envelopes/${cEnv.id}/fields`, {
  fields: [
    { id: ctrlId, documentId: cDoc.id, recipientId: rCtrl, type: "checkbox", page: 0, x: 0.1, y: 0.2, width: 0.04, height: 0.03, required: false, label: "Acepta anexo" },
    { documentId: cDoc.id, recipientId: rCtrl, type: "signature", page: 0, x: 0.1, y: 0.4, width: 0.25, height: 0.06 },
    { id: firmaId, documentId: cDoc.id, recipientId: rFirma, type: "signature", page: 0, x: 0.5, y: 0.7, width: 0.25, height: 0.06, conditions: [{ fieldId: ctrlId, operator: "checked" }] },
  ],
});
// Quien controlaba la condición pasa a copia: su casilla se borra.
cRecips[0].role = "cc";
const cAfter = await api("PUT", `/v1/envelopes/${cEnv.id}/recipients`, { recipients: cRecips });
assert(!cAfter.fields.some((f) => f.id === ctrlId), "la casilla de la copia se borró");
assert(!cAfter.fields.find((f) => f.id === firmaId)?.conditions, "la condición que citaba la casilla borrada se quitó");
await api("POST", `/v1/envelopes/${cEnv.id}/send`);
const tCond = (await linkFor(cName)).token;
await api("POST", `/v1/signing/${tCond}/consent`);
// Sin la condición huérfana, la firma vuelve a ser obligatoria (antes quedaba oculta y se completaba sin firmar).
await api("POST", `/v1/signing/${tCond}/complete`, { fields: [] }, { expect: 422 });
await api("POST", `/v1/signing/${tCond}/complete`, { fields: [], signature: { kind: "typed", imagePng: PNG, text: "Firma" } });
step("condición que citaba un campo borrado: se quita y la firma sigue siendo obligatoria");

// ── Adjunto de un campo que quedó oculto: no va al PDF final. Firma fallida: sus imágenes no quedan guardadas ──
// Las imágenes se cuentan en el almacenamiento local de la API (E2E_DATA_DIR = su DATA_DIR); sin eso se saltea.
const { readdirSync, statSync } = await import("node:fs");
const { join: pjoin } = await import("node:path");
function countSignatureBlobs(envId) {
  const root = process.env.E2E_DATA_DIR;
  if (!root) return null;
  let n = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = pjoin(dir, name);
      if (!statSync(p).isDirectory()) continue;
      if (name === "signatures" && p.includes(`${envId}`)) n += readdirSync(p).length;
      else walk(p);
    }
  };
  walk(root);
  return n;
}
const hEnv = (await api("POST", "/v1/envelopes", { subject: `Adjunto oculto ${stamp}` })).envelope;
const hFd = new FormData();
hFd.append("file", new Blob([tinyPdf(1, "Solicitud")], { type: "application/pdf" }), "solicitud.pdf");
const hDoc = await api("POST", `/v1/envelopes/${hEnv.id}/documents`, hFd);
const [noAplicaId, hAttId, rH] = [randomUUID(), randomUUID(), randomUUID()];
const hName = `Adjunto oculto ${stamp}`;
await api("PUT", `/v1/envelopes/${hEnv.id}/recipients`, {
  recipients: [{ id: rH, role: "signer", routingOrder: 1, name: hName, email: `oculto+${stamp}@example.com` }],
});
await api("PUT", `/v1/envelopes/${hEnv.id}/fields`, {
  fields: [
    { id: noAplicaId, documentId: hDoc.id, recipientId: rH, type: "checkbox", page: 0, x: 0.1, y: 0.2, width: 0.04, height: 0.03, required: false, label: "No aplica" },
    { id: hAttId, documentId: hDoc.id, recipientId: rH, type: "attachment", page: 0, x: 0.1, y: 0.3, width: 0.4, height: 0.05, required: true, label: "Comprobante", conditions: [{ fieldId: noAplicaId, operator: "unchecked" }] },
    { documentId: hDoc.id, recipientId: rH, type: "signature", page: 0, x: 0.1, y: 0.6, width: 0.25, height: 0.06 },
  ],
});
await api("POST", `/v1/envelopes/${hEnv.id}/send`);
const tH = (await linkFor(hName)).token;
await api("POST", `/v1/signing/${tH}/consent`);
const hAfd = new FormData();
hAfd.append("file", new Blob([tinyPdf(1, "Comprobante privado")], { type: "application/pdf" }), "comprobante.pdf");
await api("POST", `/v1/signing/${tH}/fields/${hAttId}/attachment`, hAfd);
// Intento fallido con firma: un campo desconocido lo rechaza dentro de la transacción, con las imágenes ya subidas.
await api("POST", `/v1/signing/${tH}/complete`, { fields: [{ id: randomUUID(), value: "x" }], signature: { kind: "typed", imagePng: PNG, text: "Firma" } }, { expect: 400 });
const afterFail = countSignatureBlobs(hEnv.id);
if (afterFail !== null) assert(afterFail === 0, `la firma de un intento fallido no queda guardada (quedaron ${afterFail})`);
// Marca "No aplica": el adjunto queda oculto.
await api("POST", `/v1/signing/${tH}/complete`, { fields: [{ id: noAplicaId, value: "true" }], signature: { kind: "typed", imagePng: PNG, text: "Firma" } });
if (afterFail !== null) assert(countSignatureBlobs(hEnv.id) === 1, "la firma completada sí queda guardada");
let hDetail;
for (let i = 0; i < 60; i++) {
  hDetail = await api("GET", `/v1/envelopes/${hEnv.id}`);
  if (hDetail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(hDetail.envelope.status === "completed", `sobre con adjunto oculto completado (estado ${hDetail.envelope.status})`);
const hPdfRes = await api("GET", `/v1/envelopes/${hEnv.id}/signed.pdf`, null, { raw: true });
const hOut = "var/e2e-productivity-hidden-attachment.pdf";
writeFileSync(hOut, Buffer.from(await hPdfRes.arrayBuffer()));
const hText = execFileSync("pdftotext", [hOut, "-"], { encoding: "utf8" });
assert(!hText.includes("Comprobante privado"), "el adjunto de un campo oculto no se anexa al PDF final");
step(
  `adjunto de un campo oculto: fuera del PDF final${afterFail === null ? " (conteo de imágenes salteado: sin E2E_DATA_DIR)" : "; la firma de un intento fallido no queda guardada"}`,
);

// ── Borrar un borrador, un documento o una plantilla borra sus PDF del almacenamiento (si nadie más los usa) ──
// Antes quedaban para siempre: la retención solo purga sobres completados.
function countPdfBlobs(segment) {
  const root = process.env.E2E_DATA_DIR;
  if (!root) return null;
  let n = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = pjoin(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.includes(`/${segment}/`) && name.endsWith(".pdf")) n++;
    }
  };
  walk(root);
  return n;
}
const blobCheck = process.env.E2E_DATA_DIR ? "" : " (conteo de archivos salteado: sin E2E_DATA_DIR)";
// Borrador con un documento propio: al borrarlo, el PDF se va.
const dEnv = (await api("POST", "/v1/envelopes", { subject: `Borrador a borrar ${stamp}` })).envelope;
const dFd = new FormData();
dFd.append("file", new Blob([tinyPdf(1, "Borrador privado")], { type: "application/pdf" }), "borrador.pdf");
const dDoc = await api("POST", `/v1/envelopes/${dEnv.id}/documents`, dFd);
const dFd2 = new FormData();
dFd2.append("file", new Blob([tinyPdf(1, "Anexo equivocado")], { type: "application/pdf" }), "anexo.pdf");
const dDoc2 = await api("POST", `/v1/envelopes/${dEnv.id}/documents`, dFd2);
if (blobCheck === "") assert(countPdfBlobs(dEnv.id) === 2, `el borrador tiene sus 2 PDF (${countPdfBlobs(dEnv.id)})`);
await api("DELETE", `/v1/envelopes/${dEnv.id}/documents/${dDoc2.id}`, null, { expect: 204 });
if (blobCheck === "") assert(countPdfBlobs(dEnv.id) === 1, `quitar un documento del borrador borra su PDF (quedaron ${countPdfBlobs(dEnv.id)})`);
await api("DELETE", `/v1/envelopes/${dEnv.id}`, null, { expect: 204 });
if (blobCheck === "") assert(countPdfBlobs(dEnv.id) === 0, `borrar el borrador borra su PDF (quedaron ${countPdfBlobs(dEnv.id)})`);
void dDoc;
// Plantilla compartida con un sobre: borrar la plantilla no rompe el sobre que usa su PDF; al borrar el sobre se va.
const sTpl = (await api("POST", "/v1/templates", { name: `Plantilla a borrar ${stamp}` })).template;
const sFd = new FormData();
sFd.append("file", new Blob([tinyPdf(1, "Plantilla compartida")], { type: "application/pdf" }), "plantilla.pdf");
await api("POST", `/v1/templates/${sTpl.id}/documents`, sFd);
await api("PUT", `/v1/templates/${sTpl.id}/roles`, { roles: [{ name: "Cliente", role: "signer", routingOrder: 1 }] });
const sEnv = await api("POST", "/v1/envelopes/from-template", {
  templateId: sTpl.id,
  recipients: [{ role: "Cliente", name: `Cliente borrado ${stamp}`, email: `borrado+${stamp}@example.com` }],
});
await api("DELETE", `/v1/templates/${sTpl.id}`, null, { expect: 204 });
const sDocRes = await api("GET", `/v1/envelopes/${sEnv.envelope.id}/documents/${sEnv.documents[0].id}/file`, null, { raw: true });
assert(sDocRes.status === 200, `borrar la plantilla no borra el PDF que usa un sobre (HTTP ${sDocRes.status})`);
if (blobCheck === "") assert(countPdfBlobs(sTpl.id) === 1, "el PDF compartido sigue guardado");
await api("DELETE", `/v1/envelopes/${sEnv.envelope.id}`, null, { expect: 204 });
if (blobCheck === "") assert(countPdfBlobs(sTpl.id) === 0, `sin plantilla ni sobre, el PDF compartido se borra (quedaron ${countPdfBlobs(sTpl.id)})`);
step(`borrar un borrador, un documento o una plantilla borra sus PDF sin romper lo que todavía los usa${blobCheck}`);

// ── Una fórmula que cita un campo número borrado (con su destinatario) frena el envío ──
// Si no, se calculaba con 0 y el PDF firmado decía "Total: 0".
const fEnv = (await api("POST", "/v1/envelopes", { subject: `Fórmula huérfana ${stamp}` })).envelope;
const fFd = new FormData();
fFd.append("file", new Blob([tinyPdf(1, "Cotizacion")], { type: "application/pdf" }), "cotizacion.pdf");
const fDoc = await api("POST", `/v1/envelopes/${fEnv.id}/documents`, fFd);
const [fA, fB, fMonto, fTotal] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
await api("PUT", `/v1/envelopes/${fEnv.id}/recipients`, {
  recipients: [
    { id: fA, role: "signer", routingOrder: 1, name: `Vendedor ${stamp}`, email: `vendedor+${stamp}@example.com` },
    { id: fB, role: "signer", routingOrder: 2, name: `Comprador ${stamp}`, email: `comprador+${stamp}@example.com` },
  ],
});
await api("PUT", `/v1/envelopes/${fEnv.id}/fields`, {
  fields: [
    { id: fMonto, documentId: fDoc.id, recipientId: fA, type: "number", page: 0, x: 0.1, y: 0.2, width: 0.2, height: 0.04, label: "Monto" },
    { documentId: fDoc.id, recipientId: fA, type: "signature", page: 0, x: 0.1, y: 0.3, width: 0.25, height: 0.06 },
    { id: fTotal, documentId: fDoc.id, recipientId: fB, type: "number", page: 0, x: 0.5, y: 0.2, width: 0.2, height: 0.04, label: "Total", formula: "{Monto} * 2" },
    { documentId: fDoc.id, recipientId: fB, type: "signature", page: 0, x: 0.5, y: 0.3, width: 0.25, height: 0.06 },
  ],
});
// El remitente quita al vendedor: su campo "Monto" se borra con él y la fórmula queda citando un campo que no está.
await api("PUT", `/v1/envelopes/${fEnv.id}/recipients`, {
  recipients: [{ id: fB, role: "signer", routingOrder: 1, name: `Comprador ${stamp}`, email: `comprador+${stamp}@example.com` }],
});
const fSend = await api("POST", `/v1/envelopes/${fEnv.id}/send`, null, { raw: true });
const fBody = await fSend.json();
assert(fSend.status === 422 && /Monto/.test(fBody.error?.message ?? ""), `una fórmula que cita un campo borrado frena el envío (HTTP ${fSend.status} ${JSON.stringify(fBody.error ?? {})})`);
step("una fórmula que cita un campo número que ya no está frena el envío");

console.log("\nE2E PRODUCTIVIDAD OK");
