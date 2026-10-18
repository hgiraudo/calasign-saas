import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CscSignatureProvider,
  IncrementalUpdate,
  addSignatureIncremental,
  buildPadesCms,
  generateDevRootCa,
  issueSealCertificate,
  addDssIncremental,
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
    expect(s1.changesAfter).toBe("evidence_only");
    expect(s2.changesAfter).toBe("evidence_only");
    expect(ts.changesAfter).toBe("none");
    expect(v.summary.modifiedAfterSigning).toBe(false);
    expect(ts.kind).toBe("document_timestamp");
    expect(ts.coversWholeDocument).toBe(true);
    expect(s1.timestamp?.valid).toBe(true);
    expect(s1.timestamp?.trusted).toBe(true);
    expect(s1.chain.revoked).toBe(false);
    expect(s1.chain.entries[0].revocation).toMatchObject({ status: "good", source: "dss-ocsp" });
    expect(s1.chain.entries[1].revocation).toMatchObject({ status: "good", source: "dss-crl" });
    expect(s2.signer?.commonName).toBe("ACME S.A. Sello de empresa");

    // Sin raíz de confianza, el sello de tiempo sigue verificando pero no cuenta como prueba de existencia.
    const untrusted = await validatePdf(lta, {});
    expect(untrusted.signatures[0].timestamp?.valid).toBe(true);
    expect(untrusted.signatures[0].timestamp?.trusted).toBe(false);
    expect(untrusted.summary.allTrusted).toBe(false);

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

  it("detecta una revisión posterior que cambia el contenido (incremental saving attack)", async () => {
    const seal = new LocalKeyProvider("lab-seal", pki.seal.keyPem, pki.sealChainPem);
    const signed = await sealedBT(seal);
    const ok = await validatePdf(signed, { trustAnchors: [pki.root.certDer] });
    expect(ok.summary).toMatchObject({ allValid: true, modifiedAfterSigning: false });

    // Revisión incremental que reemplaza el contenido de la primera página: la firma sigue verificando sobre su revisión.
    const u = await IncrementalUpdate.open(signed);
    const page = u.doc.getPages()[0];
    const ref = u.add(u.context.flateStream("BT /F1 24 Tf 50 700 Td (Monto: 1.000.000) Tj ET"));
    page.node.set(PDFName.of("Contents"), ref);
    u.touch(page.ref);
    const altered = u.serialize();
    const v = await validatePdf(altered, { trustAnchors: [pki.root.certDer] });
    expect(v.signatures[0].integrity.valid).toBe(true);
    expect(v.signatures[0].changesAfter).toBe("content");
    expect(v.summary.modifiedAfterSigning).toBe(true);
    expect(v.summary.allValid).toBe(false);

    // Una anotación nueva (texto superpuesto) también cambia lo que se ve.
    const u2 = await IncrementalUpdate.open(signed);
    const p2 = u2.doc.getPages()[0];
    const annot = u2.add(u2.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [50, 700, 300, 730], Contents: PDFString.of("Anulado") }));
    p2.node.set(PDFName.of("Annots"), u2.context.obj([annot]));
    u2.touch(p2.ref);
    const v2 = await validatePdf(u2.serialize(), { trustAnchors: [pki.root.certDer] });
    expect(v2.signatures[0].changesAfter).toBe("content");
    expect(v2.summary.allValid).toBe(false);

    // Agregar solo evidencia (DSS) no cuenta como cambio.
    const withDss = await addDssIncremental(signed, { certs: [pki.root.certDer], ocsps: [], crls: [] });
    const v3 = await validatePdf(withDss, { trustAnchors: [pki.root.certDer] });
    expect(v3.signatures[0].changesAfter).toBe("evidence_only");
    expect(v3.summary.allValid).toBe(true);
  }, 120_000);

  it("una revisión posterior con un objeto duplicado se evalúa como la ve un lector (por el xref)", async () => {
    const seal = new LocalKeyProvider("lab-seal", pki.seal.keyPem, pki.sealChainPem);
    const signed = await sealedBT(seal);
    // Revisión que cambia el contenido de la página (el xref apunta a la página alterada)…
    const u = await IncrementalUpdate.open(signed);
    const page = u.doc.getPages()[0];
    const original = (await PDFDocument.load(signed, { updateMetadata: false })).getPages()[0].node.toString();
    const ref = u.add(u.context.flateStream("BT /F1 24 Tf 50 700 Td (Monto: 1.000.000) Tj ET"));
    page.node.set(PDFName.of("Contents"), ref);
    u.touch(page.ref);
    const altered = Buffer.from(u.serialize());
    // …y deja después una copia del objeto de página original que el xref no referencia. pdf-lib se queda con la última
    // definición en el archivo; un lector, con la que indica el xref.
    const xrefAt = altered.lastIndexOf("xref\n", altered.lastIndexOf("startxref"));
    const copy = Buffer.from(`${page.ref.objectNumber} ${page.ref.generationNumber} obj\n${original}\nendobj\n`, "latin1");
    const tail = altered.subarray(xrefAt).toString("latin1").replace(/startxref\n(\d+)/, (_, n) => `startxref\n${Number(n) + copy.length}`);
    const shadowed = new Uint8Array(Buffer.concat([altered.subarray(0, xrefAt), copy, Buffer.from(tail, "latin1")]));
    const v = await validatePdf(shadowed, { trustAnchors: [pki.root.certDer] });
    expect(v.signatures[0].integrity.valid).toBe(true);
    expect(v.signatures[0].changesAfter).toBe("content");
    expect(v.summary.allValid).toBe(false);
  }, 120_000);

  it("una firma posterior visible o un cambio de capas en el catálogo no pasan como evidencia", async () => {
    const seal = new LocalKeyProvider("lab-seal", pki.seal.keyPem, pki.sealChainPem);
    const signed = await sealedBT(seal);
    // Firmante cualquiera con un certificado autofirmado: su firma verifica criptográficamente (no es de confianza).
    const ca = await generateDevRootCa("Atacante");
    const own = await issueSealCertificate(ca, { commonName: "Atacante" });
    const attacker = new LocalKeyProvider("attacker", own.keyPem!, own.chainPem);
    const later = (extra: { widgetRect?: [number, number, number, number]; appearance?: string }) =>
      addSignatureIncremental(signed, { type: "Sig", fieldName: `Otra${Math.random()}`, signatureLength: 16_000, sign: (c) => buildPadesCms(c, attacker, {}), ...extra });

    // Firma posterior invisible: solo evidencia.
    const inv = await validatePdf(await later({}), { trustAnchors: [pki.root.certDer] });
    expect(inv.signatures.every((x) => x.integrity.valid)).toBe(true);
    expect(inv.signatures[0].changesAfter).toBe("evidence_only");

    // Firma posterior con widget visible que dibuja encima de la página: cambia lo que se ve.
    const vis = await validatePdf(
      await later({ widgetRect: [0, 0, 595, 842], appearance: "1 1 1 rg 0 0 595 842 re f 0 0 0 rg BT /Helv 24 Tf 50 700 Td (Monto: 1.000.000) Tj ET" }),
      { trustAnchors: [pki.root.certDer] },
    );
    expect(vis.signatures.every((x) => x.integrity.valid)).toBe(true);
    expect(vis.signatures[0].changesAfter).toBe("content");
    expect(vis.summary.allValid).toBe(false);

    // Capas opcionales agregadas al catálogo (deciden qué contenido se ve) sin tocar las páginas.
    const u = await IncrementalUpdate.open(signed);
    const ocg = u.add(u.context.obj({ Type: "OCG", Name: PDFString.of("Capa") }));
    u.doc.catalog.set(PDFName.of("OCProperties"), u.context.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
    u.touch(u.catalogRef);
    const oc = await validatePdf(u.serialize(), { trustAnchors: [pki.root.certDer] });
    expect(oc.signatures[0].changesAfter).toBe("content");
    expect(oc.summary.modifiedAfterSigning).toBe(true);
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
    // Un prestador que firma con una clave que no es la del certificado de la credencial: se rechaza.
    const other = await pki.issue("Otra Persona (CSC)");
    const liar = await startMockCsc({ username: "u", password: "p", pin: "1234", credentials: { "cred-1": { identity: holder, chainDer: [other.certDer, pki.intermediate.certDer, pki.root.certDer] } } });
    try {
      const p2 = new CscSignatureProvider({ id: "csc:mock", baseUrl: liar.url, auth: { type: "basic", username: "u", password: "p" }, pin: "1234" });
      await expect(p2.signDigest(new Uint8Array(32).fill(7))).rejects.toThrow(/no corresponde al certificado/);
    } finally {
      await liar.close();
    }
  }, 120_000);
});

