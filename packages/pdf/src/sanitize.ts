// Saneamiento de los PDFs de afuera. Principio: lo que se guarda como original (preparePdfUpload) es exactamente lo que
// el visor muestra al firmante y lo que termina sellado (buildEnvelopeDocument copia las páginas con pdf-lib). Todo lo
// que un lector muestra distinto de esa copia —capas opcionales, campos de formulario, contenido activo— se resuelve
// acá: al subir (sobre el archivo que se guarda) y otra vez al sellar (defensa para originales guardados antes).
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFOptionList,
  PDFPage,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFTextField,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { formUnsupportedError, hiddenLayersError } from "./errors";

const N = (s: string) => PDFName.of(s);

function resolve(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}
function dictOf(ctx: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFDict ? v : undefined;
}
function arrayOf(ctx: PDFContext, o: PDFObject | undefined): PDFObject[] {
  const v = resolve(ctx, o);
  return v instanceof PDFArray ? v.asArray() : [];
}
function nameOf(ctx: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFName ? v.decodeText() : undefined;
}
function numOf(ctx: PDFContext, o: PDFObject | undefined): number | undefined {
  const v = resolve(ctx, o);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}
/** Identidad de un objeto: la referencia si es indirecto (lo normal para OCGs), el objeto mismo si es directo. */
const keyOf = (o: PDFObject) => (o instanceof PDFRef ? o.tag : o);

/** Todos los diccionarios del documento (indirectos y anidados directos), con tope de profundidad. */
function* allDicts(ctx: PDFContext): Generator<PDFDict> {
  const walk = function* (o: PDFObject, depth: number): Generator<PDFDict> {
    if (depth > 24) return;
    if (o instanceof PDFDict) {
      yield o;
      for (const [, v] of o.entries()) if (v instanceof PDFDict || v instanceof PDFArray) yield* walk(v, depth + 1);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) if (v instanceof PDFDict || v instanceof PDFArray) yield* walk(v, depth + 1);
    } else if (o instanceof PDFStream) {
      yield* walk(o.dict, depth + 1);
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) yield* walk(obj, 0);
}

// ───────────────────── Contenido opcional (capas, OCG) ─────────────────────

/** Configuración de capas de un documento, tal como la aplica un lector al abrirlo. */
export interface OptionalContentState {
  /** Capas listadas en /OCProperties /OCGs, con su estado al abrir. */
  groups: { ref: PDFObject; on: boolean }[];
  /** /D /Order (orden del panel de capas) y /D /RBGroups, para copiarlos al PDF final. */
  order: PDFObject | undefined;
  rbGroups: PDFObject | undefined;
  /** Por qué hay contenido oculto al abrir, o null si todo se ve. */
  hidden: string | null;
}

/**
 * Las capas del documento y si algo queda oculto al abrirlo, o null sin /OCProperties (sin él los lectores ignoran el
 * marcado /OC y muestran todo). Sigue a pdf.js (el visor de la web): estado inicial por /D (BaseState, ON, OFF) y uso de
 * vista (/Usage /View /ViewState OFF oculta aunque no haya /AS). /Print no cuenta (el visor muestra la capa en
 * pantalla) y /RBGroups tampoco (un lector no lo aplica al abrir). Una capa que no está en /OCGs se ve, igual que un
 * OCMD con /VE inválido (menos de 2 elementos u operador desconocido). Los diccionarios de pertenencia (OCMD) pueden
 * ocultar contenido aun con todas las capas encendidas (/P AnyOff o AllOff, /VE con /Not).
 */
export function readOptionalContent(doc: PDFDocument): OptionalContentState | null {
  const ctx = doc.context;
  const ocp = dictOf(ctx, doc.catalog.get(N("OCProperties")));
  if (!ocp) return null;
  const d = dictOf(ctx, ocp.get(N("D")));
  const base = nameOf(ctx, d?.get(N("BaseState"))) ?? "ON";
  const on = new Set(arrayOf(ctx, d?.get(N("ON"))).map(keyOf));
  const off = new Set(arrayOf(ctx, d?.get(N("OFF"))).map(keyOf));
  const listed = new Map<unknown, boolean>();
  const groups: OptionalContentState["groups"] = [];
  let hidden: string | null = null;
  for (const g of arrayOf(ctx, ocp.get(N("OCGs")))) {
    if (listed.has(keyOf(g))) continue;
    let visible = off.has(keyOf(g)) ? false : on.has(keyOf(g)) ? true : base !== "OFF";
    if (!visible) hidden ??= "capa apagada";
    const usage = dictOf(ctx, dictOf(ctx, g)?.get(N("Usage")));
    if (visible && nameOf(ctx, dictOf(ctx, usage?.get(N("View")))?.get(N("ViewState"))) === "OFF") {
      visible = false;
      hidden ??= "capa con vista apagada";
    }
    listed.set(keyOf(g), visible);
    groups.push({ ref: g, on: visible });
  }
  const state = (o: PDFObject) => listed.get(keyOf(o));
  if (!hidden && listed.size) {
    for (const dict of allDicts(ctx)) {
      if (nameOf(ctx, dict.get(N("Type"))) !== "OCMD") continue;
      if (!ocmdVisible(ctx, dict, state)) {
        hidden = "contenido oculto por una condición de capas";
        break;
      }
    }
  }
  return { groups, order: d?.get(N("Order")), rbGroups: d?.get(N("RBGroups")), hidden };
}

/** Por qué el documento tiene contenido opcional oculto al abrirlo, o null si todo se ve (readOptionalContent). */
export function hiddenOptionalContent(doc: PDFDocument): string | null {
  return readOptionalContent(doc)?.hidden ?? null;
}

type GroupState = (o: PDFObject) => boolean | undefined;

/** Visibilidad de un OCMD como pdf.js: una capa que no está en /OCGs hace visible el contenido. */
function ocmdVisible(ctx: PDFContext, d: PDFDict, state: GroupState): boolean {
  const ve = resolve(ctx, d.get(N("VE")));
  if (ve instanceof PDFArray) {
    const expr = parseVisibility(ctx, ve, 0);
    if (expr) return evalVisibility(expr, state);
  }
  const raw = d.get(N("OCGs"));
  const list = resolve(ctx, raw) instanceof PDFArray ? arrayOf(ctx, raw) : raw ? [raw] : [];
  if (!list.length) return true;
  const policy = nameOf(ctx, d.get(N("P"))) ?? "AnyOn";
  for (const g of list) {
    const s = state(g);
    if (s === undefined) return true;
    if (policy === "AnyOn" && s) return true;
    if (policy === "AllOn" && !s) return false;
    if (policy === "AnyOff" && !s) return true;
    if (policy === "AllOff" && s) return false;
  }
  return policy === "AllOn" || policy === "AllOff" || !["AnyOn", "AnyOff"].includes(policy);
}

type Visibility = { op: string; args: (Visibility | PDFRef | null)[] };

/** Expresión /VE como la lee pdf.js: null si es inválida (menos de 2 elementos, operador desconocido, más de 10 niveles). */
function parseVisibility(ctx: PDFContext, arr: PDFArray, depth: number): Visibility | null {
  if (depth >= 10) return null;
  const items = arr.asArray();
  const op = nameOf(ctx, items[0]);
  if (items.length < 2 || !op || !["And", "Or", "Not"].includes(op)) return null;
  const args: Visibility["args"] = [];
  for (const raw of items.slice(1)) {
    const v = resolve(ctx, raw);
    if (v instanceof PDFArray) args.push(parseVisibility(ctx, v, depth + 1));
    else if (raw instanceof PDFRef) args.push(raw);
  }
  return { op, args };
}

function evalVisibility(e: Visibility | null, state: GroupState): boolean {
  if (!e || !e.args.length) return true;
  for (const a of e.args) {
    const s = a instanceof PDFRef ? state(a) : evalVisibility(a, state);
    if (s === undefined) return true;
    if (e.op === "And" && !s) return false;
    if (e.op === "Or" && s) return true;
    if (e.op === "Not") return !s;
  }
  return e.op === "And";
}

/**
 * Lanza `pdf_hidden_layers` si hay contenido opcional apagado. Si todo está encendido quita /OCProperties: sin él, los
 * lectores muestran todo (el marcado /OC del contenido y de las anotaciones deja de tener efecto, y no hace falta
 * reescribir los content streams), que es lo mismo que muestra la copia de páginas del sellado (no copia el catálogo).
 */
export function resolveOptionalContent(doc: PDFDocument): void {
  if (hiddenOptionalContent(doc)) throw hiddenLayersError("upload");
  doc.catalog.delete(N("OCProperties"));
}

// ───────────────────── Formularios ─────────────────────

/** ¿El PDF trae campos de firma ya firmados (/FT /Sig con /V)? Se pierden al reescribirlo. */
export function hasSignedSignatureFields(doc: PDFDocument): boolean {
  const ctx = doc.context;
  const isSigned = (d: PDFDict) => {
    let ft: string | undefined;
    let v: PDFObject | undefined;
    let cur: PDFDict | undefined = d;
    for (let i = 0; cur && i < 32; i++) {
      ft ??= nameOf(ctx, cur.get(N("FT")));
      v ??= cur.get(N("V"));
      cur = dictOf(ctx, cur.get(N("Parent")));
    }
    return ft === "Sig" && dictOf(ctx, v) !== undefined;
  };
  const seen = new Set<PDFDict>();
  const stack = [...arrayOf(ctx, dictOf(ctx, doc.catalog.get(N("AcroForm")))?.get(N("Fields")))];
  for (const p of doc.getPages()) stack.push(...arrayOf(ctx, p.node.get(N("Annots"))));
  while (stack.length && seen.size < 100_000) {
    const d = dictOf(ctx, stack.pop());
    if (!d || seen.has(d)) continue;
    seen.add(d);
    if (isSigned(d)) return true;
    stack.push(...arrayOf(ctx, d.get(N("Kids"))));
  }
  return false;
}

/**
 * Fija los campos de formulario en el contenido de la página tal como los muestra un lector, y elimina el formulario.
 * El `flatten` de pdf-lib no sirve: dibuja widgets ocultos (/F Hidden o NoView), elige la apariencia de casillas y
 * radios por /V en vez de /AS, no escala la apariencia a /Rect (BBox y Matrix) e ignora NeedAppearances.
 *
 * - Widgets con /F Hidden (2) o NoView (32): no se dibujan.
 * - Apariencia: /AP /N; si es un diccionario de estados, el de /AS (sin /AS o sin ese estado, nada, como un lector).
 * - Con /NeedAppearances el lector regenera la apariencia de texto y listas a partir del valor: se regenera igual (pdf-lib,
 *   Helvetica). También si un campo con valor no tiene apariencia. Si no se puede (texto fuera de WinAnsi, /RV), se
 *   conserva la apariencia guardada; si el campo no tiene ninguna, al subir se rechaza (`pdf_form_unsupported`) y al
 *   sellar (`strict` false) se sigue sin ella.
 * - Ubicación según ISO 32000-1 §12.5.5: la BBox transformada por /Matrix se lleva a /Rect.
 */
export async function flattenForm(doc: PDFDocument, strict: boolean): Promise<void> {
  const ctx = doc.context;
  const acro = dictOf(ctx, doc.catalog.get(N("AcroForm")));
  if (acro) await regenerateAppearances(doc, acro, strict);
  for (const page of doc.getPages()) {
    const raw = page.node.get(N("Annots"));
    const annots = resolve(ctx, raw);
    if (!(annots instanceof PDFArray)) continue;
    const keep: PDFObject[] = [];
    for (const a of annots.asArray()) {
      const d = dictOf(ctx, a);
      if (!d) continue;
      if (nameOf(ctx, d.get(N("Subtype"))) !== "Widget") {
        keep.push(a);
        continue;
      }
      const flags = numOf(ctx, d.get(N("F"))) ?? 0;
      if (flags & 2 || flags & 32) continue;
      try {
        drawWidget(page, d);
      } catch {
        // Apariencia ilegible: un lector tampoco la dibuja.
      }
    }
    if (keep.length) {
      if (raw instanceof PDFRef) ctx.assign(raw, ctx.obj(keep));
      else page.node.set(N("Annots"), ctx.obj(keep));
    } else {
      page.node.delete(N("Annots"));
    }
  }
  doc.catalog.delete(N("AcroForm"));
}

async function regenerateAppearances(doc: PDFDocument, acro: PDFDict, strict: boolean) {
  const ctx = doc.context;
  const needAppearances = resolve(ctx, acro.get(N("NeedAppearances")));
  const need = needAppearances instanceof PDFBool && needAppearances.asBoolean();
  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch {
    if (strict && need) throw formUnsupportedError();
    return;
  }
  let font: Awaited<ReturnType<PDFDocument["embedFont"]>> | undefined;
  for (const field of fields) {
    if (!(field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList)) continue;
    try {
      const value = field instanceof PDFTextField ? field.getText() ?? "" : field.getSelected().join("");
      const missing = field.acroField.getWidgets().some((w) => !(w.getAppearances()?.normal instanceof PDFStream));
      if (!need && !(missing && value)) continue;
      font ??= await doc.embedFont(StandardFonts.Helvetica);
      field.defaultUpdateAppearances(font);
    } catch {
      // Texto fuera de WinAnsi, texto enriquecido (/RV)…: se conserva la apariencia guardada si todos los widgets la
      // tienen; sin ninguna, al subir se rechaza.
      if (!strict) continue;
      let hasAppearance = false;
      try {
        hasAppearance = field.acroField.getWidgets().every((w) => w.getAppearances()?.normal !== undefined);
      } catch {
        // sin widgets legibles
      }
      if (!hasAppearance) throw formUnsupportedError();
    }
  }
}

function drawWidget(page: PDFPage, widget: PDFDict) {
  const ctx = page.doc.context;
  const ap = dictOf(ctx, widget.get(N("AP")));
  let n: PDFObject | undefined = ap?.get(N("N"));
  const states = dictOf(ctx, n);
  if (states) {
    const as = widget.get(N("AS"));
    n = as instanceof PDFName ? states.get(as) : undefined;
  }
  if (!n) return;
  const stream = resolve(ctx, n);
  if (!(stream instanceof PDFStream)) return;
  const bbox = arrayOf(ctx, stream.dict.get(N("BBox"))).map((x) => numOf(ctx, x));
  const rect = arrayOf(ctx, widget.get(N("Rect"))).map((x) => numOf(ctx, x));
  if (bbox.length !== 4 || rect.length !== 4 || [...bbox, ...rect].some((x) => x === undefined || !Number.isFinite(x))) return;
  const mRaw = arrayOf(ctx, stream.dict.get(N("Matrix"))).map((x) => numOf(ctx, x));
  const m = mRaw.length === 6 && mRaw.every((x) => x !== undefined && Number.isFinite(x)) ? (mRaw as number[]) : [1, 0, 0, 1, 0, 0];
  const [bx1, by1, bx2, by2] = bbox as number[];
  const corners = [
    [bx1, by1],
    [bx1, by2],
    [bx2, by1],
    [bx2, by2],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const tx1 = Math.min(...corners.map((c) => c[0]));
  const tx2 = Math.max(...corners.map((c) => c[0]));
  const ty1 = Math.min(...corners.map((c) => c[1]));
  const ty2 = Math.max(...corners.map((c) => c[1]));
  const [r1, r2, r3, r4] = rect as number[];
  const rx1 = Math.min(r1, r3);
  const rx2 = Math.max(r1, r3);
  const ry1 = Math.min(r2, r4);
  const ry2 = Math.max(r2, r4);
  if (tx2 - tx1 <= 0 || ty2 - ty1 <= 0 || rx2 - rx1 <= 0 || ry2 - ry1 <= 0) return;
  const sx = (rx2 - rx1) / (tx2 - tx1);
  const sy = (ry2 - ry1) / (ty2 - ty1);
  if (!(stream.dict.get(N("Subtype")) instanceof PDFName)) stream.dict.set(N("Subtype"), N("Form"));
  const ref = n instanceof PDFRef ? n : ctx.register(stream);
  const key = page.node.newXObject("FlatWidget", ref);
  // Un widget en una capa (/OC) sigue en esa capa: si está apagada (original viejo sellado con sus capas), no se ve.
  const oc = widget.get(N("OC"));
  const ocKey = oc ? optionalContentKey(page, oc) : undefined;
  page.pushOperators(
    ...(ocKey ? [PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [N("OC"), ocKey])] : []),
    pushGraphicsState(),
    concatTransformationMatrix(sx, 0, 0, sy, rx1 - tx1 * sx, ry1 - ty1 * sy),
    drawObject(key),
    popGraphicsState(),
    ...(ocKey ? [PDFOperator.of(PDFOperatorNames.EndMarkedContent)] : []),
  );
}

/** Nombre de /Properties de la página que apunta a `oc` (lo agrega si hace falta). */
function optionalContentKey(page: PDFPage, oc: PDFObject): PDFName {
  const ctx = page.doc.context;
  page.node.normalize();
  const res = page.node.Resources()!;
  let props = dictOf(ctx, res.get(N("Properties")));
  if (!props) res.set(N("Properties"), (props = ctx.obj({})));
  for (let i = 0; ; i++) {
    const name = N(`FlatOC${i}`);
    const cur = props.get(name);
    if (cur === undefined) {
      props.set(name, oc);
      return name;
    }
    if (cur === oc) return name;
  }
}

// ───────────────────── Contenido activo ─────────────────────

const SAFE_ACTIONS = new Set(["URI", "GoTo", "Named"]);
const SAFE_NAMED = new Set(["NextPage", "PrevPage", "FirstPage", "LastPage"]);
const DROPPED_ANNOTS = new Set(["FileAttachment", "Sound", "Movie", "RichMedia", "Screen", "3D"]);

/** Acción que se conserva: URI, GoTo o Named estándar, sin acciones encadenadas (/Next). */
function keepAction(ctx: PDFContext, a: PDFObject | undefined): boolean {
  const d = dictOf(ctx, a);
  const s = d && nameOf(ctx, d.get(N("S")));
  if (!d || !s || !SAFE_ACTIONS.has(s)) return false;
  if (s === "Named" && !SAFE_NAMED.has(nameOf(ctx, d.get(N("N"))) ?? "")) return false;
  d.delete(N("Next"));
  return true;
}

/**
 * Quita el contenido activo: /AA y /AF (archivos asociados) de páginas, /AA de anotaciones; en /A solo quedan URI, GoTo
 * y Named estándar; se eliminan las anotaciones FileAttachment, Sound, Movie, RichMedia, Screen y 3D. Con `catalog`,
 * también /AA, /AF, /OpenAction que no sea un destino o un GoTo, /Names /JavaScript y /EmbeddedFiles, /Collection
 * (portafolio) y las acciones de los marcadores.
 * (XFA va con el /AcroForm, que flattenForm elimina.)
 */
export function stripActiveContent(doc: PDFDocument, catalog: boolean): void {
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    page.node.delete(N("AA"));
    page.node.delete(N("AF"));
    const raw = page.node.get(N("Annots"));
    const annots = resolve(ctx, raw);
    if (!(annots instanceof PDFArray)) continue;
    const keep: PDFObject[] = [];
    for (const a of annots.asArray()) {
      const d = dictOf(ctx, a);
      if (!d || DROPPED_ANNOTS.has(nameOf(ctx, d.get(N("Subtype"))) ?? "")) continue;
      d.delete(N("AA"));
      if (d.has(N("A")) && !keepAction(ctx, d.get(N("A")))) d.delete(N("A"));
      keep.push(a);
    }
    if (keep.length) {
      if (raw instanceof PDFRef) ctx.assign(raw, ctx.obj(keep));
      else page.node.set(N("Annots"), ctx.obj(keep));
    } else {
      page.node.delete(N("Annots"));
    }
  }
  if (!catalog) return;
  const cat = doc.catalog;
  cat.delete(N("AA"));
  cat.delete(N("Collection"));
  // Archivos asociados (PDF/A-3, Factur-X): sus /EF quedarían alcanzables y se guardarían.
  cat.delete(N("AF"));
  const open = cat.get(N("OpenAction"));
  if (open !== undefined && !(resolve(ctx, open) instanceof PDFArray)) {
    const d = dictOf(ctx, open);
    const s = d && nameOf(ctx, d.get(N("S")));
    if (!(s === "GoTo" && keepAction(ctx, d))) cat.delete(N("OpenAction"));
  }
  const names = dictOf(ctx, cat.get(N("Names")));
  if (names) {
    names.delete(N("JavaScript"));
    names.delete(N("EmbeddedFiles"));
  }
  // Marcadores: /A con JavaScript, Launch, etc.
  const seen = new Set<PDFDict>();
  const stack = [dictOf(ctx, dictOf(ctx, cat.get(N("Outlines")))?.get(N("First")))];
  while (stack.length && seen.size < 100_000) {
    const item = stack.pop();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    if (item.has(N("A")) && !keepAction(ctx, item.get(N("A")))) item.delete(N("A"));
    stack.push(dictOf(ctx, item.get(N("Next"))), dictOf(ctx, item.get(N("First"))));
  }
}

// ───────────────────── Streams y objetos huérfanos ─────────────────────

/** Streams más grandes que esto no se comprimen al subir (deflate de decenas de MB bloquea el worker). */
const MAX_COMPRESSED_STREAM = 2 * 1024 * 1024;

/**
 * Comprime con Flate los streams sin filtro, para achicar el archivo y que el texto de un documento subido no quede
 * literal. Se dejan como están los metadatos XMP (legibles), las imágenes (deflate de píxeles sin filtro es lento y
 * rinde poco) y los streams de más de 2 MB. Un `/ByteRange [0 /********** ...]` literal ya no confunde al sellado: el
 * placeholder del ByteRange lleva un nombre aleatorio (newByteRangePlaceholder).
 */
export function compressPlainStreams(doc: PDFDocument): void {
  const ctx = doc.context;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.has(N("Filter"))) continue;
    if (nameOf(ctx, obj.dict.get(N("Type"))) === "Metadata") continue;
    if (nameOf(ctx, obj.dict.get(N("Subtype"))) === "Image" || obj.contents.length > MAX_COMPRESSED_STREAM) continue;
    const s = ctx.flateStream(obj.contents);
    for (const [k, v] of obj.dict.entries()) {
      const key = k.decodeText();
      if (key !== "Length" && key !== "Filter" && key !== "DecodeParms") s.dict.set(k, v);
    }
    ctx.assign(ref, s);
  }
}

/** Borra los objetos que ya no se alcanzan desde el trailer (campos aplanados, adjuntos y JavaScript quitados). */
export function dropUnreachable(doc: PDFDocument): void {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter((o): o is PDFObject => !!o);
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
      stack.push(...o.asArray());
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

/**
 * Lo que se hace al sellar con cada documento (y adjunto PDF) antes de copiar sus páginas: defensa para originales
 * guardados antes del saneamiento en la subida. Devuelve sus capas (readOptionalContent): la copia de páginas no lleva el
 * catálogo, así que si alguna está apagada el PDF final tiene que llevar /OCProperties con el mismo estado
 * (finalize.ts), para mostrar lo mismo que vio el firmante.
 */
export async function sanitizeForSealing(doc: PDFDocument): Promise<OptionalContentState | null> {
  const layers = readOptionalContent(doc);
  await flattenForm(doc, false);
  stripActiveContent(doc, false);
  return layers;
}
