// Barrido de sellos de archivo: reintento diario de una renovación fallida (archive_renewed_at, 0116), aviso único por
// organización cuando la TSA no puede extender la validez, y solo las organizaciones de las celdas que atiende el proceso.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-archive-retry-"));
delete process.env.DATABASE_URL;

const sent: { to: string; subject: string }[] = [];
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { to: string; subject: string }) => {
    sent.push({ to: m.to, subject: m.subject });
    return { provider: "smtp", messageId: `id-${sent.length}` };
  }),
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
let db: Db;
let archive: typeof import("../src/modules/data/archive");
let cellsMod: typeof import("../src/infra/cells");
let util: typeof import("../src/lib/util");
let config: typeof import("../src/config")["config"];
const log = { info() {}, warn() {}, error() {} };
const blobs = { get: async () => Promise.reject(new Error("sin archivo")), put: async () => {}, delete: async () => {} };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  archive = await import("../src/modules/data/archive");
  cellsMod = await import("../src/infra/cells");
  util = await import("../src/lib/util");
  config = (await import("../src/config")).config;
  db = await createDb();
  await migrate(db);
}, 120_000);
afterAll(async () => db?.close());
afterEach(() => {
  delete process.env.CELLS;
  delete process.env.SERVED_CELLS;
  cellsMod.resetCells();
});

async function tenantWithAdmin(cell = "local") {
  const t = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, cell) VALUES ($1,$2,'Org',$3)`, [t, `t-${t.slice(-8)}`, cell]);
  const u = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,'Ana','x')`, [u, `admin-${t.slice(-8)}@org.test`]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [t, u]);
  return t;
}

async function dueEnvelope(tenant: string, cols: { renewals?: number; renewedAgo?: string | null; checkedAgo?: string; error?: string | null; validIn?: string } = {}) {
  const file = util.uuidv7();
  const env = util.uuidv7();
  await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',1,$4)`, [
    file,
    tenant,
    `tenants/${tenant}/x/${file}.pdf`,
    "a".repeat(64),
  ]);
  await db.query(
    `INSERT INTO envelopes (id, tenant_id, subject, status, completed_at, signed_file_id, archive_valid_until, archive_checked_at, archive_error, archive_renewals, archive_renewed_at)
     VALUES ($1,$2,'S','completed', now(), $3, now() + $4::interval, now() - $5::interval, $6, $7, now() - $8::interval)`,
    [env, tenant, file, cols.validIn ?? "10 days", cols.checkedAgo ?? "2 days", cols.error ?? null, cols.renewals ?? 0, cols.renewedAgo ?? null],
  );
  return env;
}
const row = (id: string) => db.one<any>(`SELECT archive_error, archive_checked_at > now() - interval '1 minute' AS checked FROM envelopes WHERE id = $1`, [id]);

describe("barrido de sellos de archivo", () => {
  it("una renovación fallida de un sobre ya renovado se reintenta al día siguiente (no a los 30 días)", async () => {
    const t = await tenantWithAdmin();
    // Renovado hace 40 días; el último intento falló hace 2: antes el intervalo mínimo se medía desde ese chequeo.
    const retry = await dueEnvelope(t, { renewals: 1, renewedAgo: "40 days", checkedAgo: "2 days", error: "TSA caída" });
    // Renovado hace 5 días: todavía dentro del intervalo mínimo.
    const recent = await dueEnvelope(t, { renewals: 1, renewedAgo: "5 days", checkedAgo: "2 days", error: "TSA caída" });
    archive.primeTsaCacheForTests(config.seal.tsaUrl, new Date(Date.now() + 3 * 365 * 86_400_000).toISOString());
    archive.resetArchiveSweepClock();
    archive.primeTsaCacheForTests(config.seal.tsaUrl, new Date(Date.now() + 3 * 365 * 86_400_000).toISOString());
    const r = await archive.archiveSweep({ db, blobs: blobs as any, log }, { days: 30, envelopeId: retry });
    expect(r.failed).toBe(1);
    expect((await row(retry)).checked).toBe(true);
    archive.resetArchiveSweepClock();
    archive.primeTsaCacheForTests(config.seal.tsaUrl, new Date(Date.now() + 3 * 365 * 86_400_000).toISOString());
    const r2 = await archive.archiveSweep({ db, blobs: blobs as any, log }, { days: 30, envelopeId: recent });
    expect(r2.failed).toBe(0);
    expect((await row(recent)).checked).toBe(false);
  });

  it("si la TSA no puede extender la validez: error visible en cada sobre y un solo aviso por organización", async () => {
    const t = await tenantWithAdmin();
    const a = await dueEnvelope(t, { validIn: "20 days" });
    const b = await dueEnvelope(t, { validIn: "25 days" });
    sent.length = 0;
    const tsaNotAfter = new Date(Date.now() + 5 * 86_400_000).toISOString();
    // El certificado actual de la TSA vence antes que los sellos: renovar no sirve.
    archive.resetArchiveSweepClock();
    archive.primeTsaCacheForTests(config.seal.tsaUrl, tsaNotAfter);
    const r = await archive.archiveSweep({ db, blobs: blobs as any, log }, { days: 60 });
    expect(r.failed).toBe(0);
    expect((r as any).notExtendable).toBeGreaterThanOrEqual(2);
    expect((await row(a)).archive_error).toBe(archive.TSA_CANNOT_EXTEND);
    expect((await row(b)).archive_error).toBe(archive.TSA_CANNOT_EXTEND);
    expect((await archive.archiveInfo(db, a)).errorCode).toBe("tsa_cannot_extend");
    const mine = sent.filter((m) => m.to === `admin-${t.slice(-8)}@org.test`);
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/sello de archivo/);

    // Al día siguiente vuelve a mirarlos (error + chequeo de hace más de un día), sin repetir el aviso.
    await db.query(`UPDATE envelopes SET archive_checked_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])`, [[a, b]]);
    archive.resetArchiveSweepClock();
    archive.primeTsaCacheForTests(config.seal.tsaUrl, tsaNotAfter);
    await archive.archiveSweep({ db, blobs: blobs as any, log }, { days: 60 });
    expect((await row(a)).checked).toBe(true);
    expect(sent.filter((m) => m.to === `admin-${t.slice(-8)}@org.test`)).toHaveLength(1);
  });

  it("con SERVED_CELLS solo barre las organizaciones de sus celdas", async () => {
    await db.query(`UPDATE envelopes SET archive_error = 'fuera', archive_checked_at = now() - interval '1 hour'`); // aparta lo anterior
    const us = await tenantWithAdmin("us");
    const br = await tenantWithAdmin("br");
    const eUs = await dueEnvelope(us, { error: "x", checkedAgo: "2 days" });
    const eBr = await dueEnvelope(br, { error: "x", checkedAgo: "2 days" });
    process.env.CELLS = JSON.stringify({ us: { default: true }, br: {} });
    process.env.SERVED_CELLS = "br";
    cellsMod.resetCells();
    archive.resetArchiveSweepClock();
    archive.primeTsaCacheForTests(config.seal.tsaUrl, new Date(Date.now() + 3 * 365 * 86_400_000).toISOString());
    await archive.archiveSweep({ db, blobs: blobs as any, log }, { days: 60 });
    expect((await row(eBr)).checked).toBe(true);
    expect((await row(eUs)).checked).toBe(false);
  });
});
