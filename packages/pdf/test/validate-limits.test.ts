import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { MAX_VALIDATE_SIGNATURES, validatePdf } from "../src/validate";
describe("validación pública de PDF: tope de firmas", () => {
    it("un PDF con más firmas que el tope se rechaza antes de validarlas", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const ctx = doc.context;
    const fields = [];
    for (let i = 0; i < MAX_VALIDATE_SIGNATURES + 5; i++) {
      const v = ctx.obj({ Type: "Sig", ByteRange: [0, 10, 20 + i, 5], Contents: PDFHexString.of("00") });
      fields.push(ctx.register(ctx.obj({ FT: "Sig", T: PDFHexString.fromText(`s${i}`), V: v })));
    }
    doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: fields }));
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(validatePdf(bytes)).rejects.toThrow(/demasiadas firmas/);
  });
});
