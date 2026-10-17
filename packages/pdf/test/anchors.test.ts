import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { findTextAnchors } from "../src";

async function pdfWithAnchors(rotate = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([600, 800]);
  p1.setRotation(degrees(rotate));
  p1.drawText("Firma del cliente: \\s1\\", { x: 100, y: 700, size: 12, font });
  p1.drawText("Otro texto \\s2\\ y otra vez \\s1\\", { x: 50, y: 100, size: 10, font });
  const p2 = doc.addPage([600, 800]);
  p2.drawText("\\S1\\ en mayusculas", { x: 300, y: 400, size: 12, font });
  return doc.save();
}

describe("findTextAnchors", () => {
  it("encuentra todas las apariciones con coordenadas arriba-izquierda", async () => {
    const pdf = await pdfWithAnchors();
    const m = await findTextAnchors(pdf, "\\s1\\");
    expect(m).toHaveLength(2);
    const first = m.find((x) => x.y < 200)!;
    // "Firma del cliente: " a 12pt en Helvetica ≈ 102pt de ancho → el ancla empieza cerca de x=202.
    expect(first.page).toBe(0);
    expect(first.x).toBeGreaterThan(180);
    expect(first.x).toBeLessThan(225);
    expect(first.y).toBeGreaterThan(800 - 700 - 14);
    expect(first.y).toBeLessThan(800 - 700);
    expect(first.pageWidth).toBe(600);
    expect(first.pageHeight).toBe(800);
  });

  it("respeta mayúsculas salvo que se pida lo contrario", async () => {
    const pdf = await pdfWithAnchors();
    expect(await findTextAnchors(pdf, "\\s1\\", { caseSensitive: false })).toHaveLength(3);
    expect(await findTextAnchors(pdf, "\\nada\\")).toHaveLength(0);
  });

  it("maneja páginas rotadas (tamaño mostrado intercambiado)", async () => {
    const pdf = await pdfWithAnchors(90);
    const m = (await findTextAnchors(pdf, "\\s2\\"))[0];
    expect(m.pageWidth).toBe(800);
    expect(m.pageHeight).toBe(600);
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(800);
    expect(m.height).toBeGreaterThan(m.width / 10);
  });
});
