// BYOK (migración 0078): solo un propietario activa/cambia/desactiva la clave, historial de claves, aviso de que lo
// anterior sigue cifrado con la clave anterior y lectura sin caché en escrituras. Archivo: la renovación manual se
// rechaza si no corresponde. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-byok-archive-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let byok: typeof import("../src/modules/data/byok");
let tenant = "";
let owner = "";
let admin = "";

const KEY1 = "arn:aws:kms:us-east-1:111122223333:key/hardening-1";
const KEY2 = "arn:aws:kms:us-east-1:111122223333:key/hardening-2";

beforeAll(async () => {
  const kms = await import("../src/infra/kms");
  kms.setKmsClientFactory(() => kms.mockKms());
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  byok = await import("../src/modules/data/byok");
  db = await createDb();
  await migrate(db);
  tenant = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', 'enterprise')`, [tenant, `t-${tenant.slice(-8)}`]);
  owner = await session(await newUser("duena@org.test", "owner"));
  admin = await session(await newUser("admin@org.test", "admin"));
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function newUser(email: string, role: string) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Ana','scrypt$x')`, [id, email]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, id, role]);
  return id;
}
async function session(userId: string) {
  const token = util.randomToken();
  await db.query(`INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')`, [util.sha256Hex(token), userId, tenant]);
  return token;
}
const history = () =>
  db.query<any>(`SELECT key_arn, deactivated_at IS NULL AS current FROM tenant_byok_keys WHERE tenant_id = $1 ORDER BY id`, [tenant]);

describe("BYOK: propietario, historial y aviso", () => {
  it("un administrador (settings:manage) no puede activar ni desactivar la clave; puede verla", async () => {
    const put = await app.inject({ method: "PUT", url: "/v1/settings/byok", cookies: { cs_session: admin }, payload: { keyArn: KEY1 } });
    expect(put.statusCode).toBe(403);
    const del = await app.inject({ method: "DELETE", url: "/v1/settings/byok", cookies: { cs_session: admin } });
    expect(del.statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/settings/byok", cookies: { cs_session: admin } })).statusCode).toBe(200);
  });

  it("el propietario activa, cambia y desactiva: historial de claves y aviso de que lo anterior sigue con la clave anterior", async () => {
    const first = await app.inject({ method: "PUT", url: "/v1/settings/byok", cookies: { cs_session: owner }, payload: { keyArn: KEY1 } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "active", keyArn: KEY1, notice: null });
    expect(await history()).toEqual([{ key_arn: KEY1, current: true }]);

    const change = await app.inject({ method: "PUT", url: "/v1/settings/byok", cookies: { cs_session: owner }, payload: { keyArn: KEY2 } });
    expect(change.statusCode).toBe(200);
    expect(change.json().keyArn).toBe(KEY2);
    expect(change.json().notice).toContain(KEY1);
    expect(await history()).toEqual([
      { key_arn: KEY1, current: false },
      { key_arn: KEY2, current: true },
    ]);

    const off = await app.inject({ method: "DELETE", url: "/v1/settings/byok", cookies: { cs_session: owner } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ status: "none" });
    expect(off.json().notice).toContain(KEY2);
    expect((await history()).every((r: any) => !r.current)).toBe(true);

    // Las dos claves cuentan como de la organización (lecturas de archivos viejos); otra cualquiera, no.
    expect(await byok.isTenantByokKey(db, tenant, KEY1)).toBe(true);
    expect(await byok.isTenantByokKey(db, tenant, KEY2)).toBe(true);
    expect(await byok.isTenantByokKey(db, tenant, "arn:aws:kms:us-east-1:999999999999:key/plataforma")).toBe(false);
  });

  it("las escrituras leen la clave sin caché (un cambio hecho en otro proceso no queda 15 s viejo)", async () => {
    await db.query(`UPDATE tenants SET byok_key_arn = $2, byok_status = 'active' WHERE id = $1`, [tenant, KEY1]);
    byok.invalidateTenantStorage(tenant);
    expect((await byok.tenantStorage(db, tenant)).byokStatus).toBe("active");
    // Otro proceso desactiva la clave: esta caché no se entera.
    await db.query(`UPDATE tenants SET byok_status = 'none' WHERE id = $1`, [tenant]);
    expect((await byok.tenantStorage(db, tenant)).byokStatus).toBe("active");
    expect((await byok.tenantStorage(db, tenant, { fresh: true })).byokStatus).toBe("none");
  });
});

describe("renovación manual del sello de archivo", () => {
  async function completedEnvelope(cols: { validUntil?: string | null; error?: string | null }) {
    const file = util.uuidv7();
    const env = util.uuidv7();
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',1,$4)`, [
      file,
      tenant,
      `tenants/${tenant}/x/${file}.pdf`,
      "a".repeat(64),
    ]);
    await db.query(
      `INSERT INTO envelopes (id, tenant_id, subject, status, completed_at, signed_file_id, archive_valid_until, archive_checked_at, archive_error)
       VALUES ($1,$2,'S','completed', now(), $3, $4, now(), $5)`,
      [env, tenant, file, cols.validUntil ?? null, cols.error ?? null],
    );
    return env;
  }
  const renew = (id: string) => app.inject({ method: "POST", url: `/v1/envelopes/${id}/archive/renew`, cookies: { cs_session: owner } });

  it("409 si todavía no está por vencer", async () => {
    const id = await completedEnvelope({ validUntil: new Date(Date.now() + 3 * 365 * 86_400_000).toISOString() });
    const r = await renew(id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("archive_not_due");
  });

  it("409 si el PDF no es de archivo (B-B/B-T, sin LTV pendiente)", async () => {
    const id = await completedEnvelope({});
    const r = await renew(id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("archive_not_applicable");
  });

  it("un «LTV pendiente» no se fuerza a B-LTA si la organización ahora usa B-T", async () => {
    await db.query(`UPDATE tenants SET seal_level = 'B-T' WHERE id = $1`, [tenant]);
    const id = await completedEnvelope({ error: "LTV pendiente" });
    const r = await renew(id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("archive_not_applicable");
    await db.query(`UPDATE tenants SET seal_level = 'auto' WHERE id = $1`, [tenant]);
  });
});
