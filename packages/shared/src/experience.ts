// Contrato del bloque "experiencia" (Fase 4): firma en persona, correcciones en vuelo, reportes y copias.
// No importa valores de api.ts (api.ts importa de acá): solo tipos.
import { z } from "zod";
import type { FieldInput, RecipientInput } from "./api";

// ───────────── Firma en persona (modo anfitrión) ─────────────

/** El destinatario firma en el dispositivo del anfitrión: no recibe invitaciones. */
export const InPersonInput = z.object({
  /** Usuario de la organización que presenta al firmante. Por defecto, quien carga el sobre. */
  hostUserId: z.string().uuid().optional().nullable(),
});
export type InPersonInput = z.infer<typeof InPersonInput>;

export interface InPersonHost {
  id: string;
  name: string;
}

export interface InPersonSessionResponse {
  /** Ruta relativa de la página del firmante, para abrir en el mismo navegador del anfitrión. */
  url: string;
  expiresAt: string;
}

export const InPersonConfirmInput = z.object({
  /** El firmante confirma que es la persona indicada. */
  confirmed: z.literal(true),
  /** Número de documento declarado en el momento (opcional; queda en la evidencia). */
  idDocumentNumber: z.string().trim().max(50).optional().nullable(),
});
export type InPersonConfirmInput = z.infer<typeof InPersonConfirmInput>;

/** Información de la sesión en persona que ve el firmante. */
export interface SigningInPerson {
  hostName: string;
  /** true cuando el firmante ya confirmó su identidad en el dispositivo. */
  identityConfirmed: boolean;
  /** true si el anfitrión abrió la sesión en este navegador. */
  active: boolean;
}

// ───────────── Correcciones en vuelo ─────────────

const E164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/);

export const RecipientContactPatch = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().toLowerCase().email().max(320).optional().nullable(),
  phone: E164.optional().nullable(),
  channels: z.array(z.enum(["email", "whatsapp", "telegram"])).min(1).optional(),
  locale: z.enum(["es", "pt-BR", "en"]).optional().nullable(),
});
export type RecipientContactPatch = z.infer<typeof RecipientContactPatch>;

const CorrectEnvelopeSchema = z.object({
  message: z.string().max(5000).optional().nullable(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  /** Cambios de datos de contacto: el link anterior se revoca y se envía uno nuevo. */
  updateRecipients: z.array(RecipientContactPatch).max(50).optional(),
  /** Destinatarios nuevos (mismo formato que PUT /recipients). Solo en grupos de ruteo que no empezaron. */
  addRecipients: z.array(z.unknown()).max(20).optional(),
  /** Solo destinatarios que todavía no abrieron el sobre. */
  removeRecipientIds: z.array(z.string().uuid()).max(50).optional(),
  /** Campos nuevos (mismo formato que PUT /fields) para destinatarios que todavía no abrieron el sobre. */
  addFields: z.array(z.unknown()).max(500).optional(),
  removeFieldIds: z.array(z.string().uuid()).max(500).optional(),
  /** Motivo de la corrección (queda en la evidencia). */
  reason: z.string().trim().max(1000).optional().nullable(),
});
export const CorrectEnvelopeInput = CorrectEnvelopeSchema;
export type CorrectEnvelopeInput = Omit<z.input<typeof CorrectEnvelopeSchema>, "addRecipients" | "addFields"> & {
  addRecipients?: RecipientInput[];
  addFields?: FieldInput[];
};

// ───────────── Reportes ─────────────

export interface ReportsMonth {
  /** YYYY-MM */
  month: string;
  created: number;
  draft: number;
  inProgress: number;
  completed: number;
  declined: number;
  voided: number;
  expired: number;
}

export interface ReportsSummary {
  from: string;
  to: string;
  /** Zona horaria (IANA) de los meses de byMonth: la pedida con ?tz= o UTC. */
  timeZone: string;
  totals: {
    created: number;
    sent: number;
    completed: number;
    declined: number;
    voided: number;
    expired: number;
    /** En curso ahora (sent + finalizing), sin importar el rango. */
    inProgress: number;
    /** Completados / enviados en el rango (0..1). null si no hubo envíos. */
    completionRate: number | null;
    /** Horas promedio entre envío y finalización de los completados en el rango. */
    avgHoursToComplete: number | null;
  };
  byMonth: ReportsMonth[];
  topSenders: { userId: string | null; name: string; email: string | null; sent: number; completed: number }[];
  notifications: { channel: string; sent: number; failed: number }[];
}

// ───────────── Copias ─────────────

export interface CopyQueuedResponse {
  queued: true;
  recipientId: string;
}
