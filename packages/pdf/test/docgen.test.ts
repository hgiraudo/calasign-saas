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

  it("una fila de tabla más alta que la página se parte entre páginas sin perder texto", async () => {
    const words = Array.from({ length: 900 }, (_, i) => `palabra${i}`);
    const { pdf, pageCount } = await renderDocumentPdf([
      { type: "table", header: [[{ text: "Cláusula" }], [{ text: "Texto" }]], rows: [[[{ text: "1" }], [{ text: words.join(" ") + " FINAL" }]]] },
    ]);
    expect(pageCount).toBeGreaterThanOrEqual(2);
    const text = (await extractPdfPlainText(pdf)).text;
    expect(text).toContain("FINAL");
    expect(words.filter((w) => !new RegExp(`\\b${w}\\b`).test(text))).toEqual([]);
  });

  it("una marca de firma en una columna angosta no se sale de la página", async () => {
    const long = "Texto largo de la columna para ocupar ancho natural";
    const { marks } = await renderDocumentPdf([
      {
        type: "table",
        header: [[{ text: "Nombre" }], [{ text: "Cargo" }], [{ text: "Fecha" }], [{ text: "Firma" }]],
        rows: [[[{ text: long }], [{ text: long }], [{ text: long }], [{ mark: "signature", role: "Cliente" }]]],
      },
    ]);
    expect(marks).toHaveLength(1);
    // El campo del sobre se valida con x + ancho <= 1 (si no: "el campo se sale de la página").
    expect(marks[0].x + marks[0].width).toBeLessThanOrEqual(1);
  });
});

describe("renderDocumentPdf: listas, encabezados repetidos y leyendas", () => {
  it("una lista numerada conserva su número inicial", async () => {
    const { pdf } = await renderDocumentPdf([{ type: "list", ordered: true, start: 3, items: [[{ text: "Tercero" }], [{ text: "Cuarto" }]] }]);
    const { text } = await extractPdfPlainText(pdf);
    expect(text).toMatch(/3\.\s*Tercero/);
    expect(text).toMatch(/4\.\s*Cuarto/);
    expect(text).not.toMatch(/1\.\s*Tercero/);
  });

  it("las marcas de un encabezado de tabla repetido en otras páginas no se registran otra vez", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => [[{ text: `Fila ${i + 1}` }], [{ text: "x" }]]);
    const { marks, pageCount } = await renderDocumentPdf([{ type: "table", header: [[{ text: "Detalle" }], [{ mark: "initials", role: "Cliente" }]], rows }]);
    expect(pageCount).toBeGreaterThan(1);
    expect(marks).toHaveLength(1);
    expect(marks[0].page).toBe(0);
  });

  it("la leyenda de un rol largo se recorta al ancho del espacio de firma", async () => {
    const role = "Representante legal de la parte compradora y garante solidario";
    const { pdf } = await renderDocumentPdf([{ type: "paragraph", runs: [{ mark: "date", role }] }]);
    const { text } = await extractPdfPlainText(pdf);
    expect(text).toContain("Fecha — Representante");
    expect(text).not.toContain("garante solidario");
    expect(text).toContain("…");
  });
});
