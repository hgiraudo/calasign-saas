import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider, finalizeEnvelopePdf, generateDevRootCa, issueSealCertificate, findChainHeadKeyword, readCertificateChainHead, renderEnvelopePdf, type FinalizeInput } from "../src";

async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrato", { x: 50, y: 780, size: 14, font });
  return doc.save();
}

const HEAD = "0123456789abcdef".repeat(4);

async function input(locale: string): Promise<FinalizeInput> {
  return {
    documents: [{ name: "a.pdf", bytes: await samplePdf() }],
    fields: [],
    certificate: {
      envelopeId: "0192f0e0-0000-7000-8000-0000000000cc",
      subject: "Contrato",
      organizationName: "ACME",
      senderName: "Ana",
      senderEmail: null,
      createdAt: new Date().toISOString(),
      sentAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      locale,
      documents: [{ name: "a.pdf", pageCount: 1, sha256: "a".repeat(64) }],
      recipients: [],
      events: [],
      chainHead: HEAD,
    },
  };
}

describe("hash final del certificado legible desde el PDF", () => {
  it("sale de los metadatos del PDF sellado", async () => {
    const ca = await generateDevRootCa("Test Root");
    const seal = await issueSealCertificate(ca, { commonName: "Test Seal" });
    const provider = new LocalKeyProvider("platform-seal", seal.keyPem!, seal.chainPem);
    const signed = await finalizeEnvelopePdf(await input("es"), { provider, tsaUrl: null });
    expect(await readCertificateChainHead(signed)).toEqual({ head: HEAD, source: "metadata" });
  });

  it("sin metadatos (PDF anterior), sale del texto impreso en el certificado", async () => {
    for (const locale of ["es", "pt-BR", "en"]) {
      const doc = await PDFDocument.load(await renderEnvelopePdf(await input(locale)));
      doc.setKeywords([]);
      const legacy = await doc.save();
      expect(await readCertificateChainHead(legacy)).toEqual({ head: HEAD, source: "text" });
    }
  }, 60_000);

  it("findChainHeadKeyword: de los bytes, sin parsear (sellado, con revisión incremental, literal; null sin Keyword)", async () => {
    const ca = await generateDevRootCa("Test Root");
    const seal = await issueSealCertificate(ca, { commonName: "Test Seal" });
    const provider = new LocalKeyProvider("platform-seal", seal.keyPem!, seal.chainPem);
    const signed = await finalizeEnvelopePdf(await input("es"), { provider, tsaUrl: null });
    // pdf-lib la escribe como string hex UTF-16BE con BOM.
    expect(Buffer.from(signed).includes("calasign-chain-head:")).toBe(false);
    expect(findChainHeadKeyword(signed)).toBe(HEAD);

    // Una revisión incremental al final (como las firmas con certificado propio) no la pierde.
    const tail = Buffer.from("\n9999 0 obj\n<< /Foo 1 >>\nendobj\n");
    expect(findChainHeadKeyword(Buffer.concat([Buffer.from(signed), tail]))).toBe(HEAD);

    // Un texto igual en otro objeto sin comprimir (p. ej. dentro de un documento subido) no se toma: se va por el Info del trailer.
    const other = "f".repeat(64);
    const unrelated = Buffer.from(`\n9998 0 obj\n<< /Keywords (calasign-chain-head:${other}) >>\nendobj\n`);
    expect(findChainHeadKeyword(Buffer.concat([Buffer.from(signed), unrelated]))).toBe(HEAD);

    // String literal en el Info (otra herramienta).
    const doc = await PDFDocument.load(await renderEnvelopePdf(await input("es")));
    (doc as unknown as { getInfoDict(): { set(k: PDFName, v: PDFString): void } }).getInfoDict().set(PDFName.of("Keywords"), PDFString.of(`x calasign-chain-head:${other}`));
    expect(findChainHeadKeyword(await doc.save({ useObjectStreams: false }))).toBe(other);

    // Sin Keyword (PDF anterior) o sin Info: null (el que llama recurre a readCertificateChainHead).
    doc.setKeywords([]);
    expect(findChainHeadKeyword(await doc.save({ useObjectStreams: false }))).toBeNull();
    expect(findChainHeadKeyword(Buffer.from("%PDF-1.7\nnada"))).toBeNull();
  }, 60_000);

  it("readCertificateChainHead lanza si el PDF no se puede leer (no es lo mismo que 'no lo trae')", async () => {
    await expect(readCertificateChainHead(Buffer.from("no es un pdf"))).rejects.toBeTruthy();
  }, 60_000);
});
