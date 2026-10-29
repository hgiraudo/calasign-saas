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
  decodePDFRawStream,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { constants, inflateRawSync, inflateSync } from "node:zlib";
import { formUnsupportedError, hiddenLayersError } from "./errors";
import { decodeFilterCapped, type CappedFilter } from "./stream-budget";

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
  /** /D /Order (orden del panel de capas) y /D /RBGroups (ya resueltos si eran referencias), para el PDF final. */
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
  // Resueltos acá: el PDF final concatena sus elementos (LayerMerger), y una referencia al array no se podía concatenar.
  return { groups, order: resolve(ctx, d?.get(N("Order"))), rbGroups: resolve(ctx, d?.get(N("RBGroups"))), hidden };
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
  if (hiddenOptionalContent(doc)) throw hiddenLayersError();
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
 *   conserva la apariencia guardada y, con NeedAppearances, se devuelve `appearanceMismatch` (un lector podría mostrar
 *   otra cosa: aviso no bloqueante al subir); si el campo no tiene ninguna, al subir se rechaza (`pdf_form_unsupported`)
 *   y al sellar (`strict` false) se sigue sin ella.
 * - Ubicación según ISO 32000-1 §12.5.5: la BBox transformada por /Matrix se lleva a /Rect.
 */
export async function flattenForm(doc: PDFDocument, strict: boolean): Promise<{ appearanceMismatch: boolean }> {
  const ctx = doc.context;
  const acro = dictOf(ctx, doc.catalog.get(N("AcroForm")));
  const appearanceMismatch = acro ? await regenerateAppearances(doc, acro, strict) : false;
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
  return { appearanceMismatch };
}

/** Regenera las apariencias; true si con NeedAppearances alguna no se pudo regenerar y quedó la guardada. */
async function regenerateAppearances(doc: PDFDocument, acro: PDFDict, strict: boolean): Promise<boolean> {
  const ctx = doc.context;
  const needAppearances = resolve(ctx, acro.get(N("NeedAppearances")));
  const need = needAppearances instanceof PDFBool && needAppearances.asBoolean();
  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch {
    if (strict && need) throw formUnsupportedError();
    return false;
  }
  let mismatch = false;
  let font: Awaited<ReturnType<PDFDocument["embedFont"]>> | undefined;
  for (const field of fields) {
    if (!(field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList)) continue;
    try {
      const value = field instanceof PDFTextField ? (field.getText() ?? "") : field.getSelected().join("");
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
      // Con NeedAppearances un lector regeneraría la apariencia a partir del valor (quizás distinta de la guardada, que
      // es la que se fija): se acepta con un aviso no bloqueante (PdfInfo.formAppearanceMismatch).
      if (need) mismatch = true;
    }
  }
  return mismatch;
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
 * Quita el contenido activo: /AF (archivos asociados) de cualquier diccionario y /EF (archivos embebidos) de toda
 * especificación de archivo; /AA de páginas y anotaciones; en /A solo quedan URI, GoTo
 * y Named estándar; se eliminan las anotaciones FileAttachment, Sound, Movie, RichMedia, Screen y 3D. Con `catalog`,
 * también /AA, /OpenAction que no sea un destino o un GoTo, /Names /JavaScript y /EmbeddedFiles, /Collection
 * (portafolio) y las acciones de los marcadores.
 * (XFA va con el /AcroForm, que flattenForm elimina.)
 */
export function stripActiveContent(doc: PDFDocument, catalog: boolean): void {
  const ctx = doc.context;
  // Archivos asociados (/AF, PDF 2.0 y PDF/A-3) en cualquier diccionario (XObjects, elementos de estructura, anotaciones…)
  // y los archivos embebidos (/EF) de toda especificación de archivo: sin esto quedaban alcanzables y se guardaban (al
  // subir) o se copiaban con las páginas (al sellar).
  for (const d of allDicts(ctx)) {
    d.delete(N("AF"));
    d.delete(N("EF"));
  }
  for (const page of doc.getPages()) {
    page.node.delete(N("AA"));
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

// ───────────────────── Contenido marcado sin cerrar ─────────────────────

/** Diccionario de una imagen en línea cuyo (primer) filtro es ASCII85: `/F /A85`, `/Filter [/ASCII85Decode …]`. */
const A85_INLINE = /\/(?:F|Filter)\s*(?:\[\s*)?\/(?:A85|ASCII85Decode)(?![^\s\/\[\]<>()%{}])/;

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

/**
 * Secuencias de contenido marcado (BDC/BMC) que un content stream abre y no cierra con EMC. Tokeniza lo justo: saltea
 * strings literales (con paréntesis anidados y escapes) y hexadecimales, comentarios, nombres, arrays y diccionarios
 * (un operador ahí adentro no es un operador) y los datos de las imágenes en línea (BI … ID <datos> EI). Un EMC de más
 * no cuenta (no se toca: un lector lo ignora).
 */
export function unclosedMarkedContent(data: Uint8Array): number {
  let open = 0;
  let nest = 0; // [ ] y << >>
  const n = data.length;
  let i = 0;
  let inlineStart = -1; // posición del último BI (diccionario de la imagen en línea)
  while (i < n) {
    const c = data[i];
    if (isWhite(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
    } else if (c === 0x28) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (data[i] === 0x5c) i += 2;
        else {
          if (data[i] === 0x28) depth++;
          else if (data[i] === 0x29) depth--;
          i++;
        }
      }
    } else if (c === 0x3c && data[i + 1] === 0x3c) {
      nest++;
      i += 2;
    } else if (c === 0x3e && data[i + 1] === 0x3e) {
      if (nest > 0) nest--;
      i += 2;
    } else if (c === 0x3c) {
      while (i < n && data[i] !== 0x3e) i++;
      i++;
    } else if (c === 0x5b) {
      nest++;
      i++;
    } else if (c === 0x5d) {
      if (nest > 0) nest--;
      i++;
    } else if (c === 0x2f) {
      i++;
      while (i < n && !isWhite(data[i]) && !isDelim(data[i])) i++;
    } else if (isDelim(c)) {
      i++;
    } else {
      const start = i;
      while (i < n && !isWhite(data[i]) && !isDelim(data[i])) i++;
      const len = i - start;
      if (nest > 0 || len < 2 || len > 3) continue;
      const w = String.fromCharCode(...data.subarray(start, i));
      if (w === "BDC" || w === "BMC") open++;
      else if (w === "EMC") open = Math.max(0, open - 1);
      else if (w === "BI") inlineStart = i;
      else if (w === "ID") {
        // Datos binarios de la imagen hasta un EI entre blancos (como pdf.js y poppler).
        i++;
        // Con ASCII85 como (primer) filtro los datos terminan en "~>": un " EI " dentro del texto codificado (es
        // posible: E e I son dígitos de ASCII85) no cierra la imagen. Se busca el EI después del fin de los datos.
        // Justo después del "~>" el EI puede ir pegado (el ">" ya delimita): "~>EI" cierra la imagen.
        let a85End = -1;
        if (inlineStart >= 0 && A85_INLINE.test(Buffer.from(data.buffer, data.byteOffset + inlineStart, start - inlineStart).toString("latin1"))) {
          while (i < n && !(data[i] === 0x7e && data[i + 1] === 0x3e)) i++;
          i += 2;
          a85End = i;
        }
        inlineStart = -1;
        while (
          i < n &&
          !(
            data[i] === 0x45 &&
            data[i + 1] === 0x49 &&
            (isWhite(data[i - 1]) || i === a85End) &&
            (i + 2 >= n || isWhite(data[i + 2]) || isDelim(data[i + 2]))
          )
        ) {
          i++;
        }
        i += 2;
      }
    }
  }
  return open;
}

/**
 * Descomprime Flate con zlib y un tope de salida (maxOutputLength corta sin reservar la memoria): pdf-lib lo
 * descomprime entero y una bomba chica ocupaba cientos de MB. `null` si supera `max`. Con datos dañados (suma de control,
 * bloque inválido, basura en el medio) zlib no devuelve nada: se decodifica con pdf-lib (que no verifica la suma ni el
 * encabezado: se reemplaza por uno válido) dentro del mismo tope, y se conserva lo leído hasta el error, que es lo que
 * dibuja un lector.
 */
function inflateCapped(data: Uint8Array, max: number): Uint8Array | null {
  try {
    const out = inflateSync(data, { maxOutputLength: Math.max(1, max + 1), finishFlush: constants.Z_SYNC_FLUSH });
    return out.length > max ? null : out;
  } catch (e) {
    if (e instanceof RangeError) return null;
  }
  if (data.length < 2) return new Uint8Array();
  // Encabezado zlib inválido (método distinto de deflate o FCHECK que no cierra): puede ser deflate crudo, sin
  // encabezado. Se prueba eso primero, con el mismo tope; pisar los dos primeros bytes destruía el comienzo de esos datos.
  if ((data[0] & 0x0f) !== 8 || ((data[0] << 8) | data[1]) % 31 !== 0) {
    try {
      const raw = inflateRawSync(data, { maxOutputLength: Math.max(1, max + 1), finishFlush: constants.Z_SYNC_FLUSH });
      if (raw.length > max) return null;
      if (raw.length > 0) return raw;
    } catch (e) {
      if (e instanceof RangeError) return null;
    }
  }
  const fixed = new Uint8Array(data.length);
  fixed.set(data);
  fixed[0] = 0x78;
  fixed[1] = 0x9c;
  return decodeFilterCapped("Flate", fixed, max);
}

/**
 * Deshace un predictor PNG (10-15) o TIFF (2, de 8 bits) como pdf.js. `null` con parámetros que no se saben aplicar
 * (TIFF de otro ancho de componente, predictor desconocido, valores absurdos, filas más largas que los datos).
 */
function undoPredictor(ctx: PDFContext, parms: PDFDict, data: Uint8Array, predictor: number): Uint8Array | null {
  const colors = numOf(ctx, parms.get(N("Colors"))) ?? 1;
  const bpc = numOf(ctx, parms.get(N("BitsPerComponent"))) ?? 8;
  const columns = numOf(ctx, parms.get(N("Columns"))) ?? 1;
  if (![1, 2, 4, 8, 16].includes(bpc) || !(colors >= 1 && colors <= 32) || !(columns >= 1 && columns <= 1 << 24)) return null;
  const pix = Math.ceil((colors * bpc) / 8);
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return null;
    const out = new Uint8Array(data);
    for (let r = 0; r < out.length; r += rowBytes) {
      for (let i = r + pix; i < Math.min(r + rowBytes, out.length); i++) out[i] = (out[i] + out[i - pix]) & 0xff;
    }
    return out;
  }
  if (!Number.isInteger(predictor) || predictor < 10 || predictor > 15) return null;
  // Columns sale del archivo (hasta 2^24, hasta 1 GiB por fila): una fila más larga que todos los datos no es un
  // predictor PNG real y reservar prev/row de ese tamaño, con un stream de pocos bytes, agotaba la memoria.
  if (rowBytes > data.length) return null;
  const out = new Uint8Array(Math.floor(data.length / (rowBytes + 1)) * rowBytes + Math.max(0, (data.length % (rowBytes + 1)) - 1));
  const rowAlloc = Math.min(rowBytes, data.length);
  let prev = new Uint8Array(rowAlloc);
  let o = 0;
  for (let at = 0; at < data.length; at += rowBytes + 1) {
    const type = data[at];
    const raw = data.subarray(at + 1, Math.min(at + 1 + rowBytes, data.length));
    const row = new Uint8Array(rowAlloc);
    for (let i = 0; i < raw.length; i++) {
      const a = i >= pix ? row[i - pix] : 0;
      const b = prev[i];
      const c = i >= pix ? prev[i - pix] : 0;
      let p = 0;
      if (type === 1) p = a;
      else if (type === 2) p = b;
      else if (type === 3) p = (a + b) >> 1;
      else if (type === 4) {
        const pa = Math.abs(b - c),
          pb = Math.abs(a - c),
          pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (type !== 0) return out.subarray(0, o); // tipo de fila inválido: pdf.js deja de leer ahí
      row[i] = (raw[i] + p) & 0xff;
    }
    out.set(row.subarray(0, raw.length), o);
    o += raw.length;
    prev = row;
  }
  return out.subarray(0, o);
}

const FILTER_KINDS: Record<string, CappedFilter> = {
  FlateDecode: "Flate",
  Fl: "Flate",
  LZWDecode: "LZW",
  LZW: "LZW",
  ASCII85Decode: "ASCII85",
  A85: "ASCII85",
  ASCIIHexDecode: "ASCIIHex",
  AHx: "ASCIIHex",
  RunLengthDecode: "RunLength",
  RL: "RunLength",
};

/**
 * Decodifica un stream con todos sus filtros en orden (también los nombres abreviados y los predictores de Flate/LZW,
 * que pdf-lib no aplica), con un tope de `max` bytes en cada paso. `null` si supera el tope o tiene un filtro o un
 * predictor que no se sabe decodificar: quien llama no puede saber qué dibuja un lector con él.
 */
function decodeStreamCapped(s: PDFRawStream, max: number): Uint8Array | null {
  const ctx = s.dict.context;
  const f = resolve(ctx, s.dict.get(N("Filter")));
  const filters = f instanceof PDFArray ? f.asArray() : [f];
  const p = resolve(ctx, s.dict.get(N("DecodeParms")));
  // Como pdf.js: un diccionario suelto (sin arreglo) vale para el primer filtro.
  const parmsList = p instanceof PDFArray ? p.asArray() : [p];
  let out: Uint8Array | null = s.contents;
  for (let k = 0; k < filters.length && out; k++) {
    const name = nameOf(ctx, filters[k]) ?? "";
    const kind = Object.hasOwn(FILTER_KINDS, name) ? FILTER_KINDS[name] : undefined;
    if (!kind) return null;
    const parms = dictOf(ctx, parmsList[k]);
    const predictor = (parms && numOf(ctx, parms.get(N("Predictor")))) ?? 1;
    if (kind === "Flate") out = inflateCapped(out, max);
    else out = decodeFilterCapped(kind, out, max, (parms && numOf(ctx, parms.get(N("EarlyChange")))) ?? 1);
    if (out && predictor > 1 && (kind === "Flate" || kind === "LZW")) out = undoPredictor(ctx, parms!, out, predictor);
  }
  return out;
}

function streamData(s: PDFObject | undefined): Uint8Array | undefined {
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    if (s instanceof PDFStream) return s.getContents();
  } catch {
    // Filtro desconocido o datos dañados: un lector tampoco lo dibuja.
  }
  return undefined;
}

/**
 * Tope de bytes (descomprimidos) que se tokenizan por página o por formulario. Como en compressPlainStreams, lo más
 * grande no se tokeniza: tokenizar y copiar decenas de MB por página bloqueaba el worker.
 */
const MAX_MARKED_SCAN = 32 * 1024 * 1024;

/**
 * EMC que se agregan al final de una página cuyo contenido (o el de un formulario que dibuja) no se pudo leer: más
 * grande que el tope, o con un filtro o predictor que no se sabe decodificar. Como no se puede contar lo que queda
 * abierto, se cierra "de más": los EMC sobrantes son inocuos (pdf.js, poppler y MuPDF ignoran un EMC sin BDC/BMC
 * abierto, pdf.js también en la capa de texto) y van después del Q que envuelve el original, así que no alteran nada
 * de lo que el original dibuja. Cierra hasta esta profundidad de anidamiento (4 KB por página afectada); un original
 * que anide más que esto en un stream que no se puede leer queda sin cerrar del todo (caso deliberadamente hostil).
 */
const FALLBACK_EMC = 1024;

/** Si los bytes contienen un BDC o un BMC (búsqueda nativa: casi gratis frente a tokenizar). */
function mentionsMarkedContent(data: Uint8Array): boolean {
  const b = Buffer.from(data.buffer, data.byteOffset, data.length);
  return b.indexOf("BDC", 0, "latin1") !== -1 || b.indexOf("BMC", 0, "latin1") !== -1;
}

/**
 * Contenido de un stream para buscar contenido marcado: un stream sin filtro se mira en sus bytes crudos (sin copiarlos
 * ni decodificarlos); con filtros se decodifican todos (decodeStreamCapped) con tope. `null` si no se puede leer (supera
 * `room` bytes, o filtro/predictor desconocido); con datos dañados, lo que se pudo leer (lo que dibuja un lector).
 */
function markedScanData(s: PDFObject | undefined, room: number): Uint8Array | null {
  if (s instanceof PDFRawStream && !s.dict.has(N("Filter"))) return s.contents.length > room ? null : s.contents;
  // Con filtro los datos codificados ocupan a lo sumo ~2 veces lo decodificado (ASCIIHex): más que eso ni se decodifica.
  if (s instanceof PDFRawStream && s.contents.length > room * 4) return null;
  if (s instanceof PDFRawStream) return room > 0 ? decodeStreamCapped(s, room) : null;
  // Otro objeto (no stream, o un stream que armó pdf-lib en este proceso): lo que dé pdf-lib.
  const data = streamData(s) ?? new Uint8Array();
  return data.length > room ? null : data;
}

/**
 * Cierra el contenido marcado que el original deja abierto: un `/OC /x BDC` sin EMC en una capa apagada dejaba oculto
 * todo lo que se dibuja después en la página, incluido lo estampado al sellar. En cada página se cuentan BDC/BMC contra
 * EMC sobre todos sus content streams y se agregan los EMC que falten al final, después del Q que envuelve el original
 * (el contenido queda entre q/Q como al estampar). Lo mismo dentro de cada XObject de formulario que dibuja la página
 * (también los widgets aplanados y los anidados): el EMC va al final de su stream. Se hace siempre, con o sin capas.
 * Rápido en el caso común: un stream sin "BDC" ni "BMC" no se tokeniza (y la página tampoco), y uno sin filtro se busca
 * en sus bytes crudos. Si la página o uno de sus formularios no se puede leer (más de MAX_MARKED_SCAN bytes, filtro o
 * predictor desconocido), no se sabe cuántos quedan abiertos: se agregan FALLBACK_EMC al final de la página.
 */
export function closeMarkedContent(doc: PDFDocument): void {
  const ctx = doc.context;
  /** Por formulario: si él o uno de sus anidados no se pudo leer (un formulario compartido se revisa una vez). */
  const formUnreadable = new Map<unknown, boolean>();
  const fixForms = (resources: PDFDict | undefined, depth: number): boolean => {
    if (!resources || depth > 16) return false;
    let unreadable = false;
    const xobjects = dictOf(ctx, resources.get(N("XObject")));
    for (const [name, raw] of xobjects?.entries() ?? []) {
      const key = keyOf(raw);
      if (formUnreadable.has(key)) {
        unreadable ||= formUnreadable.get(key)!;
        continue;
      }
      if (formUnreadable.size > 10_000) continue;
      formUnreadable.set(key, false); // en curso (ciclos)
      const form = resolve(ctx, raw);
      if (!(form instanceof PDFStream) || nameOf(ctx, form.dict.get(N("Subtype"))) !== "Form") continue;
      const data = markedScanData(form, MAX_MARKED_SCAN);
      const missing = data?.length && mentionsMarkedContent(data) ? unclosedMarkedContent(data) : 0;
      if (data && missing > 0) {
        const fixed = ctx.flateStream(Buffer.concat([Buffer.from(data), Buffer.from("\n" + "EMC\n".repeat(missing))]));
        for (const [k, v] of form.dict.entries()) {
          const key = k.decodeText();
          if (key !== "Length" && key !== "Filter" && key !== "DecodeParms") fixed.dict.set(k, v);
        }
        if (raw instanceof PDFRef) ctx.assign(raw, fixed);
        else xobjects!.set(name, fixed);
      }
      const bad = fixForms(dictOf(ctx, form.dict.get(N("Resources"))), depth + 1) || data === null;
      formUnreadable.set(key, bad);
      unreadable ||= bad;
    }
    return unreadable;
  };
  for (const page of doc.getPages()) {
    const raw = page.node.get(N("Contents"));
    const contents = resolve(ctx, raw);
    const refs = contents instanceof PDFArray ? contents.asArray() : raw ? [raw] : [];
    const parts: Uint8Array[] = [];
    let size = 0;
    let marked = false;
    let unreadable = false;
    for (const r of refs) {
      const part = markedScanData(resolve(ctx, r), MAX_MARKED_SCAN - size);
      if (part === null) {
        unreadable = true;
        break;
      }
      parts.push(part);
      size += part.length;
      marked ||= mentionsMarkedContent(part);
    }
    unreadable = fixForms(dictOf(ctx, page.node.getInheritableAttribute(N("Resources"))), 0) || unreadable;
    const missing = unreadable ? FALLBACK_EMC : marked ? unclosedMarkedContent(Buffer.concat(parts.flatMap((p) => [p, Buffer.from("\n")]))) : 0;
    if (missing > 0) {
      page.node.set(
        N("Contents"),
        ctx.obj([
          ctx.getPushGraphicsStateContentStream(),
          ...refs,
          ctx.getPopGraphicsStateContentStream(),
          ctx.register(ctx.flateStream("EMC\n".repeat(missing))),
        ]),
      );
    }
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
  closeMarkedContent(doc);
  return layers;
}
