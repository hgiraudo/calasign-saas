import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider, finalizeEnvelopePdf, generateDevRootCa, issueSealCertificate, readCertificateChainHead, renderEnvelopePdf, type FinalizeInput } from "../src";

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
    for (const locale of ["es", "en"]) {
      const doc = await PDFDocument.load(await renderEnvelopePdf(await input(locale)));
      doc.setKeywords([]);
      const legacy = await doc.save();
      expect(await readCertificateChainHead(legacy)).toEqual({ head: HEAD, source: "text" });
    }
  }, 60_000);
});
