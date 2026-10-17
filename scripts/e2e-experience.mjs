#!/usr/bin/env node
// E2E del bloque "experiencia" (Fase 4): firma en persona, correcciones en vuelo (revocación de tokens,
// inmutabilidad de quien ya firmó), reportes + CSV y reenvío/pedido de copias.
// Uso: node scripts/e2e-experience.mjs [baseUrl]   (requiere el buzón de desarrollo)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`✓ ${m}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`FALLÓ: ${msg}`);
}

/** Cliente con su propio frasco de cookies (varias cookies, como un navegador; se ignora el path). */
function client() {
  const jar = new Map();
  const call = async (method, path, body, { raw = false, form = null, headers: extra = {} } = {}) => {
    const headers = { ...extra };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload;
    if (form) payload = form;
    else if (body !== undefined && body !== null) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv, ...attrs] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (!v || expired) jar.delete(k);
      else jar.set(k, v);
    }
    if (raw) return res;
    const text = await res.text();
    const data = text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : text;
    if (!res.ok) {
      const err = new Error(`${method} ${path} → ${res.status} ${text}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };
  call.jar = jar;
  return call;
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

function tinyPdf(title) {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = `BT /F1 18 Tf 72 760 Td (${title}) Tj ET`;
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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const sig = { kind: "typed", imagePng: PNG, text: "Firma" };

const sender = client();
const stamp = Date.now();

async function mailbox() {
  return (await sender("GET", "/dev/mailbox")).items;
}
/** Último link de firma recibido por alguien cuyo texto incluye `name` (y opcionalmente distinto de `not`). */
async function linkFor(name, { not = null, count = 1 } = {}) {
  for (let i = 0; i < 60; i++) {
    const items = (await mailbox()).filter((x) => x.text.includes(name) && x.link?.includes("/s/"));
    const tokens = [...new Set(items.map((x) => x.link.split("/s/")[1]))].filter((t) => t !== not);
    if (tokens.length && items.length >= count) return tokens[0];
    await sleep(400);
  }
  throw new Error(`no llegó un link para ${name}`);
}

// ───────────────────────────── Preparación ─────────────────────────────

const me = await sender("POST", "/v1/auth/signup", {
  name: "Ana Anfitriona",
  email: `ana.exp+${stamp}@example.com`,
  password: "una-clave-segura-123",
  organization: `Experiencia ${stamp}`,
});
step("alta de la organización");

const { envelope } = await sender("POST", "/v1/envelopes", { subject: `Contrato en persona ${stamp}`, message: "Mensaje original" });
const fd = new FormData();
fd.append("file", new Blob([tinyPdf("Contrato E2E experiencia")], { type: "application/pdf" }), "contrato.pdf");
const doc = await sender("POST", `/v1/envelopes/${envelope.id}/documents`, null, { form: fd });

const R1 = randomUUID(); // en persona, sin correo
const R2 = randomUUID();
const R3 = randomUUID();
const R4 = randomUUID(); // copia
const n = (x) => `${x} ${stamp}`;
await sender("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [
    { id: R1, name: n("Pedro Presencial"), routingOrder: 1, inPerson: {}, idDocumentType: "cedula", idDocumentNumber: "001-7654321-0" },
    { id: R2, name: n("Beatriz Segunda"), email: `bea+${stamp}@example.com`, routingOrder: 2 },
    { id: R3, name: n("Carlos Tercero"), email: `carlos+${stamp}@example.com`, routingOrder: 2 },
    { id: R4, name: n("Copia Cuarta"), email: `cc+${stamp}@example.com`, role: "cc", routingOrder: 3 },
  ],
});
const fieldFor = (rid, y, type = "signature") => ({ documentId: doc.id, recipientId: rid, type, page: 0, x: 0.1, y, width: 0.3, height: 0.06 });
await sender("PUT", `/v1/envelopes/${envelope.id}/fields`, {
  fields: [fieldFor(R1, 0.2), fieldFor(R2, 0.35), fieldFor(R3, 0.5)],
});
let detail = await sender("GET", `/v1/envelopes/${envelope.id}`);
const r1 = detail.recipients.find((r) => r.id === R1);
assert(r1.authMethod === "in_person" && r1.inPersonHost?.id === me.user.id, "R1 quedó en persona con la anfitriona");
await sender("POST", `/v1/envelopes/${envelope.id}/send`);
await sleep(1500);
assert(!(await mailbox()).some((m) => m.text.includes(n("Pedro Presencial"))), "el firmante en persona no recibe invitación");
step("sobre enviado; el firmante en persona no recibe invitación");

// ───────────────────────────── Firma en persona ─────────────────────────────

const key = await sender("POST", "/v1/api-keys", { name: "exp" });
const apiClient = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
};
assert((await apiClient("POST", `/v1/envelopes/${envelope.id}/recipients/${R1}/in-person`, {})) === 403, "una API key no abre la firma en persona");

const device = client(); // el navegador de la anfitriona
for (const [k, v] of sender.jar) device.jar.set(k, v);
const start = await device("POST", `/v1/envelopes/${envelope.id}/recipients/${R1}/in-person`, {});
assert(start.url.startsWith("/s/") && start.url.includes("inperson=1"), "URL de sesión en persona");
const t1 = start.url.split("/s/")[1].split("?")[0];
assert(device.jar.has("cs_signer"), "la sesión del firmante queda como cookie en el dispositivo");

const stranger = client();
const blocked = await stranger("GET", `/v1/signing/${t1}`);
assert(blocked.otpRequired && blocked.documents.length === 0 && blocked.inPerson?.active === false, "sin la sesión del anfitrión no se ven documentos");
await expectStatus(stranger("POST", `/v1/signing/${t1}/consent`), 401, "sin la sesión del anfitrión no se puede aceptar");

let sess = await device("GET", `/v1/signing/${t1}`);
assert(!sess.otpRequired && sess.documents.length === 1, "con la sesión del anfitrión se ven los documentos");
assert(sess.inPerson?.active && !sess.inPerson.identityConfirmed && sess.inPerson.hostName === "Ana Anfitriona", "datos de la sesión en persona");
await device("POST", `/v1/signing/${t1}/in-person/confirm`, { confirmed: true, idDocumentNumber: "0017654321-0" });
sess = await device("GET", `/v1/signing/${t1}`);
assert(sess.inPerson.identityConfirmed, "identidad confirmada");
await device("POST", `/v1/signing/${t1}/consent`);
sess = await device("POST", `/v1/signing/${t1}/complete`, { fields: [], signature: sig });
assert(sess.recipient.status === "signed", "firmó en persona");
await device("POST", `/v1/signing/${t1}/in-person/end`);
assert(!device.jar.has("cs_signer"), "al terminar se borra la sesión del firmante");
const after = await device("GET", `/v1/signing/${t1}`);
assert(after.otpRequired && after.documents.length === 0, "terminada la sesión, el dispositivo ya no ve los documentos");
step("firma en persona: sesión del anfitrión, confirmación de identidad, firma y cierre de sesión");

// ───────────────────────────── Correcciones en vuelo ─────────────────────────────

const oldT3 = await linkFor(n("Carlos Tercero"));
const t2 = await linkFor(n("Beatriz Segunda"));
await sender("GET", `/v1/signing/${t2}`); // Beatriz abre el sobre → ya no se le pueden cambiar campos

await expectStatus(
  sender("POST", `/v1/envelopes/${envelope.id}/corrections`, { updateRecipients: [{ id: R1, name: "Otro nombre" }] }),
  409,
  "quien ya firmó es inmutable",
);
await expectStatus(sender("POST", `/v1/envelopes/${envelope.id}/corrections`, { removeRecipientIds: [R2] }), 409, "no se quita a quien ya abrió");
await expectStatus(
  sender("POST", `/v1/envelopes/${envelope.id}/corrections`, { addFields: [fieldFor(R2, 0.6, "text")] }),
  409,
  "no se cambian campos de quien ya abrió",
);
const r3SigField = detail.fields.find((f) => f.recipientId === R3 && f.type === "signature");
await expectStatus(
  sender("POST", `/v1/envelopes/${envelope.id}/corrections`, { removeFieldIds: [r3SigField.id] }),
  422,
  "un firmante pendiente no puede quedarse sin campo de firma",
);

const R5 = randomUUID();
const newExpiry = new Date(Date.now() + 20 * 86400_000).toISOString();
detail = await sender("POST", `/v1/envelopes/${envelope.id}/corrections`, {
  message: "Mensaje corregido",
  expiresAt: newExpiry,
  updateRecipients: [{ id: R3, email: `carlos.nuevo+${stamp}@example.com` }],
  addRecipients: [{ id: R5, name: n("Elena Quinta"), email: `elena+${stamp}@example.com`, routingOrder: 2 }],
  addFields: [fieldFor(R5, 0.65), fieldFor(R3, 0.8, "text")],
  reason: "Cambió el correo de Carlos",
});
assert(detail.envelope.message === "Mensaje corregido", "mensaje corregido");
assert(detail.recipients.some((r) => r.id === R5 && r.status === "sent"), "el nuevo firmante del grupo actual quedó invitado");
await expectStatus(stranger("GET", `/v1/signing/${oldT3}`), 404, "el link anterior de Carlos quedó revocado");
const newT3 = await linkFor(n("Carlos Tercero"), { not: oldT3 });
assert(newT3 !== oldT3, "Carlos recibió un link nuevo");
const t5 = await linkFor(n("Elena Quinta"));
await expectStatus(
  sender("POST", `/v1/envelopes/${envelope.id}/corrections`, {
    addRecipients: [{ name: n("Tarde"), email: `tarde+${stamp}@example.com`, routingOrder: 1 }],
  }),
  409,
  "no se agrega a un grupo de firma que ya terminó",
);
const events1 = (await sender("GET", `/v1/envelopes/${envelope.id}/events`)).items;
const corrected = events1.find((e) => e.type === "envelope.corrected");
assert(corrected && corrected.data.message && corrected.data.expiresAt && corrected.data.recipientsAdded?.length === 1, "evento con el diff");
assert(corrected.data.recipientsUpdated?.[0]?.tokenRotated === true, "el diff registra la rotación del link");
step("correcciones: mensaje, vencimiento, contacto (link revocado y reenviado), firmante y campos nuevos; reglas de inmutabilidad");

// ───────────────────────────── Completar ─────────────────────────────

for (const t of [t2, newT3, t5]) {
  const c = client();
  const s = await c("GET", `/v1/signing/${t}`);
  await c("POST", `/v1/signing/${t}/consent`);
  const values = s.fields.filter((f) => f.type === "text").map((f) => ({ id: f.id, value: "Gerente" }));
  await c("POST", `/v1/signing/${t}/complete`, { fields: values, signature: sig });
}
for (let i = 0; i < 60; i++) {
  detail = await sender("GET", `/v1/envelopes/${envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(1000);
}
assert(detail.envelope.status === "completed", `completado (estado ${detail.envelope.status})`);
const pdf = Buffer.from(await (await sender("GET", `/v1/envelopes/${envelope.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
const dir = mkdtempSync(join(tmpdir(), "e2e-exp-"));
writeFileSync(join(dir, "s.pdf"), pdf);
const text = execFileSync("pdftotext", [join(dir, "s.pdf"), "-"], { encoding: "utf8" });
assert(/En persona, presentado por Ana Anfitriona/.test(text.replace(/\s+/g, " ")), "el certificado dice 'En persona, presentado por <anfitrión>'");
step("sobre completado; el certificado muestra la firma en persona");

// ───────────────────────────── Copias ─────────────────────────────

const ccName = n("Copia Cuarta");
const before = (await mailbox()).filter((m) => m.text.includes(ccName)).length;
const q = await sender("POST", `/v1/envelopes/${envelope.id}/recipients/${R4}/resend-copy`);
assert(q.queued, "copia reenviada");
for (let i = 0; i < 30 && (await mailbox()).filter((m) => m.text.includes(ccName)).length <= before; i++) await sleep(400);
assert((await mailbox()).filter((m) => m.text.includes(ccName)).length > before, "llegó la copia reenviada");
const signer2 = client();
await signer2("POST", `/v1/signing/${t2}/request-copy`);
await expectStatus(signer2("POST", `/v1/signing/${t2}/request-copy`), 429, "no se piden copias en ráfaga");
const events2 = (await sender("GET", `/v1/envelopes/${envelope.id}/events`)).items.map((e) => e.type);
for (const t of [
  "recipient.in_person_started",
  "recipient.identity_confirmed",
  "recipient.in_person_ended",
  "envelope.corrected",
  "envelope.copy_resent",
  "recipient.copy_requested",
])
  assert(events2.includes(t), `evento ${t}`);
step("copias: reenvío del remitente y pedido del firmante (con límite), todo en la evidencia");

// ───────────────────────────── Reportes ─────────────────────────────

await sender("POST", "/v1/envelopes", { subject: '=HYPERLINK("http://evil","x")' }); // borrador con fórmula
const rep = await sender("GET", "/v1/reports/summary");
assert(rep.totals.created === 2 && rep.totals.sent === 1 && rep.totals.completed === 1, `totales ${JSON.stringify(rep.totals)}`);
assert(rep.totals.completionRate === 1 && rep.totals.avgHoursToComplete !== null, "tasa de completado y tiempo promedio");
const month = new Date().toISOString().slice(0, 7);
const m = rep.byMonth.find((x) => x.month === month);
assert(m && m.created === 2 && m.completed === 1 && m.draft === 1, `mes actual ${JSON.stringify(m)}`);
assert(rep.byMonth.length === 6, "seis meses por defecto");
assert(rep.topSenders[0]?.name === "Ana Anfitriona" && rep.topSenders[0].sent === 1, "remitente principal");
const mail = rep.notifications.find((x) => x.channel === "email");
assert(mail && mail.sent >= 5, `notificaciones por correo ${JSON.stringify(rep.notifications)}`);
await expectStatus(sender("GET", "/v1/reports/summary?from=nope"), 400, "rango inválido");
const csvRes = await sender("GET", "/v1/reports/envelopes.csv", null, { raw: true });
assert(csvRes.ok && (csvRes.headers.get("content-type") ?? "").startsWith("text/csv"), "CSV");
const csv = await csvRes.text();
assert(csv.includes(envelope.id) && csv.includes(`Contrato en persona ${stamp}`), "el CSV lista los sobres");
assert(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), "el CSV neutraliza fórmulas");
step("reportes: totales, meses, remitentes, notificaciones y CSV seguro");

console.log("\nE2E EXPERIENCIA OK");
