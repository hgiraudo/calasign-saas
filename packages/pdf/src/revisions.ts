// Qué cambió en las revisiones incrementales posteriores a una firma. Una revisión que agrega evidencia (DSS, otra firma,
// sello de documento) no toca lo que se ve; una que cambia páginas o anotaciones sí ("incremental saving attack"): la
// firma anterior sigue verificando sobre su revisión, pero el documento que se muestra ya no es el firmado.
import { createHash } from "node:crypto";
import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFObjectStreamParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject,
} from "pdf-lib";
import { findLastStartXref } from "./incremental";

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

  /**
   * Diccionario con claves ordenadas. Sin /P en anotaciones (anotación → página: la página se compara aparte) ni, en
   * páginas, /Parent y /Annots (van aparte). En cualquier otro diccionario /P sí cuenta: en un OCMD es la política de
   * visibilidad (AllOn/AnyOn/AllOff…), en una acción Launch o un elemento de estructura es parte de lo que hace.
   */
  dict(d: PDFDict, extra?: Map<string, PDFObject | undefined>, omit?: ReadonlySet<string>): string {
    const type = d.get(PDFName.of("Type"));
    const isPage = type instanceof PDFName && (type.decodeText() === "Page" || type.decodeText() === "Pages");
    const annot = isAnnotation(d);
    const entries = new Map<string, PDFObject | undefined>();
    for (const [k, v] of d.entries()) {
      const key = k.decodeText();
      if ((annot && key === "P") || (isPage && (key === "Parent" || key === "Annots" || key === "Kids")) || omit?.has(key)) continue;
      entries.set(key, v);
    }
    for (const [k, v] of extra ?? []) if (!entries.has(k) && v !== undefined) entries.set(k, v);
    const keys = [...entries.keys()].sort();
    return `<<${keys.map((k) => `/${k}=${this.of(entries.get(k))}`).join(";")}>>`;
  }

  /**
   * Widget de un campo de firma con su cadena de campos (/Parent): cada diccionario sin las claves de `omit` ni /Parent
   * (la cadena ya dice quién es el padre) y, en los campos padre, sin /Kids (los widgets hermanos están en sus páginas y se
   * comparan ahí; por /Kids volvería a entrar el /V que se quiere omitir).
   */
  field(chain: PDFDict[], omit: ReadonlySet<string>): string {
    const own = new Set([...omit, "Parent"]);
    const parent = new Set([...own, "Kids"]);
    return chain.map((d, i) => this.dict(d, undefined, i === 0 ? own : parent)).join(">");
  }
}

/** Subtipos de anotación (ISO 32000-2, 12.5.6). */
const ANNOT_SUBTYPES = new Set([
  "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly",
  "StrikeOut", "Caret", "Stamp", "Ink", "Popup", "FileAttachment", "Sound", "Movie", "Screen", "Widget", "PrinterMark",
  "TrapNet", "Watermark", "3D", "Redact", "Projection", "RichMedia",
]);

/** ¿Es un diccionario de anotación? /Type /Annot o, sin /Type (es opcional), un /Subtype de anotación. */
function isAnnotation(d: PDFDict): boolean {
  const type = d.get(PDFName.of("Type"));
  if (type instanceof PDFName) return type.decodeText() === "Annot";
  const sub = d.get(PDFName.of("Subtype"));
  return sub instanceof PDFName && ANNOT_SUBTYPES.has(sub.decodeText());
}

/**
 * Claves que, en el widget de un campo de firma o en cualquier campo de su cadena (/Parent), impiden que cuente como
 * evidencia: acciones (/A, /AA: JavaScript al abrir la página, Launch, acciones de campo heredables) y capas (/OC). Es
 * una lista de exclusión: los firmadores de terceros (iText, Acrobat, pyHanko) agregan /StructParent, /Lock, /SV, /TU,
 * /NM, /M, /BS, /Border, /DR, /Parent, /Kids, /DV…, que no hacen nada en un widget que no se ve.
 */
const ACTIVE_FIELD_KEYS = ["A", "AA", "OC"].map((k) => PDFName.of(k));
/**
 * Del widget de un campo de firma (y de sus campos padre) no se comparan /Lock ni /SV (qué campos bloquear al firmar y
 * los valores semilla: restringen la firma, no cambian lo que se ve) y, si la firma es posterior y verifica, tampoco /V.
 */
const SIGNATURE_FIELD_OMIT = new Set(["Lock", "SV"]);
const LATER_SIGNATURE_OMIT = new Set(["V", "Lock", "SV"]);

interface SignatureField {
  /** El widget y sus campos padre (/Parent), del widget hacia arriba. */
  chain: PDFDict[];
  /** ByteRange ("a,b,c,d") del valor, si lo tiene. */
  key: string | null;
  /** Campo de firma sin valor (/V). */
  empty: boolean;
}

/** Si `annot` es el widget de un campo de firma (/FT /Sig, propio o heredado), su cadena de campos y su valor. */
function signatureField(ctx: PDFContext, annot: PDFDict): SignatureField | null {
  const chain: PDFDict[] = [];
  let ft: PDFObject | undefined;
  let v: PDFObject | undefined;
  for (let cur: PDFDict | undefined = annot; cur && chain.length < 32 && !chain.includes(cur); cur = lookupDict(ctx, cur.get(PDFName.of("Parent")))) {
    chain.push(cur);
    ft ??= cur.get(PDFName.of("FT"));
    v ??= cur.get(PDFName.of("V"));
  }
  const ftv = ft instanceof PDFRef ? ctx.lookup(ft) : ft;
  if (!(ftv instanceof PDFName) || ftv.decodeText() !== "Sig") return null;
  const br = lookupArray(ctx, lookupDict(ctx, v)?.get(PDFName.of("ByteRange")));
  return { chain, key: br ? br.map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN)).join(",") : null, empty: v === undefined };
}

function hasActiveKeys(chain: PDFDict[]): boolean {
  return chain.some((d) => ACTIVE_FIELD_KEYS.some((k) => d.has(k)));
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
 * Huella del catálogo: lo que, a nivel de documento, decide qué se muestra o qué se ejecuta sin tocar las páginas (que se
 * comparan aparte, pageFingerprints). Se compara el catálogo canónico salvo lo que revisiones legítimas de terceros
 * agregan o reescriben sin cambiar lo que se ve:
 * - lo de cada firma o renovación: /DSS (LTV), /Perms y, del /AcroForm, /Fields y /SigFlags;
 * - lo que reescriben firmadores y editores (iText, pyHanko, Acrobat): /Extensions (ESIC), /Version, /Metadata (XMP),
 *   /Lang, /MarkInfo, /StructTreeRoot, /PageLabels, /ViewerPreferences, /Outlines (marcadores) y /Dests; del /AcroForm,
 *   /DR, /DA y /Q mientras todo widget que no es de firma tenga apariencia propia (/AP /N: el lector la dibuja y no usa
 *   esos valores; si alguno no la tiene, el lector la arma con /DA y /DR y se comparan), y NeedAppearances cuando queda
 *   false o se quita (true hace que el lector regenere las apariencias).
 * - De los marcadores (/Outlines) sí cuentan las acciones (/A, salvo un GoTo simple, que equivale a /Dest) y los
 *   elementos de estructura (/SE, por presencia y tipo /S) de cada ítem: un marcador nuevo con JavaScript o Launch es contenido activo. Los
 *   títulos, /Dest, colores y el orden no (lo que reescriben los editores al regenerar marcadores).
 * Sí cuentan como cambio de contenido: capas (/OCProperties), acciones (/OpenAction, /AA, /URI), /Names /JavaScript y
 * /EmbeddedFiles (los demás árboles de /Names, como /Dests, no), portafolio (/Collection), /PageMode, XFA,
 * NeedAppearances true y cualquier otra clave del catálogo que no esté en la lista de arriba.
 * Lo que agrega la plataforma (sello PAdES, sello de empresa, firma con certificado propio, DSS de B-LT y sello de
 * documento de B-LTA) solo toca /DSS y /AcroForm /Fields y /SigFlags (incremental.ts).
 *
 * Riesgo residual de las claves cosméticas ignoradas (no cambian lo que se dibuja en las páginas, pero sí cómo se
 * presenta el documento): /ViewerPreferences puede cambiar el título de la ventana (DisplayDocTitle), ocultar barras o
 * cambiar la dirección de lectura y las opciones de impresión; /StructTreeRoot cambia lo que leen los lectores de
 * pantalla y el texto alternativo (/Alt, /ActualText) de una exportación accesible; /PageLabels cambia los números de
 * página que muestra el lector (p. ej. que la página 3 se rotule "1"); los títulos de /Outlines pueden ser engañosos.
 * Ninguna altera el contenido firmado de las páginas; se aceptan porque los firmadores y editores legítimos las
 * reescriben a menudo y marcarlas daría falsos positivos.
 */
const CATALOG_IGNORED_KEYS = new Set([
  "Pages",
  "DSS",
  "Perms",
  "AcroForm",
  "Names",
  "Extensions",
  "Version",
  "Metadata",
  "Lang",
  "MarkInfo",
  "StructTreeRoot",
  "PageLabels",
  "ViewerPreferences",
  "Outlines",
  "Dests",
]);
const ACROFORM_IGNORED_KEYS = new Set(["Fields", "SigFlags", "NeedAppearances"]);
/** Del /AcroForm, ignoradas solo si todo widget que no es de firma tiene /AP /N (allWidgetsHaveAppearance). */
const ACROFORM_DEFAULTS_KEYS = new Set(["DR", "DA", "Q"]);
const MAX_OUTLINE_ITEMS = 100_000;
const NAMES_COMPARED_KEYS = ["JavaScript", "EmbeddedFiles"];

function documentFingerprint(doc: PDFDocument): string {
  const ctx = doc.context;
  const canon = new Canon(ctx);
  const cat = doc.catalog;
  const parts: string[] = [];
  for (const [k, v] of cat.entries()) {
    const key = k.decodeText();
    if (!CATALOG_IGNORED_KEYS.has(key)) parts.push(`${key}=${canon.of(v)}`);
  }
  const acro = lookupDict(ctx, cat.get(PDFName.of("AcroForm")));
  const defaultsUnused = acro ? allWidgetsHaveAppearance(doc) : true;
  for (const [k, v] of acro?.entries() ?? []) {
    const key = k.decodeText();
    if (ACROFORM_IGNORED_KEYS.has(key) || (defaultsUnused && ACROFORM_DEFAULTS_KEYS.has(key))) continue;
    parts.push(`AcroForm.${key}=${canon.of(v)}`);
  }
  parts.push(...outlineParts(ctx, canon, cat));
  const rawNeed = acro?.get(PDFName.of("NeedAppearances"));
  const need = rawNeed instanceof PDFRef ? ctx.lookup(rawNeed) : rawNeed;
  if (need instanceof PDFBool && need.asBoolean()) parts.push("AcroForm.NeedAppearances=true");
  const names = lookupDict(ctx, cat.get(PDFName.of("Names")));
  for (const key of NAMES_COMPARED_KEYS) {
    const v = names?.get(PDFName.of(key));
    if (v !== undefined) parts.push(`Names.${key}=${canon.of(v)}`);
  }
  return h(parts.sort().join("|"));
}

/**
 * true si todo widget que no es de un campo de firma tiene apariencia normal (/AP /N): el lector la dibuja y no usa los
 * valores por defecto del /AcroForm (/DA, /DR, /Q). Recorre los widgets de las páginas.
 */
function allWidgetsHaveAppearance(doc: PDFDocument): boolean {
  const ctx = doc.context;
  for (const p of doc.getPages()) {
    for (const a of lookupArray(ctx, p.node.get(PDFName.of("Annots"))) ?? []) {
      const d = lookupDict(ctx, a);
      const subtype = d?.get(PDFName.of("Subtype"));
      if (!d || !(subtype instanceof PDFName) || subtype.decodeText() !== "Widget") continue;
      if (fieldType(ctx, d) === "Sig") continue;
      if (lookupDict(ctx, d.get(PDFName.of("AP")))?.get(PDFName.of("N")) === undefined) return false;
    }
  }
  return true;
}

/** /FT del campo de un widget (heredado de /Parent). */
function fieldType(ctx: PDFContext, d: PDFDict): string | undefined {
  let cur: PDFDict | undefined = d;
  for (let i = 0; cur && i < 32; i++) {
    const ft = cur.get(PDFName.of("FT"));
    if (ft instanceof PDFName) return ft.decodeText();
    cur = lookupDict(ctx, cur.get(PDFName.of("Parent")));
  }
  return undefined;
}

/**
 * Acciones (/A) y elementos de estructura (/SE) de los marcadores, ordenados (el orden y los títulos no cuentan). Un GoTo
 * simple (sin /Next) no cuenta, igual que /Dest. Recorre /First y /Next con tope de ítems y detección de ciclos.
 */
function outlineParts(ctx: PDFContext, canon: Canon, cat: PDFDict): string[] {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const root = lookupDict(ctx, cat.get(PDFName.of("Outlines")));
  const stack: (PDFObject | undefined)[] = [root?.get(PDFName.of("First"))];
  while (stack.length) {
    const raw = stack.pop();
    const key = raw instanceof PDFRef ? raw.tag : raw;
    const item = lookupDict(ctx, raw);
    if (!item || seen.has(key) || seen.has(item)) continue;
    if (seen.size >= MAX_OUTLINE_ITEMS) {
      // Demasiados marcadores para recorrerlos: no se puede afirmar que no tengan acciones.
      parts.push("Outlines=too_many");
      break;
    }
    seen.add(key);
    seen.add(item);
    const a = item.get(PDFName.of("A"));
    const action = lookupDict(ctx, a);
    const s = action?.get(PDFName.of("S"));
    const plainGoTo = action && s instanceof PDFName && s.decodeText() === "GoTo" && action.get(PDFName.of("Next")) === undefined;
    if (a !== undefined && !plainGoTo) parts.push(`Outlines.A=${canon.of(a)}`);
    // /SE apunta a un elemento del árbol de estructura: su subárbol canónico arrastra /P, /K y todo /StructTreeRoot (que
    // los editores reescriben y se ignora), y daba falsos positivos. Cuenta la presencia y el tipo (/S) del elemento.
    const se = item.get(PDFName.of("SE"));
    if (se !== undefined) {
      const seType = lookupDict(ctx, se)?.get(PDFName.of("S"));
      const st = seType instanceof PDFRef ? ctx.lookup(seType) : seType;
      parts.push(`Outlines.SE=${st instanceof PDFName ? st.decodeText() : "-"}`);
    }
    stack.push(item.get(PDFName.of("Next")), item.get(PDFName.of("First")));
  }
  return parts;
}

function lookupDict(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof PDFRef ? ctx.lookup(o) : o;
  return v instanceof PDFDict ? v : undefined;
}

/**
 * Huella de cada página: diccionario (con atributos heredados), contenido, recursos y anotaciones. No cuentan los widgets
 * invisibles y sin acciones (ni propias ni de su cadena de campos) de campos de firma vacíos o de firmas posteriores que
 * verifican (`evidence`). Cada uno de estos últimos tiene que ser el único widget con ese ByteRange, para que no se
 * pueda colgar una apariencia falsa del valor de una firma real. Un campo de firma vacío que no se ve se omite en las
 * dos revisiones: si una revisión posterior lo firma (lo más común con varios firmantes) deja de estar vacío y pasa a
 * ser evidencia; si lo vuelve visible o le agrega una acción, cuenta en la revisión posterior y no en la firmada.
 */
function pageFingerprints(doc: PDFDocument, evidence: Set<string>): string[] {
  const ctx = doc.context;
  const canon = new Canon(ctx);
  const pages = doc.getPages().map((p) => {
    const annots = (lookupArray(ctx, p.node.get(PDFName.of("Annots"))) ?? []).map((a) => {
      const d = lookupDict(ctx, a);
      return { tag: a instanceof PDFRef ? a.tag : null, d, sig: d ? signatureField(ctx, d) : null };
    });
    return { node: p.node, annots: annots.filter((a): a is { tag: string | null; d: PDFDict; sig: SignatureField | null } => !!a.d) };
  });
  const widgets = new Map<string, Set<unknown>>();
  for (const p of pages) {
    for (const a of p.annots) {
      const key = a.sig?.key;
      if (key) widgets.set(key, (widgets.get(key) ?? new Set()).add(a.tag ?? a.d));
    }
  }
  return pages.map(({ node, annots }) => {
    const inherited = new Map(INHERITABLE.map((k) => [k, node.getInheritableAttribute(PDFName.of(k)) as PDFObject | undefined]));
    const visible: string[] = [];
    for (const { d, sig } of annots) {
      if (!sig) {
        visible.push(h(canon.dict(d)));
        continue;
      }
      const later = !!sig.key && evidence.has(sig.key) && widgets.get(sig.key)?.size === 1;
      if ((later || sig.empty) && !hasActiveKeys(sig.chain) && isInvisibleWidget(ctx, d)) continue;
      visible.push(h(canon.field(sig.chain, later ? LATER_SIGNATURE_OMIT : SIGNATURE_FIELD_OMIT)));
    }
    visible.sort();
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
    const loaded = current ?? (await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true }));
    const signedBytes = pdf.subarray(0, end);
    const signed = await PDFDocument.load(signedBytes, { updateMetadata: false, ignoreEncryption: true });
    const evidence = new Set([...laterSignatures].filter((k) => {
      const [, , c, d] = k.split(",").map(Number);
      return c + d > end;
    }));
    const a = pageFingerprints(signed, evidence);
    const docA = documentFingerprint(signed);
    // Cada lectura posible del documento completo tiene que mostrar lo firmado (más evidencia).
    for (const start of viewerStarts(pdf)) {
      const full = await asViewerSees(pdf, end, loaded, start);
      const b = pageFingerprints(full, evidence);
      const samePages = a.length === b.length && a.every((x, i) => x === b[i]);
      if (!samePages || docA !== documentFingerprint(full)) return "content";
    }
    // Lo firmado se compara en la vista de pdf-lib (la última definición de cada objeto). Si un lector, por el xref, ve
    // otra cosa en la revisión firmada (un objeto duplicado al final que el xref no lista), una revisión posterior podía
    // apuntar el xref a ese duplicado: pdf-lib veía lo mismo antes y después ("evidence_only") y el lector, que antes
    // mostraba el original, pasaba a mostrar el reemplazo. Una revisión firmada ambigua no permite afirmar nada.
    // Va al final (es lo más caro y solo cambia un "evidence_only") y se recuerda por revisión.
    if (await signedRevisionAmbiguous(pdf, end, signed)) return "content";
    return "evidence_only";
  } catch {
    // Si la revisión firmada no se puede leer, no se puede afirmar que lo que se muestra es lo firmado.
    return "content";
  }
}

/** Resultado del control de ambigüedad de cada revisión firmada (`end`) de un PDF: se calcula una vez por revisión. */
const ambiguityCache = new WeakMap<Uint8Array, Map<number, Promise<boolean>>>();

function signedRevisionAmbiguous(pdf: Uint8Array, end: number, signed: PDFDocument): Promise<boolean> {
  let byEnd = ambiguityCache.get(pdf);
  if (!byEnd) ambiguityCache.set(pdf, (byEnd = new Map()));
  let p = byEnd.get(end);
  if (!p) {
    byEnd.set(end, (p = viewerDiffersFromPdfLib(pdf.subarray(0, end), signed)));
    // Un error (p. ej. el tope de descompresión) no se recuerda: el próximo intento lo vuelve a calcular.
    p.catch(() => byEnd!.delete(end));
  }
  return p;
}

// ───────────────────── Lo que muestra un lector de PDF ─────────────────────
// pdf-lib ignora las tablas xref: lee los objetos en orden de archivo y se queda con la última definición de cada uno.
// Un lector de PDF usa el xref (desde el último startxref, siguiendo /Prev). Una revisión agregada después de la firma
// puede definir dos veces un objeto (el xref apunta a la versión alterada y una copia idéntica al original queda
// después), apuntar un objeto a una versión vieja dentro de lo firmado o marcarlo libre: pdf-lib vería lo firmado y el
// lector otra cosa. Por eso, en las revisiones posteriores a la firma, cada objeto se toma de donde lo toma el lector.

type XrefEntry =
  | { num: number; kind: "n"; offset: number }
  | { num: number; kind: "f" }
  | { num: number; kind: "c"; stream: number };

interface XrefSection {
  entries: XrefEntry[];
  root: PDFObject | undefined;
  prev: number | null;
  xrefStm: number | null;
}

function numberOf(o: PDFObject | undefined): number | null {
  return o instanceof PDFNumber ? o.asNumber() : null;
}

/** Objeto indirecto en `offset`: el encabezado tiene que ser "num gen obj" (con `expectNum`, ese número). */
function objectAt(pdf: Uint8Array, offset: number, ctx: PDFContext, expectNum?: number): { num: number; gen: number; obj: PDFObject } {
  const head = Buffer.from(pdf.subarray(offset, offset + 64)).toString("latin1");
  const m = /^\s*(\d+)\s+(\d+)\s+obj/.exec(head);
  if (!m || (expectNum !== undefined && Number(m[1]) !== expectNum)) throw new Error(`xref inconsistente en ${offset}`);
  const obj = PDFObjectParser.forBytes(pdf.subarray(offset + m[0].length), ctx).parseObject();
  return { num: Number(m[1]), gen: Number(m[2]), obj };
}

/**
 * Sección xref en `offset` (absoluto). Los offsets del archivo (entradas, /Prev, /XRefStm) se miden desde el encabezado
 * `%PDF-` (pdf.js hace `moveStart` ahí): se devuelven absolutos sumándoles `shift`.
 */
function readXrefSection(pdf: Uint8Array, offset: number, ctx: PDFContext, shift: number): XrefSection {
  const head = Buffer.from(pdf.subarray(offset, Math.min(pdf.length, offset + 16))).toString("latin1");
  if (/^\s*xref/.test(head)) return readXrefTable(pdf, offset, ctx, shift);
  const { obj } = objectAt(pdf, offset, ctx);
  if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Type")) !== PDFName.of("XRef")) throw new Error("startxref no apunta a un xref");
  return readXrefStream(obj, shift);
}

function readXrefTable(pdf: Uint8Array, offset: number, ctx: PDFContext, shift: number): XrefSection {
  // Texto de todo el buffer (compartido entre las revisiones, que son vistas del mismo archivo), acotado a `pdf`.
  const { text, base } = latin1(pdf);
  const limit = base + pdf.length;
  let pos = base + offset;
  const at = (src: string) => {
    const r = new RegExp(src, "y");
    r.lastIndex = pos;
    const m = r.exec(text);
    if (m) pos = r.lastIndex;
    return m;
  };
  at("\\s*");
  if (!at("xref")) throw new Error("xref esperado");
  const entries: XrefEntry[] = [];
  for (;;) {
    at("\\s*");
    if (text.startsWith("trailer", pos)) break;
    const sub = at("(\\d+)[ \\t]+(\\d+)");
    if (!sub) throw new Error("subsección xref inválida");
    const first = Number(sub[1]);
    const count = Number(sub[2]);
    for (let k = 0; k < count; k++) {
      at("\\s*");
      const e = at("(\\d{10}) (\\d{5}) ([nf])");
      if (!e || pos > limit) throw new Error("entrada xref inválida");
      const num = first + k;
      entries.push(e[3] === "n" ? { num, kind: "n", offset: Number(e[1]) + shift } : { num, kind: "f" });
    }
  }
  if (pos > limit) throw new Error("xref fuera de la revisión");
  const trailer = PDFObjectParser.forBytes(pdf.subarray(pos - base + "trailer".length), ctx).parseObject();
  if (!(trailer instanceof PDFDict)) throw new Error("trailer inválido");
  const plus = (n: number | null) => (n === null ? null : n + shift);
  return {
    entries,
    root: trailer.get(PDFName.of("Root")),
    prev: plus(numberOf(trailer.get(PDFName.of("Prev")))),
    xrefStm: plus(numberOf(trailer.get(PDFName.of("XRefStm")))),
  };
}

function readXrefStream(stream: PDFRawStream, shift: number): XrefSection {
  const d = stream.dict;
  const nums = (o: PDFObject | undefined) => (o instanceof PDFArray ? o.asArray().map((x) => numberOf(x) ?? 0) : null);
  const w = nums(d.get(PDFName.of("W")));
  if (!w || w.length !== 3) throw new Error("xref stream sin /W");
  const index = nums(d.get(PDFName.of("Index"))) ?? [0, numberOf(d.get(PDFName.of("Size"))) ?? 0];
  const data = decodePDFRawStream(stream).decode();
  const field = (pos: number, len: number, def: number) => {
    if (len === 0) return def;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + data[pos + i];
    return v;
  };
  const rowLen = w[0] + w[1] + w[2];
  const entries: XrefEntry[] = [];
  let pos = 0;
  for (let i = 0; i + 1 < index.length; i += 2) {
    for (let k = 0; k < index[i + 1]; k++, pos += rowLen) {
      if (pos + rowLen > data.length) throw new Error("xref stream corto");
      const type = field(pos, w[0], 1);
      const a = field(pos + w[0], w[1], 0);
      const num = index[i] + k;
      if (type === 0) entries.push({ num, kind: "f" });
      else if (type === 1) entries.push({ num, kind: "n", offset: a + shift });
      else if (type === 2) entries.push({ num, kind: "c", stream: a });
    }
  }
  const prev = numberOf(d.get(PDFName.of("Prev")));
  return { entries, root: d.get(PDFName.of("Root")), prev: prev === null ? null : prev + shift, xrefStm: null };
}

class RootChangedError extends Error {}

/**
 * El texto latin1 del PDF, una vez por archivo: antes se copiaba el archivo entero por cada sección de xref y miles de
 * secciones (/Prev) en un PDF de decenas de MB bloqueaban la API varios minutos.
 */
const latin1Cache = new WeakMap<ArrayBufferLike, string>();
function latin1(pdf: Uint8Array): { text: string; base: number } {
  let s = latin1Cache.get(pdf.buffer);
  if (s === undefined) latin1Cache.set(pdf.buffer, (s = Buffer.from(pdf.buffer as ArrayBuffer).toString("latin1")));
  return { text: s, base: pdf.byteOffset };
}

/** Tope de secciones de xref en la cadena de una revisión (un documento real tiene pocas). */
const MAX_XREF_SECTIONS = 2000;

// ───────────────────── Dónde empieza a leer el lector ─────────────────────
// pdf.js (el visor de la web) no lee el xref como pdf-lib ni como un parser estricto:
//  - mide todos los offsets desde el encabezado "%PDF-" (lo busca en el primer KB), no desde el byte 0;
//  - toma la ÚLTIMA aparición de "startxref" y el número que siga aunque esté pegado ("startxref123"); sin número usa 0
//    (y entonces reconstruye el índice);
//  - si el primer objeto es un diccionario de linealización con /L igual al largo del archivo, ignora el startxref y
//    empieza en el xref que sigue al primer "endobj".
// Con cualquiera de esas diferencias, un PDF podía mostrar en el visor una tabla distinta de la que se controlaba.
// Se controlan todas las lecturas posibles: alcanza con que una difiera de pdf-lib.

const isPdfjsSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;

interface ViewerStart {
  /** Offset absoluto del xref inicial. */
  at: number;
  /** Desde dónde se miden los offsets del archivo (posición del encabezado). */
  shift: number;
}

function headerOffset(buf: Buffer): number {
  const i = buf.subarray(0, 1024).indexOf("%PDF-");
  return i < 0 ? 0 : i;
}

/** El valor del último "startxref" como lo lee pdf.js (sin número: 0). */
function pdfjsStartXref(buf: Buffer): number {
  const at = buf.lastIndexOf("startxref");
  if (at < 0) return 0;
  let p = at + 9;
  const next = () => (p < buf.length ? buf[p++] : -1);
  let ch: number;
  do ch = next();
  while (isPdfjsSpace(ch));
  let str = "";
  while (ch >= 0x20 && ch <= 0x39) {
    str += String.fromCharCode(ch);
    ch = next();
  }
  const n = parseInt(str, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** Si pdf.js trataría el archivo como linealizado, el offset (relativo al encabezado) del xref que lee primero. */
function pdfjsLinearizedStart(buf: Buffer, base: number): number | null {
  const head = buf.subarray(base, base + 1024);
  const end = head.indexOf("endobj");
  if (end < 0) return null;
  const first = head.subarray(0, end).toString("latin1");
  const l = /\/L\s+\+?(\d+)(?![\d.])/.exec(first);
  if (!/\/Linearized\b/.test(first) || !l || Number(l[1]) !== buf.length - base) return null;
  let p = base + end + 6;
  while (p < buf.length && isPdfjsSpace(buf[p])) p++;
  return p - base;
}

/** Todos los puntos de arranque con los que un lector puede leer `pdf` (sin duplicados). */
function viewerStarts(pdf: Uint8Array): ViewerStart[] {
  const buf = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  const base = headerOffset(buf);
  const out: ViewerStart[] = [{ at: base + pdfjsStartXref(buf), shift: base }];
  const lin = pdfjsLinearizedStart(buf, base);
  if (lin !== null) out.push({ at: base + lin, shift: base });
  // Un lector estricto: el último startxref con número, offsets desde el byte 0.
  try {
    out.push({ at: findLastStartXref(pdf), shift: 0 });
  } catch {
    // sin startxref válido: ese lector reconstruye el índice
  }
  return out.filter((s, i) => out.findIndex((o) => o.at === s.at && o.shift === s.shift) === i);
}

/**
 * ¿Lo que muestra un lector (por el xref) difiere de lo que ve pdf-lib (la última definición de cada objeto en el
 * archivo)? pdf-lib es lo que arma el PDF final; el visor de la web (pdf.js) y los lectores usan el xref. Un PDF con
 * objetos duplicados mostraría una cosa al firmante y otra en el PDF firmado. Si el xref no se puede leer, los lectores
 * reconstruyen el índice recorriendo el archivo (como pdf-lib), así que eso no cuenta como diferencia.
 */
export async function viewerDiffersFromPdfLib(pdf: Uint8Array, loaded: PDFDocument): Promise<boolean> {
  for (const start of viewerStarts(pdf)) {
    let viewer: PDFDocument;
    try {
      viewer = await asViewerSees(pdf, 0, loaded, start);
    } catch (e) {
      if (e instanceof RootChangedError) return true;
      continue;
    }
    if (viewer === loaded) continue;
    try {
      const a = pageFingerprints(loaded, new Set());
      const b = pageFingerprints(viewer, new Set());
      if (!(a.length === b.length && a.every((x, i) => x === b[i])) || documentFingerprint(loaded) !== documentFingerprint(viewer)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * El documento completo tal como lo muestra un lector: la vista de pdf-lib (`loaded`) con los objetos que fijan los xref
 * de las revisiones posteriores a `end`. Si coincide con `loaded`, lo devuelve sin tocarlo (se reutiliza entre firmas).
 * Con `end` = 0, el documento entero (toda la cadena de xref).
 */
async function asViewerSees(pdf: Uint8Array, end: number, loaded: PDFDocument, start: ViewerStart): Promise<PDFDocument> {
  const ctx = loaded.context;
  const sections: XrefSection[] = [];
  const seen = new Set<number>();
  // Los objetos que las revisiones posteriores no listan, el lector los busca siguiendo /Prev. La cadena tiene que
  // seguir en el xref de la revisión firmada: con un /Prev a un xref más viejo (o sin /Prev) el lector resolvería esos
  // objetos con versiones anteriores a lo firmado (o no los encontraría), y pdf-lib seguiría viendo lo firmado.
  // La revisión firmada, leída con el mismo criterio que el documento completo.
  const signedStarts = end > 0 ? viewerStarts(pdf.subarray(0, end)).filter((s) => s.shift === start.shift).map((s) => s.at) : [];
  let off: number | null = start.at;
  while (off !== null && off >= end) {
    if (seen.has(off) || off >= pdf.length) throw new Error("cadena de xref inválida");
    seen.add(off);
    // Como un cambio de /Root: se trata como ambiguo (un error genérico se tomaría como "sin diferencias").
    if (seen.size > MAX_XREF_SECTIONS) throw new RootChangedError("demasiadas secciones de xref");
    const s = readXrefSection(pdf, off, ctx, start.shift);
    sections.push(s);
    // Archivo híbrido: las entradas del xref stream (/XRefStm) valen menos que las de la tabla.
    if (s.xrefStm !== null) {
      const { obj } = objectAt(pdf, s.xrefStm, ctx);
      if (!(obj instanceof PDFRawStream)) throw new Error("/XRefStm inválido");
      sections.push({ ...readXrefStream(obj, start.shift), root: undefined, prev: null });
    }
    off = s.prev;
  }
  if (!sections.length) throw new Error("revisión posterior sin xref");
  if (end > 0 && (off === null || !signedStarts.includes(off))) throw new Error("la revisión posterior no continúa el xref de la revisión firmada");
  // Un cambio de /Root reemplaza el documento entero: una revisión de evidencia no lo cambia.
  const root = sections[0].root;
  if (!(root instanceof PDFRef) || ctx.trailerInfo.Root?.toString() !== root.toString()) throw new RootChangedError("la revisión cambia /Root");

  // Entrada efectiva de cada objeto: gana la sección más nueva (sections[0]).
  const effective = new Map<number, XrefEntry>();
  for (const s of sections) for (const e of s.entries) if (!effective.has(e.num)) effective.set(e.num, e);

  const objStms = new Map<number, PDFContext>();
  const objStmContext = async (num: number): Promise<PDFContext> => {
    const cached = objStms.get(num);
    if (cached) return cached;
    const loc = effective.get(num);
    if (!loc || loc.kind !== "n") throw new Error(`ObjStm ${num} fuera de las revisiones posteriores`);
    const scratch = PDFContext.create();
    const { obj } = objectAt(pdf, loc.offset, scratch, num);
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Type")) !== PDFName.of("ObjStm")) throw new Error("ObjStm inválido");
    // El mismo stream (mismos bytes del mismo archivo) se descomprime una sola vez entre revisiones y lecturas.
    const decoded = decodedObjStms(pdf);
    const key = `${obj.contents.byteOffset}:${obj.contents.length}:${obj.dict.toString()}`;
    let parsed = decoded.get(key);
    if (!parsed) {
      await PDFObjectStreamParser.forStream(obj).parseIntoContext();
      decoded.set(key, (parsed = scratch));
    }
    objStms.set(num, parsed);
    return parsed;
  };

  // Lo que el lector ve de cada objeto de esas revisiones (null: objeto libre).
  const viewer: { ref: PDFRef; obj: PDFObject | null; entry: XrefEntry }[] = [];
  const refsByNum = new Map<number, PDFRef[]>();
  for (const [ref] of ctx.enumerateIndirectObjects()) refsByNum.set(ref.objectNumber, [...(refsByNum.get(ref.objectNumber) ?? []), ref]);
  // En el documento entero (end = 0), una entrada suelta que no se puede leer se saltea: un lector solo reconstruye el
  // índice (como pdf-lib) si llega a pedir ese objeto. Cortar todo el control ahí dejaba pasar un PDF con contenido
  // duplicado con solo romper la entrada de un objeto que nadie usa. Tras una firma (end > 0) sigue siendo estricto.
  const tolerant = end === 0;
  for (const e of effective.values()) {
    if (e.num === 0) continue;
    try {
      if (e.kind === "f") {
        for (const ref of refsByNum.get(e.num) ?? []) viewer.push({ ref, obj: null, entry: e });
      } else if (e.kind === "n") {
        const { gen, obj } = objectAt(pdf, e.offset, ctx, e.num);
        const type = obj instanceof PDFRawStream ? obj.dict.get(PDFName.of("Type")) : undefined;
        if (type === PDFName.of("ObjStm") || type === PDFName.of("XRef")) continue; // pdf-lib no los guarda como objetos
        viewer.push({ ref: PDFRef.of(e.num, gen), obj, entry: e });
      } else {
        const ref = PDFRef.of(e.num, 0);
        const obj = (await objStmContext(e.stream)).lookup(ref);
        if (!obj) throw new Error(`objeto ${e.num} ausente de su ObjStm`);
        viewer.push({ ref, obj, entry: e });
      }
    } catch (err) {
      if (!tolerant) throw err;
    }
  }

  const canon = new Canon(ctx);
  // Primero byte a byte (barato, sin seguir referencias: cada objeto referenciado se compara por su propia entrada) y,
  // solo si difiere, en forma canónica (orden de claves).
  const differs = viewer.filter(({ ref, obj }) => {
    const now = ctx.lookup(ref);
    if (obj === null) return now !== undefined;
    return now === undefined || (!sameBytes(obj, now) && canon.of(obj) !== canon.of(now));
  });
  if (!differs.length) return loaded;
  // Si ningún objeto que difiere se alcanza desde el catálogo (objetos liberados o huérfanos, que muchos editores dejan),
  // el lector arma el mismo documento que pdf-lib: no hace falta recargarlo.
  const reachable = reachableTags(loaded);
  if (differs.every(({ ref }) => !reachable.has(ref.tag))) return loaded;

  // Hay diferencias: documento nuevo con los objetos que ve el lector (los parseados arriba son del contexto de `loaded`).
  const doc = await PDFDocument.load(pdf, { updateMetadata: false, ignoreEncryption: true });
  // Objetos comprimidos: el ObjStm se parsea en el contexto nuevo (así resuelven sus referencias ahí) y se restauran los
  // objetos de ese stream cuya entrada efectiva está en otro lado.
  for (const stream of new Set(differs.flatMap(({ entry }) => (entry.kind === "c" ? [entry.stream] : [])))) {
    const loc = effective.get(stream) as Extract<XrefEntry, { kind: "n" }>;
    const refs = (await objStmContext(stream)).enumerateIndirectObjects().map(([ref]) => ref);
    const before = refs.map((ref) => doc.context.lookup(ref));
    const raw = objectAt(pdf, loc.offset, doc.context, stream).obj as PDFRawStream;
    await PDFObjectStreamParser.forStream(raw).parseIntoContext();
    refs.forEach((ref, i) => {
      const e = effective.get(ref.objectNumber);
      if (e?.kind === "c" && e.stream === stream) return;
      if (before[i] === undefined) doc.context.delete(ref);
      else doc.context.assign(ref, before[i]!);
    });
  }
  for (const { ref, obj, entry } of differs) {
    if (obj === null) doc.context.delete(ref);
    else if (entry.kind === "n") doc.context.assign(ref, objectAt(pdf, entry.offset, doc.context, entry.num).obj);
  }
  // El catálogo y el árbol de páginas se toman de nuevo del contexto corregido.
  const Doc = PDFDocument as unknown as new (ctx: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument;
  return new Doc(doc.context, true, false);
}

/** Serialización de pdf-lib de un objeto (las referencias quedan como "n g R"). */
function bytesOf(o: PDFObject): Uint8Array {
  const b = new Uint8Array(o.sizeInBytes());
  o.copyBytesInto(b, 0);
  return b;
}

function sameBytes(a: PDFObject, b: PDFObject): boolean {
  if (a === b) return true;
  if (a.constructor !== b.constructor) return false;
  try {
    return Buffer.from(bytesOf(a)).equals(bytesOf(b));
  } catch {
    return false;
  }
}

/** ObjStm ya descomprimidos de cada archivo (por posición de sus bytes en el buffer), compartidos entre revisiones. */
const objStmCache = new WeakMap<ArrayBufferLike, Map<string, PDFContext>>();
function decodedObjStms(pdf: Uint8Array): Map<string, PDFContext> {
  let m = objStmCache.get(pdf.buffer);
  if (!m) objStmCache.set(pdf.buffer, (m = new Map()));
  return m;
}

/** Objetos indirectos alcanzables desde el catálogo (/Root) en la vista de pdf-lib. */
const reachableCache = new WeakMap<PDFDocument, Set<string>>();
function reachableTags(doc: PDFDocument): Set<string> {
  const cached = reachableCache.get(doc);
  if (cached) return cached;
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const root = ctx.trailerInfo.Root;
  if (root) stack.push(root);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const x of o.asArray()) stack.push(x);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  reachableCache.set(doc, seen);
  return seen;
}
