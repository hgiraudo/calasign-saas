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
