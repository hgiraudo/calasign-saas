// Alta con región (migración 0125), app real sobre PGlite: la región elegida que este despliegue no tiene configurada
// queda en tenants.requested_cell y la organización en la celda por defecto; una configurada no deja requested_cell;
// una fuera del catálogo da 400.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-cells-signup-"));
delete process.env.DATABASE_URL;
delete process.env.CELLS;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  (await import("../src/infra/cells")).resetCells();
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("alta con región", () => {
  const stamp = Date.now();
  const alta = (email: string, cell: string) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { name: "Ana", email, password: "una-clave-segura-123", organization: `Org ${email}`, cell },
    });
  const filaDe = (email: string) =>
    db.one<{ cell: string; requested_cell: string | null; dir_cell: string }>(
      `SELECT t.cell, t.requested_cell, d.cell AS dir_cell FROM tenants t JOIN tenant_directory d ON d.tenant_id = t.id
         JOIN memberships m ON m.tenant_id = t.id JOIN users u ON u.id = m.user_id WHERE u.email = $1`,
      [email],
    );

  it("una región sin configurar: celda por defecto y la pedida guardada", async () => {
    const email = `cl+${stamp}@example.com`;
    expect((await alta(email, "cl")).statusCode).toBe(201);
    expect(await filaDe(email)).toEqual({ cell: "us", requested_cell: "cl", dir_cell: "us" });
  });

  it("la región configurada: sin requested_cell", async () => {
    const email = `us+${stamp}@example.com`;
    expect((await alta(email, "us")).statusCode).toBe(201);
    expect(await filaDe(email)).toEqual({ cell: "us", requested_cell: null, dir_cell: "us" });
  });

  it("una región fuera del catálogo: 400 cell_unavailable", async () => {
    const r = await alta(`marte+${stamp}@example.com`, "marte");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("cell_unavailable");
  });
});
