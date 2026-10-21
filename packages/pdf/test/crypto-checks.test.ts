// Controles criptográficos antes de incrustar: sello de tiempo de la TSA (firma, EKU, vigencia), firma del sello contra
// el certificado de su cadena, y cadena de un sello de documento que no verifica.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LocalKeyProvider,
  SignatureKeyMismatchError,
  TsaError,
  addSignatureIncremental,
  buildPadesCms,
  generateDevRootCa,
  issueSealCertificate,
  requestTimestampToken,
  sha256,
  validatePdf,
} from "../src";
import { startLab, startLabServer, type LabPki, type LabServer } from "../src/lab";
import { asn1js, pkijs, toAB } from "../src/pki";

let pki: LabPki;
let server: LabServer;
const extra: LabServer[] = [];

beforeAll(async () => {
  ({ pki, server } = await startLab());
}, 60_000);
afterAll(async () => {
  await server?.close();
  for (const s of extra) await s.close();
});

async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contrato", { x: 50, y: 780, size: 14, font });
  return doc.save();
}

describe("sello de tiempo de la TSA verificado antes de incrustarlo", () => {
  it("token firmado con una clave que no es la del certificado de la TSA → TsaError", async () => {
    const bad = await startLabServer({ ...pki, tsa: { ...pki.tsa, key: pki.seal.key } });
    extra.push(bad);
    const seal = new LocalKeyProvider("lab-seal", pki.seal.keyPem, pki.sealChainPem);
    await expect(buildPadesCms(new Uint8Array([1, 2, 3]), seal, { tsaUrl: `${bad.url}/tsr` })).rejects.toThrow(TsaError);
    await expect(buildPadesCms(new Uint8Array([1, 2, 3]), seal, { tsaUrl: `${bad.url}/tsr` })).rejects.toThrow(/no verifica/);
  });

  it("certificado de TSA sin uso extendido timeStamping → TsaError", async () => {
    const noEku = await pki.issue("TSA sin EKU");
    const bad = await startLabServer({ ...pki, tsa: noEku });
    extra.push(bad);
    const data = new Uint8Array([9, 9, 9]);
    await expect(requestTimestampToken(`${bad.url}/tsr`, sha256(data), null, data)).rejects.toThrow(/timeStamping/);
    await expect(requestTimestampToken(`${bad.url}/tsr`, sha256(data), null, data)).rejects.toBeInstanceOf(TsaError);
  });

  it("la TSA del laboratorio pasa los controles", async () => {
    const data = new Uint8Array([7, 7, 7]);
    const token = await requestTimestampToken(`${server.url}/tsr`, sha256(data), null, data);
    expect(token.length).toBeGreaterThan(100);
  });
});

describe("firma del sello contra el certificado de su cadena", () => {
  it("clave que no corresponde al primer certificado de la cadena → SignatureKeyMismatchError", async () => {
    const ca = await generateDevRootCa("Root de prueba");
    const a = await issueSealCertificate(ca, { commonName: "Sello A" });
    const b = await issueSealCertificate(ca, { commonName: "Sello B" });
    const mismatched = new LocalKeyProvider("platform-seal", b.keyPem!, a.chainPem);
    await expect(buildPadesCms(new Uint8Array([1]), mismatched, {})).rejects.toBeInstanceOf(SignatureKeyMismatchError);
    await expect(buildPadesCms(new Uint8Array([1]), mismatched, {})).rejects.toThrow(/no verifica con la clave pública/);
    const ok = new LocalKeyProvider("platform-seal", a.keyPem!, a.chainPem);
    expect((await buildPadesCms(new Uint8Array([1]), ok, {})).length).toBeGreaterThan(100);
  });
});

describe("sello de documento que no verifica", () => {
  it("no se arma su cadena ni cuenta como confiable", async () => {
    const pdf = await addSignatureIncremental(await samplePdf(), {
      type: "DocTimeStamp",
      fieldName: "DocTimeStamp1",
      signatureLength: 12_000,
      sign: async (content) => {
        const token = await requestTimestampToken(`${server.url}/tsr`, sha256(content), null, content);
        // Se altera la firma del token: el sello deja de verificar (integridad inválida).
        const ci = pkijs.ContentInfo.fromBER(toAB(token));
        const sd = new pkijs.SignedData({ schema: ci.content });
        const sig = new Uint8Array(sd.signerInfos[0].signature.valueBlock.valueHexView);
        sig[10] ^= 0xff;
        sd.signerInfos[0].signature = new asn1js.OctetString({ valueHex: toAB(sig) });
        return new Uint8Array(new pkijs.ContentInfo({ contentType: ci.contentType, content: sd.toSchema(true) }).toSchema().toBER(false));
      },
    });
    const v = await validatePdf(pdf, { trustAnchors: [pki.root.certDer] });
    expect(v.signatures).toHaveLength(1);
    const [ts] = v.signatures;
    expect(ts.kind).toBe("document_timestamp");
    expect(ts.integrity.valid).toBe(false);
    expect(ts.chain.trusted).toBe(false);
    expect(ts.chain.entries).toEqual([]);
    expect(v.summary.allTrusted).toBe(false);
  });
});
