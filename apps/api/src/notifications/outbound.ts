// Envío registrado de un aviso: supresión de direcciones (rebotes/quejas), un solo envío por job y destino aunque el
// job se reintente, y errores sin datos personales (terminan en logs y en jobs.last_error).
import type { Db } from "../infra/db";
import { maskDestination, uuidv7 } from "../lib/util";
import { deliver, type OutboundMessage, type SendResult } from "./channels";

/** Dirección normalizada para la supresión. */
export const normAddress = (a: string) => a.trim().toLowerCase();

/** Si la dirección está suprimida (rebote permanente o queja): no se le escribe más. */
export async function isSuppressed(db: Db, address: string): Promise<boolean> {
  if (!address) return false;
  return Boolean(await db.one(`SELECT 1 FROM email_suppressions WHERE address = $1`, [normAddress(address)]));
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

/** Texto de un error sin direcciones de correo ni teléfonos (enmascarados). */
export function scrubPii(s: string): string {
  return s.replace(EMAIL_RE, (m) => maskDestination(m)).replace(PHONE_RE, (m) => maskDestination(m.replace(/[^\d+]/g, "")));
}

export type TrackedResult =
  | { status: "sent"; res: SendResult; id: string }
  | { status: "already" }
  | { status: "suppressed" }
  | { status: "failed"; error: string };

export interface TrackedSend {
  tenantId: string;
  envelopeId?: string | null;
  recipientId?: string | null;
  /** Plantilla o evento (invite, reminder, agreement_expiry…). */
  template: string;
  /** Job que lo envía: con él, un reintento no repite lo que ya salió para el mismo canal y destino. */
  jobId?: number | null;
  log?: { error(o: object, m?: string): void };
}

/**
 * Envía y registra en `notifications`. Correo a una dirección suprimida: no sale (fila 'suppressed'). Ya enviado por
 * este job al mismo canal y destino: no sale otra vez. El registro posterior al envío nunca lo convierte en fallido.
 */
export async function sendTracked(db: Db, t: TrackedSend, m: OutboundMessage & { cta?: string | null }): Promise<TrackedResult> {
  if (t.jobId != null) {
    const done = await db.one(
      `SELECT 1 FROM notifications WHERE job_id = $1 AND channel = $2 AND destination = $3 AND status IN ('sent','bounced','complained','suppressed') LIMIT 1`,
      [t.jobId, m.channel, m.to],
    );
    if (done) return { status: "already" };
  }
  const id = uuidv7();
  const row = (status: string, extra: { provider?: string | null; messageId?: string | null; error?: string | null } = {}) =>
    db
      .query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, provider, provider_message_id, error, job_id, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $8 = 'sent' THEN now() END)`,
        [
          id,
          t.tenantId,
          t.envelopeId ?? null,
          t.recipientId ?? null,
          m.channel,
          t.template,
          m.to,
          status,
          extra.provider ?? null,
          extra.messageId ?? null,
          extra.error ?? null,
          t.jobId ?? null,
        ],
      )
      .catch((e) => t.log?.error({ err: scrubPii(String(e)), template: t.template, channel: m.channel }, "no se pudo registrar el aviso"));
  if (m.channel === "email" && (await isSuppressed(db, m.to))) {
    await row("suppressed", { error: "dirección suprimida (rebote permanente o queja)" });
    return { status: "suppressed" };
  }
  let res: SendResult;
  try {
    res = await deliver(m);
  } catch (err) {
    const error = scrubPii(String(err)).slice(0, 1000);
    await row("failed", { error });
    return { status: "failed", error };
  }
  await row("sent", { provider: res.provider, messageId: res.messageId });
  return { status: "sent", res, id };
}
