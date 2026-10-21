// Almacenamiento conectado con la cuenta de una persona que deja la organización: se desactiva (y se avisa), muestra
// quién lo conectó y no se reactiva sin volver a conectarlo. Además: revocación de tokens al desconectar, permisos del
// callback OAuth, reclamo de la exportación y carpeta resuelta solo para la carpeta usada. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-storage-removed-"));
delete process.env.DATABASE_URL;

const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { to: string; subject: string; text: string }) => {
    sent.push({ to: m.to, subject: m.subject, text: m.text });
    return { provider: "smtp", messageId: `id-${sent.length}` };
  }),
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let blobs: import("../src/infra/storage").BlobStore;
let tenant = "";
const users: Record<string, string> = {};
const sessions: Record<string, string> = {};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', 'enterprise')`, [tenant, `t-${tenant.slice(-8)}`]);
  const role = util.uuidv7();
  await db.query(`INSERT INTO roles (id, tenant_id, name, permissions) VALUES ($1,$2,'Ajustes',$3)`, [role, tenant, ["settings:manage"]]);
  for (const [k, r] of [
    ["owner", "owner"],
    ["ana", "admin"],
    ["beto", "member"],
    ["ajustes", "custom"],
  ] as const) {
    const id = util.uuidv7();
    users[k] = id;
    await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'scrypt$x')`, [id, `${k}@org.test`, k.toUpperCase()]);
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role, role_id) VALUES ($1,$2,$3,$4)`, [tenant, id, r, r === "custom" ? role : null]);
    const token = util.randomToken();
    await db.query(`INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')`, [util.sha256Hex(token), id, tenant]);
    sessions[k] = token;
  }
  blobs = createBlobStore();
  app = await buildApp({ db, blobs, logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function conn(provider: string, createdBy: string, config: Record<string, unknown> = {}) {
  const id = util.uuidv7();
  const creds = provider === "s3" ? { accessKeyId: "AK", secretAccessKey: "S" } : { access_token: "at", refresh_token: `rt-${id.slice(-4)}`, expires_at: Date.now() + 3_600_000 };
  await db.query(
    `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, tenant, provider, `${provider}-${id.slice(-4)}`, JSON.stringify(config), util.encrypt(JSON.stringify(creds)), createdBy],
  );
  return id;
}
const connRow = (id: string) => db.one<any>(`SELECT active, deactivated_reason, config FROM storage_connections WHERE id = $1`, [id]);

describe("almacenamiento de una persona que deja la organización", () => {
  it("al quitarla: sus conexiones OAuth se desactivan (S3 no), quedan en la auditoría y se avisa a propietarios y administradores", async () => {
    const drive = await conn("gdrive", users.beto);
    const box = await conn("box", users.beto);
    const s3 = await conn("s3", users.beto);
    const mine = await conn("dropbox", users.owner);
    const del = await app.inject({ method: "DELETE", url: `/v1/members/${users.beto}`, cookies: { cs_session: sessions.owner } });
    expect(del.statusCode).toBe(204);
    expect(await connRow(drive)).toMatchObject({ active: false, deactivated_reason: "creator_removed" });
    expect(await connRow(box)).toMatchObject({ active: false, deactivated_reason: "creator_removed" });
    expect(await connRow(s3)).toMatchObject({ active: true, deactivated_reason: null });
    expect(await connRow(mine)).toMatchObject({ active: true, deactivated_reason: null });
    const audit = await db.query<any>(`SELECT target_id FROM account_audit_log WHERE tenant_id = $1 AND action = 'storage.deactivated_member_removed' ORDER BY target_id`, [tenant]);
    expect(audit.map((a) => a.target_id).sort()).toEqual([drive, box].sort());

    // El aviso va por la cola (outbox de la baja).
    const job = await db.one<any>(`SELECT id, payload FROM jobs WHERE queue = 'platform' AND payload->>'kind' = 'storage_member_removed'`);
    expect(job.payload).toMatchObject({ tenantId: tenant, userId: users.beto });
    const { handlePlatformJob } = await import("../src/modules/platform-fanout");
    sent.length = 0;
    await handlePlatformJob({ db, blobs, log: { error() {} } }, job.payload, { id: job.id, attempts: 1, maxAttempts: 5 });
    expect(sent.map((m) => m.to).sort()).toEqual(["ana@org.test", "owner@org.test"]);
    expect(sent[0].text).toContain("beto@org.test");
    expect(sent[0].text).toMatch(/gdrive-|box-/);

    // La lista muestra quién la conectó y por qué está desactivada.
    const list = (await app.inject({ method: "GET", url: "/v1/storage/connections", cookies: { cs_session: sessions.owner } })).json().items;
    const d = list.find((x: any) => x.id === drive);
    expect(d).toMatchObject({ active: false, deactivatedReason: "creator_removed", createdBy: { id: users.beto, name: "BETO", email: "beto@org.test", member: false } });
    expect(list.find((x: any) => x.id === mine).createdBy).toMatchObject({ email: "owner@org.test", member: true });

    // No se reactiva: hay que volver a conectarla.
    const re = await app.inject({ method: "PATCH", url: `/v1/storage/connections/${drive}`, cookies: { cs_session: sessions.owner }, payload: { active: true } });
    expect(re.statusCode).toBe(409);
    expect(re.json().error.code).toBe("storage_reconnect_required");
  });

  it("al desconectar se revoca el acceso en el proveedor (lo mejor posible)", async () => {
    const drive = await conn("gdrive", users.owner);
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (u: any, init: any = {}) => {
      calls.push({ url: String(u), body: String(init.body ?? "") });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = await app.inject({ method: "DELETE", url: `/v1/storage/connections/${drive}`, cookies: { cs_session: sessions.owner } });
    expect(r.statusCode).toBe(204);
    expect(calls).toEqual([{ url: "https://oauth2.googleapis.com/revoke", body: `token=rt-${drive.slice(-4)}` }]);
    // Si el proveedor falla, la desconexión igual se hace.
    const other = await conn("gdrive", users.owner);
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    expect((await app.inject({ method: "DELETE", url: `/v1/storage/connections/${other}`, cookies: { cs_session: sessions.owner } })).statusCode).toBe(204);
    expect(await connRow(other)).toBeNull();
  });

  it("el callback OAuth exige también envelopes:view_all (como el resto de /v1/storage)", async () => {
    const st = util.encrypt(JSON.stringify({ t: tenant, u: users.ajustes, p: "gdrive", n: "X", f: "", exp: Date.now() + 60_000 }));
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = await app.inject({
      method: "GET",
      url: `/v1/storage/oauth/gdrive/callback?code=c&state=${encodeURIComponent(st)}`,
      cookies: { cs_session: sessions.ajustes },
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain("error=forbidden");
    expect(fetched).toBe(false);
  });
});

describe("exportación: reclamo y carpeta", () => {
  it("la carpeta resuelta se guarda solo si la conexión sigue apuntando a la carpeta usada", async () => {
    const { persistUpload } = await import("../src/modules/storage-export");
    const c = await conn("box", users.owner, { folder: "Nueva" });
    await persistUpload(db, c, { ref: "box:1", config: { folderId: "vieja-id" } }, "Vieja");
    expect((await connRow(c)).config.folderId).toBeUndefined();
    await persistUpload(db, c, { ref: "box:1", config: { folderId: "nueva-id" } }, "Nueva");
    expect((await connRow(c)).config.folderId).toBe("nueva-id");
    const root = await conn("box", users.owner, {});
    await persistUpload(db, root, { ref: "box:1", config: { folderId: "0" } }, undefined);
    expect((await connRow(root)).config.folderId).toBe("0");
  });

  it("al terminar suelta el reclamo solo si sigue siendo el suyo", async () => {
    const { exportEnvelopeJob } = await import("../src/modules/storage-export");
    const c = await conn("gdrive", users.owner);
    const file = util.uuidv7();
    const env = util.uuidv7();
    const key = `tenants/${tenant}/envelopes/${env}/${file}.pdf`;
    await blobs.put(key, new TextEncoder().encode("%PDF-x"), "application/pdf");
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',6,$4)`, [
      file,
      tenant,
      key,
      "b".repeat(64),
    ]);
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, completed_at, signed_file_id) VALUES ($1,$2,'S','completed', now(), $3)`, [env, tenant, file]);
    const ex = util.uuidv7();
    await db.query(`INSERT INTO storage_exports (id, tenant_id, connection_id, envelope_id) VALUES ($1,$2,$3,$4)`, [ex, tenant, c, env]);
    const claimed = () => db.one<any>(`SELECT claimed_until IS NOT NULL AS held, status FROM storage_exports WHERE id = $1`, [ex]);

    // Mientras sube, el reclamo vence y otro intento lo toma (otro valor): al terminar, este no lo borra.
    globalThis.fetch = (async () => {
      await db.query(`UPDATE storage_exports SET claimed_until = now() + interval '1 hour' WHERE id = $1`, [ex]);
      return new Response(JSON.stringify({ id: "f1", webViewLink: "https://d/f1" }), { status: 200 });
    }) as typeof fetch;
    await exportEnvelopeJob(db, blobs, { connectionId: c, envelopeId: env });
    expect(await claimed()).toEqual({ held: true, status: "succeeded" });

    // Sin carrera, lo suelta.
    await db.query(`UPDATE storage_exports SET status = 'failed', claimed_until = NULL, pdf_ref = NULL WHERE id = $1`, [ex]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: "f2", webViewLink: "https://d/f2" }), { status: 200 })) as typeof fetch;
    await exportEnvelopeJob(db, blobs, { connectionId: c, envelopeId: env });
    expect(await claimed()).toEqual({ held: false, status: "succeeded" });
  });
});
