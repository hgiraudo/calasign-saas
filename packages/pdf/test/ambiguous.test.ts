// Un PDF con objetos duplicados se ve distinto en un lector (que usa el xref) y en pdf-lib (que se queda con la última
// definición del archivo). El firmante lo ve en el visor de la web; el PDF final se arma con pdf-lib.
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { IncrementalUpdate, InvalidPdfError, inspectPdf, preparePdfUpload } from "../src";
import { extractPdfPlainText } from "../src/plain-text";

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


/**
 * Variantes donde el visor (pdf.js) elige un xref distinto del que tomaba el control: el contenido de la página está
 * definido dos veces; pdf-lib (lo que arma el PDF final) ve la última definición y el xref "visible" apunta a la otra.
 */
async function twoDefinitions(visible: string, hidden: string) {
  const buf = Buffer.from(await base(visible));
  const root = /\/Root (\d+ 0 R)/.exec(buf.toString("latin1"))![1];
  const { bytes, contents } = await shadowed(new Uint8Array(buf), hidden);
  const all = Buffer.from(bytes);
  const objs = all.subarray(0, all.lastIndexOf("xref\n", all.lastIndexOf("startxref")));
  const text = objs.toString("latin1");
  const visibleAt = new RegExp(`(?<=[\\r\\n])${contents.objectNumber} 0 obj`).exec(text)!.index;
  /** Tabla xref: cada objeto en su última definición (lo que ve pdf-lib), salvo `visibleFor`. */
  const xref = (body: Buffer, visibleShift: number | null, shift = 0) => {
    const last = new Map<number, number>();
    for (const m of body.toString("latin1").matchAll(/(?<=^|[\r\n])(\d+) 0 obj/g)) last.set(Number(m[1]), m.index! - shift);
    if (visibleShift !== null) last.set(contents.objectNumber, visibleAt + visibleShift - shift);
    const max = Math.max(...last.keys());
    let t = `xref\n0 ${max + 1}\n0000000000 65535 f\r\n`;
    for (let i = 1; i <= max; i++) t += last.has(i) ? `${String(last.get(i)).padStart(10, "0")} 00000 n\r\n` : "0000000000 00000 f\r\n";
    return `${t}trailer\n<< /Size ${max + 1} /Root ${root} >>\n`;
  };
  return { objs, xref };
}

/** Lo que muestra el visor de la web (pdf.js) y lo que queda en el PDF final (pdf-lib). */
async function views(pdf: Buffer) {
  const viewer = (await extractPdfPlainText(new Uint8Array(pdf))).text;
  const src = await PDFDocument.load(pdf);
  const out = await PDFDocument.create();
  out.addPage((await out.copyPages(src, [0]))[0]);
  return { viewer, final: (await extractPdfPlainText(await out.save())).text };
}

async function expectAmbiguous(pdf: Buffer) {
  expect(await views(pdf)).toEqual({ viewer: "Monto: 1.000", final: "Monto: 1.000.000" });
  const err = await inspectPdf(new Uint8Array(pdf)).catch((e) => e);
  expect(err).toBeInstanceOf(InvalidPdfError);
  expect((err as InvalidPdfError).code).toBe("ambiguous_pdf");
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

  it("basura antes de %PDF-: pdf.js mide los offsets desde el encabezado", async () => {
    const { objs, xref } = await twoDefinitions("Monto: 1.000", "Monto: 1.000.000");
    const pdf = Buffer.concat([objs, Buffer.from(`${xref(objs, 0)}startxref\n${objs.length}\n%%EOF\n`, "latin1")]);
    await expectAmbiguous(Buffer.concat([Buffer.from("X-Adjunto: contrato.pdf\r\n\r\n", "latin1"), pdf]));
  });

  it("startxref pegado al número: pdf.js lo lee y no usa el startxref anterior", async () => {
    const { objs, xref } = await twoDefinitions("Monto: 1.000", "Monto: 1.000.000");
    const visibleXref = objs.length;
    const mid = Buffer.concat([objs, Buffer.from(xref(objs, 0), "latin1")]);
    const tail = `${xref(objs, null)}startxref\n${mid.length}\n%%EOF\nstartxref${visibleXref}\n%%EOF\n`;
    await expectAmbiguous(Buffer.concat([mid, Buffer.from(tail, "latin1")]));
  });

  it("diccionario de linealización: pdf.js empieza en el xref que sigue al primer endobj", async () => {
    const { objs, xref } = await twoDefinitions("Monto: 1.000", "Monto: 1.000.000");
    const header = /^%PDF-[^\n]*\n(%[^\n]*\n)?/.exec(objs.toString("latin1"))![0];
    const rest = objs.subarray(header.length);
    const lin = (L: number) => `999 0 obj\n<< /Linearized 1 /L ${String(L).padStart(10, "0")} /H [ 1 1 ] /O 1 /E 1 /N 1 /T 1 >>\nendobj\n`;
    // El xref de la "primera página" (después del endobj) apunta a la definición visible; las tablas tienen largo fijo.
    const shift = lin(0).length + xref(objs, 0).length;
    const shifted = Buffer.concat([Buffer.from(header, "latin1"), Buffer.alloc(shift, 0x20), rest]);
    const body = Buffer.concat([Buffer.from(header + lin(0) + xref(shifted, shift), "latin1"), rest]);
    const pdf = Buffer.concat([body, Buffer.from(`${xref(body, null)}startxref\n${body.length}\n%%EOF\n`, "latin1")]);
    await expectAmbiguous(Buffer.from(pdf.toString("latin1").replace(lin(0), lin(pdf.length)), "latin1"));
  });

  it("acepta un PDF linealizado coherente y uno con un encabezado de correo antes de %PDF-", async () => {
    // Mismo armado que el linealizado de arriba, pero las dos tablas apuntan a la definición que ve pdf-lib.
    const { objs, xref } = await twoDefinitions("Monto: 1.000", "Monto: 1.000.000");
    const header = /^%PDF-[^\n]*\n(%[^\n]*\n)?/.exec(objs.toString("latin1"))![0];
    const rest = objs.subarray(header.length);
    const lin = (L: number) => `999 0 obj\n<< /Linearized 1 /L ${String(L).padStart(10, "0")} /H [ 1 1 ] /O 1 /E 1 /N 1 /T 1 >>\nendobj\n`;
    const shift = lin(0).length + xref(objs, null).length;
    const shifted = Buffer.concat([Buffer.from(header, "latin1"), Buffer.alloc(shift, 0x20), rest]);
    const body = Buffer.concat([Buffer.from(header + lin(0) + xref(shifted, null), "latin1"), rest]);
    let pdf = Buffer.concat([body, Buffer.from(`${xref(body, null)}startxref\n${body.length}\n%%EOF\n`, "latin1")]);
    pdf = Buffer.from(pdf.toString("latin1").replace(lin(0), lin(pdf.length)), "latin1");
    expect((await views(pdf)).viewer).toBe("Monto: 1.000.000");
    expect((await inspectPdf(new Uint8Array(pdf))).pageCount).toBe(1);
    const plain = Buffer.from(await base("Contrato"));
    expect((await inspectPdf(new Uint8Array(Buffer.concat([Buffer.from("X-Adjunto: contrato.pdf\r\n\r\n", "latin1"), plain])))).pageCount).toBe(1);
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

/** Las variantes ambiguas conocidas (rondas 10 a 13), armadas igual que en las pruebas de detección. */
async function ambiguousVariants(): Promise<[string, Buffer][]> {
  const out: [string, Buffer][] = [];
  out.push(["objeto duplicado", Buffer.from((await shadowed(await base("Monto: 1.000"), "Monto: 1.000.000")).bytes)]);
  {
    const { bytes } = await shadowed(await base("Monto: 1.000"), "Monto: 1.000.000");
    out.push(["relleno tras %%EOF", Buffer.concat([Buffer.from(bytes), Buffer.from("% relleno\n".repeat(300), "latin1")])]);
  }
  {
    const { objs, xref } = await twoDefinitions("Monto: 1.000", "Monto: 1.000.000");
    const pdf = Buffer.concat([objs, Buffer.from(`${xref(objs, 0)}startxref\n${objs.length}\n%%EOF\n`, "latin1")]);
    out.push(["prefijo antes de %PDF-", Buffer.concat([Buffer.from("X-Adjunto: contrato.pdf\r\n\r\n", "latin1"), pdf])]);
  }
  {
    const { objs, xref } = await twoDefinitions("Monto: 1.000", "Monto: 1.000.000");
    const mid = Buffer.concat([objs, Buffer.from(xref(objs, 0), "latin1")]);
    const tail = `${xref(objs, null)}startxref\n${mid.length}\n%%EOF\nstartxref${objs.length}\n%%EOF\n`;
    out.push(["startxref pegado", Buffer.concat([mid, Buffer.from(tail, "latin1")])]);
  }
  {
    const { objs, xref } = await twoDefinitions("Monto: 1.000", "Monto: 1.000.000");
    const header = /^%PDF-[^\n]*\n(%[^\n]*\n)?/.exec(objs.toString("latin1"))![0];
    const rest = objs.subarray(header.length);
    const lin = (L: number) => `999 0 obj\n<< /Linearized 1 /L ${String(L).padStart(10, "0")} /H [ 1 1 ] /O 1 /E 1 /N 1 /T 1 >>\nendobj\n`;
    const shift = lin(0).length + xref(objs, 0).length;
    const shifted = Buffer.concat([Buffer.from(header, "latin1"), Buffer.alloc(shift, 0x20), rest]);
    const body = Buffer.concat([Buffer.from(header + lin(0) + xref(shifted, shift), "latin1"), rest]);
    const pdf = Buffer.concat([body, Buffer.from(`${xref(body, null)}startxref\n${body.length}\n%%EOF\n`, "latin1")]);
    out.push(["linealización falsa", Buffer.from(pdf.toString("latin1").replace(lin(0), lin(pdf.length)), "latin1")]);
  }
  return out;
}

describe("preparePdfUpload: el PDF guardado es el que ve pdf-lib", () => {
  it("con cualquier variante ambigua, el visor muestra lo mismo que queda en el PDF final", async () => {
    for (const [name, pdf] of await ambiguousVariants()) {
      // Sin normalizar, el visor y el PDF final difieren.
      expect(await views(pdf), name).toEqual({ viewer: "Monto: 1.000", final: "Monto: 1.000.000" });
      const prepared = await preparePdfUpload(new Uint8Array(pdf));
      // Guardando la versión reescrita, el visor muestra lo que termina en el PDF final.
      expect(await views(Buffer.from(prepared.bytes)), name).toEqual({ viewer: "Monto: 1.000.000", final: "Monto: 1.000.000" });
      expect(prepared.info.pageCount, name).toBe(1);
    }
  });

  it("conserva texto, tamaño de página y rotación de un PDF normal; los campos de formulario quedan fijos en la página", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([612, 792]);
    p.drawText("Contrato de servicios", { x: 50, y: 700, size: 14, font });
    p.setRotation(degrees(90));
    const tf = doc.getForm().createTextField("cliente");
    tf.setText("ACME S.A.");
    tf.addToPage(p, { x: 50, y: 600, width: 200, height: 20 });
    const original = await doc.save();
    const prepared = await preparePdfUpload(original);
    expect(prepared.info).toEqual(await inspectPdf(original));
    // El formulario se aplana (sanitize.ts): el valor del campo pasa a ser texto de la página, como lo ve el lector.
    expect((await extractPdfPlainText(prepared.bytes)).text).toBe("Contrato de serviciosACME S.A.");
    const again = await PDFDocument.load(prepared.bytes);
    expect(again.getForm().getFields()).toHaveLength(0);
    expect(again.getPages()[0].getRotation().angle).toBe(90);
  });

  it("rechaza lo mismo que inspectPdf (no es PDF, demasiadas páginas)", async () => {
    const codeOf = (b: Uint8Array, max?: number) => preparePdfUpload(b, max).then(() => "ok", (e) => (e as InvalidPdfError).code);
    expect(await codeOf(new Uint8Array(Buffer.from("hola mundo")))).toBe("not_pdf");
    const two = await PDFDocument.create();
    two.addPage();
    two.addPage();
    expect(await codeOf(await two.save(), 1)).toBe("too_many_pages");
  });
});
