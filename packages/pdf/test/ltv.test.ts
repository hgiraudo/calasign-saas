import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  inspectPdf,
  parseCert,
  pemToDerList,
  serialHex,
  validatePdf,
} from "../src";
import { startLab, type LabPki, type LabServer } from "../src/lab";
import { startMockCsc } from "../src/csc-mock";
import { fetchOcsp } from "../src/pki";

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

async function sealedBT(provider: LocalKeyProvider, withTimestamp = true) {
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
    { provider, tsaUrl: withTimestamp ? `${server.url}/tsr` : null },
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

  it("un OCSP \"good\" viejo del DSS no oculta una revocación posterior", async () => {
    const company = await pki.issue("Firmante Comprometido");
    const provider = new LocalKeyProvider("comp", company.keyPem, company.certPem + pki.intermediate.certPem + pki.root.certPem);
    // Firma sin sello de tiempo (el momento de la firma no está probado: se evalúa al día de hoy) con un OCSP "good" de hoy.
    const bb = await sealedBT(provider, false);
    const ocsp = await fetchOcsp(parseCert(company.certDer), parseCert(pki.intermediate.certDer));
    expect(ocsp).not.toBeNull();
    const pdf = await addDssIncremental(bb, { certs: [], ocsps: [ocsp!], crls: [] });
    const fresh = await validatePdf(pdf, { trustAnchors: [pki.root.certDer] });
    expect(fresh.signatures[0].chain.entries[0].revocation).toMatchObject({ status: "good", source: "dss-ocsp" });

    // Diez días después el certificado está revocado (la clave se comprometió). El OCSP del DSS ya venció.
    pki.revoked.add(serialHex(parseCert(company.certDer)));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10 * 86400_000);
      const offline = await validatePdf(pdf, { trustAnchors: [pki.root.certDer] });
      expect(offline.signatures[0].chain.entries[0].revocation.status).toBe("not_checked");
      const online = await validatePdf(pdf, { trustAnchors: [pki.root.certDer], online: true });
      expect(online.signatures[0].chain.revoked).toBe(true);
      expect(online.summary.allTrusted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    // Un PDF firmado con revisiones incrementales legítimas se puede volver a subir (no es ambiguo).
    expect((await inspectPdf(signed)).pageCount).toBeGreaterThan(0);
    expect((await inspectPdf(withDss)).pageCount).toBeGreaterThan(0);
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
    // Subido como documento, se rechaza: el firmante vería una cosa y el PDF final tendría otra.
    expect((await inspectPdf(shadowed).catch((e) => e)).code).toBe("ambiguous_pdf");
  }, 120_000);

  it("una revisión posterior cuyo /Prev saltea el xref firmado no pasa como evidencia", async () => {
    // rev0 dice "Monto: 1.000.000"; rev1 (antes de firmar) lo cambia a "Monto: 1.000"; después, la firma.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([595, 842]).drawText("Monto: 1.000.000", { x: 50, y: 780, size: 14, font });
    const base = await doc.save({ useObjectStreams: false });
    const u = await IncrementalUpdate.open(base);
    const page = u.doc.getPages()[0];
    const fontName = (page.node.Resources()!.lookup(PDFName.of("Font")) as unknown as { entries(): [PDFName, unknown][] }).entries()[0][0].decodeText();
    page.node.set(PDFName.of("Contents"), u.add(u.context.flateStream(`BT /${fontName} 14 Tf 50 780 Td (Monto: 1.000) Tj ET`)));
    u.touch(page.ref);
    const seal = new LocalKeyProvider("lab-seal", pki.seal.keyPem, pki.sealChainPem);
    const signed = await addCadesSignatureIncremental(u.serialize(), seal, { fieldName: "Firma" });

    // Revisión con un objeto inocuo y /Prev al xref de rev0: el lector resuelve la página con la versión de rev0.
    const sd = await PDFDocument.load(signed, { updateMetadata: false });
    const n = sd.context.largestObjectNumber + 1;
    const obj = `${n} 0 obj\n<< /X 1 >>\nendobj\n`;
    const xrefAt = signed.length + obj.length;
    const rev0StartXref = Number([...Buffer.from(base).toString("latin1").matchAll(/startxref\s+(\d+)/g)].pop()![1]);
    const tail =
      `xref\n0 1\n0000000000 65535 f \n${n} 1\n${String(signed.length).padStart(10, "0")} 00000 n \n` +
      `trailer\n<< /Size ${n + 1} /Root ${sd.context.trailerInfo.Root!.toString()} /Prev ${rev0StartXref} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const attacked = new Uint8Array(Buffer.concat([Buffer.from(signed), Buffer.from(obj + tail, "latin1")]));
    const v = await validatePdf(attacked, { trustAnchors: [pki.root.certDer] });
    expect(v.signatures[0].integrity.valid).toBe(true);
    expect(v.signatures[0].changesAfter).toBe("content");
    expect(v.summary.allValid).toBe(false);

    // La misma revisión con /Prev al xref firmado sí es inocua.
    const okTail = tail.replace(`/Prev ${rev0StartXref}`, `/Prev ${Number([...Buffer.from(signed).toString("latin1").matchAll(/startxref\s+(\d+)/g)].pop()![1])}`);
    const benign = new Uint8Array(Buffer.concat([Buffer.from(signed), Buffer.from(obj + okTail, "latin1")]));
    expect((await validatePdf(benign, { trustAnchors: [pki.root.certDer] })).signatures[0].changesAfter).toBe("evidence_only");
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

