// Placeholder del ByteRange de una firma y su reemplazo. Reemplaza a @signpdf/signpdf y findByteRange, que buscan el
// placeholder por defecto (`/ByteRange [0 /********** /********** /**********]`) en TODO el archivo: esa secuencia
// literal en un content stream sin comprimir de un documento subido (o de un adjunto) hacía fallar el sellado para
// siempre ("Found multiple ByteRange placeholders"), o peor, que se escribiera el rango en el lugar equivocado.
// Acá el placeholder lleva un nombre aleatorio por firma y se busca solo desde `from` (en una revisión incremental, el
// largo del original: la región nueva).
import { randomBytes } from "node:crypto";

/** Nombre aleatorio (sin la barra) para los tres valores del placeholder del ByteRange. */
export function newByteRangePlaceholder(): string {
  return `CalaSignBR${randomBytes(8).toString("hex")}`;
}

export interface FilledByteRange {
  /** El PDF (sin saltos de línea finales) con el ByteRange real escrito y /Contents todavía vacío. */
  pdf: Buffer;
  byteRange: [number, number, number, number];
}

/** Escribe el ByteRange real en lugar del placeholder `placeholder` (único, a partir de `from`). */
export function fillByteRange(input: Uint8Array, placeholder: string, from = 0): FilledByteRange {
  let buf = Buffer.from(input);
  // Como @signpdf: sin salto final, el ByteRange cubre hasta el último byte.
  let end = buf.length;
  while (end > 0 && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end--;
  buf = buf.subarray(0, end);
  const name = `/${placeholder}`;
  const first = buf.indexOf(name, from, "latin1");
  if (first < 0) throw new Error("no se encontró el placeholder del ByteRange");
  const key = buf.lastIndexOf("/ByteRange", first, "latin1");
  const open = key < 0 ? -1 : buf.indexOf("[", key, "latin1");
  const close = open < 0 ? -1 : buf.indexOf("]", open, "latin1");
  if (key < from || open < 0 || close < 0 || !(open < first && first < close)) throw new Error("placeholder del ByteRange mal formado");
  const tokens = buf.toString("latin1", open + 1, close).split(/\s+/).filter(Boolean);
  if (tokens.join(" ") !== `0 ${name} ${name} ${name}`) throw new Error("placeholder del ByteRange mal formado");
  if (buf.indexOf(name, close, "latin1") >= 0) throw new Error("placeholder del ByteRange repetido");
  // /Contents va inmediatamente después del ByteRange en el diccionario de firma que armamos.
  const contentsTag = buf.indexOf("/Contents", close, "latin1");
  if (contentsTag < 0 || /\S/.test(buf.toString("latin1", close + 1, contentsTag))) throw new Error("no se encontró /Contents después del ByteRange");
  const lt = buf.indexOf("<", contentsTag, "latin1");
  const gt = lt < 0 ? -1 : buf.indexOf(">", lt, "latin1");
  if (lt < 0 || gt < 0 || /\S/.test(buf.toString("latin1", contentsTag + 9, lt))) throw new Error("placeholder de /Contents mal formado");
  const br: [number, number, number, number] = [0, lt, gt + 1, buf.length - (gt + 1)];
  const placeholderText = buf.toString("latin1", key, close + 1);
  const actual = `/ByteRange [${br.join(" ")}]`;
  if (actual.length > placeholderText.length) throw new Error("el ByteRange no entra en el placeholder");
  buf = Buffer.concat([buf.subarray(0, key), Buffer.from(actual.padEnd(placeholderText.length, " "), "latin1"), buf.subarray(close + 1)]);
  return { pdf: buf, byteRange: br };
}

/** Completa el ByteRange, firma lo cubierto con `sign` (devuelve el CMS o el token en DER) y lo escribe en /Contents. */
export async function signPlaceholder(
  input: Uint8Array,
  placeholder: string,
  from: number,
  sign: (content: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const { pdf, byteRange: br } = fillByteRange(input, placeholder, from);
  const content = new Uint8Array(Buffer.concat([pdf.subarray(0, br[1]), pdf.subarray(br[2])]));
  const der = await sign(content);
  const room = br[2] - br[1] - 2;
  if (der.length * 2 > room) throw new Error(`la firma no entra en el espacio reservado (${der.length * 2} > ${room})`);
  pdf.write(Buffer.from(der).toString("hex").padEnd(room, "0"), br[1] + 1, "latin1");
  return new Uint8Array(pdf);
}
