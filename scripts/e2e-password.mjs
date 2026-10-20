#!/usr/bin/env node
// Recuperación de contraseña de punta a punta (+ reintento de finalización).
// Uso: node scripts/e2e-password.mjs [baseUrl]    (requiere el buzón de desarrollo en entorno local)
const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");

function client() {
  let cookie = "";
  return async function api(method, path, body, { expect } = {}) {
    const h = {};
    if (cookie) h.cookie = cookie;
    if (body) h["content-type"] = "application/json";
    const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (expect !== undefined) {
      if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status} (esperaba ${expect}) ${text.slice(0, 300)}`);
    } else if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return data;
  };
}
const step = (m) => console.log(`✓ ${m}`);
const assert = (c, m) => {
  if (!c) throw new Error(`falló: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera un correo de restablecimiento con un link que todavía no se vio (el buzón guarda los anteriores). */
const seenTokens = new Set();
async function resetLinkFor(api, email) {
  for (let i = 0; i < 40; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.to === email && x.link?.includes("/reset/") && !seenTokens.has(x.link.split("/reset/")[1]));
    if (m) {
      seenTokens.add(m.link.split("/reset/")[1]);
      return m;
    }
    await sleep(500);
  }
  throw new Error(`no llegó el correo de restablecimiento a ${email}`);
}

const stamp = Date.now();
const email = `pw+${stamp}@example.com`;
const owner = client();
await owner("POST", "/v1/auth/signup", { name: "Paula Clave", email, password: "clave-original-123", organization: `Claves ${stamp}` });
await owner("GET", "/v1/me");
step("alta de cuenta con sesión abierta");

// Un correo que no existe también responde 202 (no revela cuentas) y no genera correo.
const anon = client();
await anon("POST", "/v1/auth/password/forgot", { email: `nadie+${stamp}@example.com` }, { expect: 202 });
await anon("POST", "/v1/auth/password/forgot", { email }, { expect: 202 });
const mail = await resetLinkFor(anon, email);
const token = mail.link.split("/reset/")[1];
assert(token && token.length >= 20, "el correo trae el link con el token");
const { items: all } = await anon("GET", "/dev/mailbox");
assert(!all.some((x) => x.to === `nadie+${stamp}@example.com`), "no se manda nada a un correo sin cuenta");
step("pedido de restablecimiento: 202 siempre, correo solo si la cuenta existe");

await anon("POST", "/v1/auth/password/reset", { token, password: "corta" }, { expect: 400 });
await anon("POST", "/v1/auth/password/reset", { token: "x".repeat(40), password: "clave-nueva-456789" }, { expect: 400 });
await anon("POST", "/v1/auth/password/reset", { token, password: "clave-nueva-456789" }, { expect: 200 });
step("contraseña nueva guardada (rechaza contraseña corta y token inválido)");

await anon("POST", "/v1/auth/password/reset", { token, password: "otra-clave-000000" }, { expect: 400 });
step("el link no se puede usar dos veces");

await owner("GET", "/v1/me", null, { expect: 401 });
step("la sesión abierta antes del cambio quedó cerrada");

const relog = client();
await relog("POST", "/v1/auth/login", { email, password: "clave-original-123" }, { expect: 401 });
await relog("POST", "/v1/auth/login", { email, password: "clave-nueva-456789" });
await relog("GET", "/v1/me");
step("la contraseña vieja ya no entra; la nueva sí");

const audit = await relog("GET", "/v1/audit-log?action=user.password_reset");
assert((audit.items ?? []).some((x) => x.action === "user.password_reset"), "auditoría del cambio de contraseña");
step("queda en la auditoría de la cuenta");

// Un pedido nuevo invalida el link anterior que no se usó.
await anon("POST", "/v1/auth/password/forgot", { email }, { expect: 202 });
const first = (await resetLinkFor(anon, email)).link.split("/reset/")[1];
await sleep(50);
await anon("POST", "/v1/auth/password/forgot", { email }, { expect: 202 });
const second = (await resetLinkFor(anon, email)).link.split("/reset/")[1];
assert(second !== first, "llegó un segundo link");
await anon("POST", "/v1/auth/password/reset", { token: first, password: "clave-tercera-789012" }, { expect: 400 });
await anon("POST", "/v1/auth/password/reset", { token: second, password: "clave-tercera-789012" }, { expect: 200 });
step("un pedido nuevo invalida el link anterior");

// Reintento de finalización: solo para sobres trabados en 'finalizing'.
const cur = client();
await cur("POST", "/v1/auth/login", { email, password: "clave-tercera-789012" });
const { envelope } = await cur("POST", "/v1/envelopes", { subject: `Reintento ${stamp}` });
const r = await cur("POST", `/v1/envelopes/${envelope.id}/retry-finalize`, null, { expect: 409 });
assert(r.error.code === "not_finalizing", "un borrador no se puede reintentar");
step("retry-finalize rechaza sobres que no están en finalización (409)");

// Bloqueo por cuenta: 10 intentos fallidos (desde cualquier IP) bloquean 15 minutos, aun con la contraseña correcta;
// restablecer la contraseña desbloquea.
const lockEmail = `lock+${stamp}@example.com`;
await client()("POST", "/v1/auth/signup", { name: "Lucía Bloqueo", email: lockEmail, password: "clave-correcta-123", organization: `Bloqueo ${stamp}` });
const atk = client();
for (let i = 0; i < 10; i++) await atk("POST", "/v1/auth/login", { email: lockEmail, password: `incorrecta-${i}` }, { expect: 401 });
await sleep(500); // la auditoría del intento fallido se registra al responder
const locked = await atk("POST", "/v1/auth/login", { email: lockEmail, password: "clave-correcta-123" }, { expect: 429 });
assert(locked.error.code === "too_many_attempts", "cuenta bloqueada tras 10 intentos fallidos");
await anon("POST", "/v1/auth/password/forgot", { email: lockEmail }, { expect: 202 });
const lockToken = (await resetLinkFor(anon, lockEmail)).link.split("/reset/")[1];
await anon("POST", "/v1/auth/password/reset", { token: lockToken, password: "clave-renovada-456" }, { expect: 200 });
await client()("POST", "/v1/auth/login", { email: lockEmail, password: "clave-renovada-456" });
step("10 intentos fallidos bloquean la cuenta (429 aun con la contraseña correcta); restablecerla la desbloquea");

// Restablecer la contraseña revoca también los tokens de apps OAuth: con la contraseña vieja (robada) se podía
// autorizar una app propia y seguir entrando con su refresh token después del cambio.
{
  const { createHash, randomBytes } = await import("node:crypto");
  const oEmail = `oauthpw+${stamp}@example.com`;
  const u = client();
  await u("POST", "/v1/auth/signup", { name: "Olga OAuth", email: oEmail, password: "clave-robada-12345", organization: `OAuth clave ${stamp}` });
  const REDIRECT = "http://localhost:5998/callback";
  const app = await u("POST", "/v1/oauth/apps", { name: "App propia", grantTypes: ["authorization_code"], redirectUris: [REDIRECT], scopes: ["envelopes:read", "offline_access"], role: "member" });
  const verifier = Buffer.from(randomBytes(48)).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const params = { response_type: "code", client_id: app.app.clientId, redirect_uri: REDIRECT, scope: "envelopes:read offline_access", state: "s", code_challenge: challenge, code_challenge_method: "S256" };
  const dec = await u("POST", "/v1/oauth/authorize/decision", { ...params, approve: true });
  const code = new URL(dec.redirectTo).searchParams.get("code");
  const tokenPost = async (body) => {
    const res = await fetch(BASE + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${app.app.clientId}:${app.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const tok = await tokenPost({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
  assert(tok.status === 200 && tok.body.refresh_token, `canje del código: ${JSON.stringify(tok.body)}`);
  // Un segundo código autorizado con la contraseña vieja y guardado sin canjear: canjearlo después del reset no puede
  // dar tokens nuevos (no los alcanzaría la revocación del reset).
  const dec2 = await u("POST", "/v1/oauth/authorize/decision", { ...params, approve: true });
  const code2 = new URL(dec2.redirectTo).searchParams.get("code");
  await anon("POST", "/v1/auth/password/forgot", { email: oEmail }, { expect: 202 });
  const t2 = (await resetLinkFor(anon, oEmail)).link.split("/reset/")[1];
  await anon("POST", "/v1/auth/password/reset", { token: t2, password: "clave-propia-67890" }, { expect: 200 });
  const acc = await fetch(BASE + "/v1/envelopes", { headers: { authorization: `Bearer ${tok.body.access_token}` } });
  assert(acc.status === 401, `el access token sigue valiendo después del reset (HTTP ${acc.status})`);
  const ref = await tokenPost({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token });
  assert(ref.status === 400 && ref.body.error === "invalid_grant", `el refresh token sigue valiendo después del reset (HTTP ${ref.status})`);
  const late = await tokenPost({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: verifier });
  assert(late.status === 400 && late.body.error === "invalid_grant", `un código emitido antes del reset se canjea después (HTTP ${late.status})`);
  step("restablecer la contraseña revoca los tokens de apps OAuth del usuario y los códigos sin canjear");
}

console.log("\nE2E CONTRASEÑA OK");
