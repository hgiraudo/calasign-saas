import "reflect-metadata";
import { createHash, createPrivateKey, privateEncrypt, constants, webcrypto, type KeyObject } from "node:crypto";
import * as x509 from "@peculiar/x509";

/**
 * Interfaz única para cualquier origen de firma: sello de la plataforma (clave local o KMS),
 * certificado del firmante emitido por una CA (Calasign, ICP-Brasil, ONAC…) vía CSC API, etc.
 * El proveedor nunca recibe el documento: solo el digest de los atributos firmados.
 */
export interface SignatureProvider {
  readonly id: string;
  readonly level: "simple" | "advanced" | "qualified";
  /** Cadena en DER: [certificado firmante, intermedias…, raíz opcional]. */
  certificateChain(): Promise<Uint8Array[]>;
  /** Firma RSA PKCS#1 v1.5 sobre un digest SHA-256 ya calculado. */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

// DigestInfo DER prefix para SHA-256 (RFC 8017 §9.2).
const SHA256_DIGEST_INFO_PREFIX = Buffer.from("3031300d060960864801650304020105000420", "hex");
// DigestInfo DER prefix para SHA-1: solo para perfiles heredados que lo exigen (SUNAT CPE).
const SHA1_DIGEST_INFO_PREFIX = Buffer.from("3021300906052b0e03021a05000414", "hex");

/** Clave RSA en PEM (PKCS#8) + cadena en PEM. Para desarrollo y entornos sin KMS. */
export class LocalKeyProvider implements SignatureProvider {
  readonly level = "simple" as const;
  private key: KeyObject;
  private chain: Uint8Array[];

  constructor(
    readonly id: string,
    privateKeyPem: string,
    chainPem: string,
  ) {
    this.key = createPrivateKey(privateKeyPem);
    this.chain = pemToDerList(chainPem);
    if (this.chain.length === 0) throw new Error("cadena de certificados vacía");
  }

  async certificateChain() {
    return this.chain;
  }

  async signDigest(digest: Uint8Array) {
    if (digest.length !== 32) throw new Error("se esperaba un digest SHA-256");
    const digestInfo = Buffer.concat([SHA256_DIGEST_INFO_PREFIX, Buffer.from(digest)]);
    return new Uint8Array(privateEncrypt({ key: this.key, padding: constants.RSA_PKCS1_PADDING }, digestInfo));
  }
  /** Firma RSA PKCS#1 v1.5 sobre un digest SHA-1 (perfiles heredados como SUNAT CPE). */
  async signDigestSha1(digest: Uint8Array) {
    if (digest.length !== 20) throw new Error("se esperaba un digest SHA-1");
    const digestInfo = Buffer.concat([SHA1_DIGEST_INFO_PREFIX, Buffer.from(digest)]);
    return new Uint8Array(privateEncrypt({ key: this.key, padding: constants.RSA_PKCS1_PADDING }, digestInfo));
  }

}

export function pemToDerList(pem: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem))) out.push(new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ""), "base64")));
  return out;
}

export function derToPem(der: Uint8Array, label = "CERTIFICATE"): string {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64.trim()}\n-----END ${label}-----\n`;
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// ───────────────────── Identidades de desarrollo (CA raíz + sello) ─────────────────────

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const RSA_ALG = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 3072,
} as const;

export interface DevCa {
  certPem: string;
  keyPem: string;
}

export async function generateDevRootCa(commonName = "CalaSign Dev Root CA"): Promise<DevCa> {
  const keys = (await webcrypto.subtle.generateKey(RSA_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=${commonName}, O=CalaSign`,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + 10 * 365 * 24 * 3600_000),
    keys,
    signingAlgorithm: RSA_ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { certPem: cert.toString("pem") + "\n", keyPem: derToPem(new Uint8Array(pkcs8), "PRIVATE KEY") };
}

/**
 * Emite el certificado del sello de plataforma firmado por la CA indicada.
 * `subjectPublicKeySpki`: si se pasa (p. ej. la clave pública de KMS), se certifica esa clave
 * y no se devuelve clave privada.
 */
export async function issueSealCertificate(
  ca: DevCa,
  opts: { commonName: string; subjectPublicKeySpki?: Uint8Array; years?: number },
): Promise<{ certPem: string; keyPem: string | null; chainPem: string }> {
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await webcrypto.subtle.importKey(
    "pkcs8",
    pemBody(ca.keyPem),
    RSA_ALG,
    false,
    ["sign"],
  );
  let publicKey: CryptoKey;
  let keyPem: string | null = null;
  if (opts.subjectPublicKeySpki) {
    publicKey = await webcrypto.subtle.importKey("spki", opts.subjectPublicKeySpki, RSA_ALG, true, ["verify"]);
  } else {
    const keys = (await webcrypto.subtle.generateKey(RSA_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    publicKey = keys.publicKey;
    keyPem = derToPem(new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)), "PRIVATE KEY");
  }
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: `CN=${opts.commonName}, O=CalaSign`,
    issuer: caCert.subject,
    notBefore: new Date(now.getTime() - 60_000),
    notAfter: new Date(now.getTime() + (opts.years ?? 3) * 365 * 24 * 3600_000),
    signingKey: caKey,
    publicKey,
    signingAlgorithm: RSA_ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation, true),
      // documentSigning + emailProtection (NSS/pdfsig lo exige para firmas PDF) + Adobe Authentic Documents.
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.36", "1.3.6.1.5.5.7.3.4", "1.2.840.113583.1.1.5"], false),
      await x509.SubjectKeyIdentifierExtension.create(publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
    ],
  });
  const certPem = cert.toString("pem") + "\n";
  return { certPem, keyPem, chainPem: certPem + ca.certPem };
}

function pemBody(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function randomSerial(): string {
  const b = webcrypto.getRandomValues(new Uint8Array(16));
  b[0] &= 0x7f;
  return Buffer.from(b).toString("hex");
}
