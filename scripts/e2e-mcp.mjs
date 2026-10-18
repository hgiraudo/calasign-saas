#!/usr/bin/env node
// Prueba de punta a punta del servidor MCP (agentes de IA) con el cliente oficial del SDK:
// token OAuth (client credentials), listar herramientas, crear desde plantilla, enviar con confirmación,
// estado, URL de descarga; rechazo sin confirm, sin scope y sin credencial; API key; anulación.
// Uso: node scripts/e2e-mcp.mjs [baseUrl]   (requiere el buzón de desarrollo)
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const stamp = Date.now();
const ok = (m) => console.log(`✓ ${m}`);
function assert(c, m) {
  if (!c) throw new Error(`FALLÓ: ${m}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
async function api(method, path, body, { raw = false, bearer = null } = {}) {
  const h = {};
  if (bearer) h.authorization = `Bearer ${bearer}`;
  else if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const set = res.headers.get("set-cookie");
  if (set && !bearer) cookie = set.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
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

async function linkFor(name) {
  for (let i = 0; i < 60; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    if (m) return m.link.split("/s/")[1].split("?")[0];
    await sleep(500);
  }
  throw new Error(`no llegó la invitación de ${name}`);
}

async function mcp(token, name = "e2e") {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
const parse = (r) => JSON.parse(r.content[0].text);

// ── Organización, plantilla y app OAuth ──
await api("POST", "/v1/auth/signup", { name: "Dueña MCP", email: `owner-mcp+${stamp}@example.com`, password: "una-clave-segura-123", organization: `MCP ${stamp}` });
const { template } = await api("POST", "/v1/templates", { name: `Contrato MCP ${stamp}`, subject: "Contrato MCP" });
const fd = new FormData();
fd.append("file", new Blob([tinyPdf("Contrato MCP")], { type: "application/pdf" }), "contrato.pdf");
const tdoc = await api("POST", `/v1/templates/${template.id}/documents`, fd);
const role = randomUUID();
await api("PUT", `/v1/templates/${template.id}/roles`, { roles: [{ id: role, name: "Cliente", role: "signer", routingOrder: 1 }] });
await api("PUT", `/v1/templates/${template.id}/fields`, {
  fields: [{ documentId: tdoc.id, roleId: role, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }],
});
const app = await api("POST", "/v1/oauth/apps", {
  name: "Asistente IA",
  grantTypes: ["client_credentials"],
  scopes: ["envelopes:read", "envelopes:write", "templates:read"],
  role: "member",
});
const tokenRes = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${app.app.clientId}:${app.clientSecret}`).toString("base64")}` },
  body: "grant_type=client_credentials",
});
const { access_token: token } = await tokenRes.json();
assert(token?.startsWith("csat_"), "token OAuth");
ok("organización, plantilla con rol Cliente y app OAuth (client credentials)");

// ── Descubrimiento y autenticación ──
const prm = await api("GET", "/.well-known/oauth-protected-resource");
assert(prm.resource === `${BASE}/mcp` && prm.authorization_servers.includes(BASE), "metadatos del recurso protegido");
const asm = await api("GET", "/.well-known/oauth-authorization-server");
assert(asm.token_endpoint === `${BASE}/oauth/token` && asm.code_challenge_methods_supported.includes("S256"), "metadatos del servidor de autorización");
const noAuth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert(noAuth.status === 401 && /resource_metadata=/.test(noAuth.headers.get("www-authenticate") ?? ""), "sin credencial: 401 con WWW-Authenticate");
const getMcp = await fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${token}` } });
assert(getMcp.status === 405, "GET /mcp → 405 (servidor sin sesiones)");
ok("descubrimiento OAuth (RFC 9728/8414); 401 sin credencial");

// ── Cliente MCP ──
const client = await mcp(token, "Claude de prueba");
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
for (const n of ["list_envelopes", "get_envelope", "get_signing_status", "list_templates", "create_envelope_from_template", "send_envelope", "void_envelope", "download_signed_pdf"]) {
  assert(names.includes(n), `herramienta ${n}`);
}
ok(`${tools.length} herramientas: ${names.join(", ")}`);

const tl = parse(await client.callTool({ name: "list_templates", arguments: {} }));
assert(tl.items.some((t) => t.id === template.id && t.roles.some((r) => r.name === "Cliente")), "list_templates");

const signer = `Firmante MCP ${stamp}`;
const created = parse(
  await client.callTool({
    name: "create_envelope_from_template",
    arguments: { templateId: template.id, subject: `Contrato MCP ${stamp}`, recipients: [{ role: "Cliente", name: signer, email: `firmante-mcp+${stamp}@example.com` }] },
  }),
);
assert(created.status === "draft" && created.recipients.length === 1, "sobre en borrador desde plantilla");
const envId = created.id;
ok("list_templates + create_envelope_from_template (queda en borrador)");

let r = await client.callTool({ name: "send_envelope", arguments: { envelopeId: envId } });
assert(r.isError && /Confirmación requerida/.test(r.content[0].text) && r.content[0].text.includes(signer), "send_envelope sin confirm se rechaza con el resumen");
let d = await api("GET", `/v1/envelopes/${envId}`);
assert(d.envelope.status === "draft", "sin confirm no se envía nada");
r = await client.callTool({ name: "send_envelope", arguments: { envelopeId: envId, confirm: false } });
assert(r.isError, "confirm=false también se rechaza");
const sent = parse(await client.callTool({ name: "send_envelope", arguments: { envelopeId: envId, confirm: true } }));
assert(sent.status === "sent", "enviado con confirm=true");
const ev = await api("GET", `/v1/envelopes/${envId}/events`);
const sentEv = ev.items.find((x) => x.type === "envelope.sent");
assert(sentEv && sentEv.actorLabel.startsWith("agente IA (Asistente IA)"), `actor del envío: ${sentEv?.actorLabel}`);
ok(`send_envelope: sin confirm no envía; con confirm=true sí; evidencia: «${sentEv.actorLabel}»`);

let st = parse(await client.callTool({ name: "get_signing_status", arguments: { envelopeId: envId } }));
assert(st.status === "sent" && st.pending.length === 1 && st.pending[0].name === signer && !st.signedPdfAvailable, "estado: falta el firmante");
r = await client.callTool({ name: "download_signed_pdf", arguments: { envelopeId: envId } });
assert(r.isError && /completa/.test(r.content[0].text), "sin completar no hay PDF");

// El firmante firma desde su link.
const tk = await linkFor(signer);
await api("GET", `/v1/signing/${tk}`);
await api("POST", `/v1/signing/${tk}/consent`);
await api("POST", `/v1/signing/${tk}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
for (let i = 0; i < 60; i++) {
  st = parse(await client.callTool({ name: "get_signing_status", arguments: { envelopeId: envId } }));
  if (st.status === "completed") break;
  await sleep(1000);
}
assert(st.status === "completed" && st.signed.length === 1 && st.signedPdfAvailable, `completado: ${st.status}`);
const dl = parse(await client.callTool({ name: "download_signed_pdf", arguments: { envelopeId: envId } }));
assert(dl.url.startsWith(`${BASE}/v1/downloads/`) && new Date(dl.expiresAt) > new Date(), "URL temporal");
const pdf = Buffer.from(await (await fetch(dl.url)).arrayBuffer());
assert(pdf.subarray(0, 5).toString() === "%PDF-" && createHash("sha256").update(pdf).digest("hex") === dl.sha256, "el PDF descargado es el sellado");
const bad = await fetch(`${BASE}/v1/downloads/${"x".repeat(43)}`);
assert(bad.status === 404, "link inexistente → 404");
ok("get_signing_status + firma + download_signed_pdf (URL temporal, SHA-256 verificado)");

const le = parse(await client.callTool({ name: "list_envelopes", arguments: { status: "completed" } }));
assert(le.items.some((e) => e.id === envId), "list_envelopes filtra por estado");

// ── Anulación con confirmación ──
const second = parse(
  await client.callTool({
    name: "create_envelope_from_template",
    arguments: { templateId: template.id, recipients: [{ role: "Cliente", name: `Otro ${stamp}`, email: `otro-mcp+${stamp}@example.com` }] },
  }),
);
await client.callTool({ name: "send_envelope", arguments: { envelopeId: second.id, confirm: true } });
r = await client.callTool({ name: "void_envelope", arguments: { envelopeId: second.id, reason: "Prueba" } });
assert(r.isError && /Confirmación requerida/.test(r.content[0].text), "void sin confirm se rechaza");
const voided = parse(await client.callTool({ name: "void_envelope", arguments: { envelopeId: second.id, reason: "Prueba", confirm: true } }));
assert(voided.status === "voided", "anulado con confirm");
const ev2 = await api("GET", `/v1/envelopes/${second.id}/events`);
assert(ev2.items.find((x) => x.type === "envelope.voided")?.actorLabel.startsWith("agente IA (Asistente IA)"), "actor de la anulación");
ok("void_envelope: sin confirm se rechaza; con confirm anula; evidencia con el agente");
await client.close();

// ── Scopes: token solo de lectura ──
const ro = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${app.app.clientId}:${app.clientSecret}`).toString("base64")}` },
  body: "grant_type=client_credentials&scope=envelopes%3Aread",
});
const roToken = (await ro.json()).access_token;
const roClient = await mcp(roToken, "Solo lectura");
const roList = parse(await roClient.callTool({ name: "list_envelopes", arguments: {} }));
assert(Array.isArray(roList.items), "con envelopes:read puede listar");
r = await roClient.callTool({
  name: "create_envelope_from_template",
  arguments: { templateId: template.id, recipients: [{ role: "Cliente", name: "X", email: `x+${stamp}@example.com` }] },
});
assert(r.isError && /insufficient_scope/.test(r.content[0].text), `sin envelopes:write/templates:read no crea: ${r.content[0].text}`);
await roClient.close();
ok("los scopes del token se respetan en cada herramienta");

// ── API key ──
const key = await api("POST", "/v1/api-keys", { name: "Agente con API key" });
const kClient = await mcp(key.secret, "Agente con key");
const kl = parse(await kClient.callTool({ name: "list_envelopes", arguments: { limit: 5 } }));
assert(Array.isArray(kl.items), "API key: list_envelopes");
await kClient.close();
const revoked = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cs_test_inexistente" }, body: "{}" });
assert(revoked.status === 401, "API key inválida → 401");
ok("API key como credencial MCP; credencial inválida → 401");

console.log("\nE2E MCP OK");
