import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider, finalizeEnvelopePdf, generateDevRootCa, issueSealCertificate } from "../src";

const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
);

async function pdf(pages: number, label: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`${label} ${i + 1}`, { x: 50, y: 780, size: 14, font });
  return doc.save();
}

describe("tipos de campo nuevos, adjuntos y branding", () => {
  it("estampa número/desplegable/empresa/cargo/adjunto, agrega adjuntos y sella", async () => {
    const ca = await generateDevRootCa("Test Root");
    const seal = await issueSealCertificate(ca, { commonName: "Test Seal" });
    const provider = new LocalKeyProvider("platform-seal", seal.keyPem!, seal.chainPem);
    const now = new Date().toISOString();

    const signed = await finalizeEnvelopePdf(
      {
        documents: [{ name: "contrato.pdf", bytes: await pdf(2, "Contrato") }],
        fields: [
          { documentIndex: 0, page: 0, x: 0.1, y: 0.2, width: 0.2, height: 0.03, type: "number", value: "1500.50" },
          { documentIndex: 0, page: 0, x: 0.1, y: 0.3, width: 0.2, height: 0.03, type: "dropdown", value: "Mensual" },
          { documentIndex: 0, page: 0, x: 0.1, y: 0.4, width: 0.3, height: 0.03, type: "company", value: "ACME S.R.L." },
          { documentIndex: 0, page: 0, x: 0.1, y: 0.5, width: 0.3, height: 0.03, type: "title", value: "Gerente" },
          { documentIndex: 0, page: 1, x: 0.1, y: 0.1, width: 0.4, height: 0.03, type: "attachment", value: "cedula.png" },
        ],
        attachments: [
          { name: "anexo.pdf", recipientName: "José", contentType: "application/pdf", bytes: await pdf(2, "Anexo") },
          { name: "cedula.png", recipientName: "José", contentType: "image/png", bytes: PNG },
        ],
        certificate: {
          envelopeId: "0192f0e0-0000-7000-8000-000000000002",
          subject: "Contrato con adjuntos",
          organizationName: "ACME",
          senderName: "Ana",
          senderEmail: "ana@acme.test",
          createdAt: now,
          sentAt: now,
          completedAt: now,
          locale: "pt-BR",
          documents: [{ name: "contrato.pdf", pageCount: 2, sha256: "a".repeat(64) }],
          recipients: [],
          events: [{ seq: 1, type: "envelope.created", occurredAt: now, actor: "Ana", ip: null }],
          chainHead: "c".repeat(64),
          attachments: [
            { name: "anexo.pdf", recipientName: "José", sha256: "d".repeat(64), appended: true },
            { name: "cedula.png", recipientName: "José", sha256: "e".repeat(64), appended: true },
          ],
          branding: { primaryColor: "#7c3aed", logo: { bytes: PNG, type: "png" } },
        },
      },
      { provider, tsaUrl: null },
    );

    const out = await PDFDocument.load(signed);
    // 2 del contrato + 2 del anexo PDF + 1 de la imagen + al menos 1 del certificado
    expect(out.getPageCount()).toBeGreaterThanOrEqual(6);

    const dir = mkdtempSync(join(tmpdir(), "calasign-prod-"));
    const file = join(dir, "signed.pdf");
    writeFileSync(file, signed);
    let report = "";
    try {
      report = execFileSync("pdfsig", [file], { encoding: "utf8" });
    } catch (e) {
      report = String((e as { stdout?: string }).stdout ?? e);
    }
    expect(report).toMatch(/Signature is Valid/);
    const text = execFileSync("pdftotext", [file, "-"], { encoding: "utf8" });
    expect(text).toContain("1500.50");
    expect(text).toContain("Mensual");
    expect(text).toContain("ACME S.R.L.");
    expect(text).toContain("Anexo: cedula.png");
    expect(text).toContain("Anexo 2");
    expect(text).toContain("Anexos");
  }, 60_000);
});
