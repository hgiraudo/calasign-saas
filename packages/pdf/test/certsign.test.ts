// Firma con certificado propio: identidad, controles del certificado y firma en dos pasos (RSA y ECDSA).
import { execFileSync } from "node:child_process";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkSigningCertificate,
  completeExternalSignature,
  identityCandidates,
  matchesIdDocument,
  normalizeIdNumber,
  prepareExternalSignature,
  renderEnvelopePdf,
  validatePdf,
} from "../src";
import { startLab, type LabIdentity, type LabPki, type LabServer } from "../src/lab";

let pki: LabPki;
let server: LabServer;

beforeAll(async () => {
  ({ pki, server } = await startLab());
}, 60_000);
afterAll(async () => server?.close());

async function basePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrato con firma de certificado", { x: 50, y: 780, size: 14, font });
  const now = new Date().toISOString();
  return renderEnvelopePdf({
    documents: [{ name: "a.pdf", bytes: await doc.save() }],
    fields: [],
    certificate: {
      envelopeId: "0192f0e0-0000-7000-8000-0000000000cc",
      subject: "Certificado propio",
      organizationName: "ACME",
      senderName: "Ana",
      senderEmail: null,
      createdAt: now,
      sentAt: now,
      completedAt: now,
      locale: "es",
      documents: [{ name: "a.pdf", pageCount: 1, sha256: "a".repeat(64) }],
      recipients: [
        { name: "José", role: "signer", email: null, phone: null, idDocument: null, channels: ["email"], authMethod: "link", sentAt: null, viewedAt: null, consentedAt: null, signedAt: null, ip: null, userAgent: null, certificateSignature: true },
      ],
      events: [],
      chainHead: "c".repeat(64),
    },
  });
}

const chainOf = (id: LabIdentity) => [id.certDer, pki.intermediate.certDer, pki.root.certDer];

function signLikeDevice(id: LabIdentity, data: Uint8Array, ec: boolean) {
  const key = createPrivateKey(id.keyPem);
  // Un token PKCS#11 / Windows devuelve ECDSA como r||s: se prueba esa forma (el servidor la normaliza a DER).
  return new Uint8Array(cryptoSign("sha256", Buffer.from(data), ec ? { key, dsaEncoding: "ieee-p1363" } : key));
}

describe("identidad del certificado", () => {
  it("normaliza y compara documentos de los cinco países", () => {
    expect(normalizeIdNumber("123.456.789-09")).toBe("12345678909");
    expect(normalizeIdNumber("001-1234567-8")).toBe("00112345678");
    const c = (value: string, source: "serialNumber" | "commonName" = "serialNumber") => [{ source, value }];
    expect(matchesIdDocument("123.456.789-09", c("JOSE DA SILVA:12345678909", "commonName"))).not.toBeNull(); // CN ICP-Brasil
    expect(matchesIdDocument("12345678", c("PNOPE-12345678"))).not.toBeNull(); // DNI Perú (ETSI)
    expect(matchesIdDocument("1.020.304.050", c("IDCCO-1020304050"))).not.toBeNull(); // CC Colombia
    expect(matchesIdDocument("001-1234567-8", c("00112345678"))).not.toBeNull(); // cédula RD
    expect(matchesIdDocument("0801-1990-12345", c("0801199012345"))).not.toBeNull(); // DNI Honduras
    expect(matchesIdDocument("AB123456", c("PASSPORT AB123456 ARG", "commonName"))).not.toBeNull();
    expect(matchesIdDocument("12345678", c("PNOPE-87654321"))).toBeNull();
    expect(matchesIdDocument("123", c("123"))).toBeNull(); // demasiado corto para afirmar identidad
  });

  it("lee serialNumber y el CPF del otherName de ICP-Brasil", async () => {
    const pe = await pki.issue("JUAN PEREZ", { serialNumber: "PNOPE-12345678" });
    expect(identityCandidates(pe.certDer).some((x) => x.source === "serialNumber" && x.value === "PNOPE-12345678")).toBe(true);
    const br = await pki.issue("MARIA DA SILVA:12345678909", { icpBrasilCpf: "12345678909" });
    const cands = identityCandidates(br.certDer);
    expect(cands.find((x) => x.source === "icp-brasil-cpf")?.value).toBe("12345678909");
    expect(matchesIdDocument("123.456.789-09", cands)?.source).toBeDefined();
  });
});

describe("controles del certificado", () => {
  it("acepta un certificado de persona vigente, confiable y con el documento correcto", async () => {
    const id = await pki.issue("JUAN PEREZ", { serialNumber: "PNOPE-12345678" });
    const r = await checkSigningCertificate(chainOf(id), { trustAnchors: [pki.root.certDer], requireTrusted: true, idDocumentNumber: "12345678" });
    expect(r.errors).toEqual([]);
    expect(r.trusted).toBe(true);
    expect(r.identityMatch?.source).toBe("serialNumber");
    expect(r.chainDer.length).toBe(3);
  });

  it("rechaza documento distinto, emisor no permitido, CA y certificados no confiables cuando se exige", async () => {
    const id = await pki.issue("JUAN PEREZ", { serialNumber: "PNOPE-12345678" });
    const mismatch = await checkSigningCertificate(chainOf(id), { idDocumentNumber: "99999999" });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join(" ")).toMatch(/documento de identidad/);
    const issuer = await checkSigningCertificate(chainOf(id), { allowedIssuers: ["ICP-Brasil"] });
    expect(issuer.errors.join(" ")).toMatch(/emisor/);
    const notTrusted = await checkSigningCertificate([id.certDer], { requireTrusted: true, trustAnchors: [] });
    expect(notTrusted.ok).toBe(false);
    const ca = await checkSigningCertificate([pki.intermediate.certDer, pki.root.certDer], {});
    expect(ca.errors.join(" ")).toMatch(/autoridad certificante|firmar/);
    const expired = await checkSigningCertificate(chainOf(id), { now: new Date(Date.now() + 5 * 365 * 86400_000) });
    expect(expired.errors.join(" ")).toMatch(/vencido/);
 
    // Documento correcto pero cadena sin ancla de confianza: la identidad no queda probada.
    const untrustedId = await checkSigningCertificate(chainOf(id), { idDocumentNumber: "12345678", trustAnchors: [] });
    expect(untrustedId.ok).toBe(false);
    expect(untrustedId.errors.join(" ")).toMatch(/para verificar la identidad/);
  });
});

describe("firma en dos pasos", () => {
  for (const key of ["rsa", "ec-p256", "ec-p384"] as const) {
    it(`${key}: dos firmantes con su certificado + sello, todas válidas`, async () => {
      const a = await pki.issue(`Firmante A ${key}`, { key, serialNumber: "PNOPE-11111111" });
      const b = await pki.issue(`Firmante B ${key}`, { key: "rsa", serialNumber: "PNOPE-22222222" });
      let pdf = await basePdf();
      for (const [i, id] of [a, b].entries()) {
        const prep = await prepareExternalSignature(pdf, chainOf(id), { fieldName: `Firma${i + 1}`, reason: "Firma con certificado digital", name: `Firmante ${i}` });
        expect(prep.digestToSign.length).toBe(32);
        const sig = signLikeDevice(id, prep.signedAttrsDer, prep.signatureAlgorithm === "ECDSA");
        // Una firma ajena (otro documento) se rechaza.
        await expect(completeExternalSignature(prep, chainOf(id), signLikeDevice(id, new Uint8Array([1, 2, 3]), prep.signatureAlgorithm === "ECDSA"))).rejects.toThrow(/no corresponde/);
        pdf = await completeExternalSignature(prep, chainOf(id), sig, { tsaUrl: `${server.url}/tsr` });
      }
      const report = await validatePdf(pdf, { trustAnchors: [pki.root.certDer] });
      expect(report.signatures.length).toBe(2);
      for (const s of report.signatures) {
        expect(s.integrity.valid).toBe(true);
        expect(s.timestamp?.valid).toBe(true);
        expect(s.chain.trusted).toBe(true);
      }
      expect(report.signatures[1].coversWholeDocument).toBe(true);
      expect(report.signatures[0].modifiedAfter).toBe(true);
      expect(report.summary.allValid).toBe(true);
      expect(report.summary.allTrusted).toBe(true);

      // pdfsig (poppler/NSS) también valida la integridad de las dos firmas.
      const dir = mkdtempSync(join(tmpdir(), "certsign-"));
      writeFileSync(join(dir, "f.pdf"), pdf);
      let out = "";
      try {
        out = execFileSync("pdfsig", [join(dir, "f.pdf")], { encoding: "utf8" });
      } catch (e) {
        out = String((e as { stdout?: string }).stdout ?? "");
      }
      if (out) expect((out.match(/Signature is Valid/g) ?? []).length).toBe(2);
    }, 60_000);
  }
});
