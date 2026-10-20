#!/usr/bin/env node
// E2E de la Fase 6 (IA) con el proveedor mock (la API sin ANTHROPIC_API_KEY): detección de campos, transparencia,
// revisión del playbook, resumen y preguntas del firmante con citas, extracción de metadatos, alertas de renovación,
// evidencia de cada interacción, IA deshabilitada (403) y presupuesto agotado (429).
// Uso: node scripts/e2e-ai.mjs [baseUrl]   (entorno local: usa /dev/mailbox y /dev/ai/sweep)
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`✓ ${m}`);
function assert(cond, msg) {
  if (!cond) throw new Error(`FALLÓ: ${msg}`);
}

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
      const err = new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
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

/** PDF de 2 páginas con texto real (Helvetica, ASCII). */
function contractPdf() {
  const page1 = [
    "CONTRATO DE PRESTACION DE SERVICIOS",
    "EL CLIENTE: Banco Demo S.A.",
    "EL PROVEEDOR: Servicios Andinos SAS",
    "El presente contrato tiene vigencia desde el 01/02/2026 y vence el 31/01/2027.",
    "Se renovara automaticamente salvo preaviso de 60 dias de anticipacion.",
    "El precio mensual es de USD 1.500,50 mas impuestos.",
    "Jurisdiccion de los tribunales de Bogota.",
    "La responsabilidad se limita a 18 meses de honorarios.",
  ];
  const page2 = ["Firma del cliente: ____________________", "Aclaracion: ____________________", "Fecha: ____________", "Firma del proveedor: ____________________"];
  const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const stream = (lines) => "BT /F1 12 Tf 72 760 Td 18 TL " + lines.map((l) => `(${esc(l)}) Tj T*`).join(" ") + " ET";
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>");
  const c1 = stream(page1);
  const c2 = stream(page2);
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>`);
  add(`<< /Length ${c1.length} >>\nstream\n${c1}\nendstream`);
  add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>`);
  add(`<< /Length ${c2.length} >>\nstream\n${c2}\nendstream`);
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

/**
 * PDF chico (~120 KB) con un stream de contenido que se descomprime a 120 MB. pdf.js lo descomprime entero sin tope
 * para leer el texto: antes la API quedaba un rato largo sin responder a nadie y ocupaba cientos de MB.
 */
function heavyPdf() {
  const text = "BT /F1 12 Tf 72 760 Td (Contrato pesado) Tj ET";
  const big = deflateSync(Buffer.alloc(120 * 1024 * 1024, "q Q "), { level: 1 });
  const parts = [];
  let len = 0;
  const offsets = [];
  const push = (b) => {
    parts.push(b);
    len += b.length;
  };
  push(Buffer.from("%PDF-1.4\n", "latin1"));
  const obj = (n, head, body) => {
    offsets[n] = len;
    push(Buffer.from(`${n} 0 obj\n${head}`, "latin1"));
    if (body) {
      push(Buffer.from("\nstream\n", "latin1"));
      push(body);
      push(Buffer.from("\nendstream", "latin1"));
    }
    push(Buffer.from("\nendobj\n", "latin1"));
  };
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents [4 0 R 5 0 R] /Resources << /Font << /F1 6 0 R >> >> >>");
  obj(4, `<< /Length ${text.length} >>`, Buffer.from(text, "latin1"));
  obj(5, `<< /Length ${big.length} /Filter /FlateDecode >>`, big);
  obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const xref = len;
  push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n` + offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join(""), "latin1"));
  push(Buffer.from(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const stamp = Date.now();
const sender = client();
const mailbox = client();

async function linkFor(name) {
  for (let i = 0; i < 40; i++) {
    const { items } = await mailbox("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1];
    await sleep(400);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

async function sign(token, name) {
  const signer = client();
  let sess = await signer("GET", `/v1/signing/${token}`);
  await signer("POST", `/v1/signing/${token}/consent`);
  sess = await signer("GET", `/v1/signing/${token}`);
  const fields = sess.fields.filter((f) => ["text", "checkbox"].includes(f.type)).map((f) => ({ id: f.id, value: f.type === "checkbox" ? "true" : "x" }));
  await signer("POST", `/v1/signing/${token}/complete`, { fields, signature: { kind: "drawn", imagePng: PNG } });
  step(`${name} firmó`);
  return signer;
}

// ───────────────────────────── Alta y sobre ─────────────────────────────

await sender("POST", "/v1/auth/signup", { name: "Remitente IA", email: `ia+${stamp}@example.com`, password: "una-clave-segura-123", organization: `IA ${stamp}` });
let settings = await sender("GET", "/v1/settings/ai");
assert(settings.enabled === false && settings.provider === "mock", `IA deshabilitada por defecto y proveedor mock (${settings.provider})`);
step("IA deshabilitada por defecto; proveedor mock (sin clave)");

const { envelope } = await sender("POST", "/v1/envelopes", { subject: `Contrato IA ${stamp}` });
const fd = new FormData();
fd.append("file", new Blob([contractPdf()], { type: "application/pdf" }), "contrato.pdf");
const doc = await sender("POST", `/v1/envelopes/${envelope.id}/documents`, null, { form: fd });
const cliente = randomUUID();
const proveedor = randomUUID();
const clienteName = `Cliente IA ${stamp}`;
const proveedorName = `Proveedor IA ${stamp}`;
await sender("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
  recipients: [
    { id: cliente, name: clienteName, email: `cliente+${stamp}@example.com`, routingOrder: 1 },
    { id: proveedor, name: proveedorName, email: `proveedor+${stamp}@example.com`, routingOrder: 2 },
  ],
});

// ───────────────────────────── Detección sin IA: solo heurísticas, nada sale del servidor ─────────────────────────────

let det = await sender("POST", `/v1/envelopes/${envelope.id}/ai/detect-fields`, {});
assert(det.usage === null && det.sent === null, "sin IA no se llama al modelo");
const sigCliente = det.suggestions.find((s) => s.type === "signature" && s.roleHint === "cliente");
const sigProveedor = det.suggestions.find((s) => s.type === "signature" && s.roleHint === "proveedor");
assert(sigCliente && sigProveedor, `sugerencias de firma por rol: ${JSON.stringify(det.suggestions.map((s) => [s.type, s.roleHint]))}`);
assert(sigCliente.page === 1 && sigCliente.signerIndex === 0 && sigProveedor.signerIndex === 1, "página y firmante sugeridos");
assert(det.suggestions.some((s) => s.type === "date_signed") && det.suggestions.some((s) => s.type === "name"), "fecha y aclaración sugeridas");
for (const s of det.suggestions) assert(s.x >= 0 && s.y >= 0 && s.x + s.width <= 1 && s.y + s.height <= 1, "coordenadas normalizadas dentro de la página");
step(`detección por heurísticas sin IA: ${det.suggestions.length} sugerencias («Firma del cliente: ____» → firmante 1)`);

await expectStatus(sender("POST", `/v1/envelopes/${envelope.id}/ai/review`, {}), 403, "revisión con IA deshabilitada");

// Un PDF que pdf.js no puede leer sin descomprimir cientos de MB: 422 enseguida y la API sigue respondiendo.
{
  const { envelope: heavy } = await sender("POST", "/v1/envelopes", { subject: `Pesado IA ${stamp}` });
  const hf = new FormData();
  hf.append("file", new Blob([heavyPdf()], { type: "application/pdf" }), "pesado.pdf");
  await sender("POST", `/v1/envelopes/${heavy.id}/documents`, null, { form: hf });
  const t0 = Date.now();
  const preview = sender("GET", `/v1/envelopes/${heavy.id}/ai/preview?feature=summary`);
  const h0 = Date.now();
  const health = await fetch(`${BASE}/healthz`);
  assert(health.ok && Date.now() - h0 < 3000, `la API responde mientras lee el PDF pesado (${Date.now() - h0} ms)`);
  const e = await expectStatus(preview, 422, "PDF demasiado pesado para leer su texto");
  assert(e?.error?.code === "pdf_too_heavy" && Date.now() - t0 < 5000, `422 pdf_too_heavy enseguida (${Date.now() - t0} ms, ${JSON.stringify(e)})`);
  step(`PDF con un stream de 120 MB: 422 pdf_too_heavy en ${Date.now() - t0} ms, sin dejar a la API sin responder`);
}
await expectStatus(sender("PATCH", `/v1/envelopes/${envelope.id}/ai/settings`, { signerAssist: true }), 403, "asistencia al firmante con IA deshabilitada");
step("IA deshabilitada → 403");

// ───────────────────────────── Habilitar: requiere aceptar el aviso ─────────────────────────────

await expectStatus(sender("PATCH", "/v1/settings/ai", { enabled: true }), 403, "habilitar sin aceptar el aviso");
settings = await sender("PATCH", "/v1/settings/ai", {
  enabled: true,
  acceptNotice: true,
  renewalAlertDays: 30,
  playbook: ["Jurisdiccion debe ser Bogota", "Responsabilidad <= 12 meses", "Confidencialidad debe ser 5 anos"],
});
assert(settings.enabled && settings.noticeAcceptedAt && settings.playbook.length === 3, "IA habilitada con aviso aceptado y playbook");
step("habilitar exige aceptar el aviso de tratamiento de datos (403 sin él)");

// ───────────────────────────── Detección con IA + transparencia ─────────────────────────────

det = await sender("POST", `/v1/envelopes/${envelope.id}/ai/detect-fields`, {});
assert(det.usage && det.usage.provider === "mock" && det.sent && det.sent.characters > 100, "con IA se informa uso y qué se envió");
const preview = await sender("GET", `/v1/envelopes/${envelope.id}/ai/preview?feature=detect_fields`);
assert(preview.text.includes("[Página 1]") && preview.text.includes("[d1-p2-l1] Firma del cliente") && preview.sent.characters === det.sent.characters, "la vista previa muestra exactamente lo que se envía");
step(`detección con IA: ${det.suggestions.length} sugerencias; vista previa = ${preview.sent.characters} caracteres enviados`);

// ───────────────────────────── Revisión del playbook ─────────────────────────────

const review = await sender("POST", `/v1/envelopes/${envelope.id}/ai/review`, {});
assert(review.findings.map((f) => f.status).join(",") === "ok,violation,not_found", `estados del playbook: ${review.findings.map((f) => f.status)}`);
assert(review.findings[1].citation?.verified && review.findings[1].citation.quote.includes("18 meses") && review.findings[1].citation.page === 1, "la violación cita el texto literal con su página");
const last = await sender("GET", `/v1/envelopes/${envelope.id}/ai/review`);
assert(last?.findings?.length === 3, "la última revisión queda guardada");
step("playbook: jurisdicción ok, responsabilidad 18 meses > 12 (violación citada), confidencialidad no encontrada");

// ───────────────────────────── Campos aceptados y envío con asistencia al firmante ─────────────────────────────

const toField = (s, recipientId) => ({ documentId: doc.id, recipientId, type: s.type, page: s.page, x: s.x, y: s.y, width: s.width, height: s.height });
await sender("PUT", `/v1/envelopes/${envelope.id}/fields`, { fields: [toField(sigCliente, cliente), toField(sigProveedor, proveedor)] });
const ai = await sender("PATCH", `/v1/envelopes/${envelope.id}/ai/settings`, { signerAssist: true });
assert(ai.signerAssist === true, "asistencia al firmante habilitada");
await sender("POST", `/v1/envelopes/${envelope.id}/send`);
step("sugerencias aceptadas como campos y sobre enviado con asistencia al firmante");

// ───────────────────────────── Firmante: resumen y preguntas con citas ─────────────────────────────

const t1 = await linkFor(clienteName);
const s1 = client();
await s1("GET", `/v1/signing/${t1}`);
const info = await s1("GET", `/v1/signing/${t1}/ai`);
assert(info.enabled && /asesoramiento legal/.test(info.disclaimer) && info.notice, "el firmante ve la asistencia con aviso y descargo");
const summary = await s1("POST", `/v1/signing/${t1}/ai/summary`);
assert(summary.summary.length > 30 && summary.citations.length > 0 && summary.citations.every((c) => c.verified), "resumen con citas verificadas");
assert(/asesoramiento legal/.test(summary.disclaimer), "resumen con descargo");
const answer = await s1("POST", `/v1/signing/${t1}/ai/ask`, { question: "Cual es el precio mensual?" });
assert(answer.answered && answer.citations[0]?.quote.includes("USD 1.500,50") && answer.citations[0].page === 1 && answer.citations[0].verified, "respuesta con cita literal y página");
const unknown = await s1("POST", `/v1/signing/${t1}/ai/ask`, { question: "Se permiten mascotas en la oficina?" });
assert(unknown.answered === false, "si el documento no lo dice, no inventa");
step("firmante: resumen con citas verificadas, respuesta con página («USD 1.500,50», pág. 1) y «no lo dice» cuando corresponde");

await sign(t1, "cliente");
const t2 = await linkFor(proveedorName);
await sign(t2, "proveedor");
let detail;
for (let i = 0; i < 60; i++) {
  detail = await sender("GET", `/v1/envelopes/${envelope.id}`);
  if (detail.envelope.status === "completed") break;
  await sleep(500);
}
assert(detail.envelope.status === "completed", `sobre completado (${detail.envelope.status})`);

// ───────────────────────────── Metadatos: extracción automática y alerta de renovación ─────────────────────────────

const sweep = await sender("POST", "/dev/ai/sweep");
assert(sweep.extracted >= 1, `extracción automática al completarse (${JSON.stringify(sweep)})`);
let meta = await sender("GET", `/v1/envelopes/${envelope.id}/ai/metadata`);
assert(meta.source === "ai" && meta.metadata.expiryDate === "2027-01-31" && meta.metadata.effectiveDate === "2026-02-01", `fechas extraídas: ${JSON.stringify(meta.metadata)}`);
assert(meta.metadata.amounts[0]?.value === 1500.5 && meta.metadata.amounts[0].currency === "USD", "monto y moneda");
assert(meta.metadata.parties.length === 2 && meta.metadata.noticePeriodDays === 60 && meta.metadata.autoRenewal === true, "partes, preaviso y renovación automática");
assert(meta.renewalAlertAt && meta.renewalAlertAt < "2027-01-31", `alerta programada antes del vencimiento (${meta.renewalAlertAt})`);
step(`metadatos extraídos al completarse; alerta de renovación programada para ${meta.renewalAlertAt}`);

// Una fecha que no existe se rechaza (JS la correría al 3 de marzo y la alerta se programaría sobre esa fecha).
await expectStatus(
  sender("PUT", `/v1/envelopes/${envelope.id}/ai/metadata`, { metadata: { ...meta.metadata, expiryDate: "2027-02-31" } }),
  400,
  "vencimiento inexistente rechazado",
);

// Edición manual con un vencimiento cercano → la alerta queda para hoy y el sweeper la envía.
const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
meta = await sender("PUT", `/v1/envelopes/${envelope.id}/ai/metadata`, { metadata: { ...meta.metadata, expiryDate: soon, renewalDate: null, noticePeriodDays: null, autoRenewal: false } });
assert(meta.source === "manual" && meta.renewalAlertAt === new Date().toISOString().slice(0, 10), `alerta reprogramada para hoy (${meta.renewalAlertAt})`);
const sweep2 = await sender("POST", "/dev/ai/sweep");
assert(sweep2.alerted >= 1, "el sweeper envía la alerta");
meta = await sender("GET", `/v1/envelopes/${envelope.id}/ai/metadata`);
assert(meta.renewalAlertSentAt, "alerta marcada como enviada");
const { items } = await mailbox("GET", "/dev/mailbox");
assert(items.some((m) => m.to === `ia+${stamp}@example.com` && m.subject.includes(soon)), "el remitente recibe la alerta de renovación");
const sweep3 = await sender("POST", "/dev/ai/sweep");
assert(sweep3.alerted === 0, "la alerta no se repite");
step("edición manual de metadatos; alerta de renovación enviada al remitente una sola vez");

// ───────────────────────────── Evidencia ─────────────────────────────

const { items: events } = await sender("GET", `/v1/envelopes/${envelope.id}/events`);
const types = new Set(events.map((e) => e.type));
for (const t of ["ai.detect_fields", "ai.playbook_review", "ai.summary", "ai.ask", "ai.extract_metadata", "ai.metadata_edited", "ai.renewal_alert"]) assert(types.has(t), `evento ${t}`);
const askEv = events.find((e) => e.type === "ai.ask");
assert(askEv.actorType === "recipient" && /^[0-9a-f]{64}$/.test(askEv.data.promptSha256) && askEv.data.model && askEv.data.inputTokens > 0, "evento con hash del prompt, modelo y tokens");
assert(!JSON.stringify(askEv.data).includes("precio mensual") && !JSON.stringify(events).includes("Servicios Andinos SAS"), "la evidencia no guarda el texto enviado ni la pregunta");
step("cada interacción queda en la evidencia (hash del prompt, modelo, tokens), sin el texto");

// ───────────────────────────── Presupuesto y desactivación ─────────────────────────────

settings = await sender("GET", "/v1/settings/ai");
assert(settings.usage.totalTokens > 0 && settings.usage.byFeature.length >= 4, "consumo del mes por función");
await sender("PATCH", "/v1/settings/ai", { monthlyTokenBudget: 1 });
const over = await expectStatus(sender("POST", `/v1/envelopes/${envelope.id}/ai/extract-metadata`), 429, "presupuesto agotado");
assert(over.error.code === "ai_budget_exceeded", "código ai_budget_exceeded");
await expectStatus(s1("POST", `/v1/signing/${t1}/ai/ask`, { question: "Cual es el precio?" }), 429, "presupuesto agotado también para el firmante");
step(`presupuesto agotado → 429 (consumo del mes: ${settings.usage.totalTokens} tokens)`);

await sender("PATCH", "/v1/settings/ai", { enabled: false, monthlyTokenBudget: 500000 });
const off = await s1("GET", `/v1/signing/${t1}/ai`);
assert(off.enabled === false, "deshabilitada para el firmante");
await expectStatus(s1("POST", `/v1/signing/${t1}/ai/summary`), 403, "resumen con IA deshabilitada");
step("IA deshabilitada → el firmante ya no la ve (403)");

console.log("\nE2E IA OK");
