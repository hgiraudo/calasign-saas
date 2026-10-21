// Datos: BYOK (clave KMS del cliente), celdas de residencia de datos, renovación de sellos de archivo y
// verificación de dominios SSO.
import { z } from "zod";

// ───────────────────────────── BYOK ─────────────────────────────

export const BYOK_STATUSES = ["none", "active", "failing"] as const;
export type ByokStatus = (typeof BYOK_STATUSES)[number];

/** ARN de una clave KMS simétrica (puede ser de otra cuenta de AWS). */
export const KMS_KEY_ARN_RE = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]{1,128}$/;

export const SetByokInput = z.object({
  keyArn: z.string().trim().regex(KMS_KEY_ARN_RE, "ARN de clave KMS inválido (arn:aws:kms:<región>:<cuenta>:key/<id>)"),
});
export type SetByokInput = z.infer<typeof SetByokInput>;

export interface ByokSettings {
  status: ByokStatus;
  keyArn: string | null;
  checkedAt: string | null;
  enabledAt: string | null;
  error: string | null;
  /** Rol de la plataforma que la clave tiene que autorizar. */
  platformPrincipal: string;
  /** Política (statements) a agregar en la clave del cliente. */
  keyPolicy: Record<string, unknown>;
  /** Celda (región) de los datos: la clave tiene que estar en esa región. */
  region: string;
  /**
   * Solo en la respuesta de PUT/DELETE: aviso de que lo guardado antes del cambio sigue cifrado con la clave anterior
   * (no se re-cifra). null si no hubo clave anterior.
   */
  notice?: string | null;
}

export interface ByokTestResult {
  ok: boolean;
  status: ByokStatus;
  checks: { name: string; ok: boolean; detail?: string }[];
  error: string | null;
}

// ───────────────────────────── Celdas ─────────────────────────────

export interface CellInfo {
  id: string;
  label: string;
  region: string | null;
  /** false: se muestra como «Próximamente». */
  available: boolean;
  default: boolean;
}

export interface CellsResponse {
  items: CellInfo[];
}

// ───────────────────────────── Archivo ─────────────────────────────

export interface SignedVersion {
  version: number;
  reason: "completed" | "archive_renewal";
  sha256: string;
  validUntil: string | null;
  createdAt: string;
}

export interface ArchiveInfo {
  validUntil: string | null;
  checkedAt: string | null;
  renewals: number;
  error: string | null;
  /** Error conocido, para mostrarlo traducido: tsa_cannot_extend = la TSA configurada no puede extender la validez. */
  errorCode?: "tsa_cannot_extend" | null;
  versions: SignedVersion[];
}

// ───────────────────────────── Dominios SSO ─────────────────────────────

export interface SsoDomainStatus {
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  txtName: string;
  txtValue: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}
