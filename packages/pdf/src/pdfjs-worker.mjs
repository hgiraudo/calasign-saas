// Lectura del texto de un PDF con pdf.js, en un proceso aparte (ver pdfjs-run.ts). JavaScript plano a propósito: así
// carga igual con tsx, con vitest y en producción, sin depender del loader de TypeScript.
// Atiende un trabajo a la vez; si uno se pasa de tiempo o de memoria, la API mata el proceso.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

async function read({ data, maxPages, maxChars, maxItems }) {
  const doc = await getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  let chars = 0;
  let items = 0;
  let tooMuch = false;
  try {
    const n = Math.min(doc.numPages, maxPages);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      // Por partes (con control de flujo): se cuenta a medida que llega y se corta al pasar el máximo, antes de que
      // pdf.js junte todo. Con getTextContent, un formulario con texto dibujado miles de veces llenaba la memoria.
      const reader = page.streamTextContent().getReader();
      const out = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const it of value.items) {
          if (typeof it.str !== "string") continue;
          out.push({ str: it.str, transform: it.transform, width: it.width, height: it.height, hasEOL: Boolean(it.hasEOL) });
          chars += it.str.length;
        }
        if (items + out.length > maxItems) {
          tooMuch = true;
          await reader.cancel(new Error("demasiados fragmentos de texto")).catch(() => {});
          break;
        }
      }
      items += out.length;
      pages.push({ width: vp.width, height: vp.height, transform: vp.transform, items: out });
      page.cleanup();
      if (tooMuch) break;
      if (maxChars && chars > maxChars) break;
    }
    return { numPages: doc.numPages, pages, tooMuch };
  } finally {
    await doc.destroy();
  }
}

process.on("message", async (job) => {
  try {
    process.send({ ok: true, result: await read(job) });
  } catch (e) {
    process.send({ ok: false, message: String(e?.message ?? e), name: String(e?.name ?? "Error") });
  }
});
// Si la API se va, este proceso también.
process.on("disconnect", () => process.exit(0));
