// El tamaño mostrado y el espacio donde se estampan los campos tienen que coincidir con lo que muestra pdf.js (el
// visor de la web): cajas con esquinas invertidas y CropBox más grande que la MediaBox son PDFs válidos.
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFNumber, StandardFonts } from "pdf-lib";
import { extractPdfText, preparePdfUpload } from "../src";
import { withDisplayedSpace } from "../src/layout";

async function pagePdf(media: number[], crop?: number[], rotate?: number) {
  const d = await PDFDocument.create();
  const p = d.addPage([612, 792]);
  p.node.set(PDFName.of("MediaBox"), d.context.obj(media));
  if (crop) p.node.set(PDFName.of("CropBox"), d.context.obj(crop));
  if (rotate !== undefined) p.node.set(PDFName.of("Rotate"), PDFNumber.of(rotate));
  return d.save();
}

const cases: [string, number[], number[] | undefined, number | undefined, number, number][] = [
  ["MediaBox con las esquinas invertidas", [612, 792, 0, 0], undefined, undefined, 612, 792],
  ["CropBox invertida", [0, 0, 612, 792], [612, 792, 0, 0], undefined, 612, 792],
  ["CropBox más grande que la MediaBox", [0, 0, 612, 792], [-100, -100, 800, 900], undefined, 612, 792],
  ["CropBox parcial y rotada", [0, 0, 612, 792], [50, 50, 500, 700], 90, 650, 450],
];

describe("caja visible de la página", () => {
  for (const [name, media, crop, rotate, w, h] of cases) {
    it(`${name}: tamaño y posición de lo estampado como en pdf.js`, async () => {
      const prepared = await preparePdfUpload(await pagePdf(media, crop, rotate));
      expect(prepared.info.pages[0]).toEqual({ width: w, height: h });

      // Un campo en el centro de la página mostrada (como drawField: fracciones del tamaño mostrado).
      const doc = await PDFDocument.load(prepared.bytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.getPage(0);
      withDisplayedSpace(page, (W, H) => page.drawText("MARCA", { x: W / 2, y: H / 2, size: 12, font }));
      const [pg] = await extractPdfText(await doc.save());
      expect({ width: pg.width, height: pg.height }).toEqual({ width: w, height: h });
      const mark = pg.lines.find((l) => l.text.includes("MARCA"));
      if (!mark) throw new Error("la marca no se ve en la página");
      expect(Math.abs(mark.x - w / 2)).toBeLessThan(2);
      // Viewport de arriba hacia abajo: la línea de base queda a la mitad del alto.
      expect(Math.abs(mark.y + mark.height - h / 2)).toBeLessThan(4);
    });
  }
});
