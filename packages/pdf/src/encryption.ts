// ¿Un PDF cifrado se abre sin contraseña? (Contraseña de usuario vacía: solo tiene restricciones de permisos —imprimir,
// copiar, editar—.) pdf-lib no descifra, así que no se puede aceptar tal cual; pero el mensaje al usuario es otro: no
// hace falta ninguna contraseña, alcanza con volver a exportarlo o imprimirlo a PDF.
import { createCipheriv, createHash } from "node:crypto";
import { PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocument, type PDFObject } from "pdf-lib";

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
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

const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();

/** Algoritmo 2.B de ISO 32000-2 (R6) con contraseña vacía. */
function hash2B(salt: Buffer, udata: Buffer): Buffer {
  let k = createHash("sha256").update(Buffer.concat([salt, udata])).digest();
  for (let i = 0; ; ) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([k, udata])));
    const c = createCipheriv("aes-128-cbc", k.subarray(0, 16), k.subarray(16, 32));
    c.setAutoPadding(false);
    const e = Buffer.concat([c.update(k1), c.final()]);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    k = createHash(["sha256", "sha384", "sha512"][sum % 3]).update(e).digest();
    i++;
    if (i >= 64 && e[e.length - 1] <= i - 32) break;
  }
  return k.subarray(0, 32);
}

function bytesOf(o: PDFObject | undefined): Buffer | null {
  if (o instanceof PDFString || o instanceof PDFHexString) return Buffer.from(o.asBytes());
  return null;
}

/**
 * true si el diccionario /Encrypt (filtro Standard) admite la contraseña de usuario vacía: el PDF abre sin pedir nada y
 * solo restringe permisos. Lee el documento cargado con `ignoreEncryption`.
 */
export function opensWithoutPassword(doc: PDFDocument): boolean {
  try {
    const ctx = doc.context;
    const raw = ctx.trailerInfo.Encrypt as PDFObject | undefined;
    const enc = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
    if (!(enc instanceof PDFDict)) return false;
    if (enc.get(PDFName.of("Filter")) !== PDFName.of("Standard")) return false;
    const r = (enc.get(PDFName.of("R")) as PDFNumber | undefined)?.asNumber?.() ?? 0;
    const o = bytesOf(enc.get(PDFName.of("O")));
    const u = bytesOf(enc.get(PDFName.of("U")));
    if (!o || !u) return false;
    if (r === 5) return createHash("sha256").update(u.subarray(32, 40)).digest().equals(u.subarray(0, 32));
    if (r === 6) return u.length >= 48 && hash2B(u.subarray(32, 40), Buffer.alloc(0)).equals(u.subarray(0, 32));
    if (r < 2 || r > 4) return false;
    const p = (enc.get(PDFName.of("P")) as PDFNumber | undefined)?.asNumber?.();
    if (p === undefined) return false;
    const pBuf = Buffer.alloc(4);
    pBuf.writeInt32LE(p | 0);
    const idRaw = ctx.trailerInfo.ID as PDFObject | undefined;
    const idArr = idRaw instanceof PDFRef ? ctx.lookup(idRaw) : idRaw;
    const id0 = idArr instanceof PDFArray ? bytesOf(idArr.get(0)) ?? Buffer.alloc(0) : Buffer.alloc(0);
    const n = r === 2 ? 5 : Math.min(16, Math.max(5, keyLengthBits(ctx, enc, r) / 8));
    const encryptMetadata = enc.get(PDFName.of("EncryptMetadata"));
    const noMeta = r >= 4 && encryptMetadata instanceof PDFBool && !encryptMetadata.asBoolean();
    let key = md5(PAD, o.subarray(0, 32), pBuf, id0, noMeta ? Buffer.from([255, 255, 255, 255]) : Buffer.alloc(0));
    if (r >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
    key = key.subarray(0, n);
    if (r === 2) return rc4(key, PAD).equals(u.subarray(0, 32));
    let x = rc4(key, md5(PAD, id0));
    for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(key.map((b) => b ^ i)), x);
    return x.equals(u.subarray(0, 16));
  } catch {
    return false;
  }
}

/**
 * Largo de la clave en bits. /Length del /Encrypt; en R4 sin él, el /Length del filtro de /StmF (/StdCF) en /CF (como
 * pdf.js: en bytes si es menor que 40, en bits si no) o 128 (AESV2, 16 bytes; también el valor por defecto de pdf.js).
 */
function keyLengthBits(ctx: PDFDocument["context"], enc: PDFDict, r: number): number {
  const num = (o: PDFObject | undefined) => {
    const v = o instanceof PDFRef ? ctx.lookup(o) : o;
    return v instanceof PDFNumber ? v.asNumber() : undefined;
  };
  const dict = (o: PDFObject | undefined) => {
    const v = o instanceof PDFRef ? ctx.lookup(o) : o;
    return v instanceof PDFDict ? v : undefined;
  };
  const len = num(enc.get(PDFName.of("Length")));
  if (len !== undefined || r !== 4) return len ?? 40;
  const stmF = enc.get(PDFName.of("StmF"));
  const filter = dict(dict(enc.get(PDFName.of("CF")))?.get(stmF instanceof PDFName ? stmF : PDFName.of("StdCF")));
  const cf = num(filter?.get(PDFName.of("Length")));
  if (!cf) return 128;
  return cf < 40 ? cf * 8 : cf;
}
