// Tope para leer el texto de un PDF con pdf.js (extractPdfText, extractPdfPlainText, findTextAnchors).
// pdf.js descomprime entero cada stream que lee al extraer texto (contenido de página, formularios, fuentes, CMaps)
// sin ningún tope, y corre en el mismo hilo que la API: un PDF de 500 KB con un stream de contenido muy comprimido
// tardaba un minuto y ocupaba casi 1 GB, con la API sin responder a nadie mientras tanto. Antes de abrirlo con pdf.js
// se descomprimen esos streams con un tope total (zlib con maxOutputLength, que corta sin reservar la memoria).
import { constants, inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, type PDFObject } from "pdf-lib";
import { InvalidPdfError } from "./inspect";
import { DecodeBudgetError, structureWithinBudget, withDecodeBudget } from "./stream-budget";

/** Total descomprimido admitido para los streams que pdf.js lee al extraer el texto. */
export const MAX_TEXT_STREAM_BYTES = 48 * 1024 * 1024;

const FLATE = new Set(["FlateDecode", "Fl"]);
const HEX = new Set(["ASCIIHexDecode", "AHx"]);
const A85 = new Set(["ASCII85Decode", "A85"]);

/**
 * Bytes que pdf.js descomprimiría al extraer el texto, o null si superan el tope o no se pueden acotar (cifrado,
 * filtros como LZW o RunLength en un stream que no es imagen, filtros indirectos que no resuelven a nombres).
 * Las imágenes no se cuentan: pdf.js no las decodifica para el texto. Un stream que es contenido de una página sí se
 * cuenta aunque su diccionario diga /Subtype /Image (pdf.js lo decodifica igual).
 */
export async function textStreamBytes(pdf: Uint8Array, budget = MAX_TEXT_STREAM_BYTES): Promise<number | null> {
  if (!structureWithinBudget(pdf)) return null;
  let doc: PDFDocument;
  try {
    // Con el tope de descompresión dentro de pdf-lib (como inspectPdf): el chequeo de arriba no ve los streams de
    // objetos con /Type o /Filter indirectos.
    doc = await withDecodeBudget(() => PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true }));
  } catch (e) {
    if (e instanceof DecodeBudgetError) return null;
    return 0; // ilegible para pdf-lib: lo decide pdf.js (que en general tampoco lo abre)
  }
  if (doc.isEncrypted) return null; // lo descifrado no se puede medir sin descifrar
  const ctx = doc.context;
  const contentRefs = new Set<string>();
  for (const page of doc.getPages()) {
    const raw = page.node.get(PDFName.of("Contents"));
    const resolved = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
    const refs = resolved instanceof PDFArray ? resolved.asArray() : [raw];
    for (const r of refs) if (r instanceof PDFRef) contentRefs.add(r.tag);
  }
  let used = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const subtype = obj.dict.lookup(PDFName.of("Subtype"));
    if (subtype instanceof PDFName && subtype.decodeText() === "Image" && !contentRefs.has(ref.tag)) continue;
    const rawFilter = obj.dict.get(PDFName.of("Filter"));
    const filters = filterNames(rawFilter instanceof PDFRef ? ctx.lookup(rawFilter) : rawFilter, ctx);
    if (filters === null) return null;
    let data: Uint8Array = obj.contents;
    for (const f of filters) {
      const room = budget - used;
      if (room <= 0) return null;
      if (FLATE.has(f)) {
        try {
          data = inflateSync(data, { maxOutputLength: room, finishFlush: constants.Z_SYNC_FLUSH });
        } catch (e) {
          if (e instanceof RangeError) return null; // superó el tope
          data = new Uint8Array(0); // datos dañados: pdf.js tampoco saca nada
          break;
        }
      } else if (HEX.has(f)) data = asciiHex(data);
      else if (A85.has(f)) {
        const d85 = ascii85(data, room);
        if (!d85) return null;
        data = d85;
      }
      else return null; // LZW, RunLength, filtros de imagen en un stream que no es imagen, etc.: no se acota
    }
    used += data.length;
    if (used > budget) return null;
  }
  return used;
}

/** Lanza InvalidPdfError si leer el texto del PDF con pdf.js superaría el tope. */
export async function assertTextReadable(pdf: Uint8Array) {
  if ((await textStreamBytes(pdf)) === null) {
    throw new InvalidPdfError("unreadable", "El PDF es demasiado pesado para leer su texto");
  }
}

function filterNames(v: PDFObject | undefined, ctx: PDFDocument["context"]): string[] | null {
  if (v === undefined) return [];
  if (v instanceof PDFName) return [v.decodeText()];
  if (v instanceof PDFArray) {
    const out: string[] = [];
    for (const item of v.asArray()) {
      const n = item instanceof PDFRef ? ctx.lookup(item) : item;
      if (!(n instanceof PDFName)) return null;
      out.push(n.decodeText());
    }
    return out;
  }
  return null;
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out = new Uint8Array((data.length >> 1) + 1); // nunca más de la mitad de la entrada
  let n = 0;
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break; // '>'
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out[n++] = (hi << 4) | v;
      hi = -1;
    }
  }
  if (hi >= 0) out[n++] = hi << 4;
  return out.subarray(0, n);
}

/** Decodifica ASCII85 sin pasar de `max` bytes ('z' son 4 bytes por carácter); null si los superaría. */
function ascii85(data: Uint8Array, max: number): Uint8Array | null {
  const out = new Uint8Array(Math.min(data.length * 4 + 4, max + 4));
  let n = 0;
  const group: number[] = [];
  const put = (v: number, k: number) => {
    for (let j = 0; j < k; j++) out[n++] = (v >>> (24 - 8 * j)) & 255;
  };
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // "<~"
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // "~>"
    if (n + 4 > max) return null;
    if (c === 0x7a && group.length === 0) {
      put(0, 4); // 'z'
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      put(v, 4);
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const k = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    put(v, k - 1);
  }
  return out.subarray(0, n);
}
