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

console.log("\nE2E PRODUCTIVIDAD OK");
