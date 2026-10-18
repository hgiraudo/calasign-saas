import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider, finalizeEnvelopePdf, generateDevRootCa, inspectPdf, issueSealCertificate, renderEnvelopePdf } from "../src";

// PNG 1x1 negro.
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
);

async function samplePdf(rotate = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([595, 842]);
    p.setRotation(degrees(rotate));
    p.drawText(`Contrato de prueba - pagina ${i + 1}`, { x: 50, y: 780, size: 14, font });
  }
  return doc.save();
}

describe("finalizeEnvelopePdf", () => {
  it("estampa, agrega certificado y sella con PAdES válido", async () => {
    const ca = await generateDevRootCa("Test Root");
    const seal = await issueSealCertificate(ca, { commonName: "Test Seal" });
    const provider = new LocalKeyProvider("platform-seal", seal.keyPem!, seal.chainPem);

    const doc1 = await samplePdf();
    const doc2 = await samplePdf(90);
    const info = await inspectPdf(doc2);
    expect(info.pages[0]).toEqual({ width: 842, height: 595 });

    const signed = await finalizeEnvelopePdf(
      {
        documents: [
          { name: "a.pdf", bytes: doc1 },
          { name: "b.pdf", bytes: doc2 },
        ],
        fields: [
          { documentIndex: 0, page: 0, x: 0.1, y: 0.8, width: 0.3, height: 0.06, type: "signature", value: "signed", imagePng: PNG },
          { documentIndex: 0, page: 0, x: 0.5, y: 0.8, width: 0.3, height: 0.03, type: "name", value: "José Ñandú Gonçalves" },
          { documentIndex: 0, page: 1, x: 0.1, y: 0.1, width: 0.03, height: 0.03, type: "checkbox", value: "true" },
          { documentIndex: 1, page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.05, type: "text", value: "rotada" },
        ],
        certificate: {
          envelopeId: "0192f0e0-0000-7000-8000-000000000001",
          subject: "Contrato de servicios",
          organizationName: "ACME",
          senderName: "Ana",
          senderEmail: "ana@acme.test",
          createdAt: new Date().toISOString(),
          sentAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          locale: "es",
          documents: [
            { name: "a.pdf", pageCount: 2, sha256: "a".repeat(64) },
            { name: "b.pdf", pageCount: 2, sha256: "b".repeat(64) },
          ],
          recipients: [
            {
              name: "José Ñandú Gonçalves",
              role: "signer",
              email: "jose@test.com",
              phone: "+5511999999999",
              idDocument: "CPF 123.456.789-00",
              channels: ["email", "whatsapp"],
              authMethod: "link",
              sentAt: new Date().toISOString(),
              viewedAt: new Date().toISOString(),
              consentedAt: new Date().toISOString(),
              signedAt: new Date().toISOString(),
              ip: "203.0.113.7",
              userAgent: "Mozilla/5.0 (test)",
              signaturePng: PNG,
            },
          ],
          events: Array.from({ length: 60 }, (_, i) => ({
            seq: i + 1,
            type: "recipient.viewed",
            occurredAt: new Date().toISOString(),
            actor: "José",
            ip: "203.0.113.7",
          })),
          chainHead: "c".repeat(64),
        },
      },
      { provider, tsaUrl: process.env.TEST_TSA_URL ?? null },
    );

    const dir = mkdtempSync(join(tmpdir(), "calasign-"));
    const out = join(dir, "signed.pdf");
    writeFileSync(out, signed);
    writeFileSync(join(dir, "root.pem"), ca.certPem);

    // pdfsig (poppler) valida la integridad criptográfica del PDF.
    let report = "";
    try {
      report = execFileSync("pdfsig", [out], { encoding: "utf8" });
    } catch (e) {
      report = String((e as { stdout?: string }).stdout ?? e);
    }
    expect(report).toMatch(/Signature Validation: Signature is Valid/);
    expect(report).toMatch(/ETSI\.CAdES\.detached/);
    console.log(report, "\n→", out);
  }, 60_000);
});

describe("certificado de finalización", () => {
  it("la firma de cada destinatario va en la página de su nombre aunque sus datos sigan en la siguiente", async () => {
    const now = new Date().toISOString();
    const recipients = Array.from({ length: 12 }, (_, i) => ({
      name: `Firmante ${i + 1}`,
      role: "signer" as const,
      email: `f${i}@test.com`,
      phone: i % 2 ? "+5491100000000" : null,
      idDocument: i % 3 ? "DNI 12345678" : null,
      channels: ["email"],
      authMethod: "otp_email",
      sentAt: now,
      viewedAt: now,
      consentedAt: now,
      signedAt: now,
      ip: "203.0.113.7",
      userAgent: (i % 2 ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 " : "") + "UA",
      note: i % 4 === 0 ? "Delegó en otra persona: viaje" : null,
      signaturePng: PNG,
    }));
    const pdf = await renderEnvelopePdf({
      documents: [{ name: "a.pdf", bytes: await samplePdf() }],
      fields: [],
      certificate: {
        envelopeId: "0192f0e0-0000-7000-8000-000000000002",
        subject: "Contrato",
        organizationName: "ACME",
        senderName: "Ana",
        senderEmail: null,
        createdAt: now,
        sentAt: now,
        completedAt: now,
        locale: "es",
        documents: [{ name: "a.pdf", pageCount: 2, sha256: "a".repeat(64) }],
        recipients,
        events: [],
        chainHead: "c".repeat(64),
      },
    });
    const doc = await PDFDocument.load(pdf);
    let names = 0;
    let images = 0;
    for (const page of doc.getPages().slice(2)) {
      const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
      const bold = (fonts?.keys() ?? [])
        .filter((k) => String(fonts!.lookup(k, PDFDict).get(PDFName.of("BaseFont"))).includes("Bold"))
        .map((k) => k.toString());
      const raw = page.node.Contents();
      const streams = raw instanceof PDFArray ? raw.asArray().map((r) => doc.context.lookup(r)) : [raw];
      const ops = streams
        .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
        .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1"))
        .join("\n");
      const pageNames = bold.reduce((n, f) => n + ops.split(`${f} 9.5 Tf`).length - 1, 0);
      const pageImages = (ops.match(/ Do\b/g) ?? []).length;
      // Cada destinatario tiene firma: en cada página hay tantas firmas como nombres de destinatarios.
      expect(pageImages).toBe(pageNames);
      names += pageNames;
      images += pageImages;
    }
    expect(names).toBe(12);
    expect(images).toBe(12);
  });
});
