import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CscSignatureProvider,
  LocalKeyProvider,
  addCadesSignatureIncremental,
  applyLtv,
  defaultSealLevel,
  finalizeEnvelopePdf,
  parseCert,
  pemToDerList,
  serialHex,
  validatePdf,
} from "../src";
import { startLab, type LabPki, type LabServer } from "../src/lab";
import { startMockCsc } from "../src/csc-mock";

let pki: LabPki;
let server: LabServer;

beforeAll(async () => {
  ({ pki, server } = await startLab());
}, 60_000);
afterAll(async () => server?.close());

async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrato LTV", { x: 50, y: 780, size: 14, font });
  return doc.save();
}

async function sealedBT(provider: LocalKeyProvider) {
  const now = new Date().toISOString();
  return finalizeEnvelopePdf(
    {
      documents: [{ name: "a.pdf", bytes: await samplePdf() }],
      fields: [],
      certificate: {
        envelopeId: "0192f0e0-0000-7000-8000-0000000000aa",
        subject: "LTV",
        organizationName: "ACME",
        senderName: "Ana",
        senderEmail: null,
        createdAt: now,
        sentAt: now,
        completedAt: now,
        locale: "es",
        documents: [{ name: "a.pdf", pageCount: 1, sha256: "a".repeat(64) }],
        recipients: [],
        events: [],
        chainHead: "c".repeat(64),
      },
    },
    { provider, tsaUrl: `${server.url}/tsr` },
  );
}

/** pdfsig con una base NSS que confía en la raíz del laboratorio. */
function pdfsig(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nss-"));
  writeFileSync(join(dir, "root.pem"), pki.root.certPem);
  execFileSync("certutil", ["-N", "-d", `sql:${dir}`, "--empty-password"]);
  execFileSync("certutil", ["-A", "-n", "calasign-lab-root", "-t", "CT,C,C", "-i", join(dir, "root.pem"), "-d", `sql:${dir}`]);
  try {
    // -no-ocsp: el OCSP del laboratorio corre en este mismo proceso (execFileSync bloquea el event loop).
    return execFileSync("pdfsig", ["-no-ocsp", "-nssdir", `sql:${dir}`, file], { encoding: "utf8", timeout: 60_000 });
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? e);
  }
}

describe("PAdES B-LT / B-LTA", () => {
  it("la cadena del laboratorio publica OCSP/CRL → nivel por defecto B-LT", () => {
    expect(defaultSealLevel(pemToDerList(pki.sealChainPem), true)).toBe("B-LT");
    expect(defaultSealLevel(pemToDerList(pki.sealChainPem), false)).toBe("B-B");
  });

  it("sello B-T + sello de empresa + DSS + sello de documento, todo válido y de confianza", async () => {
    const seal = new LocalKeyProvider("lab-seal", pki.seal.keyPem, pki.sealChainPem);
    let pdf = await sealedBT(seal);
    const company = await pki.issue("ACME S.A. Sello de empresa");
    const companyProvider = new LocalKeyProvider("company", company.keyPem, company.certPem + pki.intermediate.certPem + pki.root.certPem);
    pdf = await addCadesSignatureIncremental(pdf, companyProvider, { fieldName: "SelloEmpresa", reason: "Sello de empresa", tsaUrl: `${server.url}/tsr` });
    const { pdf: lta, report } = await applyLtv(pdf, { level: "B-LTA", tsaUrl: `${server.url}/tsr` });
    expect(report.missingRevocation).toEqual([]);
    expect(report.ocsps).toBeGreaterThanOrEqual(3); // sello, empresa, TSA
    expect(report.crls).toBeGreaterThanOrEqual(1); // intermedia (CRL de la raíz)

    const v = await validatePdf(lta, { trustAnchors: [pki.root.certDer] });
    expect(v.signatures).toHaveLength(3);
    expect(v.summary.allValid).toBe(true);
    expect(v.summary.allTrusted).toBe(true);
    expect(v.summary.anyRevoked).toBe(false);
    const [s1, s2, ts] = v.signatures;
    expect(s1.level).toBe("B-LTA");
    expect(s2.level).toBe("B-LTA");
    expect(s1.modifiedAfter).toBe(true);
    expect(ts.kind).toBe("document_timestamp");
    expect(ts.coversWholeDocument).toBe(true);
    expect(s1.timestamp?.valid).toBe(true);
    expect(s1.chain.entries[0].revocation).toMatchObject({ status: "good", source: "dss-ocsp" });
    expect(s1.chain.entries[1].revocation).toMatchObject({ status: "good", source: "dss-crl" });
    expect(s2.signer?.commonName).toBe("ACME S.A. Sello de empresa");

    const dir = mkdtempSync(join(tmpdir(), "ltv-"));
    const file = join(dir, "lta.pdf");
    writeFileSync(file, lta);
    const out = pdfsig(file);
    console.log(out);
    expect(out.match(/Signature Validation: Signature is Valid/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(out.match(/Certificate Validation: Certificate is Trusted/g)?.length ?? 0).toBe(2);
  }, 120_000);

  it("detecta un certificado revocado (CRL/OCSP del DSS) y una alteración posterior", async () => {
    const company = await pki.issue("Empresa Revocada");
    const provider = new LocalKeyProvider("rev", company.keyPem, company.certPem + pki.intermediate.certPem + pki.root.certPem);
    const bt = await sealedBT(provider);
    pki.revoked.add(serialHex(parseCert(company.certDer)));
    const { pdf } = await applyLtv(bt, { level: "B-LT" });
    const v = await validatePdf(pdf, { trustAnchors: [pki.root.certDer] });
    expect(v.summary.anyRevoked).toBe(true);
    expect(v.signatures[0].level).toBe("B-LT");

    // Alterar un byte dentro del rango firmado invalida la integridad.
    const tampered = new Uint8Array(pdf);
    const idx = Buffer.from(tampered).indexOf("(CalaSign)");
    expect(idx).toBeGreaterThan(0);
    tampered[idx + 1] = "K".charCodeAt(0);
    const v2 = await validatePdf(tampered, { trustAnchors: [pki.root.certDer] });
    expect(v2.signatures[0].integrity.valid).toBe(false);
  }, 120_000);

  it("firma remota por CSC v2 (servidor de prueba)", async () => {
    const holder = await pki.issue("Juana Pérez (CSC)");
    const chainDer = [holder.certDer, pki.intermediate.certDer, pki.root.certDer];
    const csc = await startMockCsc({ username: "u", password: "p", pin: "1234", credentials: { "cred-1": { identity: holder, chainDer } } });
    try {
      const provider = new CscSignatureProvider({ id: "csc:mock", baseUrl: csc.url, auth: { type: "basic", username: "u", password: "p" }, pin: "1234" });
      const pdf = await sealedBT(provider as unknown as LocalKeyProvider);
      const v = await validatePdf(pdf, { trustAnchors: [pki.root.certDer], online: true });
      expect(v.signatures[0].integrity.valid).toBe(true);
      expect(v.signatures[0].signer?.commonName).toBe("Juana Pérez (CSC)");
      expect(v.signatures[0].chain.trusted).toBe(true);
      expect(v.signatures[0].chain.entries[0].revocation.source).toBe("online-ocsp");
      expect(csc.calls).toEqual(expect.arrayContaining(["auth/login", "credentials/list", "credentials/info", "credentials/authorize", "signatures/signHash"]));
      const bad = new CscSignatureProvider({ id: "csc:mock", baseUrl: csc.url, auth: { type: "basic", username: "u", password: "p" }, pin: "0000" });
      await expect(bad.signDigest(new Uint8Array(32))).rejects.toThrow(/PIN/);
    } finally {
      await csc.close();
    }
  }, 120_000);
});

