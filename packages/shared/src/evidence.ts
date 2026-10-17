// Contrato de evidencia fuerte (Fase 5): niveles PAdES, validación de firmas, certificados de la
// organización, firma XML (facturación electrónica), sello de empresa y conectores de firma.
import { z } from "zod";

export const SEAL_LEVELS = ["auto", "B-B", "B-T", "B-LT", "B-LTA"] as const;
export type SealLevelSetting = (typeof SEAL_LEVELS)[number];

export const SIGNATURE_LEVELS = ["simple", "advanced", "qualified"] as const;
export type SignatureLevel = (typeof SIGNATURE_LEVELS)[number];

export const XML_PROFILES = ["dgii-ecf", "dian-fe", "xades-bes", "xades-epes"] as const;
export type XmlProfileName = (typeof XML_PROFILES)[number];

// ───────────── Ajustes de evidencia ─────────────

export const UpdateEvidenceSettingsInput = z.object({ sealLevel: z.enum(SEAL_LEVELS) });
export type UpdateEvidenceSettingsInput = z.infer<typeof UpdateEvidenceSettingsInput>;

export interface EvidenceSettings {
  sealLevel: SealLevelSetting;
  /** Nivel que se aplicaría hoy con la configuración del entorno (resuelve "auto"). */
  effectiveLevel: "B-B" | "B-T" | "B-LT" | "B-LTA";
  tsaConfigured: boolean;
}

// ───────────── Certificados de la organización ─────────────

export const CERTIFICATE_USAGES = ["xml", "pdf_seal"] as const;

export const UploadCertificateInput = z.object({
  name: z.string().trim().min(1).max(120),
  /** Archivo .p12/.pfx en base64. */
  p12Base64: z.string().min(16).max(2_000_000),
  password: z.string().max(200),
  usages: z.array(z.enum(CERTIFICATE_USAGES)).min(1).optional(),
});
export type UploadCertificateInput = z.infer<typeof UploadCertificateInput>;

export interface TenantCertificate {
  id: string;
  name: string;
  subject: string;
  issuer: string;
  commonName: string | null;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  sha256: string;
  keyAlgorithm: string;
  usages: string[];
  chainLength: number;
  createdAt: string;
  lastUsedAt: string | null;
  expired: boolean;
}

// ───────────── Firma XML ─────────────

export const XmlSignInput = z.object({
  xml: z.string().min(10).max(5_000_000),
  profile: z.enum(XML_PROFILES),
  certificateId: z.string().uuid(),
  /** Política propia (XAdES-EPES); DIAN trae la v2 por defecto. */
  policy: z
    .object({ identifier: z.string().url(), hashBase64: z.string().min(20).max(200), description: z.string().max(300).optional(), hashAlgorithm: z.enum(["sha256", "sha512"]).optional() })
    .optional()
    .nullable(),
  signerRole: z.string().max(100).optional().nullable(),
});
export type XmlSignInput = z.infer<typeof XmlSignInput>;

export const XmlVerifyInput = z.object({ xml: z.string().min(10).max(5_000_000) });

export interface XmlVerification {
  valid: boolean;
  signatureValid: boolean;
  references: { uri: string; type: string | null; valid: boolean }[];
  signer: { subject: string; issuer: string; serialNumber: string; notAfter: string } | null;
  xades: { signingTime: string | null; signingCertificateMatches: boolean | null; policyIdentifier: string | null; signerRole: string | null } | null;
  errors: string[];
}

export interface XmlSignResponse {
  signedXml: string;
  sha256: string;
  verification: XmlVerification;
}

// ───────────── Sello de empresa y nivel de firma por sobre ─────────────

export const SealOptionsInput = z.object({
  companySealCertificateId: z.string().uuid().nullable().optional(),
  signatureLevel: z.enum(SIGNATURE_LEVELS).optional(),
});
export type SealOptionsInput = z.infer<typeof SealOptionsInput>;

export interface SealOptions {
  companySealCertificateId: string | null;
  companySeal: { name: string; commonName: string | null } | null;
  signatureLevel: SignatureLevel;
}

// ───────────── Validación de PDF ─────────────

export interface PdfValidationCert {
  subject: string;
  issuer: string;
  commonName: string | null;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  sha256: string;
}

export interface PdfValidationSignature {
  index: number;
  fieldName: string | null;
  kind: "signature" | "document_timestamp";
  subFilter: string | null;
  signer: PdfValidationCert | null;
  signingTime: string | null;
  timestamp: { time: string; tsa: string | null; valid: boolean } | null;
  integrity: { valid: boolean; reason?: string };
  coversWholeDocument: boolean;
  modifiedAfter: boolean;
  chain: {
    trusted: boolean;
    anchor: string | null;
    entries: (PdfValidationCert & { revocation: { status: string; source: string | null; revokedAt?: string | null } })[];
  };
  level: "B-B" | "B-T" | "B-LT" | "B-LTA" | null;
}

export interface PdfValidationResponse {
  sha256: string;
  signatures: PdfValidationSignature[];
  dss: { certs: number; ocsps: number; crls: number } | null;
  summary: { count: number; allValid: boolean; allTrusted: boolean; anyRevoked: boolean };
  /** true si se consultó OCSP/CRL online además del DSS. */
  onlineRevocation: boolean;
}

// ───────────── Conectores de firma ─────────────

export interface SignatureProviderInfo {
  id: string;
  type: "platform" | "csc";
  level: SignatureLevel;
  baseUrl: string | null;
  configured: boolean;
}

export interface SignatureProviderTestResult {
  id: string;
  ok: boolean;
  credentials: string[];
  certificate: { subject: string; issuer: string; notAfter: string } | null;
  signatureVerified: boolean;
  error: string | null;
}
