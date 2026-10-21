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

  it("un importe o un teléfono con espacios no se parte entre líneas cuando entra en una", async () => {
    const f = await font();
    const fit = layoutFieldText(f, "Total a pagar: $ 1.234.567,00", 60, 60);
    expect(fit.wrapped).toBe(true);
    expect(fit.lines.join(" ")).toBe("Total a pagar: $ 1.234.567,00");
    expect(fit.lines.some((l) => l.endsWith("$ 1.234.567,00"))).toBe(true);
    const phone = layoutFieldText(f, "Llamar al +54 11 4444 5555 de noche", 70, 60);
    expect(phone.lines.some((l) => l.includes("+54 11 4444 5555"))).toBe(true);
  });

  it("caja alta que sólo necesita achicar un poco: una línea, sin partir", async () => {
    const f = await font();
    const text = "Responsable de Administración y Finanzas";
    const bw = f.widthOfTextAtSize(text, 11) * 0.98 + 2;
    const fit = layoutFieldText(f, text, bw, 100, { below: 700, right: 500 });
    expect(fit).toMatchObject({ lines: [text], wrapped: false, overflows: false });
    expect(fit.size).toBe(fitFontSize(f, text, bw - 2, 11));
    expect(fit.size).toBeGreaterThan(10);
  });

  it.each([
    ["nombre", "José Ñandú", 120, 18],
    ["fecha", "21/10/2026", 60, 14],
    ["nombre en caja chica", "María Fernanda González", 110, 12],
  ])("%s: una línea como siempre", async (_n, text, w, h) => {
    const f = await font();
    const fit = layoutFieldText(f, text, w, h, { below: 500, right: 300 });
    expect(fit).toMatchObject({ lines: [text], wrapped: false, overflows: false });
    expect(fit.size).toBe(fitFontSize(f, text, w - 2, Math.min(h * 0.7, 11)));
  });

  it.each([
    ["Buenos Aires", 40, 30],
    ["Departamento", 40, 20],
    ["Responsable de Administración", 60, 40],
  ])("%s en %d×%d: las palabras quedan enteras (se achica antes de partir una palabra)", async (text, w, h) => {
    const f = await font();
    const fit = layoutFieldText(f, text, w, h, { below: 600, right: 400 });
    expect(fit.lines.join(" ")).toBe(text);
    const words = new Set(text.split(" "));
    for (const l of fit.lines) for (const word of l.split(" ")) expect(words.has(word)).toBe(true);
    for (const l of fit.lines) expect(f.widthOfTextAtSize(l, fit.size)).toBeLessThanOrEqual(w - 2 + 1e-6);
    expect(fit.size).toBeGreaterThanOrEqual(4);
    expect(fit.overflows).toBe(false);
  });

  it("palabra que no entra ni a 4 pt: el pedazo partido no se pega a la palabra siguiente", async () => {
    const f = await font();
    const text = "archivo_muy_largo_sin_espacios_final.pdf adjunto";
    const fit = layoutFieldText(f, text, 40, 60, { below: 600, right: 400 });
    expect(fit.lines.join("").replace(/ /g, "")).toBe(text.replace(/ /g, ""));
    expect(fit.lines).toContain("adjunto");
    for (const l of fit.lines) expect(l.includes(" ")).toBe(false);
  });

  it("valor de 2000 caracteres: rápido (búsqueda binaria del tamaño)", async () => {
    const f = await font();
    const base = "Buenos Aires Departamento Responsable de Administración $ 1.234,00 東京都渋谷区 ";
    let text = "";
    while (text.length < 2000) text += base;
    text = text.slice(0, 2000).trim();
    layoutFieldText(f, text, 120, 40, { below: 600, right: 400 }); // calienta cachés de la fuente
    // El mejor de 5 (la máquina de CI puede estar ocupada con otras suites en paralelo).
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const fit = layoutFieldText(f, `${text} x${i}`, 120, 40, { below: 600, right: 400 });
      best = Math.min(best, performance.now() - t0);
      expect(fit.lines.join("").replace(/ /g, "")).toBe(`${text} x${i}`.replace(/ /g, ""));
    }
    expect(best).toBeLessThan(30);
  });

  it("CJK sin espacios: se parte por carácter, sin perder ninguno", async () => {
    const f = await font();
    const text = "東京都渋谷区神南一丁目二十三番十号株式会社カラサイン契約書";
    const fit = layoutFieldText(f, text, 80, 40, { below: 600, right: 400 });
    expect(fit.wrapped).toBe(true);
    expect(fit.lines.length).toBeGreaterThan(1);
    expect(fit.lines.join("")).toBe(text);
    for (const l of fit.lines) expect(f.widthOfTextAtSize(l, fit.size)).toBeLessThanOrEqual(78 + 1e-6);
  });

  it.each([
    ["correo", "maria.fernanda.gonzalez.rodriguez@empresa-ejemplo.com.ar"],
    ["dígitos", "12345678901234567890123456789012345678901234567890"],
    ["sin espacios gigante", "x".repeat(400)],
  ])("%s: se parte por carácter dentro del ancho, sin perder ninguno", async (_n, text) => {
    const f = await font();
    for (const [w, h] of [[80, 12], [80, 60], [200, 14]] as const) {
      const fit = layoutFieldText(f, text, w, h, { below: 700, right: 500 });
      expect(fit.lines.join("")).toBe(text);
      for (const l of fit.lines) expect(f.widthOfTextAtSize(l, fit.size)).toBeLessThanOrEqual(w - 2 + 1e-6);
      expect(fit.size).toBeGreaterThanOrEqual(4);
    }
  });

  it("respuesta de 300 caracteres en 100×14: dentro del ancho y de la página, con todos los caracteres", async () => {
    const f = await font();
    const words = "La parte compradora declara conocer y aceptar el estado del inmueble y renuncia a reclamos posteriores";
    let text = "";
    while (text.length < 300) text = text ? `${text} ${words}` : words;
    text = text.slice(0, 300).trim();
    const strip = (s: string) => s.replace(/ /g, "");
    // Lejos del borde: 4 pt, las líneas siguen debajo de la caja.
    const fit = layoutFieldText(f, text, 100, 14, { below: 700, right: 400 });
    expect(fit).toMatchObject({ size: 4, wrapped: true, overflows: true });
    expect(strip(fit.lines.join(""))).toBe(strip(text));
    for (const l of fit.lines) expect(f.widthOfTextAtSize(l, fit.size)).toBeLessThanOrEqual(98 + 1e-6);
    expect(fit.lines.length * fit.size * 1.15).toBeLessThanOrEqual(700);
    // Cerca del pie y del borde derecho: más chico, pero todo dentro de la página.
    const tight = layoutFieldText(f, text, 100, 14, { below: 30, right: 60 });
    expect(tight.size).toBeLessThan(4);
    expect(strip(tight.lines.join(""))).toBe(strip(text));
    for (const l of tight.lines) expect(f.widthOfTextAtSize(l, tight.size)).toBeLessThanOrEqual(58 + 1e-6);
    expect(tight.lines.length * tight.size * 1.15).toBeLessThanOrEqual(30);
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
