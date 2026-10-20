// Lo que se guarda como original (preparePdfUpload) es lo que ve el firmante y lo que se sella: capas, formularios,
// contenido activo y el placeholder del ByteRange. También la defensa al sellar originales guardados antes.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  type PDFPage,
} from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  IncrementalUpdate,
  InvalidPdfError,
  LocalKeyProvider,
  addSignatureIncremental,
  assembleCms,
  buildPadesCms,
  buildSignedAttributes,
  extractPdfPlainText,
  finalizeEnvelopePdf,
  generateDevRootCa,
  inspectPdf,
  issueSealCertificate,
  pemToDerList,
  prepareExternalSignature,
  preparePdfUpload,
  renderEnvelopePdf,
  sha256,
  validatePdf,
  type CertificateData,
} from "../src";

const cert = (): CertificateData => {
  const now = new Date().toISOString();
  return {
    envelopeId: "0192f0e0-0000-7000-8000-0000000000ee",
    subject: "Saneamiento",
    organizationName: "ACME",
    senderName: "Ana",
    senderEmail: null,
    createdAt: now,
    sentAt: now,
    completedAt: now,
    locale: "es",
    documents: [],
    recipients: [],
    events: [],
    chainHead: "c".repeat(64),
  };
};

let provider: LocalKeyProvider;
let other: { certPem: string; keyPem: string | null; chainPem: string };
let rootPem: string;
beforeAll(async () => {
  const ca = await generateDevRootCa("Saneamiento Root");
  rootPem = ca.certPem;
  const seal = await issueSealCertificate(ca, { commonName: "Sello" });
  other = await issueSealCertificate(ca, { commonName: "Otro" });
  provider = new LocalKeyProvider("seal", seal.keyPem!, seal.chainPem);
}, 60_000);

const seal = (bytes: Uint8Array) => finalizeEnvelopePdf({ documents: [{ name: "a.pdf", bytes }], fields: [], certificate: cert() }, { provider });
const render = (bytes: Uint8Array) => renderEnvelopePdf({ documents: [{ name: "a.pdf", bytes }], fields: [], certificate: cert() });
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof InvalidPdfError ? e.code : String(e)));
const text = async (b: Uint8Array) => (await extractPdfPlainText(b)).text;

function decoded(s: unknown): string {
  if (s instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  if (s instanceof PDFStream) return Buffer.from(s.getContents()).toString("latin1");
  return "";
}

/** Contenido de la página (todos sus streams) y de cada XObject que dibuja con Do. */
function drawn(doc: PDFDocument, page: PDFPage) {
  const ctx = doc.context;
  const c = page.node.Contents();
  const streams = c instanceof PDFArray ? c.asArray().map((r) => decoded(ctx.lookup(r))) : [decoded(c)];
  const content = streams.join("\n");
  const xo = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  const xobjects = [...content.matchAll(/\/(\S+) Do/g)].map((m) => decoded(ctx.lookup(xo?.get(PDFName.of(m[1])) as PDFRef)));
  return { streams, content, xobjects };
}

async function baseDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("VISIBLE", { x: 50, y: 700, size: 20, font });
  return { doc, page, font, ctx: doc.context, fontKey: [...page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict).keys()][0].asString() };
}

/** Documento con una capa (OCG) que dibuja "EN CAPA"; `configure` arma /OCProperties. */
async function layered(configure: (ctx: PDFDocument["context"], ocg: PDFRef, ocg2: PDFRef) => PDFDict) {
  const { doc, page, ctx, fontKey } = await baseDoc();
  const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("capa") }));
  const ocg2 = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("capa2") }));
  doc.catalog.set(PDFName.of("OCProperties"), configure(ctx, ocg, ocg2));
  page.node.Resources()!.set(PDFName.of("Properties"), ctx.obj({ oc1: ocg }));
  page.node.addContentStream(ctx.register(ctx.stream(`/OC /oc1 BDC BT ${fontKey} 30 Tf 50 500 Td (EN CAPA) Tj ET EMC\n`)));
  return doc.save();
}

describe("contenido opcional (capas)", () => {
  it("una capa apagada se rechaza al subir (pdf_hidden_layers) y, en un original viejo, al sellar", async () => {
    const bytes = await layered((ctx, ocg) => ctx.obj({ OCGs: [ocg], D: ctx.obj({ OFF: [ocg] }) }) as PDFDict);
    expect(await codeOf(preparePdfUpload(bytes))).toBe("pdf_hidden_layers");
    expect(await codeOf(seal(bytes))).toBe("pdf_hidden_layers");
    expect(await codeOf(render(bytes))).toBe("pdf_hidden_layers");
  });

  it("también BaseState /OFF, uso de vista apagado, grupos excluyentes y un OCMD que oculta con todo encendido", async () => {
    const cases = [
      (ctx: any, ocg: PDFRef) => ctx.obj({ OCGs: [ocg], D: { BaseState: "OFF" } }),
      (ctx: any, ocg: PDFRef) => {
        (ctx.lookup(ocg) as PDFDict).set(PDFName.of("Usage"), ctx.obj({ View: { ViewState: "OFF" } }));
        return ctx.obj({ OCGs: [ocg], D: { AS: [{ Event: "View", OCGs: [ocg], Category: ["View"] }] } });
      },
      (ctx: any, ocg: PDFRef, ocg2: PDFRef) => ctx.obj({ OCGs: [ocg, ocg2], D: { RBGroups: [[ocg, ocg2]] } }),
      (ctx: any, ocg: PDFRef) => {
        ctx.register(ctx.obj({ Type: "OCMD", OCGs: [ocg], P: "AllOff" }));
        return ctx.obj({ OCGs: [ocg], D: {} });
      },
      (ctx: any, ocg: PDFRef) => {
        ctx.register(ctx.obj({ Type: "OCMD", VE: [PDFName.of("Not"), ocg] }));
        return ctx.obj({ OCGs: [ocg], D: {} });
      },
    ];
    for (const c of cases) expect(await codeOf(preparePdfUpload(await layered(c)))).toBe("pdf_hidden_layers");
  });

  it("con todas las capas encendidas se acepta, se quita /OCProperties y lo de la capa se ve igual en el sellado", async () => {
    const bytes = await layered((ctx, ocg) => ctx.obj({ OCGs: [ocg], D: ctx.obj({ ON: [ocg] }) }) as PDFDict);
    const prep = await preparePdfUpload(bytes);
    const stored = await PDFDocument.load(prep.bytes);
    expect(stored.catalog.get(PDFName.of("OCProperties"))).toBeUndefined();
    expect(await text(prep.bytes)).toContain("EN CAPA");
    expect(await text(await seal(prep.bytes))).toContain("EN CAPA");
  });
});

/** Casilla con /V Yes y /AS Off (se ve destildada) y texto con /F Hidden. */
async function formDoc() {
  const { doc, page } = await baseDoc();
  const form = doc.getForm();
  const cb = form.createCheckBox("cb");
  cb.addToPage(page, { x: 50, y: 300, width: 20, height: 20 });
  cb.check();
  cb.acroField.getWidgets()[0].setAppearanceState(PDFName.of("Off"));
  const tf = form.createTextField("oculto");
  tf.setText("TEXTO OCULTO");
  tf.addToPage(page, { x: 50, y: 200, width: 200, height: 30 });
  tf.acroField.getWidgets()[0].dict.set(PDFName.of("F"), PDFNumber.of(2));
  const nv = form.createTextField("noview");
  nv.setText("NO VIEW");
  nv.addToPage(page, { x: 50, y: 150, width: 200, height: 30 });
  nv.acroField.getWidgets()[0].dict.set(PDFName.of("F"), PDFNumber.of(32));
  const ok = form.createTextField("visible");
  ok.setText("CAMPO VISIBLE");
  ok.addToPage(page, { x: 50, y: 100, width: 200, height: 30 });
  return doc.save();
}

describe("formularios", () => {
  async function expectFlattened(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes);
    const { xobjects } = drawn(doc, doc.getPages()[0]);
    const flat = xobjects.filter((x) => /re|m\n/.test(x));
    // La casilla se dibuja con la apariencia de /AS (Off: sin la tilde, que pdf-lib traza con "1.5 w").
    expect(xobjects.some((x) => x.includes("1.5 w"))).toBe(false);
    expect(flat.length).toBeGreaterThan(0);
    const t = await text(bytes);
    expect(t).toContain("CAMPO VISIBLE");
    expect(t).not.toContain("TEXTO OCULTO");
    expect(t).not.toContain("NO VIEW");
    return doc;
  }

  it("al subir se aplana como lo ve el lector: sin widgets ocultos, casillas según /AS, sin /AcroForm", async () => {
    const prep = await preparePdfUpload(await formDoc());
    const doc = await expectFlattened(prep.bytes);
    expect(doc.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();
    expect(doc.getPages()[0].node.get(PDFName.of("Annots"))).toBeUndefined();
    // Los campos eliminados no quedan sueltos en el archivo guardado.
    expect(Buffer.from(prep.bytes).includes("TEXTO OCULTO")).toBe(false);
  });

  it("un original guardado antes (con el formulario vivo) se sella igual de aplanado", async () => {
    const out = await render(await formDoc());
    await expectFlattened(out);
    const sealed = await seal(await formDoc());
    expect(await text(sealed)).not.toContain("TEXTO OCULTO");
  });

  it("NeedAppearances: la apariencia se regenera con el valor (lo que muestra el lector), también si falta", async () => {
    const { doc, page } = await baseDoc();
    const form = doc.getForm();
    const tf = form.createTextField("monto");
    tf.setText("VIEJO");
    tf.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });
    tf.acroField.dict.set(PDFName.of("V"), PDFString.of("NUEVO"));
    const sinAp = form.createTextField("sinap");
    sinAp.setText("SIN APARIENCIA");
    sinAp.addToPage(page, { x: 50, y: 200, width: 200, height: 30 });
    sinAp.acroField.getWidgets()[0].dict.delete(PDFName.of("AP"));
    const stale = await doc.save({ updateFieldAppearances: false });

    // Sin NeedAppearances el lector muestra la apariencia guardada; el campo sin apariencia se genera.
    const plain = await text((await preparePdfUpload(stale)).bytes);
    expect(plain).toContain("VIEJO");
    expect(plain).toContain("SIN APARIENCIA");

    const d2 = await PDFDocument.load(stale);
    d2.getForm().acroForm.dict.set(PDFName.of("NeedAppearances"), d2.context.obj(true));
    const need = await d2.save({ updateFieldAppearances: false });
    const t = await text((await preparePdfUpload(need)).bytes);
    expect(t).toContain("NUEVO");
    expect(t).not.toContain("VIEJO");
    expect(await text(await render(need))).toContain("NUEVO");
  });

  it("la apariencia se escala de su BBox (y Matrix) al /Rect del widget, como en un lector", async () => {
    const { doc, page, ctx } = await baseDoc();
    const ap = ctx.register(ctx.stream("0 0 1 rg 0 0 10 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] }));
    const w = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Btn", Ff: 65536, T: PDFString.of("b"), Rect: [100, 100, 300, 150], AP: { N: ap } }));
    page.node.set(PDFName.of("Annots"), ctx.obj([w]));
    doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [w] }));
    const prep = await PDFDocument.load((await preparePdfUpload(await doc.save())).bytes);
    expect(drawn(prep, prep.getPages()[0]).content).toMatch(/20 0 0 5 100 100 cm/);
  });

  it("informa si el PDF subido traía firmas digitales (se pierden al reescribirlo)", async () => {
    const plain = await preparePdfUpload(await (await baseDoc()).doc.save());
    expect(plain.info.hadSignatures).toBe(false);
    const signed = await seal(await (await baseDoc()).doc.save());
    expect((await inspectPdf(signed)).hadSignatures).toBe(true);
    const prep = await preparePdfUpload(signed);
    expect(prep.info.hadSignatures).toBe(true);
    expect((await validatePdf(prep.bytes)).signatures).toHaveLength(0);
  });
});

/** Página con acciones y anotaciones activas, más JavaScript, adjuntos y portafolio en el catálogo. */
async function activeDoc() {
  const { doc, page, ctx } = await baseDoc();
  const js = (s: string) => ctx.obj({ S: "JavaScript", JS: PDFString.of(s) });
  page.node.set(PDFName.of("AA"), ctx.obj({ O: js("app.alert('pagina')") }));
  const link = (a: unknown, extra: Record<string, unknown> = {}) =>
    ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 100, 30], A: a as any, ...extra } as any));
  const uri = link(ctx.obj({ S: "URI", URI: PDFString.of("https://example.com"), Next: js("app.alert('next')") }));
  const launch = link(ctx.obj({ S: "Launch", F: PDFString.of("calc.exe") }));
  const jsLink = link(js("app.alert('link')"), { AA: ctx.obj({ E: js("app.alert('enter')") }) });
  const ef = ctx.register(ctx.flateStream("ADJUNTO OCULTO", { Type: "EmbeddedFile" }));
  const spec = ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of("x.pdf"), EF: { F: ef } }));
  const fileAnnot = ctx.register(ctx.obj({ Type: "Annot", Subtype: "FileAttachment", Rect: [10, 40, 30, 60], FS: spec }));
  const screen = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Screen", Rect: [10, 70, 30, 90] }));
  page.node.set(PDFName.of("Annots"), ctx.obj([uri, launch, jsLink, fileAnnot, screen]));
  doc.catalog.set(PDFName.of("Names"), ctx.obj({ JavaScript: { Names: [PDFString.of("a"), js("app.alert('doc')")] }, EmbeddedFiles: { Names: [PDFString.of("x.pdf"), spec] } }));
  doc.catalog.set(PDFName.of("OpenAction"), js("app.alert('open')"));
  doc.catalog.set(PDFName.of("AA"), ctx.obj({ WC: js("app.alert('close')") }));
  doc.catalog.set(PDFName.of("Collection"), ctx.obj({ Type: "Collection", D: PDFString.of("x.pdf"), View: "D" }));
  const outline = ctx.register(ctx.obj({ Title: PDFString.of("M"), A: js("app.alert('outline')") }));
  const outlines = ctx.register(ctx.obj({ Type: "Outlines", First: outline, Last: outline, Count: 1 }));
  (ctx.lookup(outline) as PDFDict).set(PDFName.of("Parent"), outlines);
  doc.catalog.set(PDFName.of("Outlines"), outlines);
  return doc.save({ useObjectStreams: false });
}

function annotsOf(doc: PDFDocument, page = doc.getPages()[0]) {
  return (page.node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.asArray() ?? []).map((a) => doc.context.lookup(a) as PDFDict);
}

describe("contenido activo", () => {
  it("al subir: sin /AA, sin JavaScript ni adjuntos, solo acciones URI/GoTo/Named y sin anotaciones multimedia", async () => {
    const prep = await preparePdfUpload(await activeDoc());
    const doc = await PDFDocument.load(prep.bytes);
    const page = doc.getPages()[0];
    expect(page.node.get(PDFName.of("AA"))).toBeUndefined();
    const annots = annotsOf(doc);
    expect(annots.map((a) => a.lookup(PDFName.of("Subtype"), PDFName).decodeText())).toEqual(["Link", "Link", "Link"]);
    const actions = annots.map((a) => a.lookupMaybe(PDFName.of("A"), PDFDict));
    expect(actions[0]?.lookup(PDFName.of("S"), PDFName).decodeText()).toBe("URI");
    expect(actions[0]?.get(PDFName.of("Next"))).toBeUndefined();
    expect(actions[1]).toBeUndefined();
    expect(actions[2]).toBeUndefined();
    expect(annots.every((a) => a.get(PDFName.of("AA")) === undefined)).toBe(true);
    for (const k of ["OpenAction", "AA", "Collection"]) expect(doc.catalog.get(PDFName.of(k)), k).toBeUndefined();
    const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
    expect(names?.get(PDFName.of("JavaScript"))).toBeUndefined();
    expect(names?.get(PDFName.of("EmbeddedFiles"))).toBeUndefined();
    const item = doc.catalog.lookup(PDFName.of("Outlines"), PDFDict).lookup(PDFName.of("First"), PDFDict);
    expect(item.get(PDFName.of("A"))).toBeUndefined();
    const raw = Buffer.from(prep.bytes);
    expect(raw.includes("app.alert")).toBe(false);
  });

  it("al sellar un original viejo: las páginas copiadas no llevan /AA ni anotaciones o acciones activas", async () => {
    const out = await PDFDocument.load(await render(await activeDoc()));
    const page = out.getPages()[0];
    expect(page.node.get(PDFName.of("AA"))).toBeUndefined();
    const annots = annotsOf(out, page);
    expect(annots).toHaveLength(3);
    expect(annots.filter((a) => a.get(PDFName.of("A"))).length).toBe(1);
    expect(Buffer.from(await render(await activeDoc())).includes("app.alert")).toBe(false);
  });
});

/** Documento con la secuencia del placeholder por defecto de @signpdf en un content stream sin comprimir. */
async function byteRangeBait() {
  const { doc, page, ctx } = await baseDoc();
  page.node.addContentStream(ctx.register(ctx.stream("% /ByteRange [0 /********** /********** /**********]\n")));
  return doc.save();
}

describe("placeholder del ByteRange", () => {
  it("al subir se comprimen los streams sin filtro: la secuencia no queda literal", async () => {
    const bait = await byteRangeBait();
    expect(Buffer.from(bait).includes("/ByteRange [0 /**********")).toBe(true);
    const prep = await preparePdfUpload(bait);
    expect(Buffer.from(prep.bytes).includes("/ByteRange [0 /**********")).toBe(false);
  });

  it("un original viejo con la secuencia literal se sella, y admite firmas incrementales y externas", async () => {
    const sealed = await seal(await byteRangeBait());
    expect(Buffer.from(sealed).includes("/ByteRange [0 /**********")).toBe(true);
    let v = await validatePdf(sealed, { trustAnchors: pemToDerList(rootPem) });
    expect(v.summary.allValid).toBe(true);
    const twice = await addSignatureIncremental(sealed, { type: "Sig", fieldName: "Empresa", signatureLength: 16_000, sign: (c) => buildPadesCms(c, provider, {}) });
    v = await validatePdf(twice, { trustAnchors: pemToDerList(rootPem) });
    expect(v.signatures).toHaveLength(2);
    expect(v.summary.allValid).toBe(true);
    const ext = await prepareExternalSignature(sealed, pemToDerList(other.chainPem), { fieldName: "Externa" });
    expect(ext.byteRange[1]).toBeGreaterThan(sealed.length);
  });
});

describe("revisiones posteriores (lista blanca del catálogo)", () => {
  it("adjuntos, portafolio y PageMode agregados después de sellar cuentan como cambio de contenido", async () => {
    const sealed = await seal(await (await baseDoc()).doc.save());
    const u = await IncrementalUpdate.open(sealed);
    const ctx = u.context;
    const ef = u.add(ctx.flateStream("CONTRATO FALSO", { Type: "EmbeddedFile" }));
    const spec = u.add(ctx.obj({ Type: "Filespec", F: PDFString.of("contrato_real.pdf"), EF: ctx.obj({ F: ef }) }));
    u.doc.catalog.set(PDFName.of("Names"), ctx.obj({ EmbeddedFiles: ctx.obj({ Names: [PDFString.of("contrato_real.pdf"), spec] }) }));
    u.doc.catalog.set(PDFName.of("Collection"), ctx.obj({ Type: "Collection", D: PDFString.of("contrato_real.pdf"), View: "D" }));
    u.doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseAttachments"));
    u.touch(u.catalogRef);
    const r = await validatePdf(u.serialize(), { trustAnchors: pemToDerList(rootPem) });
    expect(r.signatures[0].changesAfter).toBe("content");
    expect(r.summary.modifiedAfterSigning).toBe(true);
    expect(r.summary.allValid).toBe(false);

    // Solo /PageMode también.
    const u2 = await IncrementalUpdate.open(sealed);
    u2.doc.catalog.set(PDFName.of("PageMode"), PDFName.of("FullScreen"));
    u2.touch(u2.catalogRef);
    expect((await validatePdf(u2.serialize(), {})).signatures[0].changesAfter).toBe("content");

    // Una firma posterior invisible (toca /AcroForm /Fields y /SigFlags) sigue siendo evidencia.
    const later = await addSignatureIncremental(sealed, { type: "Sig", fieldName: "Otra", signatureLength: 16_000, sign: (c) => buildPadesCms(c, provider, {}) });
    expect((await validatePdf(later, {})).signatures[0].changesAfter).toBe("evidence_only");
  });
});

describe("validación: certificado firmante y algoritmos débiles", () => {
  it("un signingCertificateV2 que identifica a otro certificado invalida la firma", async () => {
    const sealed = await render(await (await baseDoc()).doc.save());
    const chain = await provider.certificateChain();
    const signWith = (attrsChain: Uint8Array[]) => async (content: Uint8Array) => {
      const signedAttrsDer = buildSignedAttributes(sha256(content), attrsChain);
      const signature = await provider.signDigest(sha256(signedAttrsDer));
      return assembleCms({ signedAttrsDer, chainDer: chain, signature, signatureAlgorithm: "RSASSA-PKCS1-v1_5" });
    };
    const good = await addSignatureIncremental(sealed, { type: "Sig", fieldName: "Ok", signatureLength: 16_000, sign: signWith(chain) });
    expect((await validatePdf(good, {})).signatures[0].integrity.valid).toBe(true);
    const bad = await addSignatureIncremental(sealed, { type: "Sig", fieldName: "Mal", signatureLength: 16_000, sign: signWith(pemToDerList(other.chainPem)) });
    const r = await validatePdf(bad, {});
    expect(r.signatures[0].integrity).toEqual({ valid: false, reason: expect.stringMatching(/signingCertificate/) });
  });

  it("una clave RSA de 1024 bits se marca como algoritmo débil y no cuenta para allValid ni allTrusted", async () => {
    const ca = await generateDevRootCa("Debil Root");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const weakCert = await issueSealCertificate(ca, { commonName: "Clave corta", subjectPublicKeySpki: spki });
    const weak = new LocalKeyProvider("weak", privateKey.export({ type: "pkcs8", format: "pem" }) as string, weakCert.chainPem);
    const pdf = await finalizeEnvelopePdf({ documents: [{ name: "a.pdf", bytes: await (await baseDoc()).doc.save() }], fields: [], certificate: cert() }, { provider: weak });
    const r = await validatePdf(pdf, { trustAnchors: pemToDerList(ca.certPem) });
    expect(r.signatures[0].integrity.valid).toBe(true);
    expect(r.signatures[0].chain.trusted).toBe(true);
    expect(r.signatures[0].weakAlgorithm).toBe(true);
    expect(r.signatures[0].weakAlgorithmReasons.join()).toMatch(/1024 bits/);
    expect(r.summary).toMatchObject({ allValid: false, allTrusted: false, anyWeakAlgorithm: true });

    const ok = await validatePdf(await seal(await (await baseDoc()).doc.save()), { trustAnchors: pemToDerList(rootPem) });
    expect(ok.signatures[0].weakAlgorithm).toBe(false);
    expect(ok.summary).toMatchObject({ allValid: true, allTrusted: true, anyWeakAlgorithm: false });
  });
});

const hasGs = (() => {
  try {
    execFileSync("gs", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("PDF cifrado", () => {
  it.skipIf(!hasGs)("solo con permisos (contraseña de usuario vacía): pdf_restricted; con contraseña: encrypted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "enc-"));
    writeFileSync(join(dir, "in.pdf"), await (await baseDoc()).doc.save());
    const encrypt = (r: number, bits: number, user: string) => {
      const out = join(dir, `r${r}-${user || "vacia"}.pdf`);
      // R2 solo admite los permisos de los 6 bits bajos.
      const perms = r === 2 ? "-64" : "-3904";
      const userArg = user ? [`-sUserPassword=${user}`] : [];
      execFileSync("gs", ["-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", "-sOwnerPassword=duenio", ...userArg, `-dEncryptionR=${r}`, `-dKeyLength=${bits}`, `-dPermissions=${perms}`, `-sOutputFile=${out}`, join(dir, "in.pdf")]);
      return new Uint8Array(readFileSync(out));
    };
    for (const [r, bits] of [
      [2, 40],
      [3, 128],
    ]) {
      const restricted = encrypt(r, bits, "");
      expect(Buffer.from(restricted).includes("/Encrypt")).toBe(true);
      expect(await codeOf(preparePdfUpload(restricted)), `R${r}`).toBe("pdf_restricted");
      expect(await codeOf(inspectPdf(restricted))).toBe("pdf_restricted");
      expect(await codeOf(preparePdfUpload(encrypt(r, bits, "usuario"))), `R${r}`).toBe("encrypted");
    }
  });
});

describe("estado gráfico del original", () => {
  it("un content stream que deja cambiada la matriz no desplaza lo estampado (va entre q/Q)", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.node.addContentStream(doc.context.register(doc.context.stream("0 0 0 0 re W n 1 0 0 -1 0 800 cm\n")));
    const prep = await preparePdfUpload(await doc.save());
    const out = await PDFDocument.load(
      await renderEnvelopePdf({
        documents: [{ name: "a", bytes: prep.bytes }],
        fields: [{ documentIndex: 0, page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.05, type: "name", value: "Juan" }],
        certificate: cert(),
      }),
    );
    const { streams } = drawn(out, out.getPages()[0]);
    const iOrig = streams.findIndex((s) => s.includes("1 0 0 -1 0 800 cm"));
    expect(streams.slice(0, iOrig).join("").trim()).toBe("q");
    expect(streams[iOrig + 1].trim()).toBe("Q");
  });
});
