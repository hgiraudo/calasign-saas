import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-bulk-plan-"));
delete process.env.DATABASE_URL;

// Plantilla y dueño siempre válidos: la prueba aísla el chequeo del plan vigente.
const created: string[] = [];
vi.mock("../src/modules/owner-check", () => ({ ownerCanStillCreate: vi.fn(async () => null) }));
vi.mock("../src/modules/templates", async (orig) => ({
  ...(await orig<typeof import("../src/modules/templates")>()),
  loadTemplateForUse: vi.fn(async () => ({ tpl: { roles: [], template: { id: "tpl" } } })),
  planFromTemplate: vi.fn(() => ({})),
  insertEnvelopeFromTemplate: vi.fn(async () => {
    created.push(`env-${created.length + 1}`);
    return null;
  }),
}));

describe("envío masivo y plan vigente", () => {
  it("si la organización pasó a un plan sin envío masivo, las filas que faltan no se envían", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { handleBulkJob } = await import("../src/modules/bulk");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);

    const tenant = uuidv7();
    // Starter no incluye bulk_send (el envío se lanzó con Business y después se bajó de plan).
    await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', 'starter')`, [tenant, `t-${tenant.slice(-8)}`]);
    const user = uuidv7();
    await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'ana@x.com', 'Ana', 'x')`, [user]);
    const tpl = uuidv7();
    await db.query(`INSERT INTO templates (id, tenant_id, name, created_by) VALUES ($1, $2, 'Plantilla', $3)`, [tpl, tenant, user]);
    const bulk = uuidv7();
    await db.query(
      `INSERT INTO bulk_sends (id, tenant_id, template_id, template_name, status, total, options, actor, created_by)
       VALUES ($1, $2, $3, 'Plantilla', 'running', 1, '{}', $4, $5)`,
      [bulk, tenant, tpl, JSON.stringify({ type: "user", id: user, label: "Ana" }), user],
    );
    const item = uuidv7();
    const input = { templateId: tpl, recipients: [{ roleId: uuidv7(), name: "Bea", email: "bea@x.com", channels: ["email"] }], send: true };
    await db.query(
      `INSERT INTO bulk_send_items (id, tenant_id, bulk_send_id, row_number, input, status) VALUES ($1, $2, $3, 1, $4, 'pending')`,
      [item, tenant, bulk, JSON.stringify(input)],
    );

    const log = { info: () => {}, warn: () => {} };
    await handleBulkJob({ db, log }, { bulkSendId: bulk, tenantId: tenant, itemIds: [item] });

    const row = await db.one<any>(`SELECT status, error FROM bulk_send_items WHERE id = $1`, [item]);
    expect(created).toEqual([]);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/no incluye el envío masivo/);
    await db.close();
  }, 180_000);
});
