// SEG-20: la app real (buildApp) loguea con safeLoggerOptions: el log de acceso sin la búsqueda ni el correo de la
// query, y cualquier log de un handler sin los datos personales del objeto. Los casos de cada clave están en
// redact.test.ts (unitario, bajo mutation testing); acá, que el cableado no se pierda. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-logs-pii-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let out = "";
const lineas = () =>
  out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  db = await createDb();
  await migrate(db);
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  app = await buildApp({ db, blobs: createBlobStore(), logger: { level: "info", stream } });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("logs de la app sin datos personales", () => {
  it("el log de acceso no lleva la búsqueda ni el correo de la query", async () => {
    out = "";
    await app.inject({ method: "GET", url: "/v1/envelopes?q=Ana%20Perez&login_hint=ana.perez%40example.com&limit=5" });
    const urls = lineas()
      .filter((l) => l.req?.url)
      .map((l) => l.req.url as string);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toContain("q=[redactado]");
      expect(u).toContain("login_hint=[redactado]");
      expect(u).toContain("limit=5");
    }
    expect(out).not.toMatch(/Ana|ana\.perez/);
  });
  it("un log con el destinatario, el correo o el documento sale censurado (y el error, enmascarado)", () => {
    out = "";
    app.log.warn(
      {
        recipientId: "r-1",
        recipient: { name: "Ana Perez", email: "ana.perez@example.com" },
        signerEmail: "ana.perez@example.com",
        cpf: "123.456.789-09",
        err: new Error("550 ana.perez@example.com no existe"),
      },
      "aviso fallido",
    );
    const [l] = lineas();
    expect(l).toMatchObject({ recipientId: "r-1", recipient: "[redactado]", signerEmail: "[redactado]", cpf: "[redactado]" });
    expect(l.err.message).toBe("550 an***@example.com no existe");
    expect(out).not.toMatch(/Ana|ana\.perez|123\.456/);
  });
});
