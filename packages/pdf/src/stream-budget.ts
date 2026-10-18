// Tope de memoria al cargar un PDF de afuera. pdf-lib descomprime enteros los streams de objetos (ObjStm) al cargar el
// documento, y el análisis de revisiones descomprime los de referencias (XRef). Un archivo chico con un stream muy
// comprimido puede ocupar gigabytes al descomprimirse y dejar sin memoria al proceso. Antes de cargarlo, se descomprimen
// esos streams con un tope total (zlib con maxOutputLength, que corta sin reservar la memoria).
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
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

// ─── Tope dentro de pdf-lib ───
// El chequeo de arriba lee el PDF con expresiones regulares y no ve lo que pdf-lib resuelve al cargarlo: un /Type o un
// /Filter indirectos (`/Type 5 0 R` con 5 = /ObjStm) o un string con "obj" dentro del diccionario lo esquivaban, y
// un archivo de 700 KB llevaba el proceso a 1,4 GB. Por eso el tope real va donde pdf-lib descomprime: todos sus filtros
// (Flate, LZW, RunLength, ASCII85, ASCIIHex) crecen su buffer con DecodeStream.ensureBuffer.

/** Descompresión total admitida en una operación sobre un PDF de afuera (carga, análisis de revisiones, validación). */
export const MAX_DECODED_BYTES = 192 * 1024 * 1024;
/** Fuera de una operación con tope: ningún stream individual puede descomprimirse por encima de esto. */
export const MAX_DECODED_STREAM_BYTES = 256 * 1024 * 1024;

export class DecodeBudgetError extends Error {
  constructor() {
    super("el PDF tiene una estructura demasiado grande para procesarlo");
  }
}

interface Budget {
  remaining: number;
  exceeded: boolean;
}
const budgets = new AsyncLocalStorage<Budget>();

// El mismo módulo que carga `import "pdf-lib"` en Node (el paquete no tiene "exports": Node usa cjs/index.js).
const require = createRequire(import.meta.url);
type Decoder = { buffer: Uint8Array; minBufferLength: number };
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream").default as {
  prototype: { ensureBuffer(this: Decoder, requested: number): Uint8Array; __calasignBudget?: true };
};
if (!DecodeStream.prototype.__calasignBudget) {
  const ensureBuffer = DecodeStream.prototype.ensureBuffer;
  DecodeStream.prototype.ensureBuffer = function (this: Decoder, requested: number) {
    const have = this.buffer.byteLength;
    if (requested > have) {
      // Lo que va a reservar: la primera potencia de 2 (desde minBufferLength) que alcanza `requested`.
      let size = this.minBufferLength || 512;
      while (size < requested) size *= 2;
      const b = budgets.getStore();
      if (b) {
        b.remaining -= size - have;
        if (b.remaining < 0) {
          b.exceeded = true;
          throw new DecodeBudgetError();
        }
      } else if (size > MAX_DECODED_STREAM_BYTES) {
        throw new DecodeBudgetError();
      }
    }
    return ensureBuffer.call(this, requested);
  };
  DecodeStream.prototype.__calasignBudget = true;
}

/**
 * Corre `fn` con un tope total de descompresión. pdf-lib a veces atrapa el error de un objeto que no puede leer y sigue
 * (recupera el documento sin ese objeto): por eso, si el tope se superó en cualquier momento, el resultado se descarta.
 * Anidado, usa el tope de la operación de afuera.
 */
export async function withDecodeBudget<T>(fn: () => Promise<T>, budget = MAX_DECODED_BYTES): Promise<T> {
  if (budgets.getStore()) return fn();
  const b: Budget = { remaining: budget, exceeded: false };
  let out: T;
  try {
    out = await budgets.run(b, fn);
  } catch (e) {
    if (b.exceeded) throw new DecodeBudgetError();
    throw e;
  }
  if (b.exceeded) throw new DecodeBudgetError();
  return out;
}
