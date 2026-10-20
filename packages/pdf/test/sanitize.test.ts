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
  PDFHexString,
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
import * as asn1js from "asn1js";
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
const toArrayBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
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

/** /OCProperties del PDF final y el estado (apagada o no) de la capa a la que apunta /oc1 en la página `pageIndex`. */
async function finalLayers(pdf: Uint8Array, pageIndex = 0) {
  const doc = await PDFDocument.load(pdf);
  const ocp = doc.catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
  const props = doc.getPages()[pageIndex].node.Resources()?.lookupMaybe(PDFName.of("Properties"), PDFDict);
  const oc1 = props?.get(PDFName.of("oc1"));
  const d = ocp?.lookup(PDFName.of("D"), PDFDict);
  const off = d?.lookupMaybe(PDFName.of("OFF"), PDFArray)?.asArray() ?? [];
  const ocgs = ocp?.lookupMaybe(PDFName.of("OCGs"), PDFArray)?.asArray() ?? [];
  return { ocp, ocgs, off, oc1, oc1Off: !!oc1 && off.some((x) => x === oc1), baseState: d?.get(PDFName.of("BaseState"))?.toString() };
}

describe("contenido opcional (capas)", () => {
  it("una capa apagada se rechaza al subir; en un original viejo se sella con /OCProperties y la capa apagada", async () => {
    const bytes = await layered((ctx, ocg) => ctx.obj({ OCGs: [ocg], D: ctx.obj({ OFF: [ocg] }) }) as PDFDict);
    expect(await codeOf(preparePdfUpload(bytes))).toBe("pdf_hidden_layers");
    const sealed = await seal(bytes);
    expect((await validatePdf(sealed, { trustAnchors: pemToDerList(rootPem) })).summary.allValid).toBe(true);
    for (const pdf of [sealed, await render(bytes)]) {
      const l = await finalLayers(pdf);
      expect(l.ocgs).toHaveLength(1);
      expect(l.ocgs[0]).toBe(l.oc1);
      expect(l.oc1Off).toBe(true);
      expect(l.baseState).toBe("/ON");
    }
  });

  it("varios documentos: se unen las capas de todos con el estado de cada una (las encendidas siguen encendidas)", async () => {
    const off = await layered((ctx, ocg) => ctx.obj({ OCGs: [ocg], D: ctx.obj({ OFF: [ocg] }) }) as PDFDict);
    const viewOff = await layered((ctx, ocg) => {
      (ctx.lookup(ocg) as PDFDict).set(PDFName.of("Usage"), ctx.obj({ View: { ViewState: "OFF" } }));
      return ctx.obj({ OCGs: [ocg], D: { Order: [ocg] } }) as PDFDict;
    });
    const on = await layered((ctx, ocg) => ctx.obj({ OCGs: [ocg], D: ctx.obj({ ON: [ocg] }) }) as PDFDict);
    const pdf = await renderEnvelopePdf({ documents: [off, viewOff, on].map((bytes, i) => ({ name: `${i}.pdf`, bytes })), fields: [], certificate: cert() });
    const [a, b, c] = [await finalLayers(pdf, 0), await finalLayers(pdf, 1), await finalLayers(pdf, 2)];
    expect(a.ocgs).toHaveLength(3);
    expect(new Set([a.oc1, b.oc1, c.oc1]).size).toBe(3);
    expect([a.oc1Off, b.oc1Off, c.oc1Off]).toEqual([true, true, false]);
    expect((a.ocp!.lookup(PDFName.of("D"), PDFDict).lookup(PDFName.of("Order"), PDFArray)).asArray()).toEqual([b.oc1]);
    // Sin capas apagadas en ningún documento, el PDF final no lleva /OCProperties (todo se ve).
    expect((await finalLayers(await render(on))).ocp).toBeUndefined();
  });

  it("un widget de formulario en una capa apagada se aplana dentro de esa capa", async () => {
    const { doc, page, ctx } = await baseDoc();
    const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("capa") }));
    doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: { OFF: [ocg] } }));
    const tf = doc.getForm().createTextField("t");
    tf.setText("EN CAPA");
    tf.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });
    tf.acroField.getWidgets()[0].dict.set(PDFName.of("OC"), ocg);
    const out = await PDFDocument.load(await render(await doc.save()));
    const p = out.getPages()[0];
    const key = [...(p.node.Resources()!.lookup(PDFName.of("Properties"), PDFDict).entries())].find(([, v]) => v instanceof PDFRef)![0];
    expect(drawn(out, p).content).toMatch(new RegExp(`/OC ${key.asString()} BDC\\s+q[\\s\\S]*?Do\\s+Q\\s+EMC`));
  });

  it("también BaseState /OFF, uso de vista apagado y un OCMD que oculta con todo encendido", async () => {
    const cases = [
      (ctx: any, ocg: PDFRef) => ctx.obj({ OCGs: [ocg], D: { BaseState: "OFF" } }),
      (ctx: any, ocg: PDFRef) => {
        (ctx.lookup(ocg) as PDFDict).set(PDFName.of("Usage"), ctx.obj({ View: { ViewState: "OFF" } }));
        return ctx.obj({ OCGs: [ocg], D: { AS: [{ Event: "View", OCGs: [ocg], Category: ["View"] }] } });
      },
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

  it("se aceptan (como en pdf.js): /Print apagado, /RBGroups, /VE inválido y capas que no están en /OCGs", async () => {
    const cases: Record<string, (ctx: any, ocg: PDFRef, ocg2: PDFRef) => unknown> = {
      "PrintState OFF": (ctx, ocg) => {
        (ctx.lookup(ocg) as PDFDict).set(PDFName.of("Usage"), ctx.obj({ Print: { PrintState: "OFF" } }));
        return ctx.obj({ OCGs: [ocg], D: { AS: [{ Event: "Print", OCGs: [ocg], Category: ["Print"] }] } });
      },
      "RBGroups con dos encendidas": (ctx, ocg, ocg2) => ctx.obj({ OCGs: [ocg, ocg2], D: { RBGroups: [[ocg, ocg2]] } }),
      "OCMD /VE [] (lopdf)": (ctx, ocg) => {
        ctx.register(ctx.obj({ Type: "OCMD", VE: [], OCGs: [ocg] }));
        return ctx.obj({ OCGs: [ocg], D: {} });
      },
      "OCMD /VE [/Not] (menos de 2)": (ctx, ocg) => {
        ctx.register(ctx.obj({ Type: "OCMD", VE: [PDFName.of("Not")] }));
        return ctx.obj({ OCGs: [ocg], D: {} });
      },
      "OCMD /VE operador desconocido": (ctx, ocg) => {
        ctx.register(ctx.obj({ Type: "OCMD", VE: [PDFName.of("Xor"), ocg] }));
        return ctx.obj({ OCGs: [ocg], D: {} });
      },
      "OCMD /VE [/Not capa-no-listada]": (ctx, _ocg, ocg2) => {
        ctx.register(ctx.obj({ Type: "OCMD", VE: [PDFName.of("Not"), ocg2] }));
        return ctx.obj({ OCGs: [_ocg], D: {} });
      },
      "OCMD AllOff con capa no listada": (ctx, ocg, ocg2) => {
        ctx.register(ctx.obj({ Type: "OCMD", OCGs: [ocg2, ocg], P: "AllOff" }));
        return ctx.obj({ OCGs: [ocg], D: {} });
      },
      "la página usa una capa que no está en /OCGs (BaseState OFF)": (ctx, _ocg, ocg2) => ctx.obj({ OCGs: [ocg2], D: { BaseState: "OFF", ON: [ocg2] } }),
    };
    for (const [name, c] of Object.entries(cases)) expect(await codeOf(preparePdfUpload(await layered(c as any))), name).toBe("ok");
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

  it("si la apariencia no se puede regenerar (texto fuera de WinAnsi) se conserva la guardada; sin ninguna, se rechaza", async () => {
    const build = async (withAp: boolean) => {
      const { doc, page } = await baseDoc();
      const form = doc.getForm();
      const tf = form.createTextField("c");
      tf.setText("GUARDADA");
      tf.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });
      tf.acroField.dict.set(PDFName.of("V"), PDFHexString.fromText("Привет"));
      if (!withAp) tf.acroField.getWidgets()[0].dict.delete(PDFName.of("AP"));
      form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
      return doc.save({ updateFieldAppearances: false });
    };
    const prep = await preparePdfUpload(await build(true));
    expect(await text(prep.bytes)).toContain("GUARDADA");
    expect(await codeOf(preparePdfUpload(await build(false)))).toBe("pdf_form_unsupported");
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
  // Archivos asociados (PDF/A-3, Factur-X) en el catálogo y en la página.
  const af = (name: string) => ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of(name), AFRelationship: "Data", EF: { F: ctx.register(ctx.stream("<factura/>", { Type: "EmbeddedFile" })) } }));
  doc.catalog.set(PDFName.of("AF"), ctx.obj([af("factur-x.xml")]));
  page.node.set(PDFName.of("AF"), ctx.obj([af("pagina.xml")]));
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
    for (const k of ["OpenAction", "AA", "Collection", "AF"]) expect(doc.catalog.get(PDFName.of(k)), k).toBeUndefined();
    expect(page.node.get(PDFName.of("AF"))).toBeUndefined();
    const embedded = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFStream && o.dict.get(PDFName.of("Type")) === PDFName.of("EmbeddedFile"));
    expect(embedded).toHaveLength(0);
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
    expect(page.node.get(PDFName.of("AF"))).toBeUndefined();
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

  it("no se comprimen imágenes sin filtro ni streams de más de 2 MB (deflate lento que no hace falta)", async () => {
    const { doc, page, ctx } = await baseDoc();
    const pixels = Buffer.alloc(40 * 40 * 3, 200);
    const img = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: 40, Height: 40, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Length: pixels.length }), pixels));
    const key = page.node.newXObject("Im", img);
    page.node.addContentStream(ctx.register(ctx.stream(`q 40 0 0 40 10 10 cm /${key.decodeText()} Do Q\n`)));
    page.node.addContentStream(ctx.register(ctx.stream(`% ${"x".repeat(2.5 * 1024 * 1024)}\n`)));
    const out = await PDFDocument.load((await preparePdfUpload(await doc.save({ useObjectStreams: false }))).bytes);
    const raws = out.context.enumerateIndirectObjects().flatMap(([, o]) => (o instanceof PDFRawStream ? [o] : []));
    const image = raws.find((o) => o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))!;
    expect(image.dict.get(PDFName.of("Filter"))).toBeUndefined();
    expect(raws.find((o) => o.contents.length > 2 * 1024 * 1024)?.dict.get(PDFName.of("Filter"))).toBeUndefined();
    // El resto de los content streams sí.
    expect(raws.filter((o) => !o.dict.has(PDFName.of("Filter")) && o.contents.length < 1024 && o.dict.get(PDFName.of("Type")) !== PDFName.of("Metadata"))).toHaveLength(0);
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

  it("revisiones legítimas de terceros (ESIC, XMP, /Version, /DR /DA…) son evidencia; acciones, XFA y NeedAppearances no", async () => {
    const sealed = await seal(await (await baseDoc()).doc.save());
    const revise = async (fn: (u: IncrementalUpdate, cat: PDFDict) => void) => {
      const u = await IncrementalUpdate.open(sealed);
      const cat = u.context.lookup(u.catalogRef, PDFDict);
      fn(u, cat);
      u.touch(u.catalogRef);
      const acro = cat.get(PDFName.of("AcroForm"));
      if (acro instanceof PDFRef) u.touch(acro);
      return (await validatePdf(u.serialize(), {})).signatures[0].changesAfter;
    };
    const acroOf = (u: IncrementalUpdate, cat: PDFDict) => u.context.lookup(cat.get(PDFName.of("AcroForm")), PDFDict);
    const evidence: Record<string, (u: IncrementalUpdate, cat: PDFDict) => void> = {
      "nada": () => {},
      "Extensions ESIC": (u, cat) => cat.set(PDFName.of("Extensions"), u.context.obj({ ESIC: { BaseVersion: PDFName.of("1.7"), ExtensionLevel: 2 } })),
      "Metadata nueva": (u, cat) => cat.set(PDFName.of("Metadata"), u.add(u.context.stream("<x:xmpmeta/>", { Type: "Metadata", Subtype: "XML" }))),
      "Version 2.0": (_u, cat) => cat.set(PDFName.of("Version"), PDFName.of("2.0")),
      "Lang, MarkInfo, ViewerPreferences, PageLabels": (u, cat) => {
        cat.set(PDFName.of("Lang"), PDFString.of("es-AR"));
        cat.set(PDFName.of("MarkInfo"), u.context.obj({ Marked: true }));
        cat.set(PDFName.of("ViewerPreferences"), u.context.obj({ DisplayDocTitle: true }));
        cat.set(PDFName.of("PageLabels"), u.context.obj({ Nums: [0, { S: "r" }] }));
      },
      "Names /Dests": (u, cat) => cat.set(PDFName.of("Names"), u.context.obj({ Dests: { Names: [PDFString.of("x"), [u.doc.getPage(0).ref, "Fit"]] } })),
      "AcroForm DA+DR+Q": (u, cat) => {
        const a = acroOf(u, cat);
        a.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
        a.set(PDFName.of("Q"), PDFNumber.of(1));
        a.set(PDFName.of("DR"), u.context.obj({ Font: { Helv: { Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" } } }));
      },
      "NeedAppearances false": (u, cat) => acroOf(u, cat).set(PDFName.of("NeedAppearances"), u.context.obj(false)),
    };
    for (const [name, fn] of Object.entries(evidence)) expect(await revise(fn), name).toBe("evidence_only");
    const content: Record<string, (u: IncrementalUpdate, cat: PDFDict) => void> = {
      "NeedAppearances true": (u, cat) => acroOf(u, cat).set(PDFName.of("NeedAppearances"), u.context.obj(true)),
      "XFA": (u, cat) => acroOf(u, cat).set(PDFName.of("XFA"), u.add(u.context.stream("<xdp:xdp/>"))),
      "OpenAction": (u, cat) => cat.set(PDFName.of("OpenAction"), u.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") })),
      "AA": (u, cat) => cat.set(PDFName.of("AA"), u.context.obj({ WC: { S: "JavaScript", JS: PDFString.of("1") } })),
      "URI": (u, cat) => cat.set(PDFName.of("URI"), u.context.obj({ Base: PDFString.of("https://x") })),
      "Names /JavaScript": (u, cat) => cat.set(PDFName.of("Names"), u.context.obj({ JavaScript: { Names: [PDFString.of("a"), { S: "JavaScript", JS: PDFString.of("1") }] } })),
    };
    for (const [name, fn] of Object.entries(content)) expect(await revise(fn), name).toBe("content");
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

  it("un signingCertificateV2 con un resumen no soportado (SHA-224) no invalida la firma: queda como advertencia", async () => {
    const sealed = await render(await (await baseDoc()).doc.save());
    const chain = await provider.certificateChain();
    const sign = async (content: Uint8Array) => {
      // ESSCertIDv2 con hashAlgorithm SHA-224 explícito (el hash queda el de SHA-256: no se puede comprobar).
      const set = asn1js.fromBER(toArrayBuffer(buildSignedAttributes(sha256(content), chain))).result as asn1js.Set;
      for (const attr of set.valueBlock.value as asn1js.Sequence[]) {
        const [oid, values] = attr.valueBlock.value as [asn1js.ObjectIdentifier, asn1js.Set];
        if (oid.valueBlock.toString() !== "1.2.840.113549.1.9.16.2.47") continue;
        const ess = ((values.valueBlock.value[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
        ess.valueBlock.value.unshift(new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: "2.16.840.1.101.3.4.2.4" })] }));
      }
      const signedAttrsDer = new Uint8Array(set.toBER(false));
      const signature = await provider.signDigest(sha256(signedAttrsDer));
      return assembleCms({ signedAttrsDer, chainDer: chain, signature, signatureAlgorithm: "RSASSA-PKCS1-v1_5" });
    };
    const r = await validatePdf(await addSignatureIncremental(sealed, { type: "Sig", fieldName: "Sha224", signatureLength: 16_000, sign }), {});
    expect(r.signatures[0].integrity).toEqual({ valid: true });
    expect(r.signatures[0].warnings).toEqual([expect.stringMatching(/no soportado \(2\.16\.840\.1\.101\.3\.4\.2\.4\)/)]);
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

/** RC4 (en OpenSSL 3 está en el proveedor legacy). */
function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/** PDF con /Encrypt R4 (AESV2) y contraseña de usuario vacía, SIN /Length en /Encrypt (solo en /CF /StdCF). */
async function r4WithoutLength(cfLength: number) {
  const { createHash, randomBytes } = await import("node:crypto");
  const md5 = (...b: Buffer[]) => createHash("md5").update(Buffer.concat(b)).digest();
  const pad = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
  const id = randomBytes(16);
  const o = randomBytes(32);
  const p = -3904;
  const pBuf = Buffer.alloc(4);
  pBuf.writeInt32LE(p);
  let key = md5(pad, o, pBuf, id);
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  let u = rc4(key, md5(pad, id));
  for (let i = 1; i <= 19; i++) u = rc4(Buffer.from(key.map((b) => b ^ i)), u);
  u = Buffer.concat([u, Buffer.alloc(16)]);
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const ctx = doc.context;
  const hex = (b: Buffer) => PDFHexString.of(b.toString("hex"));
  const enc = ctx.register(
    ctx.obj({ Filter: "Standard", V: 4, R: 4, O: hex(o), U: hex(u), P: p, StmF: "StdCF", StrF: "StdCF", CF: { StdCF: { CFM: "AESV2", AuthEvent: "DocOpen", Length: cfLength } } }),
  );
  ctx.trailerInfo.Encrypt = enc;
  ctx.trailerInfo.ID = ctx.obj([hex(id), hex(id)]);
  return doc.save({ useObjectStreams: false });
}

describe("PDF cifrado", () => {
  it("R4 sin /Length en /Encrypt toma el largo de /CF /StdCF (16 bytes o 128 bits): pdf_restricted", async () => {
    expect(await codeOf(preparePdfUpload(await r4WithoutLength(16)))).toBe("pdf_restricted");
    expect(await codeOf(preparePdfUpload(await r4WithoutLength(128)))).toBe("pdf_restricted");
  });

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
