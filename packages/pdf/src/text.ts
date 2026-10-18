// Extracción de texto por líneas con su posición, en el espacio "como se ve la página"
// (CropBox + rotación, origen arriba a la izquierda, en puntos). Es el mismo espacio de anchors.ts
// y de las coordenadas normalizadas de los campos. Lo usan la detección de campos y la IA.
import { readPdfTextPages, toViewport } from "./pdfjs-run";

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

export async function extractPdfText(pdf: Uint8Array, opts: { maxPages?: number } = {}): Promise<PageText[]> {
  // pdf.js corre en un worker con tiempo y memoria acotados (ver pdfjs-run.ts).
  const { pages } = await readPdfTextPages(pdf, { maxPages: opts.maxPages ?? 500 });
  return pages.map((pg, i) => {
    const boxes: { text: string; x: number; y: number; width: number; height: number }[] = [];
    for (const it of pg.items) {
      if (!it.str || !it.str.trim() || it.width === 0) continue;
      const [a, b, , , e, f] = it.transform;
      const fontH = Math.hypot(a, b) || it.height || 10;
      // Esquinas en espacio de usuario → viewport (aplica rotación y CropBox).
      const [x1, y1] = toViewport(pg.transform, e, f);
      const [x2, y2] = toViewport(pg.transform, e + it.width * (a / (Math.hypot(a, b) || 1)), f + it.width * (b / (Math.hypot(a, b) || 1)));
      const [x3, y3] = toViewport(pg.transform, e, f + fontH);
      const xs = [x1, x2, x3];
      const ys = [y1, y2, y3];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      boxes.push({ text: it.str, x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
    }
    return { page: i, width: pg.width, height: pg.height, lines: groupLines(boxes, i + 1) };
  });
}

/** Agrupa fragmentos en líneas por su posición vertical y los ordena de izquierda a derecha. */
function groupLines(boxes: { text: string; x: number; y: number; width: number; height: number }[], pageNo: number): TextLine[] {
  const sorted = [...boxes].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2) || a.x - b.x);
  // Promedio y alto máximo de cada grupo acumulados (no recalculados por fragmento): con decenas de miles de fragmentos
  // en una línea, recalcularlos era cuadrático y Math.max(...arreglo) desbordaba la pila.
  const groups: { items: typeof boxes; midSum: number; maxH: number }[] = [];
  for (const bx of sorted) {
    const mid = bx.y + bx.height / 2;
    const g = groups[groups.length - 1];
    if (g) {
      const gm = g.midSum / g.items.length;
      if (Math.abs(mid - gm) <= Math.max(2, Math.min(g.maxH, bx.height) * 0.45)) {
        g.items.push(bx);
        g.midSum += mid;
        g.maxH = Math.max(g.maxH, bx.height);
        continue;
      }
    }
    groups.push({ items: [bx], midSum: mid, maxH: bx.height });
  }
  return groups.map(({ items: g }, i) => {
    g.sort((a, b) => a.x - b.x);
    let x = Infinity;
    let y = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const v of g) {
      x = Math.min(x, v.x);
      y = Math.min(y, v.y);
      right = Math.max(right, v.x + v.width);
      bottom = Math.max(bottom, v.y + v.height);
    }
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
