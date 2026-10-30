// Huso horario de la organización (tenants.time_zone, migración 0123): las horas del certificado de finalización y la
// fecha de los campos «fecha de firma» se escriben en el huso que configura la cuenta, con su desfase respecto de UTC
// a la vista, para que el PDF no se lea en una hora que no es la de nadie. Sin configurar: UTC (como antes).
import { z } from "zod";

export const DEFAULT_TIME_ZONE = "UTC";

/** ¿Es un huso IANA que entiende Intl (p. ej. "America/Argentina/Buenos_Aires", "UTC")? */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false; // RangeError: huso desconocido
  }
}

let supported: Map<string, string> | null = null;
/** Los husos de Intl.supportedValuesOf, por nombre en minúsculas. */
function supportedZones(): Map<string, string> {
  if (!supported) {
    const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    supported = new Map(list.map((z) => [z.toLowerCase(), z]));
  }
  return supported;
}

/**
 * El huso como se guarda: el nombre que se eligió si Intl lo entiende (se respeta "America/Argentina/Buenos_Aires",
 * aunque la lista de Intl de Node traiga el alias viejo "America/Buenos_Aires"), con las mayúsculas de la lista si
 * coincide salvo por ellas; los nombres de UTC se unifican en "UTC". Inválido: UTC.
 */
export function normalizeTimeZone(tz: unknown): string {
  if (!isValidTimeZone(tz)) return DEFAULT_TIME_ZONE;
  const name = supportedZones().get(tz.trim().toLowerCase()) ?? tz.trim();
  return /^(Etc\/)?(UTC|GMT|UCT|Zulu|Universal)$/i.test(name) ? DEFAULT_TIME_ZONE : name;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsIn(d: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(tz),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const get = (type: string) => Number(f.formatToParts(d).find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Fecha calendario (año, mes, día) de ese instante en el huso. */
export function datePartsInZone(d: Date, tz: string): { year: number; month: number; day: number } {
  const p = partsIn(d, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** Desfase del huso en ese instante, en minutos (Buenos Aires: -180). */
export function utcOffsetMinutes(d: Date, tz: string): number {
  const p = partsIn(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
}

/** "UTC", "UTC−03:00", "UTC+05:30" (con el signo menos tipográfico, como se escribe en los husos). */
export function utcOffsetLabel(d: Date, tz: string): string {
  const m = utcOffsetMinutes(d, tz);
  if (m === 0) return "UTC";
  const a = Math.abs(m);
  return `UTC${m < 0 ? "−" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** "2026-10-29 18:03:12 UTC−03:00": fecha y hora del instante en el huso, con su desfase (el del certificado). */
export function formatDateTimeInZone(d: Date, tz: string): string {
  const p = partsIn(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${utcOffsetLabel(d, tz)}`;
}

/** Configuración general de la organización (GET/PATCH /v1/settings/organization). */
export interface OrganizationSettings {
  /** Huso IANA de las horas del certificado y de la fecha de firma (UTC si no se configuró). */
  timeZone: string;
}

export const UpdateOrganizationSettingsInput = z.object({
  timeZone: z
    .string()
    .trim()
    .max(64)
    .refine(isValidTimeZone, { message: "Huso horario desconocido: usá un nombre IANA, p. ej. America/Argentina/Buenos_Aires" }),
});
export type UpdateOrganizationSettingsInput = z.infer<typeof UpdateOrganizationSettingsInput>;
