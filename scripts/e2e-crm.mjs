#!/usr/bin/env node
// Prueba de punta a punta de CRM/ERP (HubSpot, Salesforce, Zoho CRM / Bigin, Siigo, Alegra) contra servidores simulados.
// Es autocontenida: levanta los simuladores y su propia API (puerto 4115) con las URLs de los proveedores
// apuntando a ellos. Uso: node scripts/e2e-crm.mjs   (un argumento de URL se ignora)
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.E2E_CRM_PORT ?? 4115);
const BASE = `http://localhost:${PORT}`;
// Puertos de los simuladores (E2E_CRM_MOCK_BASE para evitar choques con otras pruebas en paralelo).
const MB = Number(process.env.E2E_CRM_MOCK_BASE ?? 4291);
// Zoho: zo = servidor de cuentas "US" donde se inicia OAuth; zoEu = centro de datos de la cuenta (cuentas + API).
const P = { hs: MB, sf: MB + 1, sg: MB + 2, al: MB + 3, zo: MB + 4, zoEu: MB + 5 };
const HS_SECRET = "hs-client-secret-e2e";
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

// HubSpot
const hs = {
  token: null, // vigente
  tokens: 0,
  refreshes: 0,
  revoked: false,
  codes: new Map(),
  deals: {
    "9001": { amount: "1500.50", dealname: "Renovación ACME", dealstage: "appointmentscheduled", contacts: ["c1"] },
    "9002": { amount: "980", dealname: "Alta Beta", dealstage: "appointmentscheduled", contacts: ["c2"] },
    "9003": { amount: "120", dealname: "Gamma en ráfaga", dealstage: "appointmentscheduled", contacts: ["c2"] },
    "9004": { amount: "50", dealname: "Delta correo roto", dealstage: "appointmentscheduled", contacts: ["c3"] },
  },
  contacts: { c1: { firstname: "Ana", lastname: "Pérez HS", email: "ana.hs@cliente.test", phone: "+573001112233" }, c2: { firstname: "Bruno", lastname: "Beta HS", email: "bruno.hs@cliente.test" }, c3: { firstname: "Dora", lastname: "Delta HS", email: "dora@" } },
  files: [],
  notes: [],
  expire() {
    this.token = "expired";
  },
};
function hsIssue() {
  hs.tokens++;
  hs.token = `hs-at-${hs.tokens}`;
  return { access_token: hs.token, refresh_token: "hs-rt", expires_in: 1800, token_type: "bearer" };
}
await serve(P.hs, async ({ req, url, body, json, send }) => {
  const path = url.pathname;
  if (path === "/oauth/authorize") {
    const code = `hs-code-${randomUUID()}`;
    hs.codes.set(code, url.searchParams.get("redirect_uri"));
    return send(302, undefined, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
  }
  if (path === "/oauth/v1/token") {
    const f = new URLSearchParams(body.toString());
    if (f.get("client_secret") !== HS_SECRET) return send(401, { error: "invalid_client" });
    if (f.get("grant_type") === "authorization_code") {
      if (!hs.codes.has(f.get("code")) || hs.codes.get(f.get("code")) !== f.get("redirect_uri")) return send(400, { error: "invalid_grant" });
      hs.codes.delete(f.get("code"));
      return send(200, hsIssue());
    }
    if (f.get("grant_type") === "refresh_token") {
      if (hs.revoked || f.get("refresh_token") !== "hs-rt") return send(400, { error: "invalid_grant", error_description: "refresh token revoked" });
      hs.refreshes++;
      return send(200, hsIssue());
    }
    return send(400, { error: "unsupported_grant_type" });
  }
  if (path.startsWith("/oauth/v1/access-tokens/")) return send(200, { hub_id: 777, hub_domain: "acme.hubspot.test", user: "admin@acme.test" });
  const auth = req.headers.authorization ?? "";
  if (hs.revoked || auth !== `Bearer ${hs.token}`) return send(401, { status: "error", message: "The access token provided is expired or invalid" });
  let m;
  if ((m = path.match(/^\/crm\/v3\/objects\/deals\/(\w+)$/))) {
    const d = hs.deals[m[1]];
    if (!d) return send(404, { message: "deal not found" });
    if (req.method === "PATCH") {
      Object.assign(d, json().properties);
      return send(200, { id: m[1], properties: d });
    }
    const { contacts, ...properties } = d;
    return send(200, { id: m[1], properties, associations: { contacts: { results: contacts.map((id) => ({ id, type: "deal_to_contact" })) } } });
  }
  if (path === "/crm/v3/objects/contacts/batch/read") {
    return send(200, { results: json().inputs.map(({ id }) => ({ id, properties: hs.contacts[id] })) });
  }
  if (path === "/files/v3/files" && req.method === "POST") {
    const raw = body.toString("latin1");
    hs.files.push({ size: body.length, pdf: raw.includes("%PDF"), folder: raw.includes("/CalaSign") });
    return send(201, { id: `f${hs.files.length}` });
  }
  if (path === "/crm/v3/objects/notes" && req.method === "POST") {
    const n = json();
    hs.notes.push(n);
    return send(201, { id: `n${hs.notes.length}` });
  }
  send(404, { message: `hubspot mock: ${req.method} ${path}` });
});

// Salesforce
const sf = {
  token: null,
  tokens: 0,
  refreshes: 0,
  challenges: new Map(),
  expireOnNextData: false,
  opps: { "006A1": { Name: "Contrato Gamma", Amount: 2500, CloseDate: "2026-12-01" } },
  roles: { "006A1": [{ ContactId: "003X", Role: "Decision Maker", IsPrimary: true, Contact: { Name: "Carla Gamma SF", Email: "carla.sf@cliente.test", MobilePhone: null } }] },
  versions: [],
};
function sfIssue() {
  sf.tokens++;
  sf.token = `sf-at-${sf.tokens}`;
  return { access_token: sf.token, refresh_token: "sf-rt", instance_url: `http://127.0.0.1:${P.sf}`, id: "https://login/id/00D/005", token_type: "Bearer", issued_at: String(Date.now()) };
}
await serve(P.sf, async ({ req, url, body, json, send }) => {
  const path = url.pathname;
  if (path === "/services/oauth2/authorize") {
    if (url.searchParams.get("code_challenge_method") !== "S256") return send(400, { error: "pkce_required" });
    const code = `sf-code-${randomUUID()}`;
    sf.challenges.set(code, url.searchParams.get("code_challenge"));
    return send(302, undefined, { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state"))}` });
  }
  if (path === "/services/oauth2/token") {
    const f = new URLSearchParams(body.toString());
    if (f.get("grant_type") === "authorization_code") {
      const ch = sf.challenges.get(f.get("code"));
      if (!ch || s256(f.get("code_verifier") ?? "") !== ch) return send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      sf.challenges.delete(f.get("code"));
      return send(200, sfIssue());
    }
    if (f.get("grant_type") === "refresh_token" && f.get("refresh_token") === "sf-rt") {
      sf.refreshes++;
      return send(200, sfIssue());
    }
    return send(400, { error: "invalid_grant" });
  }
  if ((req.headers.authorization ?? "") !== `Bearer ${sf.token}` || (sf.expireOnNextData && path.includes("/sobjects/"))) {
    sf.expireOnNextData = false;
    sf.token = "expired";
    return send(401, [{ errorCode: "INVALID_SESSION_ID", message: "Session expired or invalid" }]);
  }
  let m;
  if (path === "/services/data/v60.0/limits") return send(200, { DailyApiRequests: { Max: 15000, Remaining: 14999 } });
  if ((m = path.match(/^\/services\/data\/v60\.0\/sobjects\/Opportunity\/(\w+)$/))) {
    const o = sf.opps[m[1]];
    if (!o) return send(404, [{ errorCode: "NOT_FOUND" }]);
    if (req.method === "PATCH") {
      Object.assign(o, json());
      return send(204);
    }
    return send(200, { attributes: { type: "Opportunity" }, Id: m[1], ...o });
  }
  if (path === "/services/data/v60.0/query") {
    const q = url.searchParams.get("q");
    const id = q.match(/OpportunityId = '(\w+)'/)?.[1];
    return send(200, { totalSize: 1, done: true, records: sf.roles[id] ?? [] });
  }
  if (path === "/services/data/v60.0/sobjects/ContentVersion" && req.method === "POST") {
    const v = json();
    sf.versions.push({ link: v.FirstPublishLocationId, title: v.Title, pdf: Buffer.from(v.VersionData, "base64").subarray(0, 5).toString() === "%PDF-" });
    return send(201, { id: `068V${sf.versions.length}`, success: true });
  }
  send(404, [{ errorCode: "NOT_FOUND", message: `salesforce mock: ${req.method} ${path}` }]);
});

// Siigo
const sg = { failNextPut: 1, puts: [], customers: { "cust-1": { id: "cust-1", identification: "900123456", name: ["ACME S.A.S."], comments: "Cliente VIP", metadata: { created: "x" } } } };
await serve(P.sg, async ({ req, url, json, send }) => {
  const path = url.pathname;
  if (!req.headers["partner-id"]) return send(400, { Errors: [{ Message: "Partner-Id requerido" }] });
  if (path === "/auth") {
    const b = json();
    if (b.username !== "api@acme.test" || b.access_key !== "siigo-access-key") return send(401, { Errors: [{ Message: "invalid credentials" }] });
    return send(200, { access_token: "sg-token", expires_in: 86400, token_type: "Bearer" });
  }
  if (req.headers.authorization !== "Bearer sg-token") return send(401, { Errors: [{ Message: "unauthorized" }] });
  if (path === "/v1/customers") {
    const id = url.searchParams.get("identification");
    return send(200, { pagination: {}, results: id ? Object.values(sg.customers).filter((c) => c.identification === id) : [] });
  }
  let m;
  if ((m = path.match(/^\/v1\/customers\/([\w-]+)$/))) {
    const c = sg.customers[m[1]];
    if (!c) return send(404, { Errors: [{ Message: "not found" }] });
    if (req.method === "PUT") {
      if (sg.failNextPut-- > 0) return send(500, { Errors: [{ Message: "temporal" }] });
      const b = json();
      sg.puts.push(b);
      Object.assign(c, b);
      return send(200, c);
    }
    return send(200, c);
  }
  send(404, { Errors: [{ Message: `siigo mock: ${req.method} ${path}` }] });
});

// Alegra
const al = { revoked: false, attachments: [] };
await serve(P.al, async ({ req, url, body, send }) => {
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const ok = req.headers.authorization === `Basic ${Buffer.from("admin@acme.test:alegra-token").toString("base64")}`;
  if (!ok || al.revoked) return send(401, { message: "Unauthorized", code: 401 });
  if (path === "/contacts") {
    const id = url.searchParams.get("identification");
    return send(200, id === "79123456" ? [{ id: 55, name: "Diego Delta", identification: "79123456" }] : []);
  }
  let m;
  if ((m = path.match(/^\/(invoices|contacts)\/(\w+)\/attachment$/)) && req.method === "POST") {
    al.attachments.push({ kind: m[1], id: m[2], pdf: body.toString("latin1").includes("%PDF") });
    return send(201, { id: al.attachments.length, name: "documento.pdf" });
  }
  send(404, { message: `alegra mock: ${req.method} ${path}` });
});

// Zoho CRM y Bigin. La cuenta vive en el centro de datos "EU" (P.zoEu): el authorize se inicia en el "US" (P.zo) y
// Zoho vuelve con accounts-server apuntando al EU, donde hay que canjear el código y refrescar.
const zo = {
  valid: new Set(),
  tokens: 0,
  refreshes: 0,
  revoked: false,
  codes: new Map(),
  deals: { z1: { Deal_Name: "Renovación Zoho", Amount: 3200, Stage: "Negotiation", Contact_Name: { id: "zc1", name: "Zoe Zoho" } } },
  pipelines: { b1: { Deal_Name: "Bigin Beta", Amount: 410, Contact_Name: { id: "zc3", name: "Bea Bigin" } } },
  contacts: {
    zc1: { First_Name: "Zoe", Last_Name: "Zoho", Full_Name: "Zoe Zoho", Email: "zoe.zoho@cliente.test", Mobile: "+573004445566" },
    zc2: { First_Name: "Raúl", Last_Name: "Roles", Full_Name: "Raúl Roles", Email: "raul.legal@cliente.test" },
    zc3: { First_Name: "Bea", Last_Name: "Bigin", Full_Name: "Bea Bigin", Email: "bea.bigin@cliente.test" },
  },
  roles: { z1: [{ id: "zc2", Full_Name: "Raúl Roles", Email: "raul.legal@cliente.test", Contact_Role: { id: "r1", name: "Legal" } }, { id: "zc1", Full_Name: "Zoe Zoho", Email: "zoe.zoho@cliente.test", Contact_Role: { id: "r2", name: "Decision Maker" } }] },
  puts: [],
  attachments: [],
  notes: [],
  expire() {
    this.valid.clear();
  },
};
function zoIssue(withRefresh) {
  zo.tokens++;
  const t = `zo-at-${zo.tokens}`;
  zo.valid.add(t);
  return { access_token: t, ...(withRefresh ? { refresh_token: "zo-rt" } : {}), api_domain: `http://127.0.0.1:${P.zoEu}`, token_type: "Bearer", expires_in: 3600 };
}
await serve(P.zo, async ({ url, send }) => {
  if (url.pathname === "/oauth/v2/auth") {
    const q = url.searchParams;
    if (q.get("code_challenge_method") !== "S256" || q.get("access_type") !== "offline" || q.get("response_type") !== "code") return send(400, { error: "bad_request" });
    const code = `zo-code-${randomUUID()}`;
    zo.codes.set(code, { challenge: q.get("code_challenge"), redirect: q.get("redirect_uri"), scope: q.get("scope") });
    const cb = new URL(q.get("redirect_uri"));
    cb.searchParams.set("code", code);
    cb.searchParams.set("state", q.get("state"));
    cb.searchParams.set("location", "eu");
    cb.searchParams.set("accounts-server", `http://127.0.0.1:${P.zoEu}`);
    return send(302, undefined, { location: cb.toString() });
  }
  // El DC donde se inició no conoce el código (la cuenta está en el EU): Zoho responde 200 con error.
  if (url.pathname === "/oauth/v2/token") return send(200, { error: "invalid_code" });
  send(404, { code: "INVALID_URL_PATTERN" });
});
await serve(P.zoEu, async ({ req, url, body, json, send }) => {
  const path = url.pathname;
  if (path === "/oauth/v2/token") {
    const f = new URLSearchParams(body.toString());
    if (f.get("client_id") !== "zo-client" || f.get("client_secret") !== "zo-secret") return send(200, { error: "invalid_client" });
    if (f.get("grant_type") === "authorization_code") {
      const c = zo.codes.get(f.get("code"));
      if (!c || c.redirect !== f.get("redirect_uri") || s256(f.get("code_verifier") ?? "") !== c.challenge) return send(200, { error: "invalid_code" });
      zo.codes.delete(f.get("code"));
      return send(200, zoIssue(true));
    }
    if (f.get("grant_type") === "refresh_token") {
      if (zo.revoked || f.get("refresh_token") !== "zo-rt") return send(200, { error: "invalid_code" });
      zo.refreshes++;
      return send(200, zoIssue(false)); // Zoho no devuelve un refresh token nuevo
    }
    return send(200, { error: "unsupported_grant_type" });
  }
  const tok = (req.headers.authorization ?? "").replace(/^Zoho-oauthtoken /, "");
  if (zo.revoked || !zo.valid.has(tok)) return send(401, { code: "INVALID_TOKEN", details: {}, message: "invalid oauth token", status: "error" });
  const m = path.match(/^\/(crm\/v7|bigin\/v2)\/(\w+)(?:\/(\w+))?(?:\/(\w+))?$/);
  if (!m) return send(404, { code: "INVALID_URL_PATTERN", message: path, status: "error" });
  const [, api, mod, id, sub] = m;
  if (mod === "org") return send(200, { org: [{ id: "org-zo-1", company_name: api === "bigin/v2" ? "ACME Bigin" : "ACME Zoho" }] });
  const store = api === "bigin/v2" ? { Pipelines: zo.pipelines, Contacts: zo.contacts }[mod] : { Deals: zo.deals, Contacts: zo.contacts }[mod];
  if (mod === "Notes" && req.method === "POST") {
    const n = json().data[0];
    zo.notes.push({ api, ...n });
    return send(201, { data: [{ code: "SUCCESS", details: { id: `note-${zo.notes.length}` }, message: "record added", status: "success" }] });
  }
  if (!store) return send(400, { code: "INVALID_MODULE", message: `módulo ${mod} no existe en ${api}`, status: "error" });
  const rec = store[id];
  if (!rec) return send(204);
  if (!sub && req.method === "GET") return send(200, { data: [{ id, ...rec }] });
  if (!sub && req.method === "PUT") {
    const b = json();
    if (!Array.isArray(b.trigger)) return send(400, { code: "MISSING_TRIGGER" });
    if ("Campo_Inexistente" in b.data[0]) return send(400, { data: [{ code: "INVALID_DATA", details: { api_name: "Campo_Inexistente" }, message: "invalid data", status: "error" }] });
    Object.assign(rec, b.data[0]);
    zo.puts.push({ api, mod, id, ...b.data[0] });
    return send(200, { data: [{ code: "SUCCESS", details: { id }, message: "record updated", status: "success" }] });
  }
  if (sub === "Contact_Roles" && api === "crm/v7") {
    const list = zo.roles[id] ?? [];
    return list.length ? send(200, { data: list, info: { count: list.length } }) : send(204);
  }
  if (sub === "Attachments" && req.method === "POST") {
    zo.attachments.push({ api, mod, id, pdf: body.toString("latin1").includes("%PDF"), multipart: String(req.headers["content-type"]).startsWith("multipart/form-data") });
    return send(200, { data: [{ code: "SUCCESS", details: { id: `att-${zo.attachments.length}` }, message: "attachment uploaded", status: "success" }] });
  }
  send(400, { code: "INVALID_URL_PATTERN", message: `${req.method} ${path}`, status: "error" });
});

// ───────────────────────────── API propia ─────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "calasign-crm-e2e-"));
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
    HUBSPOT_CLIENT_ID: "hs-client",
    HUBSPOT_CLIENT_SECRET: HS_SECRET,
    HUBSPOT_API_BASE: `http://127.0.0.1:${P.hs}`,
    HUBSPOT_AUTHORIZE_URL: `http://127.0.0.1:${P.hs}/oauth/authorize`,
    SALESFORCE_CLIENT_ID: "sf-client",
    SALESFORCE_CLIENT_SECRET: "sf-secret",
    SALESFORCE_LOGIN_URL: `http://127.0.0.1:${P.sf}`,
    SIIGO_API_BASE: `http://127.0.0.1:${P.sg}`,
    SIIGO_PARTNER_ID: "CalaSignE2E",
    ALEGRA_API_BASE: `http://127.0.0.1:${P.al}/api/v1`,
    ZOHO_CLIENT_ID: "zo-client",
    ZOHO_CLIENT_SECRET: "zo-secret",
    ZOHO_ACCOUNTS_URL: `http://127.0.0.1:${P.zo}`,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const cleanup = () => {
  try {
    api_.kill("SIGTERM");
  } catch {}
  // La base PGlite y los archivos de la corrida pesan decenas de MB: sin borrarlos /tmp se llena
  // con cada ejecución (E2E_KEEP_DATA=1 los conserva para depurar).
  if (process.env.E2E_KEEP_DATA !== "1") {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
};
process.on("exit", cleanup);
// SIGINT/SIGTERM/SIGHUP (Ctrl+C, `timeout`, cierre de terminal) terminan sin el evento "exit": se convierten en
// process.exit para que la limpieza corra también en esos casos.
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
  if (set && set.startsWith("cs_session")) cookie = set.split(";")[0];
  if (opts.raw) return res;
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

function tinyPdf() {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"];
  const content = "BT /F1 18 Tf 72 760 Td (Contrato CRM) Tj ET";
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

async function oauthConnect(provider, name, extra = {}) {
  const { authorizeUrl } = await api("POST", `/v1/crm/oauth/${provider}/start`, { name, ...extra });
  const r1 = await fetch(authorizeUrl, { redirect: "manual" });
  const cb = r1.headers.get("location");
  assert(cb?.startsWith(`${BASE}/v1/crm/oauth/${provider}/callback`), `${provider}: el proveedor vuelve al callback`);
  const r2 = await fetch(cb, { headers: { cookie }, redirect: "manual" });
  const loc = r2.headers.get("location") ?? "";
  assert(loc.includes(`connected=${provider}`), `${provider}: callback conecta (${loc})`);
  const { items } = await api("GET", "/v1/crm/connections");
  return items.find((c) => c.provider === provider && c.name === name);
}

// ───────────────────────────── Escenario ─────────────────────────────

const stamp = Date.now();
await api("POST", "/v1/auth/signup", { name: "Admin CRM", email: `crm+${stamp}@example.com`, password: "una-clave-segura-123", organization: `CRM ${stamp}` });

const prov = await api("GET", "/v1/crm/providers");
const byP = Object.fromEntries(prov.items.map((p) => [p.provider, p]));
assert(byP.hubspot.oauthConfigured && byP.salesforce.oauthConfigured && !byP.siigo.oauthConfigured && byP.siigo.tokenSupported && !byP.salesforce.tokenSupported, "proveedores");
assert(prov.redirectUris.salesforce === `${BASE}/v1/crm/oauth/salesforce/callback`, "redirect URI");
assert(byP.zoho.oauthConfigured && !byP.zoho.tokenSupported && byP.zoho.kind === "crm" && prov.redirectUris.zoho === `${BASE}/v1/crm/oauth/zoho/callback`, "Zoho por OAuth");
step("proveedores: OAuth configurado para HubSpot, Salesforce y Zoho; Siigo y Alegra por token");

// Plantilla con dos roles y un monto a prellenar.
const { template } = await api("POST", "/v1/templates", { name: `Contrato CRM ${stamp}`, subject: "Contrato" });
const fd = new FormData();
fd.append("file", new Blob([tinyPdf()], { type: "application/pdf" }), "contrato.pdf");
const tdoc = await api("POST", `/v1/templates/${template.id}/documents`, fd);
const rC = randomUUID();
const rV = randomUUID();
await api("PUT", `/v1/templates/${template.id}/roles`, { roles: [{ id: rC, name: "Cliente", role: "signer", routingOrder: 1 }, { id: rV, name: "Vendedor", role: "signer", routingOrder: 2 }] });
await api("PUT", `/v1/templates/${template.id}/fields`, {
  fields: [
    { documentId: tdoc.id, roleId: rC, type: "signature", page: 0, x: 0.1, y: 0.7, width: 0.3, height: 0.08 },
    { documentId: tdoc.id, roleId: rC, type: "text", page: 0, x: 0.1, y: 0.2, width: 0.3, height: 0.03, label: "Monto" },
    { documentId: tdoc.id, roleId: rV, type: "signature", page: 0, x: 0.55, y: 0.7, width: 0.3, height: 0.08 },
  ],
});

// ── HubSpot por OAuth ──
const hsConn = await oauthConnect("hubspot", "HubSpot ACME");
assert(hsConn?.accountLabel === "acme.hubspot.test" && hsConn.authType === "oauth", "conexión HubSpot con etiqueta");
step("HubSpot: OAuth (authorize → callback → token) y etiqueta de la cuenta");

await api("POST", "/v1/crm/mappings", { connectionId: hsConn.id, name: "x", objectType: "opportunity", templateId: template.id }, { expect: 400 });
const vendedor = `VendHS ${stamp}`;
const vendedorWh = `VendWH ${stamp}`;
const vendedorSf = `VendSF ${stamp}`;
const vendedorErp = `VendERP ${stamp}`;
const hsMap = await api("POST", "/v1/crm/mappings", {
  connectionId: hsConn.id,
  name: "Deals → contrato",
  objectType: "deal",
  templateId: template.id,
  roles: [
    { role: "Cliente", source: "contact", index: 0 },
    { role: "Vendedor", source: "fixed", name: vendedor, email: `ventas+${stamp}@acme.test` },
  ],
  prefill: [{ field: "Monto", property: "amount" }],
  writeBack: { statusProperty: "calasign_status", statusValues: { completed: "Firmado" }, attachPdf: true },
});
const sent = await api("POST", `/v1/crm/mappings/${hsMap.id}/send`, { objectId: "9001" });
assert(sent.status === "sent", "sobre enviado desde el deal");
const det = await api("GET", `/v1/envelopes/${sent.envelopeId}`);
assert(det.recipients.some((r) => r.name === "Ana Pérez HS" && r.email === "ana.hs@cliente.test"), "contacto del deal como Cliente");
assert(det.fields.some((f) => f.label === "Monto" && f.value === "1500.50"), "monto prellenado desde el deal");
assert(det.envelope.metadata.crm?.objectId === "9001", "metadata del sobre con el registro");
await waitFor(() => hs.deals["9001"].calasign_status === "sent", "write-back sent en HubSpot");
step("HubSpot: envío desde el deal 9001 (contacto + monto mapeados) y write-back «sent»");

// Un correo mal cargado en el CRM es un error del registro (422), no del servidor (antes: 500).
const broken = await api("POST", `/v1/crm/mappings/${hsMap.id}/send`, { objectId: "9004" }, { raw: true });
assert(broken.status === 422 && (await broken.json()).error?.code === "crm_invalid_record", `correo inválido en el CRM → 422 (HTTP ${broken.status})`);
step("HubSpot: registro con un correo inválido → 422 crm_invalid_record");

hs.expire(); // el access token vence: el próximo uso tiene que refrescar
await signAll(sent.envelopeId, ["Ana Pérez HS", vendedor]);
await waitFor(() => hs.deals["9001"].calasign_status === "Firmado" && hs.notes.length === 1, "write-back Firmado + nota");
assert(hs.refreshes >= 1, "se refrescó el token vencido");
assert(hs.files.length === 1 && hs.files[0].pdf && hs.files[0].folder, "PDF sellado subido a Files /CalaSign");
assert(hs.notes[0].properties.hs_attachment_ids === "f1" && hs.notes[0].associations[0].to.id === "9001", "nota con el adjunto asociada al deal");
step("HubSpot: firmado → token refrescado, estado «Firmado» y PDF adjunto al deal con una nota");

// ── Webhook de HubSpot ──
const hsHook = await api("POST", "/v1/crm/mappings", {
  connectionId: hsConn.id,
  name: "Deal en contractsent",
  objectType: "deal",
  templateId: template.id,
  roles: [
    { role: "Cliente", source: "contact", index: 0 },
    { role: "Vendedor", source: "fixed", name: vendedorWh, email: `ventas+${stamp}@acme.test` },
  ],
  trigger: "webhook",
  triggerConfig: { property: "dealstage", value: "contractsent" },
  writeBack: { attachPdf: false },
});
const hookUrl = `${BASE}/v1/integrations/crm/hubspot/webhook`;
const events = JSON.stringify([{ eventId: 50001, subscriptionType: "deal.propertyChange", portalId: 777, objectId: 9002, propertyName: "dealstage", propertyValue: "contractsent" }]);
const ts = String(Date.now());
const sig = createHmac("sha256", HS_SECRET).update(`POST${hookUrl}${events}${ts}`).digest("base64");
const bad = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-hubspot-request-timestamp": ts, "x-hubspot-signature-v3": "x" + sig.slice(1) }, body: events });
assert(bad.status === 401, "webhook con firma inválida → 401");
for (let i = 0; i < 2; i++) {
  const r = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-hubspot-request-timestamp": ts, "x-hubspot-signature-v3": sig }, body: events });
  assert(r.status === 200, `webhook aceptado (${r.status})`);
}
const hookRun = await waitFor(async () => (await api("GET", "/v1/crm/runs")).items.find((r) => r.mappingId === hsHook.id && r.kind === "send" && r.status === "succeeded"), "envío por webhook");
const hookRuns = (await api("GET", "/v1/crm/runs")).items.filter((r) => r.mappingId === hsHook.id && r.kind === "send");
assert(hookRuns.length === 1 && hookRun.envelopeId && hookRun.objectId === "9002", "un solo envío por evento repetido");
assert(hookRun.attempts === 1, `un envío por webhook que sale al primer intento cuenta 1 intento (${hookRun.attempts})`);
step("HubSpot: webhook firmado (v3) dispara el envío del deal 9002; firma inválida 401; evento repetido no duplica");

// Varios eventos distintos del mismo deal en una tanda (la cola los procesa en paralelo): un solo sobre.
{
  const burst = JSON.stringify(
    [60001, 60002, 60003].map((eventId) => ({ eventId, subscriptionType: "deal.propertyChange", portalId: 777, objectId: 9003, propertyName: "dealstage", propertyValue: "contractsent" })),
  );
  const tsB = String(Date.now());
  const sigB = createHmac("sha256", HS_SECRET).update(`POST${hookUrl}${burst}${tsB}`).digest("base64");
  const rB = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-hubspot-request-timestamp": tsB, "x-hubspot-signature-v3": sigB }, body: burst });
  assert(rB.status === 200, "tanda de webhooks aceptada");
  const runsB = await waitFor(async () => {
    const items = (await api("GET", "/v1/crm/runs")).items.filter((r) => r.mappingId === hsHook.id && r.kind === "send" && r.objectId === "9003");
    return items.length === 3 && items.every((r) => r.status !== "pending") ? items : null;
  }, "tres ejecuciones del deal 9003");
  const withEnvelope = runsB.filter((r) => r.envelopeId);
  assert(runsB.every((r) => r.status === "succeeded"), `las tres terminan bien (${runsB.map((r) => r.status + ":" + (r.error ?? "")).join(", ")})`);
  assert(withEnvelope.length === 1 && runsB.filter((r) => r.detail?.skipped).length === 2, `un solo sobre para el deal (${withEnvelope.length})`);
  step("HubSpot: tres eventos del mismo deal en paralelo crean un solo sobre");
}

// Un mapeo por webhook creado por alguien que después deja la organización no sigue enviando a su nombre.
{
  const email = `ines+${stamp}@example.com`;
  const inv = await api("POST", "/v1/invitations", { email, role: "admin" });
  const accept = await fetch(`${BASE}/v1/invite/${inv.acceptUrl.split("/invite/")[1]}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Inés Ex", password: "clave-de-ines-123" }),
  });
  assert(accept.ok, `Inés aceptó la invitación (${accept.status})`);
  const ines = accept.headers.get("set-cookie").split(";")[0];
  const asInes = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { cookie: ines, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert(r.ok, `${method} ${path} como Inés → ${r.status}`);
    return r.json();
  };
  const inesMap = await asInes("POST", "/v1/crm/mappings", {
    connectionId: hsConn.id,
    name: "Deal en closedwon (Inés)",
    objectType: "deal",
    templateId: template.id,
    roles: [
      { role: "Cliente", source: "contact", index: 0 },
      { role: "Vendedor", source: "fixed", name: `Vendedor Ex ${stamp}`, email: `ventas3+${stamp}@acme.test` },
    ],
    trigger: "webhook",
    triggerConfig: { property: "dealstage", value: "closedwon" },
    writeBack: { attachPdf: false },
  });
  const inesMe = await (await fetch(`${BASE}/v1/me`, { headers: { cookie: ines } })).json();
  await api("DELETE", `/v1/members/${inesMe.user.id}`);
  const ev2 = JSON.stringify([{ eventId: 50002, subscriptionType: "deal.propertyChange", portalId: 777, objectId: 9001, propertyName: "dealstage", propertyValue: "closedwon" }]);
  const ts2 = String(Date.now());
  const sig2 = createHmac("sha256", HS_SECRET).update(`POST${hookUrl}${ev2}${ts2}`).digest("base64");
  const r2 = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-hubspot-request-timestamp": ts2, "x-hubspot-signature-v3": sig2 }, body: ev2 });
  assert(r2.status === 200, "webhook aceptado");
  const failed = await waitFor(async () => (await api("GET", "/v1/crm/runs")).items.find((r) => r.mappingId === inesMap.id && r.kind === "send" && r.status === "failed"), "envío rechazado");
  assert(!failed.envelopeId && /ya no es miembro/.test(failed.error ?? ""), `sin sobre a nombre de una ex miembro (${failed.error})`);
  step("HubSpot: el webhook no envía a nombre de quien creó el mapeo si ya no es miembro");
}

// Un mapeo por webhook creado con una API key: el sobre queda a nombre de la key (la key lo ve) y, revocada la key,
// el webhook deja de enviar.
{
  const { apiKey, secret } = await api("POST", "/v1/api-keys", { name: `crm key ${stamp}`, role: "admin" });
  const asKey = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const created = await asKey("POST", "/v1/crm/mappings", {
    connectionId: hsConn.id,
    name: "Deal en qualifiedtobuy (API key)",
    objectType: "deal",
    templateId: template.id,
    roles: [
      { role: "Cliente", source: "contact", index: 0 },
      { role: "Vendedor", source: "fixed", name: `Vendedor Key ${stamp}`, email: `ventas4+${stamp}@acme.test` },
    ],
    trigger: "webhook",
    triggerConfig: { property: "dealstage", value: "qualifiedtobuy" },
    writeBack: { attachPdf: false },
  });
  assert(created.status === 201, `mapeo creado con la API key (${created.status})`);
  const keyMap = created.body;
  const fire = async (eventId) => {
    const ev = JSON.stringify([{ eventId, subscriptionType: "deal.propertyChange", portalId: 777, objectId: 9001, propertyName: "dealstage", propertyValue: "qualifiedtobuy" }]);
    const t = String(Date.now());
    const sg = createHmac("sha256", HS_SECRET).update(`POST${hookUrl}${ev}${t}`).digest("base64");
    const r = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "x-hubspot-request-timestamp": t, "x-hubspot-signature-v3": sg }, body: ev });
    assert(r.status === 200, "webhook aceptado");
  };
  await fire(50003);
  const okRun = await waitFor(async () => (await api("GET", "/v1/crm/runs")).items.find((r) => r.mappingId === keyMap.id && r.kind === "send" && r.status !== "pending"), "envío con mapeo de la key");
  assert(okRun.status === "succeeded" && okRun.envelopeId, `el webhook envió con el mapeo de la key (${okRun.status} ${okRun.error ?? ""})`);
  const seen = await asKey("GET", `/v1/envelopes/${okRun.envelopeId}`);
  assert(seen.status === 200, `la key ve el sobre que mandó su mapeo (${seen.status})`);
  await api("POST", `/v1/envelopes/${okRun.envelopeId}/void`, { reason: "prueba e2e" });
  await api("DELETE", `/v1/api-keys/${apiKey.id}`);
  await fire(50004);
  const goneRun = await waitFor(
    async () => (await api("GET", "/v1/crm/runs")).items.find((r) => r.mappingId === keyMap.id && r.kind === "send" && r.id !== okRun.id && r.status !== "pending"),
    "envío rechazado con la key revocada",
  );
  assert(goneRun.status === "failed" && !goneRun.envelopeId && /revocada/.test(goneRun.error ?? ""), `con la key revocada no hay sobre (${goneRun.status} ${goneRun.error})`);
  step("HubSpot: mapeo creado con una API key → el sobre es de la key; revocada la key, el webhook no envía");
}

// ── Salesforce con PKCE ──
const sfConn = await oauthConnect("salesforce", "Salesforce Gamma");
assert(sfConn?.accountLabel === `127.0.0.1:${P.sf}`, "etiqueta = instance_url");
const sfMap = await api("POST", "/v1/crm/mappings", {
  connectionId: sfConn.id,
  name: "Opportunities",
  objectType: "opportunity",
  templateId: template.id,
  roles: [
    { role: "Cliente", source: "contact_role", primary: true },
    { role: "Vendedor", source: "fixed", name: vendedorSf, email: `ventas+${stamp}@acme.test` },
  ],
  prefill: [{ field: "Monto", property: "Amount" }],
  writeBack: { statusProperty: "CalaSign_Status__c" },
});
sf.expireOnNextData = true; // la sesión vence en la primera lectura: refresh y reintento
const sfSent = await api("POST", `/v1/crm/mappings/${sfMap.id}/send`, { objectId: "006A1" });
assert(sf.refreshes >= 1, "Salesforce: refresh ante INVALID_SESSION_ID");
assert((await api("GET", `/v1/envelopes/${sfSent.envelopeId}`)).fields.some((f) => f.label === "Monto" && f.value === "2500"), "monto desde Amount");
await signAll(sfSent.envelopeId, ["Carla Gamma SF", vendedorSf]);
await waitFor(() => sf.opps["006A1"].CalaSign_Status__c === "completed" && sf.versions.length === 1, "write-back y ContentVersion");
assert(sf.versions[0].link === "006A1" && sf.versions[0].pdf, "ContentVersion vinculado a la oportunidad");
step("Salesforce: OAuth con PKCE S256, contacto principal (OpportunityContactRole), refresh de sesión, estado y ContentVersion");

// ── Zoho CRM: OAuth multi-DC con PKCE, Deal con roles de contacto, write-back y adjunto ──
{
  const zoConn = await oauthConnect("zoho", "Zoho ACME", { region: "com", product: "crm" });
  assert(zoConn?.accountLabel === "ACME Zoho" && zoConn.authType === "oauth", `conexión Zoho con etiqueta (${zoConn?.accountLabel})`);
  assert([...zo.codes.keys()].length === 0, "el código se canjeó en el accounts-server de la cuenta (EU), no donde se inició");
  step("Zoho: OAuth con PKCE iniciado en zoho.com; el código se canjea en el accounts-server del callback (EU) y la API va a su api_domain");

  await api("POST", "/v1/crm/mappings", { connectionId: zoConn.id, name: "x", objectType: "opportunity", templateId: template.id }, { expect: 400 });
  const vendZo = `VendZO ${stamp}`;
  const zoMap = await api("POST", "/v1/crm/mappings", {
    connectionId: zoConn.id,
    name: "Deals Zoho",
    objectType: "deal",
    templateId: template.id,
    roles: [
      { role: "Cliente", source: "contact_role", contactRole: "Legal" },
      { role: "Vendedor", source: "fixed", name: vendZo, email: `ventas+zo${stamp}@acme.test` },
    ],
    prefill: [{ field: "Monto", property: "Amount" }],
    writeBack: { statusProperty: "CalaSign_Status", statusValues: { completed: "Firmado" } },
  });
  const zoSent = await api("POST", `/v1/crm/mappings/${zoMap.id}/send`, { objectId: "z1" });
  const zoDet = await api("GET", `/v1/envelopes/${zoSent.envelopeId}`);
  assert(zoDet.recipients.some((r) => r.name === "Raúl Roles" && r.email === "raul.legal@cliente.test"), "contacto con rol Legal como Cliente");
  assert(zoDet.fields.some((f) => f.label === "Monto" && f.value === "3200"), "monto prellenado desde Amount");
  assert(zoDet.envelope.subject.includes("Renovación Zoho"), `asunto con el Deal_Name (${zoDet.envelope.subject})`);
  await waitFor(() => zo.deals.z1.CalaSign_Status === "sent", "write-back sent en Zoho");
  const missing = await api("POST", `/v1/crm/mappings/${zoMap.id}/send`, { objectId: "no-existe" }, { raw: true });
  assert(missing.status === 404 && (await missing.json()).error?.code === "crm_record_not_found", `Deal inexistente (204 de Zoho) → 404 (HTTP ${missing.status})`);
  step("Zoho: envío desde el Deal z1 (rol de contacto Legal + Amount), write-back «sent»; Deal inexistente → 404");

  zo.expire(); // el access token vence: el refresh tiene que ir al accounts-server del EU
  const refreshesBefore = zo.refreshes;
  await signAll(zoSent.envelopeId, ["Raúl Roles", vendZo]);
  await waitFor(() => zo.deals.z1.CalaSign_Status === "Firmado" && zo.attachments.length === 1 && zo.notes.length === 1, "write-back Firmado + adjunto + nota en Zoho");
  assert(zo.refreshes > refreshesBefore, "se refrescó el token en el centro de datos de la cuenta");
  assert(zo.attachments[0].mod === "Deals" && zo.attachments[0].id === "z1" && zo.attachments[0].pdf && zo.attachments[0].multipart, "PDF sellado adjunto al Deal (multipart)");
  assert(zo.notes[0].Parent_Id?.id === "z1" && zo.notes[0].Parent_Id?.module?.api_name === "Deals" && /SHA-256/.test(zo.notes[0].Note_Content), "nota en el Deal con hash y enlace");
  const zoLinks = (await api("GET", `/v1/crm/links?envelopeId=${zoSent.envelopeId}`)).items;
  assert(/attachment:att-1/.test(zoLinks[0]?.remoteRef ?? ""), `referencia remota del adjunto (${zoLinks[0]?.remoteRef})`);
  step("Zoho: firmado → token refrescado en el EU, estado «Firmado», PDF adjunto al Deal y nota con hash");

  // Envío desde un Contact (el propio contacto firma) y un campo de estado inexistente: error visible del registro.
  const zoContactMap = await api("POST", "/v1/crm/mappings", {
    connectionId: zoConn.id,
    name: "Contacts Zoho",
    objectType: "contact",
    templateId: template.id,
    roles: [
      { role: "Cliente", source: "contact", index: 0 },
      { role: "Vendedor", source: "fixed", name: `VendZC ${stamp}`, email: `ventas+zc${stamp}@acme.test` },
    ],
    writeBack: { statusProperty: "Campo_Inexistente", attachPdf: false },
  });
  const zcSent = await api("POST", `/v1/crm/mappings/${zoContactMap.id}/send`, { objectId: "zc1" });
  assert((await api("GET", `/v1/envelopes/${zcSent.envelopeId}`)).recipients.some((r) => r.name === "Zoe Zoho" && r.phone === "+573004445566"), "el contacto con su móvil");
  const zcFail = await waitFor(async () => (await api("GET", `/v1/crm/runs?envelopeId=${zcSent.envelopeId}`)).items.find((r) => r.kind === "write_back" && r.status === "failed"), "write-back rechazado por Zoho");
  assert(/INVALID_DATA/.test(zcFail.error ?? ""), `error de Zoho visible (${zcFail.error})`);
  await api("POST", `/v1/envelopes/${zcSent.envelopeId}/void`, { reason: "prueba e2e" });
  step("Zoho: envío desde un Contact; un campo de estado inexistente deja el error INVALID_DATA en la actividad");

  // ── Bigin: mismo conector, producto bigin (Pipelines) ──
  const biConn = await oauthConnect("zoho", "Bigin ACME", { product: "bigin" });
  assert(biConn?.accountLabel === "ACME Bigin (Bigin)", `conexión Bigin (${biConn?.accountLabel})`);
  assert([...zo.codes.values()].length === 0, "código canjeado");
  const biMap = await api("POST", "/v1/crm/mappings", {
    connectionId: biConn.id,
    name: "Pipelines Bigin",
    objectType: "deal",
    templateId: template.id,
    roles: [
      { role: "Cliente", source: "contact", index: 0 },
      { role: "Vendedor", source: "fixed", name: `VendBI ${stamp}`, email: `ventas+bi${stamp}@acme.test` },
    ],
    prefill: [{ field: "Monto", property: "Amount" }],
    writeBack: { statusProperty: "CalaSign_Status" },
  });
  const biSent = await api("POST", `/v1/crm/mappings/${biMap.id}/send`, { objectId: "b1" });
  assert((await api("GET", `/v1/envelopes/${biSent.envelopeId}`)).recipients.some((r) => r.name === "Bea Bigin"), "contacto del pipeline");
  await waitFor(() => zo.pipelines.b1.CalaSign_Status === "sent" && zo.puts.some((p) => p.api === "bigin/v2" && p.mod === "Pipelines"), "write-back en Bigin");
  await signAll(biSent.envelopeId, ["Bea Bigin", `VendBI ${stamp}`]);
  await waitFor(() => zo.attachments.some((a) => a.api === "bigin/v2" && a.mod === "Pipelines" && a.id === "b1" && a.pdf), "PDF adjunto al pipeline de Bigin");
  step("Bigin: OAuth con producto bigin, envío desde un Pipeline, estado y PDF adjunto por la API /bigin/v2");

  // Refresh token revocado: el envío pide reconectar.
  zo.revoked = true;
  zo.expire();
  const zo409 = await api("POST", `/v1/crm/mappings/${zoMap.id}/send`, { objectId: "z1" }, { expect: 409 });
  assert(zo409.error.code === "crm_reauth_required", "Zoho revocado → crm_reauth_required");
  zo.revoked = false;
  step("Zoho revocado: el envío responde 409 crm_reauth_required");
}

// ── ERP: Siigo y Alegra por token ──
await api("POST", "/v1/crm/connections", { provider: "siigo", name: "Siigo", username: "api@acme.test", accessKey: "mala-clave-123" }, { expect: 400 });
const sgConn = await api("POST", "/v1/crm/connections", { provider: "siigo", name: "Siigo ACME", username: "api@acme.test", accessKey: "siigo-access-key" });
const alConn = await api("POST", "/v1/crm/connections", { provider: "alegra", name: "Alegra ACME", email: "admin@acme.test", token: "alegra-token" });
await api("POST", "/v1/crm/mappings", { connectionId: sgConn.id, name: "x", objectType: "customer", trigger: "manual" }, { expect: 400 });
await api("POST", "/v1/crm/mappings", { connectionId: sgConn.id, name: "Clientes Siigo", objectType: "customer", trigger: "on_completion", triggerConfig: { matchBy: "recipient_id_document", templateId: template.id } });
await api("POST", "/v1/crm/mappings", { connectionId: alConn.id, name: "Contactos Alegra", objectType: "contact", trigger: "on_completion", triggerConfig: { matchBy: "recipient_id_document" } });
step("ERP: conexiones Siigo (clave inválida rechazada) y Alegra probadas al crearlas; mapeos al completarse");

const cliente = `Cliente ERP ${stamp}`;
const erpEnv = await api("POST", "/v1/envelopes/from-template", {
  templateId: template.id,
  send: true,
  recipients: [
    { role: "Cliente", name: cliente, email: `erp+${stamp}@cliente.test`, idDocumentType: "cedula", idDocumentNumber: "900123456" },
    { role: "Vendedor", name: vendedorErp, email: `ventas2+${stamp}@acme.test`, idDocumentType: "cedula", idDocumentNumber: "79123456" },
  ],
});
await signAll(erpEnv.envelope.id, [cliente, vendedorErp]);
const sgRun = await waitFor(async () => (await api("GET", `/v1/crm/runs?envelopeId=${erpEnv.envelope.id}`)).items.find((r) => r.connectionId === sgConn.id && r.status === "succeeded"), "Siigo (con un reintento)", 40_000);
assert(sgRun.attempts >= 2, "Siigo: falló una vez (500) y la cola reintentó");
assert(sg.puts.length === 1 && sg.puts[0].comments.startsWith("Cliente VIP\nCalaSign:") && !("id" in sg.puts[0]), "comments del cliente con la referencia, sin pisar lo anterior");
await waitFor(() => al.attachments.some((a) => a.kind === "contacts" && a.id === "55" && a.pdf), "adjunto al contacto de Alegra");
step("ERP: al completarse se busca por identificación; Siigo reintenta tras un 500 y agrega la referencia; Alegra recibe el PDF");

// ── Vínculo manual + token revocado + reintento manual ──
al.revoked = true;
const link = await api("POST", "/v1/crm/links", { connectionId: alConn.id, envelopeId: sent.envelopeId, objectType: "invoice", objectId: "777" });
const failed = await waitFor(async () => (await api("GET", `/v1/crm/runs?envelopeId=${sent.envelopeId}`)).items.find((r) => r.connectionId === alConn.id && r.objectId === "777" && r.status === "failed"), "error de credenciales");
assert(/volver a conectarla|HTTP 401/.test(failed.error ?? ""), `error de credenciales visible (${failed.error})`);
const conns = (await api("GET", "/v1/crm/connections")).items;
assert(conns.find((c) => c.id === alConn.id).lastError, "la conexión muestra el último error");
await sleep(1500);
assert((await api("GET", `/v1/crm/runs?envelopeId=${sent.envelopeId}`)).items.find((r) => r.id === failed.id).attempts === 1, "sin acceso: no se reintenta solo");
al.revoked = false;
await api("POST", `/v1/crm/runs/${failed.id}/retry`, {}, { expect: 202 });
await waitFor(async () => (await api("GET", `/v1/crm/runs?envelopeId=${sent.envelopeId}`)).items.find((r) => r.id === failed.id)?.status === "succeeded", "reintento manual");
assert(al.attachments.some((a) => a.kind === "invoices" && a.id === "777"), "factura con el PDF");
assert(link.objectType === "invoice", "vínculo manual");
step("Vínculo manual a una factura de Alegra: credenciales rechazadas → error visible, sin reintento automático; reintento manual OK");

hs.revoked = true;
const e409 = await api("POST", `/v1/crm/mappings/${hsMap.id}/send`, { objectId: "9001" }, { expect: 409 });
assert(e409.error.code === "crm_reauth_required", "token revocado → crm_reauth_required");
const lastSend = (await api("GET", "/v1/crm/runs?status=failed")).items.find((r) => r.kind === "send" && r.mappingId === hsMap.id);
assert(lastSend && /volver a conectarla/.test(lastSend.error), "la ejecución fallida queda en el registro");
step("HubSpot revocado: el envío responde 409 crm_reauth_required y queda registrado");

console.log("\nE2E CRM OK");
cleanup();
process.exit(0);
