// pdf.js: carga y render de páginas en el navegador.
// Build "legacy" de pdf.js: la normal usa Promise.withResolvers y otras APIs recientes que no existen en Safari < 17.4
// (iOS 16) ni en Chrome < 119, donde ningún PDF se mostraba. Se carga aparte (import dinámico): solo la bajan las
// pantallas que muestran un PDF, no la consola ni las páginas públicas sin documento.
import type { PDFDocumentProxy } from "pdfjs-dist";
import { fetchArrayBuffer } from "./api";
import { reloadAfterDeploy } from "./deploy-reload";

export type { PDFDocumentProxy };
export type PdfJs = typeof import("pdfjs-dist");

let lib: Promise<PdfJs> | null = null;
/** El módulo de pdf.js (TextLayer, getDocument…), cargado una sola vez. */
export function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs") as Promise<PdfJs>, import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]).then(
      ([m, worker]) => {
        m.GlobalWorkerOptions.workerSrc = worker.default;
        return m;
      },
    );
    // Un fallo (red, deploy) no queda guardado: el próximo intento vuelve a pedirlo.
    lib.catch(() => {
      lib = null;
    });
  }
  return lib;
}

/**
 * El worker de pdf.js no arrancó: en una pestaña abierta antes de un deploy, su archivo con hash ya no existe (404) y
 * pdf.js cae al "fake worker", que también falla. Se recarga una vez (como con los trozos lazy) para tomar la versión
 * nueva; si no se recarga, el error se muestra.
 */
function isWorkerSetupError(e: unknown): boolean {
  // pdf.js 4: si el Worker no carga, prueba el "fake worker" (import del mismo archivo) y rechaza con este texto.
  return /Setting up fake worker failed/i.test(String((e as Error)?.message ?? e ?? ""));
}

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
    p = Promise.all([fetchArrayBuffer(url), pdfjs()])
      .then(
        ([data, m]) =>
          m.getDocument({
            data: new Uint8Array(data),
            isEvalSupported: false,
            // Fuentes estándar y CMaps servidos por la propia app (ver vite.config.ts).
            standardFontDataUrl: "/pdfjs/standard_fonts/",
            cMapUrl: "/pdfjs/cmaps/",
            cMapPacked: true,
          }).promise,
      )
      .catch((e: unknown) => {
        // Mientras se recarga la página no se muestra el error (la promesa queda pendiente).
        if (isWorkerSetupError(e) && reloadAfterDeploy()) return new Promise<never>(() => undefined);
        throw e;
      });
    // Solo si sigue siendo la entrada del caché: una carga desalojada que falla después no borra la que la reemplazó
    // (quedaba fuera del caché, sin destroy() al liberarse, y el PDF se volvía a bajar en la próxima vista).
    const mine = p;
    p.catch(() => {
      if (cache.get(url) === mine) cache.delete(url);
    });
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
