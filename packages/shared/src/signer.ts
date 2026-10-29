// Contrato del bloque "firmante y evidencia": OTP, aprobador, delegación/reasignación,
// recordatorios automáticos y verificación pública. Sin dependencias de api.ts (api.ts importa de acá).
import { z } from "zod";

/** cedula (RD, CO), cpf (BR), dni (HN, PE), ce = carné de extranjería (PE, CO), passport, other. */
export const ID_DOCUMENT_TYPES = ["cedula", "cpf", "dni", "passport", "other", "ce"] as const;

/** Cómo se autentica el destinatario antes de ver los documentos. */
export const AUTH_METHODS = ["link", "otp_email", "otp_sms", "otp_whatsapp", "in_person"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Configuración de recordatorios y delegación del sobre (se agrega a Create/UpdateEnvelopeInput). */
export const EnvelopeReminderSettings = {
  /** Recordatorio automático cada N días a los pendientes del grupo actual (null = desactivado). */
  reminderEveryDays: z.number().int().min(1).max(60).optional().nullable(),
  /** Aviso N días antes del vencimiento (null = desactivado). */
  expiryWarningDays: z.number().int().min(1).max(60).optional().nullable(),
  /** Si el firmante puede delegar en otra persona. */
  allowDelegation: z.boolean().optional(),
};

// ───────────── OTP ─────────────

export const OtpVerifyInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/),
});
export type OtpVerifyInput = z.infer<typeof OtpVerifyInput>;

export interface OtpSendResponse {
  sent: true;
  destination: string;
  /** Segundos hasta poder pedir otro código. */
  resendInSeconds: number;
  expiresAt: string;
}

// ───────────── Delegación y reasignación ─────────────

const Contact = {
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/)
    .optional()
    .nullable(),
  /**
   * Número de documento de la persona nueva. Si el firmante original debía firmar con un certificado que corresponda a
   * su documento (matchIdDocument), la delegación lo exige (409 delegation_requires_id_match) y el control se mantiene.
   */
  idDocumentNumber: z.string().trim().max(50).optional().nullable(),
  /** Tipo de ese documento (DNI, CPF…). No se hereda del firmante original: sin indicarlo, queda sin tipo. */
  idDocumentType: z.enum(ID_DOCUMENT_TYPES).optional().nullable(),
};

export const DelegateInput = z
  .object({ ...Contact, reason: z.string().trim().min(1).max(1000) })
  .refine((d) => d.email || d.phone, { message: "email o phone requerido" });
export type DelegateInput = z.infer<typeof DelegateInput>;

export const ReassignInput = z
  .object({
    ...Contact,
    channels: z
      .array(z.enum(["email", "whatsapp", "telegram"]))
      .min(1)
      .optional(),
    locale: z.enum(["es", "pt-BR", "en"]).optional().nullable(),
    reason: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((d) => d.email || d.phone, { message: "email o phone requerido" })
  // El reemplazo nace sin chat de Telegram vinculado: con solo ese canal no le llegaba la invitación (y no daba error).
  .refine((d) => !d.channels || d.channels.some((c) => c !== "telegram"), {
    message: "con solo Telegram no le llega la invitación: agregá email o WhatsApp (el link de vinculación va por ahí)",
  });
export type ReassignInput = z.infer<typeof ReassignInput>;

// ───────────── Verificación pública ─────────────

export interface VerifyResponse {
  match: boolean;
  sha256: string;
  envelope?: {
    id: string;
    subject: string;
    organizationName: string;
    completedAt: string | null;
  };
  participants?: { name: string; role: string; signedAt: string | null }[];
  seal?: { format: string | null; provider: string | null; timestamped: boolean };
  /**
   * ok: la cadena recalculada está íntegra y contiene el hash final impreso en el certificado del PDF. reason: por qué
   * no (cadena rota, el hash del certificado no está en la cadena, o no se pudo leer del PDF ni de la evidencia).
   */
  chain?: { ok: boolean; events: number; head: string; reason?: "chain_broken" | "certificate_head_mismatch" | "certificate_head_missing" };
  /** Qué versión del PDF final coincidió (las renovaciones de archivo B-LTA generan versiones nuevas). */
  version?: { number: number; latest: number; isLatest: boolean; reason: "completed" | "archive_renewal"; createdAt: string | null };
}

/**
 * Fecha de firma tal como se guarda en el campo (dd/mm/aaaa, o aaaa-mm-dd en inglés), en UTC. El valor guardado no
 * lleva sufijo (es el que devuelven la API, las exportaciones y los webhooks, como siempre); al estampar en el PDF y en
 * la vista previa del firmante se le agrega " UTC" (signingDateForDisplay): cerca de la medianoche la fecha UTC no es
 * la local del firmante y sin decirlo parecía la local. No hay zona horaria por organización ni por firmante, y la del
 * navegador no sirve como evidencia (la elige el cliente).
 */
export function formatSigningDate(d: Date, locale: string) {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return locale === "en" ? `${yyyy}-${mm}-${dd}` : `${dd}/${mm}/${yyyy}`;
}

/** Fecha de firma guardada → texto visible (PDF, vista previa): con " UTC" (sin duplicarlo en valores que ya lo traen). */
export function signingDateForDisplay(value: string): string {
  const v = value.trim();
  return !v || /\bUTC$/.test(v) ? v : `${v} UTC`;
}
