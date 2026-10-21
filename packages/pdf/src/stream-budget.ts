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

/** Hasta dónde se busca hacia atrás el "obj" que abre el diccionario de un stream. */
const DICT_WINDOW = 8 * 1024;
/**
 * Streams de objetos/referencias comprimidos admitidos: 4096, o uno por KB del archivo si es más (un PDF grande y
 * legítimo puede tener muchos; lo descomprimido y lo leído siguen acotados por sus propios topes). Cada descompresión
 * tiene un costo fijo de ~50–130 µs en el hilo: con uno cada 200 bytes, un archivo de 25 MB armado con streams
 * diminutos bloqueaba ~17 s; con uno por KB, ~3 s (antes del tope fijo, 0,5 s).
 */
const MIN_STRUCTURE_STREAMS = 4096;
const BYTES_PER_STRUCTURE_STREAM = 1024;
// Espacio en blanco (PDF y lo que \s aceptaba en latin1).
const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0x00 || c === 0xa0;

/** true si los streams estructurales del PDF entran en el tope. */
export function structureWithinBudget(pdf: Uint8Array, budget = MAX_STRUCTURE_BYTES): boolean {
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  let remaining = budget;
  // Lineal en el tamaño del archivo: cada "stream" mira hacia atrás a lo sumo DICT_WINDOW bytes, y lo leído en total
  // (búsquedas y diccionarios) tiene un tope proporcional al archivo. Un PDF real lee cada diccionario una vez; uno
  // armado con miles de "stream" seguidos (antes, cuadrático: 1 MB tardaba 30 s) agota el tope y se rechaza.
  let work = 4 * buf.length + 1024 * 1024;
  let streams = 0;
  const maxStreams = Math.max(MIN_STRUCTURE_STREAMS, Math.floor(buf.length / BYTES_PER_STRUCTURE_STREAM));
  for (let at = buf.indexOf("stream"); at >= 0; at = buf.indexOf("stream", at + 6)) {
    // "endstream" no abre un stream.
    if (at >= 3 && buf[at - 3] === 0x65 && buf[at - 2] === 0x6e && buf[at - 1] === 0x64) continue;
    // Entre ">>" y "stream" solo puede haber espacio (lo recorrido no se solapa con el de otro "stream").
    let i = at;
    while (i > 0 && isSpace(buf[i - 1])) i--;
    if (i < 2 || buf[i - 1] !== 0x3e || buf[i - 2] !== 0x3e) continue;
    const dictEnd = i - 2;
    let from = Math.max(0, dictEnd - DICT_WINDOW);
    let rel = buf.subarray(from, dictEnd).lastIndexOf("obj");
    work -= rel < 0 ? dictEnd - from : dictEnd - from - rel;
    if (work < 0) return false;
    if (rel < 0) {
      // Sin "obj" en la ventana: si ahí ya se ve un /ObjStm o /XRef (un diccionario relleno para que el encabezado
      // quede fuera de la ventana), se sigue buscando hacia atrás con lo que queda del tope de lectura; sin encontrarlo,
      // se rechaza. Si no, no es un stream estructural.
      if (!/\/(ObjStm|XRef)\b/.test(decodeNames(buf.toString("latin1", from, dictEnd)))) continue;
      while (rel < 0 && from > 0) {
        const end = Math.min(dictEnd, from + 2); // solapa 2 bytes: un "obj" partido entre dos tramos
        from = Math.max(0, from - DICT_WINDOW);
        const r = buf.subarray(from, end).lastIndexOf("obj");
        work -= r < 0 ? end - from : end - from - r;
        if (work < 0) return false;
        rel = r;
      }
      if (rel < 0) return false;
    }
    const dictStart = from + rel;
    const dict = decodeNames(buf.toString("latin1", dictStart, dictEnd + 2));
    if (!/\/Type\s*\/(ObjStm|XRef)\b/.test(dict)) continue;
    const filters = [...dict.matchAll(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/g)].map((m) => m[1]).join(" ");
    const names = filters.match(/\/[A-Za-z0-9]+/g) ?? [];
    if (names.length === 0) continue; // sin filtro: ocupa lo que ocupa en el archivo
    // Solo FlateDecode (lo que usan los generadores reales); otro filtro no se puede acotar acá.
    if (names.some((n) => n !== "/FlateDecode" && n !== "/Fl")) return false;
    if (++streams > maxStreams) return false;
    let dataStart = at + 6;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    // Sin encabezado zlib válido zlib falla enseguida: datos dañados, lo decide quien carga el PDF.
    if (dataStart + 1 >= buf.length || (buf[dataStart] & 0x0f) !== 8 || ((buf[dataStart] << 8) | buf[dataStart + 1]) % 31 !== 0) continue;
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

// ─── Decodificación de un filtro con tope propio (sincrónica) ───

type DecoderStream = Decoder & { bufferLength: number; getBytes(): Uint8Array };
const stream = (name: string) => require(`pdf-lib/cjs/core/streams/${name}`).default;
const Stream = stream("Stream") as new (data: Uint8Array) => unknown;
const DECODERS: Record<string, (s: unknown, earlyChange: number) => DecoderStream> = {
  Flate: (s) => new (stream("FlateStream"))(s),
  LZW: (s, early) => new (stream("LZWStream"))(s, undefined, early),
  ASCII85: (s) => new (stream("Ascii85Stream"))(s),
  ASCIIHex: (s) => new (stream("AsciiHexStream"))(s),
  RunLength: (s) => new (stream("RunLengthStream"))(s),
};
export type CappedFilter = keyof typeof DECODERS;

/**
 * Decodifica `data` con un filtro de pdf-lib (sin predictores: pdf-lib no los aplica) y un tope propio de `max` bytes
 * de salida, que no se suma al de la operación de afuera (lo que reserva queda acotado por `max`). Si los datos están
 * dañados devuelve lo decodificado hasta el error, como hacen los lectores (pdf.js dibuja lo que pudo leer). `null` si
 * supera el tope o si el filtro no arranca (encabezado inválido).
 */
export function decodeFilterCapped(filter: CappedFilter, data: Uint8Array, max: number, earlyChange = 1): Uint8Array | null {
  // ensureBuffer reserva en potencias de 2: el total reservado es a lo sumo el doble de lo decodificado.
  const b: Budget = { remaining: 2 * max + 1024, exceeded: false };
  return budgets.run(b, () => {
    let dec: DecoderStream;
    try {
      dec = DECODERS[filter](new Stream(data), earlyChange);
    } catch {
      return null;
    }
    let out: Uint8Array;
    try {
      out = dec.getBytes();
    } catch {
      if (b.exceeded) return null;
      out = dec.buffer.subarray(0, dec.bufferLength); // datos dañados: lo leído hasta el error
    }
    return b.exceeded || out.length > max ? null : out;
  });
}
