import { PDFDocument } from "pdf-lib";
import { displayedSize } from "./layout";
import { viewerDiffersFromPdfLib } from "./revisions";
import { structureWithinBudget } from "./stream-budget";

export class InvalidPdfError extends Error {
  constructor(
    readonly code: "not_pdf" | "encrypted" | "empty" | "too_many_pages" | "unreadable" | "ambiguous_pdf",
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

/**
 * Valida un PDF y lo deja tal cual. Para documentos que se guardan sin tocar (p. ej. contratos ya firmados afuera que
 * se cargan al repositorio): rechaza los ambiguos (un lector y pdf-lib verían contenido distinto).
 * Para lo que termina dentro del PDF final de un sobre conviene `preparePdfUpload`, que elimina la ambigüedad.
 */
export async function inspectPdf(bytes: Uint8Array, maxPages = 500): Promise<PdfInfo> {
  const doc = await loadChecked(bytes, maxPages);
  // El firmante ve el documento en un lector (por el xref) y el PDF final se arma con pdf-lib: tienen que coincidir.
  if (await viewerDiffersFromPdfLib(bytes, doc)) throw ambiguous();
  return infoOf(doc);
}

export interface PreparedPdf {
  info: PdfInfo;
  /** El PDF a guardar: reescrito por pdf-lib, una sola definición por objeto y un xref coherente. */
  bytes: Uint8Array;
}

/**
 * Valida un PDF subido para un sobre, plantilla, adjunto o negociación y lo reescribe completo con pdf-lib.
 *
 * El PDF final del sobre se arma copiando las páginas con pdf-lib (`buildEnvelopeDocument`), que se queda con la última
 * definición de cada objeto; un lector (el visor de la web, pdf.js) sigue el xref. Detectar todas las formas en que esas
 * dos lecturas pueden diferir resultó frágil (rondas 10 a 13: objetos duplicados, prefijos, startxref pegado,
 * linealización…). Guardando la versión reescrita, el visor muestra exactamente lo que pdf-lib ve y lo que termina en
 * el PDF final: coinciden por construcción, sea cual sea el truco del archivo subido.
 *
 * Consecuencias (las mismas que ya tenía el PDF final, que nunca conservó la estructura del original):
 * - Firmas previas del archivo subido dejan de verificar en la copia guardada (el PDF final tampoco las conservaba).
 * - El hash del archivo guardado no es el del archivo subido: conviene registrar ambos en la evidencia.
 * - Los campos de formulario se conservan con sus apariencias tal como venían (no se regeneran).
 */
export async function preparePdfUpload(bytes: Uint8Array, maxPages = 500): Promise<PreparedPdf> {
  const doc = await loadChecked(bytes, maxPages);
  let out: Uint8Array;
  try {
    out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false, addDefaultPage: false });
  } catch {
    throw new InvalidPdfError("unreadable", "No se pudo leer el PDF");
  }
  // Se valida lo que se va a guardar, no lo subido: páginas, tamaños y (por las dudas) que ya no sea ambiguo.
  const again = await loadChecked(out, maxPages);
  if (again.getPageCount() !== doc.getPageCount() || (await viewerDiffersFromPdfLib(out, again))) throw ambiguous();
  return { info: infoOf(again), bytes: out };
}

async function loadChecked(bytes: Uint8Array, maxPages: number): Promise<PDFDocument> {
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") === -1) {
    throw new InvalidPdfError("not_pdf", "El archivo no es un PDF");
  }
  // Antes de cargarlo: un stream de objetos que al descomprimirse ocupa gigabytes dejaría sin memoria al proceso.
  if (!structureWithinBudget(bytes)) throw new InvalidPdfError("unreadable", "El PDF tiene una estructura demasiado grande para procesarlo");
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
  return doc;
}

function ambiguous() {
  return new InvalidPdfError(
    "ambiguous_pdf",
    "El PDF muestra contenido distinto según el programa que lo abra (tiene objetos duplicados). Exportalo o imprimilo de nuevo a PDF y volvé a subirlo.",
  );
}

function infoOf(doc: PDFDocument): PdfInfo {
  const pages = doc.getPages();
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
