// Metadatos de las fotos de identidad: se quitan antes de cifrarlas y guardarlas. Una foto de celular trae en EXIF la
// ubicación GPS, el modelo del equipo y la hora; nada de eso hace falta para verificar la identidad.
//   - JPEG: segmentos APP1 (EXIF / XMP), APP13 (IPTC / Photoshop) y comentarios (COM). Se conservan APP0 (JFIF),
//     APP2 (perfil ICC) y APP14 (Adobe), que afectan cómo se ven los colores. Del EXIF queda solo la orientación (un
//     APP1 mínimo con el tag Orientation): sin ella una foto de celular tomada en vertical se ve acostada y el
//     proveedor o quien revisa la ve girada. Las imágenes secundarias MPF (miniaturas, profundidad, la «otra» foto de
//     algunos celulares) van después del EOI de la principal, cada una con su propio EXIF: se descarta todo lo que
//     sigue al primer EOI, y el APP2 MPF que las indexa.
//   - PNG: chunks eXIf, tEXt, zTXt, iTXt y tIME.

const JPEG_DROP = new Set([0xe1, 0xed, 0xfe]);
const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");
const MPF_HEADER = Buffer.from("MPF\0", "latin1");
const ORIENTATION_TAG = 0x0112;

/** Orientación (1-8) del EXIF de un segmento APP1 (`seg` = datos del segmento, sin marcador ni longitud), o null. */
export function exifOrientation(seg: Buffer): number | null {
  if (seg.length < EXIF_HEADER.length + 8 || !seg.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER)) return null;
  const t = seg.subarray(EXIF_HEADER.length);
  const order = t.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) return null;
    // SHORT (3), un valor: va en los primeros 2 bytes del campo de valor.
    if (u16(e) === ORIENTATION_TAG && u16(e + 2) === 3 && u32(e + 4) === 1) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** Segmento APP1 EXIF mínimo (marcador incluido) con solo el tag Orientation. */
export function minimalExifSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0
  tiff.writeUInt16BE(1, 8); // una entrada
  tiff.writeUInt16BE(ORIENTATION_TAG, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22); // sin IFD siguiente
  const len = Buffer.alloc(2);
  len.writeUInt16BE(2 + EXIF_HEADER.length + tiff.length);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), len, EXIF_HEADER, tiff]);
}

/** Desde el inicio de los datos de imagen: hasta el primer EOI inclusive (lo que sigue son imágenes secundarias MPF). */
function untilFirstEoi(b: Buffer, from: number): Buffer {
  // En los datos comprimidos un 0xFF va seguido de 0x00 (relleno) o de un RSTn: FF D9 solo puede ser el EOI.
  const eoi = b.indexOf(Buffer.from([0xff, 0xd9]), from);
  return eoi < 0 ? b.subarray(from) : b.subarray(from, eoi + 2);
}
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class InvalidImageError extends Error {}

function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let pos = 2;
  let keptOrientation = false;
  while (pos < b.length) {
    if (b[pos] !== 0xff) throw new InvalidImageError("JPEG mal formado");
    // Bytes de relleno 0xFF antes del marcador.
    let m = pos + 1;
    while (m < b.length && b[m] === 0xff) m++;
    if (m >= b.length) throw new InvalidImageError("JPEG mal formado");
    const marker = b[m];
    // Inicio de los datos de imagen (o fin): el resto se copia tal cual.
    if (marker === 0xda || marker === 0xd9) {
      out.push(Buffer.from([0xff]), untilFirstEoi(b, m));
      return Buffer.concat(out);
    }
    // Marcadores sin longitud.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(Buffer.from([0xff, marker]));
      pos = m + 1;
      continue;
    }
    if (m + 3 > b.length) throw new InvalidImageError("JPEG mal formado");
    const len = b.readUInt16BE(m + 1);
    const end = m + 1 + len;
    if (len < 2 || end > b.length) throw new InvalidImageError("JPEG mal formado");
    const data = b.subarray(m + 3, end);
    if (marker === 0xe1 && !keptOrientation) {
      // EXIF: se reemplaza por uno mínimo con solo la orientación (si la tiene y no es la normal).
      const o = exifOrientation(data);
      if (o !== null && o !== 1) {
        out.push(minimalExifSegment(o));
        keptOrientation = true;
      }
    } else if (marker === 0xe2 && data.subarray(0, MPF_HEADER.length).equals(MPF_HEADER)) {
      // Índice MPF de las imágenes secundarias, que se descartan.
    } else if (!JPEG_DROP.has(marker)) out.push(Buffer.from([0xff]), b.subarray(m, end));
    pos = end;
  }
  throw new InvalidImageError("JPEG sin datos de imagen");
}

function stripPng(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 8)];
  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString("latin1", pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > b.length) throw new InvalidImageError("PNG mal formado");
    if (!PNG_DROP.has(type)) out.push(b.subarray(pos, end));
    pos = end;
    if (type === "IEND") return Buffer.concat(out);
  }
  throw new InvalidImageError("PNG sin IEND");
}

/** Devuelve la imagen (JPEG o PNG) sin metadatos. Lanza InvalidImageError si la estructura no se puede recorrer. */
export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return new Uint8Array(stripJpeg(b));
  if (b.subarray(0, 8).equals(PNG_SIG)) return new Uint8Array(stripPng(b));
  throw new InvalidImageError("se esperaba JPEG o PNG");
}
