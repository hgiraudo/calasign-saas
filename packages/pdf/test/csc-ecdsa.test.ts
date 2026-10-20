// Firma remota CSC con una credencial ECDSA: signAlgo según la clave del certificado, verificación de la firma
// devuelta sobre el digest y CMS con ecdsa-with-SHA256.
import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CscSignatureProvider, addCadesSignatureIncremental, cscSignAlgoFor, validatePdf, verifyEcdsaDigest } from "../src";
import { startLab, type LabPki, type LabServer } from "../src/lab";
import { startMockCsc } from "../src/csc-mock";

let pki: LabPki;
let server: LabServer;

beforeAll(async () => {
  ({ pki, server } = await startLab());
}, 60_000);
afterAll(async () => server?.close());

const sha = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());

async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrato CSC ECDSA", { x: 50, y: 780, size: 14, font });
  return doc.save();
}

describe("ECDSA sobre un digest", () => {
  for (const key of ["ec-p256", "ec-p384"] as const) {
    it(`verifica firmas DER y r||s (${key})`, async () => {
      const id = await pki.issue(`Titular ${key}`, { key });
      const data = Buffer.from("datos firmados");
      const pk = createPrivateKey(id.keyPem);
      const der = new Uint8Array(cryptoSign("sha256", data, { key: pk, dsaEncoding: "der" }));
      const p1363 = new Uint8Array(cryptoSign("sha256", data, { key: pk, dsaEncoding: "ieee-p1363" }));
      expect(verifyEcdsaDigest(id.certDer, sha(data), der)).toBe(true);
      expect(verifyEcdsaDigest(id.certDer, sha(data), p1363)).toBe(true);
      expect(verifyEcdsaDigest(id.certDer, sha("otros datos"), der)).toBe(false);
      const other = await pki.issue("Otra clave", { key });
      expect(verifyEcdsaDigest(other.certDer, sha(data), der)).toBe(false);
      expect(cscSignAlgoFor(id.certDer).signAlgo).toBe("1.2.840.10045.4.3.2");
    }, 60_000);
  }

  it("RSA sigue pidiendo sha256WithRSA", async () => {
    const id = await pki.issue("Titular RSA");
    expect(cscSignAlgoFor(id.certDer)).toMatchObject({ signAlgo: "1.2.840.113549.1.1.11", ecdsa: false });
  }, 60_000);
});

describe("CSC con credencial ECDSA", () => {
  it("firma, verifica y el PDF valida", async () => {
    const holder = await pki.issue("Juana ECDSA (CSC)", { key: "ec-p256" });
    const chainDer = [holder.certDer, pki.intermediate.certDer, pki.root.certDer];
    const csc = await startMockCsc({ username: "u", password: "p", pin: "1234", credentials: { "cred-1": { identity: holder, chainDer } } });
    try {
      const provider = new CscSignatureProvider({ id: "csc:mock", baseUrl: csc.url, auth: { type: "basic", username: "u", password: "p" }, pin: "1234" });
      const digest = sha("hola");
      const sig = await provider.signDigest(digest);
      expect(sig[0]).toBe(0x30); // DER
      expect(verifyEcdsaDigest(holder.certDer, digest, sig)).toBe(true);
      const pdf = await addCadesSignatureIncremental(await samplePdf(), provider, { fieldName: "FirmaCSC", reason: "Firma remota" });
      const v = await validatePdf(pdf, { trustAnchors: [pki.root.certDer] });
      expect(v.signatures).toHaveLength(1);
      expect(v.signatures[0].integrity.valid).toBe(true);
      expect(v.signatures[0].signer?.commonName).toBe("Juana ECDSA (CSC)");
    } finally {
      await csc.close();
    }
    // Un prestador que firma con otra clave ECDSA: se rechaza.
    const other = await pki.issue("Otra ECDSA (CSC)", { key: "ec-p256" });
    const liar = await startMockCsc({ username: "u", password: "p", pin: "1234", credentials: { "cred-1": { identity: holder, chainDer: [other.certDer, pki.intermediate.certDer, pki.root.certDer] } } });
    try {
      const p2 = new CscSignatureProvider({ id: "csc:mock", baseUrl: liar.url, auth: { type: "basic", username: "u", password: "p" }, pin: "1234" });
      await expect(p2.signDigest(new Uint8Array(32).fill(7))).rejects.toThrow(/no corresponde al certificado/);
    } finally {
      await liar.close();
    }
  }, 120_000);
});
