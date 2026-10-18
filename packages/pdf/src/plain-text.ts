// Extracción del texto de un PDF (para el buscador del repositorio de acuerdos).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfText {
  text: string;
  pageCount: number;
  /** true si se cortó por superar maxChars. */
  truncated: boolean;
}

export async function extractPdfPlainText(pdf: Uint8Array, maxChars = 300_000): Promise<PdfText> {
  const doc = await getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  let text = "";
  let truncated = false;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const raw of content.items) {
        const item = raw as { str?: string; hasEOL?: boolean };
        if (item.str) text += item.str;
        text += item.hasEOL ? "\n" : item.str ? " " : "";
      }
      text += "\n";
      page.cleanup();
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
        break;
      }
    }
    return { text: text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), pageCount: doc.numPages, truncated };
  } finally {
    await doc.destroy();
  }
}
