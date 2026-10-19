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

/** Toma un PDF para mostrarlo; devolverlo con releasePdf al dejar de usarlo. */
export function acquirePdf(url: string): Promise<PDFDocumentProxy> {
  users.set(url, (users.get(url) ?? 0) + 1);
  return loadPdf(url);
}

/**
 * Sin tope, cada PDF abierto en la sesión (cada sobre, plantilla o documento del firmante) quedaba cargado en el worker
 * de pdf.js hasta recargar la página. Se liberan los más viejos que ninguna vista usa.
 */
export function releasePdf(url: string) {
  const n = (users.get(url) ?? 0) - 1;
  if (n > 0) users.set(url, n);
  else users.delete(url);
  const idle = [...cache.keys()].filter((u) => !users.has(u));
  for (const u of idle.slice(0, Math.max(0, idle.length - MAX_IDLE))) {
    const p = cache.get(u);
    cache.delete(u);
    p?.then((d) => d.destroy()).catch(() => undefined);
  }
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

export function forgetPdf(url: string) {
  cache.delete(url);
}
