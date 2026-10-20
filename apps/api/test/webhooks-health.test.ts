// Webhooks salientes: desactivación automática (410 Gone, racha de fallas, credencial sin permisos), fanout idempotente
// (event_id determinístico + UNIQUE), retención de entregas, tope que no cuenta inactivos viejos y reintento manual con
// el endpoint inactivo (409). App real sobre PGlite y un receptor HTTP local.
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-webhooks-health-"));
delete process.env.DATABASE_URL;

const mails: { to: string; subject: string; text: string; html?: string; from?: string }[] = [];
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { to: string; subject: string; text: string; html?: string; from?: string }) => {
    mails.push({ to: m.to, subject: m.subject, text: m.text, html: m.html, from: m.from });
    return { provider: "smtp", messageId: `id-${mails.length}` };
  }),
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let wh: typeof import("../src/modules/webhooks");
let config: typeof import("../src/config")["config"];
let server: http.Server;
let base = "";
let status = 200;
let hits = 0;
/** Se ejecuta en el receptor antes de responder (p. ej. cambiar la URL del endpoint mientras se entrega). */
let onHit: (() => Promise<void>) | null = null;
const log = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  wh = await import("../src/modules/webhooks");
  config = (await import("../src/config")).config;
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      hits++;
      await onHit?.();
      res.statusCode = status;
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  server?.close();
  await app?.close();
  await db?.close();
});
beforeEach(() => {
  mails.length = 0;
  hits = 0;
  status = 200;
  onHit = null;
});

/** Corre los avisos de desactivación encolados (como el worker de la cola "webhook"). */
async function runNotices(tenantId: string) {
  const jobs = await db.query<any>(
    `SELECT id, payload FROM jobs WHERE queue = 'webhook' AND status = 'pending' AND payload->>'kind' = 'deactivated_notice' AND payload->>'tenantId' = $1 ORDER BY id`,
    [tenantId],
  );
  for (const j of jobs) {
    await wh.handleWebhookJob({ db, log }, j.payload, { attempts: 1, id: Number(j.id) });
    await db.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [j.id]);
  }
  return jobs.length;
}

/** Organización con una propietaria (recibe los avisos), una API key (rol a elección) y una sesión. */
async function org(keyRole = "admin") {
  const tenant = util.uuidv7();
  const user = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,'Ana','scrypt$x','en')`, [user, `ana-${tenant.slice(-8)}@x.test`]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenant, user]);
  const key = `cs_test_${util.randomToken(12)}`;
  const keyId = util.uuidv7();
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1, $2, 'k', 'cs_test', $3, $4)`, [keyId, tenant, util.sha256Hex(key), keyRole]);
  const env = util.uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [env, tenant]);
  return { tenant, user, keyId, env, auth: { authorization: `Bearer ${key}` } };
}

async function endpoint(tenant: string, extra: { apiKey?: string | null; oauthClient?: string | null; createdBy?: string | null; active?: boolean } = {}) {
  const id = util.uuidv7();
  await db.query(
    `INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, secret_prefix, active, created_by, created_by_api_key, oauth_client_id)
     VALUES ($1,$2,$3,$4,'whsec_x',$5,$6,$7,$8)`,
    [id, tenant, `${base}/hook?token=secreto`, util.encrypt("whsec_x"), extra.active ?? true, extra.createdBy ?? null, extra.apiKey ?? null, extra.oauthClient ?? null],
  );
  return id;
}

async function delivery(tenant: string, endpointId: string, envelopeId: string | null = null, createdAt = "now()") {
  const id = util.uuidv7();
  await db.query(
    `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, envelope_id, payload, created_at)
     VALUES ($1,$2,$3,$4,'envelope.sent',$5,'{"a":1}', ${createdAt})`,
    [id, tenant, endpointId, util.uuidv7(), envelopeId],
  );
  return id;
}

const ep = (id: string) => db.one<any>(`SELECT ep.*, ${wh.DEACTIVATED_REASON} FROM webhook_endpoints ep WHERE ep.id = $1`, [id]);

describe("event_id determinístico", () => {
  it("UUIDv5 estándar y estable por (sobre, seq, tipo)", () => {
    expect(util.uuidv5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    const e = util.uuidv7();
    expect(wh.webhookEventId(e, 3, "envelope.sent")).toBe(wh.webhookEventId(e, 3, "envelope.sent"));
    expect(wh.webhookEventId(e, 3, "envelope.sent")).not.toBe(wh.webhookEventId(e, 4, "envelope.sent"));
    expect(wh.webhookEventId(e, 3, "envelope.sent")).not.toBe(wh.webhookEventId(e, 3, "recipient.signed"));
  });

  it("re-ejecutar el fanout no duplica entregas ni trabajos", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    const job = { kind: "fanout" as const, tenantId: o.tenant, envelopeId: o.env, seq: 7, type: "envelope.sent", recipientId: null };
    await wh.handleWebhookJob({ db, log }, job);
    await wh.handleWebhookJob({ db, log }, job);
    const rows = await db.query<any>(`SELECT id, event_id FROM webhook_deliveries WHERE endpoint_id = $1`, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(wh.webhookEventId(o.env, 7, "envelope.sent"));
    const jobs = await db.query(`SELECT 1 FROM jobs WHERE queue = 'webhook' AND payload->>'deliveryId' = $1`, [rows[0].id]);
    expect(jobs).toHaveLength(1);
    // Otro seq del mismo sobre sí es otro evento.
    await wh.handleWebhookJob({ db, log }, { ...job, seq: 8 });
    expect(await db.query(`SELECT 1 FROM webhook_deliveries WHERE endpoint_id = $1`, [id])).toHaveLength(2);
  });
});

describe("desactivación automática", () => {
  it("410 Gone de una integración: desactiva en el acto, sin reintento, con auditoría y aviso encolado", async () => {
    const o = await org();
    const id = await endpoint(o.tenant, { apiKey: o.keyId });
    const d = await delivery(o.tenant, id);
    status = 410;
    await expect(wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: d }, { attempts: 1 })).resolves.toBeUndefined();
    const row = await db.one<any>(`SELECT status, next_retry_at FROM webhook_deliveries WHERE id = $1`, [d]);
    expect(row).toMatchObject({ status: "failed", next_retry_at: null });
    const e = await ep(id);
    expect(e.active).toBe(false);
    expect(wh.toEndpoint(e).deactivatedReason).toBe("gone");
    expect(e.deactivated_at).not.toBeNull();
    const audit = await db.query<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'webhook.deactivated'`, [o.tenant]);
    expect(audit.map((a) => a.data.reason)).toEqual(["gone"]);
    // El correo no sale en la entrega: se encola (un job por endpoint y motivo).
    expect(mails).toHaveLength(0);
    expect(await runNotices(o.tenant)).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain("disabled");
    // Solo el host: no el ?token= de la URL.
    expect(mails[0].text).toContain("127.0.0.1");
    expect(mails[0].text).not.toContain("secreto");
  });

  it("410 Gone de un endpoint creado a mano: falla definitiva (racha), no lo desactiva", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    const d = await delivery(o.tenant, id);
    status = 410;
    await expect(wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: d }, { attempts: 1 })).resolves.toBeUndefined();
    expect(await db.one<any>(`SELECT status, next_retry_at FROM webhook_deliveries WHERE id = $1`, [d])).toMatchObject({ status: "failed", next_retry_at: null });
    const e = await ep(id);
    expect(e).toMatchObject({ active: true, consecutive_failures: 1 });
    expect(await runNotices(o.tenant)).toBe(0);
  });

  it("410 Gone de la URL vieja: no desactiva el endpoint al que le cambiaron la URL durante la entrega", async () => {
    const o = await org();
    const id = await endpoint(o.tenant, { apiKey: o.keyId });
    status = 410;
    onHit = async () => {
      await db.query(`UPDATE webhook_endpoints SET url = 'https://example.com/nueva' WHERE id = $1`, [id]);
    };
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 1 });
    expect(await ep(id)).toMatchObject({ active: true, url: "https://example.com/nueva", consecutive_failures: 0 });
  });

  it("50 fallas en 15 minutos no lo desactivan; con la racha y 72 h fallando, sí", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    status = 500;
    for (let i = 0; i < 50; i++) await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
    expect(await ep(id)).toMatchObject({ active: true, consecutive_failures: 50 });
    await db.query(`UPDATE webhook_endpoints SET failing_since = now() - interval '15 minutes' WHERE id = $1`, [id]);
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
    expect((await ep(id)).active).toBe(true);
    await db.query(`UPDATE webhook_endpoints SET failing_since = now() - interval '73 hours' WHERE id = $1`, [id]);
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
    expect(wh.toEndpoint(await ep(id)).deactivatedReason).toBe("failing");
  });

  it("racha de fallas definitivas: desactiva con 'failing'; un éxito la reinicia", async () => {
    const prev = config.webhooks.maxConsecutiveFailures;
    const prevHours = config.webhooks.failingMinHours;
    config.webhooks.maxConsecutiveFailures = 3;
    config.webhooks.failingMinHours = 0;
    try {
      const o = await org();
      const id = await endpoint(o.tenant);
      status = 500;
      // Un intento que se va a reintentar no cuenta.
      const first = await delivery(o.tenant, id);
      await expect(wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: first }, { attempts: 1 })).rejects.toThrow();
      expect((await ep(id)).consecutive_failures).toBe(0);
      // Último intento (8): falla definitiva.
      for (let i = 0; i < 2; i++) await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
      expect((await ep(id)).consecutive_failures).toBe(2);
      // Un reintento manual fallido tampoco cuenta.
      await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id), manual: true }, { attempts: 1 });
      expect((await ep(id)).consecutive_failures).toBe(2);
      // Un éxito reinicia la racha.
      status = 200;
      await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 1 });
      let e = await ep(id);
      expect(e.consecutive_failures).toBe(0);
      expect(e.failing_since).toBeNull();
      expect(e.last_success_at).not.toBeNull();
      status = 500;
      for (let i = 0; i < 3; i++) await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
      e = await ep(id);
      expect(e.active).toBe(false);
      expect(wh.toEndpoint(e).deactivatedReason).toBe("failing");
      expect(await runNotices(o.tenant)).toBe(1);
      expect(mails).toHaveLength(1);
      // Inactivo: la siguiente entrega automática no sale.
      const before = hits;
      await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 1 });
      expect(hits).toBe(before);
    } finally {
      config.webhooks.maxConsecutiveFailures = prev;
      config.webhooks.failingMinHours = prevHours;
    }
  });

  it("días fallando sin éxito: desactiva aunque no llegue al tope de fallas", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    await db.query(`UPDATE webhook_endpoints SET consecutive_failures = 2, failing_since = now() - interval '8 days' WHERE id = $1`, [id]);
    status = 503;
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
    expect(wh.toEndpoint(await ep(id)).deactivatedReason).toBe("failing");
  });

  it("la credencial de origen pierde los permisos: 'permission_lost'", async () => {
    // API key con rol member (sin webhooks:manage): se desactiva; la admin sigue.
    const o = await org("member");
    const lost = await endpoint(o.tenant, { apiKey: o.keyId });
    const adminKey = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1,$2,'k2','cs_test',$3,'admin')`, [adminKey, o.tenant, util.sha256Hex(adminKey)]);
    const kept = await endpoint(o.tenant, { apiKey: adminKey });
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect(wh.toEndpoint(await ep(lost)).deactivatedReason).toBe("permission_lost");
    expect((await ep(kept)).active).toBe(true);
    const audit = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'webhook.deactivated' AND target_id = $2`, [o.tenant, lost]);
    expect(audit.data).toMatchObject({ reason: "permission_lost", missing: ["webhooks:manage", "envelopes:view_all"] });

    // OAuth de un usuario: los permisos del usuario recortados a los scopes de sus tokens vigentes.
    const client = util.uuidv7();
    await db.query(`INSERT INTO oauth_clients (id, tenant_id, client_id, name, grant_types, scopes) VALUES ($1,$2,$3,'App','{authorization_code}','{webhooks:manage,envelopes:read}')`, [
      client,
      o.tenant,
      `cid-${client.slice(-8)}`,
    ]);
    const token = (scopes: string[]) =>
      db.query(`INSERT INTO oauth_tokens (id, token_hash, kind, client_id, tenant_id, user_id, scopes, family_id, expires_at) VALUES ($1,$2,'refresh',$3,$4,$5,$6,$1, now() + interval '30 days')`, [
        util.uuidv7(),
        util.randomToken(),
        client,
        o.tenant,
        o.user,
        scopes,
      ]);
    await token(["webhooks:manage", "envelopes:read"]);
    const oauthEp = await endpoint(o.tenant, { oauthClient: client, createdBy: o.user });
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect((await ep(oauthEp)).active).toBe(true);
    // El usuario vuelve a autorizar la app sin envelopes:read (los tokens anteriores se revocan).
    await db.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1`, [client]);
    await token(["webhooks:manage"]);
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect(wh.toEndpoint(await ep(oauthEp)).deactivatedReason).toBe("permission_lost");
  });

  it("refresh tokens ya usados no cuentan como autorización vigente", async () => {
    const o = await org();
    const client = util.uuidv7();
    await db.query(`INSERT INTO oauth_clients (id, tenant_id, client_id, name, grant_types, scopes) VALUES ($1,$2,$3,'App','{authorization_code}','{webhooks:manage,envelopes:read}')`, [
      client,
      o.tenant,
      `cid-${client.slice(-8)}`,
    ]);
    const token = (scopes: string[], used: boolean) =>
      db.query(
        `INSERT INTO oauth_tokens (id, token_hash, kind, client_id, tenant_id, user_id, scopes, family_id, expires_at, used_at)
         VALUES ($1,$2,'refresh',$3,$4,$5,$6,$1, now() + interval '30 days', CASE WHEN $7 THEN now() END)`,
        [util.uuidv7(), util.randomToken(), client, o.tenant, o.user, scopes, used],
      );
    // Solo un refresh usado (rotado): la app ya no está conectada.
    await token(["webhooks:manage", "envelopes:read"], true);
    const orphan = await endpoint(o.tenant, { oauthClient: client, createdBy: o.user, active: false });
    expect(wh.toEndpoint(await ep(orphan)).deactivatedReason).toBe("credential_revoked");
    // Con uno vigente sin envelopes:read: los scopes del usado no suman.
    await token(["webhooks:manage"], false);
    await db.query(`UPDATE webhook_endpoints SET active = true WHERE id = $1`, [orphan]);
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect(wh.toEndpoint(await ep(orphan)).deactivatedReason).toBe("permission_lost");
  });

  it("client_credentials: la key de servicio se recorta a los scopes vigentes de la app", async () => {
    const o = await org();
    const client = util.uuidv7();
    await db.query(`INSERT INTO oauth_clients (id, tenant_id, client_id, name, grant_types, scopes) VALUES ($1,$2,$3,'Svc','{client_credentials}','{webhooks:manage,envelopes:read}')`, [
      client,
      o.tenant,
      `cid-${client.slice(-8)}`,
    ]);
    const svcKey = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role, oauth_client_id) VALUES ($1,$2,'svc','oauth',$3,'admin',$4)`, [svcKey, o.tenant, util.sha256Hex(svcKey), client]);
    await db.query(`UPDATE oauth_clients SET service_api_key_id = $2 WHERE id = $1`, [client, svcKey]);
    const id = await endpoint(o.tenant, { apiKey: svcKey });
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect((await ep(id)).active).toBe(true);
    // Le quitan envelopes:read a la app (el rol de la key sigue siendo admin).
    await db.query(`UPDATE oauth_clients SET scopes = '{webhooks:manage}' WHERE id = $1`, [client]);
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect(wh.toEndpoint(await ep(id)).deactivatedReason).toBe("permission_lost");
  });

  it("el aviso sale con la marca de la organización y una sola vez por desactivación", async () => {
    const o = await org("member");
    await db.query(`UPDATE tenants SET branding = $2::jsonb WHERE id = $1`, [o.tenant, JSON.stringify({ whiteLabel: { productName: "FirmaYa" } })]);
    const id = await endpoint(o.tenant, { apiKey: o.keyId });
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect(await runNotices(o.tenant)).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain("FirmaYa");
    expect(mails[0].subject).not.toContain("CalaSign");
    expect(mails[0].html).toContain("127.0.0.1");
    expect(mails[0].text).toContain("/app/settings/integrations");
    expect(mails[0].text).not.toContain("secreto");
    // Un reintento del mismo job no repite el correo.
    const job = await db.one<any>(`SELECT id, payload FROM jobs WHERE queue = 'webhook' AND payload->>'endpointId' = $1`, [id]);
    await wh.handleWebhookJob({ db, log }, job.payload, { attempts: 2, id: Number(job.id) });
    expect(mails).toHaveLength(1);
  });

  it("el chequeo de permisos se cachea por organización", async () => {
    const o = await org("admin");
    const id = await endpoint(o.tenant, { apiKey: o.keyId });
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant);
    await db.query(`UPDATE api_keys SET role = 'member' WHERE id = $1`, [o.keyId]);
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant);
    expect((await ep(id)).active).toBe(true);
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect((await ep(id)).active).toBe(false);
  });
});

describe("rutas", () => {
  it("reintento manual con el endpoint inactivo: 409 endpoint_inactive", async () => {
    const o = await org();
    const id = await endpoint(o.tenant, { active: false });
    const d = await delivery(o.tenant, id);
    await db.query(`UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1`, [d]);
    const r = await app.inject({ method: "POST", url: `/v1/webhook-deliveries/${d}/retry`, headers: o.auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().code ?? r.json().error?.code).toBe("endpoint_inactive");
    await db.query(`UPDATE webhook_endpoints SET active = true WHERE id = $1`, [id]);
    expect((await app.inject({ method: "POST", url: `/v1/webhook-deliveries/${d}/retry`, headers: o.auth })).statusCode).toBe(202);
  });

  it("el tope de 20 no cuenta los inactivos de hace más de 30 días; reactivar uno vuelve a contar", async () => {
    const o = await org();
    const old = await endpoint(o.tenant, { active: false });
    await db.query(`UPDATE webhook_endpoints SET deactivated_at = now() - interval '31 days' WHERE id = $1`, [old]);
    for (let i = 0; i < 19; i++) await endpoint(o.tenant);
    const create = () => app.inject({ method: "POST", url: "/v1/webhooks", headers: o.auth, payload: { url: "https://example.com/h" } });
    expect((await create()).statusCode).toBe(201);
    const full = await create();
    expect(full.statusCode).toBe(400);
    const react = await app.inject({ method: "PATCH", url: `/v1/webhooks/${old}`, headers: o.auth, payload: { active: true } });
    expect(react.statusCode).toBe(400);
    // Pausar uno (cuenta 30 días más) no libera lugar; con uno borrado, sí se reactiva.
    const any = (await db.one<any>(`SELECT id FROM webhook_endpoints WHERE tenant_id = $1 AND active LIMIT 1`, [o.tenant]))!.id;
    expect((await app.inject({ method: "DELETE", url: `/v1/webhooks/${any}`, headers: o.auth })).statusCode).toBe(204);
    const ok = await app.inject({ method: "PATCH", url: `/v1/webhooks/${old}`, headers: o.auth, payload: { active: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().active).toBe(true);
  });

  it("tope absoluto de 100 webhooks por organización, contando los inactivos viejos", async () => {
    const o = await org();
    for (let i = 0; i < wh.MAX_WEBHOOKS_TOTAL; i++) {
      const id = await endpoint(o.tenant, { active: false });
      await db.query(`UPDATE webhook_endpoints SET deactivated_at = now() - interval '40 days' WHERE id = $1`, [id]);
    }
    const r = await app.inject({ method: "POST", url: "/v1/webhooks", headers: o.auth, payload: { url: "https://example.com/h" } });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toContain("máximo 100");
    // Borrando uno, se puede crear.
    const one = (await db.one<any>(`SELECT id FROM webhook_endpoints WHERE tenant_id = $1 LIMIT 1`, [o.tenant]))!.id;
    expect((await app.inject({ method: "DELETE", url: `/v1/webhooks/${one}`, headers: o.auth })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/webhooks", headers: o.auth, payload: { url: "https://example.com/h" } })).statusCode).toBe(201);
  });

  it("reactivar uno desactivado por fallas limpia el motivo y la racha", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    await db.query(
      `UPDATE webhook_endpoints SET active = false, auto_deactivated_reason = 'failing', deactivated_at = now(), consecutive_failures = 50, failing_since = now() WHERE id = $1`,
      [id],
    );
    const list = await app.inject({ method: "GET", url: `/v1/webhooks/${id}`, headers: o.auth });
    expect(list.json().deactivatedReason).toBe("failing");
    const r = await app.inject({ method: "PATCH", url: `/v1/webhooks/${id}`, headers: o.auth, payload: { active: true } });
    expect(r.json()).toMatchObject({ active: true, deactivatedReason: null });
    const e = await ep(id);
    expect(e).toMatchObject({ consecutive_failures: 0, failing_since: null, auto_deactivated_reason: null, deactivated_at: null });
    // Pausarlo a mano: inactivo sin motivo, con fecha.
    const p = await app.inject({ method: "PATCH", url: `/v1/webhooks/${id}`, headers: o.auth, payload: { active: false } });
    expect(p.json()).toMatchObject({ active: false, deactivatedReason: null });
    expect((await ep(id)).deactivated_at).not.toBeNull();
  });
});

describe("retención de entregas", () => {
  it("purga las viejas y las del sobre purgado o borrado", async () => {
    const { purgeOldWebhookDeliveries, purgeExpiredEnvelopes } = await import("../src/modules/retention");
    const { createBlobStore } = await import("../src/infra/storage");
    const o = await org();
    const id = await endpoint(o.tenant);
    const old = await delivery(o.tenant, id, null, "now() - interval '91 days'");
    const recent = await delivery(o.tenant, id);
    expect(await purgeOldWebhookDeliveries(db, 90)).toBeGreaterThanOrEqual(1);
    expect(await db.one(`SELECT 1 FROM webhook_deliveries WHERE id = $1`, [old])).toBeNull();
    expect(await db.one(`SELECT 1 FROM webhook_deliveries WHERE id = $1`, [recent])).not.toBeNull();

    // Sobre terminado con retención vencida: sus entregas se borran con la purga.
    await db.query(`UPDATE tenants SET retention_days = 1 WHERE id = $1`, [o.tenant]);
    await db.query(`UPDATE envelopes SET status = 'voided', voided_at = now() - interval '3 days' WHERE id = $1`, [o.env]);
    const ofEnv = await delivery(o.tenant, id, o.env);
    await purgeExpiredEnvelopes({ db, blobs: createBlobStore(), log }, { tenantId: o.tenant });
    expect(await db.one(`SELECT purged_at FROM envelopes WHERE id = $1`, [o.env])).toMatchObject({ purged_at: expect.anything() });
    expect(await db.one(`SELECT 1 FROM webhook_deliveries WHERE id = $1`, [ofEnv])).toBeNull();

    // Borrador borrado: sus entregas también.
    const draft = util.uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Borrador', 'draft')`, [draft, o.tenant]);
    const ofDraft = await delivery(o.tenant, id, draft);
    expect((await app.inject({ method: "DELETE", url: `/v1/envelopes/${draft}`, headers: o.auth })).statusCode).toBe(204);
    expect(await db.one(`SELECT 1 FROM webhook_deliveries WHERE id = $1`, [ofDraft])).toBeNull();
  });
});
