// Un PDF con objetos duplicados se ve distinto en un lector (que usa el xref) y en pdf-lib (que se queda con la última
// definición del archivo). El firmante lo ve en el visor de la web; el PDF final se arma con pdf-lib.
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { IncrementalUpdate, InvalidPdfError, inspectPdf } from "../src";

async function base(text: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

/** Inserta antes del último xref una segunda definición (no referenciada por el xref) del contenido de la página. */
async function shadowed(visible: Uint8Array, hiddenText: string) {
  const doc = await PDFDocument.load(visible);
  const page = doc.getPages()[0];
  const raw = page.node.get(PDFName.of("Contents"));
  const arr = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const contents = (arr instanceof PDFArray ? arr.get(arr.size() - 1) : raw) as PDFRef;
  const fontName = (page.node.Resources()!.lookup(PDFName.of("Font")) as unknown as { entries(): [PDFName, unknown][] }).entries()[0][0].decodeText();
  const body = `BT /${fontName} 14 Tf 50 780 Td (${hiddenText}) Tj ET`;
  const copy = Buffer.from(`${contents.objectNumber} ${contents.generationNumber} obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`, "latin1");
  const buf = Buffer.from(visible);
  const xrefAt = buf.lastIndexOf("xref\n", buf.lastIndexOf("startxref"));
  const tail = buf.subarray(xrefAt).toString("latin1").replace(/startxref\n(\d+)/, (_, n) => `startxref\n${Number(n) + copy.length}`);
  return { bytes: new Uint8Array(Buffer.concat([buf.subarray(0, xrefAt), copy, Buffer.from(tail, "latin1")])), contents };
}

describe("PDF ambiguo al subirlo", () => {
  it("rechaza un PDF cuyo contenido según el xref difiere del que ve pdf-lib", async () => {
    const { bytes, contents } = await shadowed(await base("Monto: 1.000"), "Monto: 1.000.000");
    // pdf-lib (lo que arma el PDF final) ve el texto oculto…
    const pdfLib = await PDFDocument.load(bytes);
    const stream = pdfLib.context.lookup(contents) as PDFRawStream;
    expect(Buffer.from(stream.contents).toString("latin1")).toContain("1.000.000");
    // …mientras que un lector muestra "Monto: 1.000". El documento se rechaza.
    const err = await inspectPdf(bytes).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPdfError);
    expect((err as InvalidPdfError).code).toBe("ambiguous_pdf");
  });

  it("relleno después del %%EOF no apaga la detección", async () => {
    const { bytes } = await shadowed(await base("Monto: 1.000"), "Monto: 1.000.000");
    // pdf.js busca el startxref en todo el archivo (no solo en los últimos 2 KB) y sigue mostrando "Monto: 1.000".
    const padded = new Uint8Array(Buffer.concat([Buffer.from(bytes), Buffer.from("% relleno\n".repeat(300), "latin1")]));
    const err = await inspectPdf(padded).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPdfError);
    expect((err as InvalidPdfError).code).toBe("ambiguous_pdf");
    // Un PDF normal con el mismo relleno se sigue aceptando.
    const plain = await base("Contrato");
    expect((await inspectPdf(new Uint8Array(Buffer.concat([Buffer.from(plain), Buffer.from("% relleno\n".repeat(300), "latin1")])))).pageCount).toBe(1);
  });

  it("una entrada rota del xref (de un objeto que nadie usa) no apaga la detección", async () => {
    // Un objeto huérfano: el lector nunca lo pide, así que no reconstruye el índice por él y sigue usando el xref.
    const withOrphan = await PDFDocument.load(await base("Monto: 1.000"));
    const orphan = withOrphan.context.register(withOrphan.context.obj({ Huerfano: true }));
    const { bytes } = await shadowed(await withOrphan.save({ useObjectStreams: false }), "Monto: 1.000.000");
    // La entrada del huérfano apunta al objeto 1 (offset de otro objeto).
    const buf = Buffer.from(bytes);
    const text = buf.toString("latin1");
    const table = [...text.matchAll(/\nxref\n0 \d+\n/g)].pop()!;
    const one = /\n1 0 obj/.exec(text)!.index + 1;
    const entryAt = table.index + table[0].length + orphan.objectNumber * 20;
    expect(text.slice(entryAt + 17, entryAt + 18)).toBe("n");
    buf.write(String(one).padStart(10, "0"), entryAt, "latin1");
    const err = await inspectPdf(new Uint8Array(buf)).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPdfError);
    expect((err as InvalidPdfError).code).toBe("ambiguous_pdf");
  });

  it("acepta PDFs normales y con revisiones incrementales", async () => {
    const plain = await base("Contrato");
    expect((await inspectPdf(plain)).pageCount).toBe(1);
    const u = await IncrementalUpdate.open(plain);
    const page = u.doc.getPages()[0];
    page.node.set(PDFName.of("Rotate"), u.context.obj(90));
    u.touch(page.ref);
    expect((await inspectPdf(u.serialize())).pageCount).toBe(1);
    // Con object streams y xref stream.
    const doc = await PDFDocument.load(plain);
    expect((await inspectPdf(await doc.save({ useObjectStreams: true }))).pageCount).toBe(1);
  });
});
