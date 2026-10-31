// CSP con APP_URL https (dev y producción): upgrade-insecure-requests sigue. La contraparte con http está en
// http-headers.test.ts. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-http-headers-https-"));
delete process.env.DATABASE_URL;
// Antes de importar config.
process.env.APP_URL = "https://app.calasign.test";

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("CSP con APP_URL https", () => {
  it("pide upgrade-insecure-requests en las páginas y en la API", async () => {
    for (const url of ["/login", "/v1/me"]) {
      const csp = String((await app.inject({ method: "GET", url })).headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toMatch(/(^|;)upgrade-insecure-requests(;|$)/);
    }
  });
});
