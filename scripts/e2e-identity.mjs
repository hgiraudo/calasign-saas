#!/usr/bin/env node
// Prueba de punta a punta del bloque IDENTIDAD (Fase 5):
//   KYC del firmante con el proveedor de prueba (aprobado, nombre que no coincide, intentos agotados) + OTP antes del KYC,
//   SSO OIDC contra un IdP mínimo levantado acá (PKCE, firma RS256, nonce), JIT y sesión atada a la organización,
//   SSO obligatorio, SSO SAML 2.0 con una respuesta firmada por un IdP de prueba, y SCIM 2.0 (usuarios y grupos).
// Uso: node scripts/e2e-identity.mjs [baseUrl]   (entorno local: issuer http y buzón de desarrollo sin sesión)
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";


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
const assert = (c, m) => {
  if (!c) throw new Error(`FALLÓ: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === "") this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async raw(method, path, body, headers = {}) {
    const h = { ...headers };
    const ck = this.cookieHeader();
    if (ck) h.cookie = ck;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData) && typeof body !== "string") {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(path.startsWith("http") ? path : BASE + path, { method, headers: h, body: payload, redirect: "manual" });
    this.absorb(res);
    return res;
  }
  async api(method, path, body, expect = 200, headers = {}) {
    const res = await this.raw(method, path, body, headers);
    const text = await res.text();
    const data = text && /json/.test(res.headers.get("content-type") ?? "") ? JSON.parse(text) : text;
    const exp = Array.isArray(expect) ? expect : [expect];
    if (!exp.includes(res.status)) throw new Error(`${this.name}: ${method} ${path} → ${res.status} (esperaba ${exp.join("/")}) ${text.slice(0, 400)}`);
    return data;
  }
}

async function mailbox() {
  const res = await fetch(`${BASE}/dev/mailbox`);
  return (await res.json()).items;
}
async function waitMail(pred, what) {
  for (let i = 0; i < 60; i++) {
    const m = (await mailbox()).find(pred);
    if (m) return m;
    await sleep(300);
  }
  throw new Error(`no llegó: ${what}`);
}

// PDF mínimo (sin dependencias).
function tinyPdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ];
  const content = "BT /F1 18 Tf 72 760 Td (Contrato con KYC) Tj ET";
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const off = [];
  objs.forEach((o, i) => {
    off.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** "Foto" JPEG para el flujo integrado: cabecera JPEG + bytes al azar (el proveedor de prueba no decodifica). */
const fakeJpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(4096)]);

async function upload(client, token, kind, bytes = fakeJpeg()) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "image/jpeg" }), `${kind}.jpg`);
  return client.api("POST", `/v1/signing/${token}/identity/captures/${kind}`, fd);
}

// ───────────────────────────── Organización ─────────────────────────────

const owner = new Client("owner");
const ownerEmail = `owner+${stamp}@acme-idn.test`;
const ownerPw = "clave-segura-123456";
const me = await owner.api("POST", "/v1/auth/signup", { name: "Olga Owner", email: ownerEmail, password: ownerPw, organization: `ACME IDN ${stamp}` }, 201);
const slug = me.tenant.slug;
ok(`organización ${slug}`);

// ───────────────────────────── KYC ─────────────────────────────

const st = await owner.api("GET", "/v1/settings/identity");
assert(st.providers.find((p) => p.id === "mock")?.configured, "proveedor mock disponible en local");
assert(st.providers.find((p) => p.id === "veriff") && st.providers.find((p) => p.id === "truora"), "Veriff y Truora listados");
await owner.api("PATCH", "/v1/settings/identity", { maxAttempts: 2, mock: { decision: "approve", extractedName: "MARIA JOSE GOMEZ PEREZ", extractedDocumentNumber: "00112345678" } });

async function kycEnvelope(name, level, docNumber) {
  const { envelope } = await owner.api("POST", "/v1/envelopes", { subject: `KYC ${name} ${stamp}` }, 201);
  const fd = new FormData();
  fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
  const doc = await owner.api("POST", `/v1/envelopes/${envelope.id}/documents`, fd, 201);
  const rid = randomUUID();
  const email = `kyc+${randomUUID().slice(0, 8)}@example.com`;
  await owner.api("PUT", `/v1/envelopes/${envelope.id}/recipients`, {
    recipients: [{ id: rid, name, email, channels: ["email"], authMethod: "otp_email", idDocumentType: "cedula", idDocumentNumber: docNumber, idVerification: { provider: "mock", level } }],
  });
  await owner.api("PUT", `/v1/envelopes/${envelope.id}/fields`, {
    fields: [{ documentId: doc.id, recipientId: rid, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }],
  });
  await owner.api("POST", `/v1/envelopes/${envelope.id}/send`);
  const inv = await waitMail((m) => m.to === email && m.link?.includes("/s/"), `invitación de ${name}`);
  return { envelopeId: envelope.id, rid, email, token: inv.link.split("/s/")[1] };
}

async function passOtp(client, k) {
  await client.api("POST", `/v1/signing/${k.token}/otp/send`);
  const m = await waitMail((x) => x.to === k.email && /\b\d{6}\b/.test(x.text) && !x.link, "código OTP");
  const code = /\b(\d{6})\b/.exec(m.text)[1];
  return client.api("POST", `/v1/signing/${k.token}/otp/verify`, { code });
}

// Validaciones del contrato.
{
  const { envelope } = await owner.api("POST", "/v1/envelopes", { subject: `KYC inválido ${stamp}` }, 201);
  await owner.api(
    "PUT",
    `/v1/envelopes/${envelope.id}/recipients`,
    { recipients: [{ name: "Copia", email: "cc@example.com", role: "cc", idVerification: { provider: "mock", level: "document" } }] },
    400,
  );
  await owner.api("PUT", `/v1/envelopes/${envelope.id}/recipients`, { recipients: [{ name: "X", email: "x@example.com", idVerification: { provider: "veriff", level: "document" } }] }, 400);
}
ok("KYC: no aplica a copias; un proveedor sin configurar se rechaza");

// 1) Aprobado, con OTP primero y prueba de vida.
const k1 = await kycEnvelope("María José Gómez", "document_selfie_liveness", "001-1234567-8");
const signer1 = new Client("firmante1");
let s1 = await signer1.api("GET", `/v1/signing/${k1.token}`);
assert(s1.otpRequired && s1.documents.length === 0, "OTP primero");
assert(s1.identity?.required && s1.identity.verificationId === null, "antes del OTP no se revela la sesión de KYC");
await signer1.api("POST", `/v1/signing/${k1.token}/identity/start`, undefined, 401);
s1 = await passOtp(signer1, k1);
assert(!s1.otpRequired && s1.documents.length === 0 && s1.identity.status === "pending", "después del OTP, sin documentos hasta el KYC");
await signer1.api("POST", `/v1/signing/${k1.token}/consent`, undefined, 403);
const docFileUrl = `/v1/signing/${k1.token}/documents/${(await owner.api("GET", `/v1/envelopes/${k1.envelopeId}`)).documents[0].id}/file`;
await signer1.api("GET", docFileUrl, undefined, 403);
let idn = (await signer1.api("POST", `/v1/signing/${k1.token}/identity/start`)).identity;
assert(idn.mode === "builtin" && idn.requiredCaptures.length === 4 && idn.verificationId, "flujo integrado con 4 capturas");
await signer1.api("POST", `/v1/signing/${k1.token}/identity/submit`, undefined, 422);
await upload(signer1, k1.token, "document_front");
await upload(signer1, k1.token, "document_back");
await upload(signer1, k1.token, "selfie");
const bad = new FormData();
bad.append("file", new Blob([Buffer.from("no soy una imagen".repeat(100))], { type: "image/jpeg" }), "x.jpg");
await signer1.api("POST", `/v1/signing/${k1.token}/identity/captures/selfie_liveness`, bad, 400);
idn = (await upload(signer1, k1.token, "selfie_liveness")).identity;
assert(idn.capturedKinds.length === 4, "4 capturas guardadas");
idn = (await signer1.api("POST", `/v1/signing/${k1.token}/identity/submit`)).identity;
assert(idn.status === "verified", `KYC aprobado (${JSON.stringify(idn)})`);
s1 = await signer1.api("GET", `/v1/signing/${k1.token}`);
assert(s1.documents.length === 1 && s1.fields.length === 1, "documentos visibles después del KYC");
await signer1.api("POST", `/v1/signing/${k1.token}/consent`);
await signer1.api("POST", `/v1/signing/${k1.token}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
ok("KYC aprobado: OTP → identidad (documento + selfie + prueba de vida) → consentimiento → firma");

let det;
for (let i = 0; i < 60; i++) {
  det = await owner.api("GET", `/v1/envelopes/${k1.envelopeId}`);
  if (det.envelope.status === "completed") break;
  await sleep(500);
}
assert(det.envelope.status === "completed", "sobre completado");
assert(det.recipients[0].identity?.status === "verified", "el remitente ve la identidad verificada");
const hist = await owner.api("GET", `/v1/envelopes/${k1.envelopeId}/recipients/${k1.rid}/identity`);
assert(hist.attempts.length === 1 && hist.attempts[0].result.documentNumber?.endsWith("5678") && !hist.attempts[0].result.documentNumber.includes("0011"), "historial sin datos completos del documento");
const events = (await owner.api("GET", `/v1/envelopes/${k1.envelopeId}/events`)).items;
const types = events.map((e) => e.type);
for (const t of ["recipient.otp_sent", "recipient.authenticated", "recipient.identity_started", "recipient.identity_verified"]) assert(types.includes(t), `evento ${t}`);
assert(types.indexOf("recipient.authenticated") < types.indexOf("recipient.identity_started"), "el OTP va antes que el KYC");
const evJson = JSON.stringify(events);
assert(!/[A-Za-z0-9+/]{400,}/.test(evJson), "la evidencia no contiene imágenes");
const verified = events.find((e) => e.type === "recipient.identity_verified").data;
assert(verified.nameMatch.score >= 0.8 && verified.documentNumberMatched === true && verified.liveness === true && verified.faceMatchScore > 0.9, "resumen de la verificación");
const pdf = Buffer.from(await (await owner.raw("GET", `/v1/envelopes/${k1.envelopeId}/signed.pdf`)).arrayBuffer());
const dir = tempDir("idn-");
writeFileSync(join(dir, "signed.pdf"), pdf);
const text = execFileSync("pdftotext", [join(dir, "signed.pdf"), "-"], { encoding: "utf8" });
assert(/Verificación de identidad/.test(text) && /verificada/.test(text) && /prueba de vida/.test(text), "el certificado muestra la verificación de identidad");
ok("evidencia (eventos sin imágenes) y certificado con la sección «Verificación de identidad»");

// 2) Nombre que no coincide → falla; intentos agotados.
await owner.api("PATCH", "/v1/settings/identity", { mock: { decision: "approve", extractedName: "PEDRO RAMIREZ SOSA", extractedDocumentNumber: null } });
const k2 = await kycEnvelope("Lucía Fernández", "document", "4.567.890-1");
const signer2 = new Client("firmante2");
await passOtp(signer2, k2);
await signer2.api("POST", `/v1/signing/${k2.token}/identity/start`);
await upload(signer2, k2.token, "document_front");
await upload(signer2, k2.token, "document_back");
idn = (await signer2.api("POST", `/v1/signing/${k2.token}/identity/submit`)).identity;
assert(idn.status === "pending" && idn.failureReason === "name_mismatch" && idn.attemptsLeft === 1, `nombre que no coincide (${JSON.stringify(idn)})`);
// Segundo intento: frente y dorso idénticos.
await signer2.api("POST", `/v1/signing/${k2.token}/identity/start`);
const same = fakeJpeg();
await upload(signer2, k2.token, "document_front", same);
await upload(signer2, k2.token, "document_back", same);
idn = (await signer2.api("POST", `/v1/signing/${k2.token}/identity/submit`)).identity;
assert(idn.status === "failed" && idn.attemptsLeft === 0, "intentos agotados");
await signer2.api("POST", `/v1/signing/${k2.token}/identity/start`, undefined, 429);
await signer2.api("POST", `/v1/signing/${k2.token}/consent`, undefined, 403);
const ev2 = (await owner.api("GET", `/v1/envelopes/${k2.envelopeId}/events`)).items.filter((e) => e.type === "recipient.identity_failed");
assert(ev2.length === 2 && ev2[0].data.reason === "name_mismatch" && ev2[1].data.reason === "document_front_back_identical", "dos fallas registradas");
ok("KYC fallido: nombre distinto del documento, foto repetida, intentos agotados");
// El remitente corrige el nombre (estaba mal cargado): la verificación empieza de nuevo, con todos los intentos.
// Antes el firmante seguía sin intentos y el sobre quedaba trabado.
await owner.api("POST", `/v1/envelopes/${k2.envelopeId}/corrections`, { updateRecipients: [{ id: k2.rid, name: "Pedro Ramírez Sosa" }], reason: "nombre mal cargado" });
idn = (await signer2.api("GET", `/v1/signing/${k2.token}/identity`)).identity;
assert(idn.status === "pending" && idn.attemptsLeft === 2 && !idn.failureReason, `la corrección reinicia la verificación (${JSON.stringify(idn)})`);
await signer2.api("POST", `/v1/signing/${k2.token}/identity/start`);
await upload(signer2, k2.token, "document_front");
await upload(signer2, k2.token, "document_back");
idn = (await signer2.api("POST", `/v1/signing/${k2.token}/identity/submit`)).identity;
assert(idn.status === "verified", `verificado tras corregir el nombre (${JSON.stringify(idn)})`);
await signer2.api("POST", `/v1/signing/${k2.token}/decline`, { reason: "Prefiero no firmar" });
ok("corrección del nombre: anula las verificaciones anteriores y devuelve los intentos; el firmante puede rechazar");

// ───────────────────────────── IdP OIDC de prueba ─────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
const idp = { codes: new Map(), mode: "ok", email: null };
const oidcServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const issuer = `http://127.0.0.1:${oidcServer.address().port}`;
  const json = (o, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (url.pathname === "/.well-known/openid-configuration") {
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
  }
  if (url.pathname === "/jwks") return json({ keys: [jwk] });
  if (url.pathname === "/authorize") {
    const code = randomBytes(16).toString("hex");
    idp.codes.set(code, {
      nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
    });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let body = "";
    for await (const ch of req) body += ch;
    const p = new URLSearchParams(body);
    const auth = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
    const c = idp.codes.get(p.get("code"));
    if (!c || auth !== "calasign-test:s3cr3t") return json({ error: "invalid_client" }, 401);
    idp.codes.delete(p.get("code"));
    if (createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== c.challenge) return json({ error: "invalid_grant" }, 400);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer,
      sub: "u-123",
      aud: idp.mode === "bad_aud" ? "otro-cliente" : c.clientId,
      exp: now + 300,
      iat: now,
      nonce: idp.mode === "bad_nonce" ? "nonce-falso" : c.nonce,
      email: idp.email,
      email_verified: true,
      name: "Ana OIDC",
    };
    const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
    const pl = Buffer.from(JSON.stringify(claims)).toString("base64url");
    let sig = cryptoSign("sha256", Buffer.from(`${h}.${pl}`), privateKey).toString("base64url");
    if (idp.mode === "bad_sig") sig = sig.slice(0, -4) + (sig.endsWith("AAAA") ? "BBBB" : "AAAA");
    return json({ access_token: "at", token_type: "Bearer", id_token: `${h}.${pl}.${sig}` });
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => oidcServer.listen(0, "127.0.0.1", r));
const issuer = `http://127.0.0.1:${oidcServer.address().port}`;

/** Recorre el flujo OIDC como un navegador (redirecciones manuales). Devuelve la última ubicación. */
async function oidcLogin(client, email) {
  idp.email = email;
  const disc = await client.api("POST", "/v1/auth/sso/discover", { email });
  assert(disc.sso && disc.startUrl, "descubrimiento por dominio");
  let res = await client.raw("GET", disc.startUrl);
  assert(res.status === 302, `inicio SSO → ${res.status}`);
  const toIdp = res.headers.get("location");
  assert(toIdp.startsWith(issuer) && /code_challenge_method=S256/.test(toIdp) && /nonce=/.test(toIdp), "redirección al IdP con PKCE y nonce");
  res = await fetch(toIdp, { redirect: "manual" });
  const back = res.headers.get("location");
  res = await client.raw("GET", back);
  return res.headers.get("location");
}

const domain = `acme-idn-${stamp}.test`;
await owner.api(
  "PUT",
  "/v1/settings/sso",
  { enabled: true, protocol: "oidc", domains: [domain], jitEnabled: true, jitRole: "member", enforce: false, oidc: { issuer, clientId: "calasign-test", clientSecret: "s3cr3t" } },
  200,
);
// El dominio no se usa para el descubrimiento hasta verificarlo por DNS (TXT de prueba en local).
const before = await new Client("probe").api("POST", "/v1/auth/sso/discover", { email: `x@${domain}` });
assert(before.sso === false, "un dominio sin verificar no se usa para el descubrimiento");
const dstat = (await owner.api("GET", "/v1/settings/sso/domains")).items.find((x) => x.domain === domain);
assert(dstat && !dstat.verified && dstat.txtName === `_calasign-sso.${domain}`, "dominio pendiente con su TXT");
await owner.api("POST", "/dev/dns-stub", { name: dstat.txtName, values: [dstat.txtValue] });
const ver = await owner.api("POST", `/v1/settings/sso/domains/${domain}/verify`, {});
assert(ver.verified, "dominio verificado por DNS");
const sso = await owner.api("GET", "/v1/settings/sso");
assert(sso.oidc.hasClientSecret && !JSON.stringify(sso).includes("s3cr3t"), "el client secret no se devuelve");
const ana = new Client("ana");
let loc = await oidcLogin(ana, `ana@${domain}`);
assert(loc === "/app", `OIDC redirige a /app (${loc})`);
const anaMe = await ana.api("GET", "/v1/me");
assert(anaMe.user.email === `ana@${domain}` && anaMe.tenant.slug === slug, "sesión OIDC en la organización");
const anaAccess = await ana.api("GET", "/v1/me/access");
assert(anaAccess.role === "member", "alta JIT como miembro");
ok("SSO OIDC: descubrimiento por dominio, PKCE, id_token RS256 validado con JWKS, alta JIT");

for (const mode of ["bad_nonce", "bad_aud", "bad_sig"]) {
  idp.mode = mode;
  const c = new Client(mode);
  loc = await oidcLogin(c, `ana@${domain}`);
  assert(/\/login\?sso_error=/.test(loc ?? "") && !c.cookies.has("cs_session"), `${mode} rechazado (${loc})`);
}
idp.mode = "ok";
// Reusar el state ya consumido no funciona.
const c2 = new Client("replay");
idp.email = `ana@${domain}`;
let r0 = await c2.raw("GET", (await c2.api("POST", "/v1/auth/sso/discover", { email: `ana@${domain}` })).startUrl);
const authUrl = r0.headers.get("location");
const cb = (await fetch(authUrl, { redirect: "manual" })).headers.get("location");
await c2.raw("GET", cb);
const cbAgain = (await fetch(authUrl, { redirect: "manual" })).headers.get("location");
const stateReused = new URL(cbAgain);
r0 = await new Client("replay2").raw("GET", `${stateReused.pathname}${stateReused.search}`);
assert(/sso_state_invalid/.test(r0.headers.get("location") ?? ""), "state de un solo uso");
// Login CSRF: alguien completa el ingreso con su cuenta del IdP y le pasa el link del callback a otra persona.
// El state está atado al navegador que inició el ingreso: en otro navegador no abre sesión.
const csrfAttacker = new Client("csrf-attacker");
idp.email = `ana@${domain}`;
const csrfStart = await csrfAttacker.raw("GET", (await csrfAttacker.api("POST", "/v1/auth/sso/discover", { email: `ana@${domain}` })).startUrl);
const csrfCb = new URL((await fetch(csrfStart.headers.get("location"), { redirect: "manual" })).headers.get("location"));
const csrfVictim = new Client("csrf-victim");
const csrfRes = await csrfVictim.raw("GET", `${csrfCb.pathname}${csrfCb.search}`);
assert(/sso_state_invalid/.test(csrfRes.headers.get("location") ?? "") && !csrfVictim.cookies.has("cs_session"), "el callback de otro navegador no abre sesión (login CSRF)");
ok("OIDC rechaza nonce, aud y firma inválidos; el state no se puede reusar ni usar desde otro navegador");

// Sesión SSO atada a su organización: Ana también es miembro de otra organización (vía SCIM de esa organización),
// pero con la sesión SSO no puede cambiar a ella, ni usarla para aceptar invitaciones de otra organización.
const other = new Client("other-owner");
await other.api("POST", "/v1/auth/signup", { name: "Otra", email: `otra+${stamp}@example.com`, password: ownerPw, organization: `Otra ${stamp}` }, 201);
const otherTok = await other.api("POST", "/v1/settings/scim/tokens", { name: "otra" }, 201);
// SCIM de OTRA organización no puede sumar (ni crear) cuentas de un dominio que no verificó: sería tomar la cuenta.
const linked = await fetch(`${BASE}/scim/v2/Users`, {
  method: "POST",
  headers: { authorization: `Bearer ${otherTok.secret}`, "content-type": "application/scim+json" },
  body: JSON.stringify({ userName: `ana@${domain}`, active: true }),
});
assert(linked.status === 403, `SCIM de otra organización no vincula al usuario existente (${linked.status})`);
const squat = await fetch(`${BASE}/scim/v2/Users`, {
  method: "POST",
  headers: { authorization: `Bearer ${otherTok.secret}`, "content-type": "application/scim+json" },
  body: JSON.stringify({ userName: `nadie-aun@${domain}`, active: true }),
});
assert(squat.status === 403, `SCIM no reserva correos de dominios ajenos (${squat.status})`);
// Ana se suma a la otra organización por invitación (con contraseña: la obtiene con "olvidé mi contraseña").
const otherTenantId = (await other.api("GET", "/v1/me")).tenant.id;
const invAna = await other.api("POST", "/v1/invitations", { email: `ana@${domain}`, role: "member" }, 201);
await new Client("ana-forgot").api("POST", "/v1/auth/password/forgot", { email: `ana@${domain}` }, 202);
const resetMail = await waitMail((m) => m.to === `ana@${domain}` && m.link?.includes("/reset/"), "reset de Ana");
const anaPw = "clave-de-ana-12345";
await new Client("ana-reset").api("POST", "/v1/auth/password/reset", { token: resetMail.link.split("/reset/")[1], password: anaPw }, 204);
await new Client("ana-accept").api("POST", `/v1/invite/${invAna.acceptUrl.split("/invite/")[1]}/accept`, { password: anaPw }, [200, 201]);
// El reset cerró sus sesiones: vuelve a entrar por SSO a su organización y, con esa sesión, no puede cambiar a la otra.
const ana2 = new Client("ana-sso");
idp.mode = "ok";
await oidcLogin(ana2, `ana@${domain}`);
await ana2.api("POST", "/v1/auth/switch-tenant", { tenantId: otherTenantId }, 401);
const inv = await other.api("POST", "/v1/invitations", { email: `dana@${domain}`, role: "member" }, 201);
const dana = new Client("dana");
idp.mode = "ok";
await oidcLogin(dana, `dana@${domain}`);
await dana.api("POST", `/v1/invite/${inv.acceptUrl.split("/invite/")[1]}/accept`, {}, [400, 401, 403]);
ok("SCIM ajeno no vincula ni reserva cuentas; una sesión SSO no cambia de organización ni acepta invitaciones de otra");

// Pre-secuestro de cuenta: el registro no verifica el correo, así que alguien crea una cuenta con el correo de otra
// persona y espera a que el SSO (alta JIT) de la organización de esa persona la vincule. Con la contraseña que eligió
// no entra a esa organización: hace falta el SSO o restablecer la contraseña (que prueba el control del correo).
const preEmail = `pre+${stamp}@${domain}`;
await new Client("pre-squatter").api("POST", "/v1/auth/signup", { name: "Pre", email: preEmail, password: "clave-del-squatter-1", organization: `Squat ${stamp}` }, 201);
const preVictim = new Client("pre-victim");
idp.mode = "ok";
await oidcLogin(preVictim, preEmail);
assert((await preVictim.api("GET", "/v1/me")).tenant.id === me.tenant.id, "el SSO vinculó la cuenta existente a la organización");
const preSquatter = new Client("pre-squatter-2");
await preSquatter.api("POST", "/v1/auth/login", { email: preEmail, password: "clave-del-squatter-1" });
await preSquatter.api("POST", "/v1/auth/switch-tenant", { tenantId: me.tenant.id }, 401);
await new Client("pre-forgot").api("POST", "/v1/auth/password/forgot", { email: preEmail }, 202);
const preMail = await waitMail((m) => m.to === preEmail && m.link?.includes("/reset/"), "reset del dueño del correo");
await new Client("pre-reset").api("POST", "/v1/auth/password/reset", { token: preMail.link.split("/reset/")[1], password: "clave-del-dueño-12" }, 204);
const preOwner = new Client("pre-owner");
await preOwner.api("POST", "/v1/auth/login", { email: preEmail, password: "clave-del-dueño-12" });
await preOwner.api("POST", "/v1/auth/switch-tenant", { tenantId: me.tenant.id });
ok("pre-secuestro: la contraseña de una cuenta que vinculó el SSO no entra a esa organización hasta restablecerla");

// SSO obligatorio: miembro con contraseña bloqueado; propietario entra (emergencia).
const bob = new Client("bob");
const bobEmail = `bob+${stamp}@example.com`;
const invBob = await owner.api("POST", "/v1/invitations", { email: bobEmail, role: "member" }, 201);
await bob.api("POST", `/v1/invite/${invBob.acceptUrl.split("/invite/")[1]}/accept`, { name: "Bob Pass", password: "clave-de-bob-1234" }, [200, 201]);
const bobMe = await bob.api("GET", "/v1/me");

// Tokens OAuth de usuario: valen solo mientras valdría la sesión con la que se autorizaron (ronda 13).
const OAUTH_REDIRECT = "https://erp.example.com/cb";
const oapp = await owner.api("POST", "/v1/oauth/apps", { name: "ERP IDN", grantTypes: ["authorization_code"], redirectUris: [OAUTH_REDIRECT], scopes: ["envelopes:read", "offline_access"] }, 201);
const oauthBasic = `Basic ${Buffer.from(`${oapp.app.clientId}:${oapp.clientSecret}`).toString("base64")}`;
async function oauthToken(params) {
  const res = await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: oauthBasic }, body: new URLSearchParams(params) });
  return { status: res.status, body: await res.json() };
}
async function authorizeOAuth(client) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const d = await client.api("POST", "/v1/oauth/authorize/decision", {
    response_type: "code", client_id: oapp.app.clientId, redirect_uri: OAUTH_REDIRECT, scope: "envelopes:read offline_access",
    state: "s", code_challenge: challenge, code_challenge_method: "S256", approve: true,
  });
  const r = await oauthToken({ grant_type: "authorization_code", code: new URL(d.redirectTo).searchParams.get("code"), redirect_uri: OAUTH_REDIRECT, code_verifier: verifier });
  assert(r.status === 200, `canje del código OAuth: ${JSON.stringify(r.body)}`);
  return r.body;
}
const bearerStatus = async (tok) => (await fetch(`${BASE}/v1/envelopes`, { headers: { authorization: `Bearer ${tok}` } })).status;
// La introspección (RFC 7662) tiene que decir lo mismo que la API al usar el token.
const introspectActive = async (tok) => {
  const res = await fetch(`${BASE}/oauth/introspect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: oauthBasic }, body: new URLSearchParams({ token: tok }) });
  assert(res.status === 200, `introspección: HTTP ${res.status}`);
  return (await res.json()).active;
};

// Quitar a un miembro y volver a agregarlo no revive sus tokens anteriores.
const bobOld = await authorizeOAuth(bob);
assert((await bearerStatus(bobOld.access_token)) === 200, "token OAuth de Bob funciona");
await owner.api("DELETE", `/v1/members/${bobMe.user.id}`, undefined, [200, 204]);
assert((await bearerStatus(bobOld.access_token)) === 401, "sin membresía el token deja de valer");
assert((await introspectActive(bobOld.access_token)) === false, "sin membresía la introspección dice active: false");
assert((await introspectActive(bobOld.refresh_token)) === false, "tampoco el refresh token figura activo");
const invBob2 = await owner.api("POST", "/v1/invitations", { email: bobEmail, role: "member" }, 201);
await new Client("bob-back").api("POST", `/v1/invite/${invBob2.acceptUrl.split("/invite/")[1]}/accept`, { password: "clave-de-bob-1234" }, [200, 201]);
assert((await bearerStatus(bobOld.access_token)) === 401, "al volver a agregarlo, el token de la membresía anterior no revive");
assert((await oauthToken({ grant_type: "refresh_token", refresh_token: bobOld.refresh_token })).status === 400, "ni su refresh token");
await bob.api("POST", "/v1/auth/login", { email: bobEmail, password: "clave-de-bob-1234" });

// Con SSO obligatorio, un token autorizado con contraseña deja de valer; uno autorizado con SSO sigue.
const bobTok = await authorizeOAuth(bob);
const anaTok = await authorizeOAuth(ana2);
assert((await bearerStatus(bobTok.access_token)) === 200, "token autorizado con contraseña funciona sin SSO obligatorio");
await owner.api("PUT", "/v1/settings/sso", { enabled: true, protocol: "oidc", domains: [domain], jitEnabled: true, jitRole: "member", enforce: true, oidc: { issuer, clientId: "calasign-test" } });
assert((await bearerStatus(bobTok.access_token)) === 401, "con SSO obligatorio, el token autorizado con contraseña deja de valer");
assert((await introspectActive(bobTok.access_token)) === false, "con SSO obligatorio, la introspección del token con contraseña dice active: false");
assert((await introspectActive(anaTok.access_token)) === true, "el token autorizado con SSO sigue activo en la introspección");
const bobRefresh = await oauthToken({ grant_type: "refresh_token", refresh_token: bobTok.refresh_token });
assert(bobRefresh.status === 400 && bobRefresh.body.error === "invalid_grant", "y su refresh no emite tokens nuevos");
assert((await bearerStatus(anaTok.access_token)) === 200, "el token autorizado con SSO sigue valiendo");
ok("tokens OAuth: no reviven al volver a agregar al miembro; con SSO obligatorio caen los autorizados con contraseña");
await bob.api("GET", "/v1/me", undefined, 401);
const err = await new Client("bob2").api("POST", "/v1/auth/login", { email: bobEmail, password: "clave-de-bob-1234" }, 403);
assert(err.error.code === "sso_required" && err.error.details.startUrl.includes(slug), "login con contraseña bloqueado");
await owner.api("GET", "/v1/me");
await new Client("owner2").api("POST", "/v1/auth/login", { email: ownerEmail, password: ownerPw });
await ana2.api("GET", "/v1/me");
ok("SSO obligatorio: sesiones con contraseña de miembros cerradas, login bloqueado; propietario y sesión SSO siguen");

// ───────────────────────────── SAML ─────────────────────────────

const certDir = tempDir("idp-");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "k.pem"), "-out", join(certDir, "c.pem"), "-subj", "/CN=idp.test", "-days", "2"], {
  stdio: "ignore",
});
const idpKey = readFileSync(join(certDir, "k.pem"), "utf8");
const idpCert = readFileSync(join(certDir, "c.pem"), "utf8");
const idpIssuer = "https://idp.test/saml";
await owner.api("PUT", "/v1/settings/sso", {
  enabled: true,
  protocol: "saml",
  domains: [domain],
  jitEnabled: true,
  jitRole: "member",
  enforce: false,
  saml: { entryPoint: "http://127.0.0.1:9/saml/sso", idpIssuer, idpCert },
});
const samlSettings = await owner.api("GET", "/v1/settings/sso");
assert(samlSettings.saml.idpCertFingerprint, "huella del certificado del IdP");
const meta = await (await fetch(samlSettings.serviceProvider.samlMetadataUrl.replace(/^https?:\/\/[^/]+/, BASE))).text();
assert(/EntityDescriptor/.test(meta) && meta.includes(samlSettings.serviceProvider.samlAcsUrl), "metadata del SP con el ACS");

function samlResponse({ reqId, email, acs, audience, tamper = false }) {
  const now = new Date();
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const later = new Date(now.getTime() + 5 * 60_000);
  const before = new Date(now.getTime() - 60_000);
  const aid = `_a${randomBytes(12).toString("hex")}`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${iso(now)}" Destination="${acs}" InResponseTo="${reqId}">` +
    `<saml:Issuer>${idpIssuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${aid}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${idpIssuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${reqId}" NotOnOrAfter="${iso(later)}" Recipient="${acs}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(before)}" NotOnOrAfter="${iso(later)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="displayName"><saml:AttributeValue>Beto SAML</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion></samlp:Response>`;
  const sig = new SignedXml({
    privateKey: idpKey,
    publicCert: idpCert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  let signed = sig.getSignedXml();
  if (tamper) signed = signed.replace(`>${email}<`, `>intruso@${domain}<`);
  return Buffer.from(signed).toString("base64");
}

async function samlLogin(client, email, opts = {}) {
  const res = await client.raw("GET", `/v1/auth/sso/start?org=${encodeURIComponent(slug)}`);
  const to = new URL(res.headers.get("location"));
  const reqXml = inflateRawSync(Buffer.from(to.searchParams.get("SAMLRequest"), "base64")).toString("utf8");
  const reqId = /ID="([^"]+)"/.exec(reqXml)[1];
  const relay = to.searchParams.get("RelayState");
  const acs = samlSettings.serviceProvider.samlAcsUrl;
  const form = new URLSearchParams({
    SAMLResponse: samlResponse({ reqId: opts.reqId ?? reqId, email, acs, audience: samlSettings.serviceProvider.samlEntityId, tamper: opts.tamper }),
    RelayState: relay,
  });
  const post = await client.raw("POST", acs.replace(/^https?:\/\/[^/]+/, BASE), form.toString(), {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://idp.test",
  });
  return { location: post.headers.get("location"), relay, form };
}

const beto = new Client("beto");
const r1 = await samlLogin(beto, `beto@${domain}`);
assert(r1.location === "/app", `SAML redirige a /app (${r1.location})`);
const betoMe = await beto.api("GET", "/v1/me");
assert(betoMe.user.email === `beto@${domain}` && betoMe.user.name === "Beto SAML", "sesión SAML con JIT y nombre del IdP");
const replay = await new Client("replay-saml").raw("POST", samlSettings.serviceProvider.samlAcsUrl.replace(/^https?:\/\/[^/]+/, BASE), r1.form.toString(), {
  "content-type": "application/x-www-form-urlencoded",
});
assert(/sso_state_invalid/.test(replay.headers.get("location") ?? ""), "la respuesta SAML no se puede reusar");
const tampered = await samlLogin(new Client("tamper"), `cami@${domain}`, { tamper: true });
assert(/sso_error=/.test(tampered.location ?? ""), "aserción adulterada rechazada");
const wrongReq = await samlLogin(new Client("wrongreq"), `cami@${domain}`, { reqId: "_no_emitido" });
assert(/sso_error=/.test(wrongReq.location ?? ""), "InResponseTo desconocido rechazado");
ok("SSO SAML 2.0: AuthnRequest, respuesta firmada validada con el certificado del IdP, JIT; replay, adulteración e InResponseTo rechazados");

// ───────────────────────────── SCIM 2.0 ─────────────────────────────

const tok = await owner.api("POST", "/v1/settings/scim/tokens", { name: "IdP de prueba" }, 201);
assert(tok.secret.startsWith("cs_scim_"), "token SCIM");
const scim = new Client("scim");
const H = { authorization: `Bearer ${tok.secret}`, "content-type": "application/scim+json" };
const scimApi = async (method, path, body, expect = 200) => {
  const res = await scim.raw(method, `/scim/v2${path}`, body === undefined ? undefined : JSON.stringify(body), H);
  const text = await res.text();
  if (res.status !== expect) throw new Error(`SCIM ${method} ${path} → ${res.status} (esperaba ${expect}) ${text.slice(0, 300)}`);
  assert(/application\/scim\+json/.test(res.headers.get("content-type") ?? ""), "content-type SCIM");
  return text ? JSON.parse(text) : null;
};
const unauth = await scim.raw("GET", "/scim/v2/Users", undefined, { authorization: "Bearer nada" });
assert(unauth.status === 401 && (await unauth.json()).schemas[0].includes("Error"), "token inválido → 401 SCIM");
const spc = await scimApi("GET", "/ServiceProviderConfig");
assert(spc.patch.supported && spc.filter.supported, "ServiceProviderConfig");

const carlaEmail = `carla@${domain}`;
const carla = await scimApi(
  "POST",
  "/Users",
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: carlaEmail, externalId: "ext-carla", name: { givenName: "Carla", familyName: "Suárez" }, emails: [{ value: carlaEmail, primary: true }], active: true },
  201,
);
assert(carla.id && carla.active && carla.userName === carlaEmail, "usuario creado");
await scimApi("POST", "/Users", { userName: carlaEmail }, 409);
let list = await scimApi("GET", `/Users?filter=${encodeURIComponent(`userName eq "${carlaEmail}"`)}`);
assert(list.totalResults === 1 && list.Resources[0].id === carla.id, "filtro userName eq");
list = await scimApi("GET", `/Users?filter=${encodeURIComponent('externalId eq "ext-carla"')}`);
assert(list.totalResults === 1, "filtro externalId eq");
await scimApi("GET", `/Users?filter=${encodeURIComponent('title co "x"')}`, undefined, 400);
let members = (await owner.api("GET", "/v1/members")).items;
assert(members.some((m) => m.email === carlaEmail && m.role === "member"), "es miembro de la organización");

const grp = await scimApi("POST", "/Groups", { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"], displayName: `Legales ${stamp}`, members: [{ value: carla.id }] }, 201);
assert(grp.members.length === 1, "grupo con miembro");
let groups = (await owner.api("GET", "/v1/groups")).items;
assert(groups.some((g) => g.id === grp.id), "grupo visible en la organización");
// Desactivación al estilo Azure AD (string "False").
let upd = await scimApi("PATCH", `/Users/${carla.id}`, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: "False" }] });
assert(upd.active === false, "desactivado");
members = (await owner.api("GET", "/v1/members")).items;
assert(!members.some((m) => m.email === carlaEmail), "sin membresía al desactivar");
assert((await scimApi("GET", `/Groups/${grp.id}`)).members.length === 0, "sale de los grupos al desactivar");
upd = await scimApi("PATCH", `/Users/${carla.id}`, { Operations: [{ op: "replace", value: { active: true, "name.givenName": "Carla María" } }] });
assert(upd.active === true && upd.name.givenName === "Carla María", "reactivado y renombrado");
await scimApi("PATCH", `/Groups/${grp.id}`, { Operations: [{ op: "add", path: "members", value: [{ value: carla.id }] }] }, 204);
assert((await scimApi("GET", `/Groups/${grp.id}`)).members.length === 1, "PATCH add members");
await scimApi("PATCH", `/Groups/${grp.id}`, { Operations: [{ op: "remove", path: `members[value eq "${carla.id}"]` }] }, 204);
assert((await scimApi("GET", `/Groups/${grp.id}`)).members.length === 0, "PATCH remove members");
// El correo de alguien con más permisos que el rol por defecto de SCIM (member) no se cambia por SCIM: el token lo
// puede crear quien solo tiene esos permisos, y cambiar el correo de un administrador sería quedarse con su cuenta.
await owner.api("PATCH", `/v1/members/${carla.id}`, { role: "admin" });
await scimApi("PATCH", `/Users/${carla.id}`, { Operations: [{ op: "replace", path: "userName", value: `carla.nueva-${stamp}@${domain}` }] }, 409);
await owner.api("PATCH", `/v1/members/${carla.id}`, { role: "member" });
upd = await scimApi("PATCH", `/Users/${carla.id}`, { Operations: [{ op: "replace", path: "userName", value: `carla.nueva-${stamp}@${domain}` }] });
assert(upd.userName === `carla.nueva-${stamp}@${domain}`, "el correo de un miembro sí se cambia por SCIM");
await scimApi("DELETE", `/Users/${carla.id}`, undefined, 204);
await scimApi("GET", `/Users/${carla.id}`, undefined, 404);
await scimApi("DELETE", `/Groups/${grp.id}`, undefined, 204);
const audit = (await owner.api("GET", "/v1/audit-log?action=member.scim_*")).items ?? [];
assert(audit.length >= 3, `auditoría de SCIM (${audit.length})`);
ok("SCIM 2.0: alta, filtros, duplicado 409, desactivar/reactivar (membresía y grupos), grupos con PATCH, baja y auditoría");

oidcServer.close();
console.log("\nE2E IDENTIDAD OK");
