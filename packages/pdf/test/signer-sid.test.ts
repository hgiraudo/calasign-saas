import { createHash, sign } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { assembleCms, generateDevRootCa, issueSealCertificate, pemToDerList, prepareExternalSignature, validatePdf } from "../src";

const toAB = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

// Un CMS cuyo SignerInfo identifica al firmante por subjectKeyIdentifier (CMS v3) debe informarse a nombre del
// certificado cuya clave verifica la firma, no del primero de la lista: si no, la firma con la clave de un
// atacante se mostraría como firmada (y con cadena de confianza) por otra persona.
describe("firmante identificado por subjectKeyIdentifier", () => {
  it("se informa el certificado cuya clave firmó, no el primero del CMS", async () => {
    const ca = await generateDevRootCa("Raíz de prueba");
    const victim = await issueSealCertificate(ca, { commonName: "Víctima" });
    const attacker = await generateDevRootCa("Atacante");
    const victimDer = pemToDerList(victim.certPem)[0];
    const attackerDer = pemToDerList(attacker.certPem)[0];

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText("Contrato", { x: 50, y: 780, size: 14, font });
    const prepared = await prepareExternalSignature(await doc.save(), [attackerDer], { fieldName: "Firma1" });
    const signature = new Uint8Array(sign("sha256", Buffer.from(prepared.signedAttrsDer), attacker.keyPem));
    const cms = await assembleCms({ signedAttrsDer: prepared.signedAttrsDer, chainDer: [attackerDer], signature, signatureAlgorithm: "RSASSA-PKCS1-v1_5" });

    // sid = subjectKeyIdentifier del atacante; certificados = [víctima, atacante].
    const ci = pkijs.ContentInfo.fromBER(toAB(cms));
    const sd = new pkijs.SignedData({ schema: ci.content });
    const attackerCert = pkijs.Certificate.fromBER(toAB(attackerDer));
    const ski = createHash("sha1").update(attackerCert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView).digest();
    sd.signerInfos[0].version = 3;
    sd.signerInfos[0].sid = new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 }, valueHex: toAB(new Uint8Array(ski)) });
    sd.version = 3;
    sd.certificates = [pkijs.Certificate.fromBER(toAB(victimDer)), attackerCert];
    const forged = new Uint8Array(new pkijs.ContentInfo({ contentType: ci.contentType, content: sd.toSchema(true) }).toSchema().toBER(false));

    const [, start, end] = prepared.byteRange;
    const buf = Buffer.from(prepared.preparedPdf);
    buf.write(Buffer.from(forged).toString("hex").padEnd(end - start - 2, "0"), start + 1, "latin1");

    const report = await validatePdf(new Uint8Array(buf), { trustAnchors: pemToDerList(ca.certPem) });
    const s = report.signatures[0];
    expect(s.integrity.valid).toBe(true);
    expect(s.signer?.commonName).toBe("Atacante");
    expect(s.chain.trusted).toBe(false);
    expect(report.summary.allTrusted).toBe(false);
  }, 60_000);
});
