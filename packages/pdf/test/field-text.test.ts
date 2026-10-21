import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { FIELD_MIN_FONT_SIZE, layoutFieldText } from "../src";
import { embedFonts, fitFontSize } from "../src/layout";

async function font() {
  const doc = await PDFDocument.create();
  return (await embedFonts(doc)).regular;
}

describe("layoutFieldText (texto estampado dentro de la caja del campo)", () => {
  it("texto que entra en una línea: mismo tamaño que antes", async () => {
    const f = await font();
    const fit = layoutFieldText(f, "José Ñandú", 180, 20);
    expect(fit).toMatchObject({ lines: ["José Ñandú"], wrapped: false, truncated: false });
    expect(fit.size).toBe(fitFontSize(f, "José Ñandú", 178, Math.min(20 * 0.7, 11)));
  });

  it("texto largo en caja alta: se parte en líneas que entran en el ancho y el alto", async () => {
    const f = await font();
    const text = "Esta es una cláusula bastante larga que el firmante escribió en un campo de texto amplio";
    const fit = layoutFieldText(f, text, 120, 60);
    expect(fit.wrapped).toBe(true);
    expect(fit.truncated).toBe(false);
    expect(fit.size).toBeGreaterThanOrEqual(FIELD_MIN_FONT_SIZE);
    expect(fit.lines.length * fit.size * 1.15).toBeLessThanOrEqual(60);
    for (const l of fit.lines) expect(f.widthOfTextAtSize(l, fit.size)).toBeLessThanOrEqual(118);
    expect(fit.lines.join(" ")).toBe(text);
  });

  it("texto que no entra ni al mínimo: se trunca con … sin bajar del mínimo legible", async () => {
    const f = await font();
    const text = "x".repeat(400);
    const fit = layoutFieldText(f, text, 80, 12);
    expect(fit.truncated).toBe(true);
    expect(fit.size).toBe(FIELD_MIN_FONT_SIZE);
    expect(fit.lines).toHaveLength(1);
    expect(fit.lines[0]!.endsWith("…")).toBe(true);
    expect(f.widthOfTextAtSize(fit.lines[0]!, fit.size)).toBeLessThanOrEqual(78);
  });

  it("varias líneas al mínimo y la última truncada", async () => {
    const f = await font();
    const text = Array.from({ length: 200 }, (_, i) => `palabra${i}`).join(" ");
    const fit = layoutFieldText(f, text, 100, 30);
    expect(fit.truncated).toBe(true);
    expect(fit.lines.length).toBe(Math.floor(30 / (FIELD_MIN_FONT_SIZE * 1.15)));
    expect(fit.lines.at(-1)!.endsWith("…")).toBe(true);
    for (const l of fit.lines) expect(f.widthOfTextAtSize(l, fit.size)).toBeLessThanOrEqual(98);
  });
});
