// Control estructural del PDF preparado (contra "ataques de guardado incremental"): la revisión que agrega el servidor
// solo puede sumar la firma (diccionario /Sig + widget invisible) y engancharla en la página y el formulario. Si cambia
// cualquier otra cosa —por ejemplo, el contenido de una página— lo que el titular vio no es lo que firmaría.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import { CertsignError } from "./protocol";

/** Claves que la revisión de firma puede tocar en objetos existentes. */
const ALLOWED_KEYS = new Set(["Annots", "AcroForm", "Fields", "SigFlags"]);

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
      newSigs.add(key);
    } else if (subtype === "/Widget" && str(d.get(PDFName.of("FT"))) === "/Sig") {
      const rect = d.lookupMaybe(PDFName.of("Rect"), PDFArray);
      const zero = rect?.asArray().every((n) => n instanceof PDFNumber && n.asNumber() === 0);
      if (!zero || d.has(PDFName.of("AP"))) fail("la firma agregada no es invisible");
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
