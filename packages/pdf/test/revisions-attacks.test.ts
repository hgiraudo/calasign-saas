// Revisiones posteriores a una firma que cambian lo que se ve o lo que se ejecuta y antes pasaban como "evidence_only".
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { IncrementalUpdate, changesAfterRevision, findLastStartXref } from "../src";

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
});
