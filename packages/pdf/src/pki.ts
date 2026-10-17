// Utilidades de PKI compartidas por LTV (B-LT/B-LTA) y por el validador: certificados, cadenas,
// OCSP y CRL. Todo sobre pkijs con el motor criptográfico de Node.
import { createHash, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as Crypto }));

export const OIDS = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  aia: "1.3.6.1.5.5.7.1.1",
  ocspMethod: "1.3.6.1.5.5.7.48.1",
  caIssuersMethod: "1.3.6.1.5.5.7.48.2",
  crlDp: "2.5.29.31",
  basicOcsp: "1.3.6.1.5.5.7.48.1.1",
};

export const HASH_BY_OID: Record<string, string> = {
  [OIDS.sha1]: "sha1",
  [OIDS.sha256]: "sha256",
  [OIDS.sha384]: "sha384",
  [OIDS.sha512]: "sha512",
};

export function toAB(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export function hash(alg: string, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash(alg).update(data).digest());
}

export function parseCert(der: Uint8Array): pkijs.Certificate {
  return pkijs.Certificate.fromBER(toAB(der));
}

export function certDer(c: pkijs.Certificate): Uint8Array {
  return new Uint8Array(c.toSchema(true).toBER(false));
}

/** Recorta los ceros de relleno del /Contents de una firma (el DER se autodelimita). */
export function trimDer(bytes: Uint8Array): Uint8Array {
  const r = asn1js.fromBER(toAB(bytes));
  if (r.offset === -1) throw new Error("DER inválido");
  return bytes.subarray(0, r.offset);
}

const NAME_OIDS: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "2.5.4.5": "serialNumber",
  "1.2.840.113549.1.9.1": "E",
  "2.5.4.97": "organizationIdentifier",
};

export function nameToString(n: pkijs.RelativeDistinguishedNames): string {
  return n.typesAndValues.map((tv) => `${NAME_OIDS[tv.type] ?? tv.type}=${tv.value.valueBlock.value}`).join(", ");
}

export function commonName(n: pkijs.RelativeDistinguishedNames): string | null {
  const cn = n.typesAndValues.find((tv) => tv.type === "2.5.4.3");
  return cn ? String(cn.value.valueBlock.value) : null;
}

export function serialHex(c: pkijs.Certificate): string {
  return Buffer.from(c.serialNumber.valueBlock.valueHexView).toString("hex");
}

export function fingerprint(der: Uint8Array): string {
  return Buffer.from(hash("sha256", der)).toString("hex");
}

export function isSelfSigned(c: pkijs.Certificate): boolean {
  return c.subject.isEqual(c.issuer);
}

export interface CertUrls {
  ocsp: string[];
  caIssuers: string[];
  crl: string[];
}

function generalNameUris(names: any[]): string[] {
  const out: string[] = [];
  for (const g of names ?? []) if (g?.type === 6 && typeof g.value === "string") out.push(g.value);
  return out;
}

export function certUrls(c: pkijs.Certificate): CertUrls {
  const res: CertUrls = { ocsp: [], caIssuers: [], crl: [] };
  for (const ext of c.extensions ?? []) {
    if (ext.extnID === OIDS.aia && ext.parsedValue?.accessDescriptions) {
      for (const ad of ext.parsedValue.accessDescriptions as pkijs.AccessDescription[]) {
        const uris = generalNameUris([ad.accessLocation]);
        if (ad.accessMethod === OIDS.ocspMethod) res.ocsp.push(...uris);
        if (ad.accessMethod === OIDS.caIssuersMethod) res.caIssuers.push(...uris);
      }
    }
    if (ext.extnID === OIDS.crlDp && ext.parsedValue?.distributionPoints) {
      for (const dp of ext.parsedValue.distributionPoints as pkijs.DistributionPoint[]) {
        if (Array.isArray(dp.distributionPoint)) res.crl.push(...generalNameUris(dp.distributionPoint as any[]));
      }
    }
  }
  return res;
}

export function hasRevocationInfo(certsDer: Uint8Array[]): boolean {
  return certsDer.some((d) => {
    const c = parseCert(d);
    if (isSelfSigned(c)) return false;
    const u = certUrls(c);
    return u.ocsp.length > 0 || u.crl.length > 0;
  });
}

/** Verifica que `cert` esté firmado por `issuer`. */
export async function issuedBy(cert: pkijs.Certificate, issuer: pkijs.Certificate): Promise<boolean> {
  if (!cert.issuer.isEqual(issuer.subject)) return false;
  try {
    return await cert.verify(issuer);
  } catch {
    return false;
  }
}

/** Arma la cadena desde `leaf` usando el pool; termina en un certificado autofirmado o donde no haya emisor. */
export async function buildChain(leaf: pkijs.Certificate, pool: pkijs.Certificate[]): Promise<pkijs.Certificate[]> {
  const chain = [leaf];
  let cur = leaf;
  for (let i = 0; i < 10 && !isSelfSigned(cur); i++) {
    let next: pkijs.Certificate | undefined;
    for (const cand of pool) if (await issuedBy(cur, cand)) { next = cand; break; }
    if (!next) break;
    chain.push(next);
    cur = next;
  }
  return chain;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchOcsp(cert: pkijs.Certificate, issuer: pkijs.Certificate, fetcher: Fetcher = fetch): Promise<Uint8Array | null> {
  for (const url of certUrls(cert).ocsp) {
    try {
      const req = new pkijs.OCSPRequest();
      await req.createForCertificate(cert, { hashAlgorithm: "SHA-1", issuerCertificate: issuer });
      const res = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/ocsp-request" },
        body: Buffer.from(req.toSchema(true).toBER(false)),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const der = new Uint8Array(await res.arrayBuffer());
      const parsed = pkijs.OCSPResponse.fromBER(toAB(der));
      if (parsed.responseStatus.valueBlock.valueDec !== 0) continue;
      return der;
    } catch {
      // probar el siguiente
    }
  }
  return null;
}

export async function fetchCrl(cert: pkijs.Certificate, fetcher: Fetcher = fetch): Promise<Uint8Array | null> {
  for (const url of certUrls(cert).crl) {
    try {
      const res = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      let der = new Uint8Array(await res.arrayBuffer());
      const text = Buffer.from(der.subarray(0, 32)).toString("latin1");
      if (text.startsWith("-----BEGIN")) {
        der = new Uint8Array(Buffer.from(Buffer.from(der).toString("latin1").replace(/-----[^-]+-----|\s+/g, ""), "base64"));
      }
      pkijs.CertificateRevocationList.fromBER(toAB(der));
      return der;
    } catch {
      // probar el siguiente
    }
  }
  return null;
}

export type RevocationStatus = "good" | "revoked" | "unknown";

export interface RevocationResult {
  status: RevocationStatus;
  source: "ocsp" | "crl" | null;
  revokedAt?: string | null;
}

/** Estado según una respuesta OCSP (DER de OCSPResponse) ya obtenida. */
export async function statusFromOcsp(ocspDer: Uint8Array, cert: pkijs.Certificate, issuer: pkijs.Certificate): Promise<RevocationResult | null> {
  try {
    const resp = pkijs.OCSPResponse.fromBER(toAB(ocspDer));
    if (!resp.responseBytes || resp.responseBytes.responseType !== OIDS.basicOcsp) return null;
    const basic = pkijs.BasicOCSPResponse.fromBER(resp.responseBytes.response.valueBlock.valueHexView.slice().buffer);
    const serial = serialHex(cert);
    const single = basic.tbsResponseData.responses.find(
      (r) => Buffer.from(r.certID.serialNumber.valueBlock.valueHexView).toString("hex") === serial,
    );
    if (!single) return null;
    // Firma de la respuesta: por la CA emisora o por un respondedor delegado incluido en la respuesta.
    let sigOk = false;
    try {
      sigOk = await basic.verify({ trustedCerts: [issuer] });
    } catch {
      sigOk = false;
    }
    if (!sigOk) sigOk = await verifyWithIssuerKey(basic, issuer);
    if (!sigOk) return null;
    const st = single.certStatus as any;
    const tag = st?.idBlock?.tagNumber;
    if (tag === 0) return { status: "good", source: "ocsp" };
    if (tag === 1) return { status: "revoked", source: "ocsp", revokedAt: null };
    return { status: "unknown", source: "ocsp" };
  } catch {
    return null;
  }
}

/** Respondedor = la propia CA emisora (RSA/SHA-256): verificación directa de la firma de la respuesta. */
async function verifyWithIssuerKey(basic: pkijs.BasicOCSPResponse, issuer: pkijs.Certificate): Promise<boolean> {
  try {
    const tbs: Uint8Array = (basic.tbsResponseData as any).tbsView ?? new Uint8Array(basic.tbsResponseData.toSchema(true).toBER(false));
    const key = await webcrypto.subtle.importKey(
      "spki",
      issuer.subjectPublicKeyInfo.toSchema().toBER(false),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await webcrypto.subtle.verify("RSASSA-PKCS1-v1_5", key, basic.signature.valueBlock.valueHexView, tbs);
  } catch {
    return false;
  }
}

export async function statusFromCrl(crlDer: Uint8Array, cert: pkijs.Certificate, issuer: pkijs.Certificate): Promise<RevocationResult | null> {
  try {
    const crl = pkijs.CertificateRevocationList.fromBER(toAB(crlDer));
    if (!crl.issuer.isEqual(issuer.subject)) return null;
    if (!(await crl.verify({ issuerCertificate: issuer }))) return null;
    const serial = serialHex(cert);
    const hit = (crl.revokedCertificates ?? []).find((r) => Buffer.from(r.userCertificate.valueBlock.valueHexView).toString("hex") === serial);
    if (hit) return { status: "revoked", source: "crl", revokedAt: hit.revocationDate.value.toISOString() };
    return { status: "good", source: "crl" };
  } catch {
    return null;
  }
}

/** Los certificados dentro de un SignedData (CMS) en DER. */
export function cmsCertificates(sd: pkijs.SignedData): pkijs.Certificate[] {
  return (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
}

export function parseSignedData(der: Uint8Array): pkijs.SignedData {
  const ci = pkijs.ContentInfo.fromBER(toAB(trimDer(der)));
  if (ci.contentType !== OIDS.signedData) throw new Error("no es SignedData");
  return new pkijs.SignedData({ schema: ci.content });
}

/** El signatureTimeStampToken de un SignerInfo, si tiene. */
export function signatureTimestamp(sd: pkijs.SignedData): pkijs.SignedData | null {
  const attr = sd.signerInfos[0]?.unsignedAttrs?.attributes.find((a) => a.type === OIDS.signatureTimeStampToken);
  if (!attr) return null;
  const ci = new pkijs.ContentInfo({ schema: attr.values[0] });
  return new pkijs.SignedData({ schema: ci.content });
}

export function tstInfoOf(token: pkijs.SignedData): pkijs.TSTInfo {
  const ec = token.encapContentInfo.eContent;
  if (!ec) throw new Error("token sin TSTInfo");
  return pkijs.TSTInfo.fromBER(ec.getValue().slice(0));
}

export function signerCertOf(sd: pkijs.SignedData): pkijs.Certificate | null {
  const si = sd.signerInfos[0];
  const certs = cmsCertificates(sd);
  if (si.sid instanceof pkijs.IssuerAndSerialNumber) {
    const sid = si.sid;
    return certs.find((c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber)) ?? null;
  }
  return certs[0] ?? null;
}

export { asn1js, pkijs };
