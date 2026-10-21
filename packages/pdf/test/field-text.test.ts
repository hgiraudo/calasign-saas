import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { layoutFieldText } from "../src";
import { embedFonts, fitFontSize, wrapText } from "../src/layout";

async function font() {
  const doc = await PDFDocument.create();
  return (await embedFonts(doc)).regular;
}

describe("layoutFieldText (texto estampado en la caja del campo, sin perder caracteres)", () => {
  it("texto que entra en una línea: mismo tamaño que antes", async () => {
    const f = await font();
    const fit = layoutFieldText(f, "José Ñandú", 180, 20);
    expect(fit).toMatchObject({ lines: ["José Ñandú"], wrapped: false, overflows: false });
    expect(fit.size).toBe(fitFontSize(f, "José Ñandú", 178, Math.min(20 * 0.7, 11)));
  });

  it("frase larga en caja alta: se parte sólo entre palabras, en el ancho y el alto, sin perder texto", async () => {
    const f = await font();
    const text = "Esta es una cláusula bastante larga que el firmante escribió en un campo de texto amplio";
    const fit = layoutFieldText(f, text, 120, 60);
    expect(fit.wrapped).toBe(true);
    expect(fit.size).toBeGreaterThan(fitFontSize(f, text, 118, 11));
    expect(fit.lines.length * fit.size * 1.15).toBeLessThanOrEqual(60);
    for (const l of fit.lines) expect(f.widthOfTextAtSize(l, fit.size)).toBeLessThanOrEqual(118);
    expect(fit.lines.join(" ")).toBe(text);
    const words = new Set(text.split(" "));
    for (const l of fit.lines) for (const w of l.split(" ")) expect(words.has(w)).toBe(true);
  });

  it("un importe o un teléfono con espacios no se parte entre líneas", async () => {
    const f = await font();
    for (const text of ["$ 1.234.567.890,00", "+54 11 4444 5555"]) {
      for (const [w, h] of [[40, 60], [80, 60], [30, 100]] as const) expect(layoutFieldText(f, text, w, h).lines).toEqual([text]);
    }
    // Con letras sí puede partirse entre palabras (el importe queda entero en su línea).
    const fit = layoutFieldText(f, "Total a pagar: $ 1.234.567,00", 60, 60);
    expect(fit.lines.join(" ")).toBe("Total a pagar: $ 1.234.567,00");
    expect(fit.lines.some((l) => l.endsWith("$ 1.234.567,00"))).toBe(true);
  });

  it.each([
    ["correo", "maria.fernanda.gonzalez.rodriguez@empresa-ejemplo.com.ar"],
    ["importe", "$ 1.234.567.890,00"],
    ["dígitos", "12345678901234567890123456789012345678901234567890"],
    ["sin espacios gigante", "x".repeat(400)],
  ])("%s: queda entero en una línea (achicado, aunque sobresalga) y nunca se trunca", async (_n, text) => {
    const f = await font();
    for (const [w, h] of [[80, 12], [80, 60], [200, 14]] as const) {
      const fit = layoutFieldText(f, text, w, h);
      expect(fit.lines.join(" ")).toBe(text);
      if (!text.includes(" ")) expect(fit.lines).toEqual([text]);
      expect(fit.size).toBe(fitFontSize(f, text, w - 2, Math.min(h * 0.7, 11))); // mismo achique que antes (piso ~4 pt)
      expect(fit.overflows).toBe(f.widthOfTextAtSize(fit.lines[0]!, fit.size) > w - 2);
    }
  });

  it("frase que no entra ni partida: una línea achicada como antes, sin truncar", async () => {
    const f = await font();
    const text = Array.from({ length: 200 }, (_, i) => `palabra${i}`).join(" ");
    const fit = layoutFieldText(f, text, 100, 30);
    expect(fit.lines).toEqual([text]);
    expect(fit.wrapped).toBe(false);
    expect(fit.size).toBe(fitFontSize(f, text, 98, Math.min(30 * 0.7, 11)));
  });
});

describe("wrapText", () => {
  it("nunca deja líneas vacías aunque un carácter no entre en el ancho", async () => {
    const f = await font();
    const lines = wrapText(f, "WWW abc", 20, 5);
    expect(lines.every((l) => l.length > 0)).toBe(true);
    expect(lines.join("")).toBe("WWWabc");
  });
});
