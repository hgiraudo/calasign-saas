// pdf.js: carga y render de páginas en el navegador.
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fetchArrayBuffer } from "./api";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

const cache = new Map<string, Promise<PDFDocumentProxy>>();
/** Vistas que usan cada PDF ahora: uno sin uso se conserva un rato (volver a abrirlo es instantáneo) pero no para siempre. */
const users = new Map<string, number>();
const MAX_IDLE = 6;
/** Olvidados (documento borrado) mientras una vista todavía los mostraba: se liberan cuando esa vista los devuelve. */
const doomed = new Set<string>();

function evict(url: string) {
  const p = cache.get(url);
  cache.delete(url);
  p?.then((d) => d.destroy()).catch(() => undefined);
}

/** Toma un PDF para mostrarlo; devolverlo con releasePdf al dejar de usarlo. */
export function acquirePdf(url: string): Promise<PDFDocumentProxy> {
  users.set(url, (users.get(url) ?? 0) + 1);
  // Al final del orden: se liberan primero los usados hace más tiempo, no los cargados primero (uno que se vuelve a
  // abrir seguido se descartaba igual por ser de los primeros cargados).
  const p = cache.get(url);
  if (p) {
    cache.delete(url);
    cache.set(url, p);
  }
  return loadPdf(url);
}

/**
 * Sin tope, cada PDF abierto en la sesión (cada sobre, plantilla o documento del firmante) quedaba cargado en el worker
 * de pdf.js hasta recargar la página. Se liberan los más viejos que ninguna vista usa.
 */
export function releasePdf(url: string) {
  const n = (users.get(url) ?? 0) - 1;
  if (n > 0) users.set(url, n);
  else {
    users.delete(url);
    if (doomed.delete(url)) evict(url);
  }
  const idle = [...cache.keys()].filter((u) => !users.has(u));
  for (const u of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) evict(u);
}

function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let p = cache.get(url);
  if (!p) {
    p = fetchArrayBuffer(url).then(
      (data) => pdfjsLib.getDocument({
        data: new Uint8Array(data),
        isEvalSupported: false,
        // Fuentes estándar y CMaps servidos por la propia app (ver vite.config.ts).
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
      }).promise,
    );
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

/**
 * Documento borrado: se libera ya si nadie lo muestra, o cuando lo devuelva la vista que todavía lo muestra. Antes solo
 * se sacaba del caché sin destroy(): quedaba cargado en el worker hasta recargar la página y releasePdf ya no lo veía.
 */
export function forgetPdf(url: string) {
  if (users.has(url)) doomed.add(url);
  else evict(url);
}
