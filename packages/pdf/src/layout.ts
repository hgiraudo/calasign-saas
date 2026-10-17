import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFFont, PDFPage, concatTransformationMatrix, popGraphicsState, pushGraphicsState } from "pdf-lib";
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

/** Tamaño de la página tal como se ve (CropBox + /Rotate), igual que pdf.js. */
export function displayedSize(page: PDFPage): { width: number; height: number; rotation: number } {
  const box = page.getCropBox();
  const rotation = (((page.getRotation().angle % 360) + 360) % 360) as number;
  const swap = rotation === 90 || rotation === 270;
  return { width: swap ? box.height : box.width, height: swap ? box.width : box.height, rotation };
}

/**
 * Ejecuta `draw` en un sistema de coordenadas "como se ve la página": origen abajo a la izquierda
 * de la página mostrada, sin rotación. Resuelve CropBox desplazado y /Rotate 90/180/270.
 */
export function withDisplayedSpace(page: PDFPage, draw: (w: number, h: number) => void) {
  const box = page.getCropBox();
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

/** Reemplaza caracteres que la fuente no puede dibujar. */
export function safeText(font: PDFFont, text: string): string {
  const supported = new Set(font.getCharacterSet());
  let out = "";
  for (const ch of text) out += supported.has(ch.codePointAt(0)!) || ch === " " ? ch : "?";
  return out;
}
