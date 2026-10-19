#!/usr/bin/env node
// Prueba de punta a punta del servidor MCP (agentes de IA) con el cliente oficial del SDK:
// token OAuth (client credentials), listar herramientas, crear desde plantilla, enviar con confirmación,
// estado, URL de descarga; rechazo sin confirm, sin scope y sin credencial; API key; anulación.
// Conectores (Claude, ChatGPT, Claude Code, Gemini CLI): registro dinámico (RFC 7591), consentimiento + PKCE con la app
// registrada, loopback con cualquier puerto, resource (RFC 8707), anotaciones de las herramientas, create_envelope desde
// un PDF, remind_recipients, get_account, client_credentials rechazado, apps conectadas y revocación; CORS.
// Uso: node scripts/e2e-mcp.mjs [baseUrl]   (requiere el buzón de desarrollo)
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

function tinyPdf(label, extra = "") {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = `BT /F1 18 Tf 72 760 Td (${label}) Tj ET` + (extra ? `\nBT /F1 12 Tf 72 200 Td (${extra}) Tj ET` : "");
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


// ═════════════════════════ Conectores: registro dinámico (RFC 7591) + authorization_code ═════════════════════════
const b64url = (b) => b.toString("base64url");
function pkcePair() {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
async function form(path, params, basic) {
  const h = { "content-type": "application/x-www-form-urlencoded" };
  if (basic) h.authorization = `Basic ${Buffer.from(`${basic[0]}:${basic[1]}`).toString("base64")}`;
  const res = await fetch(BASE + path, { method: "POST", headers: h, body: new URLSearchParams(params) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function register(meta) {
  const res = await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(meta) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const asm2 = await api("GET", "/.well-known/oauth-authorization-server");
assert(asm2.registration_endpoint === `${BASE}/oauth/register`, "registration_endpoint en los metadatos");
assert(asm2.token_endpoint_auth_methods_supported.includes("none") && asm2.grant_types_supported.includes("refresh_token") && asm2.revocation_endpoint, "métodos y grants");
const asmMcp = await api("GET", "/.well-known/oauth-authorization-server/mcp");
assert(asm2.authorization_response_iss_parameter_supported === true, "RFC 9207 anunciado");
assert(asmMcp.issuer === BASE && asmMcp.registration_endpoint === asm2.registration_endpoint, "metadatos con sufijo /mcp");
const prmMcp = await api("GET", "/.well-known/oauth-protected-resource/mcp");
assert(prmMcp.resource === `${BASE}/mcp` && prmMcp.scopes_supported.includes("envelopes:read"), "metadatos del recurso /mcp");
const noAuth2 = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const wwwAuth = noAuth2.headers.get("www-authenticate") ?? "";
assert(noAuth2.status === 401 && wwwAuth.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`) && /scope="/.test(wwwAuth), `WWW-Authenticate: ${wwwAuth}`);
const pre = await fetch(`${BASE}/oauth/register`, { method: "OPTIONS", headers: { origin: "http://localhost:6274", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
assert(pre.status === 204 && pre.headers.get("access-control-allow-origin") === "*" && /content-type/i.test(pre.headers.get("access-control-allow-headers") ?? ""), "preflight CORS de /oauth/register");
const preMcp = await fetch(`${BASE}/mcp`, { method: "OPTIONS", headers: { origin: "http://localhost:6274", "access-control-request-method": "POST" } });
assert(preMcp.status === 204 && /authorization/i.test(preMcp.headers.get("access-control-allow-headers") ?? ""), "preflight CORS de /mcp");
assert(noAuth2.headers.get("access-control-allow-origin") === "*" && /WWW-Authenticate/i.test(noAuth2.headers.get("access-control-expose-headers") ?? ""), "CORS en el 401 de /mcp");
ok("metadatos con registration_endpoint (también con sufijo /mcp), WWW-Authenticate con scope y CORS abierto");

// Errores del registro.
let reg = await register({ client_name: "Malo", redirect_uris: ["http://example.com/cb"] });
assert(reg.status === 400 && reg.body.error === "invalid_redirect_uri", "http no loopback → invalid_redirect_uri");
reg = await register({ client_name: "Malo", redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] });
assert(reg.status === 400 && reg.body.error === "invalid_client_metadata", "client_credentials → invalid_client_metadata");
reg = await register({ redirect_uris: ["https://a.example/cb"] });
assert(reg.status === 400 && reg.body.error === "invalid_client_metadata", "sin client_name → invalid_client_metadata");

// Cliente público (como Claude Code / Gemini CLI: loopback) y uno confidencial.
const connectorName = `Conector IA ${stamp}`;
reg = await register({ client_name: connectorName, redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1/callback"] });
assert(reg.status === 201 && reg.body.client_id && !reg.body.client_secret && reg.body.client_secret_expires_at === 0, `registro público: ${JSON.stringify(reg.body)}`);
assert(reg.body.token_endpoint_auth_method === "none" && reg.body.grant_types.join() === "authorization_code,refresh_token" && reg.body.response_types.join() === "code", "metadatos por defecto");
assert(typeof reg.body.client_id_issued_at === "number" && typeof reg.body.scope === "string", "client_id_issued_at y scope");
assert(reg.headers.get("access-control-allow-origin") === "*", "CORS en /oauth/register");
const DCR = reg.body.client_id;
const conf = await register({ client_name: `Confidencial ${stamp}`, redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "client_secret_post" });
assert(conf.status === 201 && conf.body.client_secret?.startsWith("cssec_"), "registro confidencial con secreto");
ok("POST /oauth/register: errores RFC 7591, cliente público y confidencial");

// La app registrada no es de la organización: no aparece en sus apps.
const tenantApps = await api("GET", "/v1/oauth/apps");
assert(!tenantApps.items.some((x) => x.clientId === DCR), "la app dinámica no figura entre las apps de la organización");

// client_credentials nunca, ni con secreto.
let tr = await form("/oauth/token", { grant_type: "client_credentials", client_id: DCR });
assert(tr.status === 401 && tr.body.error === "invalid_client", `client_credentials con cliente público → invalid_client (${tr.status})`);
tr = await form("/oauth/token", { grant_type: "client_credentials", client_id: conf.body.client_id, client_secret: conf.body.client_secret });
assert(tr.status === 400 && tr.body.error === "unauthorized_client", `client_credentials con cliente dinámico confidencial → unauthorized_client (${tr.status})`);
ok("client_credentials rechazado para apps registradas dinámicamente");

// Autorización: loopback con un puerto cualquiera, resource bueno/malo, sin scope (defaults MCP).
const LOOP = "http://127.0.0.1:54321/callback";
const pk = pkcePair();
const authz = (extra = {}) => ({ response_type: "code", client_id: DCR, redirect_uri: LOOP, state: "st-dcr", code_challenge: pk.challenge, code_challenge_method: "S256", resource: `${BASE}/mcp`, ...extra });
let res = await api("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authz({ resource: "https://otro.example/mcp" }))}`, undefined, { raw: true });
assert(res.status === 400 && (await res.json()).error.code === "invalid_target", "resource ajeno → invalid_target");
res = await api("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authz({ redirect_uri: "http://127.0.0.1:54321/otra" }))}`, undefined, { raw: true });
assert(res.status === 400, "loopback con otra ruta → rechazada");
res = await api("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authz({ redirect_uri: "https://claude.ai:8443/api/mcp/auth_callback" }))}`, undefined, { raw: true });
assert(res.status === 400, "https con otro puerto → rechazada (solo loopback admite cualquier puerto)");
const dinfo = await api("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authz())}`);
assert(dinfo.client.unverified === true && dinfo.client.name === connectorName && dinfo.client.organizationName === "", "consentimiento: app no verificada");
const granted = dinfo.scopes.map((x) => x.scope).sort().join(" ");
assert(granted === "envelopes:read envelopes:write offline_access templates:read", `scopes por defecto: ${granted}`);
// Pedir scopes de más (openid, profile) no rompe: se concede lo habilitado.
const extraInfo = await api("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authz({ scope: "openid profile envelopes:read" }))}`);
assert(extraInfo.scopes.map((x) => x.scope).sort().join(" ") === "envelopes:read offline_access", `scopes con openid: ${extraInfo.scopes.map((x) => x.scope)}`);
const dec = await api("POST", "/v1/oauth/authorize/decision", { ...authz(), approve: true });
const back = new URL(dec.redirectTo);
assert(back.origin === "http://127.0.0.1:54321" && back.pathname === "/callback" && back.searchParams.get("state") === "st-dcr" && back.searchParams.get("iss") === BASE, `redirección: ${dec.redirectTo}`);
const dcode = back.searchParams.get("code");

tr = await form("/oauth/token", { grant_type: "authorization_code", code: dcode, redirect_uri: LOOP, code_verifier: pk.verifier, client_id: DCR, resource: "https://otro.example/mcp" });
assert(tr.status === 400 && tr.body.error === "invalid_target", "token con resource ajeno → invalid_target");
tr = await form("/oauth/token", { grant_type: "authorization_code", code: dcode, redirect_uri: LOOP, code_verifier: pkcePair().verifier, client_id: DCR, resource: `${BASE}/mcp` });
assert(tr.status === 400 && tr.body.error === "invalid_grant", "PKCE incorrecto → invalid_grant");
// El intento anterior no consumió el código (falló antes de marcarlo): vale el canje correcto.
tr = await form("/oauth/token", { grant_type: "authorization_code", code: dcode, redirect_uri: LOOP, code_verifier: pk.verifier, client_id: DCR, resource: `${BASE}/mcp` });
assert(tr.status === 200 && tr.body.access_token?.startsWith("csat_") && tr.body.refresh_token?.startsWith("csrt_"), `token: ${JSON.stringify(tr.body)}`);
let dcrToken = tr.body.access_token;
tr = await form("/oauth/token", { grant_type: "refresh_token", refresh_token: tr.body.refresh_token, client_id: DCR, resource: `${BASE}/mcp` });
assert(tr.status === 200 && tr.body.access_token, "refresh_token rota");
dcrToken = tr.body.access_token;
ok("consentimiento (no verificada) + PKCE con loopback en otro puerto, resource RFC 8707 y refresh");

// MCP con el token del conector.
const dc = await mcp(dcrToken, connectorName);
const { tools: dtools } = await dc.listTools();
for (const n of ["create_envelope", "remind_recipients", "get_account"]) assert(dtools.some((t) => t.name === n), `herramienta ${n}`);
for (const t of dtools) {
  const an = t.annotations ?? {};
  assert(
    an.title && typeof an.readOnlyHint === "boolean" && typeof an.destructiveHint === "boolean" && typeof an.idempotentHint === "boolean" && typeof an.openWorldHint === "boolean",
    `anotaciones de ${t.name}: ${JSON.stringify(an)}`,
  );
}
const byName = Object.fromEntries(dtools.map((t) => [t.name, t.annotations]));
assert(byName.list_envelopes.readOnlyHint && !byName.send_envelope.readOnlyHint && byName.send_envelope.openWorldHint && byName.void_envelope.destructiveHint, "anotaciones coherentes");
const acct = parse(await dc.callTool({ name: "get_account", arguments: {} }));
assert(acct.organization.name === `MCP ${stamp}` && acct.user?.email === `owner-mcp+${stamp}@example.com` && acct.scopes.includes("envelopes:write"), `get_account: ${JSON.stringify(acct)}`);
assert(typeof acct.usage.envelopesSent === "number" && acct.plan.name, "plan y uso");
const dl2 = parse(await dc.callTool({ name: "list_envelopes", arguments: { limit: 5 } }));
assert(Array.isArray(dl2.items) && dl2.items.length > 0, "list_envelopes con el token del conector (sobres de la organización del usuario)");
ok(`MCP con el token del conector: ${dtools.length} herramientas con anotaciones, get_account y list_envelopes`);

// create_envelope desde un PDF (base64), con ancla y sin campos.
const pdfB64 = tinyPdf("Contrato desde PDF", "Firma del cliente: ____").toString("base64");
const ce = parse(
  await dc.callTool({
    name: "create_envelope",
    arguments: {
      subject: `PDF MCP ${stamp}`,
      recipients: [
        { name: `Ana PDF ${stamp}`, email: `ana-pdf+${stamp}@example.com` },
        { name: "Copia", email: `copia+${stamp}@example.com`, role: "cc" },
      ],
      document: { base64: pdfB64, name: "contrato.pdf" },
      fields: [{ recipientIndex: 0, type: "signature", anchorText: "Firma del cliente:", offsetY: -10 }],
    },
  }),
);
assert(ce.status === "draft" && ce.documents.length === 1 && ce.recipients.length === 2 && ce.fields === 1 && !ce.note, `create_envelope con ancla: ${JSON.stringify(ce)}`);
const ce2 = parse(
  await dc.callTool({
    name: "create_envelope",
    arguments: { subject: `PDF MCP 2 ${stamp}`, recipients: [{ name: `Beto PDF ${stamp}`, email: `beto-pdf+${stamp}@example.com` }], document: { base64: pdfB64 } },
  }),
);
assert(ce2.status === "draft" && ce2.fields === 1 && /campo de firma/.test(ce2.note), `create_envelope sin campos: ${JSON.stringify(ce2)}`);
r = await dc.callTool({ name: "create_envelope", arguments: { subject: "x", recipients: [{ name: "X", email: `x2+${stamp}@example.com` }], document: { base64: Buffer.from("hola").toString("base64") } } });
assert(r.isError && /no es un PDF/.test(r.content[0].text), `base64 que no es PDF → error: ${r.content[0].text}`);
r = await dc.callTool({ name: "create_envelope", arguments: { subject: "x", recipients: [{ name: "X", email: `x3+${stamp}@example.com` }], document: { url: "https://127.0.0.1:1/x.pdf" } } });
assert(r.isError && /No se pudo obtener el PDF/.test(r.content[0].text), `URL interna/inaccesible → error: ${r.content[0].text}`);
if (!BASE.startsWith("http://")) {
  r = await dc.callTool({ name: "create_envelope", arguments: { subject: "x", recipients: [{ name: "X", email: `x4+${stamp}@example.com` }], document: { url: "http://example.com/x.pdf" } } });
  assert(r.isError && /https/.test(r.content[0].text), "URL http (fuera de local) → error");
}
const leftovers = await api("GET", `/v1/envelopes?q=${encodeURIComponent("x")}&status=draft&limit=50`);
assert(!leftovers.items.some((e) => e.subject === "x"), "un create_envelope fallido no deja borradores");
ok("create_envelope desde PDF: ancla, firma automática al pie, PDF inválido y URL bloqueada");

// remind_recipients: sin confirm no avisa; enviado, con confirm sí.
await dc.callTool({ name: "send_envelope", arguments: { envelopeId: ce2.id, confirm: true } });
r = await dc.callTool({ name: "remind_recipients", arguments: { envelopeId: ce2.id } });
assert(r.isError && /Confirmación requerida/.test(r.content[0].text) && r.content[0].text.includes(`Beto PDF ${stamp}`), "remind sin confirm");
const rem = parse(await dc.callTool({ name: "remind_recipients", arguments: { envelopeId: ce2.id, confirm: true } }));
assert(rem.notified === 1, `remind con confirm: ${JSON.stringify(rem)}`);
const ev3 = await api("GET", `/v1/envelopes/${ce2.id}/events`);
assert(ev3.items.some((x) => x.type === "envelope.reminded" && x.actorLabel.includes(connectorName)), "evidencia del recordatorio con el conector");
await dc.close();
ok("remind_recipients con confirmación y evidencia");

// Apps conectadas: aparece para el usuario que la autorizó y se puede revocar.
const conn = await api("GET", "/v1/oauth/connected-apps");
const mine = conn.items.find((x) => x.clientId === DCR);
assert(mine && mine.unverified === true && mine.name === connectorName && mine.organizationName === "", `apps conectadas: ${JSON.stringify(conn.items)}`);
const del = await api("DELETE", `/v1/oauth/connected-apps/${DCR}`, undefined, { raw: true });
assert(del.status === 204, "desconectar");
const afterRevoke = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${dcrToken}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
assert(afterRevoke.status === 401, `token revocado → 401 (fue ${afterRevoke.status})`);
assert(!(await api("GET", "/v1/oauth/connected-apps")).items.some((x) => x.clientId === DCR), "ya no figura como conectada");
ok("apps conectadas: la app dinámica figura (no verificada) y al desconectarla el token deja de valer");

console.log("\nE2E MCP OK");
