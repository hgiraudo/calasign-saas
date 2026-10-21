// Envío registrado de un aviso: supresión de direcciones (rebotes/quejas), un solo envío por job y destino aunque el
// job se reintente, y errores sin datos personales (terminan en logs y en jobs.last_error).
import type { Db } from "../infra/db";
import { maskDestination, uuidv7 } from "../lib/util";
import { deliver, type OutboundMessage, type SendResult } from "./channels";

/** Dirección normalizada para la supresión. */
export const normAddress = (a: string) => a.trim().toLowerCase();

/**
 * Si no se le escribe a la dirección: queja registrada para esa organización (no vence; la quita un administrador
 * desde Ajustes) o rebote permanente vigente (global, vence a los EMAIL_BOUNCE_SUPPRESSION_DAYS días).
 * ignoreBounce: solo las quejas (el código de verificación lo pide la persona en ese momento: si llega y lo valida, el
 * rebote se borra; ver otp.ts).
 */
export async function isSuppressed(db: Db, address: string, tenantId: string | null, opts: { ignoreBounce?: boolean } = {}): Promise<boolean> {
  if (!address) return false;
  return Boolean(
    await db.one(
      `SELECT 1 FROM email_suppressions
        WHERE address = $1
          AND ((tenant_id IS NULL AND NOT $3::boolean AND (expires_at IS NULL OR expires_at > now())) OR tenant_id = $2::uuid)
        LIMIT 1`,
      [normAddress(address), tenantId, opts.ignoreBounce ?? false],
    ),
  );
}

/** Un código de verificación validado prueba que la dirección recibe correo: se borra su rebote (global). */
export async function clearBounceSuppression(db: Db, address: string): Promise<boolean> {
  if (!address) return false;
  const r = await db.query(`DELETE FROM email_suppressions WHERE address = $1 AND tenant_id IS NULL AND reason = 'bounce' RETURNING id`, [normAddress(address)]);
  return r.length > 0;
}

const TRANSIENT_NET = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKET|ECONNECTION|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNABORTED|EDNS|UND_ERR_[A-Z_]+)$/;
/** Errores de WhatsApp Cloud que llegan como 4xx pero son del momento (límites de envío, servicio no disponible). */
const WA_TRANSIENT_CODE = /"code":(1|2|4|80007|130429|131000|131048|131056)\b/;

/**
 * Si un error de envío es del momento y vale reintentarlo: red, timeout, 5xx o 429 del proveedor, SMTP 4xx. Los
 * permanentes (4xx del proveedor: número inválido, plantilla rechazada, chat bloqueado; SMTP 5xx) no se arreglan
 * reintentando. Uno desconocido se toma como transitorio (como antes: se reintenta).
 * Credenciales SMTP rechazadas (EAUTH / 535) y canal sin configurar: son de la plataforma, no del destinatario; se
 * arreglan corrigiendo la configuración, y el aviso tiene que salir después (no perderse para siempre).
 */
export function isTransientSendError(err: unknown): boolean {
  for (let cur: any = err, depth = 0; cur && depth < 3; cur = cur.cause, depth++) {
    if (cur.name === "TimeoutError" || cur.name === "AbortError") return true;
    if (typeof cur.code === "string" && (TRANSIENT_NET.test(cur.code) || cur.code === "EAUTH")) return true;
  }
  const e = err as any;
  const rc = Number(e?.responseCode); // nodemailer (respuesta SMTP)
  if (rc === 535) return true;
  if (rc >= 400 && rc < 500) return true;
  if (rc >= 500 && rc < 600) return false;
  const msg = String(e?.message ?? e);
  const api = /\b(?:WhatsApp API|Telegram API|Twilio) (\d{3})\b/.exec(msg);
  if (api) {
    const st = Number(api[1]);
    if (st === 408 || st === 429 || st >= 500) return true;
    return /WhatsApp API/.test(msg) && WA_TRANSIENT_CODE.test(msg);
  }
  if (/no configurado/.test(msg)) return true;
  const smtp = /^(?:Error: )?([45])(\d\d)[\s-]/.exec(msg.trim());
  if (smtp) return smtp[1] === "4" || `${smtp[1]}${smtp[2]}` === "535";
  return true;
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
  | { status: "failed"; error: string; transient: boolean };

export interface TrackedSend {
  tenantId: string;
  envelopeId?: string | null;
  recipientId?: string | null;
  /** Plantilla o evento (invite, reminder, agreement_expiry…). */
  template: string;
  /** Job que lo envía: con él, un reintento no repite lo que ya salió para el mismo canal y destino. */
  jobId?: number | null;
  log?: { error(o: object, m?: string): void; warn?(o: object, m?: string): void };
}

/**
 * Texto del aviso (email_domains.ses_identity_error_at; la API lo devuelve en sesIdentityError y el administrador lo ve
 * en Ajustes → Marca → Dominios de correo). Columna propia: last_error es de la verificación por DNS.
 */
export const SES_IDENTITY_ERROR = "SES rechazó el remitente: el dominio no está verificado como identidad en Amazon SES. Los correos salen desde la dirección de la plataforma hasta que se verifique.";

/**
 * SES rechazó el dominio propio (554 identidad sin verificar) y el correo salió desde la plataforma (channels.sendEmail):
 * se deja anotado en el dominio para que el administrador lo vea, y en el log. No hace fallar el envío.
 */
export async function noteSesIdentityRejection(db: Db, tenantId: string | null | undefined, domain: string, log?: TrackedSend["log"]) {
  (log?.warn ?? log?.error)?.call(log, { tenantId, domain }, "SES rechazó el dominio de correo propio (identidad sin verificar en SES): se envió desde la dirección de la plataforma");
  if (!tenantId) return;
  sesErrorClean.delete(`${tenantId}:${domain.toLowerCase()}`);
  // Si el aviso ya está anotado la fila no coincide y no se escribe nada.
  await db
    .query(`UPDATE email_domains SET ses_identity_error_at = now() WHERE tenant_id = $1 AND domain = $2 AND ses_identity_error_at IS NULL`, [tenantId, domain])
    .catch((e) => log?.error({ err: scrubPii(String(e)), domain }, "no se pudo anotar el rechazo de SES en el dominio"));
}

/**
 * Dominios propios (organización:dominio → vence) que en este proceso ya se sabe que no tienen anotado el rechazo de
 * SES: tras un envío con DKIM aceptado, el aviso se borra una vez por dominio y proceso cada SES_CLEAN_TTL_MS (no una
 * escritura por correo). Con vencimiento porque otra réplica puede volver a anotarlo (su envío fue rechazado) y, si
 * SES ya lo acepta, esta lo tiene que poder borrar más adelante.
 */
const sesErrorClean = new Map<string, number>();
const SES_CLEAN_TTL_MS = 10 * 60_000;

/**
 * Después de un envío: anota el rechazo de SES del dominio propio, o lo borra si SES ya aceptó un correo firmado con él.
 * Regla (para que el aviso no oscile): solo un rechazo real de SES lo anota y solo un envío con DKIM aceptado lo borra.
 * Un correo enviado en espera por un rechazo reciente (identityBackoff) no prueba nada: no escribe ni repite el log.
 * La re-verificación por DNS no lo toca.
 */
export async function noteDkimSendResult(db: Db, tenantId: string | null | undefined, res: SendResult, log?: TrackedSend["log"]) {
  if (res.identityBackoff) return;
  if (res.identityRejectedDomain) return noteSesIdentityRejection(db, tenantId, res.identityRejectedDomain, log);
  if (!res.dkimDomain || !tenantId) return;
  const key = `${tenantId}:${res.dkimDomain.toLowerCase()}`;
  if ((sesErrorClean.get(key) ?? 0) > Date.now()) return;
  await db.query(`UPDATE email_domains SET ses_identity_error_at = NULL WHERE tenant_id = $1 AND domain = $2 AND ses_identity_error_at IS NOT NULL`, [tenantId, res.dkimDomain]).then(
    () => {
      if (sesErrorClean.size > 10_000) sesErrorClean.clear();
      sesErrorClean.set(key, Date.now() + SES_CLEAN_TTL_MS);
    },
    (e) => log?.error({ err: scrubPii(String(e)), domain: res.dkimDomain }, "no se pudo borrar el rechazo de SES del dominio"),
  );
}

/**
 * Envía y registra en `notifications`. Correo a una dirección suprimida: no sale (fila 'suppressed'). Ya enviado por
 * este job al mismo canal y destino: no sale otra vez. La fila se inserta 'queued' ANTES de enviar y se actualiza
 * después: si el registro posterior falla (o el proceso muere a mitad del envío), el reintento del job la ve y no
 * reenvía. Contrapartida: un proceso que muere después de insertar y antes de entregar deja ese aviso sin enviar
 * (se prefiere eso a mandarlo dos veces); la fila 'queued' queda a la vista.
 */
export async function sendTracked(db: Db, t: TrackedSend, m: OutboundMessage & { cta?: string | null }): Promise<TrackedResult> {
  if (t.jobId != null) {
    const done = await db.one(
      `SELECT 1 FROM notifications WHERE job_id = $1 AND channel = $2 AND destination = $3 AND status IN ('queued','sent','bounced','complained','suppressed') LIMIT 1`,
      [t.jobId, m.channel, m.to],
    );
    if (done) return { status: "already" };
  }
  const id = uuidv7();
  const logFail = (e: unknown) => t.log?.error({ err: scrubPii(String(e)), template: t.template, channel: m.channel }, "no se pudo registrar el aviso");
  const insert = (status: string, extra: { error?: string | null } = {}) =>
    db
      .query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, error, job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, t.tenantId, t.envelopeId ?? null, t.recipientId ?? null, m.channel, t.template, m.to, status, extra.error ?? null, t.jobId ?? null],
      )
      .then(
        () => true,
        (e) => {
          logFail(e);
          return false;
        },
      );
  if (m.channel === "email" && (await isSuppressed(db, m.to, t.tenantId))) {
    await insert("suppressed", { error: "dirección suprimida (rebote permanente o queja)" });
    return { status: "suppressed" };
  }
  const queued = await insert("queued");
  const finish = (status: "sent" | "failed", extra: { provider?: string | null; messageId?: string | null; error?: string | null }) =>
    db
      .query(
        `UPDATE notifications SET status = $2, provider = $3, provider_message_id = $4, error = $5, sent_at = CASE WHEN $2 = 'sent' THEN now() END
          WHERE id = $1`,
        [id, status, extra.provider ?? null, extra.messageId ?? null, extra.error ?? null],
      )
      .then(
        () => true,
        (e) => {
          logFail(e);
          return false;
        },
      );
  let res: SendResult;
  try {
    res = await deliver(m);
  } catch (err) {
    const error = scrubPii(String(err)).slice(0, 1000);
    // Si no se pudo marcar 'failed', la fila quedaría 'queued' y el reintento del job la tomaría como ya enviada
    // ('already'): se borra (no salió nada). Si tampoco se puede borrar, se relanza para que el job no se dé por hecho.
    if (queued && !(await finish("failed", { error }))) {
      const removed = await db.query(`DELETE FROM notifications WHERE id = $1 AND status = 'queued'`, [id]).then(
        () => true,
        (e) => {
          logFail(e);
          return false;
        },
      );
      if (!removed) throw new Error(`no se pudo registrar el fallo del aviso: ${error}`);
    }
    return { status: "failed", error, transient: isTransientSendError(err) };
  }
  if (queued) await finish("sent", { provider: res.provider, messageId: res.messageId });
  await noteDkimSendResult(db, t.tenantId, res, t.log);
  return { status: "sent", res, id };
}
