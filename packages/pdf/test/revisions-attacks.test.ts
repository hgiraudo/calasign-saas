// Revisiones posteriores a una firma que cambian lo que se ve o lo que se ejecuta y antes pasaban como "evidence_only".
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { IncrementalUpdate, changesAfterRevision, findLastStartXref, revisionCache, withDecodeBudget } from "../src";

describe("changesAfterRevision", () => {
  it("revisión firmada con un objeto duplicado oculto que una revisión posterior activa (hide-and-replace) → content", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const content = ctx.register(ctx.stream("0 0 1 rg 10 10 100 100 re f"));
    page.node.set(PDFName.of("Contents"), content);
    const orig = Buffer.from(await doc.save({ useObjectStreams: false }));
    const n = content.objectNumber;
    const evil = "1 0 0 rg 0 0 200 200 re f";
    const dup = Buffer.from(`\n${n} 0 obj\n<< /Length ${evil.length} >>\nstream\n${evil}\nendstream\nendobj\n`, "latin1");
    // Revisión "firmada": el lector (por el xref) ve el original; pdf-lib, la copia del final.
    const signed = Buffer.concat([orig, dup]);
    const dupOffset = orig.length + 1;
    const prev = findLastStartXref(orig);
    const root = ctx.trailerInfo.Root!.toString();
    const tail = Buffer.from(
      `xref\n${n} 1\n${String(dupOffset).padStart(10, "0")} 00000 n\r\ntrailer\n<< /Size ${ctx.largestObjectNumber + 1} /Root ${root} /Prev ${prev} >>\nstartxref\n${signed.length}\n%%EOF\n`,
      "latin1",
    );
    const full = new Uint8Array(Buffer.concat([signed, tail]));
    expect(await changesAfterRevision(full, signed.length, new Set())).toBe("content");
  });

  it("cambiar /P de un OCMD (política de visibilidad de una capa) → content", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const ocg = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("L") }));
    const ocmd = ctx.register(ctx.obj({ Type: "OCMD", OCGs: [ocg], P: "AnyOn" }));
    doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [ocg], D: ctx.obj({ ON: [ocg] }) }));
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("/OC /MC0 BDC 0 0 1 rg 10 10 100 100 re f EMC")));
    page.node.set(PDFName.of("Resources"), ctx.obj({ Properties: ctx.obj({ MC0: ocmd }) }));
    const signed = await doc.save({ useObjectStreams: false });

    const modify = async (key: string) => {
      const u = await IncrementalUpdate.open(signed);
      let ref: PDFRef | undefined;
      for (const [r, o] of u.context.enumerateIndirectObjects())
        if (o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("OCMD")) ref = r;
      (u.context.lookup(ref!) as PDFDict).set(PDFName.of(key), PDFName.of("AllOff"));
      u.touch(ref!);
      return u.serialize();
    };
    expect(await changesAfterRevision(await modify("P"), signed.length, new Set())).toBe("content");
    expect(await changesAfterRevision(await modify("X"), signed.length, new Set())).toBe("content");
  });

  async function laterSignatureWidget(extra: Record<string, unknown>) {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText("hello");
    const signed = await doc.save({ useObjectStreams: false });
    const end = signed.length;
    const u = await IncrementalUpdate.open(signed);
    const ctx = u.context;
    const br = [0, 10, 20, end + 1000];
    const sig = u.add(ctx.obj({ Type: "Sig", ByteRange: br, Contents: PDFString.of("x") }));
    const p = u.doc.getPages()[0];
    const w = u.add(
      ctx.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        Rect: [0, 0, 0, 0],
        V: sig,
        F: 132,
        P: p.ref,
        T: PDFString.of("Firma2"),
        ...extra,
      } as never),
    );
    p.node.set(PDFName.of("Annots"), ctx.obj([w]));
    u.touch(p.ref);
    return { full: u.serialize(), end, key: br.join(",") };
  }

  it("widget invisible de una firma posterior que verifica, solo con claves de evidencia → evidence_only", async () => {
    const { full, end, key } = await laterSignatureWidget({});
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("evidence_only");
  });

  it("widget invisible de una firma posterior con /AA (JavaScript) → content", async () => {
    const doc = await PDFDocument.create();
    const js = doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('x')") });
    const { full, end, key } = await laterSignatureWidget({ AA: doc.context.obj({ PO: js }) });
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("content");
  });

  it("widget invisible de una firma posterior con /A (Launch) → content", async () => {
    const doc = await PDFDocument.create();
    const { full, end, key } = await laterSignatureWidget({ A: doc.context.obj({ S: "Launch", F: PDFString.of("calc.exe") }) });
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("content");
  });

  it("widget invisible de una firma posterior con las claves que agregan iText/Acrobat (/StructParent, /Lock, /SV, /TU…) → evidence_only", async () => {
    const doc = await PDFDocument.create();
    const c = doc.context;
    const { full, end, key } = await laterSignatureWidget({
      StructParent: 3,
      Lock: c.obj({ Type: "SigFieldLock", Action: "All" }),
      SV: c.obj({ Type: "SV", Filter: "Adobe.PPKLite" }),
      TU: PDFString.of("Firma de Ana"),
      NM: PDFString.of("abc"),
      M: PDFString.of("D:20260101000000Z"),
      BS: c.obj({ W: 0 }),
      Border: [0, 0, 0],
      DR: c.obj({}),
    });
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("evidence_only");
  });

  it("widget invisible de una firma posterior cuyo campo padre tiene /AA → content", async () => {
    const doc = await PDFDocument.create();
    const js = doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('x')") });
    const { full, end, key } = await splitSignatureField({ parentExtra: { AA: doc.context.obj({ K: js }) }, preexisting: false });
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("content");
  });

  it("campo de firma dividido (widget con /Parent) nuevo en una firma posterior → evidence_only", async () => {
    const { full, end, key } = await splitSignatureField({ preexisting: false });
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("evidence_only");
  });

  it("campo de firma dividido vacío en lo firmado cuyo padre recibe /V (y /Lock) después → evidence_only", async () => {
    const { full, end, key } = await splitSignatureField({ preexisting: true });
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("evidence_only");
    // Si la firma posterior no verifica, su valor sí cuenta.
    expect(await changesAfterRevision(full, end, new Set())).toBe("content");
  });

  it("campo de firma dividido visible en lo firmado cuyo padre recibe /V sin cambiar la apariencia → evidence_only", async () => {
    const { full, end, key } = await splitSignatureField({ preexisting: true, rect: [10, 10, 60, 30], flags: 4 });
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("evidence_only");
  });

  /**
   * Campo de firma dividido: el campo (/FT /Sig, /T, /Kids) y su widget (/Parent). Con `preexisting`, el campo vacío ya
   * está en la revisión firmada y la revisión posterior solo le pone /V y /Lock; si no, la revisión posterior lo agrega.
   */
  async function splitSignatureField(opts: { preexisting: boolean; parentExtra?: Record<string, unknown>; rect?: number[]; flags?: number }) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawText("hello");
    const addField = (ctx: typeof doc.context, pageRef: PDFRef) => {
      const parent = ctx.register(ctx.obj({ FT: "Sig", T: PDFString.of("Firma2"), ...(opts.parentExtra ?? {}) } as never));
      const w = ctx.register(
        ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: opts.rect ?? [0, 0, 0, 0], F: opts.flags ?? 132, P: pageRef, Parent: parent }),
      );
      (ctx.lookup(parent) as PDFDict).set(PDFName.of("Kids"), ctx.obj([w]));
      return { parent, w };
    };
    let parentRef: PDFRef | undefined;
    if (opts.preexisting) {
      const { parent, w } = addField(doc.context, page.ref);
      page.node.set(PDFName.of("Annots"), doc.context.obj([w]));
      doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [parent] }));
      parentRef = parent;
    }
    const signed = await doc.save({ useObjectStreams: false });
    const end = signed.length;
    const u = await IncrementalUpdate.open(signed);
    const ctx = u.context;
    const br = [0, 10, 20, end + 1000];
    const sig = u.add(ctx.obj({ Type: "Sig", ByteRange: br, Contents: PDFString.of("x") }));
    if (opts.preexisting) {
      // Al cargar de nuevo, las referencias conservan su número.
      const parent = ctx.lookup(parentRef!) as PDFDict;
      parent.set(PDFName.of("V"), sig);
      parent.set(PDFName.of("Lock"), ctx.obj({ Type: "SigFieldLock", Action: "All" }));
      u.touch(parentRef!);
    } else {
      const p = u.doc.getPages()[0];
      const parent = u.add(ctx.obj({ FT: "Sig", T: PDFString.of("Firma2"), V: sig, ...(opts.parentExtra ?? {}) } as never));
      const w = u.add(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 0, 0], F: 132, P: p.ref, Parent: parent }));
      (ctx.lookup(parent) as PDFDict).set(PDFName.of("Kids"), ctx.obj([w]));
      u.touch(parent);
      p.node.set(PDFName.of("Annots"), ctx.obj([w]));
      u.touch(p.ref);
    }
    return { full: u.serialize(), end, key: br.join(",") };
  }

  it("muchas firmas incrementales (8 revisiones) sobre un PDF con streams de objetos: dentro del tope y rápido", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawText("hello");
    const ctx = doc.context;
    // ~1,5 MB descomprimidos en streams de objetos.
    const filler = ctx.obj([]) as PDFArray;
    for (let i = 0; i < 1500; i++) filler.push(ctx.register(ctx.obj({ Pad: PDFString.of("x".repeat(1000)) })));
    doc.catalog.set(PDFName.of("Filler"), ctx.register(filler));
    let pdf = await doc.save({ useObjectStreams: true });
    const keys: string[] = [];
    const ends: number[] = [];
    for (let r = 0; r < 8; r++) {
      ends.push(pdf.length);
      const u = await IncrementalUpdate.open(pdf);
      const c = u.context;
      const br = [0, 10, 20, pdf.length + 1000 * (r + 1)];
      keys.push(br.join(","));
      const sig = u.add(c.obj({ Type: "Sig", ByteRange: br, Contents: PDFString.of("x") }));
      const p = u.doc.getPages()[0];
      const w = u.add(c.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", Rect: [0, 0, 0, 0], V: sig, F: 132, P: p.ref, T: PDFString.of(`F${r}`) }));
      const annots = p.node.lookup(PDFName.of("Annots"));
      p.node.set(PDFName.of("Annots"), c.obj([...(annots instanceof PDFArray ? annots.asArray() : []), w]));
      u.touch(p.ref);
      pdf = u.serialize();
    }
    const t0 = Date.now();
    const results = await withDecodeBudget(
      async () => {
        const current = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
        const out: string[] = [];
        const cache = revisionCache(pdf);
        for (const end of ends) out.push(await changesAfterRevision(pdf, end, new Set(keys), current, cache));
        return out;
      },
      24 * 1024 * 1024,
    ); // antes de cachear el control de ambigüedad y los streams de objetos hacían falta ~30 MB
    expect(results).toEqual(ends.map(() => "evidence_only"));
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});

describe("changesAfterRevision: regresiones de la 145ª pasada", () => {
  type Extra = Record<string, unknown> | ((u: IncrementalUpdate) => Record<string, unknown>);

  /** Revisión posterior que agrega a la página una anotación (por defecto, un widget de firma invisible). */
  async function laterAnnot(extra: Extra, withSig: boolean) {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText("hello");
    const signed = await doc.save({ useObjectStreams: false });
    const end = signed.length;
    const u = await IncrementalUpdate.open(signed);
    const ctx = u.context;
    const br = [0, 10, 20, end + 1000];
    const sig = withSig ? { V: u.add(ctx.obj({ Type: "Sig", ByteRange: br, Contents: PDFString.of("x") })) } : {};
    const p = u.doc.getPages()[0];
    const more = typeof extra === "function" ? extra(u) : extra;
    const w = u.add(
      ctx.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        Rect: [0, 0, 0, 0],
        F: 132,
        P: p.ref,
        T: PDFString.of("Firma2"),
        ...sig,
        ...more,
      } as never),
    );
    p.node.set(PDFName.of("Annots"), ctx.obj([w]));
    u.touch(p.ref);
    return { full: u.serialize(), end, key: br.join(",") };
  }
  const fullPageAp = (u: IncrementalUpdate) => ({
    AP: u.context.obj({ N: u.add(u.context.stream("1 0 0 rg 0 0 200 200 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200] })) }),
  });
  const emptyAp = (u: IncrementalUpdate) => ({
    AP: u.context.obj({ N: u.add(u.context.stream(" ", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 0, 0] })) }),
  });

  it("dos ObjStm con el mismo diccionario y largo: el xref apunta un objeto al malicioso → content", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawText("hello");
    const ctx = doc.context;
    const media = ctx.register(ctx.obj([0, 0, 200, 200]));
    page.node.set(PDFName.of("MediaBox"), media);
    const signed = Buffer.from(await doc.save({ useObjectStreams: false }));
    const M = media.objectNumber;
    const E = ctx.largestObjectNumber + 1;
    const [A, B, X] = [E + 1, E + 2, E + 3];
    // Mismo /N, /First y /Length (pdf-lib copia los bytes del stream: su byteOffset es siempre 0).
    const objStm = (num: number, box: string) => {
      const head = `${E} 0 ${M} 5 `;
      const body = `${head}null ${box}`;
      return Buffer.from(
        `${num} 0 obj\n<< /Type /ObjStm /N 2 /First ${head.length} /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`,
        "latin1",
      );
    };
    // B (malicioso) primero: pdf-lib se queda con la última definición (A, benigna); el lector, con lo que dice el xref.
    const parts: Buffer[] = [signed, Buffer.from("\n")];
    const offB = signed.length + 1;
    parts.push(objStm(B, "[0 0 900 900]"));
    const offA = offB + parts[2].length;
    parts.push(objStm(A, "[0 0 200 200]"));
    const offX = offA + parts[3].length;
    // W [1 4 2]; /Index en este orden: E (en A) se resuelve antes que M (en B).
    const row = (t: number, a: number, b: number) =>
      Buffer.from([t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >>> 8) & 255, b & 255]);
    const rows = Buffer.concat([row(2, A, 0), row(2, B, 1), row(1, offA, 0), row(1, offB, 0), row(1, offX, 0)]);
    const root = ctx.trailerInfo.Root!.toString();
    const xref = Buffer.concat([
      Buffer.from(
        `${X} 0 obj\n<< /Type /XRef /Size ${X + 1} /Root ${root} /Prev ${findLastStartXref(signed)} /W [1 4 2] /Index [${E} 1 ${M} 1 ${A} 1 ${B} 1 ${X} 1] /Length ${rows.length} >>\nstream\n`,
        "latin1",
      ),
      rows,
      Buffer.from(`\nendstream\nendobj\nstartxref\n${offX}\n%%EOF\n`, "latin1"),
    ]);
    const full = new Uint8Array(Buffer.concat([...parts, xref]));
    expect(await changesAfterRevision(full, signed.length, new Set())).toBe("content");
  });

  it("anotación /Text con /FT /Sig, /V que verifica y /Contents → content", async () => {
    const { full, end, key } = await laterAnnot({ Subtype: "Text", Contents: PDFString.of("Pagar a otra cuenta"), F: 2 }, true);
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("content");
  });

  it("anotación /Text con /FT /Sig vacía (sin /V) → content", async () => {
    const { full, end } = await laterAnnot({ Subtype: "Text", Contents: PDFString.of("x"), F: 2 }, false);
    expect(await changesAfterRevision(full, end, new Set())).toBe("content");
  });

  it("anotación /FileAttachment con /FT /Sig → content", async () => {
    const { full, end, key } = await laterAnnot(
      (u) => ({ Subtype: "FileAttachment", FS: u.context.obj({ Type: "Filespec", F: PDFString.of("a.exe") }), F: 2 }),
      true,
    );
    expect(await changesAfterRevision(full, end, new Set([key]))).toBe("content");
  });

  it("widget de firma invisible con /AF (archivo asociado) → content", async () => {
    const af = (u: IncrementalUpdate) => ({ AF: u.context.obj([u.context.obj({ Type: "Filespec", F: PDFString.of("a.exe") })]) });
    const later = await laterAnnot(af, true);
    expect(await changesAfterRevision(later.full, later.end, new Set([later.key]))).toBe("content");
    const empty = await laterAnnot(af, false);
    expect(await changesAfterRevision(empty.full, empty.end, new Set())).toBe("content");
  });

  it("campo de firma vacío con claves fuera de la lista (/Contents, /C) → content", async () => {
    for (const extra of [{ Contents: PDFString.of("x") }, { C: [1, 0, 0] }]) {
      const { full, end } = await laterAnnot(extra, false);
      expect(await changesAfterRevision(full, end, new Set())).toBe("content");
    }
  });

  it("campo de firma vacío pre-creado e invisible (sin /AP o con /AP vacío, /MK, /DA…) → evidence_only", async () => {
    const plain = await laterAnnot({ Ff: 0, DA: PDFString.of("/Helv 0 Tf 0 g"), StructParent: 2, TU: PDFString.of("Firma") }, false);
    expect(await changesAfterRevision(plain.full, plain.end, new Set())).toBe("evidence_only");
    const withAp = await laterAnnot((u) => ({ ...emptyAp(u), MK: u.context.obj({}) }), false);
    expect(await changesAfterRevision(withAp.full, withAp.end, new Set())).toBe("evidence_only");
  });

  it("campo de firma vacío con /AP que dibuja: de área cero no se ve (evidence_only); con rectángulo, content aunque sea Hidden", async () => {
    // La apariencia se escala al rectángulo: con área cero no se dibuja (146ª pasada: ya no hace falta Hidden).
    const zero = await laterAnnot(fullPageAp, false);
    expect(await changesAfterRevision(zero.full, zero.end, new Set())).toBe("evidence_only");
    const hidden = await laterAnnot((u) => ({ ...fullPageAp(u), F: 2 }), false);
    expect(await changesAfterRevision(hidden.full, hidden.end, new Set())).toBe("evidence_only");
    const rect = await laterAnnot((u) => ({ ...fullPageAp(u), F: 2, Rect: [0, 0, 200, 200] }), false);
    expect(await changesAfterRevision(rect.full, rect.end, new Set())).toBe("content");
  });

  it("widget de firma con NoView y Print (/F 36), de página entera y /AP → content", async () => {
    const extra = (u: IncrementalUpdate) => ({ ...fullPageAp(u), F: 36, Rect: [0, 0, 200, 200] });
    const empty = await laterAnnot(extra, false);
    expect(await changesAfterRevision(empty.full, empty.end, new Set())).toBe("content");
    // Aunque la firma posterior verifique: con Print se imprime.
    const later = await laterAnnot(extra, true);
    expect(await changesAfterRevision(later.full, later.end, new Set([later.key]))).toBe("content");
    // NoView sin Print no se ve ni se imprime.
    const noPrint = await laterAnnot((u) => ({ ...extra(u), F: 32 }), true);
    expect(await changesAfterRevision(noPrint.full, noPrint.end, new Set([noPrint.key]))).toBe("evidence_only");
    // Salvo con ToggleNoView (256): se muestra al pasar el mouse.
    const toggle = await laterAnnot((u) => ({ ...extra(u), F: 32 | 256 }), true);
    expect(await changesAfterRevision(toggle.full, toggle.end, new Set([toggle.key]))).toBe("content");
  });

  /** Campo de firma vacío y visible en lo firmado; la revisión posterior le cuelga otro widget (fuera de /Annots). */
  async function kidAddedToExistingField(kid: (u: IncrementalUpdate) => Record<string, unknown>) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawText("hello");
    const ctx = doc.context;
    const parent = ctx.register(ctx.obj({ FT: "Sig", T: PDFString.of("Firma1") }));
    const w1 = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [10, 10, 60, 30], F: 4, P: page.ref, Parent: parent }));
    (ctx.lookup(parent) as PDFDict).set(PDFName.of("Kids"), ctx.obj([w1]));
    page.node.set(PDFName.of("Annots"), ctx.obj([w1]));
    doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [parent] }));
    const signed = await doc.save({ useObjectStreams: false });
    const u = await IncrementalUpdate.open(signed);
    const pageRef = u.doc.getPages()[0].ref;
    const w2 = u.add(u.context.obj({ Type: "Annot", Subtype: "Widget", P: pageRef, Parent: parent, ...kid(u) } as never));
    (u.context.lookup(parent) as PDFDict).set(PDFName.of("Kids"), u.context.obj([w1, w2]));
    u.touch(parent);
    return { full: u.serialize(), end: signed.length };
  }

  it("widget nuevo colgado de un campo de firma existente → content; si es un widget de evidencia → evidence_only", async () => {
    const visible = await kidAddedToExistingField((u) => ({ Rect: [0, 0, 200, 200], F: 4, ...fullPageAp(u) }));
    expect(await changesAfterRevision(visible.full, visible.end, new Set())).toBe("content");
    const invisible = await kidAddedToExistingField(() => ({ Rect: [0, 0, 0, 0], F: 132 }));
    expect(await changesAfterRevision(invisible.full, invisible.end, new Set())).toBe("evidence_only");
  });

  it("dos validaciones de PDFs que comparten ArrayBuffer (como un pool de Buffer) no se mezclan", async () => {
    const doc = await PDFDocument.create();
    const js = doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('x')") });
    const bad = await laterAnnot({ AA: js }, true);
    const good = await laterAnnot({}, true);
    const pool = new ArrayBuffer(bad.full.length + good.full.length + 64);
    const first = new Uint8Array(pool, 0, bad.full.length);
    first.set(bad.full);
    expect(await changesAfterRevision(first, bad.end, new Set([bad.key]))).toBe("content");
    const second = new Uint8Array(pool, bad.full.length + 8, good.full.length);
    second.set(good.full);
    expect(await changesAfterRevision(second, good.end, new Set([good.key]))).toBe("evidence_only");
    // La misma región reescrita con otro PDF.
    const third = new Uint8Array(pool, 0, good.full.length);
    third.set(good.full);
    expect(await changesAfterRevision(third, good.end, new Set([good.key]))).toBe("evidence_only");
  });

  /**
   * Campo de firma vacío pre-creado por un editor (en la revisión firmada) que una revisión posterior firma: el widget
   * recibe /V y una apariencia nueva.
   */
  async function preplacedThenSigned(
    widget: (ctx: PDFContext) => Record<string, unknown>,
    opts: { verified?: boolean; tamper?: (u: IncrementalUpdate, w: PDFDict) => void } = {},
  ) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawText("hello");
    const ctx = doc.context;
    const w = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        T: PDFString.of("Firma2"),
        Rect: [0, 0, 0, 0],
        F: 132,
        P: page.ref,
        ...widget(ctx),
      } as never),
    );
    page.node.set(PDFName.of("Annots"), ctx.obj([w]));
    doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [w] }));
    const signed = await doc.save({ useObjectStreams: false });
    const end = signed.length;
    const u = await IncrementalUpdate.open(signed);
    const br = [0, 10, 20, end + 1000];
    const sig = u.add(u.context.obj({ Type: "Sig", ByteRange: br, Contents: PDFString.of("x") }));
    const wd = u.context.lookup(w) as PDFDict;
    wd.set(PDFName.of("V"), sig);
    wd.set(PDFName.of("AP"), u.context.obj({ N: u.add(u.context.stream("% DSBlank\n", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 0, 0] })) }));
    opts.tamper?.(u, wd);
    u.touch(w);
    const full = u.serialize();
    return changesAfterRevision(full, end, opts.verified === false ? new Set() : new Set([br.join(",")]));
  }
  const blankAp = (ctx: PDFContext, content: string) => ({
    AP: ctx.obj({ N: ctx.register(ctx.stream(content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 50, 20] })) }),
  });

  it("campo pre-creado con /DV, /Q, /AS, /H y apariencia en blanco de Acrobat, firmado después → evidence_only", async () => {
    const dv = (ctx: PDFContext) => ({ DV: ctx.obj({ Type: "Sig" }), Q: 1, AS: PDFName.of("N"), H: PDFName.of("P") });
    expect(await preplacedThenSigned(dv)).toBe("evidence_only");
    expect(await preplacedThenSigned((ctx) => ({ ...dv(ctx), ...blankAp(ctx, "% DSBlank\n") }))).toBe("evidence_only");
    expect(await preplacedThenSigned((ctx) => ({ ...blankAp(ctx, "q Q") }))).toBe("evidence_only");
    expect(await preplacedThenSigned((ctx) => ({ ...blankAp(ctx, "q\n% DSBlank\nq Q\nQ\n") }))).toBe("evidence_only");
    // Con rectángulo pero Hidden y una apariencia cualquiera (no se ve): firmado y verificado, se compara sin la lista estricta.
    expect(await preplacedThenSigned((ctx) => ({ ...blankAp(ctx, "1 0 0 rg 0 0 50 20 re f"), F: 2, Rect: [10, 10, 60, 30], C: [1, 0, 0] }))).toBe(
      "evidence_only",
    );
  });

  it("campo pre-creado: lo que sigue contando", async () => {
    // Sin firma que verifique, la lista estricta: /C no está.
    expect(
      await preplacedThenSigned((ctx) => ({ ...blankAp(ctx, "1 0 0 rg 0 0 50 20 re f"), F: 2, Rect: [10, 10, 60, 30], C: [1, 0, 0] }), {
        verified: false,
      }),
    ).toBe("content");
    // Acciones en lo firmado o agregadas después.
    expect(await preplacedThenSigned((ctx) => ({ AA: ctx.obj({ PO: ctx.obj({ S: "JavaScript", JS: PDFString.of("x") }) }) }))).toBe("content");
    expect(
      await preplacedThenSigned(() => ({}), {
        tamper: (u, w) => w.set(PDFName.of("A"), u.context.obj({ S: "Launch", F: PDFString.of("calc.exe") })),
      }),
    ).toBe("content");
    // La firma posterior lo vuelve visible.
    expect(await preplacedThenSigned(() => ({}), { tamper: (u, w) => w.set(PDFName.of("Rect"), u.context.obj([0, 0, 200, 200])) })).toBe("content");
  });

  it("apariencias que no son en blanco: operadores u operandos, q/Q desbalanceados", async () => {
    const { blankContent } = await import("../src/revisions");
    const b = (s: string) => blankContent(Buffer.from(s, "latin1"));
    expect(b("")).toBe(true);
    expect(b("% DSBlank\n")).toBe(true);
    expect(b("q Q")).toBe(true);
    expect(b("q q Q Q % x")).toBe(true);
    expect(b("qQ")).toBe(false);
    expect(b("q")).toBe(false);
    expect(b("Q q")).toBe(false);
    expect(b("q 0 0 m Q")).toBe(false);
    expect(b("q /Fm0 Do Q")).toBe(false);
    expect(b("q (x) Tj Q")).toBe(false);
    // Vacío en lo firmado con apariencia que dibuja y rectángulo (sin Hidden ni firma después) → content.
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText("hello");
    const signed = await doc.save({ useObjectStreams: false });
    const u = await IncrementalUpdate.open(signed);
    const p = u.doc.getPages()[0];
    const ap = u.context.obj({
      N: u.add(u.context.stream("q 1 0 0 rg 0 0 200 200 re f Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 200] })),
    });
    const w = u.add(
      u.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", Rect: [0, 0, 200, 200], F: 32, P: p.ref, T: PDFString.of("F"), AP: ap } as never),
    );
    p.node.set(PDFName.of("Annots"), u.context.obj([w]));
    u.touch(p.ref);
    expect(await changesAfterRevision(u.serialize(), signed.length, new Set())).toBe("content");
  });

  /** Un campo de firma con `n` widgets (todos en /Annots) en lo firmado; la revisión posterior agrega un objeto suelto. */
  async function manyKids(n: number) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([3000, 200]);
    const ctx = doc.context;
    const parent = ctx.register(ctx.obj({ FT: "Sig", T: PDFString.of("p") }));
    const kids = ctx.obj([]);
    for (let i = 0; i < n; i++)
      kids.push(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [i, 0, i + 10, 10], F: 4, Parent: parent, P: page.ref })));
    (ctx.lookup(parent) as PDFDict).set(PDFName.of("Kids"), kids);
    page.node.set(PDFName.of("Annots"), kids);
    doc.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [parent] }));
    const signed = await doc.save({ useObjectStreams: false });
    const u = await IncrementalUpdate.open(signed);
    return { u, parent, kids: kids.asArray() as PDFRef[], end: signed.length };
  }

  it("campo de firma con 2000 widgets: se compara en menos de 2 s", async () => {
    const { u, end } = await manyKids(2000);
    u.add(u.context.obj({ Unused: true }));
    const full = u.serialize();
    // Una vuelta de calentamiento (JIT): se mide la segunda. Con la comparación cuadrática tardaba casi un minuto.
    expect(await changesAfterRevision(full, end, new Set())).toBe("evidence_only");
    const t = Date.now();
    expect(await changesAfterRevision(full, end, new Set())).toBe("evidence_only");
    expect(Date.now() - t).toBeLessThan(2000);
  }, 30_000);

  it("con muchos hijos, un widget nuevo colgado del campo (fuera de /Annots) sigue contando", async () => {
    for (const n of [20, 600]) {
      const { u, parent, kids, end } = await manyKids(n);
      const pageRef = u.doc.getPages()[0].ref;
      const extra = u.add(u.context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 200, 200], F: 4, P: pageRef, Parent: parent }));
      (u.context.lookup(parent) as PDFDict).set(PDFName.of("Kids"), u.context.obj([...kids, extra]));
      u.touch(parent);
      expect(await changesAfterRevision(u.serialize(), end, new Set())).toBe("content");
    }
  }, 30_000);
});
