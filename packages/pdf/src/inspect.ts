import { PDFDocument } from "pdf-lib";
import { displayedSize } from "./layout";
import { viewerDiffersFromPdfLib } from "./revisions";
import { DecodeBudgetError, structureWithinBudget, withDecodeBudget } from "./stream-budget";
import { InvalidPdfError } from "./errors";
import { opensWithoutPassword } from "./encryption";
import { compressPlainStreams, dropUnreachable, flattenForm, hasSignedSignatureFields, resolveOptionalContent, stripActiveContent } from "./sanitize";

export { InvalidPdfError, type InvalidPdfCode } from "./errors";

export interface PdfInfo {
  pageCount: number;
  /** Tamaño mostrado de cada página en puntos (CropBox + rotación). */
  pages: { width: number; height: number }[];
  /**
   * El archivo subido traía firmas digitales (campos /FT /Sig con valor). preparePdfUpload las elimina al reescribirlo
   * (la copia guardada y el PDF final no las conservan): conviene avisarle al remitente.
   */
  hadSignatures: boolean;
}

/**
 * Valida un PDF y lo deja tal cual. Para documentos que se guardan sin tocar (p. ej. contratos ya firmados afuera que
 * se cargan al repositorio): rechaza los ambiguos (un lector y pdf-lib verían contenido distinto).
 * Para lo que termina dentro del PDF final de un sobre conviene `preparePdfUpload`, que elimina la ambigüedad.
 */
export async function inspectPdf(bytes: Uint8Array, maxPages = 500): Promise<PdfInfo> {
  return budgeted(() => inspectPdfUnbudgeted(bytes, maxPages));
}

async function inspectPdfUnbudgeted(bytes: Uint8Array, maxPages: number): Promise<PdfInfo> {
  const doc = await loadChecked(bytes, maxPages);
  // El firmante ve el documento en un lector (por el xref) y el PDF final se arma con pdf-lib: tienen que coincidir.
  if (await viewerDiffersFromPdfLib(bytes, doc)) throw ambiguous();
  return infoOf(doc, hasSignedSignatureFields(doc));
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
 * - Saneamiento (sanitize.ts), para que lo guardado sea exactamente lo que ve el firmante y lo que se sella:
 *   - contenido opcional (capas): si alguna está apagada se rechaza (`pdf_hidden_layers`); si todas están encendidas se
 *     quita /OCProperties (sin él los lectores muestran todo y el marcado /OC no tiene efecto);
 *   - formularios: se fijan en la página tal como se ven (sin widgets ocultos, apariencia según /AS, regenerada si hay
 *     NeedAppearances; si no se puede, `pdf_form_unsupported`) y se elimina el /AcroForm (con XFA);
 *   - contenido activo: acciones que no sean URI/GoTo/Named, /AA, adjuntos, multimedia, JavaScript de documento;
 *   - los streams sin filtro se comprimen y los objetos que quedaron sueltos se descartan.
 * - `info.hadSignatures`: el archivo subido traía firmas digitales (se pierden).
 */
export async function preparePdfUpload(bytes: Uint8Array, maxPages = 500): Promise<PreparedPdf> {
  return budgeted(() => preparePdfUploadUnbudgeted(bytes, maxPages));
}

async function preparePdfUploadUnbudgeted(bytes: Uint8Array, maxPages: number): Promise<PreparedPdf> {
  const doc = await loadChecked(bytes, maxPages);
  const hadSignatures = hasSignedSignatureFields(doc);
  resolveOptionalContent(doc);
  await flattenForm(doc, true);
  stripActiveContent(doc, true);
  compressPlainStreams(doc);
  dropUnreachable(doc);
  let out: Uint8Array;
  try {
    out = await doc.save({ useObjectStreams: true, updateFieldAppearances: false, addDefaultPage: false });
  } catch (e) {
    if (e instanceof DecodeBudgetError) throw e;
    throw new InvalidPdfError("unreadable", "No se pudo leer el PDF");
  }
  // Se valida lo que se va a guardar, no lo subido: páginas, tamaños y (por las dudas) que ya no sea ambiguo.
  const again = await loadChecked(out, maxPages);
  if (again.getPageCount() !== doc.getPageCount() || (await viewerDiffersFromPdfLib(out, again))) throw ambiguous();
  return { info: infoOf(again, hadSignatures), bytes: out };
}

async function loadChecked(bytes: Uint8Array, maxPages: number): Promise<PDFDocument> {
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") === -1) {
    throw new InvalidPdfError("not_pdf", "El archivo no es un PDF");
  }
  // Antes de cargarlo: un stream de objetos que al descomprimirse ocupa gigabytes dejaría sin memoria al proceso.
  if (!structureWithinBudget(bytes)) throw tooLarge();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e instanceof DecodeBudgetError) throw e;
    const msg = String((e as Error).message ?? e);
    if (/encrypt/i.test(msg)) throw await encryptedError(bytes);
    throw new InvalidPdfError("unreadable", "No se pudo leer el PDF");
  }
  if (doc.isEncrypted) throw await encryptedError(bytes, doc);
  // Un PDF sin catálogo ni árbol de páginas (p. ej. solo el encabezado "%PDF-" y basura) carga sin error, pero
  // getPages() tira un TypeError: era un 500 en vez de un 400.
  let pages: ReturnType<PDFDocument["getPages"]>;
  try {
    pages = doc.getPages();
  } catch (e) {
    if (e instanceof DecodeBudgetError) throw e;
    throw new InvalidPdfError("unreadable", "No se pudo leer el PDF");
  }
  if (pages.length === 0) throw new InvalidPdfError("empty", "El PDF no tiene páginas");
  if (pages.length > maxPages) throw new InvalidPdfError("too_many_pages", `Máximo ${maxPages} páginas`);
  return doc;
}

/** Toda la operación (cargar, analizar revisiones, reescribir) con un tope total de descompresión. */
async function budgeted<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await withDecodeBudget(fn);
  } catch (e) {
    if (e instanceof DecodeBudgetError) throw tooLarge();
    throw e;
  }
}

function tooLarge() {
  return new InvalidPdfError("unreadable", "El PDF tiene una estructura demasiado grande para procesarlo");
}

function ambiguous() {
  return new InvalidPdfError(
    "ambiguous_pdf",
    "El PDF muestra contenido distinto según el programa que lo abra (tiene objetos duplicados). Exportalo o imprimilo de nuevo a PDF y volvé a subirlo.",
  );
}

/**
 * PDF cifrado. Si abre sin contraseña (solo restricciones de permisos) el mensaje es otro: no hace falta ninguna
 * contraseña, alcanza con volver a exportarlo (pdf-lib no descifra, así que no se puede aceptar tal cual).
 */
async function encryptedError(bytes: Uint8Array, loaded?: PDFDocument): Promise<InvalidPdfError> {
  let restricted = false;
  try {
    restricted = opensWithoutPassword(loaded ?? (await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })));
  } catch (e) {
    if (e instanceof DecodeBudgetError) throw e;
  }
  return restricted
    ? new InvalidPdfError("pdf_restricted", "El PDF tiene restricciones de uso (permisos): volvé a exportarlo o imprimilo a PDF y subilo de nuevo.")
    : new InvalidPdfError("encrypted", "El PDF está protegido con contraseña");
}

function infoOf(doc: PDFDocument, hadSignatures: boolean): PdfInfo {
  const pages = doc.getPages();
  return {
    hadSignatures,
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
