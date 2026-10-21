// Firma con certificado propio del firmante (token, almacén de Windows o archivo .p12) mediante el Firmador CalaSign.
import { z } from "zod";

export const SIGNATURE_TYPES = ["electronic", "certificate"] as const;
export type SignatureType = (typeof SIGNATURE_TYPES)[number];

export const CertificateRequirementsInput = z.object({
  /** El certificado tiene que corresponder al documento declarado del firmante. Por defecto no (false): solo si se pide y el destinatario tiene número de documento. */
  matchIdDocument: z.boolean().optional(),
  /** Partes del DN del emisor permitidas (ej. "ICP-Brasil", "RENIEC"). Vacío = cualquiera. */
  allowedIssuers: z.array(z.string().trim().min(2).max(200)).max(10).optional(),
  /** Exigir que el certificado provenga de una CA del almacén de confianza de la plataforma. */
  requireQualified: z.boolean().optional(),
});
export type CertificateRequirementsInput = z.infer<typeof CertificateRequirementsInput>;

export interface CertificateRequirements {
  matchIdDocument: boolean;
  allowedIssuers: string[];
  requireQualified: boolean;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  commonName: string | null;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  sha256: string;
  trusted: boolean;
}

/** Estado de la firma con certificado de un destinatario. */
export interface RecipientCertificateSignature {
  status: "pending" | "signed";
  position: number;
  signedAt: string | null;
  commonName: string | null;
  issuer: string | null;
}

/** Bloque de la sesión del firmante cuando el sobre espera firmas con certificado. */
export interface SigningCertificateStep {
  /** waiting: firma otro antes; your_turn: tiene que firmar ahora; signed: ya firmó. */
  status: "waiting" | "your_turn" | "signed";
  position: number;
  total: number;
  signedCount: number;
  requirements: CertificateRequirements;
  certificate: CertificateSummary | null;
}

export interface CertsignPairing {
  /** Código de un solo uso para el Firmador (10 minutos). */
  code: string;
  /** calasign-firmador://sign?api=…&code=… */
  deepLink: string;
  apiBase: string;
  expiresAt: string;
}

// ───────── Protocolo del Firmador (firma remota de un hash) ─────────

export interface CertsignSessionInfo {
  status: "created" | "prepared" | "completed" | "failed" | "expired";
  expiresAt: string;
  organizationName: string;
  envelopeSubject: string;
  signerName: string;
  idDocument: string | null;
  /** SHA-256 del PDF que se va a firmar. */
  documentSha256: string;
  documentPages: number;
  requirements: CertificateRequirements;
}

export const CertsignCertificateInput = z.object({
  /** Cadena en PEM o base64 DER: el certificado del firmante primero. */
  chain: z.array(z.string().min(100).max(20_000)).min(1).max(8),
});
export type CertsignCertificateInput = z.infer<typeof CertsignCertificateInput>;

export interface CertsignPrepared {
  /** SHA-256 de los atributos firmados (base64): lo que firma un token o el almacén de Windows. */
  digestToSign: string;
  /** Atributos firmados en DER (base64): lo que firma una clave en archivo (sign con SHA-256). */
  dataToSign: string;
  signatureAlgorithm: "RSASSA-PKCS1-v1_5" | "ECDSA";
  namedCurve: string | null;
  certificate: CertificateSummary;
  warnings: string[];
}

export const CertsignSignatureInput = z.object({
  /** Firma en base64: RSA PKCS#1 v1.5, o ECDSA en DER o r||s. */
  signature: z.string().min(40).max(4096),
});
export type CertsignSignatureInput = z.infer<typeof CertsignSignatureInput>;

export interface CertsignResult {
  status: "completed";
  signedPdfSha256: string;
  /** Sobre: sigue esperando otras firmas con certificado o ya pasó a sellarse. */
  envelopeStatus: string;
}

/** Progreso del sobre (detalle del remitente). */
export interface EnvelopeCertificateProgress {
  signers: {
    recipientId: string;
    name: string;
    position: number;
    status: "pending" | "signed";
    commonName: string | null;
    issuer: string | null;
    serialNumber: string | null;
    signedAt: string | null;
  }[];
}

export interface FirmadorDownload {
  platform: "windows-x64" | "linux-x64" | "macos-arm64" | "macos-x64";
  file: string;
  sizeBytes: number;
  sha256: string;
  url: string;
}
