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
function fakeResolver(map: Record<string, { cell: string; byokKeyArn: string | null; byokStatus: "none" | "active" | "failing" }>, history: string[] = []) {
  const failures: string[] = [];
  const successes: string[] = [];
  return {
    failures,
    successes,
    resolver: {
      resolve: async (t: string) => map[t] ?? { cell: "us", byokKeyArn: null, byokStatus: "none" as const },
      isTenantKey: async (_t: string, arn: string) => history.includes(arn),
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

  it("un archivo cifrado con una clave BYOK anterior que falla no marca como fallida la clave actual", async () => {
    const OLD_ARN = "arn:aws:kms:us-east-1:111122223333:key/mock-old";
    const broken = new Set<string>();
    kms.setKmsClientFactory(() => {
      const base = kms.mockKms();
      return {
        ...base,
        async decrypt(i: any) {
          const r = await base.decrypt(i);
          if (broken.has(r.KeyId ?? "")) throw new Error(`KMSInvalidStateException: la clave ${r.KeyId} está deshabilitada`);
          return r;
        },
      };
    });
    try {
      const key = `tenants/${TENANT_A}/byok/viejo.pdf`;
      await storage.createBlobStore(fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OLD_ARN, byokStatus: "active" } }).resolver).put(key, new Uint8Array([7]), "application/pdf");
      broken.add(OLD_ARN);
      // La anterior está en el historial de la organización: 503 de la clave (con su ARN), sin marcar la actual.
      const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } }, [OLD_ARN]);
      await expect(storage.createBlobStore(resolver).get(key)).rejects.toMatchObject({ status: 503, code: "byok_key_unavailable", details: { keyArn: OLD_ARN } });
      expect(failures).toEqual([]);
    } finally {
      kms.setKmsClientFactory(() => kms.mockKms());
    }
  });

  it("en S3, un objeto cifrado con una clave anterior que falla se atribuye a esa clave (HeadObject)", async () => {
    const OLD_ARN = "arn:aws:kms:us-east-1:111122223333:key/mock-old";
    storage.setS3ClientFactory(() => ({
      send: async (cmd: any) => {
        if (cmd.constructor.name === "HeadObjectCommand") return { SSEKMSKeyId: OLD_ARN };
        throw Object.assign(new Error("The ciphertext refers to a customer master key that is disabled"), { name: "KMS.DisabledException" });
      },
    }));
    process.env.CELLS = JSON.stringify({ us: { default: true, storage: { driver: "s3", bucket: "b-us" } } });
    cellsMod.resetCells();
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } }, [OLD_ARN]);
    await expect(storage.createBlobStore(resolver).get(`tenants/${TENANT_A}/viejo.pdf`)).rejects.toMatchObject({ status: 503, code: "byok_key_unavailable" });
    expect(failures).toEqual([]);
  });

  /** S3 simulado: GetObject falla con `getErr`; HeadObject devuelve `head` (o falla si es un Error). */
  function s3With(getErr: Error, head: Record<string, unknown> | Error) {
    const calls: string[] = [];
    storage.setS3ClientFactory(() => ({
      send: async (cmd: any) => {
        calls.push(cmd.constructor.name);
        if (cmd.constructor.name === "HeadObjectCommand") {
          if (head instanceof Error) throw head;
          return head;
        }
        throw getErr;
      },
    }));
    process.env.CELLS = JSON.stringify({ us: { default: true, storage: { driver: "s3", bucket: "b-us" } } });
    cellsMod.resetCells();
    return calls;
  }
  const s3Err = (name: string, message: string) => Object.assign(new Error(message), { name, Code: name });

  it("un AccessDenied de S3 (sin s3:ListBucket o por la política del bucket) no se le atribuye a la clave BYOK", async () => {
    const original = s3Err("AccessDenied", "Access Denied");
    const calls = s3With(original, { SSEKMSKeyId: OK_ARN });
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } }, [OK_ARN]);
    await expect(storage.createBlobStore(resolver).get(`tenants/${TENANT_A}/no-existe.pdf`)).rejects.toBe(original);
    expect(failures).toEqual([]);
    expect(calls).toEqual(["GetObjectCommand"]); // ni siquiera se consulta la clave del objeto
  });

  it("un AccessDenied de S3 que sí es de KMS se atribuye a la clave confirmada por HeadObject", async () => {
    s3With(s3Err("AccessDenied", "User: arn:aws:sts::1:assumed-role/app is not authorized to perform: kms:Decrypt on resource: " + OK_ARN), { SSEKMSKeyId: OK_ARN });
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
    await expect(storage.createBlobStore(resolver).get(`tenants/${TENANT_A}/k.pdf`)).rejects.toMatchObject({ status: 503, code: "byok_key_unavailable" });
    expect(failures).toEqual([`${TENANT_A}:${OK_ARN}`]);
  });

  /** Corre `fn` sin los console.warn esperados (fallas de KMS sin atribuir). */
  async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const warn = console.warn;
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      console.warn = warn;
    }
  }

  it("si HeadObject falla o no informa la clave, 503 storage_unavailable sin atribuirlo a ninguna clave (no un 500)", async () => {
    const original = s3Err("KMS.DisabledException", "The ciphertext refers to a customer master key that is disabled");
    for (const head of [s3Err("Forbidden", "Forbidden"), {}]) {
      s3With(original, head);
      const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
      const err: any = await quiet(() => storage.createBlobStore(resolver).get(`tenants/${TENANT_A}/h.pdf`).catch((e) => e));
      expect(err).toMatchObject({ status: 503, code: "storage_unavailable" });
      expect(JSON.stringify(err.details ?? null)).not.toContain(OK_ARN);
      expect(failures).toEqual([]);
    }
  });

  it("isKeyError: los transitorios de KMS (limitación, falla interna, timeout de dependencia) no son de la clave", () => {
    for (const name of ["ThrottlingException", "KMSInternalException", "DependencyTimeoutException"]) {
      expect(kms.isKeyError(s3Err(`KMS.${name}`, "Rate exceeded"))).toBe(false);
      expect(kms.isKeyError(s3Err(name, "x"))).toBe(false);
    }
    expect(kms.isKeyError(s3Err("KMS.DisabledException", "x"))).toBe(true);
  });

  it("en S3, un error transitorio de KMS (leer o guardar) da 503 storage_unavailable sin marcar la clave ni exponer el ARN", async () => {
    for (const name of ["KMS.ThrottlingException", "KMSInternalException", "DependencyTimeoutException"]) {
      const throttled = s3Err(name, "You have exceeded the rate at which you may call KMS");
      const calls = s3With(throttled, { SSEKMSKeyId: OK_ARN });
      const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
      const store = storage.createBlobStore(resolver);
      const g: any = await quiet(() => store.get(`tenants/${TENANT_A}/t.pdf`).catch((e) => e));
      expect(g).toMatchObject({ status: 503, code: "storage_unavailable" });
      expect(calls).toEqual(["GetObjectCommand"]);
      const p: any = await quiet(() => store.put(`tenants/${TENANT_A}/t2.pdf`, new Uint8Array([1]), "application/pdf").catch((e) => e));
      expect(p).toMatchObject({ status: 503, code: "storage_unavailable" });
      expect(JSON.stringify(p.details ?? null)).not.toContain(OK_ARN);
      // Sin BYOK (clave de la plataforma) también: 503, no un 500 crudo.
      const plain: any = await quiet(() => storage.createBlobStore(fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: null, byokStatus: "none" } }).resolver)
        .put(`tenants/${TENANT_A}/t3.pdf`, new Uint8Array([1]), "application/pdf")
        .catch((e) => e));
      expect(plain).toMatchObject({ status: 503, code: "storage_unavailable" });
      expect(failures).toEqual([]);
    }
  });

  it("en S3, guardar con la clave BYOK deshabilitada sigue atribuyéndose a la clave (byok_key_unavailable)", async () => {
    s3With(s3Err("KMS.DisabledException", "key is disabled"), { SSEKMSKeyId: OK_ARN });
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
    await expect(storage.createBlobStore(resolver).put(`tenants/${TENANT_A}/k.pdf`, new Uint8Array([1]), "application/pdf")).rejects.toMatchObject({
      status: 503,
      code: "byok_key_unavailable",
    });
    expect(failures).toEqual([`${TENANT_A}:${OK_ARN}`]);
  });

  it("isTransientKmsError: limitación, falla interna y timeout de dependencia; no los de la clave ni los de S3", () => {
    for (const name of ["ThrottlingException", "KMS.ThrottlingException", "KMSInternalException", "KMS.DependencyTimeoutException"]) {
      expect(kms.isTransientKmsError(s3Err(name, "x"))).toBe(true);
    }
    for (const name of ["KMS.DisabledException", "AccessDenied", "NoSuchKey"]) expect(kms.isTransientKmsError(s3Err(name, "x"))).toBe(false);
  });

  it("en disco, un error transitorio de KMS da 503 storage_unavailable sin marcar la clave; uno de la clave la marca", async () => {
    const key = `tenants/${TENANT_A}/byok/transitorio.pdf`;
    const { resolver: okResolver } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
    await storage.createBlobStore(okResolver).put(key, new TextEncoder().encode("hola"), "application/pdf");
    let fail: Error | null = null;
    kms.setKmsClientFactory(() => {
      const base = kms.mockKms();
      return {
        ...base,
        async generateDataKey(i: any) {
          if (fail) throw fail;
          return base.generateDataKey(i);
        },
        async decrypt(i: any) {
          if (fail) throw fail;
          return base.decrypt(i);
        },
      };
    });
    try {
      fail = s3Err("ThrottlingException", "Rate exceeded");
      const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
      const store = storage.createBlobStore(resolver);
      await expect(quiet(() => store.put(`tenants/${TENANT_A}/byok/nuevo.pdf`, new Uint8Array([1]), "application/pdf"))).rejects.toMatchObject({
        status: 503,
        code: "storage_unavailable",
      });
      await expect(quiet(() => store.get(key))).rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
      expect(failures).toEqual([]);

      fail = s3Err("DisabledException", "key is disabled");
      await expect(store.get(key)).rejects.toMatchObject({ status: 503, code: "byok_key_unavailable" });
      expect(failures).toEqual([`${TENANT_A}:${OK_ARN}`]);
    } finally {
      kms.setKmsClientFactory(() => kms.mockKms());
    }
  });

  it("con BYOK desactivada (none) una falla de su clave no la marca como fallida", async () => {
    s3With(s3Err("KMS.DisabledException", "key is disabled"), { SSEKMSKeyId: OK_ARN });
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "none" } }, [OK_ARN]);
    await expect(storage.createBlobStore(resolver).get(`tenants/${TENANT_A}/d.pdf`)).rejects.toMatchObject({ status: 503, code: "byok_key_unavailable" });
    expect(failures).toEqual([]);
  });

  it("un objeto anterior a BYOK cifrado con la clave de la plataforma: 503 genérico, sin el ARN interno", async () => {
    const PLATFORM = "arn:aws:kms:us-east-1:999999999999:key/plataforma";
    s3With(s3Err("KMS.KMSInvalidStateException", "key pending deletion"), { SSEKMSKeyId: PLATFORM });
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } }, [OK_ARN]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      const err: any = await storage.createBlobStore(resolver).get(`tenants/${TENANT_A}/pre-byok.pdf`).catch((e) => e);
      expect(err).toMatchObject({ status: 503, code: "storage_unavailable" });
      expect(JSON.stringify(err.details ?? null)).not.toContain(PLATFORM);
      expect(err.message).not.toMatch(/organizaci/);
    } finally {
      console.warn = warn;
    }
    expect(failures).toEqual([]);
  });

  it("isKeyError: solo errores de KMS, no los de S3", () => {
    expect(kms.isKeyError(s3Err("AccessDenied", "Access Denied"))).toBe(false);
    expect(kms.isKeyError(s3Err("NoSuchKey", "The specified key does not exist."))).toBe(false);
    expect(kms.isKeyError(s3Err("NotFound", "Not Found"))).toBe(false);
    expect(kms.isKeyError(new Error("User is not authorized to perform: s3:GetObject"))).toBe(false);
    expect(kms.isKeyError(s3Err("AccessDenied", "not authorized to perform: kms:Decrypt"))).toBe(true);
    expect(kms.isKeyError(s3Err("KMS.KMSInvalidStateException", "x"))).toBe(true);
    expect(kms.isKeyError(s3Err("AccessDeniedException", "x"))).toBe(true);
    expect(kms.isKeyError(s3Err("DisabledException", "x"))).toBe(true);
    expect(kms.isKeyError(new Error("KMSInvalidStateException: la clave x no está habilitada"))).toBe(true);
  });

  it("una falla de red hacia S3 no marca la clave del cliente como fallida", async () => {
    storage.setS3ClientFactory(() => ({
      send: async () => {
        const e = Object.assign(new Error("getaddrinfo ENOTFOUND b-us.s3.us-east-1.amazonaws.com"), { code: "ENOTFOUND" });
        throw e;
      },
    }));
    process.env.CELLS = JSON.stringify({ us: { default: true, storage: { driver: "s3", bucket: "b-us" } } });
    cellsMod.resetCells();
    const { resolver, failures } = fakeResolver({ [TENANT_A]: { cell: "us", byokKeyArn: OK_ARN, byokStatus: "active" } });
    await expect(storage.createBlobStore(resolver).put(`tenants/${TENANT_A}/n.pdf`, new Uint8Array([1]), "application/pdf")).rejects.toThrow(/ENOTFOUND/);
    expect(failures).toHaveLength(0);
    expect(kms.isKeyError(Object.assign(new Error("KMS.DisabledException: key is disabled"), { name: "KMS.DisabledException" }))).toBe(true);
    expect(kms.isKeyError(new Error("connect ETIMEDOUT kms.us-east-1.amazonaws.com"))).toBe(false);
  });
});

describe("custodia de certificados con BYOK", () => {
  it("envuelve y abre la clave con la clave del cliente, atada a la organización", async () => {
    const { sealKey, openKey } = custody;
    const CERT = "0192f0e0-0000-7000-8000-00000000c0de";
    const sealed = await sealKey("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n", { tenantId: TENANT_A, certificateId: CERT }, { tenantId: TENANT_A, keyArn: OK_ARN });
    expect(sealed.method).toBe("kms-byok");
    expect(sealed.keyArn).toBe(OK_ARN);
    const row = { id: CERT, key_ciphertext: sealed.ciphertext, key_wrapped: sealed.wrapped, key_wrap_method: sealed.method, key_wrap_key_arn: OK_ARN, tenant_id: TENANT_A };
    expect(await openKey(row)).toContain("abc");
    // Con el contexto de otra organización no abre.
    await expect(openKey({ ...row, tenant_id: TENANT_B })).rejects.toMatchObject({ code: "byok_key_unavailable" });
    await expect(sealKey("x", { tenantId: TENANT_A, certificateId: CERT }, { tenantId: TENANT_A, keyArn: BAD_ARN })).rejects.toMatchObject({ code: "byok_key_unavailable" });
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
