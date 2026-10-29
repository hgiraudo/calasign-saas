// Cajas de página inválidas o ilegibles: 400 con código propio (antes, aceptadas con tamaño 0 o enorme, o un 500 por
// UnexpectedObjectTypeError de pdf-lib). Y el tope de PDFs procesándose a la vez.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { InvalidPdfError, PDF_INGEST_LIMITS, PdfIngestBusyError, inspectPdf, preparePdfUpload } from "../src";

/** PDF de una página con el diccionario de página dado (objeto 4: un stream vacío). */
function onePage(pageDict: string) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", pageDict, "<< /Length 0 >>\nstream\n\nendstream"];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
const page = (extra: string) => onePage(`<< /Type /Page /Parent 2 0 R ${extra} /Contents 4 0 R >>`);
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e instanceof InvalidPdfError ? e.code : `otro: ${e}`),
  );

describe("geometría de las páginas", () => {
  it.each([
    ["área cero", "/MediaBox [0 0 0 0]"],
    ["demasiado chica", "/MediaBox [0 0 1 1]"],
    ["enorme", "/MediaBox [0 0 1000000000 1000000000]"],
    ["un lado fuera de rango", "/MediaBox [0 0 600 20000]"],
  ])("rechaza una página %s con pdf_page_size", async (_n, box) => {
    expect(await codeOf(preparePdfUpload(page(box)))).toBe("pdf_page_size");
    expect(await codeOf(inspectPdf(page(box)))).toBe("pdf_page_size");
  });

  it.each([
    ["MediaBox con un nombre", "/MediaBox [0 0 /a 5]"],
    ["Rotate que no es número", "/MediaBox [0 0 600 800] /Rotate 4 0 R"],
    ["CropBox que no es un array", "/MediaBox [0 0 600 800] /CropBox 4 0 R"],
  ])("%s: unreadable (no un 500)", async (_n, extra) => {
    expect(await codeOf(preparePdfUpload(page(extra)))).toBe("unreadable");
    expect(await codeOf(inspectPdf(page(extra)))).toBe("unreadable");
  });

  it("sin MediaBox: Carta (como pdf.js), escrita en el PDF normalizado", async () => {
    const prepared = await preparePdfUpload(page(""));
    expect(prepared.info.pages[0]).toEqual({ width: 612, height: 792 });
    const again = await PDFDocument.load(prepared.bytes);
    expect(again.getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    expect((await inspectPdf(page(""))).pages[0]).toEqual({ width: 612, height: 792 });
  });

  // Una /MediaBox que apunta a un objeto inexistente (o a null) cuenta como que falta (pdf.js usa Carta).
  it.each([
    ["referencia colgada", "/MediaBox 9 0 R"],
    ["referencia a null", "/MediaBox 5 0 R"],
  ])("MediaBox con %s: Carta", async (_n, box) => {
    // Objeto 5: null (con su entrada en la tabla de referencias).
    const withNull = (pdf: Uint8Array) => {
      const s = Buffer.from(pdf).toString("latin1");
      const at = s.indexOf("xref\n");
      const obj = "5 0 obj\nnull\nendobj\n";
      const fixed =
        s.slice(0, at) +
        obj +
        s
          .slice(at)
          .replace("xref\n0 5\n", "xref\n0 6\n")
          .replace("trailer", String(at).padStart(10, "0") + " 00000 n \ntrailer")
          .replace("/Size 5", "/Size 6")
          .replace(/startxref\n\d+/, `startxref\n${at + obj.length}`);
      return new Uint8Array(Buffer.from(fixed, "latin1"));
    };
    const pdf = withNull(page(box));
    expect((await inspectPdf(pdf)).pages[0]).toEqual({ width: 612, height: 792 });
    const prepared = await preparePdfUpload(pdf);
    expect(prepared.info.pages[0]).toEqual({ width: 612, height: 792 });
    expect((await PDFDocument.load(prepared.bytes)).getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });
  });

  it("acepta los extremos del rango", async () => {
    expect((await preparePdfUpload(page("/MediaBox [0 0 3 14400]"))).info.pages[0]).toEqual({ width: 3, height: 14400 });
  });
});

describe("tope de PDFs procesándose a la vez", () => {
  it("lo que no consigue lugar a tiempo falla con PdfIngestBusyError; el resto sigue", async () => {
    const saved = { ...PDF_INGEST_LIMITS };
    Object.assign(PDF_INGEST_LIMITS, { maxConcurrent: 1, queueWaitMs: 0, maxQueue: 0 });
    try {
      const d = await PDFDocument.create();
      d.addPage();
      const pdf = await d.save();
      const results = await Promise.allSettled([preparePdfUpload(pdf), preparePdfUpload(pdf), preparePdfUpload(pdf)]);
      expect(results[0].status).toBe("fulfilled");
      for (const r of results.slice(1)) {
        expect(r.status).toBe("rejected");
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(PdfIngestBusyError);
        expect((r as PromiseRejectedResult).reason.code).toBe("pdf_busy");
      }
      // Liberado el lugar, la siguiente pasa.
      expect((await inspectPdf(pdf)).pageCount).toBe(1);
    } finally {
      Object.assign(PDF_INGEST_LIMITS, saved);
    }
  });

  it("con espera, la siguiente toma el lugar cuando se libera", async () => {
    const saved = { ...PDF_INGEST_LIMITS };
    Object.assign(PDF_INGEST_LIMITS, { maxConcurrent: 1, queueWaitMs: 30_000, maxQueue: 4 });
    try {
      const d = await PDFDocument.create();
      d.addPage();
      const pdf = await d.save();
      const results = await Promise.all([preparePdfUpload(pdf), preparePdfUpload(pdf), inspectPdf(pdf)]);
      expect(results).toHaveLength(3);
    } finally {
      Object.assign(PDF_INGEST_LIMITS, saved);
    }
  });
});
