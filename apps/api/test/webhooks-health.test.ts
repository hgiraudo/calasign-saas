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

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let wh: typeof import("../src/modules/webhooks");
let config: (typeof import("../src/config"))["config"];
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
  await db.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,'Ana','scrypt$x','en')`, [
    user,
    `ana-${tenant.slice(-8)}@x.test`,
  ]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenant, user]);
  const key = `cs_test_${util.randomToken(12)}`;
  const keyId = util.uuidv7();
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1, $2, 'k', 'cs_test', $3, $4)`, [
    keyId,
    tenant,
    util.sha256Hex(key),
    keyRole,
  ]);
  const env = util.uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [env, tenant]);
  return { tenant, user, keyId, env, auth: { authorization: `Bearer ${key}` } };
}

async function endpoint(
  tenant: string,
  extra: { apiKey?: string | null; oauthClient?: string | null; createdBy?: string | null; active?: boolean } = {},
) {
  const id = util.uuidv7();
  await db.query(
    `INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, secret_prefix, active, created_by, created_by_api_key, oauth_client_id)
     VALUES ($1,$2,$3,$4,'whsec_x',$5,$6,$7,$8)`,
    [
      id,
      tenant,
      `${base}/hook?token=secreto`,
      util.encrypt("whsec_x"),
      extra.active ?? true,
      extra.createdBy ?? null,
      extra.apiKey ?? null,
      extra.oauthClient ?? null,
    ],
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
    expect(await db.one<any>(`SELECT status, next_retry_at FROM webhook_deliveries WHERE id = $1`, [d])).toMatchObject({
      status: "failed",
      next_retry_at: null,
    });
    const e = await ep(id);
    expect(e).toMatchObject({ active: true, consecutive_failures: 1 });
    expect(await runNotices(o.tenant)).toBe(0);
  });

  it("job abandonado (worker caído en el último intento): la entrega pasa a failed y suma a la racha; una manual, sin racha", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    const d1 = await delivery(o.tenant, id);
    await wh.webhookJobGaveUp({ db, log }, { kind: "deliver", deliveryId: d1 }, "worker caído");
    expect(await db.one<any>(`SELECT status, last_error FROM webhook_deliveries WHERE id = $1`, [d1])).toEqual({
      status: "failed",
      last_error: "worker caído",
    });
    expect((await ep(id)).consecutive_failures).toBe(1);
    // Idempotente: otra llamada (ya failed) no vuelve a contar.
    await wh.webhookJobGaveUp({ db, log }, { kind: "deliver", deliveryId: d1 }, "worker caído");
    expect((await ep(id)).consecutive_failures).toBe(1);
    // Manual (reintento o prueba): failed, pero no suma a la racha.
    const d2 = await delivery(o.tenant, id);
    await wh.webhookJobGaveUp({ db, log }, { kind: "deliver", deliveryId: d2, manual: true }, "worker caído");
    expect((await db.one<any>(`SELECT status FROM webhook_deliveries WHERE id = $1`, [d2]))!.status).toBe("failed");
    expect((await ep(id)).consecutive_failures).toBe(1);
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
    for (let i = 0; i < 50; i++)
      await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
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
      for (let i = 0; i < 2; i++)
        await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
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
      for (let i = 0; i < 3; i++)
        await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
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

  it("días fallando sin éxito: desactiva aunque no llegue al tope de fallas, con un mínimo de fallas seguidas", async () => {
    expect(config.webhooks.failingDaysMinFailures).toBe(5);
    const o = await org();
    const id = await endpoint(o.tenant);
    status = 503;
    // Dos fallas separadas por una semana (y esta, la tercera): no alcanza, sigue activo.
    await db.query(`UPDATE webhook_endpoints SET consecutive_failures = 2, failing_since = now() - interval '8 days' WHERE id = $1`, [id]);
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
    expect(await ep(id)).toMatchObject({ active: true, consecutive_failures: 3 });
    // Con la quinta falla seguida (y los 7 días), sí.
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
    expect(await ep(id)).toMatchObject({ active: true, consecutive_failures: 4 });
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
    expect(wh.toEndpoint(await ep(id)).deactivatedReason).toBe("failing");
  });

  it("el mínimo de fallas de los días fallando no supera el tope de la racha", async () => {
    const prev = config.webhooks.maxConsecutiveFailures;
    const prevHours = config.webhooks.failingMinHours;
    config.webhooks.maxConsecutiveFailures = 2;
    config.webhooks.failingMinHours = 1000;
    try {
      const o = await org();
      const id = await endpoint(o.tenant);
      await db.query(`UPDATE webhook_endpoints SET consecutive_failures = 1, failing_since = now() - interval '8 days' WHERE id = $1`, [id]);
      status = 503;
      await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, id) }, { attempts: 8 });
      expect(wh.toEndpoint(await ep(id)).deactivatedReason).toBe("failing");
    } finally {
      config.webhooks.maxConsecutiveFailures = prev;
      config.webhooks.failingMinHours = prevHours;
    }
  });

  it("la credencial de origen pierde los permisos: 'permission_lost'", async () => {
    // API key con rol member (sin webhooks:manage): se desactiva; la admin sigue.
    const o = await org("member");
    const lost = await endpoint(o.tenant, { apiKey: o.keyId });
    const adminKey = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1,$2,'k2','cs_test',$3,'admin')`, [
      adminKey,
      o.tenant,
      util.sha256Hex(adminKey),
    ]);
    const kept = await endpoint(o.tenant, { apiKey: adminKey });
    await wh.deactivateEndpointsWithoutPermission({ db, log }, o.tenant, { force: true });
    expect(wh.toEndpoint(await ep(lost)).deactivatedReason).toBe("permission_lost");
    expect((await ep(kept)).active).toBe(true);
    const audit = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'webhook.deactivated' AND target_id = $2`, [
      o.tenant,
      lost,
    ]);
    expect(audit.data).toMatchObject({ reason: "permission_lost", missing: ["webhooks:manage", "envelopes:view_all"] });

    // OAuth de un usuario: los permisos del usuario recortados a los scopes de sus tokens vigentes.
    const client = util.uuidv7();
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, grant_types, scopes) VALUES ($1,$2,$3,'App','{authorization_code}','{webhooks:manage,envelopes:read}')`,
      [client, o.tenant, `cid-${client.slice(-8)}`],
    );
    const token = (scopes: string[]) =>
      db.query(
        `INSERT INTO oauth_tokens (id, token_hash, kind, client_id, tenant_id, user_id, scopes, family_id, expires_at) VALUES ($1,$2,'refresh',$3,$4,$5,$6,$1, now() + interval '30 days')`,
        [util.uuidv7(), util.randomToken(), client, o.tenant, o.user, scopes],
      );
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
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, grant_types, scopes) VALUES ($1,$2,$3,'App','{authorization_code}','{webhooks:manage,envelopes:read}')`,
      [client, o.tenant, `cid-${client.slice(-8)}`],
    );
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
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, grant_types, scopes) VALUES ($1,$2,$3,'Svc','{client_credentials}','{webhooks:manage,envelopes:read}')`,
      [client, o.tenant, `cid-${client.slice(-8)}`],
    );
    const svcKey = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role, oauth_client_id) VALUES ($1,$2,'svc','oauth',$3,'admin',$4)`, [
      svcKey,
      o.tenant,
      util.sha256Hex(svcKey),
      client,
    ]);
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
    expect((await app.inject({ method: "POST", url: "/v1/webhooks", headers: o.auth, payload: { url: "https://example.com/h" } })).statusCode).toBe(
      201,
    );
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

describe("mismo evento en webhooks y GET /v1/events", () => {
  it("mismo id, y createdAt del webhook = occurredAt del evento (no la hora del fanout)", async () => {
    const { appendEvent } = await import("../src/infra/evidence");
    const { readEvents } = await import("../src/modules/devapi/events");
    const { loadAccess } = await import("../src/modules/access");
    const o = await org();
    const id = await endpoint(o.tenant);
    // Un rechazo produce dos eventos públicos (recipient.declined y envelope.declined), cada uno con su id.
    const { seq } = await db.tx((t) =>
      appendEvent(t, { tenantId: o.tenant, envelopeId: o.env, type: "recipient.declined", actor: { type: "system" }, data: { reason: "no" } }),
    );
    await new Promise((r) => setTimeout(r, 20));
    for (const type of ["recipient.declined", "envelope.declined"]) {
      await wh.handleWebhookJob({ db, log }, { kind: "fanout", tenantId: o.tenant, envelopeId: o.env, seq, type, recipientId: null, reason: "no" });
    }
    const dels = await db.query<any>(`SELECT event_id, event_type, payload FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY event_type`, [id]);
    expect(dels).toHaveLength(2);
    const a: any = { tenantId: o.tenant, userId: null, apiKeyId: o.keyId, actor: { type: "api_key", id: o.keyId } };
    a.access = await loadAccess(db, a);
    const read = (types: string[]) =>
      readEvents(
        { db, blobs: null as any },
        a,
        { after: null, since: new Date(Date.now() - 3600_000).toISOString(), types, envelopeId: o.env, all: false },
        100,
      );
    const all = await read([]);
    expect(all.items).toHaveLength(2);
    for (const d of dels) {
      const ev = all.items.find((e) => e.type === d.event_type)!;
      expect(ev.id).toBe(d.event_id);
      expect(d.payload.id).toBe(ev.id);
      expect(d.payload.createdAt).toBe(ev.occurredAt);
      expect(ev.cursor).toMatch(/^p\d+$/);
    }
    // Con filtro por tipo el id no cambia.
    const only = await read(["envelope.declined"]);
    expect(only.items.map((e) => e.id)).toEqual([wh.webhookEventId(o.env, seq, "envelope.declined")]);
    // legacyId (obsoleto): el id viejo evt_<registro>_<n>, también sin depender del filtro.
    const legacy = all.items.map((e) => e.legacyId);
    expect(new Set(legacy).size).toBe(2);
    for (const l of legacy) expect(l).toMatch(/^evt_.+_[01]$/);
    expect(only.items[0]!.legacyId).toBe(all.items.find((e) => e.type === "envelope.declined")!.legacyId);
  });

  it("fanout sin registro de evidencia (job viejo o purgado): createdAt es la hora actual", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    const before = Date.now();
    await wh.handleWebhookJob(
      { db, log },
      { kind: "fanout", tenantId: o.tenant, envelopeId: o.env, seq: 999, type: "envelope.sent", recipientId: null },
    );
    const d = await db.one<any>(`SELECT payload FROM webhook_deliveries WHERE endpoint_id = $1`, [id]);
    expect(Date.parse(d!.payload.createdAt)).toBeGreaterThanOrEqual(before);
  });
});

describe("reintento manual y credencial revocada", () => {
  it("el reintento revisa antes la credencial de origen: 409 y el endpoint queda desactivado", async () => {
    const o = await org();
    const key2 = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1,$2,'zap','cs_test',$3,'admin')`, [
      key2,
      o.tenant,
      util.sha256Hex(key2),
    ]);
    const id = await endpoint(o.tenant, { apiKey: key2 });
    const d = await delivery(o.tenant, id);
    await db.query(`UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1`, [d]);
    await db.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [key2]);
    const r = await app.inject({ method: "POST", url: `/v1/webhook-deliveries/${d}/retry`, headers: o.auth });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("endpoint_inactive");
    expect(wh.toEndpoint(await ep(id)).deactivatedReason).toBe("credential_revoked");
  });

  it("una entrega manual ya encolada no sale si se revocó la credencial (el endpoint seguía activo)", async () => {
    const o = await org();
    const key2 = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1,$2,'zap','cs_test',$3,'admin')`, [
      key2,
      o.tenant,
      util.sha256Hex(key2),
    ]);
    const id = await endpoint(o.tenant, { apiKey: key2 });
    const d = await delivery(o.tenant, id);
    await db.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [key2]);
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: d, manual: true }, { attempts: 1 });
    expect(hits).toBe(0);
    expect(await db.one(`SELECT status, last_error FROM webhook_deliveries WHERE id = $1`, [d])).toMatchObject({
      status: "failed",
      last_error: "endpoint desactivado",
    });
    // Una prueba manual sobre un endpoint pausado a mano (ya inactivo) sí sale, como antes.
    const paused = await endpoint(o.tenant, { active: false });
    await wh.handleWebhookJob({ db, log }, { kind: "deliver", deliveryId: await delivery(o.tenant, paused), manual: true }, { attempts: 1 });
    expect(hits).toBe(1);
  });
});

describe("auditoría de webhooks", () => {
  it("registra solo el host de la URL al crear, y el host anterior y el nuevo al cambiarla", async () => {
    const o = await org();
    const c = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: o.auth,
      payload: { url: "https://hooks.example.com/in?token=s3cr3t" },
    });
    expect(c.statusCode).toBe(201);
    const whId = c.json().webhook.id;
    const created = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'webhook.created'`, [o.tenant]);
    expect(created!.data).toEqual({ host: "hooks.example.com" });
    expect(JSON.stringify(created!.data)).not.toContain("s3cr3t");
    const p = await app.inject({
      method: "PATCH",
      url: `/v1/webhooks/${whId}`,
      headers: o.auth,
      payload: { url: "https://other.example.net/in?token=n3w" },
    });
    expect(p.statusCode).toBe(200);
    // Solo la descripción: sin hosts.
    await app.inject({ method: "PATCH", url: `/v1/webhooks/${whId}`, headers: o.auth, payload: { description: "x" } });
    const upd = await db.query<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'webhook.updated' ORDER BY occurred_at, id`,
      [o.tenant],
    );
    expect(upd.map((r) => r.data)).toEqual([
      { fields: ["url"], fromHost: "hooks.example.com", toHost: "other.example.net" },
      { fields: ["description"] },
    ]);
    expect(JSON.stringify(upd)).not.toContain("n3w");
  });
});

describe("límite de pedidos y esquema Bearer", () => {
  it("el esquema Bearer no distingue mayúsculas", async () => {
    const o = await org();
    const key = o.auth.authorization.slice(7);
    for (const h of [`bearer ${key}`, `BEARER  ${key}`, `Bearer ${key}`]) {
      expect((await app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization: h } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization: `Basic ${key}` } })).statusCode).toBe(401);
    expect(util.bearerToken("bearer   abc  ")).toBe("abc");
    expect(util.bearerToken("Bearer ")).toBeNull();
    expect(util.bearerToken("Bearerabc")).toBeNull();
    expect(util.bearerToken(undefined)).toBeNull();
  });

  it("clave del límite: credencial verificada (con caché positiva y negativa) o IP; rutas públicas con límite propio, por IP", async () => {
    const ip = await import("../src/lib/ip");
    ip.resetKnownCredentials();
    const valid = new Map([["cs_live_abc", "tenant-a"]]);
    let calls = 0;
    const verify = async (t: string) => {
      calls++;
      return valid.get(t) ?? null;
    };
    const id = (addr: string, authorization?: string, config?: Record<string, unknown>) =>
      ip.rateLimitIdentity({ ip: addr, headers: authorization ? { authorization } : {}, routeOptions: { config } }, verify);
    const k = `cred:${util.sha256Hex("cs_live_abc").slice(0, 32)}`;
    // Válida aunque nunca haya autenticado en este proceso: su cupo desde el primer pedido.
    expect(await id("203.0.113.9", "bearer cs_live_abc")).toEqual({ key: k, tenantId: "tenant-a" });
    expect(k).not.toContain("cs_live_abc");
    expect(await id("203.0.113.10", "Bearer cs_live_abc")).toEqual({ key: k, tenantId: "tenant-a" });
    expect(calls).toBe(1); // caché positiva
    expect((await id("203.0.113.9")).key).toBe("203.0.113.9");
    expect((await id("203.0.113.9", "Basic eDp5")).key).toBe("203.0.113.9");
    // Inventada: IP, y una sola consulta (caché negativa).
    expect((await id("203.0.113.9", "Bearer otra")).key).toBe("203.0.113.9");
    expect((await id("203.0.113.9", "Bearer otra")).key).toBe("203.0.113.9");
    expect(calls).toBe(2);
    // Límite propio: ruta pública (login, firma…) por IP aunque la credencial sea válida; ruta que autentica, por
    // organización (crear más keys no multiplica el cupo).
    const rl = { max: 10, timeWindow: "1 minute" };
    valid.set("cs_live_def", "tenant-a");
    expect((await id("203.0.113.9", "Bearer cs_live_abc", { rateLimit: rl })).key).toBe("203.0.113.9");
    expect(await id("203.0.113.9", "Bearer cs_live_abc", { rateLimit: rl, bearerAuthRoute: true })).toEqual({
      key: "tenant:tenant-a",
      tenantId: "tenant-a",
    });
    expect((await id("203.0.113.11", "Bearer cs_live_def", { rateLimit: rl, bearerAuthRoute: true })).key).toBe("tenant:tenant-a");
    expect((await id("203.0.113.9", "Bearer cs_live_abc", { rateLimit: rl, rateLimitByCredential: true })).key).toBe("tenant:tenant-a");
    // En el límite global, cada credencial sigue con su cupo.
    expect((await id("203.0.113.9", "Bearer cs_live_def")).key).toBe(`cred:${util.sha256Hex("cs_live_def").slice(0, 32)}`);
    expect((await id("203.0.113.9", "Bearer otra", { rateLimit: rl, bearerAuthRoute: true })).key).toBe("203.0.113.9");
    // Revocada: deja de contar por credencial.
    ip.forgetCredential("cs_live_abc");
    expect((await id("203.0.113.9", "bearer cs_live_abc")).key).toBe("203.0.113.9");
    // Bearer inventados distintos: las consultas a la base tienen tope por IP (además de gastar su cupo).
    ip.resetKnownCredentials();
    calls = 0;
    for (let i = 0; i < 1300; i++) await id("198.51.100.250", `Bearer x${i}`);
    expect(calls).toBeLessThanOrEqual(1200);
    expect(calls).toBeGreaterThan(600);
    ip.resetKnownCredentials();
  });

  it("token OAuth: un error del momento al autenticar no lo deja en la caché negativa; un 401 sí", async () => {
    const ip = await import("../src/lib/ip");
    const { authenticate } = await import("../src/modules/context");
    ip.resetKnownCredentials();
    const token = `csat_${util.randomToken(16)}`;
    ip.rememberAuthenticatedCredential(token, "tenant-o");
    const verify = async () => null; // si se consultara, contaría como inválida
    const key = async () => (await ip.rateLimitIdentity({ ip: "203.0.113.50", headers: { authorization: `Bearer ${token}` } }, verify)).key;
    const req = (_dbErr: boolean) => ({
      headers: { authorization: `Bearer ${token}` },
      ip: "203.0.113.50",
      cookies: {},
    });
    const failing = {
      one: async () => {
        throw new Error("base caída");
      },
      query: async () => {
        throw new Error("base caída");
      },
    } as any;
    await expect(authenticate({ db: failing, blobs: {} as any })(req(true) as any, {} as any)).rejects.toThrow("base caída");
    expect(await key()).toMatch(/^cred:/);
    const empty = { one: async () => null, query: async () => [] } as any;
    await expect(authenticate({ db: empty, blobs: {} as any })(req(false) as any, {} as any)).rejects.toMatchObject({ status: 401 });
    expect(await key()).toBe("203.0.113.50");
    ip.resetKnownCredentials();
  });

  it("POST /v1/auth/login: un Bearer inventado distinto en cada pedido no evita el límite por IP", async () => {
    const ip = "198.51.100.21";
    const login = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { authorization: `Bearer cs_live_${util.randomToken(12)}` },
        payload: { email: "nadie@x.test", password: "x" },
        remoteAddress: ip,
      });
    for (let i = 0; i < 10; i++) expect((await login()).statusCode).not.toBe(429);
    const over = await login();
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");
    expect(over.headers["x-request-id"]).toBeTruthy();
  });

  it("POST /v1/auth/login: ni una key válida abre otro cupo en una ruta pública", async () => {
    const o = await org();
    const ip = "198.51.100.23";
    const login = (h: Record<string, string>) =>
      app.inject({ method: "POST", url: "/v1/auth/login", headers: h, payload: { email: "nadie@x.test", password: "x" }, remoteAddress: ip });
    for (let i = 0; i < 10; i++) expect((await login({})).statusCode).not.toBe(429);
    expect((await login(o.auth)).statusCode).toBe(429);
  });

  const remaining = (r: { headers: Record<string, unknown> }) => Number(r.headers["x-ratelimit-remaining"]);

  it("ruta con el límite global: Bearer inventados comparten el cupo de la IP; una key válida tiene el suyo desde el primer pedido", async () => {
    const { resetKnownCredentials } = await import("../src/lib/ip");
    const ip = "198.51.100.22";
    const get = (authorization: string) => app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization }, remoteAddress: ip });
    const r1 = await get(`Bearer cs_live_${util.randomToken(12)}`);
    const r2 = await get(`Bearer cs_live_${util.randomToken(12)}`);
    expect(r1.statusCode).toBe(401);
    expect(remaining(r2)).toBe(remaining(r1) - 1);
    const o = await org();
    // Key válida que este proceso no conoce (reinicio, otra réplica, caché vencida): igual cuenta en su cupo.
    resetKnownCredentials();
    const first = await get(o.auth.authorization);
    expect(first.statusCode).toBe(200);
    expect(remaining(first)).toBe(599);
    expect(remaining(await get(o.auth.authorization))).toBe(598);
    // La IP sigue con su cupo: otro Bearer inventado sigue descontando de él.
    expect(remaining(await get(`Bearer cs_live_${util.randomToken(12)}`))).toBe(remaining(r2) - 1);
  });

  it("rutas autenticadas con límite propio (/mcp, /v1/xml/sign): cada organización tiene su cupo aunque compartan IP; las keys de una misma organización lo comparten", async () => {
    const { resetKnownCredentials } = await import("../src/lib/ip");
    resetKnownCredentials();
    const a = await org();
    const b = await org();
    const plan = (await db.one<{ billing_plan: string }>(`SELECT billing_plan FROM tenants WHERE id = $1`, [a.tenant]))!.billing_plan;
    const ip = "198.51.100.24";
    for (const url of ["/mcp", "/v1/xml/sign"]) {
      // /mcp con un plan sin API responde 402 antes de tomar la conexión (con hijack no salen los encabezados del
      // límite); /v1/xml/sign necesita el plan con API para llegar al límite (autentica antes).
      await db.query(`UPDATE tenants SET billing_plan = $2 WHERE id = ANY($1::uuid[])`, [[a.tenant, b.tenant], url === "/mcp" ? "free" : plan]);
      const post = (h: Record<string, string>) =>
        app.inject({
          method: "POST",
          url,
          headers: { ...h, "content-type": "application/json", accept: "application/json, text/event-stream" },
          payload: {},
          remoteAddress: ip,
        });
      const ra = await post(a.auth);
      const rb = await post(b.auth);
      const max = Number(ra.headers["x-ratelimit-limit"]);
      expect(max).toBeLessThan(600);
      expect(remaining(ra)).toBe(max - 1);
      expect(remaining(rb)).toBe(max - 1);
      // Otra key de la organización A (otra IP): mismo cupo, no uno nuevo.
      const key2 = `cs_test_${util.randomToken(12)}`;
      await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1, $2, 'k2', 'cs_test', $3, 'admin')`, [
        util.uuidv7(),
        a.tenant,
        util.sha256Hex(key2),
      ]);
      const ra2 = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${key2}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        payload: {},
        remoteAddress: "198.51.100.26",
      });
      expect(remaining(ra2)).toBe(max - 2);
      if (url !== "/mcp") continue; // /v1/xml/sign autentica antes del límite: sin credencial válida responde 401 sin contar
      // Sin credencial válida, el cupo de la IP.
      const anon = await post({ authorization: `Bearer cs_live_${util.randomToken(12)}` });
      expect(remaining(anon)).toBe(max - 1);
      expect(remaining(await post({ authorization: `Bearer cs_live_${util.randomToken(12)}` }))).toBe(max - 2);
    }
  });

  it("una lluvia de Bearer inventados desde una IP no deja afuera a una key válida desde la misma IP", async () => {
    const { resetKnownCredentials } = await import("../src/lib/ip");
    resetKnownCredentials();
    const o = await org();
    const ip = "198.51.100.25";
    const get = (authorization: string) => app.inject({ method: "GET", url: "/v1/webhooks", headers: { authorization }, remoteAddress: ip });
    let last = 0;
    for (let i = 0; i < 620; i++) last = (await get(`Bearer cs_live_${util.randomToken(12)}`)).statusCode;
    expect(last).toBe(429);
    // La key válida (no vista antes por este proceso) tiene su propio cupo.
    expect((await get(o.auth.authorization)).statusCode).toBe(200);
  }, 60_000);

  it("POST /v1/webhooks/:id/test: 10 por minuto por organización (otra key de la misma organización no abre otro cupo; otra organización sí tiene el suyo)", async () => {
    const o = await org();
    const id = await endpoint(o.tenant);
    const key2 = `cs_test_${util.randomToken(12)}`;
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role) VALUES ($1,$2,'k2','cs_test',$3,'admin')`, [
      util.uuidv7(),
      o.tenant,
      util.sha256Hex(key2),
    ]);
    const send = (authorization: string) =>
      app.inject({ method: "POST", url: `/v1/webhooks/${id}/test`, headers: { authorization }, remoteAddress: "198.51.100.7" });
    for (let i = 0; i < 10; i++) expect((await send(o.auth.authorization)).statusCode).not.toBe(429);
    const over = await send(o.auth.authorization);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");
    // Crear más keys no multiplica el límite (antes contaba por credencial).
    expect((await send(`Bearer ${key2}`)).statusCode).toBe(429);
    const other = await org();
    const otherId = await endpoint(other.tenant);
    const r = await app.inject({ method: "POST", url: `/v1/webhooks/${otherId}/test`, headers: other.auth, remoteAddress: "198.51.100.7" });
    expect(r.statusCode).not.toBe(429);
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
