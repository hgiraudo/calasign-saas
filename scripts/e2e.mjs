#!/usr/bin/env node
// Prueba de punta a punta contra una API en marcha (local o dev.calasign.com).
// Uso: node scripts/e2e.mjs [baseUrl]    (requiere el buzón de desarrollo habilitado en el entorno)
// Deja el PDF sellado en ./var/e2e-signed.pdf
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
let cookie = "";

async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}

function step(msg) {
  console.log(`✓ ${msg}`);
}

// PDF mínimo de 2 páginas, generado a mano (sin dependencias).
function tinyPdf() {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>");
  for (let i = 0; i < 2; i++) {
    const content = `BT /F1 18 Tf 72 760 Td (Contrato de prueba E2E - pagina ${i + 1}) Tj ET`;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 7 0 R >> >> >>`);
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

// PNG 8x8 negro (una firma necesita un mínimo de píxeles con tinta).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAADElEQVR4nGNgoA4AAABIAAEuuDx+AAAAAElFTkSuQmCC";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function linkFor(name) {
  for (let i = 0; i < 40; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

const stamp = Date.now();
await api("POST", "/v1/auth/signup", {
  name: "Ana Remitente",
  email: `ana+${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `ACME ${stamp}`,
  locale: "es",
});
step("alta de cuenta y sesión");

const { envelope } = await api(
  "POST",
  "/v1/envelopes",
  { subject: `Contrato E2E ${stamp}`, message: "Por favor firmá" },
  { headers: { "idempotency-key": `e2e-${stamp}` } },
);
const again = await api(
  "POST",
  "/v1/envelopes",
  { subject: `Contrato E2E ${stamp}`, message: "Por favor firmá" },
  { headers: { "idempotency-key": `e2e-${stamp}` } },
);
if (again.envelope.id !== envelope.id) throw new Error("idempotencia rota");
// La clave vale por credencial: otra integración de la misma organización que use la misma clave y el mismo cuerpo
// (p. ej. el id de un pedido) crea su propio sobre; no recibe la respuesta guardada de la sesión.
{
  const { secret } = await api("POST", "/v1/api-keys", { name: `idem ${stamp}` });
  const res = await fetch(BASE + "/v1/envelopes", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "idempotency-key": `e2e-${stamp}` },
    body: JSON.stringify({ subject: `Contrato E2E ${stamp}`, message: "Por favor firmá" }),
  });
  const other = await res.json();
  if (res.status !== 201 || res.headers.get("idempotent-replay") || other.envelope?.id === envelope.id) {
    throw new Error(`otra credencial recibió la respuesta guardada de la misma Idempotency-Key (HTTP ${res.status})`);
  }
}
step(`sobre creado ${envelope.id} (idempotente, por credencial)`);

const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const doc = await api("POST", `/v1/envelopes/${envelope.id}/documents`, fd);
step(`documento subido (${doc.pageCount} páginas, sha256 ${doc.sha256.slice(0, 12)}…)`);

const s1 = randomUUID();
const s2 = randomUUID();
const cc = randomUUID();
const signer1 = `José Pérez ${stamp}`;
const signer2 = `Maria Gonçalves ${stamp}`;
await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [
    {
      id: s1,
      name: signer1,
      email: `jose+${stamp}@example.com`,
      routingOrder: 1,
      channels: ["email"],
      idDocumentType: "cedula",
      idDocumentNumber: "001-1234567-8",
    },
    {
      id: s2,
      name: signer2,
      email: `maria+${stamp}@example.com`,
      phone: "+5511999990000",
      routingOrder: 2,
      locale: "pt-BR",
      channels: ["email", "whatsapp", "telegram"],
    },
    { id: cc, name: `Copia ${stamp}`, email: `cc+${stamp}@example.com`, role: "cc", routingOrder: 3, channels: ["email"] },
  ],
});
step("destinatarios: 2 firmantes en secuencia + 1 copia");

await api("PUT", `/v1/envelopes/${envelope.id}/fields`, {
  fields: [
    { documentId: doc.id, recipientId: s1, type: "signature", page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.08 },
    { documentId: doc.id, recipientId: s1, type: "name", page: 1, x: 0.1, y: 0.79, width: 0.3, height: 0.03 },
    { documentId: doc.id, recipientId: s1, type: "date_signed", page: 1, x: 0.1, y: 0.83, width: 0.2, height: 0.03 },
    { documentId: doc.id, recipientId: s1, type: "checkbox", page: 0, x: 0.1, y: 0.3, width: 0.03, height: 0.02 },
    { documentId: doc.id, recipientId: s2, type: "signature", page: 1, x: 0.55, y: 0.7, width: 0.3, height: 0.08 },
    { documentId: doc.id, recipientId: s2, type: "text", page: 1, x: 0.55, y: 0.79, width: 0.3, height: 0.03, label: "Cargo" },
    { documentId: doc.id, recipientId: s2, type: "initials", page: 0, x: 0.85, y: 0.92, width: 0.08, height: 0.04 },
  ],
});
step("campos ubicados");

const sent = await api("POST", `/v1/envelopes/${envelope.id}/send`);
if (sent.envelope.status !== "sent") throw new Error("no quedó enviado");
step("sobre enviado");

// Firmante 1
const t1 = await linkFor(signer1);
let sess = await api("GET", `/v1/signing/${t1}`);
if (!sess.canSign) throw new Error("firmante 1 debería poder firmar");
sess = await api("POST", `/v1/signing/${t1}/consent`);
const fields1 = sess.fields.filter((f) => f.type === "checkbox").map((f) => ({ id: f.id, value: "true" }));
sess = await api("POST", `/v1/signing/${t1}/complete`, { fields: fields1, signature: { kind: "drawn", imagePng: PNG } });
if (sess.recipient.status !== "signed") throw new Error("firmante 1 no quedó firmado");
step("firmante 1 vio, aceptó y firmó");

// Firmante 2 (recién ahora recibe la invitación)
const t2 = await linkFor(signer2);
sess = await api("GET", `/v1/signing/${t2}`);
if (sess.recipient.locale !== "pt-BR") throw new Error("locale del firmante 2");
await api("POST", `/v1/signing/${t2}/consent`);
const fields2 = sess.fields.filter((f) => f.type === "text").map((f) => ({ id: f.id, value: "Diretora Financeira" }));
const bad = await api(
  "POST",
  `/v1/signing/${t2}/complete`,
  { fields: [], signature: { kind: "typed", imagePng: PNG, text: "Maria" } },
  { raw: true },
);
if (bad.status !== 422) throw new Error(`faltaba validar el campo obligatorio (HTTP ${bad.status})`);
sess = await api("POST", `/v1/signing/${t2}/complete`, { fields: fields2, signature: { kind: "typed", imagePng: PNG, text: "Maria" } });
step("firmante 2 firmó (y se rechazó un intento incompleto)");

// Esperar sellado
let detail;
for (let i = 0; i < 60; i++) {
  detail = await api("GET", `/v1/envelopes/${envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(1000);
}
if (detail.envelope.status !== "completed") throw new Error(`no se completó: ${detail.envelope.status}`);
step(`sobre completado, sha256 final ${detail.envelope.signedSha256.slice(0, 12)}…`);

const pdf = Buffer.from(await (await api("GET", `/v1/envelopes/${envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
mkdirSync("var", { recursive: true });
writeFileSync("var/e2e-signed.pdf", pdf);
const ccLink = await linkFor(`Copia ${stamp}`);
const ccPdf = await api("GET", `/v1/signing/${ccLink}/signed.pdf`, null, { raw: true });
if (ccPdf.status !== 200) throw new Error("la copia no puede descargar");
step(`PDF sellado descargado (${pdf.length} bytes) → var/e2e-signed.pdf; la copia también puede descargarlo`);

const { items: events } = await api("GET", `/v1/envelopes/${envelope.id}/events`);
const completed = events.find((e) => e.type === "envelope.completed");
console.log(`✓ ${events.length} eventos; sello: ${JSON.stringify(completed.data.seal)}`);
console.log("\nE2E OK");
