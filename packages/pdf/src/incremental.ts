// Actualizaciones incrementales de PDF (ISO 32000-1 §7.5.6): se agregan objetos nuevos o reemplazos al
// final del archivo, con su propia tabla xref y /Prev al trailer anterior. Los bytes ya firmados no se
// tocan, así que las firmas anteriores siguen siendo válidas. Es la base de B-LT (DSS), B-LTA (sello de
// documento) y de una segunda firma (sello de empresa).
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import { newByteRangePlaceholder, signPlaceholder } from "./placeholder";

export const SUBFILTER_RFC3161 = "ETSI.RFC3161";

/** Documento abierto para agregarle una revisión incremental. */
export class IncrementalUpdate {
  private readonly changed = new Map<string, { ref: PDFRef; obj: PDFObject }>();

  private constructor(
    readonly original: Uint8Array,
    readonly doc: PDFDocument,
    private readonly prevStartXref: number,
  ) {}

  static async open(pdf: Uint8Array) {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    return new IncrementalUpdate(pdf, doc, findLastStartXref(pdf));
  }

  get context() {
    return this.doc.context;
  }

  /** Registra un objeto nuevo y devuelve su referencia. */
  add(obj: PDFObject): PDFRef {
    const ref = this.context.nextRef();
    this.context.assign(ref, obj);
    this.changed.set(ref.toString(), { ref, obj });
    return ref;
  }

  /** Marca un objeto existente (ya modificado en memoria) para reescribirlo en esta revisión. */
  touch(ref: PDFRef) {
    const obj = this.context.lookup(ref);
    if (!obj) throw new Error(`objeto inexistente ${ref.toString()}`);
    this.changed.set(ref.toString(), { ref, obj });
  }

  get catalogRef(): PDFRef {
    return this.context.trailerInfo.Root as PDFRef;
  }

  /** Bytes finales: original + objetos de la revisión + xref + trailer. */
  serialize(): Uint8Array {
    const parts: Buffer[] = [Buffer.from(this.original)];
    let offset = this.original.length;
    const push = (b: Buffer) => {
      parts.push(b);
      offset += b.length;
    };
    if (this.original[this.original.length - 1] !== 0x0a) push(Buffer.from("\n"));

    const entries: { num: number; gen: number; offset: number }[] = [];
    const sorted = [...this.changed.values()].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber);
    for (const { ref, obj } of sorted) {
      entries.push({ num: ref.objectNumber, gen: ref.generationNumber, offset });
      const body = new Uint8Array(obj.sizeInBytes());
      obj.copyBytesInto(body, 0);
      push(Buffer.from(`${ref.objectNumber} ${ref.generationNumber} obj\n`, "latin1"));
      push(Buffer.from(body));
      push(Buffer.from("\nendobj\n", "latin1"));
    }

    const xrefOffset = offset;
    let xref = "xref\n";
    for (let i = 0; i < entries.length; ) {
      let j = i;
      while (j + 1 < entries.length && entries[j + 1].num === entries[j].num + 1) j++;
      xref += `${entries[i].num} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) xref += `${String(entries[k].offset).padStart(10, "0")} ${String(entries[k].gen).padStart(5, "0")} n\r\n`;
      i = j + 1;
    }
    const t = this.context.trailerInfo;
    const trailer = this.context.obj({}) as PDFDict;
    trailer.set(PDFName.of("Size"), PDFNumber.of(this.context.largestObjectNumber + 1));
    trailer.set(PDFName.of("Root"), t.Root as PDFRef);
    if (t.Info) trailer.set(PDFName.of("Info"), t.Info as PDFObject);
    if (t.ID) trailer.set(PDFName.of("ID"), t.ID as PDFObject);
    trailer.set(PDFName.of("Prev"), PDFNumber.of(this.prevStartXref));
    push(Buffer.from(`${xref}trailer\n${trailer.toString()}\nstartxref\n${xrefOffset}\n%%EOF\n`, "latin1"));
    return new Uint8Array(Buffer.concat(parts));
  }
}

export function findLastStartXref(pdf: Uint8Array): number {
  // En todo el archivo, de atrás hacia adelante, como pdf.js: no solo en los últimos 2 KB. Con relleno después del %%EOF
  // (comentarios, basura) no se encontraba, y la detección de PDF ambiguo (inspectPdf) daba el archivo por bueno
  // mientras el visor seguía usando el xref.
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  for (let at = buf.lastIndexOf("startxref"); at >= 0; at = at > 0 ? buf.lastIndexOf("startxref", at - 1) : -1) {
    const m = /^startxref\s+(\d+)/.exec(buf.subarray(at, at + 40).toString("latin1"));
    if (m) return Number(m[1]);
  }
  throw new Error("PDF sin startxref");
}

/** Agrega `ref` al array `key` de `dict` (directo o indirecto) y marca lo que haya que reescribir. */
function appendToArray(u: IncrementalUpdate, ownerRef: PDFRef, dict: PDFDict, key: string, ref: PDFRef) {
  const raw = dict.get(PDFName.of(key));
  if (raw instanceof PDFRef) {
    const arr = u.context.lookup(raw, PDFArray);
    arr.push(ref);
    u.touch(raw);
  } else if (raw instanceof PDFArray) {
    raw.push(ref);
    u.touch(ownerRef);
  } else {
    dict.set(PDFName.of(key), u.context.obj([ref]));
    u.touch(ownerRef);
  }
}

export interface IncrementalSignatureOptions {
  /** "Sig" (CAdES) o "DocTimeStamp" (sello de documento RFC 3161). */
  type: "Sig" | "DocTimeStamp";
  fieldName: string;
  /** Bytes reservados para la firma (en binario; el hex ocupa el doble). */
  signatureLength?: number;
  reason?: string;
  name?: string;
  location?: string;
  contactInfo?: string;
  /** Rectángulo del widget en la primera página. Por defecto invisible ([0,0,0,0]). */
  widgetRect?: [number, number, number, number];
  /** Operadores PDF de la apariencia visible (solo con widgetRect de área no nula). */
  appearance?: string;
  /** Recibe los bytes cubiertos por el ByteRange y devuelve el CMS (o el TimeStampToken) en DER. */
  sign: (content: Uint8Array) => Promise<Uint8Array>;
}

/** Agrega una firma (o un sello de documento) como revisión incremental, sin alterar las anteriores. */
export async function addSignatureIncremental(pdf: Uint8Array, o: IncrementalSignatureOptions): Promise<Uint8Array> {
  const p = await buildSignaturePlaceholderIncremental(pdf, o);
  return signPlaceholder(p.pdf, p.placeholder, p.from, o.sign);
}

export interface IncrementalPlaceholder {
  /** El PDF con la revisión nueva (ByteRange y Contents vacíos). */
  pdf: Uint8Array;
  /** Nombre aleatorio del placeholder del ByteRange (ver placeholder.ts). */
  placeholder: string;
  /** Dónde empieza la revisión nueva: el placeholder se busca solo desde ahí. */
  from: number;
}

/**
 * Revisión incremental con el campo de firma y el placeholder (ByteRange y Contents vacíos), sin firmar.
 * Base de la firma en dos pasos (firma remota: el firmante firma un hash en su dispositivo).
 */
export async function buildSignaturePlaceholderIncremental(
  pdf: Uint8Array,
  o: Omit<IncrementalSignatureOptions, "sign">,
): Promise<IncrementalPlaceholder> {
  const u = await IncrementalUpdate.open(pdf);
  const ctx = u.context;
  const placeholder = newByteRangePlaceholder();
  const byteRange = ctx.obj([0, PDFName.of(placeholder), PDFName.of(placeholder), PDFName.of(placeholder)]);
  const sigFields: Record<string, PDFObject> = {
    Type: PDFName.of(o.type),
    Filter: PDFName.of("Adobe.PPKLite"),
    SubFilter: PDFName.of(o.type === "DocTimeStamp" ? SUBFILTER_RFC3161 : SUBFILTER_ETSI_CADES_DETACHED),
    ByteRange: byteRange,
    Contents: PDFHexString.of("0".repeat((o.signatureLength ?? 24_000) * 2)),
  };
  if (o.type === "Sig") {
    sigFields.M = PDFString.fromDate(new Date());
    if (o.reason) sigFields.Reason = PDFString.of(o.reason);
    if (o.name) sigFields.Name = PDFString.of(o.name);
    if (o.location) sigFields.Location = PDFString.of(o.location);
    if (o.contactInfo) sigFields.ContactInfo = PDFString.of(o.contactInfo);
  }
  const sigDict = ctx.obj({}) as PDFDict;
  for (const [k, v] of Object.entries(sigFields)) sigDict.set(PDFName.of(k), v);
  const sigRef = u.add(sigDict);

  const page = u.doc.getPages()[0];
  const rect = o.widgetRect ?? [0, 0, 0, 0];
  const widget = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    Rect: rect,
    V: sigRef,
    T: PDFString.of(o.fieldName),
    F: 132,
    P: page.ref,
  }) as PDFDict;
  const [x1, y1, x2, y2] = rect;
  if (o.appearance && Math.abs(x2 - x1) > 0 && Math.abs(y2 - y1) > 0) {
    const ap = u.add(ctx.flateStream(o.appearance, { Type: "XObject", Subtype: "Form", BBox: [0, 0, Math.abs(x2 - x1), Math.abs(y2 - y1)] }));
    widget.set(PDFName.of("AP"), ctx.obj({ N: ap }));
  }
  const widgetRef = u.add(widget);
  appendToArray(u, page.ref, page.node, "Annots", widgetRef);

  const catalog = u.doc.catalog;
  const acro = catalog.get(PDFName.of("AcroForm"));
  if (acro instanceof PDFRef) {
    const acroDict = ctx.lookup(acro, PDFDict);
    appendToArray(u, acro, acroDict, "Fields", widgetRef);
    acroDict.set(PDFName.of("SigFlags"), PDFNumber.of(3));
    u.touch(acro);
  } else if (acro instanceof PDFDict) {
    appendToArray(u, u.catalogRef, acro, "Fields", widgetRef);
    acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));
    u.touch(u.catalogRef);
  } else {
    catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [widgetRef], SigFlags: 3 }));
    u.touch(u.catalogRef);
  }

  return { pdf: u.serialize(), placeholder, from: pdf.length };
}

/** Material de validación para el diccionario DSS (DER). */
export interface DssData {
  certs: Uint8Array[];
  ocsps: Uint8Array[];
  crls: Uint8Array[];
}

/** Agrega (o amplía) el /DSS del catálogo como revisión incremental. */
export async function addDssIncremental(pdf: Uint8Array, data: DssData): Promise<Uint8Array> {
  const u = await IncrementalUpdate.open(pdf);
  const ctx = u.context;
  const catalog = u.doc.catalog;
  const prev = catalog.lookupMaybe(PDFName.of("DSS"), PDFDict);
  const existing = (key: string) => {
    const arr = prev?.lookupMaybe(PDFName.of(key), PDFArray);
    return arr ? arr.asArray() : [];
  };
  // Lo que ya está en el DSS no se vuelve a agregar: cada renovación de archivo (B-LTA) sumaba otra copia de toda la
  // cadena.
  const already = (refs: PDFObject[]) => {
    const keys = new Set<string>();
    for (const r of refs) {
      try {
        const s = ctx.lookup(r);
        if (s instanceof PDFRawStream) keys.add(Buffer.from(decodePDFRawStream(s).decode()).toString("base64"));
      } catch {
        // stream ilegible: no cuenta como presente
      }
    }
    return keys;
  };
  const section = (key: string, list: Uint8Array[]) => {
    const prevRefs = existing(key);
    const have = already(prevRefs);
    const fresh = dedupe(list).filter((b) => !have.has(Buffer.from(b).toString("base64")));
    return [...prevRefs, ...fresh.map((b) => u.add(ctx.flateStream(b)))];
  };
  const dss = ctx.obj({
    Type: "DSS",
    Certs: section("Certs", data.certs),
    OCSPs: section("OCSPs", data.ocsps),
    CRLs: section("CRLs", data.crls),
  }) as PDFDict;
  // Los datos por firma (/VRI) de un DSS anterior se conservan.
  const vri = prev?.get(PDFName.of("VRI"));
  if (vri) dss.set(PDFName.of("VRI"), vri);
  catalog.set(PDFName.of("DSS"), u.add(dss));
  u.touch(u.catalogRef);
  return u.serialize();
}

function dedupe(list: Uint8Array[]): Uint8Array[] {
  const seen = new Set<string>();
  return list.filter((b) => {
    const k = Buffer.from(b).toString("base64");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
