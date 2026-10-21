import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFFont, PDFName, PDFNull, PDFPage, PDFRef, concatTransformationMatrix, popGraphicsState, pushGraphicsState } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const fontsDir = fileURLToPath(new URL("../fonts/", import.meta.url));
let regularBytes: Uint8Array | null = null;
let boldBytes: Uint8Array | null = null;

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

export async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  regularBytes ??= readFileSync(fontsDir + "DejaVuSans.ttf");
  boldBytes ??= readFileSync(fontsDir + "DejaVuSans-Bold.ttf");
  return {
    regular: await doc.embedFont(regularBytes, { subset: true }),
    bold: await doc.embedFont(boldBytes, { subset: true }),
  };
}

type Box = { x: number; y: number; width: number; height: number };

/** Rectángulo con esquinas en cualquier orden ([612 792 0 0] es válido) → ancho y alto positivos. */
function normalized(b: Box): Box {
  const x1 = Math.min(b.x, b.x + b.width);
  const y1 = Math.min(b.y, b.y + b.height);
  return { x: x1, y: y1, width: Math.abs(b.width), height: Math.abs(b.height) };
}

/**
 * Área visible de la página, como la calcula pdf.js: la CropBox recortada contra la MediaBox (si no se cortan, la
 * MediaBox), con las esquinas normalizadas. pdf-lib devuelve la CropBox tal cual: con una caja invertida daba tamaños
 * negativos, y con una CropBox más grande que la MediaBox, un tamaño que el visor no muestra; los campos (fracciones
 * del tamaño mostrado) se estampaban fuera del lugar que vio el firmante, o fuera de la página.
 */
export function visibleBox(page: PDFPage): Box {
  const media = normalized(mediaBox(page));
  const crop = page.node.CropBox() ? normalized(page.getCropBox()) : media;
  const x1 = Math.max(media.x, crop.x);
  const y1 = Math.max(media.y, crop.y);
  const x2 = Math.min(media.x + media.width, crop.x + crop.width);
  const y2 = Math.min(media.y + media.height, crop.y + crop.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : media;
}

/** Tamaño Carta: el que usa pdf.js para una página sin /MediaBox (ni propia ni heredada). */
export const LETTER_MEDIABOX: Box = { x: 0, y: 0, width: 612, height: 792 };

/**
 * true si la página no tiene /MediaBox (pdf-lib tiraba UnexpectedObjectTypeError al leerla). Una referencia colgada (a
 * un objeto que no existe) o a null cuenta como que falta, como en pdf.js; de otro tipo, no (getMediaBox la rechaza).
 */
export function lacksMediaBox(page: PDFPage): boolean {
  const raw = page.node.getInheritableAttribute(PDFName.of("MediaBox"));
  if (raw === undefined) return true;
  const v = raw instanceof PDFRef ? page.node.context.lookup(raw) : raw;
  return v === undefined || v === PDFNull;
}

/** La MediaBox, o Carta si falta (como pdf.js). */
export function mediaBox(page: PDFPage): Box {
  return lacksMediaBox(page) ? { ...LETTER_MEDIABOX } : page.getMediaBox();
}

/** Tamaño de la página tal como se ve (CropBox + /Rotate), igual que pdf.js. */
export function displayedSize(page: PDFPage): { width: number; height: number; rotation: number } {
  const box = visibleBox(page);
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as number;
  const swap = rotation === 90 || rotation === 270;
  return { width: swap ? box.height : box.width, height: swap ? box.width : box.height, rotation };
}

/**
 * Ejecuta `draw` en un sistema de coordenadas "como se ve la página": origen abajo a la izquierda
 * de la página mostrada, sin rotación. Resuelve CropBox desplazado y /Rotate 90/180/270.
 */
export function withDisplayedSpace(page: PDFPage, draw: (w: number, h: number) => void) {
  const box = visibleBox(page);
  const { width, height, rotation } = displayedSize(page);
  const { x: cx, y: cy, width: W, height: H } = box;
  let m: [number, number, number, number, number, number];
  switch (rotation) {
    case 90:
      m = [0, 1, -1, 0, cx + W, cy];
      break;
    case 180:
      m = [-1, 0, 0, -1, cx + W, cy + H];
      break;
    case 270:
      m = [0, -1, 1, 0, cx, cy + H];
      break;
    default:
      m = [1, 0, 0, 1, cx, cy];
  }
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
  draw(width, height);
  page.pushOperators(popGraphicsState());
}

/** Achica el tamaño de fuente hasta que el texto entre en el ancho dado. */
export function fitFontSize(font: PDFFont, text: string, maxWidth: number, maxSize: number, minSize = 4) {
  let size = maxSize;
  while (size > minSize && font.widthOfTextAtSize(text, size) > maxWidth) size -= 0.25;
  return size;
}

/** Corta texto en líneas que entren en `maxWidth`. Respeta palabras; parte palabras demasiado largas. */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
      } else {
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        line = chunk;
      }
    }
    lines.push(line);
  }
  return lines;
}

const charsets = new WeakMap<PDFFont, Set<number>>();

/** Caracteres que la fuente puede dibujar. Se arma una vez por fuente: son miles y se consultaba por cada texto. */
export function fontCharset(font: PDFFont): Set<number> {
  let set = charsets.get(font);
  if (!set) charsets.set(font, (set = new Set(font.getCharacterSet())));
  return set;
}

/**
 * safeText para texto que pasa por wrapText: conserva los saltos de línea (la fuente no tiene glifo para "\n", así que
 * safeText los volvía "?" antes de que wrapText partiera los párrafos) y los tabuladores pasan a espacios.
 */
export function safeMultiline(font: PDFFont, text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((l) => safeText(font, l.replace(/\t/g, " ")))
    .join("\n");
}

/** Reemplaza caracteres que la fuente no puede dibujar. */
export function safeText(font: PDFFont, text: string): string {
  const supported = fontCharset(font);
  let out = "";
  for (const ch of text) out += supported.has(ch.codePointAt(0)!) || ch === " " ? ch : "?";
  return out;
}
