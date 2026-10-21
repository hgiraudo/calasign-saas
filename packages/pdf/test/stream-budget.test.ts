import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { InvalidPdfError, inspectPdf, preparePdfUpload, structureWithinBudget, validatePdf } from "../src";
import { textStreamBytes } from "../src/text-budget";

/**
 * PDF mínimo con un stream de objetos que se descomprime en `size` bytes, escrito de forma que una lectura con
 * expresiones regulares no lo ve como tal pero pdf-lib sí: /Type o /Filter indirectos, o un string con "obj".
 */
function pdfWithHiddenObjStm(size: number, variant: "type" | "filter" | "objstr") {
  const comp = deflateSync(Buffer.alloc(size, 0x20), { level: 9 });
  const parts: Buffer[] = [];
  const offs: number[] = [];
  let len = 0;
  const push = (x: string | Buffer) => {
    const b = typeof x === "string" ? Buffer.from(x, "latin1") : x;
    parts.push(b);
    len += b.length;
  };
  push("%PDF-1.7\n");
  offs[1] = len;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offs[2] = len;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offs[3] = len;
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n");
  offs[5] = len;
  push("5 0 obj\n/ObjStm\nendobj\n");
  offs[6] = len;
  push("6 0 obj\n/FlateDecode\nendobj\n");
  offs[4] = len;
  const dict =
    variant === "type"
      ? "/Type 5 0 R /N 1 /First 4 /Filter /FlateDecode"
      : variant === "filter"
        ? "/Type /ObjStm /N 1 /First 4 /Filter 6 0 R"
        : "/Type /ObjStm /N 1 /First 4 /X (obj) /Filter /FlateDecode";
  push(`4 0 obj\n<< ${dict} /Length ${comp.length} >>\nstream\n`);
  push(comp);
  push("\nendstream\nendobj\n");
  const xref = len;
  let x = "xref\n0 7\n0000000000 65535 f \n";
  for (let i = 1; i <= 6; i++) x += String(offs[i]).padStart(10, "0") + " 00000 n \n";
  push(x + "trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
  return new Uint8Array(Buffer.concat(parts));
}

/** PDF mínimo con un stream de objetos (ObjStm) que se descomprime en `size` bytes. */
function pdfWithObjStm(size: number) {
  const comp = deflateSync(Buffer.alloc(size, 0x20), { level: 9 });
  const parts: Buffer[] = [];
  const offs: number[] = [];
  let len = 0;
  const push = (x: string | Buffer) => {
    const b = typeof x === "string" ? Buffer.from(x, "latin1") : x;
    parts.push(b);
    len += b.length;
  };
  push("%PDF-1.7\n");
  offs[1] = len;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offs[2] = len;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offs[3] = len;
  push("3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n");
  offs[4] = len;
  push(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`);
  push(comp);
  push("\nendstream\nendobj\n");
  const xref = len;
  let x = "xref\n0 5\n0000000000 65535 f \n";
  for (let i = 1; i <= 4; i++) x += String(offs[i]).padStart(10, "0") + " 00000 n \n";
  push(x + "trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
  return new Uint8Array(Buffer.concat(parts));
}

describe("tope de descompresión al cargar un PDF", () => {
  it("rechaza un stream de objetos que se descomprime por encima del tope", () => {
    expect(structureWithinBudget(pdfWithObjStm(4 * 1024 * 1024), 1024 * 1024)).toBe(false);
    expect(structureWithinBudget(pdfWithObjStm(512 * 1024), 1024 * 1024)).toBe(true);
  });

  // Antes, por cada "stream" se buscaba hacia atrás sin límite y se armaba un string con todo el tramo: 1 MB de
  // "stream" repetido tardaba ~30 s (sincrónico, alcanzable sin autenticación por /v1/validate).
  it("es lineal con miles de \"stream\" seguidos", () => {
    const n = Math.floor((4 * 1024 * 1024) / 10);
    const variants = [
      "%PDF-1.4\n" + "stream".repeat(n),
      "%PDF-1.4\n<<>>\n" + "stream".repeat(n),
      "%PDF-1.4\n" + "<<>>stream".repeat(n),
      "%PDF-1.4\n1 0 obj\n" + "<</Type/ObjStm>>stream".repeat(n / 2),
      "%PDF-1.4\n" + "1 0 obj<</Type/ObjStm/Filter/FlateDecode>>stream\n".repeat(n / 5),
      "%PDF-1.4\n" + "1 0 obj<</Type/ObjStm/Filter/FlateDecode>>stream\nx\x9c".repeat(n / 5),
    ];
    for (const v of variants) {
      const t0 = performance.now();
      structureWithinBudget(new Uint8Array(Buffer.from(v, "latin1")));
      expect(performance.now() - t0).toBeLessThan(10000);
    }
  });

  it("la subida rechaza el PDF sin cargarlo entero en memoria", async () => {
    const err = await preparePdfUpload(pdfWithObjStm(160 * 1024 * 1024)).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPdfError);
    expect(err.code).toBe("unreadable");
  }, 60_000);

  // La lectura con expresiones regulares no ve estos streams; el tope dentro de pdf-lib sí. Sin él, un archivo de
  // ~300 KB se descomprimía entero (300 MB, y el doble en memoria) y se aceptaba.
  for (const variant of ["type", "filter", "objstr"] as const) {
    it(`rechaza un stream de objetos escondido (${variant}) en la subida, la inspección y la validación`, async () => {
      const pdf = pdfWithHiddenObjStm(300 * 1024 * 1024, variant);
      for (const run of [() => preparePdfUpload(pdf), () => inspectPdf(pdf)]) {
        const err = await run().catch((e) => e);
        expect(err).toBeInstanceOf(InvalidPdfError);
        expect(err.code).toBe("unreadable");
      }
      await expect(validatePdf(pdf)).rejects.toThrow(/demasiado grande/);
    }, 120_000);
  }

  // Un diccionario relleno deja el "obj" fuera de la ventana de búsqueda: antes, el stream se salteaba sin medirlo.
  it("un stream de objetos con el diccionario relleno se mide igual (o se rechaza sin encabezado)", () => {
    const padded = (size: number, header = "4 0 obj\n") => {
      const comp = deflateSync(Buffer.alloc(size, 0x20), { level: 9 });
      const head = `%PDF-1.7\n${header}<< /N 1 /First 4 /Filter /FlateDecode /Length ${comp.length}${" ".repeat(20_000)}/Type /ObjStm >>\nstream\n`;
      return new Uint8Array(Buffer.concat([Buffer.from(head, "latin1"), comp, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]));
    };
    expect(structureWithinBudget(padded(4 * 1024 * 1024), 1024 * 1024)).toBe(false);
    expect(structureWithinBudget(padded(512 * 1024), 1024 * 1024)).toBe(true);
    // Con el nombre escapado (#53 = S) también.
    expect(structureWithinBudget(new Uint8Array(Buffer.from(Buffer.from(padded(4 * 1024 * 1024)).toString("latin1").replace("/ObjStm", "/Obj#53tm"), "latin1")), 1024 * 1024)).toBe(false);
    // Sin ningún "obj" antes: no se puede medir, se rechaza.
    expect(structureWithinBudget(padded(1024, ""), 1024 * 1024)).toBe(false);
  });

  // Un PDF grande y legítimo puede tener más de 4096 streams de objetos: el tope crece con el tamaño del archivo.
  it("muchos streams de objetos chicos: se aceptan si el archivo los justifica", () => {
    const build = (n: number, pad: number) => {
      const parts: Buffer[] = [Buffer.from("%PDF-1.7\n")];
      for (let i = 1; i <= n; i++) {
        const comp = deflateSync(Buffer.from(`${i} 0 ` + "x".repeat(pad)), { level: 0 });
        parts.push(Buffer.from(`${i} 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`, "latin1"));
        parts.push(comp, Buffer.from("\nendstream\nendobj\n", "latin1"));
      }
      return new Uint8Array(Buffer.concat(parts));
    };
    const big = build(6000, 1024);
    expect(big.length / 6000).toBeGreaterThan(1024);
    expect(structureWithinBudget(big)).toBe(true);
    // Miles de streams diminutos en un archivo chico siguen rechazándose.
    const tiny = build(6000, 0);
    expect(tiny.length / 6000).toBeLessThan(1024);
    expect(structureWithinBudget(tiny)).toBe(false);
  });

  // textStreamBytes cargaba el PDF con pdf-lib sin el tope de descompresión: un stream de objetos escondido se
  // descomprimía entero.
  it("medir el texto también rechaza un stream de objetos escondido", async () => {
    expect(await textStreamBytes(pdfWithHiddenObjStm(200 * 1024 * 1024, "type"))).toBeNull();
  }, 120_000);

  it("un PDF normal con streams de objetos pasa", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 50; i++) doc.addPage([612, 792]).drawText(`Pagina ${i + 1}`, { x: 50, y: 700, font, size: 12 });
    const bytes = await doc.save({ useObjectStreams: true });
    expect(structureWithinBudget(bytes)).toBe(true);
    expect((await preparePdfUpload(bytes)).info.pageCount).toBe(50);
  });
});
