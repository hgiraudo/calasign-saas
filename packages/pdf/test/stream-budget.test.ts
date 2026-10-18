import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { InvalidPdfError, preparePdfUpload, structureWithinBudget } from "../src";

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

  it("la subida rechaza el PDF sin cargarlo entero en memoria", async () => {
    const err = await preparePdfUpload(pdfWithObjStm(160 * 1024 * 1024)).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidPdfError);
    expect(err.code).toBe("unreadable");
  }, 60_000);

  it("un PDF normal con streams de objetos pasa", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 50; i++) doc.addPage([612, 792]).drawText(`Pagina ${i + 1}`, { x: 50, y: 700, font, size: 12 });
    const bytes = await doc.save({ useObjectStreams: true });
    expect(structureWithinBudget(bytes)).toBe(true);
    expect((await preparePdfUpload(bytes)).info.pageCount).toBe(50);
  });
});
