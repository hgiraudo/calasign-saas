import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { extractPdfPlainText, renderDocumentPdf, type DocBlock } from "../src";

describe("renderDocumentPdf", () => {
  it("maqueta párrafos, listas, tablas largas y marcas de firma; el texto se puede extraer", async () => {
    const rows = Array.from({ length: 80 }, (_, i) => [[{ text: `Ítem ${i + 1}` }], [{ text: String(i + 1) }], [{ text: `${(i + 1) * 10},00 US$` }]]);
    const blocks: DocBlock[] = [
      { type: "heading", level: 1, runs: [{ text: "Contrato de servicios" }] },
      { type: "paragraph", runs: [{ text: "Entre " }, { text: "ACME S.A.", b: true }, { text: " y " }, { text: "José Ñandú", i: true }, { br: true }, { text: "Segunda línea." }] },
      { type: "list", ordered: true, items: [[{ text: "Primero" }], [{ text: "Segundo" }]] },
      { type: "table", header: [[{ text: "Producto" }], [{ text: "Cant." }], [{ text: "Precio" }]], rows },
      { type: "pagebreak" },
      { type: "heading", level: 2, runs: [{ text: "Firmas" }] },
      { type: "paragraph", runs: [{ mark: "signature", role: "Cliente" }, { text: "   " }, { mark: "signature", role: "Proveedor" }] },
      { type: "paragraph", runs: [{ mark: "date", role: "Cliente" }] },
    ];
    const { pdf, marks, pageCount } = await renderDocumentPdf(blocks, { title: "Contrato", locale: "es", footer: "ACME" });
    expect(pageCount).toBeGreaterThanOrEqual(3);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(pageCount);
    expect(marks.map((m) => `${m.kind}:${m.role}`)).toEqual(["signature:Cliente", "signature:Proveedor", "date:Cliente"]);
    for (const m of marks) {
      expect(m.page).toBe(pageCount - 1);
      expect(m.x).toBeGreaterThan(0);
      expect(m.x + m.width).toBeLessThanOrEqual(1);
      expect(m.y).toBeGreaterThan(0);
      expect(m.y + m.height).toBeLessThanOrEqual(1);
    }
    // Las dos firmas, en la misma línea y sin superponerse.
    expect(marks[0].y).toBeCloseTo(marks[1].y, 5);
    expect(marks[0].x + marks[0].width).toBeLessThan(marks[1].x);
    const { text } = await extractPdfPlainText(pdf);
    expect(text).toContain("Contrato de servicios");
    expect(text).toContain("José Ñandú");
    expect(text).toContain("Ítem 80");
    expect(text).toContain("Firma — Cliente");
  });
});
