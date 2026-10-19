// Write-back de conectores (RR. HH./CLM): el vínculo se reclama (last_status) antes de escribir; si la escritura del
// estado falla de forma definitiva (error permanente o último intento de la cola), last_status vuelve al valor
// anterior, solo si nadie lo cambió, y queda en la actividad. PGlite propio y un fetch falso.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-connectors-restore-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
let db: Db;
let tenant: string;
const real = globalThis.fetch;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
}, 120_000);
afterAll(async () => {
  globalThis.fetch = real;
  await db?.close();
});

/** Conexión de BambooHR (estado en un campo del empleado), flujo, vínculo y una ejecución "sent". */
async function setup() {
  const { encrypt, uuidv7, sha256Hex } = await import("../src/lib/util");
  const [conn, flow, link, envelope, run] = [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [envelope, tenant]);
  await db.query(
    `INSERT INTO connector_connections (id, tenant_id, provider, category, name, auth_type, credentials_enc, config, webhook_token_hash, webhook_token_enc)
     VALUES ($1,$2,'bamboohr','hris','B','api_key',$3,$4,$5,$6)`,
    [conn, tenant, encrypt(JSON.stringify({ apiKey: "k" })), JSON.stringify({ companyDomain: "acme" }), sha256Hex(conn), encrypt("x")],
  );
  await db.query(`INSERT INTO connector_flows (id, tenant_id, connection_id, name, object_type, write_back) VALUES ($1,$2,$3,'f','employee',$4)`, [
    flow,
    tenant,
    conn,
    JSON.stringify({ statusProperty: "customCalaSign", uploadSigned: false }),
  ]);
  await db.query(`INSERT INTO connector_links (id, tenant_id, connection_id, flow_id, envelope_id, object_type, object_id) VALUES ($1,$2,$3,$4,$5,'employee','7')`, [
    link,
    tenant,
    conn,
    flow,
    envelope,
  ]);
  await db.query(
    `INSERT INTO connector_runs (id, tenant_id, connection_id, flow_id, link_id, envelope_id, kind, event, object_type, object_id) VALUES ($1,$2,$3,$4,$5,$6,'write_back','sent','employee','7')`,
    [run, tenant, conn, flow, link, envelope],
  );
  return { link, run };
}
const failing = (status: number, before?: () => Promise<void>) => {
  globalThis.fetch = (async () => {
    await before?.();
    return new Response(JSON.stringify({ message: "boom" }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
};
const lastStatus = async (link: string) => (await db.one<any>(`SELECT last_status FROM connector_links WHERE id = $1`, [link]))!.last_status;
const detail = async (run: string) => (await db.one<any>(`SELECT detail FROM connector_runs WHERE id = $1`, [run]))!.detail;

describe("write-back de conectores que falla de forma definitiva", () => {
  it("error permanente: last_status vuelve al valor anterior y queda en la actividad", async () => {
    const { handleConnectorJob } = await import("../src/modules/connectors");
    const { link, run } = await setup();
    failing(401);
    await handleConnectorJob({ db, blobs: {} as any }, { runId: run }, { attempts: 1, maxAttempts: 8 });
    expect(await lastStatus(link)).toBeNull();
    expect((await detail(run)).lastStatusRestored).toEqual({ from: "sent", to: null });
  });

  it("error transitorio: el reclamo se conserva hasta el último intento y ahí vuelve al valor de antes del primero", async () => {
    const { handleConnectorJob } = await import("../src/modules/connectors");
    const { link, run } = await setup();
    failing(500);
    await expect(handleConnectorJob({ db, blobs: {} as any }, { runId: run }, { attempts: 1, maxAttempts: 2 })).rejects.toThrow();
    expect(await lastStatus(link)).toBe("sent");
    await expect(handleConnectorJob({ db, blobs: {} as any }, { runId: run }, { attempts: 2, maxAttempts: 2 })).rejects.toThrow();
    expect(await lastStatus(link)).toBeNull();
    expect((await detail(run)).lastStatusRestored).toEqual({ from: "sent", to: null });
  });

  it("no restaura si otro trabajo cambió last_status después del reclamo", async () => {
    const { handleConnectorJob } = await import("../src/modules/connectors");
    const { link, run } = await setup();
    failing(401, async () => {
      await db.query(`UPDATE connector_links SET last_status = 'completed' WHERE id = $1`, [link]);
    });
    await handleConnectorJob({ db, blobs: {} as any }, { runId: run }, { attempts: 1, maxAttempts: 8 });
    expect(await lastStatus(link)).toBe("completed");
    expect((await detail(run)).lastStatusRestored).toBeUndefined();
  });
});
