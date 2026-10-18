import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storeFor } from "../src/infra/storage";

describe("almacenamiento local", () => {
  it("no deja escapar a un directorio hermano con el mismo prefijo", async () => {
    const base = mkdtempSync(join(tmpdir(), "cs-blobs-"));
    const store = storeFor({ driver: "local", dir: join(base, "blobs") });
    await store.put("tenants/x/ok.bin", new Uint8Array([1]), "application/octet-stream");
    expect(await store.get("tenants/x/ok.bin")).toEqual(new Uint8Array([1]));
    await expect(store.put("../blobs-br/robado.bin", new Uint8Array([2]), "application/octet-stream")).rejects.toThrow(/clave inválida/);
    await expect(store.get("../blobs-br/robado.bin")).rejects.toThrow(/clave inválida/);
  });
});
