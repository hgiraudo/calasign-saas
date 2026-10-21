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

async function conn(provider: string, createdBy: string, config: Record<string, unknown> = {}, label: string | null = null) {
  const id = util.uuidv7();
  const creds = provider === "s3" ? { accessKeyId: "AK", secretAccessKey: "S" } : { access_token: "at", refresh_token: `rt-${id.slice(-4)}`, expires_at: Date.now() + 3_600_000 };
  await db.query(
    `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, created_by, account_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, tenant, provider, `${provider}-${id.slice(-4)}`, JSON.stringify(config), util.encrypt(JSON.stringify(creds)), createdBy, label],
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
    const drive = await conn("gdrive", users.owner, {}, "solo@gmail.test");
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (u: any, init: any = {}) => {
      calls.push({ url: String(u), body: String(init.body ?? "") });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const r = await app.inject({ method: "DELETE", url: `/v1/storage/connections/${drive}`, cookies: { cs_session: sessions.owner } });
    expect(r.statusCode).toBe(204);
    expect(calls).toEqual([{ url: "https://oauth2.googleapis.com/revoke", body: `token=rt-${drive.slice(-4)}` }]);
    // Si el proveedor falla, la desconexión igual se hace.
    const other = await conn("gdrive", users.owner, {}, "otro@gmail.test");
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as typeof fetch;
    expect((await app.inject({ method: "DELETE", url: `/v1/storage/connections/${other}`, cookies: { cs_session: sessions.owner } })).statusCode).toBe(204);
    expect(await connRow(other)).toBeNull();
  });

  it("Google: no se revoca si otra conexión (de cualquier organización) usa la misma cuenta (revocar corta toda la concesión)", async () => {
    const otherTenant = util.uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Otra')`, [otherTenant, `t-${otherTenant.slice(-8)}`]);
    const shared = "Compartida@gmail.test";
    const elsewhere = util.uuidv7();
    await db.query(
      `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, account_label) VALUES ($1,$2,'gdrive','Otra','{}',$3,$4)`,
      [elsewhere, otherTenant, util.encrypt(JSON.stringify({ access_token: "x", refresh_token: "rx", expires_at: 0 })), "compartida@gmail.test"],
    );
    const a = await conn("gdrive", users.owner, {}, shared);
    const calls: string[] = [];
    globalThis.fetch = (async (u: any) => {
      calls.push(String(u));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect((await app.inject({ method: "DELETE", url: `/v1/storage/connections/${a}`, cookies: { cs_session: sessions.owner } })).statusCode).toBe(204);
    expect(calls).toEqual([]);
    expect(await connRow(a)).toBeNull();

    // Callback que obtuvo tokens de esa cuenta pero no pudo guardar la conexión (el insert falla por una restricción
    // agregada para la prueba): tampoco revoca.
    const idToken = `h.${Buffer.from(JSON.stringify({ email: "compartida@gmail.test" })).toString("base64url")}.s`;
    globalThis.fetch = (async (u: any) => {
      calls.push(String(u));
      if (String(u).includes("/token")) return new Response(JSON.stringify({ access_token: "na", refresh_token: "nr", expires_in: 3600, id_token: idToken }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const st = util.encrypt(JSON.stringify({ t: tenant, u: users.owner, p: "gdrive", n: "x".repeat(10_000), f: "", exp: Date.now() + 60_000 }));
    await db.query(`ALTER TABLE storage_connections ADD CONSTRAINT test_name_len CHECK (length(name) < 1000) NOT VALID`);
    try {
      const r = await app.inject({ method: "GET", url: `/v1/storage/oauth/gdrive/callback?code=c&state=${encodeURIComponent(st)}`, cookies: { cs_session: sessions.owner } });
      expect(r.headers.location).toContain("error=");
    } finally {
      await db.query(`ALTER TABLE storage_connections DROP CONSTRAINT test_name_len`);
    }
    expect(calls.some((u) => u.endsWith("/token"))).toBe(true);
    expect(calls.filter((u) => u.includes("revoke"))).toEqual([]);

    // Ya sin otra conexión con esa cuenta, sí se revoca.
    await db.query(`DELETE FROM storage_connections WHERE id = $1`, [elsewhere]);
    const b = await conn("gdrive", users.owner, {}, shared);
    calls.length = 0;
    expect((await app.inject({ method: "DELETE", url: `/v1/storage/connections/${b}`, cookies: { cs_session: sessions.owner } })).statusCode).toBe(204);
    expect(calls).toEqual(["https://oauth2.googleapis.com/revoke"]);
  });

  it("Google: sin email ni sub solo cuentan las conexiones de la misma organización y persona; con sub se compara por sub", async () => {
    const otherTenant = util.uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Otra2')`, [otherTenant, `t-${otherTenant.slice(-8)}`]);
    const calls: string[] = [];
    globalThis.fetch = (async (u: any) => {
      calls.push(String(u));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const del = async (id: string) => {
      calls.length = 0;
      expect((await app.inject({ method: "DELETE", url: `/v1/storage/connections/${id}`, cookies: { cs_session: sessions.owner } })).statusCode).toBe(204);
      return calls.filter((u) => u.includes("revoke")).length > 0;
    };
    // Sin etiqueta en otra organización: no impide revocar.
    const elsewhere = util.uuidv7();
    await db.query(`INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc) VALUES ($1,$2,'gdrive','Sin etiqueta','{}',$3)`, [
      elsewhere,
      otherTenant,
      util.encrypt(JSON.stringify({ access_token: "x", refresh_token: "rx", expires_at: 0 })),
    ]);
    expect(await del(await conn("gdrive", users.owner))).toBe(true);
    // Sin etiqueta, de otra persona de la misma organización: tampoco.
    const byAna = await conn("gdrive", users.ana);
    expect(await del(await conn("gdrive", users.owner))).toBe(true);
    // Sin etiqueta, de la misma persona y organización: no se revoca (puede ser la misma cuenta).
    const mine = await conn("gdrive", users.owner);
    expect(await del(await conn("gdrive", users.owner))).toBe(false);
    await db.query(`DELETE FROM storage_connections WHERE id = ANY($1::uuid[])`, [[elsewhere, byAna, mine]]);

    // Con sub: misma cuenta aunque cambió el email; otra cuenta con el mismo email (sub distinto) no impide revocar.
    const a = await conn("gdrive", users.owner, {}, "viejo@gmail.test");
    const b = await conn("gdrive", users.owner, {}, "nuevo@gmail.test");
    await db.query(`UPDATE storage_connections SET account_sub = 'sub-1' WHERE id = ANY($1::uuid[])`, [[a, b]]);
    expect(await del(a)).toBe(false);
    const c = await conn("gdrive", users.owner, {}, "nuevo@gmail.test");
    await db.query(`UPDATE storage_connections SET account_sub = 'sub-2' WHERE id = $1`, [c]);
    expect(await del(b)).toBe(true);
    // Una fila anterior a la columna (sin sub) con el mismo email cuenta como la misma cuenta.
    const legacy = await conn("gdrive", users.ana, {}, "Nuevo@gmail.test");
    expect(await del(c)).toBe(false);
    await db.query(`DELETE FROM storage_connections WHERE id = $1`, [legacy]);
  });

  it("Google: el callback guarda el sub del id_token", async () => {
    const idToken = `h.${Buffer.from(JSON.stringify({ email: "subby@gmail.test", sub: "1234567890" })).toString("base64url")}.s`;
    globalThis.fetch = (async (u: any) => {
      if (String(u).includes("/token")) return new Response(JSON.stringify({ access_token: "na", refresh_token: "nr", expires_in: 3600, id_token: idToken }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const st = util.encrypt(JSON.stringify({ t: tenant, u: users.owner, p: "gdrive", n: "Con sub", f: "", exp: Date.now() + 60_000 }));
    const r = await app.inject({ method: "GET", url: `/v1/storage/oauth/gdrive/callback?code=c&state=${encodeURIComponent(st)}`, cookies: { cs_session: sessions.owner } });
    expect(r.headers.location).toContain("connected=gdrive");
    const row = await db.one<any>(`SELECT account_sub, account_label FROM storage_connections WHERE tenant_id = $1 AND name = 'Con sub'`, [tenant]);
    expect(row).toEqual({ account_sub: "1234567890", account_label: "subby@gmail.test" });
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

describe("regresiones de la ronda 142", () => {
  it("PATCH active=true: si la conexión se desactiva por la baja entre la lectura y el UPDATE, 409 y sigue desactivada", async () => {
    const c = await conn("gdrive", users.owner);
    await db.query(`UPDATE storage_connections SET active = false WHERE id = $1`, [c]);
    const orig = db.query.bind(db);
    (db as any).query = async (sql: string, params?: unknown[]) => {
      if (/UPDATE storage_connections SET name = COALESCE/.test(sql)) {
        await orig(`UPDATE storage_connections SET deactivated_reason = 'creator_removed' WHERE id = $1`, [c]);
      }
      return orig(sql, params);
    };
    try {
      const r = await app.inject({ method: "PATCH", url: `/v1/storage/connections/${c}`, cookies: { cs_session: sessions.owner }, payload: { active: true } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe("storage_reconnect_required");
    } finally {
      (db as any).query = orig;
    }
    expect(await connRow(c)).toMatchObject({ active: false, deactivated_reason: "creator_removed" });
    // Otros cambios (nombre) sobre una desactivada sí se guardan.
    const n = await app.inject({ method: "PATCH", url: `/v1/storage/connections/${c}`, cookies: { cs_session: sessions.owner }, payload: { name: "Renombrada" } });
    expect(n.statusCode).toBe(200);
  });

  it("aviso de la baja: un envío transitorio fallido reintenta el job aunque otro haya salido (sin repetir el enviado)", async () => {
    const { notifyStorageMemberRemoved } = await import("../src/modules/storage-export");
    const channels = await import("../src/notifications/channels");
    const c = await conn("box", users.beto);
    await db.query(`UPDATE storage_connections SET active = false, deactivated_reason = 'creator_removed' WHERE id = $1`, [c]);
    const deliver = vi.mocked(channels.deliver);
    const base = deliver.getMockImplementation()!;
    sent.length = 0;
    deliver.mockImplementation(async (m: any) => {
      if (m.to === "ana@org.test") throw Object.assign(new Error("421 try later"), { responseCode: 421 });
      return base(m);
    });
    const job = { id: 9_142_001 };
    try {
      await expect(notifyStorageMemberRemoved(db, { tenantId: tenant, userId: users.beto, connectionIds: [c] }, job)).rejects.toThrow(/no se pudo avisar/);
      expect(sent.map((m) => m.to)).toEqual(["owner@org.test"]);
    } finally {
      deliver.mockImplementation(base);
    }
    // Reintento del job: solo a quien faltaba.
    await notifyStorageMemberRemoved(db, { tenantId: tenant, userId: users.beto, connectionIds: [c] }, job);
    expect(sent.map((m) => m.to)).toEqual(["owner@org.test", "ana@org.test"]);
  });

  it("Drive: una URL de carpeta que la app no ve da un error claro (no crea una carpeta); unidades compartidas", async () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    const c = await conn("gdrive", users.owner, { folder: `https://drive.google.com/drive/folders/${id}` });
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = (async (u: any, init: any = {}) => {
      calls.push({ url: String(u), method: init.method ?? "GET" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const r = await app.inject({ method: "POST", url: `/v1/storage/connections/${c}/test`, cookies: { cs_session: sessions.owner } });
    expect(r.json()).toMatchObject({ ok: false });
    expect(r.json().error).toMatch(/no existe o la app no tiene acceso/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/drive/v3/files/${id}?`);
    expect(calls[0].url).toContain("supportsAllDrives=true");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("Drive: un nombre con forma de id (CalaSign_Signed_Documents) que da 404/403 se toma como nombre de carpeta", async () => {
    for (const status of [404, 403]) {
      const name = "CalaSign_Signed_Documents";
      const c = await conn("gdrive", users.owner, { folder: name });
      const calls: { url: string; method: string; body?: string }[] = [];
      globalThis.fetch = (async (u: any, init: any = {}) => {
        const url = String(u);
        calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
        if (url.includes(`/drive/v3/files/${name}?`)) return new Response("{}", { status });
        if (url.includes("/drive/v3/files?q=")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
        if ((init.method ?? "GET") === "POST" && url.includes("/drive/v3/files?")) return new Response(JSON.stringify({ id: "nueva-carpeta" }), { status: 200 });
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      }) as typeof fetch;
      const r = await app.inject({ method: "POST", url: `/v1/storage/connections/${c}/test`, cookies: { cs_session: sessions.owner } });
      expect(String(r.json().error ?? "")).not.toMatch(/no existe o la app no tiene acceso/);
      const search = calls.find((x) => x.url.includes("/drive/v3/files?q="));
      expect(search && decodeURIComponent(search.url)).toContain(name);
      const created = calls.find((x) => x.method === "POST" && x.body?.includes("application/vnd.google-apps.folder"));
      expect(created?.body).toContain(`"name":"${name}"`);
    }
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
