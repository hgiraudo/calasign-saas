#!/usr/bin/env node
// Prueba de punta a punta de la plataforma: OAuth 2.0 (client credentials, authorization code + PKCE,
// rotación de refresh tokens, revocación, introspección, scopes), avisos a Slack, Teams, Discord, Google Chat, Mattermost,
// Rocket.Chat y Webex con receptores locales,
// exportación a un bucket S3 simulado y dominio propio con DNS de prueba.
// Uso: node scripts/e2e-platform.mjs [baseUrl]   (solo entorno local: usa /dev/dns-stub y destinos 127.0.0.1)
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const stamp = Date.now();
const ok = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => {
  throw new Error(msg);
};
const assert = (c, msg) => {
  if (!c) fail(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 40_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  fail(`timeout esperando: ${what}`);
}

// ───────── Cliente HTTP: sesión (cookie) o Bearer ─────────

function client() {
  let cookie = "";
  return async function api(method, path, body, { raw = false, headers = {}, bearer = null } = {}) {
    const h = { ...headers };
    if (bearer) h.authorization = `Bearer ${bearer}`;
    else if (cookie) h.cookie = cookie;
    let payload = body;
    if (body && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set && !bearer) cookie = set.split(";")[0];
    if (raw) return res;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return data;
  };
}

/** GET con un Host arbitrario (fetch no deja cambiar Host). */
function getWithHost(path, host, extraHeaders = {}) {
  const u = new URL(BASE + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers: { host, ...extraHeaders } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function oauthPost(path, params, basic) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(basic[0])}:${encodeURIComponent(basic[1])}`).toString("base64")}`;
  const res = await fetch(BASE + path, { method: "POST", headers, body: new URLSearchParams(params) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
}

// ───────── Receptores locales: Slack/Teams y S3 ─────────

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

// Receptores de webhooks entrantes: uno por plataforma (primer segmento del path), que responde como la real
// (Discord 204, Workflows de Teams 202…) y rechaza con 400 lo que la real rechazaría por forma.
const CHANNEL_RECEIVERS = {
  slack: { status: 200, valid: (b) => typeof b.text === "string" },
  teams: { status: 202, valid: (b) => b.type === "message" && b.attachments?.[0]?.contentType === "application/vnd.microsoft.card.adaptive" },
  discord: { status: 204, valid: (b) => Array.isArray(b.embeds) && b.embeds.length <= 10 && b.embeds.every((e) => (e.title ?? "").length <= 256 && (e.description ?? "").length <= 4096) },
  google_chat: { status: 200, valid: (b) => Array.isArray(b.cardsV2) && !!b.cardsV2[0]?.card?.header },
  mattermost: { status: 200, valid: (b) => !!(b.text || b.attachments?.length) },
  rocketchat: { status: 200, valid: (b) => !!(b.text || b.attachments?.length) },
  webex: { status: 204, valid: (b) => typeof b.markdown === "string" && Buffer.byteLength(b.markdown) <= 7439 },
};
const channelHits = [];
const channels = await startServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    channelHits.push({ path: req.url, body: parsed });
    const rcv = CHANNEL_RECEIVERS[req.url.split("/")[1]];
    if (rcv && !rcv.valid(parsed)) return res.writeHead(400, { "content-type": "text/plain" }).end("invalid payload");
    res.writeHead(rcv?.status ?? 200, { "content-type": "text/plain" }).end(rcv?.status === 204 ? undefined : "ok");
  });
});

const s3Objects = new Map();
let s3Mode = "ok";
const s3 = await startServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (s3Mode === "deny") return res.writeHead(403, { "content-type": "application/xml" }).end("<Error><Code>AccessDenied</Code></Error>");
    if (req.method === "PUT") {
      // La firma SigV4 tiene que venir (no se valida: es un S3 de mentira).
      if (!String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256")) return res.writeHead(400).end();
      s3Objects.set(decodeURIComponent(req.url.split("?")[0]), Buffer.concat(chunks));
      return res.writeHead(200, { etag: '"x"' }).end();
    }
    res.writeHead(404).end();
  });
});

// ───────── Utilidades de sobres ─────────

function tinyPdf(label) {
  const content = `BT /F1 18 Tf 72 760 Td (Contrato plataforma ${label}) Tj ET`;
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

async function linkFor(api, name) {
  return waitFor(async () => {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.text.includes(name) && x.link?.includes("/s/"));
    return m?.link ?? null;
  }, `invitación de ${name}`);
}

/** Sobre de un firmante, enviado. Devuelve ids y el nombre del firmante. */
async function sendEnvelope(api, label, opts = {}) {
  const { envelope } = await api("POST", "/v1/envelopes", { subject: `Plataforma ${label} ${stamp}${opts.subjectSuffix ?? ""}` }, { bearer: opts.bearer });
  const fd = new FormData();
  fd.append("file", new Blob([tinyPdf(label)], { type: "application/pdf" }), "contrato.pdf");
  const doc = await api("POST", `/v1/envelopes/${envelope.id}/documents`, fd, { bearer: opts.bearer });
  const signerId = randomUUID();
  const signerName = `Firmante ${label} ${stamp}`;
  await api("PUT", `/v1/envelopes/${envelope.id}/recipients`, { recipients: [{ id: signerId, name: signerName, email: `f-${label}-${stamp}@example.com`, routingOrder: 1 }] }, { bearer: opts.bearer });
  await api("PUT", `/v1/envelopes/${envelope.id}/fields`, { fields: [{ documentId: doc.id, recipientId: signerId, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }] }, { bearer: opts.bearer });
  await api("POST", `/v1/envelopes/${envelope.id}/send`, undefined, { bearer: opts.bearer });
  return { envelopeId: envelope.id, signerName };
}

async function signAll(api, signerName) {
  const link = await linkFor(api, signerName);
  const token = link.split("/s/")[1];
  await api("GET", `/v1/signing/${token}`);
  await api("POST", `/v1/signing/${token}/consent`);
  await api("POST", `/v1/signing/${token}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
  return { link, token };
}

// PKCE
const b64url = (b) => Buffer.from(b).toString("base64url");
function pkcePair() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ═════════════════════════ 1. OAuth 2.0 ═════════════════════════

const owner = client();
await owner("POST", "/v1/auth/signup", { name: "Dueña Plataforma", email: `owner-plat+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Plataforma ${stamp}` });
const myEnvelope = await sendEnvelope(owner, "propio");
ok("alta de cuenta y un sobre propio");

const REDIRECT = "http://localhost:5999/callback";
const created = await owner("POST", "/v1/oauth/apps", {
  name: "ERP de prueba",
  grantTypes: ["client_credentials", "authorization_code"],
  redirectUris: [REDIRECT],
  scopes: ["envelopes:read", "envelopes:write", "templates:read", "offline_access"],
  role: "member",
});
const CLIENT_ID = created.app.clientId;
let SECRET = created.clientSecret;
assert(CLIENT_ID.startsWith("csapp_") && SECRET?.startsWith("cssec_"), "app OAuth creada con client_id y secreto");
const keys = await owner("GET", "/v1/api-keys");
assert(!keys.items.some((k) => k.name.includes("ERP de prueba")), "la API key interna de la app no aparece entre las API keys");
ok(`app OAuth confidencial ${CLIENT_ID} (secreto mostrado una sola vez; identidad de servicio oculta)`);

// ── client_credentials ──
let r = await oauthPost("/oauth/token", { grant_type: "client_credentials" }, [CLIENT_ID, SECRET]);
assert(r.status === 200 && r.body.access_token?.startsWith("csat_") && r.body.expires_in === 3600 && !r.body.refresh_token, `client_credentials: ${JSON.stringify(r.body)}`);
assert(r.headers.get("cache-control") === "no-store", "respuesta de token con Cache-Control: no-store");
const cc = r.body.access_token;
assert(!r.body.scope.includes("offline_access"), "client_credentials no recibe offline_access");
r = await oauthPost("/oauth/token", { grant_type: "client_credentials" }, [CLIENT_ID, "cssec_incorrecto"]);
assert(r.status === 401 && r.body.error === "invalid_client", "secreto inválido → invalid_client");
r = await oauthPost("/oauth/token", { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: SECRET, scope: "audit:read" });
assert(r.status === 400 && r.body.error === "invalid_scope", "scope fuera de la app → invalid_scope");

const appEnv = await sendEnvelope(owner, "app", { bearer: cc });
const ccList = await owner("GET", "/v1/envelopes", undefined, { bearer: cc });
assert(ccList.items.some((e) => e.id === appEnv.envelopeId), "la app ve su sobre");
assert(!ccList.items.some((e) => e.id === myEnvelope.envelopeId), "la app con rol member NO ve los sobres de la dueña (RBAC ∩ scopes)");
let res = await owner("GET", `/v1/envelopes/${myEnvelope.envelopeId}`, undefined, { bearer: cc, raw: true });
assert(res.status === 404, `sobre ajeno → 404 (fue ${res.status})`);
res = await owner("GET", "/v1/api-keys", undefined, { bearer: cc, raw: true });
assert(res.status === 403 && (await res.json()).error.code === "insufficient_scope", "API keys no disponibles con OAuth");
res = await owner("GET", "/v1/webhooks", undefined, { bearer: cc, raw: true });
assert(res.status === 403, "webhooks sin scope → 403");
const me = await owner("GET", "/v1/me", undefined, { bearer: cc });
assert(me.tenant.name === `Plataforma ${stamp}`, "/v1/me con token de app");
r = await oauthPost("/oauth/token", { grant_type: "client_credentials", scope: "envelopes:read" }, [CLIENT_ID, SECRET]);
const readOnly = r.body.access_token;
res = await owner("POST", "/v1/envelopes", { subject: "no debería" }, { bearer: readOnly, raw: true });
assert(res.status === 403 && (await res.json()).error.code === "insufficient_scope", "token solo lectura no puede crear sobres");
// Firma XML (facturación electrónica): disponible con envelopes:write, no con solo lectura.
res = await owner("POST", "/v1/xml/verify", { xml: "<a>sin firma</a>" }, { bearer: cc, raw: true });
assert(res.status === 200, `/v1/xml/verify con envelopes:write (fue ${res.status})`);
res = await owner("POST", "/v1/xml/verify", { xml: "<a>sin firma</a>" }, { bearer: readOnly, raw: true });
assert(res.status === 403 && (await res.json()).error.code === "insufficient_scope", "firma XML exige envelopes:write");
ok("client_credentials: token de 1 h, scopes recortados, RBAC del rol de la app y endpoints prohibidos");

// ── authorization_code + PKCE ──
const authorizeParams = (pk, extra = {}) => ({
  response_type: "code",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  scope: "envelopes:read offline_access",
  state: "st-123",
  code_challenge: pk.challenge,
  code_challenge_method: "S256",
  ...extra,
});
let pk = pkcePair();
const info = await owner("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authorizeParams(pk))}`);
assert(info.client.name === "ERP de prueba" && info.scopes.length === 2 && !info.previouslyApproved, "pantalla de consentimiento con la app y los scopes");
res = await owner("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authorizeParams(pk, { redirect_uri: "https://evil.example.com/cb" }))}`, undefined, { raw: true });
assert(res.status === 400 && (await res.json()).error.code === "invalid_redirect_uri", "redirect_uri no registrada → 400 (sin redirigir)");
res = await owner("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authorizeParams(pk, { scope: "members:write" }))}`, undefined, { raw: true });
assert(res.status === 400, "scope no habilitado en la app → 400");
res = await owner("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authorizeParams(pk))}`, undefined, { bearer: cc, raw: true });
assert(res.status === 403, "el consentimiento no se puede dar con un token");

const denied = await owner("POST", "/v1/oauth/authorize/decision", { ...authorizeParams(pk), approve: false });
const deniedUrl = new URL(denied.redirectTo);
assert(deniedUrl.searchParams.get("error") === "access_denied" && deniedUrl.searchParams.get("state") === "st-123", "rechazo → access_denied con state");

let decision = await owner("POST", "/v1/oauth/authorize/decision", { ...authorizeParams(pk), approve: true });
let cb = new URL(decision.redirectTo);
assert(cb.origin + cb.pathname === REDIRECT && cb.searchParams.get("state") === "st-123", "redirige a la URI registrada con el state");
let code = cb.searchParams.get("code");
r = await oauthPost("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pkcePair().verifier }, [CLIENT_ID, SECRET]);
assert(r.status === 400 && r.body.error === "invalid_grant", "PKCE con otro verifier → invalid_grant");

// El intento fallido no gasta el código (se revalida en la transacción), pero un canje exitoso sí.
r = await oauthPost("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pk.verifier }, [CLIENT_ID, SECRET]);
assert(r.status === 200 && r.body.refresh_token?.startsWith("csrt_"), `canje del código: ${JSON.stringify(r.body)}`);
const userAccess = r.body.access_token;
const userList = await owner("GET", "/v1/envelopes", undefined, { bearer: userAccess });
assert(userList.items.some((e) => e.id === myEnvelope.envelopeId), "token del usuario ve sus sobres");
res = await owner("POST", "/v1/envelopes", { subject: "no" }, { bearer: userAccess, raw: true });
assert(res.status === 403, "sin envelopes:write no puede crear (aunque la usuaria sea dueña)");
r = await oauthPost("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pk.verifier }, [CLIENT_ID, SECRET]);
assert(r.status === 400 && r.body.error === "invalid_grant", "código reutilizado → invalid_grant");
res = await owner("GET", "/v1/envelopes", undefined, { bearer: userAccess, raw: true });
assert(res.status === 401, "al reutilizar el código se revocan los tokens emitidos con él");
ok("authorization_code + PKCE: consentimiento, state, PKCE, código de un solo uso con revocación");

// ── refresh con rotación ──
pk = pkcePair();
const info2 = await owner("GET", `/v1/oauth/authorize/info?${new URLSearchParams(authorizeParams(pk))}`);
assert(info2.previouslyApproved, "consentimiento recordado");
decision = await owner("POST", "/v1/oauth/authorize/decision", { ...authorizeParams(pk), approve: true });
code = new URL(decision.redirectTo).searchParams.get("code");
r = await oauthPost("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pk.verifier, client_id: CLIENT_ID, client_secret: SECRET });
const a1 = r.body.access_token;
const r1 = r.body.refresh_token;
r = await oauthPost("/oauth/token", { grant_type: "refresh_token", refresh_token: r1 }, [CLIENT_ID, SECRET]);
assert(r.status === 200 && r.body.refresh_token && r.body.refresh_token !== r1, "refresh emite un refresh token nuevo");
const a2 = r.body.access_token;
const r2 = r.body.refresh_token;
res = await owner("GET", "/v1/envelopes", undefined, { bearer: a1, raw: true });
assert(res.status === 401, "el access token anterior deja de valer al rotar");
res = await owner("GET", "/v1/envelopes", undefined, { bearer: a2, raw: true });
assert(res.status === 200, "el access token nuevo funciona");
r = await oauthPost("/oauth/token", { grant_type: "refresh_token", refresh_token: r1 }, [CLIENT_ID, SECRET]);
assert(r.status === 400 && r.body.error === "invalid_grant", "refresh token reutilizado → invalid_grant");
res = await owner("GET", "/v1/envelopes", undefined, { bearer: a2, raw: true });
assert(res.status === 401, "reutilizar un refresh token revoca toda la familia");
r = await oauthPost("/oauth/token", { grant_type: "refresh_token", refresh_token: r2 }, [CLIENT_ID, SECRET]);
assert(r.status === 400, "el refresh más nuevo de la familia también quedó revocado");
ok("refresh token: rotación, invalidación del access anterior y detección de reutilización");

// ── introspección y revocación ──
r = await oauthPost("/oauth/token", { grant_type: "client_credentials" }, [CLIENT_ID, SECRET]);
const t3 = r.body.access_token;
r = await oauthPost("/oauth/introspect", { token: t3 }, [CLIENT_ID, SECRET]);
assert(r.body.active === true && r.body.client_id === CLIENT_ID && r.body.scope.includes("envelopes:write"), `introspección activa: ${JSON.stringify(r.body)}`);
r = await oauthPost("/oauth/revoke", { token: t3 }, [CLIENT_ID, SECRET]);
assert(r.status === 200, "revocación 200");
r = await oauthPost("/oauth/introspect", { token: t3 }, [CLIENT_ID, SECRET]);
assert(r.body.active === false, "revocado → inactivo");
res = await owner("GET", "/v1/envelopes", undefined, { bearer: t3, raw: true });
assert(res.status === 401, "token revocado rechazado");
r = await oauthPost("/oauth/revoke", { token: "csat_inexistente" }, [CLIENT_ID, SECRET]);
assert(r.status === 200, "revocar un token desconocido también responde 200 (RFC 7009)");
ok("introspección y revocación");

// ── cliente público + rotación de secreto + apps conectadas ──
const pub = await owner("POST", "/v1/oauth/apps", { name: "App de escritorio", grantTypes: ["authorization_code"], redirectUris: [REDIRECT], scopes: ["envelopes:read"], confidential: false });
assert(pub.clientSecret === null && pub.app.confidential === false, "cliente público sin secreto");
pk = pkcePair();
decision = await owner("POST", "/v1/oauth/authorize/decision", {
  response_type: "code",
  client_id: pub.app.clientId,
  redirect_uri: REDIRECT,
  code_challenge: pk.challenge,
  code_challenge_method: "S256",
  approve: true,
});
code = new URL(decision.redirectTo).searchParams.get("code");
r = await oauthPost("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pk.verifier, client_id: pub.app.clientId });
assert(r.status === 200 && !r.body.refresh_token, "cliente público canjea con PKCE (sin offline_access no hay refresh)");
const rot = await owner("POST", `/v1/oauth/apps/${created.app.id}/rotate-secret`);
r = await oauthPost("/oauth/token", { grant_type: "client_credentials" }, [CLIENT_ID, SECRET]);
assert(r.status === 401, "el secreto anterior deja de valer al rotar");
SECRET = rot.clientSecret;
r = await oauthPost("/oauth/token", { grant_type: "client_credentials" }, [CLIENT_ID, SECRET]);
assert(r.status === 200, "el secreto nuevo funciona");
const connected = await owner("GET", "/v1/oauth/connected-apps");
assert(connected.items.some((x) => x.clientId === pub.app.clientId), "apps conectadas de la usuaria");
await owner("DELETE", `/v1/oauth/connected-apps/${pub.app.clientId}`);
res = await owner("GET", "/v1/envelopes", undefined, { bearer: r.body.access_token, raw: true });
assert(res.status === 200, "desconectar otra app no afecta a la app de servicio");

// Un código emitido antes de que la app cambie no da tokens con lo que se le quitó: el PATCH revoca los tokens
// vigentes, pero el código (vale 10 min) seguía canjeándose con el scope o la URI de redirección quitados.
const pubCode = async () => {
  const p2 = pkcePair();
  const d2 = await owner("POST", "/v1/oauth/authorize/decision", {
    response_type: "code",
    client_id: pub.app.clientId,
    redirect_uri: REDIRECT,
    scope: "envelopes:read",
    code_challenge: p2.challenge,
    code_challenge_method: "S256",
    approve: true,
  });
  return { code: new URL(d2.redirectTo).searchParams.get("code"), verifier: p2.verifier };
};
let pc = await pubCode();
await owner("PATCH", `/v1/oauth/apps/${pub.app.id}`, { scopes: ["templates:read"] });
r = await oauthPost("/oauth/token", { grant_type: "authorization_code", code: pc.code, redirect_uri: REDIRECT, code_verifier: pc.verifier, client_id: pub.app.clientId });
assert(r.status === 400 && r.body.error === "invalid_grant", `código con un scope que la app ya no tiene → invalid_grant (${r.status} ${JSON.stringify(r.body)})`);
await owner("PATCH", `/v1/oauth/apps/${pub.app.id}`, { scopes: ["envelopes:read"] });
pc = await pubCode();
await owner("PATCH", `/v1/oauth/apps/${pub.app.id}`, { redirectUris: ["http://localhost:5998/otra"] });
r = await oauthPost("/oauth/token", { grant_type: "authorization_code", code: pc.code, redirect_uri: REDIRECT, code_verifier: pc.verifier, client_id: pub.app.clientId });
assert(r.status === 400 && r.body.error === "invalid_grant", `código con una URI de redirección quitada → invalid_grant (${r.status} ${JSON.stringify(r.body)})`);
ok("un código emitido antes de quitarle a la app un scope o una URI de redirección ya no se canjea");
ok("cliente público con PKCE, rotación de secreto y desconexión de apps");

// ═════════════════════════ 2. Avisos a canales ═════════════════════════

const slack = await owner("POST", "/v1/notification-integrations", { kind: "slack", name: "#firmas", url: `${channels.url}/slack/${stamp}`, events: ["envelope.sent", "envelope.completed"] });
const teams = await owner("POST", "/v1/notification-integrations", { kind: "teams", name: "Legales", url: `${channels.url}/teams/${stamp}`, events: ["envelope.completed"] });
assert(!JSON.stringify(slack).includes(`/slack/${stamp}`), "la URL del webhook no se devuelve completa");
const test = await owner("POST", `/v1/notification-integrations/${slack.id}/test`);
assert(test.ok && channelHits.some((h) => h.path === `/slack/${stamp}` && /prueba/i.test(h.body.text)), "mensaje de prueba a Slack");
res = await owner("POST", "/v1/notification-integrations", { kind: "slack", name: "x", url: "ftp://x.example.com/hook", events: ["envelope.sent"] }, { raw: true });
assert(res.status === 400, "URL no https → 400");
res = await owner("POST", "/v1/notification-integrations", { kind: "irc", name: "x", url: `${channels.url}/irc/${stamp}`, events: ["envelope.sent"] }, { raw: true });
assert(res.status === 400, "tipo de canal desconocido → 400");
// El resto de las plataformas: cada una con su receptor, avisando "completado".
const OTHER_KINDS = ["discord", "google_chat", "mattermost", "rocketchat", "webex"];
const others = {};
for (const kind of OTHER_KINDS) {
  others[kind] = await owner("POST", "/v1/notification-integrations", { kind, name: `Canal ${kind}`, url: `${channels.url}/${kind}/${stamp}`, events: ["envelope.completed"] });
  assert(others[kind].kind === kind, `alta de ${kind}`);
  const t = await owner("POST", `/v1/notification-integrations/${others[kind].id}/test`);
  assert(t.ok, `mensaje de prueba a ${kind} (${JSON.stringify(t)})`);
}
const discordTest = channelHits.find((h) => h.path === `/discord/${stamp}`).body;
assert(discordTest.embeds[0].title.includes("prueba") && discordTest.allowed_mentions?.parse?.length === 0, "Discord: prueba como embed y sin menciones");
const teamsTest = await owner("POST", `/v1/notification-integrations/${teams.id}/test`);
assert(teamsTest.ok && teamsTest.status === 202, "Teams (Workflows responde 202) cuenta como entregado");

// ═════════════════════════ 3. Exportación a S3 (simulado) ═════════════════════════

const providers = await owner("GET", "/v1/storage/providers");
assert(providers.items.filter((p) => p.provider !== "s3").every((p) => p.configured === false), "Drive/Dropbox/OneDrive sin credenciales → no configurados");
res = await owner("POST", "/v1/storage/oauth/gdrive/start", { name: "Drive" }, { raw: true });
assert(res.status === 409, "conectar un proveedor no configurado → 409");
s3Mode = "deny";
res = await owner("POST", "/v1/storage/connections/s3", { name: "Bucket", endpoint: s3.url, region: "us-east-1", bucket: "calasign-e2e", prefix: "firmados", accessKeyId: "AKIAE2E", secretAccessKey: "secreto" }, { raw: true });
assert(res.status === 400 && (await res.json()).error.code === "storage_test_failed", "credenciales rechazadas por el bucket → 400 al conectar");
s3Mode = "ok";
const conn = await owner("POST", "/v1/storage/connections/s3", { name: "Bucket", endpoint: s3.url, region: "us-east-1", bucket: "calasign-e2e", prefix: "firmados", accessKeyId: "AKIAE2E", secretAccessKey: "secreto" });
assert(conn.target === "calasign-e2e/firmados/" && s3Objects.has("/calasign-e2e/firmados/calasign-connection-test.pdf"), "conexión S3 probada al crearla (path-style, SigV4)");
assert(!JSON.stringify(conn).includes("secreto"), "el secreto del bucket no se devuelve");

// Sobre completo → aviso a Slack (enviado + completado), Teams (completado) y PDF sellado en el bucket.
// El asunto trae marcado de Slack/Teams: tiene que llegar como texto (sin @channel ni links falsos).
const flow = await sendEnvelope(owner, "canales", { subjectSuffix: " <!channel> [Ver](https://evil.example) @everyone <users/all> <@all>" });
await signAll(owner, flow.signerName);
const done = await waitFor(async () => {
  const d = await owner("GET", `/v1/envelopes/${flow.envelopeId}`);
  return d.envelope.status === "completed" ? d : null;
}, "sobre completado");
await waitFor(() => channelHits.filter((h) => h.path === `/slack/${stamp}`).length >= 3, "avisos de Slack");
const slackMsgs = channelHits.filter((h) => h.path === `/slack/${stamp}`).map((h) => h.body);
assert(slackMsgs.some((m) => /enviado/i.test(m.text) && m.text.includes(`Plataforma canales ${stamp}`)), "Slack: sobre enviado");
const slackDone = slackMsgs.find((m) => /completado/i.test(m.text));
assert(slackDone?.blocks?.[1]?.elements?.[0]?.url?.endsWith(`/app/envelopes/${flow.envelopeId}`), "Slack: sobre completado con botón al sobre");
await waitFor(() => channelHits.some((h) => h.path === `/teams/${stamp}`), "aviso de Teams");
const teamsMsg = channelHits.find((h) => h.path === `/teams/${stamp}` && /completado/i.test(JSON.stringify(h.body))).body;
assert(teamsMsg.attachments?.[0]?.contentType === "application/vnd.microsoft.card.adaptive" && /completado/i.test(teamsMsg.attachments[0].content.body[0].text), "Teams: tarjeta adaptable");
assert(slackMsgs.every((m) => !JSON.stringify(m).includes("<!channel>")) && slackMsgs.some((m) => m.text.includes("&lt;!channel&gt;")), "Slack: el asunto va escapado (sin @channel)");
assert(teamsMsg.attachments[0].content.body[1].text.includes("[Ver] (https://evil.example)"), "Teams: el asunto no arma links markdown");
const integrations = await owner("GET", "/v1/notification-integrations");
assert(integrations.items.find((i) => i.id === slack.id).lastStatus === 200, "última entrega registrada");
const lastOf = async (kind) => {
  await waitFor(() => channelHits.some((h) => h.path === `/${kind}/${stamp}` && /completado/i.test(JSON.stringify(h.body))), `aviso de ${kind}`);
  return channelHits.filter((h) => h.path === `/${kind}/${stamp}`).at(-1).body;
};
const envLink = `/app/envelopes/${flow.envelopeId}`;
const discordMsg = await lastOf("discord");
const embed = discordMsg.embeds[0];
assert(/completado/i.test(embed.title) && embed.url.endsWith(envLink) && embed.color === 0x16a34a, "Discord: embed verde con el título linkeado al sobre");
assert(discordMsg.allowed_mentions?.parse?.length === 0 && embed.description.includes("\\@everyone") && !embed.description.includes("[Ver](https://evil.example)"), "Discord: el asunto no menciona ni arma links");
const chatMsg = await lastOf("google_chat");
const chatJson = JSON.stringify(chatMsg);
assert(chatJson.includes(envLink) && !chatJson.includes("<users/all>") && chatJson.includes("&lt;users/all&gt;"), "Google Chat: tarjeta con botón al sobre y HTML escapado");
for (const kind of ["mattermost", "rocketchat"]) {
  const m = await lastOf(kind);
  const a = m.attachments[0];
  assert(a.title_link.endsWith(envLink) && a.color === "#16a34a" && !/@(channel|all|everyone)\b/.test(a.text), `${kind}: attachment al sobre y sin menciones`);
}
const webexMsg = await lastOf("webex");
assert(webexMsg.markdown.includes(envLink) && !webexMsg.markdown.includes("<@all>"), "Webex: markdown con link al sobre y sin menciones");
const integrations2 = await owner("GET", "/v1/notification-integrations");
for (const kind of OTHER_KINDS) {
  const it = integrations2.items.find((i) => i.id === others[kind].id);
  assert(it.lastStatus >= 200 && it.lastStatus < 300 && !it.lastError, `${kind}: última entrega registrada (${it.lastStatus})`);
}
ok("avisos a canales (Slack, Teams, Discord, Google Chat, Mattermost, Rocket.Chat, Webex): prueba, eventos elegidos, enlaces al sobre, escape y estado de la última entrega");

const exported = await waitFor(async () => {
  const { items } = await owner("GET", "/v1/storage/exports");
  return items.find((x) => x.envelopeId === flow.envelopeId && x.status === "succeeded") ?? null;
}, "exportación a S3");
const key = [...s3Objects.keys()].find((k) => k.startsWith("/calasign-e2e/firmados/Plataforma canales"));
assert(key && exported.remoteRef === `s3:/${key}`, `objeto exportado: ${key} / ${exported.remoteRef}`);
const body = s3Objects.get(key);
assert(createHash("sha256").update(body).digest("hex") === done.envelope.signedSha256, "el PDF exportado es exactamente el sellado (mismo SHA-256)");
ok("exportación automática del PDF sellado a un bucket compatible con S3");

// ═════════════════════════ 4. Dominio propio ═════════════════════════

const DOMAIN = `firmas-${stamp}.cliente-e2e.com`;
// Otra organización registra antes el mismo dominio sin poder verificarlo: no bloquea al dueño.
const squatter = client();
await squatter("POST", "/v1/auth/signup", { name: "Ocupa", email: `ocupa-plat+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Ocupa ${stamp}` });
assert((await squatter("PUT", "/v1/domains", { domain: DOMAIN })).domain.status === "pending", "otra organización registra el dominio (pendiente)");
res = await owner("PUT", "/v1/domains", { domain: "algo.calasign.com" }, { raw: true });
assert(res.status === 400, "subdominio de la plataforma → 400");
let dom = (await owner("PUT", "/v1/domains", { domain: DOMAIN })).domain;
assert(dom.status === "pending" && dom.txtName === `_calasign-challenge.${DOMAIN}` && dom.txtValue.startsWith("calasign-verify="), "dominio pendiente con TXT a crear");
dom = (await owner("POST", "/v1/domains/verify")).domain;
assert(dom.status === "pending" && dom.lastError, "sin el TXT no se verifica");
await owner("POST", "/dev/dns-stub", { name: dom.txtName, values: ["otra-cosa", dom.txtValue] });
dom = (await owner("POST", "/v1/domains/verify")).domain;
assert(dom.status === "verified" && dom.verifiedAt, "con el TXT queda verificado");
assert((await squatter("GET", "/v1/domains")).domain === null, "el registro pendiente de la otra organización se descarta al verificar");

let hb = await getWithHost("/v1/public/host-branding", DOMAIN);
assert(hb.status === 200 && JSON.parse(hb.body).organizationName === `Plataforma ${stamp}`, "marca según el Host");
hb = await getWithHost("/v1/public/host-branding", "desconocido.example.com");
assert(hb.status === 404, "Host desconocido → 404");
let tls = await getWithHost(`/internal/tls-allowed?domain=${DOMAIN}`, "localhost");
assert(tls.status === 200, "Caddy ask: dominio verificado → 200");
tls = await getWithHost("/internal/tls-allowed?domain=no-verificado.example.com", "localhost");
assert(tls.status === 404, "Caddy ask: dominio no verificado → 404");
tls = await getWithHost(`/internal/tls-allowed?domain=${DOMAIN}`, "localhost", { "x-forwarded-for": "203.0.113.9" });
assert(tls.status === 404, "Caddy ask: no responde a pedidos que vienen por el proxy");

// Los links nuevos usan el dominio propio.
const afterDomain = await sendEnvelope(owner, "dominio");
const link = await linkFor(owner, afterDomain.signerName);
assert(link.startsWith(`https://${DOMAIN}/s/`), `link de firma con el dominio propio: ${link}`);
const tokenMine = link.split("/s/")[1];
let sg = await getWithHost(`/v1/signing/${tokenMine}`, DOMAIN);
assert(sg.status === 200, "link propio por el dominio propio → 200");

// El dominio propio no sirve la cuenta: la organización controla su DNS y podría quedarse con la cookie de sesión.
const loginPage = await getWithHost("/login", DOMAIN);
assert(loginPage.status === 302 && loginPage.headers.location === `${BASE.replace(/\/$/, "")}/login`.replace(BASE, new URL(BASE).origin) || loginPage.headers.location?.endsWith("/login"), `/login en el dominio propio redirige a la plataforma (${loginPage.status} ${loginPage.headers.location})`);
const dotted = await getWithHost("/login", `${DOMAIN}.`);
assert(dotted.status === 302, `con punto final el dominio propio también redirige (${dotted.status})`);
const appPage = await getWithHost("/app/envelopes/x", DOMAIN);
assert(appPage.status === 302 && !appPage.headers.location?.includes(DOMAIN), "/app en el dominio propio redirige a la plataforma");
const loginRes = await fetch(`${BASE}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `owner-plat+${stamp}@example.com`, password: "una-clave-segura-123" }) });
const sessionCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
assert(loginRes.ok && sessionCookie.startsWith("cs_session="), "sesión en la plataforma");
assert((await getWithHost("/v1/me", "localhost", { cookie: sessionCookie })).status === 200, "la sesión vale en la plataforma");
assert((await getWithHost("/v1/me", DOMAIN, { cookie: sessionCookie })).status === 401, "la cookie de sesión se ignora en el dominio propio");
{ const r = await getWithHost("/v1/envelopes", DOMAIN, { cookie: sessionCookie }); assert(r.status === 401, `ni para la API de la cuenta (${r.status} ${r.body.slice(0, 120)})`); }
ok("dominio propio: sin login ni sesión de cuenta (redirige a la plataforma e ignora la cookie)");

// Otra organización con su propio dominio: su dominio no abre links de la primera.
const other = client();
await other("POST", "/v1/auth/signup", { name: "Otra", email: `otra-plat+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Otra ${stamp}` });
const OTHER = `firmas-${stamp}.otra-e2e.com`;
const od = (await other("PUT", "/v1/domains", { domain: OTHER })).domain;
await other("POST", "/dev/dns-stub", { name: od.txtName, values: [od.txtValue] });
assert((await other("POST", "/v1/domains/verify")).domain.status === "verified", "segunda organización verificada");
res = await other("PUT", "/v1/domains", { domain: DOMAIN }, { raw: true });
assert(res.status === 409, "un dominio ya registrado por otra organización → 409");
sg = await getWithHost(`/v1/signing/${tokenMine}`, OTHER);
assert(sg.status === 404, "un link de otra organización no abre en un dominio ajeno");
await other("DELETE", "/v1/domains");
ok("dominio propio: verificación por TXT (DNS de prueba), marca por Host, Caddy ask, links con el dominio y aislamiento entre organizaciones");

// Limpieza: apps revocadas → tokens rechazados.
await owner("DELETE", `/v1/oauth/apps/${created.app.id}`);
r = await oauthPost("/oauth/token", { grant_type: "client_credentials" }, [CLIENT_ID, SECRET]);
assert(r.status === 401, "app revocada → invalid_client");
res = await owner("GET", "/v1/envelopes", undefined, { bearer: cc, raw: true });
assert(res.status === 401, "tokens de una app revocada → 401");
ok("revocar la app invalida sus tokens y su identidad de servicio");

channels.server.close();
s3.server.close();
console.log("\nE2E PLATAFORMA OK");
