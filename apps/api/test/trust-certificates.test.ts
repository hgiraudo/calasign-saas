// Certificados de confianza para Acrobat (GET /v1/public/trust-certificates): la raíz e intermedias de la cadena del
// sello, nunca el certificado del sello; descarga en DER y PEM con la misma huella. App real sobre PGlite, con la CA
// de desarrollo que genera el sello local.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-trust-"));
delete process.env.DATABASE_URL;

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

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("certificados de confianza de CalaSign", () => {
  it("lista la raíz (y las intermedias) sin sesión, nunca el certificado del sello", async () => {
    const { getSealProvider } = await import("../src/infra/seal");
    const chain = await (await getSealProvider()).certificateChain();
    const res = await app.inject({ method: "GET", url: "/v1/public/trust-certificates" });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { sha256: string; root: boolean; cerUrl: string; pemUrl: string; commonName: string | null }[];
    expect(items.length).toBe(chain.length - 1);
    expect(items[0].root).toBe(true);
    // El del sello (el primero de la cadena) no se publica.
    expect(items.map((i) => i.sha256)).not.toContain(sha(Buffer.from(chain[0])));
    expect(items.map((i) => i.sha256).sort()).toEqual(
      chain
        .slice(1)
        .map((d) => sha(Buffer.from(d)))
        .sort(),
    );
  });

  it("descarga en DER (.cer, para Acrobat) y en PEM, con la misma huella", async () => {
    const [root] = (await app.inject({ method: "GET", url: "/v1/public/trust-certificates" })).json().items;
    const cer = await app.inject({ method: "GET", url: root.cerUrl });
    expect(cer.statusCode).toBe(200);
    expect(cer.headers["content-type"]).toContain("application/pkix-cert");
    expect(String(cer.headers["content-disposition"])).toMatch(/attachment; filename=".+\.cer"/);
    expect(sha(cer.rawPayload)).toBe(root.sha256);

    const pem = await app.inject({ method: "GET", url: root.pemUrl });
    expect(pem.statusCode).toBe(200);
    const body = pem.body;
    expect(body).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    const der = Buffer.from(body.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
    expect(sha(der)).toBe(root.sha256);
  });

  it("404 para lo que no es una autoridad publicada (incluido el certificado del sello)", async () => {
    const { getSealProvider } = await import("../src/infra/seal");
    const leaf = sha(Buffer.from((await (await getSealProvider()).certificateChain())[0]));
    for (const file of [`${leaf}.cer`, `${"0".repeat(64)}.cer`, "nada.cer", `${leaf}.exe`]) {
      expect((await app.inject({ method: "GET", url: `/v1/public/trust-certificates/${file}` })).statusCode, file).toBe(404);
    }
  });

  it("si el proveedor del sello pasa a otra cadena, la lista la sigue (no queda la del arranque)", async () => {
    const { getSealProvider } = await import("../src/infra/seal");
    const provider = await getSealProvider();
    const chain = await provider.certificateChain();
    const list = async () => (await app.inject({ method: "GET", url: "/v1/public/trust-certificates" })).json().items as unknown[];
    expect((await list()).length).toBe(chain.length - 1);
    // Otra cadena (acá, sin autoridades): la lista cambia sin reiniciar.
    const original = provider.certificateChain.bind(provider);
    provider.certificateChain = async () => [chain[0]!];
    try {
      expect(await list()).toEqual([]);
    } finally {
      provider.certificateChain = original;
    }
    expect((await list()).length).toBe(chain.length - 1);
  });
});
