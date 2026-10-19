// Origen de un PDF que llega dentro de un pedido JSON: base64 o una URL pública (con protección SSRF).
// Lo usan POST /v1/envelopes (sobre completo en una llamada) y la herramienta create_envelope del MCP.
import { config } from "../config";
import { safeRequest } from "./webhooks";

export class PdfSourceError extends Error {
  constructor(
    readonly code: "invalid_base64" | "not_a_pdf" | "file_too_large" | "invalid_url" | "download_failed",
    message: string,
  ) {
    super(message);
  }
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** Como la subida de la API: el encabezado %PDF- puede estar en el primer KB (hay PDFs con bytes antes). */
export function looksLikePdf(buf: Uint8Array) {
  return Buffer.from(buf.buffer, buf.byteOffset, Math.min(buf.length, 1024)).indexOf("%PDF-") !== -1;
}

/** Largo máximo del base64 de un PDF de `maxBytes`: con el prefijo data: y saltos de línea cada 76 caracteres (MIME). */
export function maxBase64Length(maxBytes: number) {
  return Math.ceil((maxBytes * 4) / 3) + Math.ceil((maxBytes * 4) / 3 / 76) * 2 + 64;
}

export function decodePdfBase64(b64: string, maxBytes = config.maxUploadBytes): Buffer {
  if (b64.length > maxBase64Length(maxBytes)) throw new PdfSourceError("file_too_large", `el PDF supera ${mb(maxBytes)}`);
  const clean = b64.replace(/^data:application\/pdf;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) throw new PdfSourceError("invalid_base64", "base64 inválido");
  const buf = Buffer.from(clean, "base64");
  if (buf.length > maxBytes) throw new PdfSourceError("file_too_large", `el PDF supera ${mb(maxBytes)}`);
  if (!looksLikePdf(buf)) throw new PdfSourceError("not_a_pdf", "el contenido no es un PDF");
  return buf;
}

/** Descarga un PDF de una URL pública: solo https, sin redirecciones, con tope de tamaño y sin destinos internos (SSRF). */
export async function fetchPdf(url: string, maxBytes = config.maxUploadBytes): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new PdfSourceError("invalid_url", "URL inválida");
  }
  if (u.protocol !== "https:" && !(config.environment === "local" && u.protocol === "http:")) throw new PdfSourceError("invalid_url", "la URL tiene que ser https");
  if (u.username || u.password) throw new PdfSourceError("invalid_url", "la URL no puede llevar credenciales");
  let r;
  try {
    r = await safeRequest(url, { method: "GET", headers: { accept: "application/pdf" }, timeoutMs: 20_000, maxBytes });
  } catch (e) {
    if (/demasiado grande/.test(String((e as Error).message))) throw new PdfSourceError("file_too_large", `el PDF supera ${mb(maxBytes)}`);
    throw new PdfSourceError("download_failed", `no se pudo descargar (${(e as Error).message})`);
  }
  if (r.status >= 300 && r.status < 400) throw new PdfSourceError("download_failed", "la URL redirige: pasá la URL final del PDF");
  if (r.status !== 200) throw new PdfSourceError("download_failed", `la URL respondió HTTP ${r.status}`);
  if (!looksLikePdf(r.body)) throw new PdfSourceError("not_a_pdf", "lo descargado no es un PDF");
  return r.body;
}

/** Nombre de archivo a partir del final de una URL (sin la query), o null. */
export function fileNameFromUrl(url: string): string | null {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").trim();
    return last ? last.slice(0, 200) : null;
  } catch {
    return null;
  }
}
