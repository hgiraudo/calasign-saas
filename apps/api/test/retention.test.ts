import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-ret-"));

describe("retención", () => {
  it("purga solo sobres completados más viejos que la política, conservando el PDF firmado", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { purgeExpiredEnvelopes } = await import("../src/modules/retention");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);

    const deleted: string[] = [];
    const blobs = { put: async () => {}, get: async () => new Uint8Array(), delete: async (k: string) => void deleted.push(k) };
    const log = { info() {}, warn() {}, error() {} };

    const tenant = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name, retention_days) VALUES ($1, $2, 'T', 30)`, [tenant, `t-${tenant.slice(-6)}`]);
    const mk = async (completedDaysAgo: number) => {
      const env = uuidv7();
      const orig = uuidv7();
      const signed = uuidv7();
      await db.query(
        `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',1,'x')`,
        [orig, tenant, `o-${orig}`],
      );
      await db.query(
        `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',1,'y')`,
        [signed, tenant, `s-${signed}`],
      );
      await db.query(
        `INSERT INTO envelopes (id, tenant_id, subject, status, completed_at, signed_file_id) VALUES ($1,$2,'S','completed', now() - make_interval(days => $3), $4)`,
        [env, tenant, completedDaysAgo, signed],
      );
      await db.query(
        `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'d.pdf',$4,1,'[]')`,
        [uuidv7(), tenant, env, orig],
      );
      return { env, orig, signed };
    };
    const old = await mk(45);
    const recent = await mk(5);

    const r = await purgeExpiredEnvelopes({ db, blobs: blobs as any, log });
    expect(r.purged).toBe(1);
    expect(deleted).toEqual([`o-${old.orig}`]);
    const files = await db.query<any>(`SELECT id, purged_at FROM files WHERE id = ANY($1::uuid[])`, [[old.orig, old.signed, recent.orig]]);
    const byId = Object.fromEntries(files.map((f) => [f.id, f.purged_at]));
    expect(byId[old.orig]).not.toBeNull();
    expect(byId[old.signed]).toBeNull();
    expect(byId[recent.orig]).toBeNull();
    const ev = await db.query<any>(`SELECT type FROM envelope_events WHERE envelope_id = $1`, [old.env]);
    expect(ev.map((e) => e.type)).toEqual(["envelope.purged"]);

    // Idempotente: una segunda pasada no hace nada.
    expect((await purgeExpiredEnvelopes({ db, blobs: blobs as any, log })).purged).toBe(0);
    await db.close();
  }, 60_000);
});
