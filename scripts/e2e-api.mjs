#!/usr/bin/env node
// Prueba de punta a punta de las ampliaciones de la API (docs/API-ROADMAP.md): búsqueda avanzada de sobres
// (fechas, metadata, destinatario), datos de formulario y adjuntos del firmante, API de eventos (polling con cursor y
// SSE), clonado de sobres, operaciones en lote y rotación del secreto de un webhook con período de gracia.
// Usa un receptor de webhooks en 127.0.0.1: solo corre contra el entorno local.
// Uso: node scripts/e2e-api.mjs [baseUrl]
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
let cookie = "";
let bearer = "";

async function api(method, path, body, { raw = false, expect, headers = {}, session = false } = {}) {
  const h = { ...headers };
  if (bearer && !session) h.authorization = `Bearer ${bearer}`;
  else if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set && /^(__Host-)?cs_session=/.test(set)) cookie = set.split(";")[0];
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

function tinyPdf(label) {
  const content = `BT /F1 18 Tf 72 760 Td (${label}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
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

// ───────── Receptor de webhooks ─────────
const received = [];
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ headers: req.headers, body });
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => receiver.listen(0, "127.0.0.1", r));
const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
const sigsOf = (header) => header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
const hmac = (secret, t, body) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
async function waitDelivery(pred, what) {
  for (let i = 0; i < 60; i++) {
    const d = received.find(pred);
    if (d) return d;
    await sleep(300);
  }
  throw new Error(`no llegó el webhook: ${what}`);
}

try {
  // ───────── Cuenta y API key ─────────
  const stamp = Date.now();
  await api("POST", "/v1/auth/signup", { name: "Dev API", email: `devapi+${stamp}@example.com`, password: "una-clave-segura-123", organization: `DevAPI ${stamp}`, locale: "es" });
  const { secret: key } = await api("POST", "/v1/api-keys", { name: `e2e-api ${stamp}` });
  bearer = key;
  step("cuenta y API key");

  const { webhook, secret: whSecret } = await api("POST", "/v1/webhooks", { url: hookUrl, events: [] }, { expect: 201 });

  // ───────── Sobre A: texto + adjunto ─────────
  const orderId = `ORD-${stamp}`;
  const signerEmail = `firmante+${stamp}@example.com`;
  const signerName = `Firmante API ${stamp}`;
  const { envelope: A } = await api("POST", "/v1/envelopes", { subject: `Pedido ${orderId}`, metadata: { orderId, canal: "e2e" } }, { expect: 201 });
  const fd = new FormData();
  fd.append("file", new Blob([tinyPdf("Pedido")], { type: "application/pdf" }), "pedido.pdf");
  const doc = await api("POST", `/v1/envelopes/${A.id}/documents`, fd, { expect: 201 });
  const rid = randomUUID();
  await api("PUT", `/v1/envelopes/${A.id}/recipients`, { recipients: [{ id: rid, name: signerName, email: signerEmail, routingOrder: 1 }] });
  await api("PUT", `/v1/envelopes/${A.id}/fields`, {
    fields: [
      { documentId: doc.id, recipientId: rid, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 },
      { documentId: doc.id, recipientId: rid, type: "text", page: 0, x: 0.1, y: 0.5, width: 0.3, height: 0.04, label: "Empresa" },
      { documentId: doc.id, recipientId: rid, type: "text", page: 0, x: 0.1, y: 0.4, width: 0.3, height: 0.04, label: "Fijo", value: "Valor del remitente", readOnly: true },
      { documentId: doc.id, recipientId: rid, type: "attachment", page: 0, x: 0.5, y: 0.5, width: 0.3, height: 0.05, label: "Cédula", required: true },
    ],
  });
  const before = await api("GET", "/v1/events?limit=500");
  const startCursor = before.nextCursor;
  await api("POST", `/v1/envelopes/${A.id}/send`);
  step("sobre A enviado (metadata orderId, campo de texto y adjunto)");

  // ───────── Búsqueda avanzada ─────────
  {
    const byMeta = await api("GET", `/v1/envelopes?metadata=${encodeURIComponent(`orderId:${orderId}`)}`);
    assert(byMeta.items.length === 1 && byMeta.items[0].id === A.id, "filtro metadata=clave:valor");
    assert(byMeta.items[0].metadata?.orderId === orderId && byMeta.items[0].updatedAt, "el resumen trae metadata y updatedAt");
    const byBracket = await api("GET", `/v1/envelopes?metadata[orderId]=${encodeURIComponent(orderId)}&metadata[canal]=e2e`);
    assert(byBracket.items.length === 1, "filtro metadata[clave]=valor (dos pares)");
    const miss = await api("GET", `/v1/envelopes?metadata=${encodeURIComponent(`orderId:${orderId}`)}&metadata=canal:otro`);
    assert(miss.items.length === 0, "metadata: todos los pares tienen que coincidir");
    const byRecipient = await api("GET", `/v1/envelopes?recipient=${encodeURIComponent(signerEmail.toUpperCase())}`);
    assert(byRecipient.items.some((e) => e.id === A.id), "filtro por destinatario (sin mayúsculas)");
    const future = new Date(Date.now() + 3600_000).toISOString();
    const none = await api("GET", `/v1/envelopes?created_from=${encodeURIComponent(future)}`);
    assert(none.items.length === 0, "created_from en el futuro");
    const recent = await api("GET", `/v1/envelopes?updated_from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&status=sent&created_via=api`);
    assert(recent.items.some((e) => e.id === A.id), "updated_from + status + created_via");
    await api("GET", "/v1/envelopes?created_from=ayer", null, { expect: 400 });
    await api("GET", "/v1/envelopes?metadata=sin-dos-puntos", null, { expect: 400 });
    step("búsqueda: metadata (dos sintaxis), destinatario, rangos de fechas, origen y errores de validación");
  }

  // ───────── Firmante: adjunto + texto ─────────
  const token = await linkFor(signerName);
  let sess = await api("GET", `/v1/signing/${token}`, null, { session: true });
  sess = await api("POST", `/v1/signing/${token}/consent`, null, { session: true });
  const attField = sess.fields.find((f) => f.type === "attachment");
  const textField = sess.fields.find((f) => f.type === "text" && f.label === "Empresa");
  {
    const afd = new FormData();
    afd.append("file", new Blob([tinyPdf("Cedula")], { type: "application/pdf" }), "cedula.pdf");
    const r = await fetch(`${BASE}/v1/signing/${token}/fields/${attField.id}/attachment`, { method: "POST", body: afd });
    assert(r.ok, `subir adjunto (HTTP ${r.status} ${await r.text()})`);
  }
  // Antes de que firme: los datos ya muestran el adjunto, todavía no el texto.
  {
    const partial = await api("GET", `/v1/envelopes/${A.id}/form-data`);
    assert(partial.values["Fijo"] === "Valor del remitente", "valor fijado por el remitente");
    assert(partial.values["Empresa"] === undefined, "sin valor antes de firmar");
  }
  await api("POST", `/v1/signing/${token}/complete`, { fields: [{ id: textField.id, value: "ACME Dominicana SRL" }], signature: { kind: "drawn", imagePng: PNG } }, { session: true });
  let detail;
  for (let i = 0; i < 60; i++) {
    detail = await api("GET", `/v1/envelopes/${A.id}`);
    if (detail.envelope.status === "completed") break;
    await sleep(1000);
  }
  assert(detail.envelope.status === "completed", `A completado (${detail.envelope.status})`);
  step("firmante subió el adjunto y firmó; sobre completado");

  // ───────── Datos de formulario y adjunto ─────────
  {
    const form = await api("GET", `/v1/envelopes/${A.id}/form-data`);
    assert(form.status === "completed" && form.completedAt, "estado en form-data");
    assert(form.values["Empresa"] === "ACME Dominicana SRL", "valor del firmante en values");
    const r = form.recipients.find((x) => x.id === rid);
    const sig = r.fields.find((f) => f.type === "signature");
    assert(sig.filled === true && sig.value === null, "la firma informa filled sin devolver la imagen");
    const att = r.fields.find((f) => f.type === "attachment");
    assert(att.attachment && att.attachment.contentType === "application/pdf" && att.attachment.sha256, "metadatos del adjunto");
    const file = await api("GET", att.attachment.downloadPath, null, { raw: true });
    assert(file.status === 200 && file.headers.get("content-type") === "application/pdf", `descarga del adjunto (HTTP ${file.status})`);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert(bytes.subarray(0, 5).toString() === "%PDF-", "el adjunto es el PDF subido");
    await api("GET", `/v1/envelopes/${A.id}/attachments/${textField.id}`, null, { expect: 404 });
    await api("GET", `/v1/envelopes/${randomUUID()}/form-data`, null, { expect: 404 });
    step("form-data: valores por destinatario y vista plana; descarga del adjunto del firmante");
  }

  // ───────── API de eventos (polling) ─────────
  {
    let all = [];
    for (let i = 0; i < 20; i++) {
      const page = await api("GET", `/v1/events?envelope_id=${A.id}&after=${startCursor ?? ""}`);
      all = page.items;
      if (all.some((e) => e.type === "envelope.completed")) break;
      await sleep(500);
    }
    const types = all.map((e) => e.type);
    for (const t of ["envelope.sent", "recipient.viewed", "recipient.signed", "envelope.completed"]) assert(types.includes(t), `evento ${t} (vinieron ${types.join(", ")})`);
    assert(types.indexOf("envelope.sent") < types.indexOf("envelope.completed"), `orden cronológico: ${JSON.stringify(all.map((e) => [e.type, e.id, e.cursor, e.occurredAt]))}`);
    assert(all.every((e) => e.envelope.metadata.orderId === orderId && e.envelope.status === "completed"), "cada evento trae el sobre con su estado actual");
    const signed = all.find((e) => e.type === "recipient.signed");
    assert(signed.recipientId === rid, "recipientId en recipient.signed");
    // Paginación de a uno siguiendo el cursor: mismos eventos, sin repetidos.
    const seen = [];
    let cursor = startCursor;
    for (let i = 0; i < 50; i++) {
      const page = await api("GET", `/v1/events?envelope_id=${A.id}&limit=1${cursor ? `&after=${cursor}` : ""}`);
      seen.push(...page.items.map((e) => e.id));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    assert(seen.length === all.length && new Set(seen).size === seen.length, `paginación por cursor (${seen.length} vs ${all.length})`);
    const onlyCompleted = await api("GET", `/v1/events?envelope_id=${A.id}&types=envelope.completed&after=${startCursor ?? ""}`);
    assert(onlyCompleted.items.length === 1 && onlyCompleted.items[0].type === "envelope.completed", "filtro por tipo");
    const raw = await api("GET", `/v1/events?envelope_id=${A.id}&scope=all&after=${startCursor ?? ""}&limit=500`);
    assert(raw.items.some((e) => e.type === "envelope.finalizing"), "scope=all trae los tipos de evidencia");
    const noNew = await api("GET", `/v1/events?after=${raw.nextCursor}&envelope_id=${A.id}`);
    assert(noNew.items.length === 0 && noNew.nextCursor === raw.nextCursor, "sin eventos nuevos el cursor no cambia");
    // Cursores anteriores (el id solo, y "<tx>.<id>" de 0048): se traducen al mismo punto que el cursor nuevo.
    const mid = all[0].cursor;
    assert(/^p\d+$/.test(mid), `formato del cursor: ${mid}`);
    const rowId = all[0].id.replace(/^evt_/, "").split("_")[0];
    const ids = (p) => JSON.stringify(p.items.map((e) => e.id));
    const fromNew = await api("GET", `/v1/events?envelope_id=${A.id}&after=${mid}`);
    const fromLegacy = await api("GET", `/v1/events?envelope_id=${A.id}&after=${rowId}`);
    const fromTx = await api("GET", `/v1/events?envelope_id=${A.id}&after=12345.${rowId}`);
    assert(ids(fromNew) === ids(fromLegacy) && ids(fromNew) === ids(fromTx), "cursores viejos equivalentes al nuevo");
    await api("GET", "/v1/events?after=abc", null, { expect: 400 });
    await api("GET", "/v1/events?after=1.2.3", null, { expect: 400 });
    await api("GET", "/v1/events?after=p1x", null, { expect: 400 });
    await api("GET", "/v1/events?types=envelope.inventado", null, { expect: 400 });
    step(`eventos: ${all.length} en orden, cursor, filtro por tipo y sobre, scope=all, validaciones`);
  }

  // ───────── Clonado ─────────
  let B;
  {
    B = await api("POST", `/v1/envelopes/${A.id}/clone`, { subject: `Pedido ${orderId} (copia)` }, { expect: 201 });
    assert(B.envelope.status === "draft" && B.envelope.id !== A.id, "el clon es un borrador nuevo");
    assert(B.envelope.metadata.clonedFrom === A.id && B.envelope.metadata.orderId === orderId, "metadata con clonedFrom");
    assert(B.documents.length === 1 && B.documents[0].sha256 === detail.documents[0].sha256, "mismo documento original");
    assert(B.recipients.length === 1 && B.recipients[0].email === signerEmail && B.recipients[0].status === "created", "destinatario copiado, sin estado");
    assert(B.fields.length === 4, `campos copiados (${B.fields.length})`);
    const empresa = B.fields.find((f) => f.label === "Empresa");
    const fijo = B.fields.find((f) => f.label === "Fijo");
    assert(empresa.value === null && fijo.value === "Valor del remitente" && fijo.readOnly, "sin lo que escribió el firmante, con lo fijado por el remitente");
    assert(B.fields.every((f) => f.recipientId === B.recipients[0].id), "los campos apuntan al destinatario nuevo");
    const withValues = await api("POST", `/v1/envelopes/${A.id}/clone`, { includeValues: true, metadata: { lote: "x" } }, { expect: 201 });
    assert(withValues.fields.find((f) => f.label === "Empresa").value === "ACME Dominicana SRL" && withValues.envelope.metadata.lote === "x" && !withValues.envelope.metadata.clonedFrom, "includeValues y metadata propia");
    const docsOnly = await api("POST", `/v1/envelopes/${A.id}/clone`, { includeRecipients: false }, { expect: 201 });
    assert(docsOnly.recipients.length === 0 && docsOnly.fields.length === 0 && docsOnly.documents.length === 1, "includeRecipients: false");
    await api("POST", `/v1/envelopes/${randomUUID()}/clone`, {}, { expect: 404 });
    step("clonado: documentos, destinatarios, campos y lógica; includeValues; solo documentos");

    // ───────── SSE: el envío del clon llega por el stream ─────────
    const cur = (await api("GET", "/v1/events?limit=500")).nextCursor;
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/v1/events/stream?max_seconds=20&envelope_id=${B.envelope.id}`, { headers: { authorization: `Bearer ${bearer}`, "last-event-id": cur ?? "" }, signal: ctrl.signal });
    assert(res.status === 200 && res.headers.get("content-type").startsWith("text/event-stream"), "stream abierto");
    await api("POST", `/v1/envelopes/${B.envelope.id}/send`);
    const reader = res.body.getReader();
    let buf = "";
    let got = null;
    const deadline = Date.now() + 15_000;
    while (!got && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString();
      for (const block of buf.split("\n\n")) {
        if (block.includes("event: envelope.sent")) got = JSON.parse(block.split("\n").find((l) => l.startsWith("data: ")).slice(6));
      }
    }
    ctrl.abort();
    assert(got && got.envelopeId === B.envelope.id && /^p\d+$/.test(got.cursor), "envelope.sent del clon por SSE");
    step("SSE: el envío del clon llegó por /v1/events/stream (retomando desde Last-Event-ID)");
    // Limpieza de los otros clones (borradores) por lote, más abajo.
    B.extra = [withValues.envelope.id, docsOnly.envelope.id];
  }

  // ───────── Rotación del secreto del webhook ─────────
  {
    await waitDelivery((d) => d.headers["calasign-event-type"] === "envelope.completed", "envelope.completed");
    const before = received.length;
    const rot = await api("POST", `/v1/webhooks/${webhook.id}/rotate-secret`, { graceHours: 1 });
    assert(rot.secret.startsWith("whsec_") && rot.secret !== whSecret && rot.webhook.previousSecretExpiresAt, "secreto nuevo y vigencia del anterior");
    await api("POST", `/v1/webhooks/${webhook.id}/test`, null, { expect: 202 });
    const d1 = await waitDelivery((d, i) => received.indexOf(d) >= before && d.headers["calasign-event-type"] === "webhook.test", "test con dos firmas");
    const [tPart] = d1.headers["calasign-signature"].split(",");
    const t = tPart.slice(2);
    const sigs = sigsOf(d1.headers["calasign-signature"]);
    assert(sigs.length === 2 && sigs[0] === hmac(rot.secret, t, d1.body) && sigs[1] === hmac(whSecret, t, d1.body), "durante la gracia: v1=<nuevo>,v1=<anterior>");
    const before2 = received.length;
    const rot2 = await api("POST", `/v1/webhooks/${webhook.id}/rotate-secret`, { graceHours: 0 });
    assert(rot2.webhook.previousSecretExpiresAt === null, "graceHours 0 corta el anterior");
    await api("POST", `/v1/webhooks/${webhook.id}/test`, null, { expect: 202 });
    const d2 = await waitDelivery((d) => received.indexOf(d) >= before2 && d.headers["calasign-event-type"] === "webhook.test", "test con una firma");
    const t2 = d2.headers["calasign-signature"].split(",")[0].slice(2);
    const sigs2 = sigsOf(d2.headers["calasign-signature"]);
    assert(sigs2.length === 1 && sigs2[0] === hmac(rot2.secret, t2, d2.body), "sin gracia: una sola firma con el secreto nuevo");
    const audit = await api("GET", "/v1/audit-log?action=webhook.secret_rotated", null, { session: true });
    assert(audit.items.length === 2, `rotaciones en la auditoría: ${JSON.stringify(audit.items.map((x) => [x.action, x.targetId, x.createdAt]))}`);
    step("webhook: rotación con período de gracia (dos firmas) y sin gracia; auditada");
  }

  // ───────── Lote ─────────
  {
    const ghost = randomUUID();
    const remind = await api("POST", "/v1/envelopes/batch", { action: "remind", ids: [B.envelope.id, A.id, ghost] });
    assert(remind.succeeded === 1 && remind.failed === 2, `remind: 1 ok, 2 fallidos (${JSON.stringify(remind)})`);
    assert(remind.results[0].ok && remind.results[0].data.notified === 1, "recordatorio del clon enviado");
    assert(remind.results[1].status === 409 && remind.results[1].error.code === "not_in_progress", "A completado: 409");
    assert(remind.results[2].status === 404, "id inexistente: 404");
    await api("POST", "/v1/envelopes/batch", { action: "void", ids: [B.envelope.id] }, { expect: 400 });
    await api("POST", "/v1/envelopes/batch", { action: "get", ids: [A.id, A.id] }, { expect: 400 });
    const voided = await api("POST", "/v1/envelopes/batch", { action: "void", ids: [B.envelope.id], reason: "Prueba de lote" });
    assert(voided.succeeded === 1 && voided.results[0].data.envelope.status === "voided", "anulado por lote");
    const got = await api("POST", "/v1/envelopes/batch", { action: "get", ids: [A.id, B.envelope.id] });
    assert(got.results.map((r) => r.data.envelope.status).join(",") === "completed,voided", "get por lote");
    const del = await api("POST", "/v1/envelopes/batch", { action: "delete", ids: [...B.extra, A.id] });
    assert(del.succeeded === 2 && del.results[2].error.code === "not_draft", "delete: borradores sí, completado no");
    await api("GET", `/v1/envelopes/${B.extra[0]}`, null, { expect: 404 });
    const evVoid = await api("GET", `/v1/events?envelope_id=${B.envelope.id}&types=envelope.voided&since=${encodeURIComponent(new Date(Date.now() - 600_000).toISOString())}`);
    for (let i = 0; i < 10 && evVoid.items.length === 0; i++) {
      await sleep(500);
      Object.assign(evVoid, await api("GET", `/v1/events?envelope_id=${B.envelope.id}&types=envelope.voided`));
    }
    assert(evVoid.items[0]?.data?.reason === "Prueba de lote", "el evento envelope.voided trae el motivo");
    step("lote: remind/void/get/delete con resultados por elemento, y validaciones");
  }

  // ───────── Visibilidad: una API key "member" no ve eventos de sobres ajenos ─────────
  {
    const { secret: memberKey } = await api("POST", "/v1/api-keys", { name: `member ${stamp}`, role: "member" }, { session: true });
    const prev = bearer;
    bearer = memberKey;
    const ev = await api("GET", "/v1/events?limit=500&since=" + encodeURIComponent(new Date(Date.now() - 3600_000).toISOString()));
    assert(ev.items.length === 0, `la key member no ve eventos de sobres que no creó (${ev.items.length})`);
    bearer = prev;
    step("visibilidad: los eventos respetan envelopes:view_all");
  }

  console.log("\nE2E API: todo OK");
} finally {
  receiver.close();
}
