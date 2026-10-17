import { PDFDocument } from "pdf-lib";
import { displayedSize } from "./layout";

export class InvalidPdfError extends Error {
  constructor(
    readonly code: "not_pdf" | "encrypted" | "empty" | "too_many_pages" | "unreadable",
    message: string,
  ) {
    super(message);
  }
}

export interface PdfInfo {
  pageCount: number;
  /** Tamaño mostrado de cada página en puntos (CropBox + rotación). */
  pages: { width: number; height: number }[];
}

export async function inspectPdf(bytes: Uint8Array, maxPages = 500): Promise<PdfInfo> {
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") === -1) {
    throw new InvalidPdfError("not_pdf", "El archivo no es un PDF");
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/encrypt/i.test(msg)) throw new InvalidPdfError("encrypted", "El PDF está protegido con contraseña");
    throw new InvalidPdfError("unreadable", "No se pudo leer el PDF");
  }
  if (doc.isEncrypted) throw new InvalidPdfError("encrypted", "El PDF está protegido con contraseña");
  const pages = doc.getPages();
  if (pages.length === 0) throw new InvalidPdfError("empty", "El PDF no tiene páginas");
  if (pages.length > maxPages) throw new InvalidPdfError("too_many_pages", `Máximo ${maxPages} páginas`);
  return {
    pageCount: pages.length,
    pages: pages.map((p) => {
      const s = displayedSize(p);
      return { width: round2(s.width), height: round2(s.height) };
    }),
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
