#!/usr/bin/env node
// Prueba de punta a punta de EQUIPOS (Fase 4): invitaciones, cambio de organización, RBAC (403/404),
// grupos y visibilidad, escalada de API keys, auditoría + CSV, retención y 2FA (TOTP + recuperación).
// Uso: node scripts/e2e-teams.mjs [baseUrl]     (la purga inmediata de retención solo existe en entorno local)
import { createHmac, randomUUID } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`✓ ${m}`);

class Client {
  constructor(name) {
    this.name = name;
    this.cookie = "";
  }
  async raw(method, path, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers: h, body: payload });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    return res;
  }
  async api(method, path, body, expect = [200, 201, 204]) {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    const data = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
    const ok = Array.isArray(expect) ? expect.includes(res.status) : res.status === expect;
    if (!ok) throw new Error(`[${this.name}] ${method} ${path} → ${res.status} (esperado ${expect}) ${text.slice(0, 300)}`);
    return data;
  }
}

// ───────── TOTP (RFC 6238) para la prueba ─────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32dec(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const c of s.replace(/=+$/, "")) {
    val = (val << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totp(secret, step) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", b32dec(secret)).update(c).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
const nowStep = () => Math.floor(Date.now() / 30000);

// ───────── PDF mínimo y PNG ─────────
function tinyPdf() {
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const content = "BT /F1 18 Tf 72 760 Td (Contrato de equipos) Tj ET";
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`);
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const off = [];
  objs.forEach((o, i) => {
    off.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function draftEnvelope(c, subject) {
  const { envelope } = await c.api("POST", "/v1/envelopes", { subject });
  return envelope;
}

// ───────────────────────────── 1. Organización e invitaciones ─────────────────────────────

const owner = new Client("owner");
const ownerEmail = `owner+${stamp}@example.com`;
const ownerPw = "clave-del-owner-123";
await owner.api("POST", "/v1/auth/signup", { name: "Olga Owner", email: ownerEmail, password: ownerPw, organization: `Equipos ${stamp}` });
const ownerMe = await owner.api("GET", "/v1/me");
const orgX = ownerMe.tenant.id;

const revisor = await owner.api("POST", "/v1/roles", { name: "Revisor", permissions: ["envelopes:view_all", "audit:view"] });
const integrador = await owner.api("POST", "/v1/roles", { name: "Integrador", permissions: ["api_keys:manage"] });
await owner.api("POST", "/v1/roles", { name: "revisor", permissions: [] }, 409);
step("roles personalizados creados (nombre duplicado → 409)");

const bobEmail = `bob+${stamp}@example.com`;
const invBob = await owner.api("POST", "/v1/invitations", { email: bobEmail, role: "member" });
const carolEmail = `carol+${stamp}@example.com`;
const invCarol = await owner.api("POST", "/v1/invitations", { email: carolEmail, role: "custom", roleId: revisor.id });
await owner.api("POST", "/v1/invitations", { email: ownerEmail, role: "member" }, 409);

// La invitación llega por correo (buzón de desarrollo).
const { items: mails } = await owner.api("GET", "/dev/mailbox");
const mail = mails.find((m) => m.to === bobEmail && m.link?.includes("/invite/"));
if (!mail || mail.link.split("/invite/")[1] !== invBob.acceptUrl.split("/invite/")[1]) throw new Error("no llegó la invitación por correo");
step("invitaciones enviadas por correo (miembro y rol personalizado); invitar a un miembro existente → 409");

const bobToken = invBob.acceptUrl.split("/invite/")[1];
const preview = await new Client("anon").api("GET", `/v1/invite/${bobToken}`);
if (preview.existingAccount || preview.email !== bobEmail || preview.status !== "pending") throw new Error("vista previa de invitación");
const bob = new Client("bob");
await bob.api("POST", `/v1/invite/${bobToken}/accept`, { name: "Bob Miembro", password: "x" }, 400);
await bob.api("POST", `/v1/invite/${bobToken}/accept`, { name: "Bob Miembro", password: "clave-de-bob-123" });
await new Client("anon").api("POST", `/v1/invite/${bobToken}/accept`, { name: "X", password: "clave-de-bob-123" }, 410);
const bobMe = await bob.api("GET", "/v1/me");
if (bobMe.tenant.id !== orgX) throw new Error("bob no quedó en la organización");
step("Bob aceptó con cuenta nueva (contraseña débil → 400; reutilizar el link → 410)");

// Carol ya tiene cuenta (con su propia organización) y acepta con su contraseña.
const carol = new Client("carol");
await carol.api("POST", "/v1/auth/signup", { name: "Carol Revisora", email: carolEmail, password: "clave-de-carol-123", organization: `Carol SRL ${stamp}` });
const orgY = (await carol.api("GET", "/v1/me")).tenant.id;
const carolToken = invCarol.acceptUrl.split("/invite/")[1];
const carolAnon = new Client("carol-anon");
await carolAnon.api("POST", `/v1/invite/${carolToken}/accept`, { password: "incorrecta" }, 401);
await carol.api("POST", `/v1/invite/${carolToken}/accept`, {});
let acc = await carol.api("GET", "/v1/me/access");
if (acc.tenants.length !== 2 || !acc.tenants.find((t) => t.id === orgX && t.current)) throw new Error("carol debería estar en 2 organizaciones, con X activa");
if (acc.roleName !== "Revisor" || !acc.permissions.includes("audit:view")) throw new Error("rol personalizado de carol");
await carol.api("POST", "/v1/auth/switch-tenant", { tenantId: orgY });
if ((await carol.api("GET", "/v1/me")).tenant.id !== orgY) throw new Error("cambio de organización");
await carol.api("POST", "/v1/auth/switch-tenant", { tenantId: randomUUID() }, 404);
await carol.api("POST", "/v1/auth/switch-tenant", { tenantId: orgX });
step("Carol (cuenta existente) se unió con su sesión; cambia entre sus 2 organizaciones; organización ajena → 404");

// ───────────────────────────── 2. RBAC ─────────────────────────────

await bob.api("POST", "/v1/api-keys", { name: "x" }, 403);
await bob.api("GET", "/v1/audit-log", undefined, 403);
await bob.api("PATCH", "/v1/settings/branding", { primaryColor: "#123456" }, 403);
await bob.api("POST", "/v1/roles", { name: "Hack", permissions: ["members:manage"] }, 403);
await bob.api("POST", "/v1/invitations", { email: `x+${stamp}@example.com` }, 403);
await bob.api("GET", "/v1/members");
const bobEnv = await draftEnvelope(bob, `Sobre de Bob ${stamp}`);
const ownerEnv = await draftEnvelope(owner, `Sobre del owner ${stamp}`);
await bob.api("GET", `/v1/envelopes/${ownerEnv.id}`, undefined, 404);
let bobList = await bob.api("GET", "/v1/envelopes");
if (bobList.items.some((e) => e.id === ownerEnv.id) || !bobList.items.some((e) => e.id === bobEnv.id)) throw new Error("listado de bob");
await carol.api("GET", `/v1/envelopes/${ownerEnv.id}`);
await carol.api("PATCH", `/v1/envelopes/${ownerEnv.id}`, { subject: "hack" }, 403);
await carol.api("POST", "/v1/envelopes", { subject: "no" }, 403);
await carol.api("GET", "/v1/audit-log");
step("RBAC: miembro sin acceso a API keys/auditoría/ajustes/roles (403), solo ve sus sobres; Revisor ve todo pero no modifica ni crea");

// ───────────────────────────── 3. Grupos y visibilidad ─────────────────────────────

const group = await owner.api("POST", "/v1/groups", { name: "Ventas", memberIds: [bobMe.user.id] });
await owner.api("POST", "/v1/groups", { name: "ventas" }, 409);
await owner.api("PUT", `/v1/envelopes/${ownerEnv.id}/shares`, { groupIds: [group.id] });
await bob.api("GET", `/v1/envelopes/${ownerEnv.id}`);
bobList = await bob.api("GET", "/v1/envelopes");
if (!bobList.items.some((e) => e.id === ownerEnv.id)) throw new Error("el sobre compartido no aparece en el listado de bob");
await bob.api("PATCH", `/v1/envelopes/${ownerEnv.id}`, { subject: "hack" }, 403);
await bob.api("PUT", `/v1/envelopes/${ownerEnv.id}/shares`, { groupIds: [] }, 403);

const tpl = await owner.api("POST", "/v1/templates", { name: `Plantilla restringida ${stamp}` });
const tplId = tpl.template.id;
await bob.api("GET", `/v1/templates/${tplId}`); // visible para toda la organización por defecto
await owner.api("PUT", `/v1/templates/${tplId}/shares`, { groupIds: [], visibility: "restricted" });
await bob.api("GET", `/v1/templates/${tplId}`, undefined, 404);
if ((await bob.api("GET", "/v1/templates")).items.some((t) => t.id === tplId)) throw new Error("plantilla restringida visible");
await owner.api("PUT", `/v1/templates/${tplId}/shares`, { groupIds: [group.id] });
await bob.api("GET", `/v1/templates/${tplId}`);
await bob.api("PATCH", `/v1/templates/${tplId}`, { name: "hack" }, 403);
step("grupos: sobre compartido visible para el grupo (solo lectura); plantilla restringida oculta hasta compartirla");

// ───────────────────────────── 4. API keys sin escalada ─────────────────────────────

// Configurar el SSO equivale a poder entrar como cualquier miembro: con settings:manage no alcanza.
const ajustes = await owner.api("POST", "/v1/roles", { name: "Ajustes", permissions: ["settings:manage"] });
await owner.api("PATCH", `/v1/members/${bobMe.user.id}`, { role: "custom", roleId: ajustes.id });
await bob.api("PUT", "/v1/settings/sso", { enabled: false, protocol: "oidc", domains: [] }, 403);
step("SSO: solo un propietario lo configura (un rol con settings:manage → 403)");

await owner.api("PATCH", `/v1/members/${bobMe.user.id}`, { role: "custom", roleId: integrador.id });
await bob.api("POST", "/v1/api-keys", { name: "admin?" }, 403);
await bob.api("POST", "/v1/api-keys", { name: "member?", role: "member" }, 403);
const bobKey = await bob.api("POST", "/v1/api-keys", { name: "integración", role: "custom", roleId: integrador.id });
const keyRoles = await owner.api("GET", "/v1/api-keys/roles");
if (keyRoles.items.find((k) => k.id === bobKey.apiKey.id)?.roleName !== "Integrador") throw new Error("rol de la API key");
const keyClient = new Client("key");
keyClient.bearer = bobKey.secret;
await keyClient.api("GET", "/v1/envelopes");
await keyClient.api("POST", "/v1/envelopes", { subject: "no" }, 403);
await owner.api("PATCH", `/v1/members/${ownerMe.user.id}`, { role: "member" }, 409);
await owner.api("PATCH", `/v1/members/${bobMe.user.id}`, { role: "member" });
step("API keys: no se puede crear una key con más permisos que los propios (403); la key respeta su rol; último propietario protegido (409)");

// ───────────────────────────── 5. Retención ─────────────────────────────

await owner.api("PATCH", "/v1/settings/security", { retentionDays: 1 });
const env = await draftEnvelope(owner, `Retención ${stamp}`);
const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const doc = await owner.api("POST", `/v1/envelopes/${env.id}/documents`, fd);
const signerId = randomUUID();
const signerName = `Firmante Retención ${stamp}`;
await owner.api("PUT", `/v1/envelopes/${env.id}/recipients`, { recipients: [{ id: signerId, name: signerName, email: `ret+${stamp}@example.com` }] });
await owner.api("PUT", `/v1/envelopes/${env.id}/fields`, {
  fields: [{ documentId: doc.id, recipientId: signerId, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }],
});
await owner.api("POST", `/v1/envelopes/${env.id}/send`);
let token = null;
for (let i = 0; i < 40 && !token; i++) {
  const { items } = await owner.api("GET", "/dev/mailbox");
  token = items.find((m) => m.text.includes(signerName) && m.link?.includes("/s/"))?.link.split("/s/")[1];
  if (!token) await sleep(500);
}
const signer = new Client("signer");
await signer.api("GET", `/v1/signing/${token}`);
await signer.api("POST", `/v1/signing/${token}/consent`);
await signer.api("POST", `/v1/signing/${token}/complete`, { fields: [], signature: { kind: "drawn", imagePng: PNG } });
for (let i = 0; i < 60; i++) {
  if ((await owner.api("GET", `/v1/envelopes/${env.id}`)).envelope.status === "completed") break;
  await sleep(1000);
}
const runRes = await owner.raw("POST", "/dev/retention/run", {});
if (runRes.status === 404) {
  console.log("· retención: purga inmediata no disponible fuera de entorno local (se omite)");
} else {
  const r = await runRes.json();
  if (!(r.purged >= 1)) throw new Error(`retención no purgó: ${JSON.stringify(r)}`);
  await owner.api("GET", `/v1/envelopes/${env.id}/documents/${doc.id}/file`, undefined, 410);
  const signed = await owner.raw("GET", `/v1/envelopes/${env.id}/signed.pdf`);
  if (signed.status !== 200) throw new Error("el PDF firmado debe conservarse");
  const { items: evs } = await owner.api("GET", `/v1/envelopes/${env.id}/events`);
  const purged = evs.find((e) => e.type === "envelope.purged");
  if (!purged || !(purged.data.files >= 2)) throw new Error("evento envelope.purged");
  step(`retención: originales e imagen de firma borrados (${purged.data.files} archivos) → 410; PDF firmado y eventos conservados`);
}

// ───────────────────────────── 6. 2FA (TOTP) ─────────────────────────────

const setup = await bob.api("POST", "/v1/me/2fa/setup");
if (!setup.qrSvg.startsWith("<svg") || !setup.otpauthUrl.startsWith("otpauth://totp/")) throw new Error("setup 2FA");
await bob.api("POST", "/v1/me/2fa/enable", { code: "000000" }, 400);
const { recoveryCodes } = await bob.api("POST", "/v1/me/2fa/enable", { code: totp(setup.secret, nowStep()) });
if (recoveryCodes.length !== 10) throw new Error("códigos de recuperación");
await bob.api("POST", "/v1/auth/logout");
const bob2 = new Client("bob2");
const ch = await bob2.api("POST", "/v1/auth/login", { email: bobEmail, password: "clave-de-bob-123" });
if (!ch.twoFactorRequired || bob2.cookie) throw new Error("el login con 2FA no debe crear sesión todavía");
await bob2.api("POST", "/v1/auth/2fa/verify", { challengeToken: ch.challengeToken, code: "123456" }, 401);
await bob2.api("POST", "/v1/auth/2fa/verify", { challengeToken: ch.challengeToken, code: recoveryCodes[0] });
await bob2.api("GET", "/v1/me");
const ch2 = await new Client("bob3").api("POST", "/v1/auth/login", { email: bobEmail, password: "clave-de-bob-123" });
const bob3 = new Client("bob3");
await bob3.api("POST", "/v1/auth/2fa/verify", { challengeToken: ch2.challengeToken, code: recoveryCodes[0] }, 401);
await bob3.api("POST", "/v1/auth/2fa/verify", { challengeToken: ch2.challengeToken, code: totp(setup.secret, nowStep() + 1) });
await bob3.api("GET", "/v1/me");
step("2FA: login pide segundo factor; código incorrecto → 401; código de recuperación de un solo uso; TOTP válido crea la sesión");

// Exigir 2FA a la organización.
await owner.api("PATCH", "/v1/settings/security", { require2fa: true }, 409);
const oSetup = await owner.api("POST", "/v1/me/2fa/setup");
await owner.api("POST", "/v1/me/2fa/enable", { code: totp(oSetup.secret, nowStep()) });
await owner.api("PATCH", "/v1/settings/security", { require2fa: true });
const blocked = await carol.raw("GET", "/v1/envelopes");
const blockedBody = await blocked.json();
if (blocked.status !== 403 || blockedBody.error.code !== "two_factor_setup_required") throw new Error("carol debería estar bloqueada hasta activar 2FA");
acc = await carol.api("GET", "/v1/me/access");
if (!acc.twoFactor.setupRequired) throw new Error("setupRequired");
const cSetup = await carol.api("POST", "/v1/me/2fa/setup");
await carol.api("POST", "/v1/me/2fa/enable", { code: totp(cSetup.secret, nowStep()) });
await carol.api("GET", "/v1/envelopes");
await bob3.api("POST", "/v1/me/2fa/disable", { code: totp(setup.secret, nowStep() + 1) }, [400, 409]);
step("exigir 2FA: no se puede activar sin tenerlo uno mismo (409); sin 2FA se bloquea el acceso (403) hasta activarlo");

// ───────────────────────────── 7. Auditoría ─────────────────────────────

await owner.api("PATCH", "/v1/settings/branding", { primaryColor: "#0f7c7c" });
await owner.api("POST", "/v1/api-keys", { name: "owner key" });
const failed = new Client("failed");
await failed.api("POST", "/v1/auth/login", { email: ownerEmail, password: "incorrecta" }, 401);
const { items: audit } = await owner.api("GET", "/v1/audit-log?limit=200");
const actions = new Set(audit.map((x) => x.action));
const expected = [
  "role.created", "member.invited", "member.joined", "member.role_changed", "group.created", "envelope.shared", "template.shared",
  "api_key.created", "settings.changed", "auth.login_failed", "user.2fa_enabled", "auth.tenant_switched", "template.created",
];
const missing = expected.filter((a) => !actions.has(a));
if (missing.length) throw new Error(`faltan acciones en la auditoría: ${missing.join(", ")}`);
const loginAudit = await owner.api("GET", "/v1/audit-log?action=auth.*");
if (!loginAudit.items.every((x) => x.action.startsWith("auth."))) throw new Error("filtro de auditoría");
const csv = await owner.raw("GET", "/v1/audit-log.csv?action=member.*");
const csvText = await csv.text();
if (csv.status !== 200 || !csv.headers.get("content-type")?.includes("text/csv") || !csvText.includes("member.invited")) throw new Error("CSV de auditoría");
await bob3.api("GET", "/v1/audit-log.csv", undefined, 403);
step(`auditoría: ${audit.length} entradas (${expected.length} tipos verificados), filtro por prefijo y export CSV`);

// ───────────────────────────── 8. Quitar un miembro ─────────────────────────────

await owner.api("DELETE", `/v1/members/${bobMe.user.id}`);
await bob3.api("GET", "/v1/envelopes", undefined, 401);
await owner.api("DELETE", `/v1/members/${ownerMe.user.id}`, undefined, 409);
step("quitar a un miembro cierra su acceso (401); el último propietario no se puede quitar (409)");

// ───────────────────────────── 9. Regresiones de la revisión (ronda 3) ─────────────────────────────

// (a) Dos propietarios que se quitan el rol (o se eliminan) al mismo tiempo: la organización nunca queda sin propietario.
{
  const p1 = new Client("dueño-1");
  const p1Email = `p1+${stamp}@example.com`;
  await p1.api("POST", "/v1/auth/signup", { name: "Pía Uno", email: p1Email, password: "clave-dueño-1-123", organization: `Dos dueños ${stamp}` });
  const p1Me = await p1.api("GET", "/v1/me");
  const p2Email = `p2+${stamp}@example.com`;
  const invP2 = await p1.api("POST", "/v1/invitations", { email: p2Email, role: "owner" });
  const p2 = new Client("dueño-2");
  await p2.api("POST", `/v1/invite/${invP2.acceptUrl.split("/invite/")[1]}/accept`, { name: "Pablo Dos", password: "clave-dueño-2-123" });
  const p2Me = await p2.api("GET", "/v1/me");
  for (const [label, fn] of [
    ["degradarse mutuamente", (a, b, bId, aId) => [a.raw("PATCH", `/v1/members/${bId}`, { role: "member" }), b.raw("PATCH", `/v1/members/${aId}`, { role: "member" })]],
  ]) {
    const results = await Promise.all(fn(p1, p2, p2Me.user.id, p1Me.user.id));
    const statuses = results.map((r) => r.status);
    const viewer = statuses[0] < 300 ? p1 : p2;
    const { items } = await viewer.api("GET", "/v1/members");
    const owners = items.filter((m) => m.role === "owner");
    if (owners.length < 1) throw new Error(`${label}: la organización quedó sin propietario (${statuses.join("/")})`);
    // El que pierde la carrera recibe 409 (último propietario, bajo el lock) o 401/403 (ya no es propietario).
    if (statuses.filter((x) => x < 300).length !== 1 || !statuses.some((x) => [401, 403, 409].includes(x))) {
      throw new Error(`${label}: tenía que ganar exactamente uno (${statuses.join("/")})`);
    }
  }
  // Reponer a P2 como propietario y probar la eliminación cruzada simultánea.
  const viewer = (await p1.raw("GET", "/v1/members")).status === 200 ? p1 : p2;
  const other = viewer === p1 ? p2Me : p1Me;
  await viewer.api("PATCH", `/v1/members/${other.user.id}`, { role: "owner" });
  const del = await Promise.all([p1.raw("DELETE", `/v1/members/${p2Me.user.id}`), p2.raw("DELETE", `/v1/members/${p1Me.user.id}`)]);
  const survivor = del[0].status < 300 ? p1 : p2;
  const { items: after } = await survivor.api("GET", "/v1/members");
  if (!after.some((m) => m.role === "owner")) throw new Error(`eliminación cruzada: la organización quedó sin propietario (${del.map((r) => r.status).join("/")})`);
  if (del.filter((r) => r.status < 300).length !== 1) throw new Error(`eliminación cruzada: tenía que ganar exactamente uno (${del.map((r) => r.status).join("/")})`);
  step("dos propietarios que se degradan o se eliminan a la vez: siempre queda un propietario (el otro pedido falla)");
}

// (b) Cambiar de organización exige una sesión de navegador: con API key → 403.
{
  const { secret } = await owner.api("POST", "/v1/api-keys", { name: "sin sesión" });
  const keyClient = new Client("api-key");
  keyClient.bearer = secret;
  await keyClient.api("POST", "/v1/auth/switch-tenant", { tenantId: orgX }, 403);
  step("/v1/auth/switch-tenant con API key → 403");
}

// (c) Plantillas con aprobador: se crean con el rol, y "desde sobre" conserva aprobadores y omite reemplazados.
{
  const tpl = await owner.api("POST", "/v1/templates", { name: `Con aprobador ${stamp}` });
  const tplId = tpl.template?.id ?? tpl.id;
  const rolesSet = await owner.api("PUT", `/v1/templates/${tplId}/roles`, {
    roles: [
      { name: "Cliente", role: "signer", routingOrder: 1 },
      { name: "Gerencia", role: "approver", routingOrder: 2 },
    ],
  });
  if (!rolesSet.roles.some((r) => r.role === "approver" && r.name === "Gerencia")) throw new Error("la plantilla no guardó el rol aprobador");

  const env = await draftEnvelope(owner, `Desde sobre con aprobador ${stamp}`);
  const fd = new FormData();
  fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "c.pdf");
  const doc = await owner.api("POST", `/v1/envelopes/${env.id}/documents`, fd);
  const S = randomUUID(), A = randomUUID();
  await owner.api("PUT", `/v1/envelopes/${env.id}/recipients`, {
    recipients: [
      { id: S, name: "Firma Original", email: `orig+${stamp}@example.com`, role: "signer", routingOrder: 1 },
      { id: A, name: "Aprueba", email: `aprueba+${stamp}@example.com`, role: "approver", routingOrder: 2 },
    ],
  });
  await owner.api("PUT", `/v1/envelopes/${env.id}/fields`, {
    fields: [{ documentId: doc.id, recipientId: S, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 }],
  });
  await owner.api("POST", `/v1/envelopes/${env.id}/send`);
  await owner.api("POST", `/v1/envelopes/${env.id}/recipients/${S}/reassign`, { name: "Firma Nueva", email: `nueva+${stamp}@example.com`, reason: "prueba" });
  const fromEnv = await owner.api("POST", `/v1/templates/from-envelope/${env.id}`, { name: `Desde sobre ${stamp}` });
  const roles = fromEnv.roles;
  const signers = roles.filter((r) => r.role === "signer");
  const approvers = roles.filter((r) => r.role === "approver");
  if (roles.length !== 2 || signers.length !== 1 || approvers.length !== 1) {
    throw new Error(`desde sobre: se esperaba 1 firmante + 1 aprobador (sin el reemplazado), vino ${JSON.stringify(roles.map((r) => r.role))}`);
  }
  step("plantillas: rol aprobador al crear; «desde sobre» conserva el aprobador y omite al firmante reasignado");
}

console.log("\nE2E EQUIPOS OK");
