// pdf.js: carga y render de páginas en el navegador.
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fetchArrayBuffer } from "./api";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

const cache = new Map<string, Promise<PDFDocumentProxy>>();

export function loadPdf(url: string): Promise<PDFDocumentProxy> {
  let p = cache.get(url);
  if (!p) {
    p = fetchArrayBuffer(url).then(
      (data) => pdfjsLib.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise,
    );
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export function forgetPdf(url: string) {
  cache.delete(url);
}
