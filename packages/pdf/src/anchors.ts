// Búsqueda de textos ancla en un PDF (para ubicar campos por contenido, p. ej. "\\firma1\\").
// Devuelve rectángulos en el espacio "como se ve la página" (CropBox + rotación, origen arriba a la
// izquierda, en puntos), el mismo que usa la web con pdf.js y que guardan las coordenadas de los campos.
import { readPdfTextPages, toViewport } from "./pdfjs-run";

export interface AnchorMatch {
  /** Página 0-based. */
  page: number;
  /** Caja del texto encontrado, en puntos, origen arriba a la izquierda de la página mostrada. */
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export async function findTextAnchors(pdf: Uint8Array, text: string, opts: { caseSensitive?: boolean } = {}): Promise<AnchorMatch[]> {
  const caseSensitive = opts.caseSensitive ?? true;
  const needle = caseSensitive ? text : text.toLowerCase();
  // pdf.js corre en un worker con tiempo y memoria acotados (ver pdfjs-run.ts).
  const { pages } = await readPdfTextPages(pdf, { maxPages: Number.MAX_SAFE_INTEGER });
  const out: AnchorMatch[] = [];
  pages.forEach((pg, p) => {
    const vp = { convertToViewportPoint: (x: number, y: number) => toViewport(pg.transform, x, y) };
    for (const item of pg.items) {
      if (!item.str || item.width === 0) continue;
      const hay = caseSensitive ? item.str : item.str.toLowerCase();
      let idx = hay.indexOf(needle);
      while (idx !== -1) {
        out.push({ page: p, ...boxFor(item, idx, needle.length, vp), pageWidth: pg.width, pageHeight: pg.height });
        idx = hay.indexOf(needle, idx + needle.length);
      }
    }
  });
  return out;
}

/** Caja (en coordenadas de la página mostrada) de una porción de un item de texto. */
function boxFor(
  item: TextItem,
  start: number,
  len: number,
  vp: { convertToViewportPoint(x: number, y: number): number[] },
) {
  const [a, b, c, d, e, f] = item.transform;
  const ux = Math.hypot(a, b) ? a / Math.hypot(a, b) : 1;
  const uy = Math.hypot(a, b) ? b / Math.hypot(a, b) : 0;
  const vxl = Math.hypot(c, d);
  const vx = vxl ? c / vxl : 0;
  const vy = vxl ? d / vxl : 1;
  const total = item.str.length || 1;
  // Aproximación proporcional al número de caracteres (las anclas suelen ser tokens cortos y aislados).
  const w0 = (item.width * start) / total;
  const w = (item.width * len) / total;
  const h = item.height || Math.hypot(c, d) || 10;
  const x0 = e + ux * w0;
  const y0 = f + uy * w0;
  // Un poco de descenso por debajo de la línea base para que la caja cubra el texto.
  const descent = h * 0.2;
  const corners = [
    [x0 - vx * descent, y0 - vy * descent],
    [x0 + ux * w - vx * descent, y0 + uy * w - vy * descent],
    [x0 + vx * h, y0 + vy * h],
    [x0 + ux * w + vx * h, y0 + uy * w + vy * h],
  ].map(([x, y]) => vp.convertToViewportPoint(x, y));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
