// Control estructural del PDF preparado (contra "ataques de guardado incremental"): la revisión que agrega el servidor
// solo puede sumar la firma (diccionario /Sig + widget invisible) y engancharla en la página y el formulario. Si cambia
// cualquier otra cosa —por ejemplo, el contenido de una página— lo que el titular vio no es lo que firmaría.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { CertsignError } from "./protocol";

/** Claves que la revisión de firma puede tocar en objetos existentes. */
const ALLOWED_KEYS = new Set(["Annots", "AcroForm", "Fields", "SigFlags"]);
/** Claves de un diccionario de firma común (sin /Reference: DocMDP/FieldMDP cambiarían los permisos del documento). */
const SIG_KEYS = new Set(["Type", "Filter", "SubFilter", "ByteRange", "Contents", "M", "Reason", "Name", "Location", "ContactInfo"]);
/** Claves del widget invisible del campo de firma (sin acciones /A o /AA, sin apariencia). */
const WIDGET_KEYS = new Set(["Type", "Subtype", "FT", "Rect", "V", "T", "F", "P"]);

const fail = (m: string): never => {
  throw new CertsignError(0, "document_mismatch", `No se firma: ${m}`);
};

async function load(bytes: Uint8Array) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: true });
  } catch {
    return fail("no se pudo leer el documento");
  }
}

const str = (o: PDFObject | undefined) => (o === undefined ? "" : o.toString());

function sameObject(a: PDFObject, b: PDFObject): boolean {
  if (a instanceof PDFStream || b instanceof PDFStream) {
    if (!(a instanceof PDFRawStream) || !(b instanceof PDFRawStream)) return str(a) === str(b) && a.constructor === b.constructor;
    return a.dict.toString() === b.dict.toString() && Buffer.from(a.contents).equals(Buffer.from(b.contents));
  }
  return str(a) === str(b);
}

/** `after` = `before` + referencias a widgets nuevos (en ese orden). */
function onlyAppendsWidgets(before: PDFArray | undefined, after: PDFArray, newWidgets: Set<string>): boolean {
  const prev = before ? before.asArray() : [];
  const next = after.asArray();
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) if (str(prev[i]) !== str(next[i])) return false;
  return next.slice(prev.length).every((x) => x instanceof PDFRef && newWidgets.has(x.toString()));
}

/**
 * Compara el documento mostrado (`working`) con el preparado para firmar. Lanza `document_mismatch` si la revisión
 * nueva hace algo más que agregar una firma invisible.
 */
export async function assertOnlySignatureAdded(working: Uint8Array, prepared: Uint8Array): Promise<void> {
  const A = await load(working);
  const B = await load(prepared);
  const before = new Map(A.context.enumerateIndirectObjects().map(([r, o]) => [r.toString(), o] as const));
  const after = new Map(B.context.enumerateIndirectObjects().map(([r, o]) => [r.toString(), o] as const));

  for (const key of before.keys()) if (!after.has(key)) fail("el documento preparado elimina partes del documento");
  // La raíz del documento (y su cifrado) no pueden cambiar: otro catálogo mostraría otras páginas.
  if (str(A.context.trailerInfo.Root) !== str(B.context.trailerInfo.Root)) fail("el documento preparado cambia la raíz del documento");
  if (str(A.context.trailerInfo.Encrypt) !== str(B.context.trailerInfo.Encrypt)) fail("el documento preparado cambia el cifrado");
  // Un objeto nuevo no puede reusar el número de uno existente (otra generación lo "taparía" para los lectores).
  const beforeNums = new Set([...before.keys()].map((k) => k.split(" ")[0]));
  for (const key of after.keys()) if (!before.has(key) && beforeNums.has(key.split(" ")[0])) fail("el documento preparado reemplaza objetos existentes");
  // Lo que pdf-lib no ve (lee los objetos en orden e ignora la tabla xref): la revisión nueva solo puede listar
  // objetos que escribe ella misma, sin liberar ni redirigir objetos del documento mostrado.
  assertTailXref(working, prepared, str(A.context.trailerInfo.Root), str(A.context.trailerInfo.Encrypt));

  // Objetos nuevos: solo el diccionario de firma y su widget invisible.
  const newSigs = new Set<string>();
  const newWidgets = new Set<string>();
  for (const [key, obj] of after) {
    if (before.has(key)) continue;
    if (!(obj instanceof PDFDict) || obj instanceof PDFStream) fail("el documento preparado agrega contenido");
    const d = obj as PDFDict;
    const type = str(d.get(PDFName.of("Type")));
    const subtype = str(d.get(PDFName.of("Subtype")));
    if (type === "/Sig" && d.has(PDFName.of("ByteRange"))) {
      for (const k of d.keys()) if (!SIG_KEYS.has(k.decodeText())) fail(`la firma agregada trae /${k.decodeText()}`);
      newSigs.add(key);
    } else if (subtype === "/Widget" && str(d.get(PDFName.of("FT"))) === "/Sig") {
      const rect = d.lookupMaybe(PDFName.of("Rect"), PDFArray);
      const zero = rect?.asArray().every((n) => n instanceof PDFNumber && n.asNumber() === 0);
      if (!zero || d.has(PDFName.of("AP"))) fail("la firma agregada no es invisible");
      for (const k of d.keys()) if (!WIDGET_KEYS.has(k.decodeText())) fail(`el campo de firma trae /${k.decodeText()}`);
      newWidgets.add(key);
    } else {
      fail("el documento preparado agrega objetos que no son la firma");
    }
  }
  if (newSigs.size !== 1 || newWidgets.size !== 1) fail("el documento preparado no agrega exactamente una firma");
  const widget = after.get([...newWidgets][0]) as PDFDict;
  if (str(widget.get(PDFName.of("V"))) !== [...newSigs][0]) fail("el campo de firma no apunta a la firma nueva");

  // Objetos existentes modificados: solo para enganchar el widget (Annots de la página, Fields/SigFlags/AcroForm).
  for (const [key, prev] of before) {
    const next = after.get(key)!;
    if (sameObject(prev, next)) continue;
    if (prev instanceof PDFArray && next instanceof PDFArray) {
      if (!onlyAppendsWidgets(prev, next, newWidgets)) fail("el documento preparado modifica una lista del documento");
      continue;
    }
    if (!(prev instanceof PDFDict) || !(next instanceof PDFDict) || prev instanceof PDFStream || next instanceof PDFStream) {
      fail("el documento preparado modifica el contenido del documento");
    }
    checkDictChange(prev as PDFDict, next as PDFDict, newWidgets);
  }
}

function checkDictChange(prev: PDFDict, next: PDFDict, newWidgets: Set<string>) {
  const keys = new Set([...prev.keys(), ...next.keys()].map((k) => k.decodeText()));
  for (const k of keys) {
    const a = prev.get(PDFName.of(k));
    const b = next.get(PDFName.of(k));
    if (str(a) === str(b)) continue;
    if (!ALLOWED_KEYS.has(k)) fail(`el documento preparado modifica /${k}`);
    if (k === "SigFlags") {
      if (!(b instanceof PDFNumber)) fail("/SigFlags inválido");
      continue;
    }
    if (k === "Annots" || k === "Fields") {
      if (!(b instanceof PDFArray) || (a !== undefined && !(a instanceof PDFArray))) fail(`el documento preparado reemplaza /${k}`);
      if (!onlyAppendsWidgets(a as PDFArray | undefined, b as PDFArray, newWidgets)) fail(`el documento preparado agrega a /${k} algo que no es la firma`);
      continue;
    }
    // AcroForm directo en el catálogo: solo puede cambiar Fields/SigFlags.
    if (!(b instanceof PDFDict) || (a !== undefined && !(a instanceof PDFDict))) fail("el documento preparado reemplaza /AcroForm");
    checkDictChange((a as PDFDict | undefined) ?? (b as PDFDict).context.obj({}), b as PDFDict, newWidgets);
  }
}

/**
 * Revisa las tablas xref que agrega la revisión nueva (solo xref clásica: un xref en stream sería un objeto nuevo
 * que no es la firma y ya se rechaza arriba). Cada entrada tiene que ser "en uso" (salvo la entrada 0 estándar) y
 * apuntar a un objeto escrito en la revisión nueva con ese mismo número: si apuntara a bytes del documento mostrado
 * o liberara un objeto, un lector mostraría otro contenido aunque pdf-lib lea lo mismo.
 */
function assertTailXref(working: Uint8Array, prepared: Uint8Array, root: string, encrypt: string) {
  const base = working.length;
  const buf = Buffer.from(prepared);
  const tail = buf.subarray(base).toString("latin1");
  if (/\/Type\s*\/XRef\b/.test(tail)) fail("el documento preparado usa una tabla de referencias comprimida");
  const sections = [...tail.matchAll(/(?:^|[\r\n])xref[ \t]*\r?\n/g)];
  if (sections.length === 0) fail("el documento preparado no tiene tabla de referencias propia");
  // Última definición de cada objeto en la revisión nueva: es la que lee pdf-lib (y la que se compara arriba). Si la
  // tabla apuntara a otra copia anterior del mismo objeto, un lector mostraría esa copia, que nadie comparó.
  const lastDef = new Map<string, number>();
  for (const m of tail.matchAll(/(^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g)) lastDef.set(`${Number(m[2])} ${Number(m[3])}`, base + (m.index ?? 0) + m[1].length);
  const starts = new Set<number>();
  for (const sec of sections) {
    const lead = sec[0].startsWith("x") ? 0 : 1;
    starts.add(base + (sec.index ?? 0) + lead);
    let pos = (sec.index ?? 0) + sec[0].length;
    for (;;) {
      const head = /^[ \t]*(\d+)[ \t]+(\d+)[ \t]*\r?\n/.exec(tail.slice(pos));
      if (!head) break;
      pos += head[0].length;
      const start = Number(head[1]);
      const count = Number(head[2]);
      for (let i = 0; i < count; i++) {
        const e = /^(\d{10}) (\d{5}) ([nf])[ \t]?\r?\n?/.exec(tail.slice(pos, pos + 22));
        if (!e) fail("tabla de referencias inválida");
        pos += e![0].length;
        const num = start + i;
        const offset = Number(e![1]);
        const gen = Number(e![2]);
        if (e![3] === "f") {
          if (num !== 0) fail("el documento preparado libera objetos del documento");
          continue;
        }
        if (offset < base) fail("el documento preparado redirige objetos a otras partes del documento");
        const at = buf.subarray(offset, offset + 40).toString("latin1");
        if (!new RegExp(`^${num}\\s+${gen}\\s+obj\\b`).test(at)) fail("la tabla de referencias no corresponde a los objetos agregados");
        if (lastDef.get(`${num} ${gen}`) !== offset) fail("la tabla de referencias apunta a una copia del objeto distinta de la que se revisó");
      }
    }
    if (!/^\s*trailer\b/.test(tail.slice(pos))) fail("tabla de referencias inválida");
  }
  // pdf-lib "recupera" un /Root que no es un catálogo y lo reemplaza por otro: se mira el trailer tal cual está escrito.
  const norm = (r: string) => r.replace(/\s+/g, " ");
  if ((tail.match(/\/Root\b/g) ?? []).length !== [...tail.matchAll(/\/Root\s+\d+\s+\d+\s+R/g)].length) fail("el documento preparado cambia la raíz del documento");
  for (const m of tail.matchAll(/\/Root\s+(\d+\s+\d+\s+R)/g)) if (norm(m[1]) !== root) fail("el documento preparado cambia la raíz del documento");
  for (const m of tail.matchAll(/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/g)) if (norm(m[1]) !== encrypt) fail("el documento preparado cambia el cifrado");
  // La cadena de tablas tiene que ser: startxref → una tabla de la revisión nueva → (/Prev entre ellas) → la última
  // tabla del documento mostrado. Saltear esa última haría que un lector muestre una revisión anterior del documento.
  const last = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!last || !starts.has(Number(last[1]))) fail("el documento preparado no usa su propia tabla de referencias");
  // El último startxref del documento mostrado, buscado en todo el archivo (con relleno tras el %%EOF no está en los
  // últimos 2 KB).
  const workingStartxref = [...Buffer.from(working).subarray(0, base).toString("latin1").matchAll(/startxref\s+(\d+)/g)].pop();
  for (const m of tail.matchAll(/\/Prev\s+(\d+)/g)) {
    const prev = Number(m[1]);
    if (prev >= base ? !starts.has(prev) : !workingStartxref || prev !== Number(workingStartxref[1])) {
      fail("el documento preparado no encadena con la última revisión del documento mostrado");
    }
  }
}
