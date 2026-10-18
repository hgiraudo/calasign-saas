import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignedXml } from "xml-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalKeyProvider } from "@calasign/pdf";
import { startLab, type LabPki, type LabServer } from "@calasign/pdf/lab";
import { DIAN_POLICY_V2, signXml, verifyXml, type XmlProfile } from "../src";

const VERIFIER = fileURLToPath(new URL("./verify_xmldsig.py", import.meta.url));

/** Verificación independiente con libxml2 (lxml) si está disponible (XMLDSIG_PYTHONPATH o lxml del sistema). */
function independent(xml: string): { valid: boolean; references?: { uri: string; valid: boolean }[]; error?: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "xmldsig-"));
  const file = join(dir, "doc.xml");
  writeFileSync(file, xml);
  try {
    const out = execFileSync("python3", [VERIFIER, file], { encoding: "utf8", env: { ...process.env, PYTHONPATH: process.env.XMLDSIG_PYTHONPATH ?? "" } });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const UBL_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1">
  <ext:UBLExtensions>
    <ext:UBLExtension><ext:ExtensionContent><sts:DianExtensions><sts:SoftwareProvider><sts:ProviderID>900123456</sts:ProviderID></sts:SoftwareProvider></sts:DianExtensions></ext:ExtensionContent></ext:UBLExtension>
    <ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>
  </ext:UBLExtensions>
  <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
  <cbc:ID>SETP990000001</cbc:ID>
  <cbc:IssueDate>2026-10-17</cbc:IssueDate>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="COP">119000.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>`;

const ECF = `<?xml version="1.0" encoding="utf-8"?>
<ECF><Encabezado><Version>1.0</Version><IdDoc><TipoeCF>31</TipoeCF><eNCF>E310000000001</eNCF></IdDoc><Emisor><RNCEmisor>101000000</RNCEmisor><RazonSocialEmisor>Empresa Ñandú SRL</RazonSocialEmisor></Emisor><Totales><MontoTotal>1180.00</MontoTotal></Totales></Encabezado><FechaHoraFirma>17-10-2026 10:00:00</FechaHoraFirma></ECF>`;

// Factura UBL 2.1 de Perú (SUNAT): la firma va en el primer ExtensionContent vacío y su Id es cac:Signature/cbc:ID.
const SUNAT_INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>F001-00000123</cbc:ID>
  <cbc:IssueDate>2026-10-17</cbc:IssueDate>
  <cbc:InvoiceTypeCode listID="0101">01</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
  <cac:Signature><cbc:ID>SignSUNAT</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>20123456789</cbc:ID></cac:PartyIdentification></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#SignSUNAT</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>Empresa Ñandú S.A.C.</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">1180.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>`;

let pki: LabPki;
let server: LabServer;
let signer: LocalKeyProvider;

beforeAll(async () => {
  ({ pki, server } = await startLab());
  const id = await pki.issue("Empresa Facturadora S.A.S.");
  signer = new LocalKeyProvider("xml", id.keyPem, id.certPem + pki.intermediate.certPem + pki.root.certPem);
}, 60_000);
afterAll(async () => server?.close());

describe("firma XML", () => {
  const cases: [XmlProfile, string][] = [
    ["dgii-ecf", ECF],
    ["dian-fe", UBL_INVOICE],
    ["xades-bes", ECF],
    ["xades-epes", UBL_INVOICE],
  ];
  for (const [profile, xml] of cases) {
    it(`${profile}: firma y verifica (propio, xml-crypto y libxml2)`, async () => {
      const signed = await signXml(xml, signer, { profile, policy: profile === "xades-epes" ? DIAN_POLICY_V2 : undefined });
      const own = verifyXml(signed);
      expect(own.errors).toEqual([]);
      expect(own.valid).toBe(true);
      if (profile === "dgii-ecf") expect(own.xades).toBeNull();
      else expect(own.xades?.signingCertificateMatches).toBe(true);
      if (profile === "dian-fe") {
        expect(own.xades?.policyIdentifier).toBe(DIAN_POLICY_V2.identifier);
        expect(own.xades?.signerRole).toBe("supplier");
        expect(own.xades?.signingTime).toMatch(/-05:00$/);
        // La firma quedó dentro del ExtensionContent vacío.
        expect(signed).toMatch(/<ext:ExtensionContent><ds:Signature /);
        expect(own.references).toHaveLength(3);
      }

      // xml-crypto como segundo verificador (misma canonicalización, otra lógica de referencias).
      const sx = new SignedXml({ publicCert: Buffer.from(own.signer ? (await signer.certificateChain())[0] : []).toString("base64").replace(/(.{64})/g, "$1\n").replace(/^/, "-----BEGIN CERTIFICATE-----\n").concat("\n-----END CERTIFICATE-----\n") });
      const sigNode = new (await import("@xmldom/xmldom")).DOMParser().parseFromString(signed, "text/xml").getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")[0];
      sx.loadSignature(sigNode as unknown as Node);
      const xc = sx.checkSignature(signed);
      const ind = independent(signed);
      if (!xc) console.log("XMLCRYPTO", profile, JSON.stringify(ind), (sx as any).validationErrors ?? "");
      expect(xc).toBe(true);
      if (ind) {
        expect(ind.error).toBeUndefined();
        expect(ind.valid).toBe(true);
      } else {
        console.warn("verificador libxml2 no disponible (definir XMLDSIG_PYTHONPATH con lxml)");
      }

      // Alterar un dato firmado rompe la verificación.
      const tampered = signed.replace(/119000\.00|1180\.00/, "999999.00");
      expect(verifyXml(tampered).valid).toBe(false);
    });
  }

  it("sunat-cpe: XMLDSig RSA-SHA1 en el primer ExtensionContent, Id de cac:Signature (propio, xml-crypto y libxml2)", async () => {
    const signed = await signXml(SUNAT_INVOICE, signer, { profile: "sunat-cpe" });
    const own = verifyXml(signed);
    expect(own.errors).toEqual([]);
    expect(own.valid).toBe(true);
    expect(own.xades).toBeNull();
    expect(signed).toMatch(/<ext:ExtensionContent><ds:Signature [^>]*Id="SignSUNAT"/);
    expect(signed).toContain('SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"');
    expect(signed).toContain('DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"');
    expect(own.references).toHaveLength(1);

    const pem = Buffer.from((await signer.certificateChain())[0]).toString("base64").replace(/(.{64})/g, "$1\n");
    const sx = new SignedXml({ publicCert: `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----\n` });
    const sigNode = new (await import("@xmldom/xmldom")).DOMParser().parseFromString(signed, "text/xml").getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature")[0];
    sx.loadSignature(sigNode as unknown as Node);
    expect(sx.checkSignature(signed)).toBe(true);
    const ind = independent(signed);
    if (ind) expect(ind.valid).toBe(true);

    expect(verifyXml(signed.replace("1180.00", "9999.00")).valid).toBe(false);
  });

  it("sunat-cpe: admite RSA-SHA256 si el OSE lo acepta, y exige un ExtensionContent vacío", async () => {
    const signed = await signXml(SUNAT_INVOICE, signer, { profile: "sunat-cpe", signatureAlgorithm: "rsa-sha256" });
    expect(verifyXml(signed).valid).toBe(true);
    expect(signed).toContain("xmldsig-more#rsa-sha256");
    const sinExtension = SUNAT_INVOICE.replace("<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>", "");
    await expect(signXml(sinExtension, signer, { profile: "sunat-cpe" })).rejects.toThrow(/ExtensionContent/);
  });

  it("sunat-cpe: un cbc:ID con comillas o & se escapa en el Id de la firma", async () => {
    const xml = SUNAT_INVOICE.replace("<cbc:ID>SignSUNAT</cbc:ID>", '<cbc:ID>Sign"A&amp;B</cbc:ID>');
    const signed = await signXml(xml, signer, { profile: "sunat-cpe" });
    expect(signed).toContain('Id="Sign&quot;A&amp;B"');
    const own = verifyXml(signed);
    expect(own.errors).toEqual([]);
    expect(own.valid).toBe(true);
    const ind = independent(signed);
    if (ind) expect(ind.valid).toBe(true);
  });

  it("dian-fe: sin un ExtensionContent vacío no firma en la raíz (la DIAN lo rechazaría)", async () => {
    const sinLugar = UBL_INVOICE.replace("<ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>", "");
    expect(sinLugar).not.toBe(UBL_INVOICE);
    await expect(signXml(sinLugar, signer, { profile: "dian-fe" })).rejects.toThrow(/ExtensionContent/);
  });

  it("una ds:Signature sin SignedInfo es inválida, no un error", () => {
    const r = verifyXml('<a><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>AA==</ds:SignatureValue></ds:Signature></a>');
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/SignedInfo/);
  });

  it("un Id repetido (signature wrapping) invalida la verificación", async () => {
    const signed = await signXml(UBL_INVOICE, signer, { profile: "dian-fe" });
    expect(verifyXml(signed).valid).toBe(true);
    const m = /<xades:SignedProperties Id="([^"]+)"/.exec(signed);
    expect(m).toBeTruthy();
    // Se agrega en el documento un elemento con el mismo Id que SignedProperties.
    const wrapped = signed.replace("<cbc:UBLVersionID>", `<cbc:Note Id="${m![1]}">otra cosa</cbc:Note><cbc:UBLVersionID>`);
    const r = verifyXml(wrapped);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Id repetido/);
  });

  it("un SignedProperties sin firmar agregado en otro ds:Object no reemplaza las propiedades firmadas", async () => {
    const signed = await signXml(UBL_INVOICE, signer, { profile: "dian-fe" });
    const real = verifyXml(signed);
    expect(real.valid).toBe(true);
    // Se agrega, antes del ds:Object real, uno con propiedades falsas (sin Id: ninguna referencia lo cubre).
    const forged = signed.replace(
      "<ds:Object>",
      `<ds:Object><xades:QualifyingProperties><xades:SignedProperties><xades:SignedSignatureProperties><xades:SigningTime>1999-01-01T00:00:00Z</xades:SigningTime></xades:SignedSignatureProperties></xades:SignedProperties></xades:QualifyingProperties></ds:Object><ds:Object>`,
    );
    const r = verifyXml(forged);
    expect(r.xades?.signingTime).toBe(real.xades?.signingTime);
    expect(r.valid).toBe(false);
  });

  it("XAdES-EPES sin política es un error", async () => {
    await expect(signXml(ECF, signer, { profile: "xades-epes" })).rejects.toThrow(/política/);
  });
});
