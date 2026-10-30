// Lienzos de la firma: medir la tinta, recortar el margen y convertir una imagen subida en una firma (PNG con fondo
// transparente, del mismo tamaño que la dibujada). Lo usan el diálogo «Adoptá tu firma» y la página del celular.

/** Tamaño del lienzo de la firma dibujada (y tope de la importada y de la que llega del celular). */
export const SIG_W = 720;
export const SIG_H = 240;
/**
 * Mismo criterio que la API al recibir la imagen (packages/pdf pngInkPixels + SIGNATURE_MIN_INK_PIXELS en signing.ts):
 * píxeles con alfa ≥ 32 y no casi blancos, al menos 24. Un toque suelto no llega y la API lo rechazaba al finalizar.
 */
export const INK_MIN_ALPHA = 32;
export const MIN_INK_PIXELS = 24;
/** Tope del PNG que acepta la API (SIGNATURE_PNG_MAX_BYTES en signing.ts). */
export const SIGNATURE_PNG_MAX_BYTES = 700 * 1024;

/** Topes de la imagen importada: un archivo de foto de celular entra holgado; algo más grande no es una firma. */
export const IMPORT_MAX_MB = 10;
const IMPORT_MAX_BYTES = IMPORT_MAX_MB * 1024 * 1024;
/** Decodificar una imagen de 40 MP ocupa ~160 MB: más que eso puede tumbar el navegador de un celular. */
const IMPORT_MAX_PIXELS = 40_000_000;
const IMPORT_MAX_SIDE = 12_000;
export const IMPORT_MIN_W = 40;
export const IMPORT_MIN_H = 16;

/** Píxeles con tinta, como pngInkPixels en la API: alfa ≥ 32 y no casi blancos. */
export function inkPixels(c: HTMLCanvasElement): number {
  const ctx = c.getContext("2d");
  if (!ctx || !c.width || !c.height) return 0;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < INK_MIN_ALPHA) continue;
    if (d[i]! > 240 && d[i + 1]! > 240 && d[i + 2]! > 240) continue;
    ink++;
  }
  return ink;
}

/** Recorta el área transparente alrededor del trazo (con margen). null si el lienzo está vacío. */
export function trimCanvas(src: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = src.getContext("2d");
  if (!ctx) return src;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")?.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Copia del lienzo achicada para entrar en SIG_W × SIG_H (sin agrandar): la firma del celular o una foto grande. */
export function fitCanvas(src: HTMLCanvasElement, maxW = SIG_W, maxH = SIG_H): HTMLCanvasElement {
  const scale = Math.min(1, maxW / src.width, maxH / src.height);
  if (scale === 1) return src;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  const ctx = out.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, out.width, out.height);
  }
  return out;
}

/** PNG en base64 (sin prefijo) y data URL de un lienzo. */
export function canvasPng(c: HTMLCanvasElement): { dataUrl: string; imagePng: string } {
  const dataUrl = c.toDataURL("image/png");
  return { dataUrl, imagePng: dataUrl.split(",")[1] ?? "" };
}

/** Bytes que ocupa un base64 ya decodificado. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

export type ImportError =
  | { code: "format" }
  | { code: "tooLarge" }
  | { code: "dimensions"; w: number; h: number }
  | { code: "tooSmall" }
  | { code: "unreadable" }
  | { code: "blank" };

/** Tipo real por los primeros bytes (no por la extensión ni por el `type` que informa el navegador). */
function sniff(head: Uint8Array): "png" | "jpeg" | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => head[i] === b)) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  return null;
}

async function decode(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number; close: () => void }> {
  // createImageBitmap decodifica fuera del hilo principal donde existe; Safari < 15 no lo tiene con Blob.
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      return { img: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    } catch {
      // Sigue con <img>: algunos navegadores rechazan acá lo que <img> sí decodifica.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("decode"));
      img.src = url;
    });
    return { img, w: img.naturalWidth, h: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Convierte una imagen subida (PNG o JPG; nada de SVG, que puede traer scripts y no es una imagen de píxeles) en la
 * firma: la escala para que entre en el tamaño de la dibujada, la redibuja en un lienzo (eso descarta los metadatos:
 * EXIF, ubicación, cámara), quita el fondo claro de una foto o un escaneo (un papel blanco o gris se estamparía como un
 * rectángulo) y recorta el margen. Mide la tinta con el mismo criterio que la API.
 */
export async function signatureFromFile(file: File): Promise<{ ok: true; canvas: HTMLCanvasElement } | { ok: false; error: ImportError }> {
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, error: { code: "tooLarge" } };
  const kind = sniff(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  if (!kind) return { ok: false, error: { code: "format" } };
  let decoded;
  try {
    decoded = await decode(file);
  } catch {
    return { ok: false, error: { code: "unreadable" } };
  }
  try {
    const { w, h } = decoded;
    if (!w || !h) return { ok: false, error: { code: "unreadable" } };
    if (w * h > IMPORT_MAX_PIXELS || w > IMPORT_MAX_SIDE || h > IMPORT_MAX_SIDE) return { ok: false, error: { code: "dimensions", w, h } };
    if (w < IMPORT_MIN_W || h < IMPORT_MIN_H) return { ok: false, error: { code: "tooSmall" } };
    const scale = Math.min(1, SIG_W / w, SIG_H / h);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { ok: false, error: { code: "unreadable" } };
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.img, 0, 0, c.width, c.height);
    removeLightBackground(ctx, c.width, c.height);
    const trimmed = trimCanvas(c);
    if (!trimmed || inkPixels(trimmed) < MIN_INK_PIXELS) return { ok: false, error: { code: "blank" } };
    if (base64Bytes(canvasPng(trimmed).imagePng) > SIGNATURE_PNG_MAX_BYTES) return { ok: false, error: { code: "tooLarge" } };
    return { ok: true, canvas: trimmed };
  } finally {
    decoded.close();
  }
}

/**
 * Fondo de una imagen opaca (foto o escaneo de la firma en papel) → transparente. El fondo se estima como el tono
 * claro más común (percentil 85 de la luminancia: el papel ocupa casi toda la imagen); lo que está cerca de ese tono
 * se vuelve transparente, con un borde suave para que el trazo no quede serruchado. Una imagen que ya trae
 * transparencia (un PNG recortado) se deja como está.
 */
function removeLightBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  let transparent = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3]! < 250) transparent++;
    hist[luma(d, i * 4)]!++;
  }
  if (transparent > n * 0.01) return;
  let acc = 0;
  let bg = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    if (acc >= n * 0.85) {
      bg = v;
      break;
    }
  }
  // Un fondo oscuro (firma blanca sobre negro) no se toca: no hay un papel claro que quitar.
  if (bg < 110) return;
  const hard = bg - 70; // de acá para abajo, trazo opaco
  const soft = bg - 25; // de acá para arriba, fondo transparente
  for (let i = 0; i < n; i++) {
    const l = luma(d, i * 4);
    d[i * 4 + 3] = l >= soft ? 0 : l <= hard ? 255 : Math.round(((soft - l) / (soft - hard)) * 255);
  }
  ctx.putImageData(img, 0, 0);
}

const luma = (d: Uint8ClampedArray, o: number) => Math.round(0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]!);
