// Firma con certificado propio del firmante, en dos pasos (el servidor nunca ve la clave privada):
//   1. prepareExternalSignature: revisión incremental con el campo de firma y el placeholder; se calcula el
//      ByteRange, el digest del contenido y los atributos firmados. El dispositivo del firmante firma su hash.
//   2. completeExternalSignature: se verifica la firma contra el certificado, se arma el CMS (con sello de
//      tiempo si hay TSA) y se inserta en el placeholder. Las firmas anteriores del PDF no se tocan.
import { X509Certificate, createHash, verify as cryptoVerify } from "node:crypto";
import { findByteRange } from "@signpdf/utils";
import { buildSignaturePlaceholderIncremental } from "./incremental";
import { assembleCms, buildSignedAttributes, type CmsOptions, type CmsSignatureAlgorithm } from "./cms";

export interface PrepareExternalOptions {
  fieldName: string;
  reason?: string;
  name?: string;
  location?: string;
  /** Bytes reservados para el CMS (en binario). Por defecto 32 KB: cadena larga + sello de tiempo. */
  signatureLength?: number;
}

export interface PreparedExternalSignature {
  /** PDF con el ByteRange ya escrito y Contents en ceros. Se guarda hasta recibir la firma. */
  preparedPdf: Uint8Array;
  byteRange: [number, number, number, number];
  /** Atributos firmados (DER). Lo que firma el titular. */
  signedAttrsDer: Uint8Array;
  /** SHA-256 de signedAttrsDer: el hash que firma un token / almacén de Windows. */
  digestToSign: Uint8Array;
  signatureAlgorithm: CmsSignatureAlgorithm;
  /** Curva, si es ECDSA. */
  namedCurve: string | null;
}

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** Tipo de clave del certificado del firmante (solo RSA y ECDSA P-256/P-384). */
export function signingAlgorithmFor(certDer: Uint8Array): { algorithm: CmsSignatureAlgorithm; namedCurve: string | null } {
  const key = new X509Certificate(Buffer.from(certDer)).publicKey;
  if (key.asymmetricKeyType === "rsa") return { algorithm: "RSASSA-PKCS1-v1_5", namedCurve: null };
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve ?? null;
    if (curve !== "prime256v1" && curve !== "secp384r1") throw new Error(`curva no soportada: ${curve ?? "desconocida"}`);
    return { algorithm: "ECDSA", namedCurve: curve };
  }
  throw new Error(`tipo de clave no soportado: ${key.asymmetricKeyType}`);
}

export async function prepareExternalSignature(pdf: Uint8Array, chainDer: Uint8Array[], o: PrepareExternalOptions): Promise<PreparedExternalSignature> {
  if (!chainDer.length) throw new Error("falta el certificado del firmante");
  const { algorithm, namedCurve } = signingAlgorithmFor(chainDer[0]);
  const withPlaceholder = await buildSignaturePlaceholderIncremental(pdf, {
    type: "Sig",
    fieldName: o.fieldName,
    reason: o.reason,
    name: o.name,
    location: o.location,
    signatureLength: o.signatureLength ?? 32_000,
  });
  // Igual que @signpdf/signpdf: sin salto final, ByteRange real en lugar del placeholder.
  let buf = Buffer.from(withPlaceholder);
  while (buf.length && (buf[buf.length - 1] === 0x0a || buf[buf.length - 1] === 0x0d)) buf = buf.subarray(0, buf.length - 1);
  const { byteRangePlaceholder, byteRangePlaceholderPosition } = findByteRange(buf);
  if (!byteRangePlaceholder || byteRangePlaceholderPosition === undefined) throw new Error("no se encontró el placeholder del ByteRange");
  const byteRangeEnd = byteRangePlaceholderPosition + byteRangePlaceholder.length;
  const contentsTagPos = buf.indexOf("/Contents ", byteRangeEnd);
  const placeholderPos = buf.indexOf("<", contentsTagPos);
  const placeholderEnd = buf.indexOf(">", placeholderPos);
  const br: [number, number, number, number] = [0, placeholderPos, placeholderEnd + 1, 0];
  br[3] = buf.length - br[2];
  let actual = `/ByteRange [${br.join(" ")}]`;
  actual += " ".repeat(byteRangePlaceholder.length - actual.length);
  buf = Buffer.concat([buf.subarray(0, byteRangePlaceholderPosition), Buffer.from(actual), buf.subarray(byteRangeEnd)]);
  const content = Buffer.concat([buf.subarray(0, br[1]), buf.subarray(br[2], br[2] + br[3])]);
  const signedAttrsDer = buildSignedAttributes(sha256(content), chainDer);
  return {
    preparedPdf: new Uint8Array(buf),
    byteRange: br,
    signedAttrsDer,
    digestToSign: sha256(signedAttrsDer),
    signatureAlgorithm: algorithm,
    namedCurve,
  };
}

/** ECDSA: acepta DER o r||s (IEEE P1363, lo que devuelven PKCS#11 y Windows) y devuelve DER. */
export function normalizeEcdsaSignature(sig: Uint8Array, namedCurve: string | null): Uint8Array {
  const coord = namedCurve === "secp384r1" ? 48 : 32;
  if (sig.length === coord * 2 && sig[0] !== 0x30) {
    const int = (b: Uint8Array) => {
      let i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      let v = b.subarray(i);
      if (v[0] & 0x80) v = Uint8Array.from([0, ...v]);
      return Uint8Array.from([0x02, v.length, ...v]);
    };
    const r = int(sig.subarray(0, coord));
    const s = int(sig.subarray(coord));
    const body = Uint8Array.from([...r, ...s]);
    return Uint8Array.from([0x30, body.length, ...body]);
  }
  return sig;
}

/** Verifica la firma del titular sobre los atributos firmados con la clave pública de su certificado. */
export function verifyExternalSignature(p: Pick<PreparedExternalSignature, "signedAttrsDer" | "signatureAlgorithm">, certDer: Uint8Array, signature: Uint8Array): boolean {
  const key = new X509Certificate(Buffer.from(certDer)).publicKey;
  try {
    return cryptoVerify("sha256", Buffer.from(p.signedAttrsDer), p.signatureAlgorithm === "ECDSA" ? { key, dsaEncoding: "der" } : key, Buffer.from(signature));
  } catch {
    return false;
  }
}

export async function completeExternalSignature(
  p: Pick<PreparedExternalSignature, "preparedPdf" | "byteRange" | "signedAttrsDer" | "signatureAlgorithm" | "namedCurve">,
  chainDer: Uint8Array[],
  signatureIn: Uint8Array,
  opts: CmsOptions = {},
): Promise<Uint8Array> {
  const signature = p.signatureAlgorithm === "ECDSA" ? normalizeEcdsaSignature(signatureIn, p.namedCurve) : signatureIn;
  if (!verifyExternalSignature(p, chainDer[0], signature)) throw new Error("la firma no corresponde al certificado y al documento");
  const cms = await assembleCms({ signedAttrsDer: p.signedAttrsDer, chainDer, signature, signatureAlgorithm: p.signatureAlgorithm }, opts);
  const [, start, end] = p.byteRange;
  const placeholderLength = end - start - 2;
  if (cms.length * 2 > placeholderLength) throw new Error(`la firma no entra en el espacio reservado (${cms.length * 2} > ${placeholderLength})`);
  const hex = Buffer.from(cms).toString("hex").padEnd(placeholderLength, "0");
  const buf = Buffer.from(p.preparedPdf);
  if (buf[start] !== 0x3c || buf[end - 1] !== 0x3e) throw new Error("el PDF preparado no coincide con el ByteRange");
  buf.write(hex, start + 1, "latin1");
  return new Uint8Array(buf);
}
