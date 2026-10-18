// Extracción del texto de un PDF (para el buscador del repositorio de acuerdos).
import { readPdfTextPages } from "./pdfjs-run";

export interface PdfText {
  text: string;
  pageCount: number;
  /** true si se cortó por superar maxChars. */
  truncated: boolean;
}

export async function extractPdfPlainText(pdf: Uint8Array, maxChars = 300_000): Promise<PdfText> {
  // pdf.js corre en un worker con tiempo y memoria acotados (ver pdfjs-run.ts).
  const { numPages, pages } = await readPdfTextPages(pdf, { maxPages: Number.MAX_SAFE_INTEGER, maxChars });
  let text = "";
  let truncated = false;
  for (const page of pages) {
    for (const item of page.items) {
      if (item.str) text += item.str;
      text += item.hasEOL ? "\n" : item.str ? " " : "";
    }
    text += "\n";
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
      break;
    }
  }
  return { text: text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), pageCount: numPages, truncated };
}
