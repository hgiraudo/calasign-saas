// Tipos del Firmador CalaSign. El protocolo es el de /v1/certsign (packages/shared/src/certsign.ts); se duplica
// acá lo mínimo para que el binario no dependa del monorepo.

export type SignatureAlgorithm = "RSASSA-PKCS1-v1_5" | "ECDSA";

export interface SessionInfo {
  status: string;
  expiresAt: string;
  organizationName: string;
  envelopeSubject: string;
  signerName: string;
  idDocument: string | null;
  documentSha256: string;
  documentPages: number;
  requirements: { matchIdDocument: boolean; allowedIssuers: string[]; requireQualified: boolean };
}

export interface Prepared {
  digestToSign: string;
  dataToSign: string;
  signatureAlgorithm: SignatureAlgorithm;
  namedCurve: string | null;
  certificate: { subject: string; issuer: string; commonName: string | null; serialNumber: string; notBefore: string; notAfter: string; sha256: string; trusted: boolean };
  warnings: string[];
}

export interface SignResult {
  status: "completed";
  signedPdfSha256: string;
  envelopeStatus: string;
}

/** Un certificado disponible en alguna fuente (token, Windows, archivo). */
export interface CertEntry {
  /** Identificador dentro de la fuente (thumbprint, CKA_ID, índice). */
  id: string;
  label: string;
  subject: string;
  issuer: string;
  notAfter: string;
  /** Cadena DER: el certificado del titular primero. */
  chainDer: Uint8Array[];
}

/** Lo que hay que firmar: datos (para fuentes que hashean) y su SHA-256 (para fuentes que firman un hash). */
export interface ToSign {
  data: Uint8Array;
  digest: Uint8Array;
  algorithm: SignatureAlgorithm;
}

export interface CertSource {
  readonly kind: "pkcs11" | "windows" | "p12";
  list(): Promise<CertEntry[]>;
  /** Devuelve la firma: RSA PKCS#1 v1.5, o ECDSA (DER o r||s, el servidor acepta las dos). */
  sign(entry: CertEntry, x: ToSign): Promise<Uint8Array>;
  close?(): Promise<void>;
}
