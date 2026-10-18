// Extracción de texto por líneas con su posición, en el espacio "como se ve la página"
// (CropBox + rotación, origen arriba a la izquierda, en puntos). Es el mismo espacio de anchors.ts
// y de las coordenadas normalizadas de los campos. Lo usan la detección de campos y la IA.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface TextLine {
  /** Identificador estable dentro del documento: p<página 1-based>-l<n>. */
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fragmentos que forman la línea, con su caja (para ubicar subcadenas como "____"). */
  spans: { text: string; x: number; width: number }[];
}

export interface PageText {
  /** 0-based. */
  page: number;
  width: number;
  height: number;
  lines: TextLine[];
}

interface Item {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export async function extractPdfText(pdf: Uint8Array, opts: { maxPages?: number } = {}): Promise<PageText[]> {
  const doc = await getDocument({
    data: new Uint8Array(pdf), // pdf.js vacía el buffer que recibe
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const out: PageText[] = [];
  try {
    const n = Math.min(doc.numPages, opts.maxPages ?? 500);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const boxes: { text: string; x: number; y: number; width: number; height: number }[] = [];
      for (const raw of content.items) {
        const it = raw as Item;
        if (!it.str || !it.str.trim() || it.width === 0) continue;
        const [a, b, , , e, f] = it.transform;
        const fontH = Math.hypot(a, b) || it.height || 10;
        // Esquinas en espacio de usuario → viewport (aplica rotación y CropBox).
        const [x1, y1] = vp.convertToViewportPoint(e, f);
        const [x2, y2] = vp.convertToViewportPoint(e + it.width * (a / (Math.hypot(a, b) || 1)), f + it.width * (b / (Math.hypot(a, b) || 1)));
        const [x3, y3] = vp.convertToViewportPoint(e, f + fontH);
        const xs = [x1, x2, x3];
        const ys = [y1, y2, y3];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        boxes.push({ text: it.str, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
      }
      out.push({ page: p - 1, width: vp.width, height: vp.height, lines: groupLines(boxes, p) });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** Agrupa fragmentos en líneas por su posición vertical y los ordena de izquierda a derecha. */
function groupLines(boxes: { text: string; x: number; y: number; width: number; height: number }[], pageNo: number): TextLine[] {
  const sorted = [...boxes].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x);
  const groups: (typeof boxes)[] = [];
  for (const bx of sorted) {
    const mid = bx.y + bx.height / 2;
    const g = groups[groups.length - 1];
    if (g) {
      const gm = g.reduce((s, v) => s + v.y + v.height / 2, 0) / g.length;
      const gh = Math.max(...g.map((v) => v.height));
      if (Math.abs(mid - gm) <= Math.max(2, Math.min(gh, bx.height) * 0.45)) {
        g.push(bx);
        continue;
      }
    }
    groups.push([bx]);
  }
  return groups.map((g, i) => {
    g.sort((a, b) => a.x - b.x);
    const x = Math.min(...g.map((v) => v.x));
    const y = Math.min(...g.map((v) => v.y));
    const right = Math.max(...g.map((v) => v.x + v.width));
    const bottom = Math.max(...g.map((v) => v.y + v.height));
    let text = "";
    let prevRight: number | null = null;
    for (const v of g) {
      if (prevRight !== null && v.x - prevRight > 1.5 && !text.endsWith(" ") && !v.text.startsWith(" ")) text += " ";
      text += v.text;
      prevRight = v.x + v.width;
    }
    return {
      id: `p${pageNo}-l${i + 1}`,
      text: text.replace(/\s+/g, " ").trim(),
      x: round(x),
      y: round(y),
      width: round(right - x),
      height: round(bottom - y),
      spans: g.map((v) => ({ text: v.text, x: round(v.x), width: round(v.width) })),
    };
  });
}

/** Caja horizontal aproximada de una subcadena de la línea (por proporción de caracteres dentro de su fragmento). */
export function substringBox(line: TextLine, start: number, length: number): { x: number; width: number } {
  let offset = 0;
  // Reconstruye la posición de cada fragmento dentro de line.text (que normaliza espacios).
  const joined = line.spans.map((s) => s.text.replace(/\s+/g, " "));
  let cursor = 0;
  for (let i = 0; i < line.spans.length; i++) {
    const t = joined[i].trim();
    const at = line.text.indexOf(t, cursor);
    const sStart = at >= 0 ? at : cursor;
    const sEnd = sStart + t.length;
    if (start < sEnd || i === line.spans.length - 1) {
      const span = line.spans[i];
      const per = span.width / Math.max(1, span.text.length);
      const rel = Math.max(0, start - sStart);
      const relLen = Math.min(length, Math.max(1, sEnd - Math.max(start, sStart)));
      offset = span.x + rel * per;
      return { x: round(offset), width: round(Math.max(per * relLen, 10)) };
    }
    cursor = sEnd;
  }
  return { x: line.x, width: line.width };
}

const round = (n: number) => Math.round(n * 100) / 100;
