// CRM y conectores: cuenta obligatoria en Pipedrive/Kommo, revocación al desconectar conservando la actividad,
// webhook de conectores con ventana de deduplicación y firma HMAC por flujo, eventos propios de HubSpot, bucle de
// write-back, reanudación del adjunto de HubSpot, portal obligatorio con token, retención de ejecuciones y auditoría.
// App real sobre PGlite y un fetch falso (sin red).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-integ-hard-"));
delete process.env.DATABASE_URL;
process.env.PIPEDRIVE_CLIENT_ID = "pd-client";
process.env.PIPEDRIVE_CLIENT_SECRET = "pd-secret";
process.env.HUBSPOT_CLIENT_ID = "hs-client";
process.env.HUBSPOT_CLIENT_SECRET = "hs-secret";
process.env.FACTORIAL_CLIENT_ID = "fa-client";
process.env.FACTORIAL_CLIENT_SECRET = "fa-secret";

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let tenant = "";
let user = "";
let template = "";
let session = "";
const KEY = "cs_test_integrations_hardening_key";
const auth = { authorization: `Bearer ${KEY}` };
const real = globalThis.fetch;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
let calls: Call[] = [];
let handler: (c: Call) => Response | Promise<Response> = () => new Response("{}", { status: 404 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const b = init?.body;
    const c: Call = { method: init?.method ?? "GET", url: String(input), headers, body: typeof b === "string" ? b : b instanceof URLSearchParams ? b.toString() : b ? "[binario]" : "" };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
}

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = util.uuidv7();
  user = util.uuidv7();
  template = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Ana','scrypt$x')`, [user, `ana-${tenant.slice(-6)}@x.test`]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenant, user]);
  session = util.randomToken();
  await db.query(`INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1,$2,$3, now() + interval '14 days', 'password')`, [
    util.sha256Hex(session),
    user,
    tenant,
  ]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [util.uuidv7(), tenant, util.sha256Hex(KEY)]);
  await db.query(`INSERT INTO templates (id, tenant_id, name, created_by) VALUES ($1, $2, 'Plantilla', $3)`, [template, tenant, user]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  installFetch();
}, 120_000);
afterAll(async () => {
  globalThis.fetch = real;
  await app?.close();
  await db?.close();
});
afterEach(() => {
  calls = [];
  handler = () => new Response("{}", { status: 404 });
  vi.restoreAllMocks();
});

async function crmConn(provider: string, opts: { auth?: string; creds?: unknown; config?: Record<string, unknown> } = {}) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO crm_connections (id, tenant_id, provider, name, auth_type, credentials_enc, config) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    id,
    tenant,
    provider,
    `${provider} ${id.slice(-4)}`,
    opts.auth ?? "oauth",
    util.encrypt(JSON.stringify(opts.creds ?? { access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3_600_000 })),
    JSON.stringify(opts.config ?? {}),
  ]);
  return id;
}
async function crmMapping(connectionId: string, extra: { trigger?: string; triggerConfig?: unknown; objectType?: string } = {}) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO crm_mappings (id, tenant_id, connection_id, name, object_type, template_id, trigger, trigger_config, created_by) VALUES ($1,$2,$3,'m',$4,$5,$6,$7,$8)`, [
    id,
    tenant,
    connectionId,
    extra.objectType ?? "deal",
    template,
    extra.trigger ?? "manual",
    JSON.stringify(extra.triggerConfig ?? {}),
    user,
  ]);
  return id;
}
async function connConn(provider: string, opts: { auth?: string; creds?: unknown } = {}) {
  const id = util.uuidv7();
  const token = `cshk_${util.randomToken()}`;
  await db.query(
    `INSERT INTO connector_connections (id, tenant_id, provider, category, name, auth_type, credentials_enc, config, webhook_token_hash, webhook_token_enc)
     VALUES ($1,$2,$3,'hris',$4,$5,$6,'{}',$7,$8)`,
    [id, tenant, provider, `${provider} ${id.slice(-4)}`, opts.auth ?? "api_key", util.encrypt(JSON.stringify(opts.creds ?? { apiKey: "k" })), util.sha256Hex(token), util.encrypt(token)],
  );
  return { id, token };
}
async function connFlow(connectionId: string, secret?: string) {
  const id = util.uuidv7();
  await db.query(
    `INSERT INTO connector_flows (id, tenant_id, connection_id, name, object_type, template_id, trigger, created_by, webhook_secret_enc) VALUES ($1,$2,$3,'f','employee',$4,'webhook',$5,$6)`,
    [id, tenant, connectionId, template, user, secret ? util.encrypt(secret) : null],
  );
  return id;
}
const audits = async (action: string, targetId: string) =>
  db.query<any>(`SELECT * FROM account_audit_log WHERE tenant_id = $1 AND action = $2 AND target_id = $3`, [tenant, action, targetId]);

// ───────────────────────────── 1. Cuenta de Pipedrive/Kommo ─────────────────────────────

describe("Pipedrive/Kommo: cuenta obligatoria", () => {
  const callback = async () => {
    const state = util.encrypt(JSON.stringify({ t: tenant, u: user, p: "pipedrive", n: "PD OAuth", v: null, exp: Date.now() + 600_000 }));
    return app.inject({ method: "GET", url: `/v1/crm/oauth/pipedrive/callback?code=c1&state=${encodeURIComponent(state)}`, cookies: { cs_session: session } });
  };
  const pdHandler = (me: (c: Call) => Response) => (c: Call) => {
    if (c.url === "https://oauth.pipedrive.com/oauth/token") return json(200, { access_token: "pd-at", refresh_token: "pd-rt", expires_in: 3599, api_domain: "https://acme.pipedrive.com" });
    if (c.url.startsWith("https://acme.pipedrive.com/api/v1/users/me")) return me(c);
    return json(404, {});
  };
  const count = async () => Number((await db.one<any>(`SELECT count(*)::int AS n FROM crm_connections WHERE tenant_id = $1 AND name = 'PD OAuth'`, [tenant]))!.n);

  it("el callback falla si la prueba falla o no informa company_id; con la cuenta, la guarda", async () => {
    handler = pdHandler(() => json(500, { success: false, error: "caído" }));
    let r = await callback();
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain("error=token_exchange_failed");
    expect(await count()).toBe(0);

    handler = pdHandler(() => json(200, { success: true, data: { id: 1, company_domain: "acme" } }));
    r = await callback();
    expect(r.headers.location).toContain("error=token_exchange_failed");
    expect(await count()).toBe(0);

    handler = pdHandler(() => json(200, { success: true, data: { id: 1, company_id: 5150, company_domain: "acme" } }));
    r = await callback();
    expect(r.headers.location).toContain("connected=pipedrive");
    const row = await db.one<any>(`SELECT config FROM crm_connections WHERE tenant_id = $1 AND name = 'PD OAuth'`, [tenant]);
    expect(row!.config.companyId).toBe("5150");
  });

  it("envío: sin cuenta guardada 409, sin companyId 400, de otra cuenta 409; ?companyId no lista mapeos sin cuenta", async () => {
    const noAcc = await crmConn("pipedrive", { config: { apiDomain: "https://acme.pipedrive.com" } });
    const mNoAcc = await crmMapping(noAcc);
    let r = await app.inject({ method: "POST", url: `/v1/crm/mappings/${mNoAcc}/send`, headers: auth, payload: { objectId: "42", companyId: "5150" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("crm_account_unknown");

    const acc = await crmConn("kommo", { config: { baseDomain: "https://acme.kommo.com", accountId: "31337" } });
    const mAcc = await crmMapping(acc);
    r = await app.inject({ method: "POST", url: `/v1/crm/mappings/${mAcc}/send`, headers: auth, payload: { objectId: "42" } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("company_required");
    r = await app.inject({ method: "POST", url: `/v1/crm/mappings/${mAcc}/send`, headers: auth, payload: { objectId: "42", companyId: "999" } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("company_mismatch");

    const list = await app.inject({ method: "GET", url: `/v1/crm/mappings?provider=pipedrive&companyId=5150`, headers: auth });
    expect(list.json().items.map((x: any) => x.id)).not.toContain(mNoAcc);
    const kList = await app.inject({ method: "GET", url: `/v1/crm/mappings?provider=kommo&companyId=31337`, headers: auth });
    expect(kList.json().items.map((x: any) => x.id)).toContain(mAcc);
  });
});

// ───────────────────────────── 2. Webhook de conectores ─────────────────────────────

describe("webhook de conectores", () => {
  const post = (token: string, body: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: `/v1/integrations/connectors/hook/${token}`, headers: { "content-type": "application/json", ...headers }, payload: body });
  const runs = async (flowId: string) => Number((await db.one<any>(`SELECT count(*)::int AS n FROM connector_runs WHERE flow_id = $1`, [flowId]))!.n);

  it("la misma entrega se deduplica dentro de la ventana y vuelve a disparar después", async () => {
    const c = await connConn("bamboohr");
    const f = await connFlow(c.id);
    const body = JSON.stringify({ recordId: "e-1", event: "Created" });
    expect((await post(c.token, body)).json().queued).toBe(1);
    expect((await post(c.token, body)).json().queued).toBe(0);
    expect(await runs(f)).toBe(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    expect((await post(c.token, body)).json().queued).toBe(1);
    expect(await runs(f)).toBe(2);
  });

  it("flujo con secreto: sin firma o con otra 401; con X-CalaSign-Signature se encola; un flujo sin secreto no se afecta", async () => {
    const c = await connConn("bamboohr");
    const secret = "s3cret-0123456789abcdef";
    const signedFlow = await connFlow(c.id, secret);
    const body = JSON.stringify({ recordId: "e-2" });
    let r = await post(c.token, body);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("invalid_signature");
    r = await post(c.token, body, { "x-calasign-signature": `sha256=${"a".repeat(64)}` });
    expect(r.statusCode).toBe(401);
    r = await post(c.token, body, { "x-calasign-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().queued).toBe(1);
    expect(await runs(signedFlow)).toBe(1);

    // Con un flujo sin secreto en la misma conexión: la entrega sin firma dispara ese y no el firmado.
    const open = await connFlow(c.id);
    const b2 = JSON.stringify({ recordId: "e-3" });
    r = await post(c.token, b2);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ queued: 1, rejected: 1 });
    expect(await runs(open)).toBe(1);
    expect(await runs(signedFlow)).toBe(1);
  });

  it("el secreto se configura por la API, no se devuelve y queda auditado", async () => {
    const c = await connConn("bamboohr");
    const f = await connFlow(c.id);
    const r = await app.inject({ method: "PATCH", url: `/v1/connectors/flows/${f}`, headers: auth, payload: { webhookSecret: "otro-secreto-1234567" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().webhookSigned).toBe(true);
    expect(JSON.stringify(r.json())).not.toContain("otro-secreto");
    const cleared = await app.inject({ method: "PATCH", url: `/v1/connectors/flows/${f}`, headers: auth, payload: { webhookSecret: null } });
    expect(cleared.json().webhookSigned).toBe(false);
    const a = await audits("connector.flow_updated", f);
    expect(a.length).toBe(2);
    expect(JSON.stringify(a)).not.toContain("otro-secreto");
  });

  it("firmas de HiBob (Bob-Signature) y Factorial (challenge)", async () => {
    const { verifyHookSignature } = await import("../src/modules/connectors/providers");
    const raw = '{"type":"employee.created","employee":{"id":"7"}}';
    const bob = createHmac("sha512", "hb-secret").update(raw).digest("base64");
    expect(verifyHookSignature("hibob", "hb-secret", raw, { "bob-signature": bob })).toBe(true);
    expect(verifyHookSignature("hibob", "otro", raw, { "bob-signature": bob })).toBe(false);
    expect(verifyHookSignature("factorial", "fa-challenge", raw, { "x-factorial-wh-challenge": "fa-challenge" })).toBe(true);
    expect(verifyHookSignature("bamboohr", "x", raw, { "bob-signature": bob })).toBe(false);
  });
});

// ───────────────────────────── 3. Desconectar ─────────────────────────────

describe("desconectar revoca tokens y conserva la actividad", () => {
  it("HubSpot OAuth: DELETE del refresh token; ejecuciones conservadas con nombre y proveedor; auditado", async () => {
    const id = await crmConn("hubspot", { creds: { access_token: "hs-at", refresh_token: "hs-rt", expires_at: Date.now() + 3_600_000 }, config: { portalId: "1" } });
    const runId = util.uuidv7();
    await db.query(`INSERT INTO crm_runs (id, tenant_id, connection_id, kind, status) VALUES ($1,$2,$3,'send','succeeded')`, [runId, tenant, id]);
    handler = (c) => (c.method === "DELETE" && c.url.endsWith("/oauth/v1/refresh-tokens/hs-rt") ? new Response(null, { status: 204 }) : json(404, {}));
    const r = await app.inject({ method: "DELETE", url: `/v1/crm/connections/${id}`, headers: auth });
    expect(r.statusCode).toBe(204);
    expect(calls.some((c) => c.method === "DELETE" && c.url === "https://api.hubapi.com/oauth/v1/refresh-tokens/hs-rt")).toBe(true);
    const run = await db.one<any>(`SELECT * FROM crm_runs WHERE id = $1`, [runId]);
    expect(run!.connection_id).toBeNull();
    const listed = (await app.inject({ method: "GET", url: `/v1/crm/runs`, headers: auth })).json().items.find((x: any) => x.id === runId);
    expect(listed).toMatchObject({ provider: "hubspot", connectionId: null });
    expect(listed.connectionName).toContain("hubspot");
    expect((await audits("crm.disconnected", id))[0].data.tokenRevoked).toBe(true);
  });

  it("si la revocación falla, desconecta igual", async () => {
    const id = await crmConn("pipedrive", { config: { apiDomain: "https://acme.pipedrive.com", companyId: "1" } });
    handler = () => json(500, {});
    const r = await app.inject({ method: "DELETE", url: `/v1/crm/connections/${id}`, headers: auth });
    expect(r.statusCode).toBe(204);
    expect(calls.some((c) => c.url === "https://oauth.pipedrive.com/oauth/revoke" && c.headers.authorization?.startsWith("Basic "))).toBe(true);
    expect(await db.one(`SELECT 1 FROM crm_connections WHERE id = $1`, [id])).toBeNull();
    expect((await audits("crm.disconnected", id))[0].data.tokenRevoked).toBe("failed");
  });

  it("Salesforce y Zoho: endpoints de revocación; Kommo y tokens de HubSpot: nada que revocar", async () => {
    const { CrmConn, revokeCrmTokens } = await import("../src/modules/crm/providers");
    const mk = (provider: string, auth_type: string, creds: unknown, config: Record<string, unknown> = {}) =>
      new CrmConn({ id: "x", provider: provider as any, auth_type: auth_type as any, credentials_enc: util.encrypt(JSON.stringify(creds)), config }, null);
    handler = () => new Response(null, { status: 200 });
    expect(await revokeCrmTokens(mk("salesforce", "oauth", { access_token: "a", refresh_token: "sf-rt" }, { instanceUrl: "https://acme.my.salesforce.com" }))).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: "https://acme.my.salesforce.com/services/oauth2/revoke", body: "token=sf-rt" });
    expect(await revokeCrmTokens(mk("zoho", "oauth", { access_token: "a", refresh_token: "zo-rt" }, { accountsServer: "https://accounts.zoho.eu" }))).toBe(true);
    expect(calls.at(-1)!.url).toBe("https://accounts.zoho.eu/oauth/v2/token/revoke?token=zo-rt");
    const n = calls.length;
    expect(await revokeCrmTokens(mk("kommo", "oauth", { access_token: "a", refresh_token: "r" }, { baseDomain: "https://acme.kommo.com" }))).toBe(false);
    expect(await revokeCrmTokens(mk("hubspot", "token", { token: "pat" }))).toBe(false);
    expect(calls.length).toBe(n);
  });

  it("conector Factorial OAuth: POST /oauth/revoke; actividad conservada", async () => {
    const c = await connConn("factorial", { auth: "oauth", creds: { access_token: "fa-at", refresh_token: "fa-rt" } });
    const runId = util.uuidv7();
    await db.query(`INSERT INTO connector_runs (id, tenant_id, connection_id, kind, status) VALUES ($1,$2,$3,'send','failed')`, [runId, tenant, c.id]);
    handler = () => new Response("{}", { status: 200 });
    const r = await app.inject({ method: "DELETE", url: `/v1/connectors/connections/${c.id}`, headers: auth });
    expect(r.statusCode).toBe(204);
    const revoke = calls.find((x) => x.url === "https://api.factorialhr.com/oauth/revoke");
    expect(revoke?.body).toContain("token=fa-rt");
    expect(revoke?.body).toContain("client_id=fa-client");
    const run = await db.one<any>(`SELECT connection_id, detail FROM connector_runs WHERE id = $1`, [runId]);
    expect(run!.connection_id).toBeNull();
    expect(run!.detail.connection.provider).toBe("factorial");
  });
});

// ───────────────────────────── 4. HubSpot ─────────────────────────────

describe("HubSpot", () => {
  it("adjunto: guarda el archivo antes de la nota y, al reintentar, no lo vuelve a subir", async () => {
    const { CrmConn, attachSigned } = await import("../src/modules/crm/providers");
    const conn = new CrmConn({ id: "x", provider: "hubspot", auth_type: "token", credentials_enc: util.encrypt(JSON.stringify({ token: "pat" })), config: {} }, null);
    let noteFails = true;
    handler = (c) => {
      if (c.url.endsWith("/files/v3/files")) return json(200, { id: "f-1" });
      if (c.url.endsWith("/crm/v3/objects/notes")) return noteFails ? json(500, { message: "caído" }) : json(201, { id: "n-1" });
      return json(404, {});
    };
    const saved: string[] = [];
    const input = { fileName: "a.pdf", pdf: new Uint8Array([37, 80, 68, 70]), subject: "S", envelopeId: "e", sha256: "h", url: "u", onFileUploaded: async (id: string) => void saved.push(id) };
    await expect(attachSigned(conn, "deal", "42", input)).rejects.toThrow();
    expect(saved).toEqual(["f-1"]);
    noteFails = false;
    calls = [];
    const ref = await attachSigned(conn, "deal", "42", { ...input, uploadedFileId: "f-1" });
    expect(ref).toBe("file:f-1 note:n-1");
    expect(calls.some((c) => c.url.endsWith("/files/v3/files"))).toBe(false);
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/notes"))!.body).properties.hs_attachment_ids).toBe("f-1");
  });

  it("token de app privada: sin account-info (o sin portalId) la prueba falla", async () => {
    const { CrmConn, testConnection } = await import("../src/modules/crm/providers");
    const conn = () => new CrmConn({ id: "x", provider: "hubspot", auth_type: "token", credentials_enc: util.encrypt(JSON.stringify({ token: "pat" })), config: {} }, null);
    handler = (c) => (c.url.includes("/account-info/") ? json(403, { message: "missing scopes" }) : json(200, { results: [] }));
    await expect(testConnection(conn())).rejects.toThrow();
    handler = (c) => (c.url.includes("/account-info/") ? json(200, { uiDomain: "app.hubspot.com" }) : json(200, { results: [] }));
    await expect(testConnection(conn())).rejects.toThrow(/portal/);
    handler = (c) => (c.url.includes("/account-info/") ? json(200, { portalId: 777, uiDomain: "app.hubspot.com" }) : json(200, { results: [] }));
    expect((await testConnection(conn())).config).toEqual({ portalId: "777" });
  });

  it("webhook: los cambios hechos por la propia app no disparan; los de un usuario sí", async () => {
    const { hubspotSignatureV3, isOwnHubspotChange } = await import("../src/modules/crm");
    const { config } = await import("../src/config");
    const id = await crmConn("hubspot", { config: { portalId: "4242" } });
    const m = await crmMapping(id, { trigger: "webhook", triggerConfig: { property: "dealstage", value: "contractsent" } });
    const send = (events: unknown[]) => {
      const raw = JSON.stringify(events);
      const ts = String(Date.now());
      const url = "/v1/integrations/crm/hubspot/webhook";
      return app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json", "x-hubspot-request-timestamp": ts, "x-hubspot-signature-v3": hubspotSignatureV3("hs-secret", "POST", `${config.appUrl}${url}`, raw, ts) },
        payload: raw,
      });
    };
    const base = { subscriptionType: "deal.propertyChange", portalId: 4242, appId: 555, objectId: 9, propertyName: "dealstage", propertyValue: "contractsent" };
    let r = await send([{ ...base, eventId: 1, changeSource: "INTEGRATION", sourceId: "555" }]);
    expect(r.json().queued).toBe(0);
    r = await send([{ ...base, eventId: 2, changeSource: "CRM_UI", sourceId: "userId:1" }]);
    expect(r.json().queued).toBe(1);
    expect(await db.one(`SELECT 1 FROM crm_runs WHERE mapping_id = $1`, [m])).not.toBeNull();
    expect(isOwnHubspotChange({ changeSource: "INTEGRATION", sourceId: "999", appId: 555 })).toBe(false);
  });

  it("mapeo cuya propiedad de write-back es la que dispara: 400 crm_trigger_loop (al crear y al editar)", async () => {
    const id = await crmConn("hubspot", { config: { portalId: "1" } });
    const r = await app.inject({
      method: "POST",
      url: "/v1/crm/mappings",
      headers: auth,
      payload: { connectionId: id, name: "loop", objectType: "deal", templateId: template, trigger: "webhook", triggerConfig: { property: "dealstage" }, writeBack: { statusProperty: "DealStage" } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("crm_trigger_loop");
    const m = await crmMapping(id, { trigger: "webhook", triggerConfig: { property: "dealstage" } });
    const p = await app.inject({ method: "PATCH", url: `/v1/crm/mappings/${m}`, headers: auth, payload: { writeBack: { statusProperty: "dealstage" } } });
    expect(p.statusCode).toBe(400);
    expect(p.json().error.code).toBe("crm_trigger_loop");
  });
});

// ───────────────────────────── 5. Retención y auditoría ─────────────────────────────

describe("retención de ejecuciones", () => {
  it("borra las ejecuciones más viejas que la retención y conserva las recientes", async () => {
    const { purgeOldIntegrationRuns } = await import("../src/modules/retention");
    const c = await crmConn("hubspot", { config: { portalId: "2" } });
    const k = await connConn("bamboohr");
    const [oldCrm, newCrm, oldCn] = [util.uuidv7(), util.uuidv7(), util.uuidv7()];
    await db.query(`INSERT INTO crm_runs (id, tenant_id, connection_id, kind, created_at) VALUES ($1,$2,$3,'send', now() - interval '200 days'), ($4,$2,$3,'send', now() - interval '10 days')`, [oldCrm, tenant, c, newCrm]);
    await db.query(`INSERT INTO connector_runs (id, tenant_id, connection_id, kind, created_at) VALUES ($1,$2,$3,'send', now() - interval '181 days')`, [oldCn, tenant, k.id]);
    const out = await purgeOldIntegrationRuns(db, 180);
    expect(out.crm_runs).toBeGreaterThanOrEqual(1);
    expect(out.connector_runs).toBeGreaterThanOrEqual(1);
    expect(await db.one(`SELECT 1 FROM crm_runs WHERE id = $1`, [oldCrm])).toBeNull();
    expect(await db.one(`SELECT 1 FROM crm_runs WHERE id = $1`, [newCrm])).not.toBeNull();
    expect(await db.one(`SELECT 1 FROM connector_runs WHERE id = $1`, [oldCn])).toBeNull();
  });
});

describe("auditoría", () => {
  it("desactivar/activar conexiones y editar/borrar mapeos y flujos queda registrado", async () => {
    const c = await crmConn("hubspot", { config: { portalId: "3" } });
    await app.inject({ method: "PATCH", url: `/v1/crm/connections/${c}`, headers: auth, payload: { active: false } });
    await app.inject({ method: "PATCH", url: `/v1/crm/connections/${c}`, headers: auth, payload: { active: true } });
    expect((await audits("crm.deactivated", c)).length).toBe(1);
    expect((await audits("crm.activated", c)).length).toBe(1);
    const m = await crmMapping(c);
    expect((await app.inject({ method: "PATCH", url: `/v1/crm/mappings/${m}`, headers: auth, payload: { name: "nuevo" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/crm/mappings/${m}`, headers: auth })).statusCode).toBe(204);
    expect((await audits("crm.mapping_updated", m)).length).toBe(1);
    expect((await audits("crm.mapping_deleted", m)).length).toBe(1);

    const k = await connConn("bamboohr");
    await app.inject({ method: "PATCH", url: `/v1/connectors/connections/${k.id}`, headers: auth, payload: { active: false } });
    expect((await audits("connector.deactivated", k.id)).length).toBe(1);
    const f = await connFlow(k.id);
    expect((await app.inject({ method: "DELETE", url: `/v1/connectors/flows/${f}`, headers: auth })).statusCode).toBe(204);
    expect((await audits("connector.flow_deleted", f)).length).toBe(1);
  });
});
