import { describe, expect, it } from "vitest";
import { gdriveFolderQuery } from "../src/modules/storage-export";

// Literal de Drive: dentro de '…' se escapan \ y ' (https://developers.google.com/drive/api/guides/ref-search-terms).
const literal = (q: string) => /^name = '((?:[^'\\]|\\.)*)' and mimeType/.exec(q)?.[1];

describe("consulta de carpeta de Drive", () => {
  it("escapa la barra invertida y la comilla", () => {
    expect(literal(gdriveFolderQuery("Contratos\\Firmados"))).toBe("Contratos\\\\Firmados");
    expect(literal(gdriveFolderQuery("Fin\\"))).toBe("Fin\\\\");
    expect(literal(gdriveFolderQuery("D'Alessandro"))).toBe("D\\'Alessandro");
  });
});

describe("carpeta de Drive fijada", () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("no sirve si está en la papelera o ya no existe; sí si está viva", async () => {
    const { gdriveFolderUsable } = await import("../src/modules/storage-export");
    const real = globalThis.fetch;
    try {
      globalThis.fetch = reply(200, { id: "f1", trashed: true }) as typeof fetch;
      expect(await gdriveFolderUsable("tok", "f1")).toBe(false);
      globalThis.fetch = reply(404, { error: { message: "File not found" } }) as typeof fetch;
      expect(await gdriveFolderUsable("tok", "f1")).toBe(false);
      globalThis.fetch = reply(200, { id: "f1", trashed: false }) as typeof fetch;
      expect(await gdriveFolderUsable("tok", "f1")).toBe(true);
      globalThis.fetch = reply(500, { error: { message: "backend" } }) as typeof fetch;
      await expect(gdriveFolderUsable("tok", "f1")).rejects.toThrow(/HTTP 500/);
    } finally {
      globalThis.fetch = real;
    }
  });
});
