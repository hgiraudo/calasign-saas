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

async function resetLinkFor(api, email) {
  for (let i = 0; i < 40; i++) {
    const { items } = await api("GET", "/dev/mailbox");
    const m = items.find((x) => x.to === email && x.link?.includes("/reset/"));
    if (m) return m;
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
await anon("POST", "/v1/auth/password/reset", { token, password: "clave-nueva-456789" }, { expect: 204 });
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
let second = first;
for (let i = 0; i < 40 && second === first; i++) {
  const { items } = await anon("GET", "/dev/mailbox");
  second = items.find((x) => x.to === email && x.link?.includes("/reset/"))?.link.split("/reset/")[1] ?? first;
  if (second === first) await sleep(500);
}
assert(second !== first, "llegó un segundo link");
await anon("POST", "/v1/auth/password/reset", { token: first, password: "clave-tercera-789012" }, { expect: 400 });
await anon("POST", "/v1/auth/password/reset", { token: second, password: "clave-tercera-789012" }, { expect: 204 });
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
await anon("POST", "/v1/auth/password/reset", { token: lockToken, password: "clave-renovada-456" }, { expect: 204 });
await client()("POST", "/v1/auth/login", { email: lockEmail, password: "clave-renovada-456" });
step("10 intentos fallidos bloquean la cuenta (429 aun con la contraseña correcta); restablecerla la desbloquea");

console.log("\nE2E CONTRASEÑA OK");
