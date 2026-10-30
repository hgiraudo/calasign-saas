// Revocación del certificado de la TSA en el validador. Antes no se miraba: un sello de tiempo de una TSA revocada (o
// con la clave comprometida, que permite emitir sellos antedatados) seguía "de confianza" y fijaba la fecha con la que
// se valida la cadena del firmante. Con la PKI de laboratorio (OCSP, CRL y TSA locales).
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalKeyProvider, finalizeEnvelopePdf, parseCert, serialHex, validatePdf } from "../src";
import { startLab, type LabPki, type LabServer } from "../src/lab";
import { fetchCrl, fetchOcsp, statusFromCrl, statusFromOcsp } from "../src/pki";

let pki: LabPki;
let server: LabServer;
let tsaSerial = "";
const DAY = 86400_000;

beforeAll(async () => {
  ({ pki, server } = await startLab());
  tsaSerial = serialHex(parseCert(pki.tsa.certDer));
}, 60_000);
afterAll(async () => server?.close());
afterEach(() => {
  pki.revoked.delete(tsaSerial);
  pki.revocationInfo.delete(tsaSerial);
});

/** PDF sellado por el laboratorio con sello de tiempo de la TSA del laboratorio (B-T). */
async function sealedWithTimestamp() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrato TSA", { x: 50, y: 780, size: 14, font });
  const now = new Date().toISOString();
  return finalizeEnvelopePdf(
    {
      documents: [{ name: "a.pdf", bytes: await doc.save() }],
      fields: [],
      certificate: {
        envelopeId: "0192f0e0-0000-7000-8000-0000000000bb",
        subject: "TSA",
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
    { provider: new LocalKeyProvider("lab-seal", pki.seal.keyPem, pki.sealChainPem), tsaUrl: `${server.url}/tsr` },
  );
}

const revokeTsa = (at: Date, reason?: number) => {
  pki.revoked.add(tsaSerial);
  pki.revocationInfo.set(tsaSerial, { at, ...(reason !== undefined ? { reason } : {}) });
};

describe("motivo de revocación (CRLReason)", () => {
  it("se lee del OCSP y de la CRL", async () => {
    revokeTsa(new Date(Date.now() - DAY), 1);
    const tsa = parseCert(pki.tsa.certDer);
    const issuer = parseCert(pki.intermediate.certDer);
    const ocsp = await fetchOcsp(tsa, issuer);
    expect(await statusFromOcsp(ocsp!, tsa, issuer)).toMatchObject({ status: "revoked", reason: 1 });
    const crl = await fetchCrl(tsa);
    expect(await statusFromCrl(crl!, tsa, issuer)).toMatchObject({ status: "revoked", reason: 1 });
  });

  it("sin motivo en la respuesta: null", async () => {
    revokeTsa(new Date(Date.now() - DAY));
    const tsa = parseCert(pki.tsa.certDer);
    const issuer = parseCert(pki.intermediate.certDer);
    expect((await statusFromOcsp((await fetchOcsp(tsa, issuer))!, tsa, issuer))?.reason ?? null).toBeNull();
    expect((await statusFromCrl((await fetchCrl(tsa))!, tsa, issuer))?.reason ?? null).toBeNull();
  });
});

describe("sello de tiempo de una TSA revocada", () => {
  const anchors = () => ({ trustAnchors: [pki.root.certDer], online: true });

  it("sin revocación: el sello es de confianza", async () => {
    const v = await validatePdf(await sealedWithTimestamp(), anchors());
    expect(v.signatures[0].timestamp).toMatchObject({ valid: true, trusted: true });
  }, 60_000);

  it("revocada antes de emitir el sello: no es de confianza y se avisa", async () => {
    revokeTsa(new Date(Date.now() - DAY));
    const v = await validatePdf(await sealedWithTimestamp(), anchors());
    expect(v.signatures[0].timestamp).toMatchObject({ valid: true, trusted: false });
    expect(v.signatures[0].warnings?.join(" ")).toMatch(/TSA.*revocado/);
  }, 60_000);

  it("revocada después del sello por un motivo común: el sello sigue valiendo", async () => {
    const pdf = await sealedWithTimestamp();
    revokeTsa(new Date(Date.now() + DAY), 5); // cessationOfOperation, con fecha posterior al sello
    const v = await validatePdf(pdf, anchors());
    expect(v.signatures[0].timestamp).toMatchObject({ valid: true, trusted: true });
  }, 60_000);

  it("revocada después del sello por compromiso de clave: no es de confianza (pudo antedatarse)", async () => {
    const pdf = await sealedWithTimestamp();
    revokeTsa(new Date(Date.now() + DAY), 1); // keyCompromise
    const v = await validatePdf(pdf, anchors());
    expect(v.signatures[0].timestamp).toMatchObject({ valid: true, trusted: false });
  }, 60_000);
});
