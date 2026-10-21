// Revisiones posteriores a una firma que cambian lo que se ve o lo que se ejecuta y antes pasaban como "evidence_only".
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { IncrementalUpdate, changesAfterRevision, findLastStartXref, withDecodeBudget } from "../src";

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
      for (const [r, o] of u.context.enumerateIndirectObjects()) if (o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("OCMD")) ref = r;
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
    const w = u.add(ctx.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", Rect: [0, 0, 0, 0], V: sig, F: 132, P: p.ref, T: PDFString.of("Firma2"), ...extra } as never));
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
      const w = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: opts.rect ?? [0, 0, 0, 0], F: opts.flags ?? 132, P: pageRef, Parent: parent }));
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
    const results = await withDecodeBudget(async () => {
      const current = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
      const out: string[] = [];
      for (const end of ends) out.push(await changesAfterRevision(pdf, end, new Set(keys), current));
      return out;
    }, 24 * 1024 * 1024); // antes de cachear el control de ambigüedad y los streams de objetos hacían falta ~30 MB
    expect(results).toEqual(ends.map(() => "evidence_only"));
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});
