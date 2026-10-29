#!/usr/bin/env node
// E2E del bloque "firmante y evidencia": OTP por email, aprobador, delegación, reasignación y verificación pública.
// Uso: node scripts/e2e-signer.mjs [baseUrl]   (requiere el buzón de desarrollo)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`✓ ${m}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`FALLÓ: ${msg}`);
}

/** Cliente con su propia cookie (remitente o firmante). */
function client() {
  let cookie = "";
  return async function call(method, path, body, { raw = false, form = null } = {}) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined && body !== null) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    if (raw) return res;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status} ${text}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };
}

async function expectStatus(promise, status, msg) {
  try {
    await promise;
  } catch (e) {
    assert(e.status === status, `${msg}: se esperaba HTTP ${status} y vino ${e.status} ${e.message}`);
    return e.data;
  }
  throw new Error(`FALLÓ: ${msg}: se esperaba HTTP ${status} y la llamada salió bien`);
}

function tinyPdf() {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = "BT /F1 18 Tf 72 760 Td (Contrato E2E firmante) Tj ET";
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);
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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAADElEQVR4nGNgoA4AAABIAAEuuDx+AAAAAElFTkSuQmCC";
const sender = client();
const stamp = Date.now();

async function mailbox() {
  return (await sender("GET", "/dev/mailbox")).items;
}
async function linkFor(email) {
  for (let i = 0; i < 40; i++) {
    const m = (await mailbox()).find((x) => x.to === email && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación a ${email}`);
}
async function codeFor(email, after) {
  for (let i = 0; i < 20; i++) {
    const m = (await mailbox()).find((x) => x.to === email && /\b\d{6}\b/.test(x.text) && x.createdAt > after);
    if (m) return m.text.match(/\b(\d{6})\b/)[1];
    await sleep(300);
  }
  throw new Error(`no llegó el código a ${email}`);
}

await sender("POST", "/v1/auth/signup", {
  name: "Remitente",
  email: `rem+${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `Firmante SA ${stamp}`,
});
const { envelope } = await sender("POST", "/v1/envelopes", {
  subject: `Sobre firmante ${stamp}`,
  reminderEveryDays: 2,
  expiryWarningDays: 3,
  allowDelegation: true,
});
assert(envelope.reminderEveryDays === 2 && envelope.allowDelegation === true, "configuración de recordatorios");
const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const doc = await sender("POST", `/v1/envelopes/${envelope.id}/documents`, null, { form: fd });

const em = (n) => `${n}+${stamp}@example.com`;
const ids = { s1: randomUUID(), ap: randomUUID(), s3: randomUUID(), s4: randomUUID(), cc: randomUUID() };
await sender("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [
    { id: ids.s1, name: "Sofía OTP", email: em("s1"), routingOrder: 1, authMethod: "otp_email" },
    { id: ids.ap, name: "Andrés Aprobador", email: em("ap"), role: "approver", routingOrder: 2 },
    { id: ids.s3, name: "Diego Delega", email: em("s3"), routingOrder: 3 },
    { id: ids.s4, name: "Raúl Reasignado", email: em("s4"), routingOrder: 4 },
    { id: ids.cc, name: "Carla Copia", email: em("cc"), role: "cc", routingOrder: 5 },
  ],
});
await sender("PUT", `/v1/envelopes/${envelope.id}/fields`, {
  fields: [ids.s1, ids.s3, ids.s4].map((r, i) => ({
    documentId: doc.id,
    recipientId: r,
    type: "signature",
    page: 0,
    x: 0.1 + i * 0.28,
    y: 0.7,
    width: 0.25,
    height: 0.07,
  })),
});
let detail = await sender("POST", `/v1/envelopes/${envelope.id}/send`);
assert(detail.recipients.find((r) => r.id === ids.s1).authMethod === "otp_email", "authMethod persistido");
step("sobre enviado: OTP + aprobador + 2 firmantes + copia (el aprobador no necesita campos)");

// Reasignación por el remitente mientras el destinatario todavía no fue invitado.
detail = await sender("POST", `/v1/envelopes/${envelope.id}/recipients/${ids.s4}/reassign`, {
  name: "Rita Reemplazo",
  email: em("rita"),
  reason: "cambió de área",
});
const old4 = detail.recipients.find((r) => r.id === ids.s4);
const rita = detail.recipients.find((r) => r.email === em("rita"));
assert(old4.status === "reassigned" && old4.replacedBy === rita.id, "reasignado");
assert(detail.fields.some((f) => f.recipientId === rita.id) && !detail.fields.some((f) => f.recipientId === ids.s4), "los campos pasan al nuevo");
assert(rita.status === "created", "el reemplazo espera su turno");
step("remitente reasignó a un firmante pendiente; heredó campos y orden");

// Firmante 1: OTP por email.
const t1 = await linkFor(em("s1"));
const s1 = client();
let sess = await s1("GET", `/v1/signing/${t1}`);
assert(sess.otpRequired && sess.documents.length === 0 && sess.fields.length === 0, "sin código no ve documentos");
assert(sess.otpDestination?.includes("***"), "destino enmascarado");
let err = await expectStatus(s1("POST", `/v1/signing/${t1}/consent`), 401, "consentir sin código");
assert(err.error.code === "otp_required", "código otp_required");
await expectStatus(s1("GET", `/v1/signing/${t1}/documents/${doc.id}/file`, null, { raw: false }), 401, "bajar documento sin código");
const t0 = new Date(Date.now() - 1000).toISOString();
await s1("POST", `/v1/signing/${t1}/otp/send`);
await expectStatus(s1("POST", `/v1/signing/${t1}/otp/send`), 429, "reenvío inmediato");
const code = await codeFor(em("s1"), t0);
const wrong = code === "000000" ? "111111" : "000000";
err = await expectStatus(s1("POST", `/v1/signing/${t1}/otp/verify`, { code: wrong }), 400, "código incorrecto");
assert(err.error.details.remaining === 4, "quedan 4 intentos");
sess = await s1("POST", `/v1/signing/${t1}/otp/verify`, { code });
assert(!sess.otpRequired && sess.documents.length === 1 && sess.recipient.status === "viewed", "con código ve documentos");
const other = client();
const o = await other("GET", `/v1/signing/${t1}`);
assert(o.otpRequired, "otro navegador sigue necesitando código");
await s1("POST", `/v1/signing/${t1}/consent`);
sess = await s1("POST", `/v1/signing/${t1}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
assert(sess.recipient.status === "signed", "firmante 1 firmó");
step("OTP por email: bloquea sin código, cooldown, intento fallido, sesión por cookie, firma");

// Copia en curso: quien ya firmó puede bajar lo firmado hasta ahora (con su código), sin el PDF final.
assert(sess.copyAvailable && !sess.signedAvailable, "copia disponible, PDF final todavía no");
await expectStatus(other("GET", `/v1/signing/${t1}/copy.pdf`), 401, "copia sin código");
const copyRes = await s1("GET", `/v1/signing/${t1}/copy.pdf`, null, { raw: true });
const copy = Buffer.from(await copyRes.arrayBuffer());
assert(copyRes.status === 200 && copyRes.headers.get("content-type") === "application/pdf", `copia ${copyRes.status}`);
assert(copy.subarray(0, 5).toString() === "%PDF-", "la copia es un PDF");
mkdirSync("var", { recursive: true });
writeFileSync("var/e2e-signer-copy.pdf", copy);
await expectStatus(s1("GET", `/v1/signing/${t1}/signed.pdf`), 404, "PDF final antes de completar");
step("el firmante que ya firmó baja una copia en curso; sin código no");

// Aprobador.
const tap = await linkFor(em("ap"));
const ap = client();
sess = await ap("GET", `/v1/signing/${tap}`);
assert(sess.recipient.role === "approver" && sess.canSign && sess.fields.length === 0, "aprobador puede aprobar");
await ap("POST", `/v1/signing/${tap}/consent`);
sess = await ap("POST", `/v1/signing/${tap}/complete`, { fields: [] });
assert(sess.recipient.status === "signed", "aprobó");
step("aprobador aprobó sin campos ni firma");

// Delegación.
const t3 = await linkFor(em("s3"));
const s3 = client();
sess = await s3("GET", `/v1/signing/${t3}`);
assert(sess.canDelegate, "puede delegar");
const del = await s3("POST", `/v1/signing/${t3}/delegate`, { name: "Dora Delegada", email: em("dora"), reason: "estoy de viaje" });
assert(del.delegated, "delegó");
await expectStatus(s3("GET", `/v1/signing/${t3}`), 404, "el link anterior queda revocado");
const td = await linkFor(em("dora"));
const dora = client();
sess = await dora("GET", `/v1/signing/${td}`);
assert(sess.canSign && sess.fields.length === 1, "la delegada hereda el campo");
await dora("POST", `/v1/signing/${td}/consent`);
await dora("POST", `/v1/signing/${td}/complete`, { fields: [], signature: { kind: "typed", imagePng: PNG, text: "Dora" } });
step("firmante delegó; link anterior revocado; la delegada firmó");

// Reemplazo por reasignación firma en su turno.
const tr = await linkFor(em("rita"));
const r = client();
await r("GET", `/v1/signing/${tr}`);
await r("POST", `/v1/signing/${tr}/consent`);
await r("POST", `/v1/signing/${tr}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
step("la reasignada firmó en su turno");

for (let i = 0; i < 60; i++) {
  detail = await sender("GET", `/v1/envelopes/${envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(detail.envelope.status === "completed", `completado (${detail.envelope.status})`);
const pdf = Buffer.from(await (await sender("GET", `/v1/envelopes/${envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
mkdirSync("var", { recursive: true });
sess = await s1("GET", `/v1/signing/${t1}`);
assert(sess.signedAvailable && !sess.copyAvailable, "completo: PDF final en lugar de la copia");
const finalRes = await s1("GET", `/v1/signing/${t1}/signed.pdf`, null, { raw: true });
assert(finalRes.status === 200 && (await finalRes.arrayBuffer()).byteLength > 1000, `el firmante baja el PDF final (${finalRes.status})`);
await expectStatus(other("GET", `/v1/signing/${t1}/signed.pdf`), 401, "PDF final sin código");
step("completo: el firmante baja el PDF sellado; sin código no");
writeFileSync("var/e2e-signer-signed.pdf", pdf);
const txt = execFileSync("pdftotext", ["-layout", "var/e2e-signer-signed.pdf", "-"], { encoding: "utf8" });
for (const needle of ["Aprobador", "Delegó en Dora Delegada", "Reasignado a Rita Reemplazo", "código de un solo uso por correo", "/verify"])
  assert(txt.includes(needle), `el certificado incluye "${needle}"`);
const { items: events } = await sender("GET", `/v1/envelopes/${envelope.id}/events`);
for (const t of [
  "recipient.otp_sent",
  "recipient.otp_failed",
  "recipient.authenticated",
  "recipient.approved",
  "recipient.delegated",
  "recipient.reassigned",
])
  assert(
    events.some((e) => e.type === t),
    `evento ${t}`,
  );
step("sobre completado; certificado y eventos reflejan OTP, aprobación, delegación y reasignación");

// Verificación pública.
const pub = client();
const vf = new FormData();
vf.append("file", new Blob([pdf], { type: "application/pdf" }), "x.pdf");
const ok = await pub("POST", "/v1/verify", null, { form: vf });
assert(ok.match && ok.envelope.id === envelope.id && ok.chain.ok && ok.participants.length === 4, "verifica el original");
const bad = Buffer.from(pdf);
bad[Math.floor(bad.length / 2)] ^= 0x01;
const vf2 = new FormData();
vf2.append("file", new Blob([bad], { type: "application/pdf" }), "x.pdf");
const no = await pub("POST", "/v1/verify", null, { form: vf2 });
assert(no.match === false, "un PDF modificado no coincide");
step(`verificación pública: original ✓ (cadena íntegra, ${ok.chain.events} eventos), modificado ✗`);

console.log("\nE2E FIRMANTE OK");
