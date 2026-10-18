import type { CertificateRequirements } from "@calasign/shared";

/** Requisitos del certificado de un firmante, con los valores por defecto aplicados. */
export function normalizeRequirements(raw: any, hasIdDocument: boolean): CertificateRequirements {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    matchIdDocument: typeof r.matchIdDocument === "boolean" ? r.matchIdDocument : hasIdDocument,
    allowedIssuers: Array.isArray(r.allowedIssuers) ? r.allowedIssuers.filter((x: unknown) => typeof x === "string") : [],
    requireQualified: r.requireQualified === true,
  };
}
