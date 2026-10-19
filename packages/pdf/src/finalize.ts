// Arma el PDF final de un sobre: estampa los campos completados en cada documento, une todo,
// agrega el certificado de finalización y sella con PAdES.
import { PDFDocument, PDFPage, rgb, type PDFImage } from "pdf-lib";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SUBFILTER_ETSI_CADES_DETACHED, Signer } from "@signpdf/utils";
import signpdfModule from "@signpdf/signpdf";
import { buildPadesCms, type CmsOptions } from "./cms";
import { embedFonts, fitFontSize, safeMultiline, safeText, withDisplayedSpace, wrapText, type Fonts } from "./layout";
import { labels, type CertLabels } from "./i18n";
import type { SignatureProvider } from "./provider";

// @signpdf/signpdf exporta una instancia por defecto; según el bundler llega anidada.
const signpdf = ((signpdfModule as unknown as { default?: typeof signpdfModule }).default ?? signpdfModule) as {
  sign(pdf: Buffer, signer: Signer, signingTime?: Date): Promise<Buffer>;
};

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
  await stampDocuments(out, fonts, L, input.documents, input.fields, input.envelopeId, imageEmbedder(out), (page) =>
    withDisplayedSpace(page, (W) => {
      const size = fitFontSize(fonts.bold, text, W - 16, 8);
      page.drawText(text, { x: 8, y: 6, size, font: fonts.bold, color: rgb(0.7, 0.1, 0.1) });
    }),
  );
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

  await stampDocuments(out, fonts, L, input.documents, input.fields, input.certificate.envelopeId, embedImage);

  for (const a of input.attachments ?? []) await appendAttachment(out, fonts, L, a, input.certificate.envelopeId);

  await drawCertificate(out, fonts, L, input.certificate, embedImage);

  out.setTitle(input.certificate.subject);
  out.setProducer(producerOf(input.certificate.productName));
  out.setCreator(producerOf(input.certificate.productName));
  out.setModificationDate(new Date(input.certificate.completedAt));
  return out;
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
      img = out.embedPng(png);
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
  decorate?: (page: PDFPage) => void,
) {
  for (let di = 0; di < documents.length; di++) {
    const src = await PDFDocument.load(documents[di].bytes, { updateMetadata: false });
    try {
      src.getForm().flatten();
    } catch {
      // Formularios rotos: se copian tal cual.
    }
    const copied = await out.copyPages(src, src.getPageIndices());
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

/** Agrega el diccionario de firma y sella. El PDF se guarda sin object streams para poder ubicar el ByteRange. */
export async function sealPdfDocument(doc: PDFDocument, seal: SealOptions): Promise<Uint8Array> {
  pdflibAddPlaceholder({
    pdfDoc: doc,
    reason: seal.reason ?? "Sello de integridad CalaSign",
    contactInfo: seal.contactInfo ?? "https://calasign.com",
    name: seal.signerName ?? "CalaSign",
    location: seal.location ?? "Cloud",
    signatureLength: 24_000,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    widgetRect: [0, 0, 0, 0],
  });
  const unsigned = Buffer.from(await doc.save({ useObjectStreams: false }));

  class PadesSigner extends Signer {
    async sign(content: Buffer): Promise<Buffer> {
      return Buffer.from(await buildPadesCms(new Uint8Array(content), seal.provider, seal));
    }
  }
  const signed = await signpdf.sign(unsigned, new PadesSigner());
  return new Uint8Array(signed);
}

/** Agrega un adjunto: páginas del PDF o la imagen en una página A4, con un rótulo arriba. */
async function appendAttachment(out: PDFDocument, fonts: Fonts, L: CertLabels, a: FinalizeAttachment, envelopeId: string) {
  const caption = safeText(fonts.regular, `${L.attachment}: ${a.name} — ${L.uploadedBy} ${a.recipientName}`);
  if (a.contentType === "application/pdf") {
    const src = await PDFDocument.load(a.bytes, { updateMetadata: false });
    try {
      src.getForm().flatten();
    } catch {
      // se copia tal cual
    }
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const p of copied) {
      const page = out.addPage(p);
      withDisplayedSpace(page, (_W, H) => {
        page.drawText(caption, { x: 8, y: H - 17, size: 5.5, font: fonts.regular, color: MUTED });
      });
      drawPageFooter(page, fonts, L, envelopeId);
    }
    return;
  }
  const img = a.contentType === "image/png" ? await out.embedPng(a.bytes) : await out.embedJpg(a.bytes);
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
    const size = fitFontSize(fonts.regular, text, bw - 2, Math.min(bh * 0.7, 11));
    page.drawText(text, { x: bx + 1, y: by + (bh - size * 0.72) / 2, size, font: fonts.regular, color: INK });
  });
}

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
      const logo = c.branding.logo.type === "png" ? await doc.embedPng(c.branding.logo.bytes) : await doc.embedJpg(c.branding.logo.bytes);
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
    page.drawText(safeText(fonts.regular, e.type), { x: cols[2], y: y - 8, size: 7.5, font: fonts.regular, color: INK });
    actorLines.forEach((line, i) => page.drawText(line, { x: cols[3], y: y - 8 - i * 10.5, size: 7.5, font: fonts.regular, color: INK }));
    y -= rowH;
  }

  section(L.chainHead);
  text(c.chainHead, { size: 8.5 });
  y -= 6;
  text(L.statement, { size: 8, color: MUTED });
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
