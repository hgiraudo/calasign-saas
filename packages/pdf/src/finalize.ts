// Arma el PDF final de un sobre: estampa los campos completados en cada documento, une todo,
// agrega el certificado de finalización y sella con PAdES.
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFObjectCopier,
  PDFPage,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFObject,
} from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import { buildPadesCms, type CmsOptions } from "./cms";
import { embedFonts, fitFontSize, safeMultiline, safeText, withDisplayedSpace, wrapText, type Fonts } from "./layout";
import { labels, type CertLabels } from "./i18n";
import type { SignatureProvider } from "./provider";
import { assertPngSize } from "./images";
import { findLastStartXref } from "./incremental";
import { newByteRangePlaceholder, signPlaceholder } from "./placeholder";
import { sanitizeForSealing, type OptionalContentState } from "./sanitize";


export type StampFieldType =
  | "signature"
  | "initials"
  | "date_signed"
  | "name"
  | "email"
  | "text"
  | "checkbox"
  | "number"
  | "dropdown"
  | "company"
  | "title"
  | "attachment";

export interface StampField {
  documentIndex: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: StampFieldType;
  value: string | null;
  /** PNG para signature / initials. */
  imagePng?: Uint8Array | null;
}

export interface CertificateRecipient {
  name: string;
  role: "signer" | "cc" | "approver";
  email: string | null;
  phone: string | null;
  idDocument: string | null;
  channels: string[];
  authMethod: string;
  sentAt: string | null;
  viewedAt: string | null;
  consentedAt: string | null;
  signedAt: string | null;
  ip: string | null;
  userAgent: string | null;
  signaturePng?: Uint8Array | null;
  /** Ej. "Delegó en Ana Pérez: viaje" (destinatarios reemplazados). */
  note?: string | null;
  /** Verificación de identidad (KYC) del firmante. */
  identity?: CertificateIdentity | null;
  /** Firma además con su certificado digital (los datos del certificado van en la firma PAdES del PDF). */
  certificateSignature?: boolean;
}

export interface CertificateIdentity {
  provider: string;
  level: string;
  result: "verified" | "failed";
  /** Tipo · país · número enmascarado. */
  document: string | null;
  nameScore: number | null;
  documentNumberMatched: boolean | null;
  faceMatchScore: number | null;
  liveness: boolean | null;
  reference: string | null;
  verifiedAt: string | null;
}

export interface CertificateData {
  envelopeId: string;
  subject: string;
  organizationName: string;
  senderName: string;
  senderEmail: string | null;
  createdAt: string;
  sentAt: string | null;
  completedAt: string;
  locale: string;
  documents: { name: string; pageCount: number; sha256: string }[];
  recipients: CertificateRecipient[];
  events: { seq: number; type: string; occurredAt: string; actor: string; ip: string | null }[];
  chainHead: string;
  /**
   * false si el sello va sin sello de tiempo (la TSA falló y no era obligatoria): el texto no lo afirma. null: todavía
   * no se sabe (firma con certificado: la página se arma antes del sellado final) y el texto no afirma ni niega.
   */
  timestamped?: boolean | null;
  /** URL pública de verificación (se imprime al pie del certificado). */
  verifyUrl?: string | null;
  /** Archivos que subieron los firmantes (se listan con su hash). */
  attachments?: { name: string; recipientName: string; sha256: string; appended: boolean }[];
  /**
   * Marca blanca: nombre del producto que reemplaza al de la plataforma en la declaración, el pie de página y los
   * metadatos del PDF (Producer/Creator). "" lo quita. Sin definir: el de la plataforma.
   */
  productName?: string | null;
  /** Logo y color de la organización. El logo solo se usa si es PNG o JPG. */
  branding?: { primaryColor?: string | null; logo?: { bytes: Uint8Array; type: "png" | "jpg" } | null } | null;
  /** Nivel de firma declarado para el sobre (simple / avanzada / cualificada). */
  signatureLevel?: "simple" | "advanced" | "qualified" | null;
  /** Sello de empresa: el PDF se firma además con un certificado de la organización. */
  companySeal?: { name: string; commonName: string | null } | null;
  /** Cobros confirmados dentro del flujo de firma (comprobante). */
  payments?: { description: string; amount: string; payerName: string; provider: string; reference: string; paidAt: string | null }[];
}

/** Adjunto subido por un firmante: PDF o imagen, se agrega al final de los documentos. */
export interface FinalizeAttachment {
  name: string;
  recipientName: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface FinalizeInput {
  documents: { name: string; bytes: Uint8Array }[];
  fields: StampField[];
  certificate: CertificateData;
  attachments?: FinalizeAttachment[];
}

export interface SealOptions extends CmsOptions {
  provider: SignatureProvider;
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
}

const INK = rgb(0.05, 0.1, 0.25);
const MUTED = rgb(0.4, 0.43, 0.5);
const LINE = rgb(0.82, 0.85, 0.9);
const ACCENT = rgb(0.0, 0.5, 0.5);

export async function finalizeEnvelopePdf(input: FinalizeInput, seal: SealOptions): Promise<Uint8Array> {
  return sealPdfDocument(await buildEnvelopeDocument(input), seal);
}

/**
 * PDF final del sobre SIN sello de plataforma (documentos estampados + adjuntos + certificado de finalización).
 * Lo usa la firma con certificado propio: los firmantes agregan sus firmas como revisiones incrementales y el
 * sello de la plataforma se agrega al final, también incremental.
 */
export async function renderEnvelopePdf(input: FinalizeInput): Promise<Uint8Array> {
  const doc = await buildEnvelopeDocument(input);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/**
 * Copia de un sobre que todavía no terminó (faltan firmas): los documentos con los campos ya completados,
 * marcada en cada página como copia en curso. Sin certificado ni sello: no es el documento final.
 */
export async function renderProgressCopyPdf(input: {
  documents: { name: string; bytes: Uint8Array }[];
  fields: StampField[];
  envelopeId: string;
  subject: string;
  locale: string;
  /** Marca blanca (ver CertificateData.productName). */
  productName?: string | null;
}): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const fonts = await embedFonts(out);
  const L = labels(input.locale, input.productName);
  const text = safeText(fonts.bold, L.progressCopy);
  const layers = new LayerMerger();
  await stampDocuments(out, fonts, L, input.documents, input.fields, input.envelopeId, imageEmbedder(out), layers, (page) =>
    withDisplayedSpace(page, (W) => {
      const size = fitFontSize(fonts.bold, text, W - 16, 8);
      page.drawText(text, { x: 8, y: 6, size, font: fonts.bold, color: rgb(0.7, 0.1, 0.1) });
    }),
  );
  layers.apply(out);
  out.setTitle(input.subject);
  out.setProducer(producerOf(input.productName));
  out.setCreator(producerOf(input.productName));
  return new Uint8Array(await out.save());
}

async function buildEnvelopeDocument(input: FinalizeInput): Promise<PDFDocument> {
  const out = await PDFDocument.create();
  const fonts = await embedFonts(out);
  const L = labels(input.certificate.locale, input.certificate.productName);
  const embedImage = imageEmbedder(out);

  const layers = new LayerMerger();
  await stampDocuments(out, fonts, L, input.documents, input.fields, input.certificate.envelopeId, embedImage, layers);

  for (const a of input.attachments ?? []) await appendAttachment(out, fonts, L, a, input.certificate.envelopeId, layers);
  layers.apply(out);

  await drawCertificate(out, fonts, L, input.certificate, embedImage);

  out.setTitle(input.certificate.subject);
  out.setProducer(producerOf(input.certificate.productName));
  out.setCreator(producerOf(input.certificate.productName));
  out.setModificationDate(new Date(input.certificate.completedAt));
  // El hash final impreso en el certificado, también legible por máquina: la verificación pública lo compara con la
  // cadena de eventos guardada (una cadena reescrita y recalculada en la base ya no lo contiene).
  if (/^[0-9a-f]{64}$/.test(input.certificate.chainHead)) out.setKeywords([`${CHAIN_HEAD_KEYWORD}${input.certificate.chainHead}`]);
  return out;
}

const CHAIN_HEAD_KEYWORD = "calasign-chain-head:";

/**
 * Hash final del certificado leído de los BYTES del PDF sin parsearlo (barato, apto para el hilo principal): busca el
 * diccionario Info al que apunta el último trailer (o diccionario de xref stream) y, dentro de su última versión, la
 * entrada /Keywords con `calasign-chain-head:<hash>`. buildEnvelopeDocument la escribe con pdf-lib (setKeywords: string
 * hex UTF-16BE con BOM, `<FEFF0063...>`) y el PDF se guarda sin object streams, así que el diccionario queda legible en
 * los bytes; también se acepta string literal `(...)` o hex sin BOM (PDFDocEncoding). Las actualizaciones
 * incrementales posteriores (firmas con certificado propio, sello, LTV) agregan revisiones al final: el objeto se
 * resuelve por la tabla xref (startxref, /Prev), no por la última aparición de `N 0 obj` en el archivo, que podría venir
 * sin comprimir dentro de un documento subido por el remitente.
 * null si no se encuentra (PDF sellado antes de escribir la Keyword, o reescrito por otra herramienta): el que llama
 * puede recurrir a readCertificateChainHead.
 */
export function findChainHeadKeyword(pdf: Uint8Array): string | null {
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  const obj = infoObjectViaXref(buf);
  if (!obj) return null;
  const m = /\/Keywords\s*(\(|<)/.exec(obj);
  if (!m) return null;
  const start = m.index + m[0].length;
  let text: string;
  if (m[1] === "<") {
    const end = obj.indexOf(">", start);
    if (end < 0) return null;
    const hex = obj.slice(start, end).replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
    const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      const body = bytes.subarray(2);
      const swapped = Buffer.alloc(body.length - (body.length % 2));
      for (let i = 0; i + 1 < body.length; i += 2) {
        swapped[i] = body[i + 1];
        swapped[i + 1] = body[i];
      }
      text = swapped.toString("utf16le");
    } else {
      text = bytes.toString("latin1");
    }
  } else {
    // String literal: el hash y el prefijo no llevan paréntesis ni escapes; alcanza con cortar en el primer ')'.
    const end = obj.indexOf(")", start);
    if (end < 0) return null;
    text = obj.slice(start, end);
  }
  const k = new RegExp(`${CHAIN_HEAD_KEYWORD}([0-9a-f]{64})(?![0-9a-f])`).exec(text);
  return k ? k[1] : null;
}

/**
 * Diccionario Info vigente, resuelto como lo haría un lector: startxref → tabla xref clásica y trailer, siguiendo /Prev
 * hacia las revisiones anteriores (la entrada más reciente de cada objeto gana), y el objeto leído en el offset exacto
 * que indica la tabla. Buscar `N 0 obj` en todo el archivo no sirve: un content stream sin comprimir de un documento
 * subido puede traer un `N 0 obj << /Keywords (...) >> endobj` falso. Devuelve el texto (latin1) del objeto, acotado a
 * 64 KB; null si el xref es un xref stream (o híbrido sin la entrada) o si algo no cierra: el que llama recurre al
 * respaldo que sí parsea el PDF.
 */
function infoObjectViaXref(buf: Buffer): string | null {
  let offset: number;
  try {
    offset = findLastStartXref(buf);
  } catch {
    return null;
  }
  let info: { num: number; gen: number } | null = null;
  const sections: { start: number; count: number; body: number }[][] = [];
  const seen = new Set<number>();
  // Cadena de revisiones (de la más nueva a la más vieja), acotada.
  for (let rev = 0; rev < 256; rev++) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= buf.length || seen.has(offset)) return null;
    seen.add(offset);
    const head = buf.toString("latin1", offset, Math.min(buf.length, offset + 4));
    if (head !== "xref") return null; // xref stream (u offset roto): que resuelva el respaldo.
    let pos = offset + 4;
    const subs: { start: number; count: number; body: number }[] = [];
    const ws = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
    for (;;) {
      while (pos < buf.length && ws(buf[pos])) pos++;
      if (buf.toString("latin1", pos, pos + 7) === "trailer") break;
      const m = /^(\d{1,10})[ \t]+(\d{1,10})[ \t]*\r?\n?/.exec(buf.toString("latin1", pos, Math.min(buf.length, pos + 32)));
      if (!m) return null;
      const start = Number(m[1]);
      const count = Number(m[2]);
      const body = pos + m[0].length;
      // Cada entrada ocupa 20 bytes (ISO 32000-1 §7.5.4).
      if (body + count * 20 > buf.length) return null;
      subs.push({ start, count, body });
      pos = body + count * 20;
    }
    sections.push(subs);
    const tEnd = buf.indexOf("startxref", pos, "latin1");
    const trailer = buf.toString("latin1", pos + 7, tEnd < 0 ? Math.min(buf.length, pos + 4096) : Math.min(tEnd, pos + 4096));
    if (!info) {
      const im = /\/Info\s+(\d{1,10})\s+(\d{1,5})\s+R/.exec(trailer);
      if (im) info = { num: Number(im[1]), gen: Number(im[2]) };
    }
    const prev = /\/Prev\s+(\d{1,15})(?![\d.])/.exec(trailer);
    if (!prev) break;
    offset = Number(prev[1]);
  }
  if (!info) return null;
  // Entrada más reciente del objeto Info.
  let entry: { offset: number; gen: number; type: string } | null = null;
  for (const subs of sections) {
    for (const s of subs) {
      if (info.num < s.start || info.num >= s.start + s.count) continue;
      const at = s.body + (info.num - s.start) * 20;
      const m = /^(\d{10}) (\d{5}) ([nf])/.exec(buf.toString("latin1", at, at + 18));
      if (!m) return null;
      entry = { offset: Number(m[1]), gen: Number(m[2]), type: m[3] };
    }
    if (entry) break;
  }
  if (!entry || entry.type !== "n" || entry.gen !== info.gen || entry.offset >= buf.length) return null;
  const m = /^(\d{1,10})\s+(\d{1,5})\s+obj/.exec(buf.toString("latin1", entry.offset, Math.min(buf.length, entry.offset + 32)));
  if (!m || Number(m[1]) !== info.num || Number(m[2]) !== info.gen) return null;
  const from = entry.offset + m[0].length;
  const end = buf.indexOf("endobj", from, "latin1");
  return buf.toString("latin1", from, end < 0 ? Math.min(buf.length, from + 65_536) : Math.min(end, from + 65_536));
}

/**
 * Hash final del registro de eventos que figura en el certificado de un PDF sellado: de los metadatos (Keywords) o, en
 * PDFs sellados antes de que se guardara ahí, del texto impreso en la página del certificado. null si no se encuentra;
 * lanza si no se pudo leer el texto (PdfReaderBusyError u otro error de pdf.js).
 */
export async function readCertificateChainHead(pdf: Uint8Array): Promise<{ head: string; source: "metadata" | "text" } | null> {
  try {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
    const kw = doc.getKeywords() ?? "";
    const m = new RegExp(`${CHAIN_HEAD_KEYWORD}([0-9a-f]{64})`).exec(kw);
    if (m) return { head: m[1], source: "metadata" };
  } catch {
    // Sigue con el texto.
  }
  // Sin try: un error al extraer el texto (lector ocupado, PDF ilegible) se propaga. No es lo mismo que un certificado
  // sin el hash: quien llama no debe recordar "el PDF no lo trae" por un error.
  const { extractPdfPlainText } = await import("./plain-text");
  const { text } = await extractPdfPlainText(pdf, 5_000_000);
  const names = ["es", "pt-BR", "en"].map((l) => labels(l).chainHead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?:${names.join("|")})\\s*([0-9a-f]{64})`, "g");
  let last: string | null = null;
  for (const x of text.matchAll(re)) last = x[1];
  return last ? { head: last, source: "text" } : null;
}

/** Producer/Creator del PDF: el producto de la marca (marca blanca) o el de la plataforma. */
function producerOf(productName: string | null | undefined): string {
  if (productName === undefined || productName === null) return "CalaSign";
  return productName.trim() || "PDF";
}

/** Incrusta cada PNG una sola vez: la misma firma (los mismos bytes) se repite en todos sus campos. */
function imageEmbedder(out: PDFDocument) {
  const cache = new Map<Uint8Array, Promise<PDFImage>>();
  return (png: Uint8Array) => {
    let img = cache.get(png);
    if (!img) {
      // Las firmas se validan al recibirlas; esto evita que una que se haya colado reserve GB en el worker.
      img = Promise.resolve().then(() => (assertPngSize(png), out.embedPng(png)));
      cache.set(png, img);
    }
    return img;
  };
}

/** Copia las páginas de cada documento con sus campos completados estampados y el pie con el id del sobre. */
async function stampDocuments(
  out: PDFDocument,
  fonts: Fonts,
  L: CertLabels,
  documents: { bytes: Uint8Array }[],
  fields: StampField[],
  envelopeId: string,
  embedImage: (png: Uint8Array) => Promise<PDFImage>,
  layers: LayerMerger,
  decorate?: (page: PDFPage) => void,
) {
  for (let di = 0; di < documents.length; di++) {
    const copied = await copyForSealing(out, documents[di].bytes, layers);
    for (let pi = 0; pi < copied.length; pi++) {
      const page = out.addPage(copied[pi]);
      for (const f of fields) {
        if (f.documentIndex !== di || f.page !== pi) continue;
        const img = (f.type === "signature" || f.type === "initials") && f.imagePng ? await embedImage(f.imagePng) : null;
        drawField(page, fonts, f, img, L);
      }
      drawPageFooter(page, fonts, L, envelopeId);
      decorate?.(page);
    }
  }
}

/**
 * Copia al PDF final las páginas de un documento (o adjunto PDF), saneado como en la subida (preparePdfUpload): los
 * originales guardados antes de ese saneamiento pueden traer formularios, capas o contenido activo. Las capas se
 * registran en `layers` con las referencias de la copia (el mismo copiador que las páginas).
 */
async function copyForSealing(out: PDFDocument, bytes: Uint8Array, layers: LayerMerger): Promise<PDFPage[]> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false });
  const oc = await sanitizeForSealing(src);
  // Como PDFDocument.copyPages, pero con el copiador a mano para remapear también las capas del catálogo.
  await src.flush();
  const copier = PDFObjectCopier.for(src.context, out.context);
  const pages = src.getPages().map((p) => {
    const node = copier.copy(p.node);
    return PDFPage.of(node, out.context.register(node), out);
  });
  if (oc) layers.add(oc, copier);
  return pages;
}

/**
 * Capas (contenido opcional) de los documentos copiados. Un original guardado antes del saneamiento de la subida puede
 * tener capas apagadas: el firmante no las vio, así que el PDF final lleva /OCProperties con el mismo estado (sin él,
 * un lector mostraría todo). Varios documentos: unión de las capas, con BaseState ON y las apagadas en /OFF (cada
 * documento aporta las suyas, ya remapeadas por la copia); /Order y /RBGroups se concatenan. Si ninguna capa está
 * apagada no se agrega nada (como en la subida: sin /OCProperties todo se ve).
 */
class LayerMerger {
  private ocgs: PDFObject[] = [];
  private off: PDFObject[] = [];
  private order: PDFObject[] = [];
  private rbGroups: PDFObject[] = [];
  private hidden = false;

  add(oc: OptionalContentState, copier: PDFObjectCopier) {
    if (oc.hidden) this.hidden = true;
    for (const g of oc.groups) {
      const ref = copier.copy(g.ref);
      this.ocgs.push(ref);
      if (!g.on) this.off.push(ref);
    }
    const items = (o: PDFObject | undefined) => {
      const v = o === undefined ? undefined : copier.copy(o);
      const arr = v instanceof PDFArray ? v : undefined;
      return arr?.asArray() ?? [];
    };
    this.order.push(...items(oc.order));
    this.rbGroups.push(...items(oc.rbGroups));
  }

  apply(out: PDFDocument) {
    if (!this.hidden) return;
    const ctx = out.context;
    const d = ctx.obj({ BaseState: "ON", OFF: this.off });
    if (this.order.length) d.set(PDFName.of("Order"), ctx.obj(this.order));
    if (this.rbGroups.length) d.set(PDFName.of("RBGroups"), ctx.obj(this.rbGroups));
    out.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: this.ocgs, D: d }));
  }
}

/**
 * Agrega el diccionario de firma y sella. El PDF se guarda sin object streams para poder ubicar el ByteRange. El
 * placeholder del ByteRange lleva un nombre aleatorio: un `/ByteRange [0 /********** ...]` literal en el contenido de un
 * documento subido no se confunde con el nuestro (con el nombre por defecto, @signpdf encontraba dos y el sellado del
 * sobre fallaba para siempre).
 */
export async function sealPdfDocument(doc: PDFDocument, seal: SealOptions): Promise<Uint8Array> {
  const byteRangePlaceholder = newByteRangePlaceholder();
  pdflibAddPlaceholder({
    byteRangePlaceholder,
    pdfDoc: doc,
    reason: seal.reason ?? "Sello de integridad CalaSign",
    contactInfo: seal.contactInfo ?? "https://calasign.com",
    name: seal.signerName ?? "CalaSign",
    location: seal.location ?? "Cloud",
    signatureLength: 24_000,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    widgetRect: [0, 0, 0, 0],
  });
  const unsigned = await doc.save({ useObjectStreams: false });
  return signPlaceholder(unsigned, byteRangePlaceholder, 0, (content) => buildPadesCms(content, seal.provider, seal));
}

/** Agrega un adjunto: páginas del PDF o la imagen en una página A4, con un rótulo arriba. */
async function appendAttachment(out: PDFDocument, fonts: Fonts, L: CertLabels, a: FinalizeAttachment, envelopeId: string, layers: LayerMerger) {
  const caption = safeText(fonts.regular, `${L.attachment}: ${a.name} — ${L.uploadedBy} ${a.recipientName}`);
  if (a.contentType === "application/pdf") {
    const copied = await copyForSealing(out, a.bytes, layers);
    for (const p of copied) {
      const page = out.addPage(p);
      withDisplayedSpace(page, (_W, H) => {
        page.drawText(caption, { x: 8, y: H - 17, size: 5.5, font: fonts.regular, color: MUTED });
      });
      drawPageFooter(page, fonts, L, envelopeId);
    }
    return;
  }
  const img = a.contentType === "image/png" ? (assertPngSize(a.bytes), await out.embedPng(a.bytes)) : await out.embedJpg(a.bytes);
  const page = out.addPage([A4.w, A4.h]);
  const maxW = A4.w - 2 * M;
  const maxH = A4.h - 2 * M - 20;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawText(caption, { x: M, y: A4.h - M + 6, size: 8, font: fonts.regular, color: MUTED });
  page.drawImage(img, { x: (A4.w - w) / 2, y: A4.h - M - 10 - h, width: w, height: h });
  drawPageFooter(page, fonts, L, envelopeId);
}

function drawField(page: PDFPage, fonts: Fonts, f: StampField, img: PDFImage | null, L: CertLabels) {
  withDisplayedSpace(page, (W, H) => {
    const bx = f.x * W;
    const bw = f.width * W;
    const bh = f.height * H;
    const by = H - f.y * H - bh; // abajo-izquierda del campo
    if (img) {
      const scale = Math.min(bw / img.width, bh / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: bx + (bw - w) / 2, y: by + (bh - h) / 2, width: w, height: h });
      return;
    }
    if (f.type === "checkbox") {
      if (f.value === "true") {
        const s = Math.min(bw, bh) * 0.8;
        const ox = bx + (bw - s) / 2;
        const oy = by + (bh - s) / 2;
        const t = Math.max(0.8, s / 9);
        page.drawLine({ start: { x: ox + s * 0.1, y: oy + s * 0.5 }, end: { x: ox + s * 0.4, y: oy + s * 0.15 }, thickness: t, color: INK });
        page.drawLine({ start: { x: ox + s * 0.4, y: oy + s * 0.15 }, end: { x: ox + s * 0.92, y: oy + s * 0.88 }, thickness: t, color: INK });
      }
      return;
    }
    const raw = f.type === "attachment" ? (f.value ? `${L.attachment}: ${f.value}` : "") : (f.value ?? "");
    const text = safeText(fonts.regular, raw.replace(/\s+/g, " ").trim());
    if (!text) return;
    // Lugar hasta el borde visible de la página: las líneas que no entran en la caja siguen hacia abajo sin salir de
    // la hoja (ver layoutFieldText).
    const fit = layoutFieldText(fonts.regular, text, bw, bh, { below: Math.min(by + bh, H) - 2, right: W - bx });
    // Sin recorte al rectángulo del campo: en un documento firmado no se puede perder ningún carácter del valor.
    if (!fit.wrapped) {
      page.drawText(fit.lines[0]!, { x: bx + 1, y: by + (bh - fit.size * 0.72) / 2, size: fit.size, font: fonts.regular, color: INK });
    } else {
      const lh = fit.size * FIELD_LINE_HEIGHT;
      // Entra en la caja: centrado en el alto. No entra: desde el borde de arriba de la caja hacia abajo.
      const top = fit.overflows ? Math.min(by + bh, H) : by + (bh + fit.lines.length * lh) / 2;
      fit.lines.forEach((line, i) => {
        page.drawText(line, { x: bx + 1, y: top - i * lh - fit.size * 0.9, size: fit.size, font: fonts.regular, color: INK });
      });
    }
  });
}

/** Debajo de este tamaño el texto estampado se considera difícil de leer (la web avisa al firmante). No trunca nada. */
export const FIELD_LEGIBLE_FONT_SIZE = 6;
const FIELD_LINE_HEIGHT = 1.15;
/** Tamaño mínimo dentro de la caja; más chico sólo para no salirse de la página. */
const FIELD_MIN_WRAP_SIZE = 4;
const FIELD_MIN_PAGE_SIZE = 1;

export interface FieldTextLayout {
  size: number;
  lines: string[];
  /** Más de una línea (o partido): se dibuja línea por línea. */
  wrapped: boolean;
  /** Las líneas no entran en el alto de la caja y siguen hacia abajo (sin salir de la página). */
  overflows: boolean;
}

/**
 * Cómo entra el texto de un campo en su caja (bw × bh, en puntos). Regla definitiva (nunca se pierde un carácter, nunca
 * se recorta ni se dibuja fuera de la página):
 * 1. Si entra en UNA línea al tamaño que elegía siempre fitFontSize (de min(0.7·alto, 11) pt achicando de a 0.25) y ese
 *    tamaño es ≥ FIELD_LEGIBLE_FONT_SIZE (6 pt): una línea exactamente como antes, sin partir (las plantillas
 *    existentes no cambian; una caja alta que sólo necesitaba achicar un poco no se parte).
 * 2. Si no, se parte en los espacios, al mayor tamaño entre 4 pt y min(0.7·alto, 11) con el que todas las líneas entran
 *    en el alto de la caja, sin partir ninguna palabra (ni los grupos numéricos "pegados": importes, teléfonos) si hay
 *    algún tamaño ≥ 4 pt con el que entran enteras. Sólo el texto en escrituras sin espacios (CJK, tailandés) se parte
 *    por carácter a cualquier tamaño. Si ningún tamaño ≥ 4 pt sirve con las palabras enteras (un nombre de archivo, un
 *    correo o un número largo), la palabra que no entra se parte por grafema y cada pedazo empieza su propia línea.
 * 3. Si ni a 4 pt entran en el alto, quedan a 4 pt y las líneas de más siguen debajo de la caja, hasta el borde visible
 *    de la página (`room`); si ni así entran, se achica más (hasta 1 pt) para que todo quede dentro de la página.
 * El ancho de partido es el de la caja, limitado por el borde derecho de la página.
 */
export function layoutFieldText(font: PDFFont, text: string, bw: number, bh: number, room: { below?: number; right?: number } = {}): FieldTextLayout {
  const maxW = bw - 2;
  const maxSize = Math.min(bh * 0.7, 11);
  const width = widthAt1(font);
  // fitFontSize mide el texto entero en cada paso de 0.25 pt: sólo se llama si a 6 pt podría entrar en una línea. La
  // estimación suma los anchos de las palabras (con caché, los reusa el partido) con margen por el interletrado; medir
  // el texto entero de un valor de 2000 caracteres costaba más que todo el partido.
  const words = text.split(" ");
  const approxW = words.reduce((acc, w) => acc + (w ? width(w) : 0), 0) + (words.length - 1) * width(" ");
  if (approxW * FIELD_LEGIBLE_FONT_SIZE <= maxW * 1.1) {
    const single = fitFontSize(font, text, maxW, maxSize);
    if (single >= FIELD_LEGIBLE_FONT_SIZE && font.widthOfTextAtSize(text, single) <= maxW) return { size: single, lines: [text], wrapped: false, overflows: false };
  }

  const units = wrapUnits(text);
  const wrapW = Math.max(1, Math.min(bw, room.right ?? Infinity) - 2);
  const minSize = Math.min(FIELD_MIN_WRAP_SIZE, maxSize);
  const result = (size: number, lines: string[]): FieldTextLayout => {
    const overflows = lines.length * size * FIELD_LINE_HEIGHT > bh + 1e-6;
    return { size, lines, wrapped: lines.length > 1 || overflows, overflows };
  };
  const sizes: number[] = [];
  for (let s = maxSize; s > minSize; s -= 0.25) sizes.push(s);
  sizes.push(minSize);
  const fitsBox = (lines: number, s: number, h: number) => lines * s * FIELD_LINE_HEIGHT <= h + 1e-6;
  // 2a) Palabras enteras (CJK/tailandés, que no usan espacios, sí se parten por carácter a cualquier tamaño): el mayor
  //     tamaño entre el máximo y 4 pt; primero con los grupos numéricos ("$ 1.234,00") enteros, después en sus partes.
  // 2b) Sólo si a ningún tamaño ≥ 4 pt entran las palabras enteras, se parten por grafema, igual que antes.
  // Entrar NO es monótono en el tamaño (un grupo numérico que a un tamaño entra entero en una línea, a uno menor puede
  // pegarse a la palabra anterior y desplazar el resto), así que se recorren todos los tamaños de arriba hacia abajo.
  // Los anchos se miden una vez a 1 pt (widthAt1) y el partido corta apenas sobran líneas: cada intento es aritmética.
  for (const [splitWords, numbersWhole] of [[false, true], [false, false], [true, true], [true, false]] as const) {
    const hit = largestFit(sizes, (s) => {
      const w = wrapFieldUnits(units, width, s, wrapW, splitWords, maxLinesIn(s, bh));
      return (!numbersWhole || !w.numberSplit) && !w.wordSplit && !w.tooWide && !w.tooTall && fitsBox(w.lines.length, s, bh) ? w : null;
    });
    if (hit) return result(hit.size, hit.value.lines);
  }
  // 3) Ni a 4 pt entra en el alto: sigue debajo de la caja; a cada tamaño se prefieren las palabras enteras.
  const availH = Math.max(1, room.below ?? Infinity);
  const small: number[] = [];
  for (let s = minSize; ; s -= 0.25) {
    small.push(s);
    if (s - 0.25 < FIELD_MIN_PAGE_SIZE) break;
  }
  const below = (splitWords: boolean) =>
    largestFit(small, (s) => {
      const w = wrapFieldUnits(units, width, s, wrapW, splitWords, maxLinesIn(s, availH));
      return !w.wordSplit && !w.tooWide && !w.tooTall && fitsBox(w.lines.length, s, availH) ? w : null;
    });
  const whole = below(false);
  const split = below(true);
  const best = whole && (!split || whole.size >= split.size) ? whole : split;
  if (best) return result(best.size, best.value.lines);
  const last = small[small.length - 1]!;
  return result(last, wrapFieldUnits(units, width, last, wrapW, true).lines);
}

/** El primer tamaño de `sizes` (de mayor a menor) con el que `test` da un resultado. Recorre todos en orden: que un
 *  tamaño sirva no implica que sirvan los menores (el partido no es monótono), así que no se puede buscar en binario. */
function largestFit<T>(sizes: number[], test: (s: number) => T | null): { size: number; value: T } | null {
  for (const size of sizes) {
    const value = test(size);
    if (value) return { size, value };
  }
  return null;
}

/** Cuántas líneas de tamaño `s` entran en el alto `h` (para cortar el partido apenas sobran). */
function maxLinesIn(s: number, h: number): number {
  // +1 de margen por redondeo: el corte es sólo un atajo; lo que decide si entra es fitsBox.
  return Number.isFinite(h) ? Math.floor((h + 1e-6) / (s * FIELD_LINE_HEIGHT)) + 1 : Infinity;
}

/** Ancho a 1 pt, con caché (el ancho es proporcional al tamaño; sumar anchos de partes nunca da menos que el real). */
function widthAt1(font: PDFFont): (s: string) => number {
  const cache = new Map<string, number>();
  return (s) => {
    let w = cache.get(s);
    if (w === undefined) cache.set(s, (w = font.widthOfTextAtSize(s, 1)));
    return w;
  };
}

/**
 * Unidades que no se separan al partir el texto de un campo: palabras, salvo que dos seguidas no tengan letras
 * ("$ 1.234,00", "+54 11 4444 5555", "12 345"), que van juntas para que un importe o un número no quede partido.
 */
function wrapUnits(text: string): string[] {
  const units: string[] = [];
  let prevNoLetters = false;
  for (const tok of text.split(" ").filter(Boolean)) {
    const noLetters = !/\p{L}/u.test(tok);
    if (noLetters && prevNoLetters && units.length) units[units.length - 1] += ` ${tok}`;
    else units.push(tok);
    prevNoLetters = noLetters;
  }
  return units;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCache = new Map<string, string[]>();
function graphemesOf(tok: string): string[] {
  let g = graphemeCache.get(tok);
  if (!g) {
    g = Array.from(graphemes.segment(tok), (x) => x.segment);
    if (graphemeCache.size > 5000) graphemeCache.clear();
    graphemeCache.set(tok, g);
  }
  return g;
}

/** Escrituras que no separan las palabras con espacios (chino, japonés, tailandés, laosiano, jemer, birmano, tibetano):
 *  una "palabra" de esas es en realidad una frase y se parte por carácter a cualquier tamaño. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

/**
 * Líneas de a lo sumo `maxW` a tamaño `size`: se corta en los espacios; una unidad que no entra sola en el ancho se
 * separa en sus palabras. Una palabra que no entra: si es de una escritura sin espacios (CJK, tailandés) se parte por
 * grafema siempre; si no, sólo con `splitWords` (si no, `wordSplit` y el resultado no sirve), y sus pedazos empiezan
 * cada uno su línea y la palabra siguiente también (que "Bueno|s Aires" no se lea como "s Aires").
 * `tooWide`: algún grafema solo ya es más ancho que `maxW`. `numberSplit`: hubo que partir un grupo o token sin letras.
 */
function wrapFieldUnits(
  units: string[],
  width: (s: string) => number,
  size: number,
  maxW: number,
  splitWords: boolean,
  maxLines = Infinity,
): { lines: string[]; tooWide: boolean; numberSplit: boolean; wordSplit: boolean; tooTall: boolean } {
  const lines: string[] = [];
  const sp = width(" ") * size;
  let line = "";
  let lineW = 0;
  let tooWide = false;
  let numberSplit = false;
  let wordSplit = false;
  const add = (tok: string, w: number): boolean => {
    if (line && lineW + sp + w <= maxW) {
      line += ` ${tok}`;
      lineW += sp + w;
      return true;
    }
    if (w <= maxW) {
      if (line) lines.push(line);
      line = tok;
      lineW = w;
      return true;
    }
    return false;
  };
  for (const u of units) {
    // Ya sobran líneas: el resultado no sirve, no hace falta terminar de partir (un valor largo a tamaño grande).
    if (lines.length > maxLines) return { lines, tooWide, numberSplit, wordSplit, tooTall: true };
    if (add(u, width(u) * size)) continue;
    if (!/\p{L}/u.test(u)) numberSplit = true;
    for (const tok of u.split(" ")) {
      if (add(tok, width(tok) * size)) continue;
      const free = NO_SPACE_SCRIPT.test(tok);
      if (!free) {
        if (!/\p{L}/u.test(tok)) numberSplit = true;
        if (!splitWords) {
          wordSplit = true;
          return { lines, tooWide, numberSplit, wordSplit, tooTall: false };
        }
      }
      if (line) lines.push(line);
      line = "";
      lineW = 0;
      for (const ch of graphemesOf(tok)) {
        const cw = width(ch) * size;
        if (cw > maxW) tooWide = true;
        if (line && lineW + cw > maxW) {
          lines.push(line);
          line = ch;
          lineW = cw;
        } else {
          line += ch;
          lineW += cw;
        }
      }
      if (!free && line) {
        lines.push(line);
        line = "";
        lineW = 0;
      }
    }
  }
  if (line) lines.push(line);
  return { lines, tooWide, numberSplit, wordSplit, tooTall: lines.length > maxLines };
}

/** @internal Sólo para las pruebas (comparar el tamaño elegido contra un recorrido exhaustivo). */
export const fieldTextInternals = { wrapUnits, wrapFieldUnits, widthAt1, FIELD_LINE_HEIGHT, FIELD_MIN_WRAP_SIZE, FIELD_MIN_PAGE_SIZE };

function drawPageFooter(page: PDFPage, fonts: Fonts, L: CertLabels, envelopeId: string) {
  withDisplayedSpace(page, (_W, H) => {
    page.drawText(`${L.pageFooter} ${envelopeId}`, { x: 8, y: H - 9, size: 5.5, font: fonts.regular, color: MUTED });
  });
}

// ───────────────────────────── Certificado de finalización ─────────────────────────────

const A4 = { w: 595.28, h: 841.89 };
const M = 42;

async function drawCertificate(
  doc: PDFDocument,
  fonts: Fonts,
  L: CertLabels,
  c: CertificateData,
  embedImage: (png: Uint8Array) => Promise<PDFImage>,
) {
  let page = doc.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const contentW = A4.w - 2 * M;
  const accent = hexToRgb(c.branding?.primaryColor) ?? ACCENT;
  const pagesAdded: PDFPage[] = [page];

  const ensure = (needed: number) => {
    if (y - needed < M + 20) {
      page = doc.addPage([A4.w, A4.h]);
      pagesAdded.push(page);
      y = A4.h - M;
    }
  };
  const text = (s: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; maxW?: number } = {}) => {
    const size = opts.size ?? 8.5;
    const font = opts.bold ? fonts.bold : fonts.regular;
    const lines = wrapText(font, safeMultiline(font, s), size, opts.maxW ?? contentW);
    for (const line of lines) {
      ensure(size * 1.4);
      page.drawText(line, { x: opts.x ?? M, y: y - size, size, font, color: opts.color ?? INK });
      y -= size * 1.4;
    }
  };
  /** `right`: borde derecho de los valores (por defecto el margen; en un destinatario con firma, antes del recuadro). */
  const kv = (k: string, v: string | null | undefined, x = M, keyW = 150, right = A4.w - M) => {
    if (!v) return;
    const size = 8.5;
    const lines = wrapText(fonts.regular, safeMultiline(fonts.regular, v), size, right - x - keyW);
    // El bloque entero junto si entra en una página; si no (un motivo de 1000 caracteres con un salto por línea son
    // cientos de líneas), sigue en la página siguiente línea por línea en vez de dibujarse fuera de la hoja.
    ensure(Math.min(size * 1.4 * lines.length, A4.h - 2 * M - 20));
    page.drawText(safeText(fonts.bold, k), { x, y: y - size, size, font: fonts.bold, color: MUTED });
    for (const line of lines) {
      ensure(size * 1.4);
      page.drawText(line, { x: x + keyW, y: y - size, size, font: fonts.regular, color: INK });
      y -= size * 1.4;
    }
  };
  const section = (title: string) => {
    ensure(40);
    y -= 10;
    page.drawText(safeText(fonts.bold, title), { x: M, y: y - 11, size: 11, font: fonts.bold, color: accent });
    y -= 16;
    page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.6, color: LINE });
    y -= 8;
  };
  const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : null);

  // Encabezado
  page.drawRectangle({ x: 0, y: A4.h - 6, width: A4.w, height: 6, color: accent });
  if (c.branding?.logo) {
    try {
      const logo = c.branding.logo.type === "png" ? (assertPngSize(c.branding.logo.bytes), await doc.embedPng(c.branding.logo.bytes)) : await doc.embedJpg(c.branding.logo.bytes);
      const scale = Math.min(130 / logo.width, 38 / logo.height, 1);
      page.drawImage(logo, { x: A4.w - M - logo.width * scale, y: A4.h - M - logo.height * scale + 4, width: logo.width * scale, height: logo.height * scale });
    } catch {
      // Logo ilegible: el certificado sale sin logo.
    }
  }
  text(L.title, { size: 18, bold: true });
  text(L.subtitle, { size: 9.5, color: MUTED });
  y -= 6;
  kv(L.envelope, c.envelopeId);
  kv(L.subject, c.subject);
  kv(L.organization, c.organizationName);
  kv(L.sender, c.senderEmail ? `${c.senderName} <${c.senderEmail}>` : c.senderName);
  kv(L.created, fmt(c.createdAt));
  kv(L.sent, fmt(c.sentAt));
  kv(L.completed, fmt(c.completedAt));
  if (c.signatureLevel) kv(L.signatureLevel, c.signatureLevel === "qualified" ? L.level_qualified : c.signatureLevel === "advanced" ? L.level_advanced : L.level_simple);
  if (c.companySeal) kv(L.companySeal, c.companySeal.commonName ?? c.companySeal.name);

  section(L.documents);
  c.documents.forEach((d, i) => {
    text(`${i + 1}. ${d.name} (${d.pageCount} ${L.pages})`, { bold: true });
    kv(L.originalHash, d.sha256, M + 12, 108);
  });

  if (c.attachments && c.attachments.length) {
    section(L.attachments);
    c.attachments.forEach((a, i) => {
      text(`${i + 1}. ${a.name} — ${L.uploadedBy} ${a.recipientName}${a.appended ? ` (${L.appended})` : ""}`, { bold: true });
      kv(L.originalHash, a.sha256, M + 12, 108);
    });
  }

  if (c.payments && c.payments.length) {
    section(L.payments);
    c.payments.forEach((p, i) => {
      text(`${i + 1}. ${p.description} — ${p.amount}`, { bold: true });
      kv(L.paidBy, p.payerName, M + 12, 108);
      kv(L.paymentProvider, p.provider, M + 12, 108);
      kv(L.paymentReference, p.reference, M + 12, 108);
      kv(L.paidAt, fmt(p.paidAt), M + 12, 108);
    });
  }

  section(L.recipients);
  for (const r of c.recipients) {
    ensure(110);
    const role = r.role === "cc" ? L.role_cc : r.role === "approver" ? L.role_approver : L.role_signer;
    text(`${r.name} — ${role}`, { bold: true, size: 9.5 });
    const top = y;
    // Si los datos del destinatario siguen en la página siguiente, la firma va junto a su nombre (en la página donde
    // empezó el bloque): `top` es una coordenada de esa página, y en la nueva caía encima del destinatario siguiente.
    const topPage = page;
    const ix = M + 12;
    // Recuadro de la firma, a la derecha del bloque: los valores cortan antes. Si no, un correo o un motivo largo
    // seguía por debajo de la imagen de la firma y quedaba tapado en el certificado.
    const boxW = 130;
    const boxH = 48;
    const valueRight = r.signaturePng ? A4.w - M - boxW - 12 : A4.w - M;
    kv(L.email, r.email, ix, 150, valueRight);
    kv(L.phone, r.phone, ix, 150, valueRight);
    kv(L.idDocument, r.idDocument, ix, 150, valueRight);
    kv(L.channels, r.channels.join(", "), ix, 150, valueRight);
    if (r.role !== "cc") kv(L.auth, authLabel(L, r.authMethod), ix, 150, valueRight);
    kv(L.sent, fmt(r.sentAt), ix, 150, valueRight);
    kv(L.viewed, fmt(r.viewedAt), ix, 150, valueRight);
    kv(L.consented, fmt(r.consentedAt), ix, 150, valueRight);
    kv(r.role === "approver" ? L.approved : L.signed, fmt(r.signedAt), ix, 150, valueRight);
    kv(L.note, r.note ?? null, ix, 150, valueRight);
    if (r.certificateSignature) kv(L.certSignature, L.certSignatureNote, ix, 150, valueRight);
    if (r.identity) {
      const idv = r.identity;
      const levelLabel = (L as Record<string, string>)[`idv_level_${idv.level}`] ?? idv.level;
      kv(L.idv, `${idv.provider} · ${levelLabel} · ${idv.result === "verified" ? L.idv_verified : L.idv_failed}${idv.verifiedAt ? ` · ${fmt(idv.verifiedAt)}` : ""}`, ix, 150, valueRight);
      kv(L.idv_document, idv.document, ix, 150, valueRight);
      const matches: string[] = [];
      if (idv.nameScore != null) matches.push(`${L.idv_name} ${Math.round(idv.nameScore * 100)} %`);
      if (idv.documentNumberMatched === true) matches.push(L.idv_docnum);
      if (idv.faceMatchScore != null) matches.push(`${L.idv_face} ${Math.round(idv.faceMatchScore * 100)} %`);
      if (idv.liveness === true) matches.push(L.idv_liveness);
      kv(L.idv_matched, matches.length ? matches.join(", ") : null, ix, 150, valueRight);
      kv(L.idv_reference, idv.reference, ix, 150, valueRight);
    }
    kv(L.ip, r.ip, ix, 150, valueRight);
    kv(L.device, r.userAgent ? r.userAgent.slice(0, 160) : null, ix, 150, valueRight);
    if (r.signaturePng) {
      const img = await embedImage(r.signaturePng);
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const bx = A4.w - M - boxW;
      const byTop = topPage === page ? Math.min(top, y + 200) : top;
      topPage.drawRectangle({ x: bx - 4, y: byTop - boxH - 8, width: boxW + 8, height: boxH + 8, borderColor: LINE, borderWidth: 0.6 });
      topPage.drawImage(img, { x: bx + (boxW - img.width * scale) / 2, y: byTop - boxH - 4 + (boxH - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
    }
    y -= 8;
  }

  section(L.events);
  const cols = [M, M + 28, M + 168, M + 300];
  const header = () => {
    ensure(14);
    [["#", cols[0]], [L.when, cols[1]], [L.event, cols[2]], [`${L.actor} / ${L.ip}`, cols[3]]].forEach(([s, x]) =>
      page.drawText(safeText(fonts.bold, String(s)), { x: Number(x), y: y - 8, size: 7.5, font: fonts.bold, color: MUTED }),
    );
    y -= 13;
  };
  header();
  for (const e of c.events) {
    const actor = safeText(fonts.regular, `${e.actor}${e.ip ? ` · ${e.ip}` : ""}`);
    const actorLines = wrapText(fonts.regular, actor, 7.5, A4.w - M - cols[3]);
    const rowH = Math.max(1, actorLines.length) * 10.5;
    if (y - rowH < M + 20) {
      page = doc.addPage([A4.w, A4.h]);
      pagesAdded.push(page);
      y = A4.h - M;
      header();
    }
    page.drawText(String(e.seq), { x: cols[0], y: y - 8, size: 7.5, font: fonts.regular, color: INK });
    page.drawText(fmt(e.occurredAt) ?? "", { x: cols[1], y: y - 8, size: 7.5, font: fonts.regular, color: INK });
    // Tipos largos (recipient.embedded_session_started) se achican para no pisar la columna de actor / IP.
    const typeText = safeText(fonts.regular, e.type);
    page.drawText(typeText, { x: cols[2], y: y - 8, size: fitFontSize(fonts.regular, typeText, cols[3] - cols[2] - 4, 7.5), font: fonts.regular, color: INK });
    actorLines.forEach((line, i) => page.drawText(line, { x: cols[3], y: y - 8 - i * 10.5, size: 7.5, font: fonts.regular, color: INK }));
    y -= rowH;
  }

  section(L.chainHead);
  text(c.chainHead, { size: 8.5 });
  y -= 6;
  text(c.timestamped === false ? L.statementNoTimestamp : c.timestamped === null ? L.statementNeutral : L.statement, { size: 8, color: MUTED });
  if (c.verifyUrl) text(`${L.verifyAt} ${c.verifyUrl}`, { size: 8, color: MUTED });

  pagesAdded.forEach((p, i) => {
    p.drawText(safeText(fonts.regular, `${L.title} · ${c.envelopeId} · ${L.page} ${i + 1}/${pagesAdded.length}`), {
      x: M,
      y: M - 18,
      size: 7,
      font: fonts.regular,
      color: MUTED,
    });
  });
}

function authLabel(L: CertLabels, m: string): string {
  if (m === "otp_email") return L.auth_otp_email;
  if (m === "otp_sms") return L.auth_otp_sms;
  if (m === "otp_whatsapp") return L.auth_otp_whatsapp;
  return m === "link" ? L.auth_link : m;
}

function hexToRgb(hex: string | null | undefined) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
