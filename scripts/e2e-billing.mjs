#!/usr/bin/env node
// Prueba de punta a punta de cobros al firmar y planes (proveedor simulado):
// - after_sign: el sobre recién se completa cuando se confirma el pago (incluye un pago rechazado y reintento)
// - before_sign: no se puede firmar sin pagar
// - plan Free: límite de sobres (402), funcionalidades bloqueadas; mejora a Business por checkout simulado
// - uso del mes, moneda local, auditoría, permiso billing:manage
// Uso: node scripts/e2e-billing.mjs [baseUrl]   (entorno local o dev: el proveedor simulado no existe en producción)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const stamp = Date.now();
const ok = (m) => console.log(`✓ ${m}`);
function assert(c, m) {
  if (!c) throw new Error(`FALLÓ: ${m}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function session() {
  let cookie = "";
  return async function api(method, path, body, { raw = false, expect, bearer, headers = {} } = {}) {
    const h = { ...headers };
    if (bearer) h.authorization = `Bearer ${bearer}`;
    else if (cookie) h.cookie = cookie;
    let payload = body;
    if (body && !(body instanceof FormData)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set && !bearer) cookie = set.split(";")[0];
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
ok(`plan por defecto del entorno: ${bill.plan.name}; proveedores: ${bill.providers.map((p) => `${p.id}${p.configured ? "" : " (no configurado)"}`).join(", ")}`);

// ── after_sign ──
const A = `Pagador ${stamp}`;
const B = `Segundo ${stamp}`;
const e1 = await draft([A, B], `Contrato con cobro ${stamp}`);
await owner("PUT", `/v1/envelopes/${e1.id}/payment`, { amount: 10, currency: "BRL", description: "Tasa", payerRecipientId: randomUUID(), provider: "mock" }, { expect: 400 });
await owner("PUT", `/v1/envelopes/${e1.id}/payment`, { amount: 10, currency: "BRL", description: "Tasa", payerRecipientId: e1.recips[0].id, provider: "stripe" }, { expect: 400 });
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
  const dir = mkdtempSync(join(tmpdir(), "cs-bill-"));
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

console.log("\nE2E BILLING OK");
