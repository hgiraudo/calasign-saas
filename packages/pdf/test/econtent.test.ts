import { sign } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { assembleCms, generateDevRootCa, issueSealCertificate, pemToDerList, prepareExternalSignature, validatePdf } from "../src";
import { signedContent } from "../src/signatures";

const toAB = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function pdfWith(text: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 14, font });
  return doc.save();
}

// Un CMS con contenido incrustado (eContent): pkijs verifica la firma sobre ese contenido e ignora el del PDF. Una
// firma hecha por otra persona sobre otro documento no puede validar como firma de este.
describe("CMS con contenido incrustado", () => {
  it("una firma sobre otro contenido no valida en este PDF", async () => {
    const ca = await generateDevRootCa("Raíz de prueba");
    const victim = await issueSealCertificate(ca, { commonName: "Víctima" });
    const victimDer = pemToDerList(victim.certPem)[0];

    // La víctima firma (legítimamente) otro documento.
    const other = await prepareExternalSignature(await pdfWith("Algo que la víctima firmó"), [victimDer], { fieldName: "Firma1" });
    const signature = new Uint8Array(sign("sha256", Buffer.from(other.signedAttrsDer), victim.keyPem!));
    const cms = await assembleCms({ signedAttrsDer: other.signedAttrsDer, chainDer: [victimDer], signature, signatureAlgorithm: "RSASSA-PKCS1-v1_5" });
    // Se incrusta el contenido que sí firmó.
    const ci = pkijs.ContentInfo.fromBER(toAB(cms));
    const sd = new pkijs.SignedData({ schema: ci.content });
    sd.encapContentInfo = new pkijs.EncapsulatedContentInfo({
      eContentType: "1.2.840.113549.1.7.1",
      eContent: new asn1js.OctetString({ valueHex: toAB(signedContent(other.preparedPdf, other.byteRange)) }),
    });
    const forged = new Uint8Array(new pkijs.ContentInfo({ contentType: ci.contentType, content: sd.toSchema(true) }).toSchema().toBER(false));

    // Y se pega en el PDF del atacante.
    const target = await prepareExternalSignature(await pdfWith("Deuda a favor del atacante"), [victimDer], { fieldName: "Firma1" });
    const [, start, end] = target.byteRange;
    const buf = Buffer.from(target.preparedPdf);
    buf.write(Buffer.from(forged).toString("hex").padEnd(end - start - 2, "0"), start + 1, "latin1");

    const report = await validatePdf(new Uint8Array(buf), { trustAnchors: pemToDerList(ca.certPem) });
    expect(report.signatures[0].integrity.valid).toBe(false);
    expect(report.summary.allValid).toBe(false);
  }, 60_000);
});
