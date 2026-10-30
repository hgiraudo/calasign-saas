// Renovación del sello de archivo → las copias ya exportadas (Drive, Dropbox, …) se reemplazan por el PDF renovado.
// Antes quedaban con el PDF anterior, cuyo sello vence. App real sobre PGlite; el proveedor (Dropbox) simulado con fetch.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-export-renewal-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
let db: Db;
let blobs: import("../src/infra/storage").BlobStore;
let util: typeof import("../src/lib/util");
let se: typeof import("../src/modules/storage-export");
let tenant = "";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Dropbox simulado: registra los bytes de cada subida; get_metadata no encuentra nada (no hay copia que reutilizar). */
function mockDropbox() {
  const uploads: Buffer[] & { args?: any[] } = [];
  uploads.args = [];
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const url = String(u);
    if (url.endsWith("/files/get_metadata")) return new Response('{"error_summary":"path/not_found/"}', { status: 409 });
    if (url.endsWith("/files/upload")) {
      uploads.push(Buffer.from(init.body));
      uploads.args!.push(JSON.parse(String(init.headers["dropbox-api-arg"])));
      return new Response(JSON.stringify({ path_display: `/CalaSign/f${uploads.length}.pdf` }), { status: 200 });
    }
    return new Response("inesperado", { status: 500 });
  }) as typeof fetch;
  return uploads;
}

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  util = await import("../src/lib/util");
  se = await import("../src/modules/storage-export");
  db = await createDb();
  await migrate(db);
  blobs = createBlobStore();
  tenant = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', 'enterprise')`, [tenant, `t-${tenant.slice(-8)}`]);
}, 120_000);
afterAll(async () => {
  await db?.close();
});

async function signedFile(envelopeId: string, content: string) {
  const id = util.uuidv7();
  const bytes = new Uint8Array(Buffer.from(`%PDF-1.7\n${content}\n%%EOF\n`));
  const key = `tenants/${tenant}/envelopes/${envelopeId}/${id}-signed.pdf`;
  await blobs.put(key, bytes, "application/pdf");
  const sha = util.sha256Hex(bytes);
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`,
    [id, tenant, key, bytes.length, sha],
  );
  return { id, bytes, sha };
}

/** Sobre completado, ya exportado a una conexión de Dropbox con el PDF original (pdfSha: lo que quedó anotado). */
async function exportedEnvelope(opts: { active?: boolean; pdfSha?: "original" | null } = {}) {
  const env = util.uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, completed_at) VALUES ($1,$2,'Contrato','completed', now())`, [env, tenant]);
  const original = await signedFile(env, "original");
  await db.query(`UPDATE envelopes SET signed_file_id = $2 WHERE id = $1`, [env, original.id]);
  const conn = util.uuidv7();
  await db.query(
    `INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc, active) VALUES ($1,$2,'dropbox','Dropbox','{"folder":"CalaSign"}',$3,$4)`,
    [conn, tenant, util.encrypt(JSON.stringify({ access_token: "tok", expires_at: Date.now() + 3_600_000 })), opts.active ?? true],
  );
  const ex = util.uuidv7();
  await db.query(
    `INSERT INTO storage_exports (id, tenant_id, connection_id, envelope_id, status, attempts, pdf_ref, pdf_sha256, remote_ref)
     VALUES ($1,$2,$3,$4,'succeeded',1,'dropbox:/CalaSign/c.pdf',$5,'dropbox:/CalaSign/c.pdf')`,
    [ex, tenant, conn, env, opts.pdfSha === null ? null : original.sha],
  );
  return { env, conn, ex, original };
}

/** Lo que hace archiveRenewal: el sobre pasa a un PDF nuevo y se registra envelope.archive_renewed (dispara el fanout). */
async function renew(env: string) {
  const renewed = await signedFile(env, "renovado");
  const { appendEvent } = await import("../src/infra/evidence");
  await db.tx(async (t) => {
    await t.query(`SELECT 1 FROM envelopes WHERE id = $1 FOR UPDATE`, [env]);
    await t.query(`UPDATE envelopes SET signed_file_id = $2 WHERE id = $1`, [env, renewed.id]);
    await appendEvent(t, {
      tenantId: tenant,
      envelopeId: env,
      type: "envelope.archive_renewed",
      actor: { type: "system", id: null },
      data: { version: 2 },
    });
  });
  return renewed;
}

const exportJobs = (env: string) =>
  db.query<{ dedupe_key: string; payload: any }>(`SELECT dedupe_key, payload FROM jobs WHERE queue = 'platform' AND payload->>'envelopeId' = $1`, [
    env,
  ]);
const exportRow = (id: string) => db.one<any>(`SELECT status, pdf_sha256, remote_ref FROM storage_exports WHERE id = $1`, [id]);

describe("renovación del sello de archivo y copias exportadas", () => {
  it("la renovación encola la re-exportación y el trabajo sube el PDF renovado (una sola vez)", async () => {
    const { env, conn, ex } = await exportedEnvelope();
    const renewed = await renew(env);
    const jobs = await exportJobs(env);
    expect(jobs.map((j) => j.dedupe_key)).toEqual([expect.stringMatching(new RegExp(`^exp:${conn}:${env}:renewal:\\d+$`))]);

    const uploads = mockDropbox();
    await se.exportEnvelopeJob(db, blobs, { connectionId: conn, envelopeId: env });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].equals(Buffer.from(renewed.bytes))).toBe(true);
    // Reemplaza la copia anterior (Dropbox guarda la versión vieja), no suma «c (1).pdf» al lado.
    expect(uploads.args![0]).toMatchObject({ path: "/CalaSign/c.pdf", mode: "overwrite", autorename: false });
    expect(await exportRow(ex)).toMatchObject({ status: "succeeded", pdf_sha256: renewed.sha, remote_ref: "dropbox:/CalaSign/f1.pdf" });

    // Idempotente: otro trabajo (reintento de la cola) no vuelve a subir.
    await se.exportEnvelopeJob(db, blobs, { connectionId: conn, envelopeId: env });
    expect(uploads).toHaveLength(1);
  });

  it("sin renovación, una exportación hecha no se repite", async () => {
    const { env, conn } = await exportedEnvelope();
    const uploads = mockDropbox();
    await se.exportEnvelopeJob(db, blobs, { connectionId: conn, envelopeId: env });
    expect(uploads).toHaveLength(0);
  });

  it("una exportación anterior a 0057 (sin sha anotado) también se reemplaza al renovar", async () => {
    const { env, conn, ex } = await exportedEnvelope({ pdfSha: null });
    const renewed = await renew(env);
    const uploads = mockDropbox();
    await se.exportEnvelopeJob(db, blobs, { connectionId: conn, envelopeId: env });
    expect(uploads).toHaveLength(1);
    expect((await exportRow(ex)).pdf_sha256).toBe(renewed.sha);
  });

  it("un PDF anterior ya subido en un intento a medias no se reutiliza tras la renovación", async () => {
    const { env, conn, ex } = await exportedEnvelope();
    // Intento que subió el PDF original y falló después (p. ej. al subir la evidencia): queda la referencia anotada.
    await db.query(`UPDATE storage_exports SET status = 'failed' WHERE id = $1`, [ex]);
    const renewed = await renew(env);
    const uploads = mockDropbox();
    await se.exportEnvelopeJob(db, blobs, { connectionId: conn, envelopeId: env });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].equals(Buffer.from(renewed.bytes))).toBe(true);
    expect((await exportRow(ex)).pdf_sha256).toBe(renewed.sha);
  });

  it("una conexión desactivada no se re-exporta", async () => {
    const { env } = await exportedEnvelope({ active: false });
    await renew(env);
    expect(await exportJobs(env)).toHaveLength(0);
  });
});
