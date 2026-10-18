import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdfText } from "../src";

describe("extractPdfText", () => {
  it("agrupa el texto en líneas con posiciones en el espacio mostrado (también en páginas rotadas)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([595, 842]);
    p1.drawText("Firma del cliente:", { x: 72, y: 700, size: 12, font });
    p1.drawText("____________", { x: 180, y: 700, size: 12, font });
    p1.drawText("Segunda linea", { x: 72, y: 650, size: 12, font });
    const p2 = doc.addPage([595, 842]);
    p2.setRotation(degrees(90));
    p2.drawText("Rotada", { x: 72, y: 700, size: 12, font });
    const pages = await extractPdfText(await doc.save());

    expect(pages).toHaveLength(2);
    const [a, b] = pages[0].lines;
    expect(a.text).toBe("Firma del cliente: ____________");
    expect(a.id).toBe("p1-l1");
    expect(a.y).toBeCloseTo(842 - 700 - 12 * 0.9, -1);
    expect(a.x).toBeCloseTo(72, 0);
    expect(b.text).toBe("Segunda linea");
    expect(b.y).toBeGreaterThan(a.y);
    // Página rotada: dimensiones intercambiadas y caja dentro de la página mostrada.
    expect(pages[1].width).toBe(842);
    const r = pages[1].lines[0];
    expect(r.text).toBe("Rotada");
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(842);
  });
});
