import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { fieldTextInternals, layoutFieldText } from "../src";
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

  it("valor de 2000 caracteres: rápido (anchos medidos una vez, partido cortado apenas sobran líneas)", async () => {
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

describe("layoutFieldText: el tamaño elegido es el de un recorrido exhaustivo de arriba hacia abajo", () => {
  const { wrapUnits, wrapFieldUnits, widthAt1, FIELD_LINE_HEIGHT: LH, FIELD_MIN_WRAP_SIZE, FIELD_MIN_PAGE_SIZE } = fieldTextInternals;
  type F = Awaited<ReturnType<typeof font>>;

  /** Referencia: cada tamaño de 0,25 en 0,25 desde arriba, el primero que sirve (sin búsquedas ni atajos). */
  function bruteForce(f: F, text: string, bw: number, bh: number, room: { below?: number; right?: number } = {}) {
    const width = widthAt1(f);
    const maxSize = Math.min(bh * 0.7, 11);
    const minSize = Math.min(FIELD_MIN_WRAP_SIZE, maxSize);
    const units = wrapUnits(text);
    const wrapW = Math.max(1, Math.min(bw, room.right ?? Infinity) - 2);
    const fits = (n: number, s: number, h: number) => n * s * LH <= h + 1e-6;
    const sizes: number[] = [];
    for (let s = maxSize; s > minSize; s -= 0.25) sizes.push(s);
    sizes.push(minSize);
    for (const [sw, nw] of [[false, true], [false, false], [true, true], [true, false]] as const) {
      for (const s of sizes) {
        const w = wrapFieldUnits(units, width, s, wrapW, sw);
        if ((!nw || !w.numberSplit) && !w.wordSplit && !w.tooWide && fits(w.lines.length, s, bh)) return { size: s, lines: w.lines };
      }
    }
    const availH = Math.max(1, room.below ?? Infinity);
    const small: number[] = [];
    for (let s = minSize; ; s -= 0.25) {
      small.push(s);
      if (s - 0.25 < FIELD_MIN_PAGE_SIZE) break;
    }
    const below = (sw: boolean) => {
      for (const s of small) {
        const w = wrapFieldUnits(units, width, s, wrapW, sw);
        if (!w.wordSplit && !w.tooWide && fits(w.lines.length, s, availH)) return { size: s, lines: w.lines };
      }
      return null;
    };
    const whole = below(false);
    const split = below(true);
    const best = whole && (!split || whole.size >= split.size) ? whole : split;
    if (best) return best;
    const last = small[small.length - 1]!;
    return { size: last, lines: wrapFieldUnits(units, width, last, wrapW, true).lines };
  }

  it.each([
    ["5555 a Aires 1.234,00 5555 11 1 +54 Ana", 55.2, 10.14, 4.35],
    ["a +54 4444 Ana 1.234,00 2 1 5555", 34.8, 32, 6.75],
  ])("%s en %d×%d: no se queda con un tamaño más chico ni se sale de la caja", async (text, bw, bh, approx) => {
    const f = await font();
    const fit = layoutFieldText(f, text, bw, bh);
    expect(fit.overflows).toBe(false);
    expect(fit.size).toBeCloseTo(approx, 1);
    expect(fit).toMatchObject(bruteForce(f, text, bw, bh));
  });

  it("2000 casos al azar (semilla fija): igual al recorrido exhaustivo", async () => {
    const f = await font();
    let seed = 0x5eed1234;
    const rnd = () => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const vocab = ["a", "de", "Ana", "Buenos", "Aires", "x", "1", "2", "$", "1.234,00", "+54", "11", "4444", "5555", "%", "12", "Mm", "Wwww", "iii", "firmante", "東京都渋谷区", "correo@ejemplo.com.ar"];
    for (let i = 0; i < 2000; i++) {
      const n = 1 + Math.floor(rnd() * 12);
      const text = Array.from({ length: n }, () => vocab[Math.floor(rnd() * vocab.length)]).join(" ");
      const bw = 8 + rnd() * 100;
      const bh = 4 + rnd() * 45;
      const room = rnd() < 0.5 ? {} : { below: 5 + rnd() * 100, right: bw * (0.5 + rnd()) };
      const fit = layoutFieldText(f, text, bw, bh, room);
      const ctx = JSON.stringify({ text, bw, bh, room });
      const ref = bruteForce(f, text, bw, bh, room);
      if (fit.size === ref.size && JSON.stringify(fit.lines) === JSON.stringify(ref.lines)) continue;
      // Si no, sólo puede ser el paso 1 (una línea al tamaño de siempre, ≥ 6 pt), que va antes del partido.
      expect(fit, ctx).toMatchObject({ lines: [text], wrapped: false, overflows: false });
      expect(fit.size, ctx).toBeGreaterThanOrEqual(6);
      expect(f.widthOfTextAtSize(text, fit.size), ctx).toBeLessThanOrEqual(bw - 2 + 1e-6);
    }
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
