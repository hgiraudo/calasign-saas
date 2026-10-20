// Envío masivo: CSV (comillas sin cerrar, encabezados repetidos, separador, tope de filas), filas repetidas, y el worker
// (reintento ante errores del momento, cierre en el último intento, corte tras agotar el cupo).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-bulk-hardening-"));
delete process.env.DATABASE_URL;

// Plantilla y dueño siempre válidos; el alta del sobre la decide cada prueba.
const behavior: { fail: (n: number) => unknown; load: () => unknown } = { fail: () => null, load: () => null };
let calls = 0;
vi.mock("../src/modules/owner-check", () => ({ ownerCanStillCreate: vi.fn(async () => null) }));
vi.mock("../src/modules/templates", async (orig) => ({
  ...(await orig<typeof import("../src/modules/templates")>()),
  loadTemplateForUse: vi.fn(async () => {
    const err = behavior.load();
    if (err) throw err;
    return { tpl: { roles: [], template: { id: "tpl" } } };
  }),
  planFromTemplate: vi.fn(() => ({})),
  insertEnvelopeFromTemplate: vi.fn(async () => {
    const err = behavior.fail(++calls);
    if (err) throw err;
    return null;
  }),
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
let db: Db;
let tenant: string;
let user: string;
let tpl: string;
const log = { info: () => {}, warn: () => {} };
const netError = (code = "ECONNRESET") => Object.assign(new Error("connection reset"), { code });

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
  user = uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'ana@x.com', 'Ana', 'x')`, [user]);
  tpl = uuidv7();
  await db.query(`INSERT INTO templates (id, tenant_id, name, created_by) VALUES ($1, $2, 'Plantilla', $3)`, [tpl, tenant, user]);
}, 120_000);
afterAll(async () => db?.close());

async function bulkWith(n: number) {
  const { uuidv7 } = await import("../src/lib/util");
  const bulk = uuidv7();
  await db.query(
    `INSERT INTO bulk_sends (id, tenant_id, template_id, template_name, status, total, options, actor, created_by) VALUES ($1, $2, $3, 'Plantilla', 'running', $4, '{}', $5, $6)`,
    [bulk, tenant, tpl, n, JSON.stringify({ type: "user", id: user, label: "Ana" }), user],
  );
  const items: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = uuidv7();
    items.push(id);
    const input = { templateId: tpl, recipients: [{ roleId: uuidv7(), name: `P${i}`, email: `p${i}@x.com`, channels: ["email"] }], send: true };
    await db.query(`INSERT INTO bulk_send_items (id, tenant_id, bulk_send_id, row_number, input, status) VALUES ($1, $2, $3, $4, $5, 'pending')`, [
      id,
      tenant,
      bulk,
      i,
      JSON.stringify(input),
    ]);
  }
  return { bulk, items };
}
const statuses = async (bulk: string) =>
  (await db.query<any>(`SELECT status FROM bulk_send_items WHERE bulk_send_id = $1 ORDER BY row_number`, [bulk])).map((r) => r.status);
const bulkStatus = async (bulk: string) => (await db.one<any>(`SELECT status FROM bulk_sends WHERE id = $1`, [bulk]))!.status;

describe("CSV del envío masivo", () => {
  it("comilla sin cerrar → error de archivo con la línea", async () => {
    const { csvToRows } = await import("../src/modules/bulk");
    const r = csvToRows('Cliente.name,Cliente.email\nAna,ana@x.com\n"Bea,bea@x.com\n', [{ id: "r1", name: "Cliente" }]);
    expect(r.rows).toEqual([]);
    expect(r.fileErrors[0]).toMatch(/comilla sin cerrar.*línea 3/);
  });

  it("encabezados repetidos (también dos alias del mismo dato) → error", async () => {
    const { csvToRows } = await import("../src/modules/bulk");
    const roles = [{ id: "r1", name: "Cliente" }];
    expect(csvToRows("Cliente.email,cliente.email\na@x.com,b@x.com\n", roles).fileErrors).toEqual(['Columna "cliente.email" repetida']);
    expect(csvToRows("Cliente.email,Cliente.correo\na@x.com,b@x.com\n", roles).fileErrors[0]).toMatch(/mismo dato/);
    expect(csvToRows("field.Plan,campo.plan\nx,y\n", roles).fileErrors[0]).toMatch(/mismo dato/);
  });

  it("separador: el que más aparece en el encabezado (fuera de comillas)", async () => {
    const { parseCsv } = await import("../src/modules/bulk");
    // Líneas vacías al principio: se mira la primera con datos.
    expect(parseCsv("\n\r\na;b;c\n1;2;3\n")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    // Una comilla suelta en medio de un campo sin comillas no esconde los separadores que siguen.
    expect(parseCsv('Pulg";a;b\n1;2;3\n')).toEqual([['Pulg"', "a", "b"], ["1", "2", "3"]]);
    expect(parseCsv("a;b\tc\td\n1;2\t3\t4\n")).toEqual([["a;b", "c", "d"], ["1;2", "3", "4"]]);
    expect(parseCsv('"x,y,z";b;c\n1;2;3\n')).toEqual([["x,y,z", "b", "c"], ["1", "2", "3"]]);
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("corta la lectura al pasar el máximo de filas", async () => {
    const { parseCsv, csvToRows } = await import("../src/modules/bulk");
    const { BULK_MAX_ROWS } = await import("@calasign/shared");
    expect(parseCsv("h\n1\n2\n3\n4\n", 2)).toEqual([["h"], ["1"], ["2"]]);
    const big = "Cliente.email\n" + "a@x.com\n".repeat(BULK_MAX_ROWS + 5);
    const r = csvToRows(big, [{ id: "r1", name: "Cliente" }]);
    expect(r.tooManyRows).toBe(true);
    expect(r.rows).toEqual([]);
    expect(csvToRows("Cliente.email\n" + "a@x.com\n".repeat(BULK_MAX_ROWS), [{ id: "r1", name: "Cliente" }]).rows).toHaveLength(BULK_MAX_ROWS);
  });

  it("filas repetidas: mismos destinatarios y prellenado (sin importar mayúsculas del correo ni el orden)", async () => {
    const { duplicateRows } = await import("../src/modules/bulk");
    const row = (email: string, plan: string) => ({ templateId: "t", recipients: [{ roleId: "r1", name: "Ana", email }], prefill: { Plan: plan }, send: true }) as any;
    expect(
      duplicateRows([
        { row: 1, input: row("ana@x.com", "Oro") },
        { row: 2, input: row("ANA@x.com", "Oro") },
        { row: 3, input: row("ana@x.com", "Plata") },
        { row: 4, input: null },
        { row: 5, input: row("ana@x.com", "Oro") },
      ]),
    ).toEqual([
      { row: 2, sameAs: 1 },
      { row: 5, sameAs: 1 },
    ]);
  });
});

describe("worker del envío masivo", () => {
  it("un error del momento se relanza (la fila sigue pendiente) y el reintento la envía", async () => {
    const { handleBulkJob } = await import("../src/modules/bulk");
    const { bulk, items } = await bulkWith(3);
    calls = 0;
    behavior.fail = (n) => (n === 2 ? netError() : null);
    await expect(handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: items }, { attempts: 1, maxAttempts: 8 })).rejects.toThrow("connection reset");
    expect(await statuses(bulk)).toEqual(["sent", "pending", "pending"]);
    expect(await bulkStatus(bulk)).toBe("running");
    behavior.fail = () => null;
    await handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: items }, { attempts: 2, maxAttempts: 8 });
    expect(await statuses(bulk)).toEqual(["sent", "sent", "sent"]);
    expect(await bulkStatus(bulk)).toBe("completed");
  });

  it("transitorios: conexión, serialización, deadlock (también en cause); el resto no", async () => {
    const { isTransientError } = await import("../src/modules/bulk");
    expect(isTransientError(netError("ETIMEDOUT"))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "40001" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "40P01" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "08006" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true);
    expect(isTransientError(new Error("wrap", { cause: netError() }))).toBe(true);
    expect(isTransientError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientError(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
  });

  it("una excepción inesperada (no transitoria) marca fallida solo esa fila y sigue, sin relanzar", async () => {
    const { handleBulkJob } = await import("../src/modules/bulk");
    const { bulk, items } = await bulkWith(3);
    calls = 0;
    behavior.fail = (n) => (n === 2 ? new TypeError("Cannot read properties of undefined") : null);
    await handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: items }, { attempts: 1, maxAttempts: 8 });
    expect(await statuses(bulk)).toEqual(["sent", "failed", "sent"]);
    expect(await bulkStatus(bulk)).toBe("completed");
  });

  it("en el último intento, un error del momento deja fallida solo esa fila y sigue con las demás", async () => {
    const { handleBulkJob } = await import("../src/modules/bulk");
    const { bulk, items } = await bulkWith(3);
    calls = 0;
    behavior.fail = (n) => (n === 1 ? netError() : null);
    await handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: items }, { attempts: 8, maxAttempts: 8 });
    expect(await statuses(bulk)).toEqual(["failed", "sent", "sent"]);
    expect(await bulkStatus(bulk)).toBe("completed");
  });

  it("en el último intento, un error fuera de las filas cierra las de su ronda (no las reencoladas por retry-failed)", async () => {
    const { handleBulkJob } = await import("../src/modules/bulk");
    const { bulk, items } = await bulkWith(3);
    // La fila 3 ya la volvió a encolar "Reintentar fallidas" (ronda 1): es de otro job.
    await db.query(`UPDATE bulk_send_items SET retry_round = 1 WHERE id = $1`, [items[2]]);
    behavior.load = () => netError();
    try {
      await expect(handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: items }, { attempts: 8, maxAttempts: 8 })).rejects.toThrow("connection reset");
    } finally {
      behavior.load = () => null;
    }
    expect(await statuses(bulk)).toEqual(["failed", "failed", "pending"]);
    expect(await bulkStatus(bulk)).toBe("running");
    // El job de la ronda 1 la procesa; el viejo (ronda 0) ya no la toca.
    calls = 0;
    behavior.fail = () => null;
    await handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: [items[2]] }, { attempts: 1, maxAttempts: 8 });
    expect(calls).toBe(0);
    await handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: [items[2]], retryRound: 1 }, { attempts: 1, maxAttempts: 8 });
    expect(await statuses(bulk)).toEqual(["failed", "failed", "sent"]);
    expect(await bulkStatus(bulk)).toBe("completed");
  });

  it("un error de la fila (AppError) la marca fallida y sigue; tras el primer plan_limit el resto falla sin intentarse", async () => {
    const { handleBulkJob } = await import("../src/modules/bulk");
    const { AppError } = await import("../src/lib/errors");
    const { bulk, items } = await bulkWith(5);
    calls = 0;
    behavior.fail = (n) =>
      n === 1 ? new AppError(400, "invalid_prefill", "valor inválido") : n === 3 ? new AppError(402, "plan_limit", "Llegaste al límite de sobres") : null;
    await handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: items.slice(0, 4) });
    // La fila 5 (de otro job del mismo envío) también queda fallida: el cupo está agotado.
    expect(await statuses(bulk)).toEqual(["failed", "sent", "failed", "failed", "failed"]);
    expect(calls).toBe(3);
    expect(await bulkStatus(bulk)).toBe("completed");
    const errs = await db.query<any>(`SELECT error FROM bulk_send_items WHERE bulk_send_id = $1 AND row_number >= 3`, [bulk]);
    expect(errs.every((e) => /límite de sobres/.test(e.error))).toBe(true);
  });
});

describe("POST /v1/bulk-sends/:id/retry-failed", () => {
  it("reencola solo las fallidas con datos válidos; respeta el cupo del mes y no reintenta uno cancelado", async () => {
    const { createBlobStore } = await import("../src/infra/storage");
    const { buildApp } = await import("../src/app");
    const { sha256Hex, uuidv7 } = await import("../src/lib/util");
    const KEY = "cs_test_bulk_retry_key";
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
    const app = await buildApp({ db, blobs: createBlobStore(), logger: false });
    await app.ready();
    const headers = { authorization: `Bearer ${KEY}` };
    try {
      const { bulk, items } = await bulkWith(3);
      await db.query(`UPDATE bulk_sends SET status = 'completed', completed_at = now() WHERE id = $1`, [bulk]);
      await db.query(`UPDATE bulk_send_items SET status = 'failed', error = 'x' WHERE bulk_send_id = $1`, [bulk]);
      // Fila 3: falló por sus datos (se guardan solo los nombres): no se reintenta.
      await db.query(`UPDATE bulk_send_items SET input = '{"recipients":[{"name":"P3"}]}' WHERE id = $1`, [items[2]]);

      // Business: 1000 sobres por mes; con 999 enviados no entran las 2 filas.
      await db.query(`UPDATE tenants SET billing_plan = 'business' WHERE id = $1`, [tenant]);
      await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at) SELECT gen_random_uuid(), $1, 'x', 'sent', now() FROM generate_series(1, 999)`, [tenant]);
      const over = await app.inject({ method: "POST", url: `/v1/bulk-sends/${bulk}/retry-failed`, headers });
      expect(over.statusCode).toBe(402);
      expect(over.json().error.code).toBe("plan_limit");
      await db.query(`DELETE FROM envelopes WHERE tenant_id = $1 AND subject = 'x'`, [tenant]);

      // Las filas pendientes de otro envío en curso también ocupan el cupo: 998 enviados + 1 pendiente → queda 1.
      await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at) SELECT gen_random_uuid(), $1, 'x', 'sent', now() FROM generate_series(1, 998)`, [tenant]);
      const other = await bulkWith(1);
      expect((await app.inject({ method: "POST", url: `/v1/bulk-sends/${bulk}/retry-failed`, headers })).statusCode).toBe(402);
      await db.query(`UPDATE bulk_sends SET status = 'completed' WHERE id = $1`, [other.bulk]);
      await db.query(`DELETE FROM envelopes WHERE tenant_id = $1 AND subject = 'x'`, [tenant]);

      // El contador de fallidas que se pueden reintentar (la consola muestra el botón solo con alguna).
      const before = (await app.inject({ method: "GET", url: `/v1/bulk-sends/${bulk}`, headers })).json();
      expect(before).toMatchObject({ failed: 3, retryable: 2 });
      const ok = await app.inject({ method: "POST", url: `/v1/bulk-sends/${bulk}/retry-failed`, headers });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ status: "running", pending: 2, failed: 1, retryable: 0 });
      expect(await statuses(bulk)).toEqual(["pending", "pending", "failed"]);
      const jobs = await db.query<any>(`SELECT payload FROM jobs WHERE queue = 'bulk' AND payload->>'bulkSendId' = $1`, [bulk]);
      expect(jobs.map((j) => j.payload.itemIds)).toEqual([[items[0], items[1]]]);
      // Cada reintento es una ronda nueva (el cierre de un job viejo no toca estas filas).
      expect(jobs[0].payload.retryRound).toBe(1);
      const rounds = await db.query<any>(`SELECT retry_round FROM bulk_send_items WHERE id = ANY($1)`, [[items[0], items[1]]]);
      expect(rounds.map((r) => r.retry_round)).toEqual([1, 1]);

      // Nada para reintentar → 409; cancelado → 409.
      await db.query(`UPDATE bulk_send_items SET status = 'sent' WHERE id = ANY($1)`, [[items[0], items[1]]]);
      expect((await app.inject({ method: "POST", url: `/v1/bulk-sends/${bulk}/retry-failed`, headers })).json().error.code).toBe("nothing_to_retry");
      await db.query(`UPDATE bulk_sends SET status = 'cancelled' WHERE id = $1`, [bulk]);
      expect((await app.inject({ method: "POST", url: `/v1/bulk-sends/${bulk}/retry-failed`, headers })).json().error.code).toBe("not_retryable");
    } finally {
      await db.query(`UPDATE tenants SET billing_plan = NULL WHERE id = $1`, [tenant]);
      await app.close();
    }
  });
});
