// Contrato del bloque "firmante y evidencia": OTP, aprobador, delegación/reasignación,
// recordatorios automáticos y verificación pública. Sin dependencias de api.ts (api.ts importa de acá).
import { z } from "zod";

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

export const OtpVerifyInput = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
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
};

export const DelegateInput = z
  .object({ ...Contact, reason: z.string().trim().min(1).max(1000) })
  .refine((d) => d.email || d.phone, { message: "email o phone requerido" });
export type DelegateInput = z.infer<typeof DelegateInput>;

export const ReassignInput = z
  .object({
    ...Contact,
    channels: z.array(z.enum(["email", "whatsapp", "telegram"])).min(1).optional(),
    locale: z.enum(["es", "pt-BR", "en"]).optional().nullable(),
    reason: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((d) => d.email || d.phone, { message: "email o phone requerido" });
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
  chain?: { ok: boolean; events: number; head: string };
}
