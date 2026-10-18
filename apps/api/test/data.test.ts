import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-data-"));

const TENANT_A = "0192f0e0-0000-7000-8000-00000000000a";
const TENANT_B = "0192f0e0-0000-7000-8000-00000000000b";
const OK_ARN = "arn:aws:kms:us-east-1:111122223333:key/mock-ok";
const BAD_ARN = "arn:aws:kms:us-east-1:111122223333:key/mock-failing";

let kms: typeof import("../src/infra/kms");
let storage: typeof import("../src/infra/storage");
let cellsMod: typeof import("../src/infra/cells");
let custody: typeof import("../src/modules/custody");
let byok: typeof import("../src/modules/data/byok");

// Importar custody/byok arrastra media API (pdf, forge, AWS SDK): bajo carga eso solo tardaba más que el timeout
// por defecto del test. Se cargan una vez acá, con un timeout holgado, y los tests quedan deterministas.
beforeAll(async () => {
  kms = await import("../src/infra/kms");
  storage = await import("../src/infra/storage");
  cellsMod = await import("../src/infra/cells");
  kms.setKmsClientFactory(() => kms.mockKms());
  custody = await import("../src/modules/custody");
  byok = await import("../src/modules/data/byok");
}, 120_000);

afterEach(() => {
  delete process.env.CELLS;
  cellsMod.resetCells();
  storage.setS3ClientFactory(null);
});

describe("celdas", () => {
  it("sin CELLS hay una sola celda por defecto con el almacenamiento de siempre", () => {
    const c = cellsMod.parseCells(undefined, { storage: { driver: "local", bucket: "", prefix: "", region: "us-east-1" }, dataDir: "/data", defaultId: "us" });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: "us", default: true, storage: { driver: "local", dir: "/data/blobs" } });
  });

  it("CELLS: varias celdas; la por defecto en disco sigue en var/blobs; ids viejos caen en la por defecto", () => {
    process.env.CELLS = JSON.stringify({ us: { label: "Estados Unidos", default: true }, br: { label: "Brasil", region: "sa-east-1" } });
    cellsMod.resetCells();
    const all = cellsMod.cells();
    expect(all.map((c) => c.id)).toEqual(["us", "br"]);
    expect(all[0].storage.dir).toMatch(/blobs$/);
    expect(all[1].storage.dir).toMatch(/blobs-br$/);
    expect(cellsMod.cellById("local").id).toBe("us");
    expect(cellsMod.cellById("br").id).toBe("br");
  });

  it("CELLS inválido falla al arrancar", () => {
    expect(() => cellsMod.parseCells("{nope")).toThrow(/JSON/);
    expect(() => cellsMod.parseCells(JSON.stringify({ "MAL ID": {} }))).toThrow(/inválido/);
    expect(() => cellsMod.parseCells(JSON.stringify({ us: { storage: { driver: "s3" } } }))).toThrow(/bucket/);
    expect(() => cellsMod.parseCells(JSON.stringify({ a: { default: true }, b: { default: true } }))).toThrow(/más de una/);
  });
});

/** Resolver de prueba: celda y clave por organización, registra fallas. */
function fakeResolver(map: Record<string, { cell: string; byokKeyArn: string | null; byokStatus: "none" | "active" | "failing" }>) {
  const failures: string[] = [];
  const successes: string[] = [];
  return {
    failures,
    successes,
    resolver: {
      resolve: async (t: string) => map[t] ?? { cell: "us", byokKeyArn: null, byokStatus: "none" as const },
      onKeyFailure: async (t: string, arn: string) => void failures.push(`${t}:${arn}`),
      onKeySuccess: async (t: string) => void successes.push(t),
    },
  };
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("almacenamiento por celda y BYOK", () => {
  it("cada organización va a la celda de su directorio", async () => {
    process.env.CELLS = JSON.stringify({ us: { default: true }, br: {} });
    cellsMod.resetCells();
    const { resolver } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: null, byokStatus: "none" }, [TENANT_B]: { cell: "br", byokKeyArn: null, byokStatus: "none" } });
    const store = storage.createBlobStore(resolver);
    await store.put(`tenants/${TENANT_A}/x/a.pdf`, new TextEncoder().encode("A"), "application/pdf");
    await store.put(`tenants/${TENANT_B}/x/b.pdf`, new TextEncoder().encode("B"), "application/pdf");
    const dirs = cellsMod.cells();
    expect(filesUnder(dirs[0].storage.dir!).some((f) => f.endsWith("a.pdf"))).toBe(true);
    expect(filesUnder(dirs[1].storage.dir!).some((f) => f.endsWith("b.pdf"))).toBe(true);
    expect(filesUnder(dirs[1].storage.dir!).some((f) => f.endsWith("a.pdf"))).toBe(false);
    expect(new TextDecoder().decode(await store.get(`tenants/${TENANT_B}/x/b.pdf`))).toBe("B");
  });

  it("con BYOK en disco el archivo queda cifrado con una clave de datos de la clave del cliente", async () => {
    const { resolver } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
    const store = storage.createBlobStore(resolver);
    const secret = "contrato confidencial ñandú";
    await store.put(`tenants/${TENANT_A}/byok/doc.pdf`, new TextEncoder().encode(secret), "application/pdf");
    const onDisk = readFileSync(join(cellsMod.cells()[0].storage.dir!, "tenants", TENANT_A, "byok", "doc.pdf"));
    expect(onDisk.subarray(0, 8).toString()).toBe("CSBYOK1\n");
    expect(onDisk.includes(Buffer.from("confidencial"))).toBe(false);
    expect(new TextDecoder().decode(await store.get(`tenants/${TENANT_A}/byok/doc.pdf`))).toBe(secret);
  });

  it("si la clave no se puede usar, falla cerrado (503) y avisa; no se escribe nada", async () => {
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: BAD_ARN, byokStatus: "active" } });
    const store = storage.createBlobStore(resolver);
    const key = `tenants/${TENANT_A}/byok/blocked.pdf`;
    await expect(store.put(key, new TextEncoder().encode("x"), "application/pdf")).rejects.toMatchObject({ status: 503, code: "byok_key_unavailable" });
    expect(failures).toEqual([`${TENANT_A}:${BAD_ARN}`]);
    expect(existsSync(join(cellsMod.cells()[0].storage.dir!, key))).toBe(false);
  });

  it("una clave «failing» que vuelve a funcionar se marca sana", async () => {
    const { resolver, successes } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "failing" } });
    await storage.createBlobStore(resolver).put(`tenants/${TENANT_A}/ok.pdf`, new Uint8Array([1]), "application/pdf");
    expect(successes).toEqual([TENANT_A]);
  });

  it("en S3 usa SSE-KMS con la clave del cliente (cliente S3 simulado)", async () => {
    const sent: any[] = [];
    storage.setS3ClientFactory(() => ({ send: async (cmd: any) => void sent.push(cmd.input) }));
    process.env.CELLS = JSON.stringify({ us: { default: true, storage: { driver: "s3", bucket: "b-us", region: "us-east-1" } } });
    cellsMod.resetCells();
    const { resolver } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" }, [TENANT_B]: { cell: "us", byokKeyArn: null, byokStatus: "none" } });
    const store = storage.createBlobStore(resolver);
    await store.put(`tenants/${TENANT_A}/s3.pdf`, new Uint8Array([1]), "application/pdf");
    await store.put(`tenants/${TENANT_B}/s3.pdf`, new Uint8Array([1]), "application/pdf");
    expect(sent[0]).toMatchObject({ Bucket: "b-us", ServerSideEncryption: "aws:kms", SSEKMSKeyId: OK_ARN, BucketKeyEnabled: true });
    expect(sent[1].SSEKMSKeyId).toBeUndefined();
  });

  it("un error de KMS de S3 también falla cerrado", async () => {
    storage.setS3ClientFactory(() => ({
      send: async () => {
        const e = new Error("User is not authorized to perform kms:GenerateDataKey");
        e.name = "KMS.AccessDeniedException";
        throw e;
      },
    }));
    process.env.CELLS = JSON.stringify({ us: { default: true, storage: { driver: "s3", bucket: "b-us" } } });
    cellsMod.resetCells();
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
    await expect(storage.createBlobStore(resolver).put(`tenants/${TENANT_A}/z.pdf`, new Uint8Array([1]), "application/pdf")).rejects.toMatchObject({ status: 503 });
    expect(failures).toHaveLength(1);
  });
});

describe("custodia de certificados con BYOK", () => {
  it("envuelve y abre la clave con la clave del cliente, atada a la organización", async () => {
    const { sealKey, openKey } = custody;
    const sealed = await sealKey("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", { tenantId: TENANT_A, keyArn: OK_ARN });
    expect(sealed.method).toBe("kms-byok");
    expect(sealed.keyArn).toBe(OK_ARN);
    const row = { key_ciphertext: sealed.ciphertext, key_wrapped: sealed.wrapped, key_wrap_method: sealed.method, key_wrap_key_arn: OK_ARN, tenant_id: TENANT_A };
    expect(await openKey(row)).toContain("abc");
    // Con el contexto de otra organización no abre.
    await expect(openKey({ ...row, tenant_id: TENANT_B })).rejects.toMatchObject({ code: "byok_key_unavailable" });
    await expect(sealKey("x", { tenantId: TENANT_A, keyArn: BAD_ARN })).rejects.toMatchObject({ code: "byok_key_unavailable" });
  }, 30_000);
});

describe("prueba de clave BYOK", () => {
  it("pasa con una clave usable y falla con una deshabilitada o de otra región", async () => {
    const { testKey } = byok;
    const ok = await testKey(OK_ARN, TENANT_A, "us");
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.name)).toEqual(["describe", "encrypt_decrypt", "generate_data_key"]);
    const bad = await testKey(BAD_ARN, TENANT_A, "us");
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/describe/);
    process.env.CELLS = JSON.stringify({ br: { default: true, storage: { driver: "s3", bucket: "b-br", region: "sa-east-1" } } });
    cellsMod.resetCells();
    const region = await testKey(OK_ARN, TENANT_A, "br");
    expect(region.ok).toBe(false);
    expect(region.error).toMatch(/misma región/);
  }, 30_000);
});

describe("links con el dominio de la organización", () => {
  it("ningún link público (firma, formularios, embebido, verificación, negociación, workflows) usa APP_URL fijo", () => {
    const src = resolve(fileURLToPath(new URL("../src", import.meta.url)));
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (/\$\{config\.appUrl\}\/(s|f|embed|verify|n|w|wf)\b/.test(line)) offenders.push(`${p.slice(src.length)}:${i + 1}`);
            });
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
