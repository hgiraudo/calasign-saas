#!/usr/bin/env node
// Prueba de punta a punta de integraciones: API key, webhooks firmados (con receptor local),
// reintento manual, firma embebida (URL de un solo uso + frame-ancestors), anclas de texto, OpenAPI.
// Uso: node scripts/e2e-integrations.mjs [baseUrl]   (entorno local: permite webhooks a 127.0.0.1)
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
let cookie = "";
let bearer = "";

async function api(method, path, body, { raw = false, headers = {}, useKey = true } = {}) {
  const h = { ...headers };
  if (bearer && useKey) h.authorization = `Bearer ${bearer}`;
  else if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return data;
}

const ok = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  fail(`timeout esperando: ${what}`);
}

// PDF de 1 página con un texto ancla, generado a mano.
function anchorPdf() {
  const content = "BT /F1 12 Tf 72 700 Td (Contrato con ancla) Tj ET BT /F1 12 Tf 300 200 Td (Firma: [[s1]]) Tj ET";
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
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// ───────── Receptor de webhooks ─────────
const received = [];
let failMode = false;
let secrets = {};
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const sig = String(req.headers["calasign-signature"] ?? "");
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    const secret = secrets[req.url] ?? "";
    let valid = false;
    if (m && secret) {
      const expected = createHmac("sha256", secret).update(`${m[1]}.${body}`).digest();
      valid = timingSafeEqual(expected, Buffer.from(m[2], "hex")) && Math.abs(Date.now() / 1000 - Number(m[1])) < 300;
    }
    const evt = JSON.parse(body || "{}");
    received.push({ path: req.url, valid, type: evt.type, evt, eventId: req.headers["calasign-event-id"] });
    if (req.url === "/flaky" && failMode) {
      res.writeHead(500).end("boom");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const hookBase = `http://127.0.0.1:${server.address().port}`;

try {
  const stamp = Date.now();
  await api("POST", "/v1/auth/signup", { name: "Integradora", email: `int+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Fintech ${stamp}` });
  const key = await api("POST", "/v1/api-keys", { name: "e2e" });
  bearer = key.secret;
  ok("cuenta + API key (el resto va con Bearer)");

  // OpenAPI
  const spec = await api("GET", "/v1/openapi.json");
  if (spec.openapi !== "3.1.0" || !spec.paths["/v1/webhooks"] || !spec.paths["/v1/envelopes/{id}/recipients/{recipientId}/signing-url"]) fail("OpenAPI incompleto");
  ok(`OpenAPI ${spec.openapi}: ${Object.keys(spec.paths).length} rutas`);

  // Webhooks
  const wh = await api("POST", "/v1/webhooks", { url: `${hookBase}/hook`, description: "e2e" });
  secrets["/hook"] = wh.secret;
  if (!wh.secret.startsWith("whsec_")) fail("secreto de webhook");
  await api("POST", `/v1/webhooks/${wh.webhook.id}/test`);
  const test = await waitFor(() => received.find((r) => r.type === "webhook.test"), "webhook.test");
  if (!test.valid) fail("firma HMAC inválida en webhook.test");
  ok("webhook de prueba recibido con firma HMAC válida");

  const bad = await api("POST", "/v1/webhooks", { url: "http://example.com/x" }, { raw: true });
  if (bad.status !== 400) fail(`webhook http debería rechazarse (HTTP ${bad.status})`);
  ok("webhook sin https rechazado");

  // Webhook que falla para probar reintentos
  failMode = true;
  const flaky = await api("POST", "/v1/webhooks", { url: `${hookBase}/flaky`, events: ["envelope.sent"] });
  secrets["/flaky"] = flaky.secret;

  // Firma embebida: orígenes autorizados
  await api("PATCH", "/v1/settings/embed", { frameAncestors: ["http://localhost:5199"] });

  // Sobre con ancla
  const { envelope } = await api("POST", "/v1/envelopes", { subject: `Embebido ${stamp}`, metadata: { externalId: `ORD-${stamp}` } });
  const fd = new FormData();
  fd.append("file", new Blob([anchorPdf()], { type: "application/pdf" }), "contrato.pdf");
  const doc = await api("POST", `/v1/envelopes/${envelope.id}/documents`, fd);
  const signer = randomUUID();
  const approver = randomUUID();
  const cc = randomUUID();
  const det = await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
    recipients: [
      { id: signer, name: `Cliente ${stamp}`, embedded: true, routingOrder: 1 },
      { id: approver, name: `Aprobador ${stamp}`, embedded: true, role: "approver", routingOrder: 2 },
      { id: cc, name: `Backoffice ${stamp}`, email: `bo+${stamp}@example.com`, role: "cc", routingOrder: 3 },
    ],
  });
  if (!det.recipients.find((r) => r.id === signer).embedded) fail("flag embedded no quedó");
  const missing = await api(
    "PUT",
    `/v1/envelopes/${envelope.id}/fields`,
    { fields: [{ recipientId: signer, type: "signature", anchor: { text: "[[nada]]", width: 100, height: 30 } }] },
    { raw: true },
  );
  if (missing.status !== 400) fail(`ancla inexistente debería dar 400 (HTTP ${missing.status})`);
  const withFields = await api("PUT", `/v1/envelopes/${envelope.id}/fields`, {
    fields: [
      { recipientId: signer, type: "signature", anchor: { text: "[[s1]]", offsetX: 0, offsetY: -45, width: 150, height: 40 } },
      { recipientId: signer, type: "date_signed", anchor: { text: "[[s1]]", offsetX: 60, offsetY: 0, width: 90, height: 14 } },
      // Un desplegable por ancla conserva sus opciones (antes se perdían y el pedido daba 400).
      { recipientId: signer, type: "dropdown", required: false, options: ["Contado", "Cuotas"], label: "Pago", anchor: { text: "[[s1]]", offsetX: 0, offsetY: 20, width: 90, height: 14 } },
      { documentId: doc.id, recipientId: signer, type: "name", page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.03 },
    ],
  });
  const sigField = withFields.fields.find((f) => f.type === "signature");
  const dd = withFields.fields.find((f) => f.type === "dropdown");
  if (!dd || JSON.stringify(dd.options) !== JSON.stringify(["Contado", "Cuotas"])) fail(`desplegable por ancla sin sus opciones: ${JSON.stringify(dd)}`);
  // "Firma: " en Helvetica 12 ≈ 37pt → el ancla empieza en x ≈ 337 de 595 (0.566); y del texto ≈ 842-200-12.
  if (!(sigField.x > 0.52 && sigField.x < 0.61)) fail(`x del ancla inesperada: ${sigField.x}`);
  if (!(sigField.y > (842 - 200 - 12 - 45 - 8) / 842 && sigField.y < (842 - 200 - 45 + 4) / 842)) fail(`y del ancla inesperada: ${sigField.y}`);
  ok(`campos por ancla ubicados (x=${sigField.x.toFixed(3)}, y=${sigField.y.toFixed(3)}); ancla inexistente → 400`);

  await api("POST", `/v1/envelopes/${envelope.id}/send`);
  const sent = await waitFor(() => received.find((r) => r.path === "/hook" && r.type === "envelope.sent"), "envelope.sent");
  if (!sent.valid || sent.evt.data.envelope.metadata.externalId !== `ORD-${stamp}`) fail("payload de envelope.sent");
  ok("webhook envelope.sent con metadata del integrador");

  // Reintentos: el endpoint 'flaky' falló → pendiente con próximo intento; reintento manual → OK
  const flakyList = await waitFor(async () => {
    const r = await api("GET", `/v1/webhooks/${flaky.webhook.id}/deliveries`);
    const d = r.items[0];
    return d && d.attempts >= 1 ? d : null;
  }, "primer intento fallido");
  if (flakyList.status !== "pending" || flakyList.lastStatusCode !== 500 || !flakyList.nextRetryAt) fail(`estado tras fallo: ${JSON.stringify(flakyList)}`);
  failMode = false;
  await api("POST", `/v1/webhook-deliveries/${flakyList.id}/retry`);
  await waitFor(async () => (await api("GET", `/v1/webhooks/${flaky.webhook.id}/deliveries`)).items[0].status === "succeeded", "reintento manual exitoso");
  ok("entrega fallida (500) quedó pendiente con backoff; reintento manual → succeeded");

  // URL de firma embebida
  const notAllowed = await api(
    "POST",
    `/v1/envelopes/${envelope.id}/recipients/${signer}/signing-url`,
    { frameAncestors: ["https://evil.example"] },
    { raw: true },
  );
  if (notAllowed.status !== 400) fail("origen no autorizado debería dar 400");
  const su = await api("POST", `/v1/envelopes/${envelope.id}/recipients/${signer}/signing-url`, {
    returnUrl: "http://localhost:5199/done",
    frameAncestors: ["http://localhost:5199"],
  });
  const path = new URL(su.url).pathname;
  const r1 = await fetch(BASE + path, { redirect: "manual" });
  const loc = r1.headers.get("location") ?? "";
  if (r1.status !== 302 || !/^\/s\/[A-Za-z0-9_-]+\?embed=1$/.test(loc)) fail(`intercambio embebido: ${r1.status} ${loc}`);
  const r2 = await fetch(BASE + path, { redirect: "manual" });
  if (r2.status !== 410) fail(`el código debería ser de un solo uso (HTTP ${r2.status})`);
  const page = await fetch(BASE + loc);
  const csp = page.headers.get("content-security-policy") ?? "";
  if (!csp.includes("frame-ancestors 'self' http://localhost:5199") || page.headers.get("x-frame-options")) fail(`CSP embebido: ${csp}`);
  const plain = await fetch(BASE + loc.replace("?embed=1", ""));
  if (!(plain.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'")) fail("sin embed=1 debe seguir sin poder enmarcarse");
  ok("URL embebida: 302 a la firma, un solo uso, frame-ancestors solo para el origen autorizado");

  const token = loc.split("/s/")[1].split("?")[0];
  const info = await api("GET", `/v1/signing/${token}/embed`, null, { useKey: false });
  if (!info.embedded || info.returnUrl !== "http://localhost:5199/done") fail(`info embebida: ${JSON.stringify(info)}`);
  await api("GET", `/v1/signing/${token}`, null, { useKey: false });
  await api("POST", `/v1/signing/${token}/consent`, null, { useKey: false });
  await api("POST", `/v1/signing/${token}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } }, { useKey: false });
  ok("firmante embebido firmó");

  // Aprobador (embebido): su aprobación dispara el webhook recipient.approved.
  const sa = await api("POST", `/v1/envelopes/${envelope.id}/recipients/${approver}/signing-url`, {});
  const ra = await fetch(BASE + new URL(sa.url).pathname, { redirect: "manual" });
  const tokenA = (ra.headers.get("location") ?? "").split("/s/")[1]?.split("?")[0];
  if (!tokenA) fail(`intercambio embebido del aprobador: ${ra.status}`);
  await api("GET", `/v1/signing/${tokenA}`, null, { useKey: false });
  await api("POST", `/v1/signing/${tokenA}/consent`, null, { useKey: false });
  await api("POST", `/v1/signing/${tokenA}/complete`, { fields: [] }, { useKey: false });
  const approvedHook = await waitFor(() => received.find((r) => r.path === "/hook" && r.type === "recipient.approved"), "recipient.approved");
  if (!approvedHook.valid || approvedHook.evt.data.recipientId !== approver) fail(`payload de recipient.approved: ${JSON.stringify(approvedHook.evt?.data)}`);
  ok("aprobador aprobó → webhook recipient.approved con firma válida");

  const completed = await waitFor(() => received.find((r) => r.path === "/hook" && r.type === "envelope.completed"), "envelope.completed", 60_000);
  const types = new Set(received.filter((r) => r.path === "/hook").map((r) => r.type));
  for (const t of ["envelope.sent", "recipient.viewed", "recipient.signed", "recipient.approved", "envelope.completed"]) if (!types.has(t)) fail(`falta webhook ${t}`);
  if (received.filter((r) => r.path === "/hook").some((r) => !r.valid)) fail("alguna firma de webhook inválida");
  if (completed.evt.data.envelope.status !== "completed" || !completed.evt.data.envelope.signedSha256) fail("payload de envelope.completed");
  ok(`webhooks del ciclo completo: ${[...types].join(", ")} — todas con firma válida`);

  const ev = await api("GET", `/v1/envelopes/${envelope.id}/events`);
  if (!ev.items.some((e) => e.type === "recipient.embedded_session_started" && e.data.authentication === "embedded")) fail("evidencia de sesión embebida");
  const box = await api("GET", "/dev/mailbox", null, { useKey: false }).catch(() => ({ items: [] }));
  if (box.items.some((m) => m.subject?.includes(`Embebido ${stamp}`) && m.text.includes(`Cliente ${stamp}`) && m.link?.includes("/s/") && !m.text.includes("Backoffice")))
    fail("el firmante embebido no debería recibir invitaciones");
  ok("evidencia registra la sesión embebida; sin invitaciones al firmante embebido");

  console.log("\nE2E INTEGRACIONES OK");
} finally {
  server.close();
}
