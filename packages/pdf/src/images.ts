import { PDFDocument } from "pdf-lib";
// El decodificador que usa pdf-lib al incrustar (no se exporta en su índice): decodificar con él valida lo mismo que embedPng.
import { PNG } from "pdf-lib/cjs/utils/png.js";

/**
 * Tope de píxeles de un PNG. pdf-lib decodifica el PNG entero y reserva memoria según el ancho y alto de la cabecera,
 * no según los datos: un PNG de pocos KB que declara 16000×16000 reserva varios GB y tumba el proceso.
 */
export const MAX_PNG_PIXELS = 4096 * 4096;

/** Ancho y alto de la cabecera IHDR de un PNG (null si no es un PNG con IHDR). */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => bytes[i] === b)) return null;
  // IHDR es siempre el primer bloque: largo (4) + "IHDR" (4) + ancho (4) + alto (4).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** Lanza si el PNG no tiene cabecera válida o supera el tope de píxeles (antes de decodificarlo). */
export function assertPngSize(bytes: Uint8Array, maxPixels = MAX_PNG_PIXELS): void {
  const d = pngDimensions(bytes);
  if (!d || d.width === 0 || d.height === 0) throw new Error("PNG sin cabecera válida");
  if (d.width * d.height > maxPixels) throw new Error(`PNG demasiado grande (${d.width}×${d.height})`);
}

/**
 * Decodificaciones de PNG a la vez en este proceso: cada una puede ocupar ~200 MB y bloquear ~1 s (4096×4096); sin tope,
 * unos pocos firmantes subiendo imágenes a la vez juntaban GB en la API.
 */
const MAX_CONCURRENT_DECODES = 2;
let decoding = 0;
const waiting: (() => void)[] = [];
async function withDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  // Al terminar, el lugar pasa directo al siguiente en espera (sin liberarlo): así nadie se cuela entre medio.
  if (decoding >= MAX_CONCURRENT_DECODES) await new Promise<void>((r) => waiting.push(r));
  else decoding++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else decoding--;
  }
}

/** Verifica que una imagen PNG/JPG se pueda incrustar en un PDF (lanza si está dañada o es demasiado grande). */
export async function assertEmbeddableImage(bytes: Uint8Array, contentType: "image/png" | "image/jpeg", maxPixels = MAX_PNG_PIXELS): Promise<void> {
  const doc = await PDFDocument.create();
  if (contentType === "image/png") {
    assertPngSize(bytes, maxPixels);
    await withDecodeSlot(() => doc.embedPng(bytes).then(() => undefined));
  } else await doc.embedJpg(bytes);
}

/**
 * Decodifica un PNG (con el mismo tope de píxeles y de concurrencia que al incrustarlo) y cuenta los píxeles con tinta:
 * visibles (alfa ≥ 32: el borde suavizado de un trazo cuenta) y no casi blancos. Lanza si el PNG está dañado o es demasiado grande. Sirve para rechazar una
 * firma "adoptada" transparente, toda blanca o de un punto.
 */
/** Alfa mínimo de un píxel con tinta. La web (SignaturePad) cuenta igual antes de habilitar "Adoptar". */
export const INK_MIN_ALPHA = 32;

export async function pngInkPixels(bytes: Uint8Array, maxPixels = MAX_PNG_PIXELS): Promise<number> {
  assertPngSize(bytes, maxPixels);
  return withDecodeSlot(async () => {
    const png = PNG.load(bytes);
    const rgb = png.rgbChannel;
    const alpha = png.alphaChannel; // undefined si todos los píxeles son opacos
    let ink = 0;
    const n = png.width * png.height;
    for (let i = 0; i < n; i++) {
      if (alpha && alpha[i]! < INK_MIN_ALPHA) continue;
      if (rgb[i * 3]! > 240 && rgb[i * 3 + 1]! > 240 && rgb[i * 3 + 2]! > 240) continue;
      ink++;
    }
    return ink;
  });
}
