// Qué cambió en las revisiones incrementales posteriores a una firma. Una revisión que agrega evidencia (DSS, otra firma,
// sello de documento) no toca lo que se ve; una que cambia páginas o anotaciones sí ("incremental saving attack"): la
// firma anterior sigue verificando sobre su revisión, pero el documento que se muestra ya no es el firmado.
import { createHash } from "node:crypto";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";

export type ChangesAfter = "none" | "evidence_only" | "content";

const h = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const INHERITABLE = ["Resources", "MediaBox", "CropBox", "Rotate"];

class Canon {
  private memo = new Map<string, string>();
  private stack = new Set<string>();
  constructor(private ctx: PDFContext) {}

  of(o: PDFObject | undefined): string {
    if (o === undefined) return "u";
    if (o instanceof PDFRef) {
      const memo = this.memo.get(o.tag);
      if (memo) return memo;
      if (this.stack.has(o.tag)) return "cycle";
      this.stack.add(o.tag);
      const v = "R" + h(this.of(this.ctx.lookup(o)));
      this.stack.delete(o.tag);
      this.memo.set(o.tag, v);
      return v;
    }
    if (o instanceof PDFRawStream) return `S${this.dict(o.dict)}${h(o.contents)}`;
    if (o instanceof PDFStream) return `S${this.dict(o.dict)}${h(o.getContents())}`;
    if (o instanceof PDFDict) return this.dict(o);
    if (o instanceof PDFArray) return `[${o.asArray().map((x) => this.of(x)).join(",")}]`;
    return `${o.constructor.name}:${o.toString()}`;
  }

  /** Diccionario con claves ordenadas. Sin /P (anotación → página) ni, en páginas, /Parent y /Annots (van aparte). */
  dict(d: PDFDict, extra?: Map<string, PDFObject | undefined>): string {
    const type = d.get(PDFName.of("Type"));
    const isPage = type instanceof PDFName && (type.decodeText() === "Page" || type.decodeText() === "Pages");
    const entries = new Map<string, PDFObject | undefined>();
    for (const [k, v] of d.entries()) {
      const key = k.decodeText();
      if (key === "P" || (isPage && (key === "Parent" || key === "Annots" || key === "Kids"))) continue;
      entries.set(key, v);
    }
    for (const [k, v] of extra ?? []) if (!entries.has(k) && v !== undefined) entries.set(k, v);
    const keys = [...entries.keys()].sort();
    return `<<${keys.map((k) => `/${k}=${this.of(entries.get(k))}`).join(";")}>>`;
  }
}

/**
 * Widget que no se ve: rectángulo de área cero o banderas Hidden (2) / NoView (32). Solo esos cuentan como evidencia:
 * un widget de firma visible puede dibujar cualquier cosa encima de la página (su apariencia es un dibujo arbitrario),
 * así que una firma posterior visible —aunque verifique, por ejemplo con un certificado autofirmado— sí cambia lo que se ve.
 */
function isInvisibleWidget(ctx: PDFContext, annot: PDFDict): boolean {
  const f = annot.get(PDFName.of("F"));
  const flags = f instanceof PDFNumber ? f.asNumber() : 0;
  if (flags & 2 || flags & 32) return true;
  const rect = lookupArray(ctx, annot.get(PDFName.of("Rect")));
  if (!rect || rect.length !== 4) return false;
  const [x1, y1, x2, y2] = rect.map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN));
  if ([x1, y1, x2, y2].some((n) => !Number.isFinite(n))) return false;
  return Math.abs(x2 - x1) < 0.01 || Math.abs(y2 - y1) < 0.01;
}

/**
 * Huella de lo que, a nivel de documento, cambia lo que se muestra sin tocar las páginas: capas opcionales (OCProperties
 * decide qué contenido se ve), acciones al abrir (OpenAction/AA), JavaScript de documento, y en AcroForm XFA (reemplaza
 * la vista entera) y NeedAppearances (regenera las apariencias de los campos). Las revisiones legítimas (DSS, firmas y
 * sellos) solo tocan /DSS y AcroForm /Fields y /SigFlags.
 */
function documentFingerprint(doc: PDFDocument): string {
  const ctx = doc.context;
  const canon = new Canon(ctx);
  const cat = doc.catalog;
  const parts = ["OCProperties", "OpenAction", "AA"].map((k) => `${k}=${canon.of(cat.get(PDFName.of(k)))}`);
  const names = lookupDict(ctx, cat.get(PDFName.of("Names")));
  parts.push(`JavaScript=${canon.of(names?.get(PDFName.of("JavaScript")))}`);
  const acro = lookupDict(ctx, cat.get(PDFName.of("AcroForm")));
  for (const k of ["XFA", "NeedAppearances"]) parts.push(`AcroForm.${k}=${canon.of(acro?.get(PDFName.of(k)))}`);
  return h(parts.join("|"));
}

function lookupDict(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFDict ? v : undefined;
}

/** ByteRange (como "a,b,c,d") del valor de un widget de campo de firma ya firmado, o null si no lo es. */
function signatureWidgetKey(ctx: PDFContext, annot: PDFDict): string | null {
  let ft: PDFObject | undefined;
  let v: PDFObject | undefined;
  let cur: PDFDict | undefined = annot;
  for (let i = 0; cur && i < 32; i++) {
    ft ??= cur.get(PDFName.of("FT"));
    v ??= cur.get(PDFName.of("V"));
    cur = lookupDict(ctx, cur.get(PDFName.of("Parent")));
  }
  if (!(ft instanceof PDFName) || ft.decodeText() !== "Sig") return null;
  const br = lookupArray(ctx, lookupDict(ctx, v)?.get(PDFName.of("ByteRange")));
  return br ? br.map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN)).join(",") : null;
}

/**
 * Huella de cada página: diccionario (con atributos heredados), contenido, recursos y anotaciones. Se omiten solo los
 * widgets invisibles de firmas posteriores que verifican (`evidence`): cada uno tiene que ser el único widget con ese
 * ByteRange, para que no se pueda colgar una apariencia falsa del valor de una firma real.
 */
function pageFingerprints(doc: PDFDocument, evidence: Set<string>): string[] {
  const ctx = doc.context;
  const canon = new Canon(ctx);
  const pages = doc.getPages().map((p) => {
    const annots = (lookupArray(ctx, p.node.get(PDFName.of("Annots"))) ?? []).map((a) => ({ tag: a instanceof PDFRef ? a.tag : null, d: lookupDict(ctx, a) }));
    return { node: p.node, annots: annots.filter((a): a is { tag: string | null; d: PDFDict } => !!a.d) };
  });
  const widgets = new Map<string, Set<unknown>>();
  for (const p of pages) {
    for (const a of p.annots) {
      const key = signatureWidgetKey(ctx, a.d);
      if (key) widgets.set(key, (widgets.get(key) ?? new Set()).add(a.tag ?? a.d));
    }
  }
  return pages.map(({ node, annots }) => {
    const inherited = new Map(INHERITABLE.map((k) => [k, node.getInheritableAttribute(PDFName.of(k)) as PDFObject | undefined]));
    const visible = annots
      .filter((a) => {
        const key = signatureWidgetKey(ctx, a.d);
        return !(key && evidence.has(key) && widgets.get(key)?.size === 1 && isInvisibleWidget(ctx, a.d));
      })
      .map((a) => h(canon.dict(a.d)))
      .sort();
    return h(`${canon.dict(node, inherited)}|${visible.join(",")}`);
  });
}

function lookupArray(ctx: PDFContext, o: PDFObject | undefined): PDFObject[] | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFArray ? v.asArray() : undefined;
}

/**
 * Compara lo visible (páginas, su contenido y recursos, y anotaciones) entre la revisión firmada (`pdf[0, end)`) y el
 * documento completo. `laterSignatures`: ByteRanges ("a,b,c,d") de las firmas y sellos que verifican; solo sus widgets
 * agregados después de `end` cuentan como evidencia. `current` permite reutilizar el documento completo ya cargado.
 */
export async function changesAfterRevision(pdf: Uint8Array, end: number, laterSignatures: Set<string>, current?: PDFDocument): Promise<ChangesAfter> {
  if (end >= pdf.length) return "none";
  try {
    const full = current ?? (await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true }));
    const signed = await PDFDocument.load(pdf.subarray(0, end), { updateMetadata: false, ignoreEncryption: true });
    const evidence = new Set([...laterSignatures].filter((k) => {
      const [, , c, d] = k.split(",").map(Number);
      return c + d > end;
    }));
    const a = pageFingerprints(signed, evidence);
    const b = pageFingerprints(full, evidence);
    const samePages = a.length === b.length && a.every((x, i) => x === b[i]);
    return samePages && documentFingerprint(signed) === documentFingerprint(full) ? "evidence_only" : "content";
  } catch {
    // Si la revisión firmada no se puede leer, no se puede afirmar que lo que se muestra es lo firmado.
    return "content";
  }
}
