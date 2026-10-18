// Leer el texto de un PDF (IA, buscador del repositorio, negociaciones, anclas) no puede dejar sin responder a la API.
// pdf.js descomprime sin tope y corría en el mismo hilo: un PDF de 500 KB tardaba un minuto, ocupaba casi 1 GB y
// bloqueaba el hilo todo ese tiempo.
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, type PDFDict } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { extractPdfPlainText, extractPdfText, findTextAnchors, InvalidPdfError } from "../src";
import { PDFJS_LIMITS } from "../src/pdfjs-run";

const defaults = { ...PDFJS_LIMITS };
afterEach(() => Object.assign(PDFJS_LIMITS, defaults));

/** Página con texto real más un stream de contenido extra (comprimido) con `ops` repetido hasta `mb` megas. */
async function pdfWithContent(mb: number, ops: string, dictExtra: Record<string, unknown> = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Contrato de servicios", { x: 50, y: 800, size: 12, font });
  const raw = Buffer.alloc(Math.floor(mb * 1024 * 1024), ops);
  const comp = deflateSync(raw, { level: 1 });
  const dict = doc.context.obj({ Filter: "FlateDecode", Length: comp.length, ...dictExtra }) as PDFDict;
  const ref = doc.context.register(PDFRawStream.of(dict, new Uint8Array(comp)));
  const arr = doc.context.obj([]) as any;
  arr.push(page.node.get(PDFName.of("Contents")));
  arr.push(ref);
  page.node.set(PDFName.of("Contents"), arr);
  return doc.save({ useObjectStreams: false });
}

/** Mide el bloqueo más largo del hilo mientras corre `fn`. */
async function maxBlock<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; blockMs: number; ms: number }> {
  let last = Date.now();
  let block = 0;
  const iv = setInterval(() => {
    block = Math.max(block, Date.now() - last);
    last = Date.now();
  }, 10);
  const t0 = Date.now();
  try {
    const value = await fn();
    return { value, blockMs: Math.max(block, Date.now() - last), ms: Date.now() - t0 };
  } catch (error) {
    return { error, blockMs: Math.max(block, Date.now() - last), ms: Date.now() - t0 };
  } finally {
    clearInterval(iv);
  }
}

describe("leer el texto de un PDF con tope", () => {
  it("un stream de contenido de cientos de MB descomprimido se rechaza enseguida, sin bloquear el hilo", async () => {
    const pdf = await pdfWithContent(120, "q Q ");
    expect(pdf.length).toBeLessThan(2 * 1024 * 1024);
    const reads: (() => Promise<unknown>)[] = [() => extractPdfPlainText(pdf), () => extractPdfText(pdf), () => findTextAnchors(pdf, "Contrato")];
    for (const read of reads) {
      const r = await maxBlock(read);
      expect(r.error).toBeInstanceOf(InvalidPdfError);
      expect(r.ms).toBeLessThan(5000);
      expect(r.blockMs).toBeLessThan(2000);
    }
  }, 60_000);

  it("también si el stream de contenido dice ser una imagen (pdf.js lo decodifica igual)", async () => {
    const pdf = await pdfWithContent(120, "q Q ", { Subtype: "Image", Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: "DeviceGray" });
    const r = await maxBlock(() => extractPdfPlainText(pdf));
    expect(r.error).toBeInstanceOf(InvalidPdfError);
    expect(r.ms).toBeLessThan(5000);
  }, 60_000);

  it("una imagen grande no cuenta: el texto se sigue leyendo", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText("Anexo escaneado", { x: 50, y: 800, size: 12, font });
    // 8000 x 8000 en gris: 61 MB descomprimida, más que el tope de texto.
    const w = 8000;
    const comp = deflateSync(Buffer.alloc(w * w, 0x80), { level: 1 });
    const img = doc.context.register(
      PDFRawStream.of(
        doc.context.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: w, BitsPerComponent: 8, ColorSpace: "DeviceGray", Filter: "FlateDecode", Length: comp.length }) as PDFDict,
        new Uint8Array(comp),
      ),
    );
    page.node.Resources()!.set(PDFName.of("XObject"), doc.context.obj({ Im0: img }));
    const pdf = await doc.save({ useObjectStreams: false });
    expect((await extractPdfPlainText(pdf)).text).toContain("Anexo escaneado");
  }, 60_000);

  it("un PDF que tarda demasiado se corta por tiempo sin bloquear el hilo, y la lectura siguiente funciona", async () => {
    const pdf = await pdfWithContent(30, "q Q "); // dentro del tope de descompresión, pero lento para pdf.js
    PDFJS_LIMITS.timeoutMs = 800;
    const r = await maxBlock(() => extractPdfPlainText(pdf));
    expect(r.error).toBeInstanceOf(InvalidPdfError);
    expect(r.ms).toBeLessThan(3000);
    expect(r.blockMs).toBeLessThan(500);
    Object.assign(PDFJS_LIMITS, defaults);
    const ok = await PDFDocument.create();
    const font = await ok.embedFont(StandardFonts.Helvetica);
    ok.addPage([595, 842]).drawText("Hola", { x: 50, y: 700, size: 12, font });
    expect((await extractPdfPlainText(await ok.save())).text).toBe("Hola");
  }, 60_000);

  it("demasiados fragmentos de texto (p. ej. un formulario con texto dibujado miles de veces) se rechazan", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText("p", { x: 10, y: 10, size: 8, font });
    const fontRef = (page.node.Resources()!.lookup(PDFName.of("Font")) as PDFDict).entries()[0][1];
    const formData = Buffer.from("BT /F1 12 Tf (Clausula) Tj ET");
    const form = doc.context.register(
      PDFRawStream.of(
        doc.context.obj({ Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100], Resources: { Font: { F1: fontRef } }, Length: formData.length }) as PDFDict,
        new Uint8Array(formData),
      ),
    );
    page.node.Resources()!.set(PDFName.of("XObject"), doc.context.obj({ Fm: form }));
    const content = deflateSync(Buffer.from("/Fm Do ".repeat(5000)));
    const ref = doc.context.register(PDFRawStream.of(doc.context.obj({ Filter: "FlateDecode", Length: content.length }) as PDFDict, new Uint8Array(content)));
    const arr = doc.context.obj([]) as any;
    arr.push(page.node.get(PDFName.of("Contents")));
    arr.push(ref);
    page.node.set(PDFName.of("Contents"), arr);
    const pdf = await doc.save({ useObjectStreams: false });
    PDFJS_LIMITS.maxItems = 1000;
    await expect(extractPdfPlainText(pdf)).rejects.toBeInstanceOf(InvalidPdfError);
    Object.assign(PDFJS_LIMITS, defaults);
    expect((await extractPdfPlainText(pdf)).text).toContain("Clausula");
  }, 60_000);
});
