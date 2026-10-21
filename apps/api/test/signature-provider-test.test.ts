// Prueba de conectores CSC de la plataforma: no hay rol de operador de plataforma, así que cualquier administrador de
// una organización la puede usar. Solo devuelve ok/error y el titular (sin credenciales, certificado completo ni el
// error del prestador), tiene un tope por organización y el listado no muestra la URL del prestador. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-sigprov-"));
delete process.env.DATABASE_URL;
process.env.CSC_CONNECTORS = JSON.stringify([{ id: "csc:prestador", baseUrl: "https://csc.prestador-secreto.example/csc/v2", auth: { type: "bearer", token: "t" } }]);

const fake: { chain: Uint8Array[]; fail: Error | null } = { chain: [], fail: null };
vi.mock("../src/modules/evidence-seal", async (orig) => ({
  ...(await orig<typeof import("../src/modules/evidence-seal")>()),
  getCscProvider: (id: string) =>
    id === "csc:prestador"
      ? {
          id,
          level: "qualified",
          client: { listCredentials: async () => ["cred-secreta-1", "cred-secreta-2"] },
          certificateChain: async () => fake.chain,
          signDigest: async () => {
            if (fake.fail) throw fake.fail;
            return new Uint8Array(256);
          },
        }
      : null,
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
const KEY_A = "cs_test_sigprov_a";
const KEY_B = "cs_test_sigprov_b";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  const { generateDevRootCa, pemToDerList } = await import("@calasign/pdf");
  db = await createDb();
  await migrate(db);
  for (const key of [KEY_A, KEY_B]) {
    const tenant = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(key)]);
  }
  fake.chain = pemToDerList((await generateDevRootCa("Prestador Titular SA")).certPem);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const test = (key: string) => app.inject({ method: "POST", url: "/v1/signature-providers/csc:prestador/test", headers: { authorization: `Bearer ${key}` }, payload: {} });

describe("conectores de firma de la plataforma", () => {
  it("el listado no muestra la URL del prestador", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/signature-providers", headers: { authorization: `Bearer ${KEY_A}` } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("prestador-secreto");
    expect(r.json().items.find((p: any) => p.id === "csc:prestador")).toMatchObject({ type: "csc", baseUrl: null, configured: true });
  });

  it("la prueba devuelve ok y el titular, sin credenciales ni certificado; el error del prestador no sale", async () => {
    const ok = await test(KEY_A);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ id: "csc:prestador", ok: true, holder: "Prestador Titular SA", signatureVerified: true, error: null });
    expect(ok.body).not.toContain("cred-secreta");
    fake.fail = new Error("CSC signatures/signHash: token https://csc.prestador-secreto.example inválido");
    const bad = await test(KEY_A);
    fake.fail = null;
    expect(bad.json()).toMatchObject({ ok: false, signatureVerified: false });
    expect(bad.body).not.toContain("prestador-secreto");
  });

  it("hasta 5 pruebas por hora por organización", async () => {
    for (let i = 0; i < 3; i++) expect((await test(KEY_A)).statusCode).toBe(200);
    const limited = await test(KEY_A);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("provider_test_limit");
    // Otra organización tiene su propio cupo.
    expect((await test(KEY_B)).statusCode).toBe(200);
  });

  it("pruebas en paralelo no pasan el tope (candado por organización)", async () => {
    // KEY_B ya usó 1: de 8 simultáneas pasan exactamente 4.
    const rs = await Promise.all(Array.from({ length: 8 }, () => test(KEY_B)));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(4);
    expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(4);
  });
});
