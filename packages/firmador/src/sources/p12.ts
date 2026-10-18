// Certificado en archivo .p12/.pfx: se abre con la contraseña y la clave queda solo en memoria.
import { X509Certificate, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import forge from "node-forge";
import type { CertEntry, CertSource, ToSign } from "../types";

export interface P12Contents {
  key: KeyObject;
  chainDer: Uint8Array[];
}

/** Abre un PKCS#12 (AES moderno o 3DES heredado; claves RSA o EC). */
export function openP12(bytes: Uint8Array, password: string): P12Contents {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(bytes).toString("binary")), false, password);
  } catch (e) {
    throw new Error(/mac|password|invalid/i.test(String(e)) ? "Contraseña incorrecta o archivo dañado" : `No se pudo abrir el archivo: ${(e as Error).message}`);
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const kb = keyBags[0];
  if (!kb) throw new Error("El archivo no tiene clave privada");
  // RSA: forge la decodifica; EC: queda el PrivateKeyInfo (PKCS#8) en ASN.1, que Node sí entiende.
  const pkcs8Der = kb.key
    ? forge.asn1.toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(kb.key as forge.pki.rsa.PrivateKey))).getBytes()
    : kb.asn1
      ? forge.asn1.toDer(kb.asn1).getBytes()
      : null;
  if (!pkcs8Der) throw new Error("No se pudo leer la clave privada");
  const key = createPrivateKey({ key: Buffer.from(pkcs8Der, "binary"), format: "der", type: "pkcs8" });

  const certs: Uint8Array[] = [];
  for (const cb of p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []) {
    if (cb.cert) {
      certs.push(new Uint8Array(Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cb.cert)).getBytes(), "binary")));
      continue;
    }
    // Certificado que forge no decodifica (clave pública EC): según la versión, guarda el ASN.1 del certificado
    // o el del CertBag. Se acepta lo que Node pueda leer como X.509.
    for (const cand of [cb.asn1, cb.asn1 ? extractCertAsn1(cb.asn1) : null]) {
      if (!cand) continue;
      const der = new Uint8Array(Buffer.from(forge.asn1.toDer(cand).getBytes(), "binary"));
      try {
        new X509Certificate(Buffer.from(der));
        certs.push(der);
        break;
      } catch {
        // probar la otra forma
      }
    }
  }
  if (!certs.length) throw new Error("El archivo no tiene certificados");
  // Ordena: primero el que corresponde a la clave, después su cadena.
  const pub = createPublicKey(key).export({ format: "der", type: "spki" });
  const leafIdx = certs.findIndex((c) => new X509Certificate(Buffer.from(c)).publicKey.export({ format: "der", type: "spki" }).equals(pub));
  if (leafIdx < 0) throw new Error("Ningún certificado corresponde a la clave privada");
  const leaf = certs[leafIdx];
  const rest = certs.filter((_, i) => i !== leafIdx);
  return { key, chainDer: orderChain(leaf, rest) };
}

/** certBag con certificado que forge no pudo decodificar (p. ej. clave pública EC): se toma el DER del bag. */
function extractCertAsn1(bagAsn1: forge.asn1.Asn1): forge.asn1.Asn1 | null {
  // CertBag ::= SEQUENCE { certId OID, certValue [0] EXPLICIT OCTET STRING (DER del certificado) }
  try {
    const value = (bagAsn1.value as forge.asn1.Asn1[])[1];
    const octet = (value.value as forge.asn1.Asn1[])[0];
    return forge.asn1.fromDer(octet.value as string);
  } catch {
    return null;
  }
}

function orderChain(leaf: Uint8Array, pool: Uint8Array[]): Uint8Array[] {
  const out = [leaf];
  let cur = new X509Certificate(Buffer.from(leaf));
  const left = [...pool];
  for (let i = 0; i < 8 && left.length; i++) {
    const idx = left.findIndex((c) => {
      const x = new X509Certificate(Buffer.from(c));
      return cur.checkIssued(x) && x.subject !== cur.subject;
    });
    if (idx < 0) break;
    out.push(left[idx]);
    cur = new X509Certificate(Buffer.from(left[idx]));
    left.splice(idx, 1);
  }
  return out;
}

/** Firma con la clave del archivo: los datos (atributos firmados) con SHA-256. */
export function signWithKey(key: KeyObject, x: ToSign): Uint8Array {
  return new Uint8Array(cryptoSign("sha256", Buffer.from(x.data), x.algorithm === "ECDSA" ? { key, dsaEncoding: "der" } : key));
}

export class P12Source implements CertSource {
  readonly kind = "p12" as const;
  private contents: P12Contents;
  constructor(
    readonly path: string,
    password: string,
  ) {
    this.contents = openP12(new Uint8Array(readFileSync(path)), password);
  }
  static fromBytes(bytes: Uint8Array, password: string, label = "certificado.p12"): P12Source {
    const s = Object.create(P12Source.prototype) as P12Source;
    Object.assign(s, { kind: "p12", path: label, contents: openP12(bytes, password) });
    return s;
  }
  async list(): Promise<CertEntry[]> {
    const c = new X509Certificate(Buffer.from(this.contents.chainDer[0]));
    return [{ id: "0", label: this.path, subject: c.subject.replace(/\n/g, ", "), issuer: c.issuer.replace(/\n/g, ", "), notAfter: new Date(c.validTo).toISOString(), chainDer: this.contents.chainDer }];
  }
  async sign(_entry: CertEntry, x: ToSign): Promise<Uint8Array> {
    return signWithKey(this.contents.key, x);
  }
}
