#!/usr/bin/env node
// Prueba de punta a punta de cobros al firmar y planes (proveedor simulado):
// - after_sign: el sobre recién se completa cuando se confirma el pago (incluye un pago rechazado y reintento)
// - before_sign: no se puede firmar sin pagar
// - plan Free: límite de sobres (402), funcionalidades bloqueadas; mejora a Business por checkout simulado
// - uso del mes, moneda local, auditoría, permiso billing:manage
// Uso: node scripts/e2e-billing.mjs [baseUrl]   (entorno local o dev: el proveedor simulado no existe en producción)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";


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
const stamp = Date.now();
const ok = (m) => console.log(`✓ ${m}`);
function assert(c, m) {
  if (!c) throw new Error(`FALLÓ: ${m}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function session() {
  // Cookies por nombre: la de sesión y otras que pone la API (p. ej. cs_signer_return al iniciar un pago).
  const jar = new Map();
  return async function api(method, path, body, { raw = false, expect, bearer, headers = {} } = {}) {
    const h = { ...headers };
    if (bearer) h.authorization = `Bearer ${bearer}`;
    else if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload = body;
    if (body && !(body instanceof FormData)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    if (!bearer) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv] = c.split(";");
        const i = kv.indexOf("=");
        jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
      }
    }
    if (raw) return res;
    const text = await res.text();
    const data = text && (res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : text;
    if (expect !== undefined) {
      if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (esperaba ${expect}) ${String(text).slice(0, 300)}`);
      return data;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${String(text).slice(0, 300)}`);
    return data;
  };
}

function tinyPdf(label) {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = `BT /F1 18 Tf 72 760 Td (${label}) Tj ET`;
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
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

const owner = session();
await owner("POST", "/v1/auth/signup", { name: "Dueña Cobros", email: `owner-bill+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Cobros ${stamp}` });

async function linkFor(name) {
  for (let i = 0; i < 60; i++) {
    const { items } = await owner("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1].split("?")[0];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

/** Crea un sobre con firmantes; devuelve ids. No lo envía. */
async function draft(signers, subject) {
  const { envelope } = await owner("POST", "/v1/envelopes", { subject });
  const fd = new FormData();
  fd.append("file", new Blob([tinyPdf(subject)], { type: "application/pdf" }), "doc.pdf");
  const doc = await owner("POST", `/v1/envelopes/${envelope.id}/documents`, fd);
  const recips = signers.map((name, i) => ({ id: randomUUID(), name, email: `s${i}-${stamp}-${randomUUID().slice(0, 6)}@example.com`, routingOrder: i + 1 }));
  await owner("PUT", `/v1/envelopes/${envelope.id}/recipients`, { recipients: recips });
  await owner("PUT", `/v1/envelopes/${envelope.id}/fields`, {
    fields: recips.map((r, i) => ({ documentId: doc.id, recipientId: r.id, type: "signature", page: 0, x: 0.1 + i * 0.4, y: 0.7, width: 0.3, height: 0.08 })),
  });
  return { id: envelope.id, recips };
}

async function sign(name) {
  const tk = await linkFor(name);
  await owner("GET", `/v1/signing/${tk}`);
  await owner("POST", `/v1/signing/${tk}/consent`);
  return { tk, res: await owner("POST", `/v1/signing/${tk}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } }, { raw: true }) };
}

async function payMock(tk, outcome) {
  const { url } = await owner("POST", `/v1/signing/${tk}/payment/checkout`);
  assert(url.includes("/v1/payments/mock/checkout/"), "URL del checkout simulado");
  const page = await owner("GET", url.replace(BASE, ""));
  assert(typeof page === "string" && page.includes("Pago simulado") && page.includes("Rechazar"), "página del pago simulado");
  const action = /action="([^"]+)"/.exec(page)[1].replace(/&amp;/g, "&");
  return owner("POST", action, { outcome }, { headers: { accept: "application/json" } });
}

async function status(id) {
  return (await owner("GET", `/v1/envelopes/${id}`)).envelope.status;
}

// ── Plan por defecto (local: sin límites) ──
let bill = await owner("GET", "/v1/billing");
assert(bill.defaultPlan && bill.plans.length === 4 && bill.providers.some((p) => p.id === "mock" && p.configured), `resumen de facturación: ${JSON.stringify(bill.plan)}`);
const provs = await owner("GET", "/v1/payments/providers");
assert(provs.items.find((p) => p.id === "mercadopago").methods.some((m) => m.includes("PSE")), "medios por proveedor (Pix/PSE)");
// Códigos estables (los traduce la web), uno por medio y en el mismo orden.
for (const p of provs.items) assert(Array.isArray(p.methodCodes) && p.methodCodes.length === p.methods.length, `methodCodes de ${p.id}: ${JSON.stringify(p.methodCodes)}`);
assert(JSON.stringify(provs.items.find((p) => p.id === "mock").methodCodes) === '["simulated"]', "el proveedor simulado se informa con el código simulated");
assert(provs.items.find((p) => p.id === "mercadopago").methodCodes.includes("pse"), "Mercado Pago informa pse");
ok(`plan por defecto del entorno: ${bill.plan.name}; proveedores: ${bill.providers.map((p) => `${p.id}${p.configured ? "" : " (no configurado)"}`).join(", ")}`);

// ── after_sign ──
const A = `Pagador ${stamp}`;
const B = `Segundo ${stamp}`;
const e1 = await draft([A, B], `Contrato con cobro ${stamp}`);
await owner("PUT", `/v1/envelopes/${e1.id}/payment`, { amount: 10, currency: "BRL", description: "Tasa", payerRecipientId: randomUUID(), provider: "mock" }, { expect: 400 });
if (!provs.items.find((p) => p.id === "stripe").configured) {
  await owner("PUT", `/v1/envelopes/${e1.id}/payment`, { amount: 10, currency: "BRL", description: "Tasa", payerRecipientId: e1.recips[0].id, provider: "stripe" }, { expect: 400 });
}
const pay = await owner("PUT", `/v1/envelopes/${e1.id}/payment`, {
  amount: 150.5,
  currency: "BRL",
  description: "Honorarios de gestión",
  payerRecipientId: e1.recips[0].id,
  timing: "after_sign",
  provider: "mock",
});
assert(pay.payment.status === "pending" && pay.payment.amount === 150.5, "cobro configurado");
await owner("POST", `/v1/envelopes/${e1.id}/send`);
const s1 = await sign(A);
assert(s1.res.status === 200, "el pagador firma (after_sign)");
let info = await owner("GET", `/v1/signing/${s1.tk}/payment`);
assert(info.required && info.canPay && !info.blocksSigning && info.amount === 150.5, `info del pago para el firmante: ${JSON.stringify(info)}`);
const s2 = await sign(B);
assert(s2.res.status === 200, "el segundo firma");
await sleep(1500);
assert((await status(e1.id)) === "sent", "con todos firmados, sin pago el sobre NO se completa");
let ev = (await owner("GET", `/v1/envelopes/${e1.id}/events`)).items;
assert(ev.some((x) => x.type === "envelope.awaiting_payment"), "evento envelope.awaiting_payment");
const otherInfo = await owner("GET", `/v1/signing/${s2.tk}/payment`);
assert(!otherInfo.required, "el otro firmante no paga");
await owner("POST", `/v1/signing/${s2.tk}/payment/checkout`, null, { expect: 404 });

const failed = await payMock(s1.tk, "failed");
assert(failed.ok && failed.outcome === "failed", "pago rechazado");
info = await owner("GET", `/v1/signing/${s1.tk}/payment`);
assert(info.status === "pending" && info.canPay, "tras el rechazo se puede reintentar");
await payMock(s1.tk, "paid");
let st = "";
for (let i = 0; i < 60; i++) {
  st = await status(e1.id);
  if (st === "completed") break;
  await sleep(1000);
}
assert(st === "completed", `con el pago confirmado el sobre se completa (${st})`);
ev = (await owner("GET", `/v1/envelopes/${e1.id}/events`)).items;
const paidEv = ev.find((x) => x.type === "payment.completed");
assert(paidEv && paidEv.data.amount === 150.5 && paidEv.data.currency === "BRL", "evento payment.completed con monto");
assert(ev.some((x) => x.type === "payment.failed"), "evento payment.failed");
await owner("POST", `/v1/signing/${s1.tk}/payment/checkout`, null, { expect: 409 });
const pdf = Buffer.from(await (await owner("GET", `/v1/envelopes/${e1.id}/signed.pdf`, null, { raw: true })).arrayBuffer());
try {
  const dir = tempDir("cs-bill-");
  writeFileSync(join(dir, "f.pdf"), pdf);
  const txt = execFileSync("pdftotext", [join(dir, "f.pdf"), "-"], { encoding: "utf8" });
  assert(/Pagos/.test(txt) && /150,50/.test(txt) && /Pagado por/.test(txt), "el certificado incluye el comprobante del pago");
  ok("after_sign: firman todos → espera el pago; rechazo y reintento; pago → se completa; comprobante en el certificado");
} catch (e) {
  if (String(e).includes("ENOENT")) ok("after_sign: firman todos → espera el pago; rechazo y reintento; pago → se completa (pdftotext no disponible)");
  else throw e;
}

// ── before_sign ──
const C = `Paga antes ${stamp}`;
const e2 = await draft([C], `Reserva ${stamp}`);
await owner("PUT", `/v1/envelopes/${e2.id}/payment`, { amount: 25000, currency: "COP", description: "Reserva", payerRecipientId: e2.recips[0].id, timing: "before_sign", provider: "mock" });
await owner("POST", `/v1/envelopes/${e2.id}/send`);
const tk2 = await linkFor(C);
await owner("GET", `/v1/signing/${tk2}`);
await owner("POST", `/v1/signing/${tk2}/consent`);
info = await owner("GET", `/v1/signing/${tk2}/payment`);
assert(info.blocksSigning && info.canPay, "before_sign bloquea la firma");
const blocked = await owner("POST", `/v1/signing/${tk2}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } }, { expect: 402 });
assert(blocked.error.code === "payment_required", "sin pagar: 402 payment_required");
await payMock(tk2, "paid");
await owner("POST", `/v1/signing/${tk2}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
for (let i = 0; i < 60; i++) {
  st = await status(e2.id);
  if (st === "completed") break;
  await sleep(1000);
}
assert(st === "completed", "before_sign: pagó, firmó y se completó");
ok("before_sign: 402 hasta pagar; después firma y se completa");

// ── Simulado: un sobre anulado no se paga ──
// Como Stripe y Mercado Pago después de cerrarse el checkout: completar el pago simulado de un sobre anulado da 409.
const Cv = `Paga y anulan simulado ${stamp}`;
const e2v = await draft([Cv], `Reserva anulada ${stamp}`);
await owner("PUT", `/v1/envelopes/${e2v.id}/payment`, { amount: 100, currency: "BRL", description: "Reserva", payerRecipientId: e2v.recips[0].id, timing: "before_sign", provider: "mock" });
await owner("POST", `/v1/envelopes/${e2v.id}/send`);
const tk2v = await linkFor(Cv);
await owner("GET", `/v1/signing/${tk2v}`);
await owner("POST", `/v1/signing/${tk2v}/consent`);
const { url: vurl } = await owner("POST", `/v1/signing/${tk2v}/payment/checkout`);
const vpage = await owner("GET", vurl.replace(BASE, ""));
const vaction = /action="([^"]+)"/.exec(vpage)[1].replace(/&amp;/g, "&");
await owner("POST", `/v1/envelopes/${e2v.id}/void`, { reason: "Se canceló la reserva" });
const vres = await owner("POST", vaction, { outcome: "paid" }, { headers: { accept: "application/json" }, expect: 409 });
assert(vres.error.code === "envelope_closed", `pago simulado de un sobre anulado: 409 envelope_closed (${JSON.stringify(vres)})`);
assert((await owner("GET", `/v1/envelopes/${e2v.id}/payment`)).payment.status !== "paid", "el pago simulado no quedó acreditado en el sobre anulado");
ok("simulado: un sobre anulado no admite el pago (409)");

// ── Plan Free: límites ──
bill = await owner("POST", "/v1/billing/cancel");
assert(bill.plan.id === "free" && !bill.defaultPlan, "baja a Free");
const lim = await owner("POST", "/v1/api-keys", { name: "k" }, { expect: 402 });
assert(lim.error.code === "plan_limit" && lim.error.details.feature === "api" && lim.error.details.suggestedPlan === "starter", `Free sin API: ${JSON.stringify(lim.error.details)}`);
await owner("POST", "/v1/invitations", { email: `inv-${stamp}@example.com`, role: "member" }, { expect: 402 });
const e3 = await draft([`Libre ${stamp}`], `Free ${stamp}`);
const p402 = await owner("PUT", `/v1/envelopes/${e3.id}/payment`, { amount: 1, currency: "USD", description: "x", payerRecipientId: e3.recips[0].id, provider: "mock" }, { expect: 402 });
assert(p402.error.details.feature === "payments", "cobro al firmar no incluido en Free");
bill = await owner("GET", "/v1/billing");
let used = bill.usage.envelopesSent;
assert(used >= 2, `uso del mes: ${used} sobres`);
let ids = [e3.id];
while (used < 5) {
  await owner("POST", `/v1/envelopes/${ids.pop()}/send`);
  used++;
  if (used < 5) ids.push((await draft([`Libre ${used} ${stamp}`], `Free ${used} ${stamp}`)).id);
}
const over = await draft([`Excedido ${stamp}`], `Excedido ${stamp}`);
const q = await owner("POST", `/v1/envelopes/${over.id}/send`, null, { expect: 402 });
assert(q.error.code === "plan_limit" && q.error.details.limit === "envelopes_per_month" && q.error.details.max === 5 && q.error.details.upgradeUrl === "/app/settings/billing", `cupo: ${JSON.stringify(q.error)}`);
assert((await status(over.id)) === "draft", "el sobre excedido queda en borrador");
ok("Free: API, invitaciones y cobros bloqueados (402 con plan sugerido); 6.º sobre del mes → 402 plan_limit");

// ── Starter (3 usuarios): cupo de invitaciones ──
// Reenviar a un correo con invitación pendiente la reemplaza (no suma usuarios), y dos invitaciones simultáneas
// por el último lugar no superan el cupo.
{
  const sco = await owner("POST", "/v1/billing/checkout", { plan: "starter", currency: "USD", provider: "mock" });
  const spage = await owner("GET", sco.url.replace(BASE, ""));
  await owner("POST", /action="([^"]+)"/.exec(spage)[1].replace(/&amp;/g, "&"), { outcome: "paid" }, { headers: { accept: "application/json" } });
  assert((await owner("GET", "/v1/billing")).plan.id === "starter", "plan Starter activo");
  const members = (await owner("GET", "/v1/members")).items.length;
  const free = 3 - members;
  assert(free >= 2, `Starter con lugar para 2 invitaciones (miembros: ${members})`);
  const invs = [];
  for (let i = 0; i < free; i++) invs.push((await owner("POST", "/v1/invitations", { email: `seat${i}-${stamp}@example.com`, role: "member" })).invitation);
  const full = await owner("POST", "/v1/invitations", { email: `seat-x-${stamp}@example.com`, role: "member" }, { expect: 402 });
  assert(full.error.details.limit === "users", "cupo lleno → 402 users");
  const again = await owner("POST", "/v1/invitations", { email: `SEAT0-${stamp}@example.com`, role: "member" }, { raw: true });
  assert(again.status === 201, `con el cupo lleno, reenviar a un correo con invitación pendiente la reemplaza (${again.status})`);
  const resent = (await again.json()).invitation;
  await owner("DELETE", `/v1/invitations/${resent.id}`, null, { expect: 204 });
  const race = await Promise.all(
    [0, 1].map((i) => owner("POST", "/v1/invitations", { email: `race${i}-${stamp}@example.com`, role: "member" }, { raw: true }).then((r) => r.status)),
  );
  assert(race.filter((x) => x === 201).length === 1 && race.filter((x) => x === 402).length === 1, `dos invitaciones simultáneas por el último lugar: una entra (${race})`);
  for (const it of (await owner("GET", "/v1/invitations")).items) {
    if (it.status === "pending") await owner("DELETE", `/v1/invitations/${it.id}`, null, { expect: 204 });
  }
  void invs;
}
ok("Starter: reenviar una invitación no consume cupo; dos invitaciones simultáneas no lo superan");

// ── Mejora a Business con checkout simulado en BRL ──
const co = await owner("POST", "/v1/billing/checkout", { plan: "business", currency: "BRL", provider: "mock" });
assert(co.provider === "mock" && co.url.includes("/v1/billing/mock/checkout/"), "checkout de suscripción");
const page = await owner("GET", co.url.replace(BASE, ""));
assert(page.includes("Business") && page.includes("249"), "página del checkout con el precio en reales");
const action = /action="([^"]+)"/.exec(page)[1].replace(/&amp;/g, "&");
await owner("POST", action, { outcome: "paid" }, { headers: { accept: "application/json" } });
bill = await owner("GET", "/v1/billing");
assert(bill.plan.id === "business" && bill.subscription.provider === "mock" && bill.subscription.status === "active" && bill.subscription.renewsAt, "plan Business activo");
await owner("POST", `/v1/envelopes/${over.id}/send`);
assert((await status(over.id)) === "sent", "con Business el envío pasa");
assert(bill.usage.envelopesSent >= 5 && bill.usage.messages.email > 0, `uso: ${JSON.stringify(bill.usage)}`);
const key = await owner("POST", "/v1/api-keys", { name: "Integración", role: "member" });
await owner("GET", "/v1/billing", null, { bearer: key.secret, expect: 403 });
ok("checkout simulado → Business; el envío pasa; API key de miembro sin billing:manage → 403");

bill = await owner("PATCH", "/v1/billing/currency", { currency: "COP" });
assert(bill.currency === "COP" && bill.plans.find((p) => p.id === "business").price === 199000, "precios en pesos colombianos");
const audit = await owner("GET", "/v1/audit-log?action=billing.*");
assert(audit.items.filter((x) => x.action === "billing.plan_changed").length >= 2, "auditoría de cambios de plan");
const wh = await owner("POST", "/v1/integrations/payments/stripe/webhook", { id: "evt_x", type: "checkout.session.completed" }, { raw: true });
assert(wh.status === 400, "webhook de Stripe sin firma válida → 400");
ok("moneda local (COP), auditoría billing.plan_changed, webhook sin firma rechazado");

// ── Opcional: Stripe y Mercado Pago contra un servidor falso de los proveedores ──
// Requiere arrancar la API con:
//   STRIPE_SECRET_KEY=sk_test_fake STRIPE_API_BASE=http://127.0.0.1:$PORT STRIPE_WEBHOOK_SECRET=whsec_e2e
//   MP_ACCESS_TOKEN=TEST-fake MP_API_BASE=http://127.0.0.1:$PORT MP_WEBHOOK_SECRET=mp_e2e
// y correr este script con E2E_FAKE_PROVIDERS_PORT=$PORT.
if (process.env.E2E_FAKE_PROVIDERS_PORT) {
  const { createServer } = await import("node:http");
  const { createHmac } = await import("node:crypto");
  const port = Number(process.env.E2E_FAKE_PROVIDERS_PORT);
  const mpPayments = new Map();
  let mpPrefCount = 0;
  const mpPreapprovals = new Map();
  const stripeSessions = new Map();
  const cancelled = [];
  const refunds = [];
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path === "/v1/checkout/sessions") {
        const p = new URLSearchParams(body);
        const id = `cs_test_${randomUUID().slice(0, 8)}`;
        const ses = { id, status: "open", url: `https://checkout.stripe.test/${id}`, _mode: p.get("mode") };
        stripeSessions.set(id, ses);
        return send(200, ses);
      }
      if (req.method === "POST" && path === "/v1/refunds") {
        refunds.push({ paymentIntent: new URLSearchParams(body).get("payment_intent"), key: req.headers["idempotency-key"] });
        return send(200, { id: `re_${refunds.length}`, status: "succeeded" });
      }
      if (req.method === "POST" && /^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(path)) {
        const ses = stripeSessions.get(path.split("/")[4]);
        if (!ses || ses.status !== "open") return send(400, { error: { message: "Only open sessions can be expired" } });
        ses.status = "expired";
        ses.url = null;
        return send(200, ses);
      }
      if (req.method === "GET" && path.startsWith("/v1/checkout/sessions/")) {
        const ses = stripeSessions.get(path.split("/").pop());
        return ses ? send(200, ses) : send(404, { error: { message: "No such checkout.session" } });
      }
      if (req.method === "DELETE" && path.startsWith("/v1/subscriptions/")) {
        cancelled.push(`stripe:${path.split("/").pop()}`);
        return send(200, { id: path.split("/").pop(), status: "canceled" });
      }
      if (req.method === "PUT" && path.startsWith("/preapproval/")) {
        cancelled.push(`mp:${path.split("/").pop()}`);
        return send(200, { id: path.split("/").pop(), status: "cancelled" });
      }
      if (req.method === "POST" && path === "/checkout/preferences") {
        const id = `pref_e2e_${++mpPrefCount}`;
        return send(201, { id, init_point: `https://mp.test/${id}`, sandbox_init_point: `https://sandbox.mp.test/${id}` });
      }
      if (req.method === "GET" && path.startsWith("/v1/payments/")) return send(200, mpPayments.get(path.split("/").pop()) ?? {});
      if (req.method === "POST" && path === "/preapproval") return send(201, { id: "pre_e2e", init_point: "https://mp.test/pre_e2e" });
      if (req.method === "GET" && path.startsWith("/preapproval/")) return send(200, mpPreapprovals.get(path.split("/").pop()) ?? {});
      send(404, { message: "not found" });
    });
  });
  await new Promise((r) => fake.listen(port, "127.0.0.1", r));
  const stripeSig = (payload) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac("sha256", "whsec_e2e").update(`${t}.${payload}`).digest("hex")}`;
  };
  const stripeHook = async (event, sig = true) => {
    const payload = JSON.stringify(event);
    return fetch(`${BASE}/v1/integrations/payments/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": stripeSig(payload) } : {}) },
      body: payload,
    });
  };

  // Stripe: cobro after_sign
  const S = `Paga Stripe ${stamp}`;
  const es = await draft([S], `Stripe ${stamp}`);
  await owner("PUT", `/v1/envelopes/${es.id}/payment`, { amount: 99.9, currency: "USD", description: "Cuota", payerRecipientId: es.recips[0].id, provider: "stripe" });
  await owner("POST", `/v1/envelopes/${es.id}/send`);
  const ss = await sign(S);
  const { url } = await owner("POST", `/v1/signing/${ss.tk}/payment/checkout`);
  assert(url.startsWith("https://checkout.stripe.test/"), "checkout de Stripe");
  const again = await owner("POST", `/v1/signing/${ss.tk}/payment/checkout`);
  assert(again.url === url, "Stripe: un segundo pedido reutiliza la sesión abierta (no dos cobrables)");
  const pid = (await owner("GET", `/v1/envelopes/${es.id}/payment`)).payment.id;
  const session = { id: url.split("/").pop(), mode: "payment", payment_status: "paid", amount_total: 9990, currency: "usd", payment_intent: "pi_e2e", metadata: { paymentId: pid } };
  let r = await stripeHook({ id: `evt_${stamp}_bad`, type: "checkout.session.completed", data: { object: { ...session, amount_total: 100 } } });
  assert(r.status === 400, "Stripe: monto distinto → 400 (no se acredita)");
  r = await stripeHook({ id: `evt_${stamp}_nosig`, type: "checkout.session.completed", data: { object: session } }, false);
  assert(r.status === 400, "Stripe: sin firma → 400");
  r = await stripeHook({ id: `evt_${stamp}_ok`, type: "checkout.session.completed", data: { object: session } });
  assert(r.status === 200, "Stripe: evento válido");
  r = await stripeHook({ id: `evt_${stamp}_ok`, type: "checkout.session.completed", data: { object: session } });
  assert((await r.json()).duplicate === true, "Stripe: evento repetido se ignora");
  for (let i = 0; i < 60 && (await status(es.id)) !== "completed"; i++) await sleep(1000);
  assert((await status(es.id)) === "completed", "Stripe: pago confirmado por webhook → sobre completado");

  // Anular un sobre con un checkout abierto lo cierra en el proveedor: si no, el firmante podía seguir pagando en la
  // sesión de Stripe y el cobro quedaba acreditado en un sobre anulado. Lo cierra el barrido periódico (cada 30 s).
  const SV = `Paga y anulan ${stamp}`;
  const ev = await draft([SV], `Stripe anulado ${stamp}`);
  await owner("PUT", `/v1/envelopes/${ev.id}/payment`, { amount: 10, currency: "USD", description: "Cuota", payerRecipientId: ev.recips[0].id, provider: "stripe" });
  await owner("POST", `/v1/envelopes/${ev.id}/send`);
  const sv = await sign(SV);
  const vco = await owner("POST", `/v1/signing/${sv.tk}/payment/checkout`);
  const vses = stripeSessions.get(vco.url.split("/").pop());
  assert(vses?.status === "open", "checkout de Stripe abierto antes de anular");
  await owner("POST", `/v1/envelopes/${ev.id}/void`, { reason: "Se canceló la operación" });
  for (let i = 0; i < 50 && vses.status === "open"; i++) await sleep(1000);
  assert(vses.status === "expired", "al anular el sobre, la sesión de Stripe se venció (no se puede pagar)");
  // Un pago que igual llega con el sobre cerrado (pagado antes de que se venciera la sesión) se reembolsa.
  const vpid = (await owner("GET", `/v1/envelopes/${ev.id}/payment`)).payment.id;
  r = await stripeHook({
    id: `evt_${stamp}_late`,
    type: "checkout.session.completed",
    data: { object: { id: vses.id, mode: "payment", payment_status: "paid", amount_total: 1000, currency: "usd", payment_intent: "pi_late", metadata: { paymentId: vpid } } },
  });
  assert(r.status === 200, "Stripe: pago tardío recibido");
  for (let i = 0; i < 50 && (await owner("GET", `/v1/envelopes/${ev.id}/payment`)).payment.status !== "refunded"; i++) await sleep(1000);
  assert((await owner("GET", `/v1/envelopes/${ev.id}/payment`)).payment.status === "refunded", "el pago que llegó con el sobre anulado quedó reembolsado");
  assert(refunds.some((x) => x.paymentIntent === "pi_late" && x.key === `refund:${vpid}`), "reembolso pedido a Stripe con clave de idempotencia");
  const vpay = (await owner("GET", `/v1/envelopes/${ev.id}/payment`)).payment;
  assert(vpay.refundRequiredAt && vpay.refundedAt && vpay.refundError === null, `el pago expone el reembolso (${JSON.stringify(vpay)})`);
  const vEvents = (await owner("GET", `/v1/envelopes/${ev.id}/events`)).items.map((x) => x.type);
  assert(vEvents.includes("payment.refund_required") && vEvents.includes("payment.refunded"), `evidencia del reembolso (${vEvents.slice(-5)})`);
  ok("Stripe: anular el sobre cierra el checkout abierto; un pago tardío se reembolsa");

  // Stripe: suscripción
  await owner("POST", "/v1/billing/cancel");
  const sco = await owner("POST", "/v1/billing/checkout", { plan: "starter", currency: "USD", provider: "stripe" });
  assert(sco.url.startsWith("https://checkout.stripe.test/"), "checkout de suscripción en Stripe");
  const me = await owner("GET", "/v1/me");
  const subObj = { id: "sub_e2e", status: "active", customer: "cus_e2e", metadata: { tenantId: me.tenant.id, plan: "starter" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 };
  await stripeHook({ id: `evt_${stamp}_sub`, type: "checkout.session.completed", data: { object: { id: "cs_sub", mode: "subscription", customer: "cus_e2e", subscription: "sub_e2e", metadata: { tenantId: me.tenant.id, plan: "starter" } } } });
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "starter" && bill.subscription.provider === "stripe", "Stripe: suscripción Starter activa");
  await stripeHook({ id: `evt_${stamp}_upd`, type: "customer.subscription.updated", data: { object: subObj } });
  bill = await owner("GET", "/v1/billing");
  assert(bill.subscription.renewsAt, "Stripe: fecha de renovación");
  await owner("POST", "/v1/billing/cancel", null, { expect: 409 }); // Stripe se cancela desde el portal
  await stripeHook({ id: `evt_${stamp}_del`, type: "customer.subscription.deleted", data: { object: { ...subObj, status: "canceled" } } });
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "free", "Stripe: suscripción borrada → Free");
  ok("Stripe (servidor falso): checkout, webhook firmado, monto verificado, idempotencia, suscripción alta/renovación/baja");


  // Cambio de plan con una suscripción de Stripe vigente: el portal no puede cambiar de plan (los precios son de cada
  // checkout), así que el cambio es un checkout nuevo y, al pagarse, la suscripción anterior se cancela.
  await stripeHook({ id: `evt_${stamp}_sub3`, type: "checkout.session.completed", data: { object: { id: "cs_sub3", mode: "subscription", customer: "cus_e2e", subscription: "sub_e2e3", metadata: { tenantId: me.tenant.id, plan: "starter" } } } });
  await owner("POST", "/v1/billing/checkout", { plan: "starter", currency: "USD", provider: "stripe" }, { expect: 409 });
  const up = await owner("POST", "/v1/billing/checkout", { plan: "business", currency: "USD", provider: "stripe" });
  assert(up.url.startsWith("https://checkout.stripe.test/"), "Stripe vigente: checkout para subir de plan");
  await stripeHook({ id: `evt_${stamp}_sub4`, type: "checkout.session.completed", data: { object: { id: "cs_sub4", mode: "subscription", customer: "cus_e2e", subscription: "sub_e2e4", metadata: { tenantId: me.tenant.id, plan: "business" } } } });
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "business" && bill.subscription.provider === "stripe", "Stripe: subió a Business");
  assert(cancelled.includes("stripe:sub_e2e3"), "la suscripción Starter anterior se canceló");
  await stripeHook({ id: `evt_${stamp}_del4`, type: "customer.subscription.deleted", data: { object: { ...subObj, id: "sub_e2e4", status: "canceled", metadata: { tenantId: me.tenant.id, plan: "business" } } } });
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "free", "Stripe: Business borrada → Free");
  ok("Stripe: cambio de plan con suscripción vigente (checkout nuevo; la anterior se cancela)");

  // Mercado Pago: cobro before_sign y suscripción
  const co2 = await owner("POST", "/v1/billing/checkout", { plan: "business", currency: "BRL", provider: "mock" });
  const pg2 = await owner("GET", co2.url.replace(BASE, ""));
  await owner("POST", /action="([^"]+)"/.exec(pg2)[1].replace(/&amp;/g, "&"), { outcome: "paid" }, { headers: { accept: "application/json" } });
  const Mm = `Paga MP ${stamp}`;
  const em = await draft([Mm], `MP ${stamp}`);
  await owner("PUT", `/v1/envelopes/${em.id}/payment`, { amount: 25000, currency: "COP", description: "Reserva", payerRecipientId: em.recips[0].id, timing: "before_sign", provider: "mercadopago" });
  await owner("POST", `/v1/envelopes/${em.id}/send`);
  const tkm = await linkFor(Mm);
  await owner("GET", `/v1/signing/${tkm}`);
  await owner("POST", `/v1/signing/${tkm}/consent`);
  const mco = await owner("POST", `/v1/signing/${tkm}/payment/checkout`);
  const prefsBefore = mpPrefCount;
  assert(mco.url.includes("sandbox.mp.test"), "Checkout Pro sandbox");
  const mpid = (await owner("GET", `/v1/envelopes/${em.id}/payment`)).payment.id;
  const mpHook = (dataId, type = "payment", secret = "mp_e2e") => {
    const ts = String(Date.now());
    const reqId = randomUUID();
    const v1 = createHmac("sha256", secret).update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest("hex");
    return fetch(`${BASE}/v1/integrations/payments/mercadopago/webhook?data.id=${dataId}&type=${type}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": reqId },
      body: JSON.stringify({ type, action: `${type}.updated`, data: { id: dataId } }),
    });
  };
  // Un pago rechazado no cierra la preferencia: el siguiente checkout la reutiliza (dos preferencias cobrables
  // permitirían pagar dos veces, y el segundo cobro no se acreditaría).
  mpPayments.set("776", { id: 776, status: "rejected", external_reference: `pay:${mpid}`, transaction_amount: 25000, currency_id: "COP" });
  assert((await mpHook("776")).status === 200, "MP: notificación de pago rechazado");
  const mcoRetry = await owner("POST", `/v1/signing/${tkm}/payment/checkout`);
  assert(mcoRetry.url === mco.url && mpPrefCount === prefsBefore, `MP: tras un rechazo se reutiliza la preferencia (${mpPrefCount} creadas)`);
  mpPayments.set("777", { id: 777, status: "approved", external_reference: `pay:${mpid}`, transaction_amount: 25000, currency_id: "COP", payment_method_id: "pse", date_approved: new Date().toISOString() });
  r = await mpHook("777", "payment", "secreto-incorrecto");
  assert(r.status === 400, "MP: firma inválida → 400");
  r = await mpHook("777");
  assert(r.status === 200, "MP: notificación de pago aprobada");
  const okSign = await owner("POST", `/v1/signing/${tkm}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } }, { raw: true });
  assert(okSign.status === 200, "MP: pagado (PSE) → puede firmar");
  mpPreapprovals.set("pre_e2e", { id: "pre_e2e", status: "authorized", external_reference: `sub:${me.tenant.id}:enterprise`, next_payment_date: new Date(Date.now() + 30 * 86400_000).toISOString() });
  await mpHook("pre_e2e", "subscription_preapproval");
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "enterprise" && bill.subscription.provider === "mercadopago", "MP: preapproval autorizado → Enterprise");
  ok("Mercado Pago (servidor falso): Checkout Pro, x-signature verificada, pago aprobado consultado a la API, preapproval");

  // Dos suscripciones pagadas con distintos medios: queda la última y la anterior se cancela (no cobran las dos).
  await stripeHook({ id: `evt_${stamp}_sub2`, type: "checkout.session.completed", data: { object: { id: "cs_sub2", mode: "subscription", customer: "cus_e2e", subscription: "sub_e2e2", metadata: { tenantId: me.tenant.id, plan: "starter" } } } });
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "starter" && bill.subscription.provider === "stripe", "Stripe pagada con MP vigente → queda Stripe");
  assert(cancelled.includes("mp:pre_e2e"), "la suscripción de Mercado Pago anterior se canceló");
  mpPreapprovals.set("pre_e2e2", { id: "pre_e2e2", status: "authorized", external_reference: `sub:${me.tenant.id}:business`, next_payment_date: null });
  await mpHook("pre_e2e2", "subscription_preapproval");
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "business" && bill.subscription.provider === "mercadopago", "MP autorizada con Stripe vigente → queda MP");
  assert(cancelled.includes("stripe:sub_e2e2"), "la suscripción de Stripe anterior se canceló");
  ok("suscripciones de dos medios a la vez: la anterior se cancela");

  // Checkout simulado (fuera de producción) con una suscripción real vigente: también la cancela.
  const coMock = await owner("POST", "/v1/billing/checkout", { plan: "enterprise", currency: "BRL", provider: "mock" });
  const pgMock = await owner("GET", coMock.url.replace(BASE, ""));
  await owner("POST", /action="([^"]+)"/.exec(pgMock)[1].replace(/&amp;/g, "&"), { outcome: "paid" }, { headers: { accept: "application/json" } });
  bill = await owner("GET", "/v1/billing");
  assert(bill.plan.id === "enterprise" && bill.subscription.provider === "mock", "checkout simulado aplicado");
  assert(cancelled.includes("mp:pre_e2e2"), "el checkout simulado canceló la suscripción real de Mercado Pago");
  ok("checkout simulado con una suscripción real vigente: la real se cancela");
  fake.close();
}

console.log("\nE2E BILLING OK");
