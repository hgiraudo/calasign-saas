// Render de documentos generados (Fase 6) a PDF: párrafos con estilos, títulos, listas, tablas con
// encabezado repetido, saltos de página y espacios reservados para firmas (las "marcas"), cuya posición
// se devuelve normalizada (0..1 desde arriba a la izquierda) para crear los campos del sobre.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { fontCharset } from "./layout";

const widthCache = new WeakMap<object, Map<string, number>>();
/** Ancho de un carácter con esa fuente y tamaño (memoizado). */
function charWidth(font: { widthOfTextAtSize(t: string, size: number): number }, ch: string, size: number): number {
  let m = widthCache.get(font);
  if (!m) widthCache.set(font, (m = new Map()));
  const k = `${size}|${ch}`;
  let w = m.get(k);
  if (w === undefined) m.set(k, (w = font.widthOfTextAtSize(ch, size)));
  return w;
}
export type DocMarkKind = "signature" | "initials" | "date" | "name";
export type DocRun = { text: string; b?: boolean; i?: boolean } | { mark: DocMarkKind; role: string } | { br: true };
export type DocBlock =
  | { type: "heading"; level: 1 | 2 | 3; runs: DocRun[] }
  | { type: "paragraph"; runs: DocRun[] }
  | { type: "list"; ordered: boolean; items: DocRun[][]; start?: number }
  | { type: "table"; header: DocRun[][] | null; rows: DocRun[][][] }
  | { type: "pagebreak" };

export interface DocMarkPosition {
  kind: DocMarkKind;
  role: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderDocOptions {
  title?: string;
  /** Producer/Creator del PDF (marca blanca); por defecto, el de la plataforma. */
  producer?: string | null;
  locale?: string;
  /** Color de acento (títulos y encabezados de tabla), #RRGGBB. */
  accent?: string | null;
  /** Texto de pie de página, a la izquierda (el número de página va a la derecha). */
  footer?: string | null;
}

const PAGE = { w: 595.28, h: 841.89 };
const M = { left: 62, right: 62, top: 64, bottom: 70 };
const BASE = 10.5;
const LH = 1.45;
const MARK_SIZE: Record<DocMarkKind, { w: number; h: number }> = {
  signature: { w: 170, h: 46 },
  initials: { w: 80, h: 36 },
  date: { w: 110, h: 18 },
  name: { w: 170, h: 18 },
};
const CAPTION = 10;
const INK = rgb(0.07, 0.09, 0.16);
const MUTED = rgb(0.42, 0.45, 0.52);
const RULE = rgb(0.78, 0.81, 0.86);

const fontsDir = fileURLToPath(new URL("../fonts/", import.meta.url));
let fontBytes: Record<string, Uint8Array> | null = null;

interface DocFonts {
  r: PDFFont;
  b: PDFFont;
  i: PDFFont;
  bi: PDFFont;
}

const CAPTIONS: Record<string, Record<DocMarkKind, string>> = {
  es: { signature: "Firma", initials: "Iniciales", date: "Fecha", name: "Nombre" },
  "pt-BR": { signature: "Assinatura", initials: "Rubrica", date: "Data", name: "Nome" },
  en: { signature: "Signature", initials: "Initials", date: "Date", name: "Name" },
};
const PAGE_LABEL: Record<string, string> = { es: "Página", "pt-BR": "Página", en: "Page" };

type Item =
  | { k: "word"; text: string; font: PDFFont; size: number; w: number }
  | { k: "space"; w: number }
  | { k: "mark"; kind: DocMarkKind; role: string; w: number; h: number }
  | { k: "br" };

interface Line {
  items: { item: Item; x: number }[];
  height: number;
  ascent: number;
}

export async function renderDocumentPdf(
  blocks: DocBlock[],
  opts: RenderDocOptions = {},
): Promise<{ pdf: Uint8Array; marks: DocMarkPosition[]; pageCount: number }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  fontBytes ??= {
    r: readFileSync(fontsDir + "LiberationSans-Regular.ttf"),
    b: readFileSync(fontsDir + "LiberationSans-Bold.ttf"),
    i: readFileSync(fontsDir + "LiberationSans-Italic.ttf"),
    bi: readFileSync(fontsDir + "LiberationSans-BoldItalic.ttf"),
  };
  const fonts: DocFonts = {
    r: await doc.embedFont(fontBytes.r, { subset: true }),
    b: await doc.embedFont(fontBytes.b, { subset: true }),
    i: await doc.embedFont(fontBytes.i, { subset: true }),
    bi: await doc.embedFont(fontBytes.bi, { subset: true }),
  };
  const locale = opts.locale && CAPTIONS[opts.locale] ? opts.locale : "es";
  const accent = hex(opts.accent) ?? rgb(0.06, 0.29, 0.43);
  if (opts.title) doc.setTitle(opts.title);
  doc.setProducer(opts.producer ?? "CalaSign");
  doc.setCreator(opts.producer ?? "CalaSign");

  const pages: PDFPage[] = [];
  const marks: DocMarkPosition[] = [];
  let page!: PDFPage;
  let y = 0;
  const contentW = PAGE.w - M.left - M.right;
  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    pages.push(page);
    y = PAGE.h - M.top;
  };
  newPage();
  const pageHasContent = () => y < PAGE.h - M.top - 0.5;
  const ensure = (h: number) => {
    if (y - h < M.bottom && pageHasContent()) newPage();
  };

  const fontFor = (b?: boolean, i?: boolean) => (b && i ? fonts.bi : b ? fonts.b : i ? fonts.i : fonts.r);

  function toItems(runs: DocRun[], size: number, forceBold = false): Item[] {
    const items: Item[] = [];
    for (const r of runs) {
      if ("br" in r) items.push({ k: "br" });
      else if ("mark" in r) {
        const s = MARK_SIZE[r.mark];
        items.push({ k: "mark", kind: r.mark, role: r.role, w: s.w, h: s.h });
      } else {
        const font = fontFor(forceBold || r.b, r.i);
        for (const part of r.text.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) items.push({ k: "space", w: font.widthOfTextAtSize(" ", size) });
          else {
            const text = safe(font, part);
            items.push({ k: "word", text, font, size, w: font.widthOfTextAtSize(text, size) });
          }
        }
      }
    }
    return items;
  }

  function layout(items: Item[], width: number, size: number): Line[] {
    const lines: Line[] = [];
    const textH = size * LH;
    let cur: Line = { items: [], height: textH, ascent: size };
    let x = 0;
    const push = () => {
      // Sin espacios colgando al final de la línea.
      while (cur.items.length && cur.items[cur.items.length - 1].item.k === "space") cur.items.pop();
      lines.push(cur);
      cur = { items: [], height: textH, ascent: size };
      x = 0;
    };
    for (const it of items) {
      if (it.k === "br") {
        push();
        continue;
      }
      if (it.k === "space") {
        if (x > 0) {
          cur.items.push({ item: it, x });
          x += it.w;
        }
        continue;
      }
      // Una marca más ancha que el espacio (p. ej. la columna "Firma" de una tabla de 4 columnas) se achica: si no,
      // se salía de la celda y hasta de la página (x + ancho > 1), la firma se estampaba en parte fuera de la hoja y
      // el editor rechazaba guardar los campos del sobre ("el campo se sale de la página").
      if (it.k === "mark" && it.w > width) it.w = Math.max(1, width);
      let w = it.w;
      if (x + w > width && x > 0) push();
      if (it.k === "word" && w > width) {
        // Palabra más larga que la línea: se corta por caracteres.
        // Ancho acumulado por carácter (con caché): medir el trozo entero en cada carácter era cuadrático y una
        // palabra larga bloqueaba el proceso durante minutos.
        let chunk = "";
        let chunkW = 0;
        for (const ch of it.text) {
          const chW = charWidth(it.font, ch, it.size);
          if (chunkW + chW > width && chunk) {
            cur.items.push({ item: { ...it, text: chunk, w: chunkW }, x });
            push();
            chunk = ch;
            chunkW = chW;
          } else {
            chunk += ch;
            chunkW += chW;
          }
        }
        it.text = chunk;
        w = it.w = it.font.widthOfTextAtSize(chunk, it.size);
      }
      cur.items.push({ item: it, x });
      if (it.k === "mark") cur.height = Math.max(cur.height, it.h + CAPTION + 8);
      x += w;
    }
    if (cur.items.length || lines.length === 0) push();
    return lines;
  }

  /** Dibuja líneas ya maquetadas; `top` es el borde superior de la primera línea. Devuelve el nuevo y. */
  /**
   * `repeat`: encabezado de tabla repetido en otra página. Sus marcas no se dibujan ni se registran: si no, cada página
   * de la tabla agregaba otro campo de firma del mismo rol (el firmante tenía que firmar N veces lo mismo).
   */
  function drawLines(
    lines: Line[],
    x0: number,
    width: number,
    opts2: { align?: "left" | "center"; color?: ReturnType<typeof rgb>; paginate?: boolean; repeat?: boolean } = {},
  ) {
    for (const line of lines) {
      if (opts2.paginate !== false) ensure(line.height);
      const lineW = line.items.length ? line.items[line.items.length - 1].x + itemW(line.items[line.items.length - 1].item) : 0;
      const off = opts2.align === "center" ? Math.max(0, (width - lineW) / 2) : 0;
      const top = y;
      const markLine = line.items.some((p) => p.item.k === "mark");
      const baseline = markLine ? top - (line.height - CAPTION - 4) : top - line.ascent - (line.height - line.ascent * 1.2) / 2;
      for (const { item, x } of line.items) {
        if (item.k === "word")
          page.drawText(item.text, { x: x0 + off + x, y: baseline, size: item.size, font: item.font, color: opts2.color ?? INK });
        else if (item.k === "mark" && !opts2.repeat) {
          const bx = x0 + off + x;
          const by = baseline; // borde inferior del espacio de firma
          page.drawLine({ start: { x: bx, y: by }, end: { x: bx + item.w, y: by }, thickness: 0.7, color: MUTED });
          // La leyenda se recorta al ancho del espacio: un rol largo se salía de la celda (o de la hoja) y se superponía.
          const cap = fitText(fonts.r, safe(fonts.r, `${CAPTIONS[locale][item.kind]} — ${item.role}`), 7, item.w);
          page.drawText(cap, { x: bx, y: by - CAPTION + 1, size: 7, font: fonts.r, color: MUTED });
          marks.push({
            kind: item.kind,
            role: item.role,
            page: pages.length - 1,
            x: bx / PAGE.w,
            y: (PAGE.h - (by + item.h)) / PAGE.h,
            width: item.w / PAGE.w,
            height: item.h / PAGE.h,
          });
        }
      }
      y -= line.height;
    }
  }

  for (const block of blocks) {
    if (block.type === "pagebreak") {
      if (pageHasContent()) newPage();
      continue;
    }
    if (block.type === "heading") {
      const size = block.level === 1 ? 17 : block.level === 2 ? 13.5 : 11.5;
      const before = block.level === 1 ? 4 : 10;
      const lines = layout(toItems(block.runs, size, true), contentW, size);
      // El título no queda huérfano al pie de la página.
      ensure(before + lines.reduce((a, l) => a + l.height, 0) + BASE * LH * 2);
      if (pageHasContent()) y -= before;
      drawLines(lines, M.left, contentW, { align: block.level === 1 ? "center" : "left", color: block.level === 1 ? INK : accent });
      y -= block.level === 1 ? 8 : 3;
      continue;
    }
    if (block.type === "paragraph") {
      drawLines(layout(toItems(block.runs, BASE), contentW, BASE), M.left, contentW);
      y -= 6;
      continue;
    }
    if (block.type === "list") {
      const indent = 20;
      block.items.forEach((runs, idx) => {
        const lines = layout(toItems(runs, BASE), contentW - indent, BASE);
        ensure(lines[0]?.height ?? BASE * LH);
        // Una lista numerada que empieza en otro número ("3. …", después de un párrafo) lo conserva.
        const label = block.ordered ? `${(block.start ?? 1) + idx}.` : "•";
        const markerY = y - BASE - (BASE * LH - BASE * 1.2) / 2;
        page.drawText(label, { x: M.left + (block.ordered ? 0 : 6), y: markerY, size: BASE, font: fonts.r, color: INK });
        drawLines(lines, M.left + indent, contentW - indent);
        y -= 2;
      });
      y -= 5;
      continue;
    }
    // Tabla
    const cols = Math.max(block.header?.length ?? 0, ...block.rows.map((r) => r.length), 1);
    const pad = 4;
    const size = BASE - 1;
    const allRows = [...(block.header ? [block.header] : []), ...block.rows];
    const natural = Array.from({ length: cols }, (_, c) =>
      Math.max(24, ...allRows.map((r) => Math.min(260, toItems(r[c] ?? [], size, r === block.header).reduce((a, it) => a + itemW(it), 0) + pad * 2))),
    );
    const total = natural.reduce((a, b) => a + b, 0);
    const widths = natural.map((n) => (n / total) * contentW);
    const layoutRow = (row: DocRun[][], header: boolean) => {
      const cells = widths.map((w, c) => layout(toItems(row[c] ?? [], size, header), w - pad * 2, size));
      const h = Math.max(...cells.map((ls) => ls.reduce((a, l) => a + l.height, 0))) + pad * 2;
      return { cells, h };
    };
    const header = block.header ? layoutRow(block.header, true) : null;
    const drawRow = (r: { cells: Line[][]; h: number }, isHeader: boolean, repeat = false) => {
      const top = y;
      let x = M.left;
      if (isHeader) page.drawRectangle({ x: M.left, y: top - r.h, width: contentW, height: r.h, color: rgb(0.94, 0.95, 0.97) });
      r.cells.forEach((lines, c) => {
        y = top - pad;
        drawLines(lines, x + pad, widths[c] - pad * 2, { paginate: false, color: isHeader ? accent : INK, repeat });
        page.drawRectangle({ x, y: top - r.h, width: widths[c], height: r.h, borderColor: RULE, borderWidth: 0.5 });
        x += widths[c];
      });
      y = top - r.h;
    };
    if (header) {
      ensure(header.h + 20);
      drawRow(header, true);
    }
    const linesH = (ls: Line[]) => ls.reduce((a, l) => a + l.height, 0);
    for (const row of block.rows) {
      // Una fila más alta que lo que queda de página se parte entre páginas (repitiendo el encabezado):
      // si no, el resto del texto de la celda se dibujaba debajo del borde de la hoja y no se veía.
      let rest = layoutRow(row, false).cells;
      for (;;) {
        const h = Math.max(...rest.map(linesH)) + pad * 2;
        if (y - h >= M.bottom) {
          drawRow({ cells: rest, h }, false);
          break;
        }
        const avail = y - M.bottom - pad * 2;
        const firstH = Math.max(...rest.map((ls) => ls[0]?.height ?? 0));
        if (avail < firstH) {
          // No entra ni la primera línea: a la página siguiente (si la página ya está vacía, se dibuja igual).
          if (pageHasContent() && !(header && y === PAGE.h - M.top - header.h)) {
            newPage();
            if (header) drawRow(header, true, true);
            continue;
          }
        }
        const take = rest.map((ls) => {
          let n = 0;
          let acc = 0;
          while (n < ls.length && acc + ls[n].height <= avail) acc += ls[n++].height;
          return Math.max(n, Math.min(1, ls.length));
        });
        const part = rest.map((ls, c) => ls.slice(0, take[c]));
        drawRow({ cells: part, h: Math.max(...part.map(linesH)) + pad * 2 }, false);
        rest = rest.map((ls, c) => ls.slice(take[c]));
        if (rest.every((ls) => ls.length === 0)) break;
        newPage();
        if (header) drawRow(header, true, true);
      }
    }
    y -= 10;
  }

  // Pie de página: texto + "Página n de N".
  const label = PAGE_LABEL[locale];
  pages.forEach((p, idx) => {
    const num = `${label} ${idx + 1} / ${pages.length}`;
    p.drawText(num, { x: PAGE.w - M.right - fonts.r.widthOfTextAtSize(num, 7.5), y: 36, size: 7.5, font: fonts.r, color: MUTED });
    if (opts.footer) p.drawText(safe(fonts.r, opts.footer).slice(0, 120), { x: M.left, y: 36, size: 7.5, font: fonts.r, color: MUTED });
  });
  const pdf = await doc.save();
  return { pdf, marks, pageCount: pages.length };
}

function itemW(it: Item): number {
  return it.k === "word" || it.k === "space" || it.k === "mark" ? it.w : 0;
}

/** Recorta `text` (con "…") para que entre en `maxW` puntos a ese tamaño. */
function fitText(font: PDFFont, text: string, size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  const ell = "…";
  const ellW = font.widthOfTextAtSize(ell, size);
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(font, ch, size);
    if (w + cw + ellW > maxW) break;
    out += ch;
    w += cw;
  }
  return out.trimEnd() + ell;
}

function safe(font: PDFFont, text: string): string {
  const set = fontCharset(font);
  let out = "";
  for (const ch of text) out += set.has(ch.codePointAt(0)!) ? ch : ch === "\t" ? " " : "?";
  return out;
}

function hex(h: string | null | undefined) {
  if (!h || !/^#[0-9a-fA-F]{6}$/.test(h)) return null;
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
