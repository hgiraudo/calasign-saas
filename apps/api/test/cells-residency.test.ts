// Residencia de datos (celdas): celda de cada job (0115) y toma solo de las celdas que atiende el worker (SERVED_CELLS),
// enrutamiento 421 de las rutas públicas que identifican a la organización (formularios, negociaciones, workflows) y
// falla cerrada con una celda que no está configurada en el despliegue (nunca la por defecto).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-cells-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
let db: Db;
let cellsMod: typeof import("../src/infra/cells");
let queue: typeof import("../src/infra/queue");
let util: typeof import("../src/lib/util");
const T: Record<string, string> = {};

const TWO_CELLS = JSON.stringify({ us: { default: true, baseUrl: "https://us.example" }, br: { baseUrl: "https://br.example" } });
const setCells = (cells: string | null, served: string | null) => {
  if (cells) process.env.CELLS = cells;
  else delete process.env.CELLS;
  if (served) process.env.SERVED_CELLS = served;
  else delete process.env.SERVED_CELLS;
  cellsMod.resetCells();
};

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  cellsMod = await import("../src/infra/cells");
  queue = await import("../src/infra/queue");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  for (const cell of ["us", "br", "local", "xx"]) {
    const id = util.uuidv7();
    T[cell] = id;
    await db.query(`INSERT INTO tenants (id, slug, name, cell) VALUES ($1,$2,'Org',$3)`, [id, `t-${cell}-${id.slice(-6)}`, cell]);
  }
}, 120_000);
afterAll(async () => db?.close());
afterEach(() => setCells(null, null));

const cellOf = async (dedupe: string) => (await db.one<any>(`SELECT cell FROM jobs WHERE dedupe_key = $1`, [dedupe]))?.cell ?? null;

describe("celda de los jobs", () => {
  it("con varias celdas: la de la organización (payload.tenantId, opts.tenantId o el sobre); ids viejos = la por defecto", async () => {
    setCells(TWO_CELLS, null);
    const env = util.uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1,$2,'S','sent')`, [env, T.br]);
    await queue.enqueue(db, "notify", { kind: "invite", tenantId: T.br }, { dedupeKey: "c1" });
    await queue.enqueue(db, "notify", { kind: "invite", tenantId: T.us }, { dedupeKey: "c2" });
    await queue.enqueue(db, "notify", { kind: "invite", tenantId: T.local }, { dedupeKey: "c3" });
    await queue.enqueue(db, "platform", { kind: "export", envelopeId: env }, { dedupeKey: "c4" });
    await queue.enqueue(db, "webhook", { kind: "deliver", deliveryId: "x" }, { dedupeKey: "c5", tenantId: T.br });
    await queue.enqueue(db, "notify", { kind: "password_reset", userId: "u" }, { dedupeKey: "c6" });
    await queue.enqueue(db, "notify", { kind: "invite", tenantId: T.xx }, { dedupeKey: "c7" });
    expect([
      await cellOf("c1"),
      await cellOf("c2"),
      await cellOf("c3"),
      await cellOf("c4"),
      await cellOf("c5"),
      await cellOf("c6"),
      await cellOf("c7"),
    ]).toEqual([
      "br",
      "us",
      "us",
      "br",
      "br",
      null,
      "xx", // celda no configurada acá: ningún worker de este despliegue la toma
    ]);
  });

  it("jobs de la cola agreements con solo el id del acuerdo / run / negociación: la celda de su organización", async () => {
    setCells(TWO_CELLS, null);
    const file = util.uuidv7();
    await db.query(
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',1,$4)`,
      [file, T.br, `tenants/${T.br}/a/${file}.pdf`, "a".repeat(64)],
    );
    const ag = util.uuidv7();
    await db.query(`INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title) VALUES ($1,$2,'external',$3,'a.pdf','A')`, [
      ag,
      T.br,
      file,
    ]);
    await queue.enqueue(db, "agreements", { kind: "expiry_notice", agreementId: ag, expiryDate: "2030-01-01" }, { dedupeKey: "agr1" });
    expect(await cellOf("agr1")).toBe("br");
    // Un id que no existe: sin celda (cualquier worker), como antes.
    await queue.enqueue(db, "agreements", { kind: "advance", runId: util.uuidv7() }, { dedupeKey: "agr2" });
    expect(await cellOf("agr2")).toBeNull();
  });

  it("con una sola celda no se fija (cualquier worker, como siempre)", async () => {
    setCells(null, null);
    await queue.enqueue(db, "notify", { kind: "invite", tenantId: T.br }, { dedupeKey: "s1" });
    expect(await cellOf("s1")).toBeNull();
  });

  it("un worker con SERVED_CELLS solo toma los de sus celdas y los sin celda", async () => {
    await db.query(`DELETE FROM jobs`);
    setCells(TWO_CELLS, "br");
    await queue.enqueue(db, "notify", { kind: "x", tenantId: T.br }, { dedupeKey: "w-br" });
    await queue.enqueue(db, "notify", { kind: "x", tenantId: T.us }, { dedupeKey: "w-us" });
    await queue.enqueue(db, "notify", { kind: "x" }, { dedupeKey: "w-none" });
    const seen: string[] = [];
    const log = { info() {}, error() {} };
    const worker = queue.startWorker(db, {
      handlers: { notify: async (p: any, job: any) => void seen.push(String(job.id)) } as any,
      pollMs: 20,
      log,
    });
    try {
      const end = Date.now() + 5000;
      while (seen.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await worker.stop();
    }
    const rows = await db.query<any>(`SELECT dedupe_key, status FROM jobs ORDER BY dedupe_key`);
    expect(rows).toEqual([
      { dedupe_key: "w-br", status: "done" },
      { dedupe_key: "w-none", status: "done" },
      { dedupe_key: "w-us", status: "pending" },
    ]);
  });
});

describe("celdas no configuradas: falla cerrada", () => {
  it("los ids viejos caen en la por defecto; uno de otra celda no configurada, no", async () => {
    setCells(JSON.stringify({ us: { default: true } }), null);
    expect(cellsMod.cellById("local").id).toBe("us");
    expect(cellsMod.cellById(null).id).toBe("us");
    expect(cellsMod.cellById("dev").id).toBe("us");
    expect(() => cellsMod.cellById("br")).toThrow(cellsMod.CellNotConfiguredError);
    expect(cellsMod.effectiveCellId("br")).toBe("br");
  });

  it("el almacenamiento de una organización de una celda no configurada no guarda ni lee en la por defecto (503 wrong_cell)", async () => {
    setCells(JSON.stringify({ us: { default: true } }), null);
    const storage = await import("../src/infra/storage");
    const tenant = util.uuidv7();
    const store = storage.createBlobStore({
      resolve: async () => ({ cell: "br", byokKeyArn: null, byokStatus: "none" as const }),
      onKeyFailure: async () => {},
      onKeySuccess: async () => {},
    });
    await expect(store.put(`tenants/${tenant}/x.pdf`, new Uint8Array([1]), "application/pdf")).rejects.toMatchObject({
      status: 503,
      code: "wrong_cell",
    });
    await expect(store.get(`tenants/${tenant}/x.pdf`)).rejects.toMatchObject({ status: 503, code: "wrong_cell" });
  });
});

describe("enrutamiento de las rutas públicas", () => {
  type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
  let app: App;
  const slug: Record<string, string> = {};
  const runToken: Record<string, string> = {};

  beforeAll(async () => {
    const { buildApp } = await import("../src/app");
    const { createBlobStore } = await import("../src/infra/storage");
    for (const cell of ["us", "br", "xx"]) {
      const wf = util.uuidv7();
      slug[cell] = `wf-${cell}-${wf.slice(-6)}`;
      await db.query(
        `INSERT INTO workflows (id, tenant_id, name, active, public_start, public_slug, steps, signing_secret_enc) VALUES ($1,$2,'W',true,true,$3,'[]'::jsonb,'x')`,
        [wf, T[cell], slug[cell]],
      );
      runToken[cell] = util.randomToken();
      await db.query(`INSERT INTO workflow_runs (id, tenant_id, workflow_id, steps, public_token_hash) VALUES ($1,$2,$3,'[]'::jsonb,$4)`, [
        util.uuidv7(),
        T[cell],
        wf,
        util.sha256Hex(runToken[cell]),
      ]);
    }
    app = await buildApp({ db, blobs: createBlobStore(), logger: false });
    await app.ready();
  }, 120_000);
  afterAll(async () => app?.close());

  it("solo la lista de celdas y la marca quedan exentas; workflows y ejecuciones públicas de otra celda: 421 con la URL correcta", async () => {
    setCells(TWO_CELLS, "br");
    expect((await app.inject({ method: "GET", url: "/v1/public/cells" })).statusCode).toBe(200);
    const wrong = await app.inject({ method: "GET", url: `/v1/public/workflows/${slug.us}` });
    expect(wrong.statusCode).toBe(421);
    expect(wrong.headers.location).toBe(`https://us.example/v1/public/workflows/${slug.us}`);
    expect(wrong.json().error.code).toBe("wrong_cell");
    expect((await app.inject({ method: "POST", url: `/v1/public/workflows/${slug.us}/start`, payload: {} })).statusCode).toBe(421);
    expect((await app.inject({ method: "GET", url: `/v1/public/workflow-runs/${runToken.us}` })).statusCode).toBe(421);
    // De su celda: lo atiende (lo que responda la ruta, pero no 421).
    expect((await app.inject({ method: "GET", url: `/v1/public/workflows/${slug.br}` })).statusCode).not.toBe(421);
    expect((await app.inject({ method: "GET", url: `/v1/public/workflow-runs/${runToken.br}` })).statusCode).not.toBe(421);
    // Sin organización deducible (slug inexistente): lo atiende (404 de la ruta).
    expect((await app.inject({ method: "GET", url: "/v1/public/workflows/no-existe" })).statusCode).not.toBe(421);
    expect(cellsModExempt("/v1/public/brand-theme?b=x")).toBe(true);
    expect(cellsModExempt("/v1/public/forms/abc/submit")).toBe(false);
  });

  it("organización de una celda que este despliegue no conoce: 503 wrong_cell (nunca la por defecto)", async () => {
    setCells(TWO_CELLS, "br");
    const r = await app.inject({ method: "GET", url: `/v1/public/workflows/${slug.xx}` });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("wrong_cell");
  });

  let cellsModExempt: (u: string) => boolean;
  beforeAll(async () => {
    cellsModExempt = (await import("../src/modules/data/cells")).cellExemptPath;
  });
});
