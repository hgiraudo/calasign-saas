#!/usr/bin/env node
// Prueba de punta a punta de los conectores HRIS/CLM (BambooHR, Ironclad, Juro) y del archivado en gestores
// documentales (Box, SharePoint) contra servidores simulados. Autocontenida: levanta los simuladores y su propia API
// (puerto 4117) con las URLs de los proveedores apuntando a ellos. Uso: node scripts/e2e-connectors.mjs
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.E2E_CONN_PORT ?? 4117);
const BASE = `http://localhost:${PORT}`;
const MB = Number(process.env.E2E_CONN_MOCK_BASE ?? 4301);
const P = { bamboo: MB, ironclad: MB + 1, juro: MB + 2, box: MB + 3, ms: MB + 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`✓ ${m}`);
const assert = (c, m) => {
  if (!c) throw new Error(`falló: ${m}`);
};

// ───────────────────────────── Simuladores ─────────────────────────────

function readBody(req) {
  return new Promise((res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
  });
}
function serve(port, handler) {
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (status, data, headers = {}) => {
      if (data === undefined) {
        res.writeHead(status, headers);
        return res.end();
      }
      if (Buffer.isBuffer(data)) {
        res.writeHead(status, { "content-type": "application/pdf", ...headers });
        return res.end(data);
      }
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    try {
      await handler({ req, url, body, json: () => JSON.parse(body.toString() || "{}"), send });
    } catch (e) {
      send(500, { message: String(e) });
    }
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}
const s256 = (v) => createHash("sha256").update(v).digest("base64url");
/** Partes de un multipart/form-data (nombre → {filename, text}). */
function parts(req, body) {
  const b = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers["content-type"] ?? "");
  const boundary = b?.[1] ?? b?.[2];
  const out = {};
  if (!boundary) return out;
  for (const chunk of body.toString("latin1").split(`--${boundary}`)) {
    const m = /name="([^"]+)"(?:; filename="([^"]*)")?[\s\S]*?\r\n\r\n([\s\S]*)\r\n$/.exec(chunk);
    if (m) out[m[1]] = { filename: m[2] ?? null, text: m[3] };
  }
  return out;
}

function tinyPdf(text) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"];
  const content = `BT /F1 18 Tf 72 760 Td (${text}) Tj ET`;
  objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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

// BambooHR (API key por Basic)
const bamboo = {
  key: "bamboo-key-123456",
  revoked: false,
  employees: {
    101: { id: "101", firstName: "Lucía", lastName: "Gómez HR", workEmail: "lucia.hr@acme.test", jobTitle: "Analista contable", supervisorEId: "100" },
    100: { id: "100", firstName: "Marta", lastName: "Jefa HR", workEmail: "marta.hr@acme.test", jobTitle: "Gerente" },
    102: { id: "102", firstName: "Pedro", lastName: "Nuevo HR", workEmail: "pedro.hr@acme.test", jobTitle: "Vendedor" },
  },
  files: [],
  updates: [],
};
await serve(P.bamboo, async ({ req, url, body, json, send }) => {
  const m0 = url.pathname.match(/^\/api\/gateway\.php\/([\w-]+)\/v1(\/.*)$/);
  if (!m0 || m0[1] !== "acme") return send(404, { message: "company not found" });
  const path = m0[2];
  if (bamboo.revoked || req.headers.authorization !== `Basic ${Buffer.from(`${bamboo.key}:x`).toString("base64")}`) return send(401, undefined, { "x-bamboohr-error-message": "invalid key" });
  let m;
  if (path === "/employees/directory") return send(200, { employees: Object.values(bamboo.employees).map((e) => ({ id: e.id, displayName: `${e.firstName} ${e.lastName}`, workEmail: e.workEmail, jobTitle: e.jobTitle })) });
  if ((m = path.match(/^\/employees\/(\w+)\/files\/view$/))) return send(200, { categories: [{ id: 17, name: "Contratos" }] });
  if ((m = path.match(/^\/employees\/(\w+)\/files$/)) && req.method === "POST") {
    const p = parts(req, body);
    bamboo.files.push({ employee: m[1], category: p.category?.text, fileName: p.fileName?.text, share: p.share?.text, pdf: p.file?.text.startsWith("%PDF"), evidence: p.file?.text.includes("calasign.evidence-certificate") });
    return send(201, undefined, { location: `https://api.bamboohr.test/files/${bamboo.files.length}` });
  }
  if ((m = path.match(/^\/employees\/(\w+)$/))) {
    const e = bamboo.employees[m[1]];
    if (!e) return send(404, undefined);
    if (req.method === "POST") {
      bamboo.updates.push({ id: m[1], ...json() });
      Object.assign(e, json());
      return send(200, undefined);
    }
    const fields = (url.searchParams.get("fields") ?? "").split(",");
    return send(200, Object.fromEntries(Object.entries(e).filter(([k]) => k === "id" || fields.includes(k))));
  }
  send(404, { message: `bamboo mock: ${req.method} ${path}` });
});

// Ironclad (OAuth con PKCE)
const ic = {
  token: null,
  codes: new Map(),
  signed: [],
  workflows: {
    wf1: {
      id: "wf1",
      title: "MSA Globex",
      status: "active",
      step: "Sign",
      attributes: { counterpartyName: "Globex", counterpartySignerName: "Gina Globex IC", counterpartySignerEmail: "gina.ic@globex.test", contractValue: "50000", draft: [{ key: "d1", filename: "MSA Globex.pdf" }] },
    },
  },
};
await serve(P.ironclad, async ({ req, url, body, send }) => {
  const path = url.pathname;
  if (path === "/oauth/authorize") {
    if (url.searchParams.get("code_challenge_method") !== "S256") return send(400, { error: "pkce_required" });
    const code = `ic-${randomUUID()}`;
    ic.codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirect: url.searchParams.get("redirect_uri") });
    return send(302, undefined, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
  }
  if (path === "/oauth/token") {
    const f = new URLSearchParams(body.toString());
    const c = ic.codes.get(f.get("code"));
    if (f.get("client_secret") !== "ic-secret" || !c || c.redirect !== f.get("redirect_uri") || s256(f.get("code_verifier") ?? "") !== c.challenge) return send(400, { error: "invalid_grant" });
    ic.codes.delete(f.get("code"));
    ic.token = `ic-at-${randomUUID()}`;
    return send(200, { access_token: ic.token, refresh_token: "ic-rt", expires_in: 3600 });
  }
  if (req.headers.authorization !== `Bearer ${ic.token}`) return send(401, { message: "unauthorized" });
  let m;
  if (path === "/public/api/v1/workflows") return send(200, { list: Object.values(ic.workflows).map((w) => ({ id: w.id, title: w.title, step: w.step })) });
  if ((m = path.match(/^\/public\/api\/v1\/workflows\/(\w+)\/document\/(\w+)\/download$/))) return send(200, tinyPdf("Contrato marco Globex (Ironclad)"));
  if ((m = path.match(/^\/public\/api\/v1\/workflows\/(\w+)\/upload-signed$/)) && req.method === "POST") {
    const p = parts(req, body);
    ic.signed.push({ id: m[1], pdf: p.attachment?.text.startsWith("%PDF"), filename: p.attachment?.filename });
    ic.workflows[m[1]].step = "Archive";
    return send(200, { key: "signed1" });
  }
  if ((m = path.match(/^\/public\/api\/v1\/workflows\/(\w+)$/))) return ic.workflows[m[1]] ? send(200, ic.workflows[m[1]]) : send(404, { message: "not found" });
  send(404, { message: `ironclad mock: ${req.method} ${path}` });
});

// Juro (x-api-key)
const juro = { uploads: [] };
await serve(P.juro, async ({ req, url, body, send }) => {
  const path = url.pathname.replace(/^\/v3/, "");
  if (req.headers["x-api-key"] !== "juro-key-123456") return send(401, { message: "invalid api key" });
  if (path === "/contracts") return send(200, { contracts: [{ id: "jc1", name: "NDA Initech", state: "draft" }] });
  if (path === "/contracts/jc1") return send(200, { contract: { id: "jc1", name: "NDA Initech", fields: [{ title: "Plazo", value: "12 meses" }], signingSides: [{ name: "Initech", signatories: [{ name: "Ivo Initech JU", email: "ivo.ju@initech.test" }] }] } });
  if (path === "/contracts/jc1/pdf/binary") return send(200, tinyPdf("NDA Initech (Juro)"));
  if (path === "/contracts/upload" && req.method === "POST") {
    const p = parts(req, body);
    juro.uploads.push({ name: p.name?.text, pdf: p.file?.text.startsWith("%PDF") });
    return send(201, { contract: { id: `jc-signed-${juro.uploads.length}` } });
  }
  send(404, { message: `juro mock: ${req.method} ${path}` });
});

// Box (OAuth) — API y subida en el mismo simulador
const box = { codes: new Set(), token: null, folders: { 0: { name: "root", children: {} } }, nextId: 1000, files: [] };
await serve(P.box, async ({ req, url, body, json, send }) => {
  const path = url.pathname;
  if (path === "/authorize") {
    const code = `box-${randomUUID()}`;
    box.codes.add(code);
    return send(302, undefined, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
  }
  if (path === "/oauth2/token") {
    const f = new URLSearchParams(body.toString());
    if (f.get("client_secret") !== "box-secret" || !box.codes.delete(f.get("code"))) return send(400, { error: "invalid_grant" });
    box.token = `box-at-${randomUUID()}`;
    return send(200, { access_token: box.token, refresh_token: "box-rt", expires_in: 3600 });
  }
  if (req.headers.authorization !== `Bearer ${box.token}`) return send(401, { type: "error", code: "unauthorized" });
  if (path === "/2.0/users/me") return send(200, { login: "admin@acme.box.test", name: "Admin" });
  if (path === "/2.0/folders" && req.method === "POST") {
    const { name, parent } = json();
    const par = box.folders[parent.id];
    if (par.children[name]) return send(409, { type: "error", code: "item_name_in_use", context_info: { conflicts: [{ id: par.children[name], type: "folder" }] } });
    const id = String(box.nextId++);
    box.folders[id] = { name, children: {} };
    par.children[name] = id;
    return send(201, { id, type: "folder", name });
  }
  if (path === "/api/2.0/files/content" && req.method === "POST") {
    const p = parts(req, body);
    const attrs = JSON.parse(p.attributes.text);
    box.files.push({ name: attrs.name, parent: attrs.parent.id, pdf: p.file.text.startsWith("%PDF"), evidence: p.file.text.includes("calasign.evidence-certificate") });
    return send(201, { total_count: 1, entries: [{ id: `f${box.files.length}`, type: "file", name: attrs.name }] });
  }
  send(404, { message: `box mock: ${req.method} ${path}` });
});

// Microsoft (login + Graph) para SharePoint
const ms = { codes: new Set(), token: null, uploads: [] };
await serve(P.ms, async ({ req, url, body, send }) => {
  const path = decodeURIComponent(url.pathname);
  if (path === "/common/oauth2/v2.0/authorize") {
    if (!url.searchParams.get("scope").includes("Sites.ReadWrite.All")) return send(400, { error: "invalid_scope" });
    const code = `ms-${randomUUID()}`;
    ms.codes.add(code);
    return send(302, undefined, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
  }
  if (path === "/common/oauth2/v2.0/token") {
    const f = new URLSearchParams(body.toString());
    if (f.get("client_secret") !== "ms-secret" || !ms.codes.delete(f.get("code"))) return send(400, { error: "invalid_grant" });
    ms.token = `ms-at-${randomUUID()}`;
    return send(200, { access_token: ms.token, refresh_token: "ms-rt", expires_in: 3600 });
  }
  if (req.headers.authorization !== `Bearer ${ms.token}`) return send(401, { error: { code: "InvalidAuthenticationToken" } });
  if (path === "/v1.0/me") return send(200, { mail: "legal@acme.onmicrosoft.test" });
  if (path === "/v1.0/sites/127.0.0.1:/sites/Legal") return send(200, { id: "site-legal", webUrl: "https://acme.sharepoint.test/sites/Legal" });
  if (path === "/v1.0/sites/site-legal/drives") return send(200, { value: [{ id: "drive-docs", name: "Documentos" }, { id: "drive-rrhh", name: "Contratos RRHH" }] });
  let m;
  if ((m = path.match(/^\/v1\.0\/drives\/([\w-]+)\/root:\/(.+):\/content$/)) && req.method === "PUT") {
    ms.uploads.push({ drive: m[1], path: m[2], type: req.headers["content-type"], pdf: body.subarray(0, 5).toString() === "%PDF-", evidence: body.toString().includes("calasign.evidence-certificate") });
    return send(201, { id: `it${ms.uploads.length}`, webUrl: `https://acme.sharepoint.test/${encodeURI(m[2])}` });
  }
  send(404, { error: { message: `ms mock: ${req.method} ${path}` } });
});

// ───────────────────────────── API propia ─────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "calasign-conn-e2e-"));
const api_ = spawn(join(ROOT, "apps/api/node_modules/.bin/tsx"), [join(ROOT, "scripts/e2e-api-entry.mts")], {
  cwd: join(ROOT, "apps/api"),
  env: {
    ...process.env,
    NODE_ENV: "development",
    APP_ENV: "local",
    PORT: String(PORT),
    HOST: "127.0.0.1",
    APP_URL: BASE,
    DATA_DIR: dataDir,
    DATABASE_URL: "",
    LOG_LEVEL: "warn",
    TSA_URL: "",
    BAMBOOHR_API_BASE: `http://127.0.0.1:${P.bamboo}/api/gateway.php/{company}/v1`,
    IRONCLAD_BASE: `http://127.0.0.1:${P.ironclad}`,
    IRONCLAD_CLIENT_ID: "ic-client",
    IRONCLAD_CLIENT_SECRET: "ic-secret",
    JURO_API_BASE: `http://127.0.0.1:${P.juro}/v3`,
    BOX_CLIENT_ID: "box-client",
    BOX_CLIENT_SECRET: "box-secret",
    BOX_API_BASE: `http://127.0.0.1:${P.box}`,
    BOX_UPLOAD_BASE: `http://127.0.0.1:${P.box}`,
    BOX_AUTHORIZE_URL: `http://127.0.0.1:${P.box}/authorize`,
    MS_CLIENT_ID: "ms-client",
    MS_CLIENT_SECRET: "ms-secret",
    MS_LOGIN_BASE: `http://127.0.0.1:${P.ms}`,
    MS_GRAPH_BASE: `http://127.0.0.1:${P.ms}/v1.0`,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const cleanup = () => {
  try {
    api_.kill("SIGTERM");
  } catch {}
  if (process.env.E2E_KEEP_DATA !== "1") {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
};
process.on("exit", cleanup);
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) process.on(sig, () => process.exit(128 + n));
process.on("uncaughtException", (e) => {
  console.error(e);
  cleanup();
  process.exit(1);
});
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await sleep(500);
}

let cookie = "";
async function api(method, path, body, opts = {}) {
  const h = { ...(opts.headers ?? {}) };
  if (cookie) h.cookie = cookie;
  let payload = body;
  if (body && !(body instanceof FormData) && typeof body !== "string") {
    h["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: "manual" });
  const set = res.headers.get("set-cookie");
  if (set && /^(__Host-)?cs_session=/.test(set)) cookie = set.split(";")[0];
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  const expect = opts.expect ?? [200, 201, 202, 204];
  if (!(Array.isArray(expect) ? expect : [expect]).includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return data;
}
async function waitFor(fn, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(400);
  }
  throw new Error(`timeout esperando: ${what}`);
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
async function signAll(envelopeId, names) {
  for (const name of names) {
    const link = await waitFor(async () => {
      const { items } = await api("GET", "/dev/mailbox");
      return items.find((x) => x.text.includes(name) && x.link?.includes("/s/"))?.link;
    }, `invitación de ${name}`);
    const token = link.split("/s/")[1];
    let sess = await api("GET", `/v1/signing/${token}`);
    await api("POST", `/v1/signing/${token}/consent`);
    const fields = sess.fields.filter((f) => ["text", "number"].includes(f.type) && !f.readOnly).map((f) => ({ id: f.id, value: f.value ?? "x" }));
    sess = await api("POST", `/v1/signing/${token}/complete`, { fields, signature: { kind: "drawn", imagePng: PNG } });
    assert(sess.recipient.status === "signed", `${name} firmó`);
  }
  await waitFor(async () => (await api("GET", `/v1/envelopes/${envelopeId}`)).envelope.status === "completed", "sobre completado");
}
async function oauthDance(startPath, body, callbackPrefix, okMarker) {
  const { authorizeUrl } = await api("POST", startPath, body);
  const r1 = await fetch(authorizeUrl, { redirect: "manual" });
  const cb = r1.headers.get("location");
  assert(cb?.startsWith(`${BASE}${callbackPrefix}`), `el proveedor vuelve al callback (${cb ?? r1.status})`);
  const r2 = await fetch(cb, { headers: { cookie }, redirect: "manual" });
  const loc = r2.headers.get("location") ?? "";
  assert(loc.includes(okMarker), `callback conecta (${loc})`);
}
async function template(name, roles, extraFields = []) {
  const { template: t } = await api("POST", "/v1/templates", { name, subject: name });
  const fd = new FormData();
  fd.append("file", new Blob([tinyPdf(name)], { type: "application/pdf" }), "plantilla.pdf");
  const doc = await api("POST", `/v1/templates/${t.id}/documents`, fd);
  const ids = roles.map(() => randomUUID());
  await api("PUT", `/v1/templates/${t.id}/roles`, { roles: roles.map((r, i) => ({ id: ids[i], name: r, role: "signer", routingOrder: i + 1 })) });
  await api("PUT", `/v1/templates/${t.id}/fields`, {
    fields: [
      ...roles.map((_, i) => ({ documentId: doc.id, roleId: ids[i], type: "signature", page: 0, x: 0.1 + i * 0.45, y: 0.7, width: 0.3, height: 0.08 })),
      ...extraFields.map((f) => ({ documentId: doc.id, roleId: ids[0], type: "text", page: 0, x: 0.1, y: 0.2, width: 0.3, height: 0.03, label: f })),
    ],
  });
  return t;
}

// ───────────────────────────── Escenario ─────────────────────────────

const stamp = Date.now();
await api("POST", "/v1/auth/signup", { name: "Admin Conectores", email: `conn+${stamp}@example.com`, password: "una-clave-segura-123", organization: `Conectores ${stamp}` });

const prov = await api("GET", "/v1/connectors/providers");
const byP = Object.fromEntries(prov.items.map((p) => [p.provider, p]));
assert(byP.ironclad.oauthConfigured && !byP.factorial.oauthConfigured && byP.bamboohr.category === "hris" && byP.juro.category === "clm", "proveedores");
assert(prov.redirectUris.ironclad === `${BASE}/v1/connectors/oauth/ironclad/callback`, "redirect URI de Ironclad");
step("proveedores: 3 HRIS + 2 CLM; OAuth configurado para Ironclad");

// ── DMS: Box y SharePoint con certificado de evidencia ──
await oauthDance("/v1/storage/oauth/box/start", { name: "Box RRHH", folder: "CalaSign/RRHH", includeEvidence: true }, "/v1/storage/oauth/box/callback", "connected=box");
await api("POST", "/v1/storage/oauth/sharepoint/start", { name: "SP sin sitio" }, { expect: 400 });
await oauthDance(
  "/v1/storage/oauth/sharepoint/start",
  { name: "SharePoint Legal", siteUrl: `http://127.0.0.1:${P.ms}/sites/Legal/Shared%20Documents/Forms/AllItems.aspx`, library: "Contratos RRHH", folder: "Firmados/2026", includeEvidence: true },
  "/v1/storage/oauth/sharepoint/callback",
  "connected=sharepoint",
);
const stConns = (await api("GET", "/v1/storage/connections")).items;
const spConn = stConns.find((c) => c.provider === "sharepoint");
assert(spConn?.accountLabel === "legal@acme.onmicrosoft.test" && spConn.includeEvidence && spConn.target.includes("Contratos RRHH"), `conexión SharePoint (${JSON.stringify(spConn)})`);
assert(stConns.find((c) => c.provider === "box")?.accountLabel === "admin@acme.box.test", "conexión Box");
step("DMS: Box y SharePoint por OAuth (sitio y biblioteca resueltos con Graph), con certificado de evidencia");

// ── HRIS: BambooHR ──
const tplHr = await template(`Contrato laboral ${stamp}`, ["Empleado", "Jefe"], ["Cargo"]);
await api("POST", "/v1/connectors/connections", { provider: "bamboohr", name: "x", credentials: { companyDomain: "acme", apiKey: "clave-mala-123" } }, { expect: 400 });
await api("POST", "/v1/connectors/connections", { provider: "bamboohr", name: "x", credentials: { companyDomain: "acme/../evil", apiKey: bamboo.key } }, { expect: 400 });
const bConn = await api("POST", "/v1/connectors/connections", { provider: "bamboohr", name: "BambooHR ACME", credentials: { companyDomain: "https://acme.bamboohr.com", apiKey: bamboo.key } });
assert(bConn.accountLabel === "acme.bamboohr.com" && bConn.webhookUrl.startsWith(`${BASE}/v1/integrations/connectors/hook/cshk_`), "conexión BambooHR con URL de webhook");
const found = await api("GET", `/v1/connectors/connections/${bConn.id}/records?q=lucía`);
assert(found.items.length === 1 && found.items[0].id === "101", "búsqueda de empleados");
step("BambooHR: clave inválida y dominio raro rechazados; conexión probada; búsqueda de empleados");

await api("POST", "/v1/connectors/flows", { connectionId: bConn.id, name: "x", objectType: "workflow", templateId: tplHr.id }, { expect: 400 });
const onboarding = await api("POST", "/v1/connectors/flows", {
  connectionId: bConn.id,
  name: "Onboarding",
  objectType: "employee",
  templateId: tplHr.id,
  roles: [
    { role: "Empleado", source: "contact", index: 0 },
    { role: "Jefe", source: "contact_role", contactRole: "manager" },
  ],
  prefill: [{ field: "Cargo", property: "jobTitle" }],
  writeBack: { uploadSigned: true, uploadEvidence: true, statusProperty: "customCalaSign", statusValues: { completed: "Firmado" } },
});
const sent = await api("POST", `/v1/connectors/flows/${onboarding.id}/send`, { recordId: "101" });
const det = await api("GET", `/v1/envelopes/${sent.envelopeId}`);
assert(det.recipients.some((r) => r.name === "Lucía Gómez HR" && r.email === "lucia.hr@acme.test"), "empleado como firmante");
assert(det.recipients.some((r) => r.name === "Marta Jefa HR"), "jefe (supervisor) como firmante");
assert(det.fields.some((f) => f.label === "Cargo" && f.value === "Analista contable"), "cargo prellenado");
assert(det.envelope.metadata.connector?.objectId === "101", "metadata del sobre con el empleado");
await waitFor(() => bamboo.employees[101].customCalaSign === "sent", "estado sent en BambooHR");
step("BambooHR: sobre desde el empleado 101 (empleado + jefe, cargo prellenado) y estado «sent»");

await signAll(sent.envelopeId, ["Lucía Gómez HR", "Marta Jefa HR"]);
await waitFor(() => bamboo.files.length === 2 && bamboo.employees[101].customCalaSign === "Firmado", "PDF + evidencia al legajo");
assert(bamboo.files.every((f) => f.employee === "101" && f.category === "17" && f.share === "no"), "categoría del legajo y sin compartir");
assert(bamboo.files.some((f) => f.pdf) && bamboo.files.some((f) => f.evidence), "PDF sellado y certificado de evidencia");
step("BambooHR: firmado → PDF sellado y certificado de evidencia en el legajo, estado «Firmado»");

await waitFor(() => box.files.filter((f) => f.pdf).length >= 1 && box.files.some((f) => f.evidence), "Box: PDF + evidencia");
const boxFolder = box.folders[0].children.CalaSign && box.folders[box.folders[0].children.CalaSign].children.RRHH;
assert(boxFolder && box.files.every((f) => f.parent === boxFolder), "Box: dentro de CalaSign/RRHH");
await waitFor(() => ms.uploads.filter((u) => u.drive === "drive-rrhh").length >= 2, "SharePoint: PDF + evidencia");
assert(ms.uploads.some((u) => u.path.startsWith("Firmados/2026/") && u.pdf) && ms.uploads.some((u) => u.evidence && u.type === "application/json"), "SharePoint: carpeta y tipos");
step("DMS: el firmado (y su evidencia) archivados en Box (carpeta anidada creada) y en la biblioteca de SharePoint");

// ── Webhook de BambooHR ──
const hookFlow = await api("POST", "/v1/connectors/flows", {
  connectionId: bConn.id,
  name: "Alta de empleado",
  objectType: "employee",
  templateId: tplHr.id,
  roles: [
    { role: "Empleado", source: "contact", index: 0 },
    { role: "Jefe", source: "fixed", name: `RRHH Fijo ${stamp}`, email: `rrhh+${stamp}@acme.test` },
  ],
  trigger: "webhook",
  triggerConfig: { event: "Created" },
});
const bad = await fetch(`${BASE}/v1/integrations/connectors/hook/cshk_nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert(bad.status === 404, "token de webhook inválido → 404");
const hookBody = JSON.stringify({ employees: [{ id: "102", action: "Created", changedFields: [] }] });
for (let i = 0; i < 2; i++) {
  const r = await fetch(bConn.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: hookBody });
  assert(r.status === 200, `webhook aceptado (${r.status})`);
}
await fetch(bConn.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employees: [{ id: "102", action: "Updated" }] }) });
const hookRun = await waitFor(async () => (await api("GET", "/v1/connectors/runs")).items.find((r) => r.flowId === hookFlow.id && r.status === "succeeded" && r.envelopeId), "envío por webhook");
const hookRuns = (await api("GET", "/v1/connectors/runs")).items.filter((r) => r.flowId === hookFlow.id && r.kind === "send");
assert(hookRuns.length === 1 && hookRun.objectId === "102", `un solo envío por evento repetido y filtrado por evento (${JSON.stringify(hookRuns.map((r) => [r.event, r.status, r.detail, r.error]))})`);
step("BambooHR: webhook (URL secreta) dispara el alta del empleado 102; repetido no duplica; otro evento no dispara");

// Secreto HMAC opcional del flujo: sin firma (o con otra) no dispara; firmado con X-CalaSign-Signature sí.
const hookSecret = `whsec-${stamp}-0123456789`;
const signedFlow = await api("PATCH", `/v1/connectors/flows/${hookFlow.id}`, { webhookSecret: hookSecret });
assert(signedFlow.webhookSigned === true && !("webhookSecret" in signedFlow), "flujo con secreto (no se devuelve)");
const sigBody = JSON.stringify({ employees: [{ id: "102", action: "Created", changedFields: ["firma"] }] });
const unsigned = await fetch(bConn.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: sigBody });
assert(unsigned.status === 401, `webhook sin firma → 401 (${unsigned.status})`);
const wrongSig = await fetch(bConn.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-calasign-signature": `sha256=${"0".repeat(64)}` }, body: sigBody });
assert(wrongSig.status === 401, "firma incorrecta → 401");
const signed = await fetch(bConn.webhookUrl, {
  method: "POST",
  headers: { "content-type": "application/json", "x-calasign-signature": `sha256=${createHmac("sha256", hookSecret).update(sigBody).digest("hex")}` },
  body: sigBody,
});
assert(signed.status === 200 && (await signed.json()).queued === 1, "firmado → encolado");
assert((await api("PATCH", `/v1/connectors/flows/${hookFlow.id}`, { webhookSecret: null })).webhookSigned === false, "secreto quitado");
step("Webhook con secreto por flujo: sin firma o con otra → 401; con X-CalaSign-Signature (HMAC-SHA256 del cuerpo) se encola");

// ── CLM: Ironclad con documento de origen ──
await oauthDance("/v1/connectors/oauth/ironclad/start", { name: "Ironclad Legal" }, "/v1/connectors/oauth/ironclad/callback", "connected=ironclad");
const icConn = (await api("GET", "/v1/connectors/connections")).items.find((c) => c.provider === "ironclad");
assert(icConn?.authType === "oauth", "conexión Ironclad por OAuth (PKCE verificado por el simulador)");
const tplSig = await template(`Hoja de firmas ${stamp}`, ["Contraparte"]);
await api("POST", "/v1/connectors/flows", { connectionId: bConn.id, name: "x", objectType: "employee", templateId: tplSig.id, documentSource: "record" }, { expect: 400 });
const icFlow = await api("POST", "/v1/connectors/flows", {
  connectionId: icConn.id,
  name: "Firma de workflows",
  objectType: "workflow",
  templateId: tplSig.id,
  documentSource: "record",
  roles: [{ role: "Contraparte", source: "contact_role", primary: true }],
});
const icSent = await api("POST", `/v1/connectors/flows/${icFlow.id}/send`, { recordId: "wf1" });
const icDet = await api("GET", `/v1/envelopes/${icSent.envelopeId}`);
assert(icDet.documents.length === 2 && icDet.documents[0].name === "MSA Globex.pdf", `documento de Ironclad primero (${icDet.documents.map((x) => x.name)})`);
assert(icDet.recipients[0].email === "gina.ic@globex.test", "contraparte desde los atributos del workflow");
await signAll(icSent.envelopeId, ["Gina Globex IC"]);
await waitFor(() => ic.signed.length === 1 && ic.signed[0].pdf && ic.workflows.wf1.step === "Archive", "upload-signed en Ironclad");
step("Ironclad: OAuth+PKCE, contrato del workflow + hoja de firmas, firmado devuelto con upload-signed (avanza el paso)");

// ── CLM: Juro ──
const jConn = await api("POST", "/v1/connectors/connections", { provider: "juro", name: "Juro", credentials: { apiKey: "juro-key-123456" } });
const jFlow = await api("POST", "/v1/connectors/flows", {
  connectionId: jConn.id,
  name: "NDA Juro",
  objectType: "contract",
  templateId: tplSig.id,
  documentSource: "record",
  roles: [{ role: "Contraparte", source: "contact", index: 0 }],
});
const jSent = await api("POST", `/v1/connectors/flows/${jFlow.id}/send`, { recordId: "jc1" });
await signAll(jSent.envelopeId, ["Ivo Initech JU"]);
await waitFor(() => juro.uploads.length === 1 && juro.uploads[0].pdf, "copia firmada subida a Juro");
step("Juro: contrato y firmantes desde Juro; copia firmada subida");

// ── Credenciales revocadas ──
bamboo.revoked = true;
const e409 = await api("POST", `/v1/connectors/flows/${onboarding.id}/send`, { recordId: "101" }, { expect: 409 });
assert(e409.error.code === "connector_reauth_required", "clave revocada → connector_reauth_required");
const conns = (await api("GET", "/v1/connectors/connections")).items;
assert(conns.find((c) => c.id === bConn.id).lastError, "la conexión muestra el error");
const rotated = await api("POST", `/v1/connectors/connections/${bConn.id}/rotate-webhook`);
assert(rotated.webhookUrl !== bConn.webhookUrl && (await fetch(bConn.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 404, "URL de webhook regenerada");
step("BambooHR revocado → 409 connector_reauth_required y error visible; URL de webhook regenerada");

console.log("\nE2E conectores OK");
cleanup();
process.exit(0);
