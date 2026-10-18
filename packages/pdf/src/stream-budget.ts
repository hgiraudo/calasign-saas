// Tope de memoria al cargar un PDF de afuera. pdf-lib descomprime enteros los streams de objetos (ObjStm) al cargar el
// documento, y el análisis de revisiones descomprime los de referencias (XRef). Un archivo chico con un stream muy
// comprimido puede ocupar gigabytes al descomprimirse y dejar sin memoria al proceso. Antes de cargarlo, se descomprimen
// esos streams con un tope total (zlib con maxOutputLength, que corta sin reservar la memoria).
import { constants, inflateSync } from "node:zlib";

/** Total descomprimido admitido para los streams de objetos y de referencias de un PDF. */
export const MAX_STRUCTURE_BYTES = 128 * 1024 * 1024;

const decodeNames = (s: string) => s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** true si los streams estructurales del PDF entran en el tope. */
export function structureWithinBudget(pdf: Uint8Array, budget = MAX_STRUCTURE_BYTES): boolean {
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  let remaining = budget;
  for (let at = buf.indexOf("stream"); at >= 0; at = buf.indexOf("stream", at + 6)) {
    // "endstream" no abre un stream.
    if (at >= 3 && buf.toString("latin1", at - 3, at) === "end") continue;
    const dictEnd = buf.lastIndexOf(">>", at);
    if (dictEnd < 0 || /\S/.test(buf.toString("latin1", dictEnd + 2, at))) continue;
    const dictStart = buf.lastIndexOf("obj", dictEnd);
    if (dictStart < 0) continue;
    const dict = decodeNames(buf.toString("latin1", dictStart, dictEnd + 2));
    if (!/\/Type\s*\/(ObjStm|XRef)\b/.test(dict)) continue;
    const filters = [...dict.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/g)].map((m) => m[1]).join(" ");
    const names = filters.match(/\/[A-Za-z0-9]+/g) ?? [];
    if (names.length === 0) continue; // sin filtro: ocupa lo que ocupa en el archivo
    // Solo FlateDecode (lo que usan los generadores reales); otro filtro no se puede acotar acá.
    if (names.some((n) => n !== "/FlateDecode" && n !== "/Fl")) return false;
    let dataStart = at + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    try {
      // Hasta el final del archivo: zlib se detiene al terminar el stream comprimido.
      let out = buf.subarray(dataStart);
      for (let i = 0; i < names.length; i++) {
        out = inflateSync(out, { maxOutputLength: Math.max(1, remaining), finishFlush: constants.Z_SYNC_FLUSH });
      }
      remaining -= out.length;
    } catch (e) {
      if (e instanceof RangeError) return false; // superó el tope
      // Datos dañados: lo decide quien carga el PDF.
    }
    if (remaining <= 0) return false;
  }
  return true;
}
