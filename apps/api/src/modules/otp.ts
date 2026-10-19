// Autenticación del firmante con código de un solo uso (email, SMS o WhatsApp) y sesión de firmante.
// La sesión es una cookie HttpOnly con path = /v1/signing/<token>: solo viaja a los endpoints de ese link.
import { randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OtpVerifyInput, type OtpSendResponse } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import { AppError, conflict } from "../lib/errors";
import { maskDestination, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { deliver } from "../notifications/channels";
import { normLocale } from "../notifications/templates";
import type { Services } from "./context";
import { lockEnvelope } from "./envelopes";
import { buildSession, recipientActor, resolveToken } from "./signing";

export const SIGNER_COOKIE = "cs_signer";
const SESSION_HOURS = 2;
const CODE_TTL_MIN = 10;
const RESEND_COOLDOWN_S = 30;
const MAX_SENDS_PER_HOUR = 8;

const METHOD_CHANNEL = { otp_email: "email", otp_sms: "sms", otp_whatsapp: "whatsapp" } as const;
/**
 * Estados del sobre en que el link admite pedir y validar el código. 'finalizing' y 'completed': quien ya firmó sigue
 * descargando la copia en curso (copy.pdf, también mientras se sella) o el PDF final, y su sesión dura 2 horas.
 */
const OTP_OPEN_STATUSES = ["sent", "awaiting_certificates", "finalizing", "completed"];
const envelopeClosed = () => new AppError(410, "envelope_closed", "El sobre ya no está disponible");
type OtpMethod = keyof typeof METHOD_CHANNEL;

const MSG = {
  es: { subject: "Tu código de verificación de CalaSign", text: (c: string, s: string) => `Tu código para firmar "${s}" es ${c}. Vence en ${CODE_TTL_MIN} minutos. No lo compartas.` },
  "pt-BR": { subject: "Seu código de verificação da CalaSign", text: (c: string, s: string) => `Seu código para assinar "${s}" é ${c}. Expira em ${CODE_TTL_MIN} minutos. Não compartilhe.` },
  en: { subject: "Your CalaSign verification code", text: (c: string, s: string) => `Your code to sign "${s}" is ${c}. It expires in ${CODE_TTL_MIN} minutes. Don't share it.` },
};

function destinationOf(r: any): string | null {
  if (r.auth_method === "otp_email") return r.email;
  if (r.auth_method === "otp_sms" || r.auth_method === "otp_whatsapp") return r.phone;
  return null;
}

export function otpDestinationFor(r: any): string | null {
  const d = destinationOf(r);
  return d ? maskDestination(d) : null;
}

/** Se registró solo en un formulario web y no validó su correo: no se le manda nada ni puede hacer que se mande a otros. */
export function isUnverifiedSelfRegistered(r: any): boolean {
  return Boolean(r.self_registered) && !(r.auth_method === "otp_email" && r.authenticated_at);
}

export function canDelegate(r: any, e: any): boolean {
  return (
    e.status === "sent" &&
    !isUnverifiedSelfRegistered(r) &&
    (e.allow_delegation ?? true) &&
    (r.role === "signer" || r.role === "approver") &&
    ["sent", "viewed"].includes(r.status)
  );
}

export async function isSignerAuthenticated(db: Db, req: FastifyRequest, r: any): Promise<boolean> {
  if (!r.auth_method || r.auth_method === "link") return true;
  const cookie = req.cookies?.[SIGNER_COOKIE];
  if (!cookie) return false;
  const row = await db.one(`SELECT 1 FROM signer_sessions WHERE token_hash = $1 AND recipient_id = $2 AND expires_at > now()`, [
    sha256Hex(cookie),
    r.id,
  ]);
  return Boolean(row);
}

function codeHash(recipientId: string, code: string) {
  return sha256Hex(`${recipientId}:${code}`);
}

export async function otpRoutes(app: FastifyInstance, s: Services) {
  type P = { Params: { token: string } };
  const rl = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  // Los endpoints del link (salvo la sesión y el propio OTP) exigen el código validado si el destinatario lo requiere.
  app.addHook("preHandler", async (req: FastifyRequest, _reply: FastifyReply) => {
    const url = req.routeOptions?.url ?? "";
    if (!url.startsWith("/v1/signing/:token/") || url.includes("/otp/")) return;
    const token = (req.params as { token?: string }).token ?? "";
    const { recipient } = await resolveToken(s.db, token);
    if (!(await isSignerAuthenticated(s.db, req, recipient))) {
      throw new AppError(401, "otp_required", "Hace falta validar el código de verificación");
    }
  });

  app.post<P>("/v1/signing/:token/otp/send", rl, async (req) => {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    const method = r.auth_method as OtpMethod;
    if (!(method in METHOD_CHANNEL)) throw conflict("otp_not_required", "Este link no requiere código");
    if (!OTP_OPEN_STATUSES.includes(e.status)) throw envelopeClosed();
    const destination = destinationOf(r);
    if (!destination) throw conflict("otp_no_destination", "No hay a dónde enviar el código");

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);
    const locale = normLocale(r.locale ?? e.locale);
    const m = MSG[locale];
    const channel = METHOD_CHANNEL[method];
    const challengeId = uuidv7();
    // Se reserva el código con el sobre bloqueado ANTES de enviarlo: pedidos simultáneos no esquivan la espera
    // entre envíos ni el máximo por hora (cada SMS/WhatsApp cuesta).
    await s.db.tx(async (t) => {
      // El estado se vuelve a mirar con el sobre bloqueado: el de arriba se leyó sin bloqueo.
      if (!OTP_OPEN_STATUSES.includes((await lockEnvelope(t, e.tenant_id, e.id)).status)) throw envelopeClosed();
      const last = await t.one<any>(
        `SELECT created_at, (SELECT count(*) FROM otp_challenges WHERE recipient_id = $1 AND created_at > now() - interval '1 hour') AS n
         FROM otp_challenges WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [r.id],
      );
      if (last) {
        const wait = RESEND_COOLDOWN_S - Math.floor((Date.now() - new Date(last.created_at).getTime()) / 1000);
        if (wait > 0) throw new AppError(429, "otp_cooldown", `Esperá ${wait} s para pedir otro código`, { resendInSeconds: wait });
        if (Number(last.n) >= MAX_SENDS_PER_HOUR) throw new AppError(429, "otp_too_many", "Demasiados códigos pedidos. Probá más tarde.");
      }
      // Un código nuevo invalida los anteriores.
      await t.query(`UPDATE otp_challenges SET expires_at = LEAST(expires_at, now()) WHERE recipient_id = $1 AND verified_at IS NULL`, [r.id]);
      await t.query(
        `INSERT INTO otp_challenges (id, tenant_id, recipient_id, method, destination, code_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [challengeId, e.tenant_id, r.id, method, destination, codeHash(r.id, code), expiresAt.toISOString()],
      );
    });
    let res;
    try {
      res = await deliver({
        channel,
        to: destination,
        subject: m.subject,
        text: m.text(code, e.subject),
        locale,
        templateParams: [code],
        // La plantilla del pedido de firma espera remitente, asunto y link: con solo el código, Meta la rechaza.
        template: config.whatsapp.otpTemplate,
        tenantId: e.tenant_id,
      });
    } catch (err) {
      // No salió: el código reservado no sirve (cuenta igual para la espera, para no reintentar en ráfaga).
      await s.db.query(`UPDATE otp_challenges SET expires_at = now() WHERE id = $1`, [challengeId]);
      throw new AppError(502, "otp_delivery_failed", "No se pudo enviar el código. Probá de nuevo en unos segundos.");
    }
    await s.db.tx(async (t) => {
      const cur = await lockEnvelope(t, e.tenant_id, e.id);
      await t.query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, provider, provider_message_id, sent_at)
         VALUES ($1,$2,$3,$4,$5,'otp',$6,'sent',$7,$8,now())`,
        [uuidv7(), e.tenant_id, e.id, r.id, channel, destination, res.provider, res.messageId],
      );
      // El sobre se anuló, rechazó o venció mientras salía el código (el envío por SMS/WhatsApp tarda): el mensaje
      // queda registrado, pero no se agrega un evento a la evidencia de un sobre cerrado.
      if (!OTP_OPEN_STATUSES.includes(cur.status)) return;
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.otp_sent",
        actor: recipientActor(req, r),
        data: { method, destination: maskDestination(destination), provider: res.provider },
      });
    });
    const out: OtpSendResponse = {
      sent: true,
      destination: maskDestination(destination),
      resendInSeconds: RESEND_COOLDOWN_S,
      expiresAt: expiresAt.toISOString(),
    };
    return out;
  });

  app.post<P>("/v1/signing/:token/otp/verify", rl, async (req, reply) => {
    const input = OtpVerifyInput.parse(req.body);
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    // Los mismos estados que /otp/send: un código pedido con el sobre en curso y canjeado después de anularlo, rechazarlo
    // o vencerlo agregaba recipient.authenticated / otp_failed a la evidencia de un sobre cerrado (como el consentimiento).
    if (!OTP_OPEN_STATUSES.includes(e.status)) throw envelopeClosed();
    const ch = await s.db.one<any>(
      `SELECT * FROM otp_challenges WHERE recipient_id = $1 AND verified_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [r.id],
    );
    if (!ch) throw new AppError(400, "otp_expired", "El código venció o no existe. Pedí uno nuevo.");
    // El intento se cuenta ANTES de comparar y de forma atómica: pedidos concurrentes no pueden superar max_attempts.
    const upd = await s.db.one<any>(
      `UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1 AND attempts < max_attempts AND verified_at IS NULL RETURNING attempts, max_attempts`,
      [ch.id],
    );
    if (!upd) throw new AppError(429, "otp_locked", "Demasiados intentos. Pedí un código nuevo.");

    const ok = timingSafeEqual(Buffer.from(codeHash(r.id, input.code)), Buffer.from(ch.code_hash));
    if (!ok) {
      await s.db.tx(async (t) => {
        // Con el sobre bloqueado: el estado de arriba se leyó sin bloqueo (un sobre anulado justo antes no suma eventos).
        if (!OTP_OPEN_STATUSES.includes((await lockEnvelope(t, e.tenant_id, e.id)).status)) throw envelopeClosed();
        await appendEvent(t, {
          tenantId: e.tenant_id,
          envelopeId: e.id,
          type: "recipient.otp_failed",
          actor: recipientActor(req, r),
          data: { method: r.auth_method, attempt: upd.attempts },
        });
      });
      const remaining = Math.max(0, upd.max_attempts - upd.attempts);
      throw new AppError(400, "invalid_code", remaining ? `Código incorrecto. Te quedan ${remaining} intentos.` : "Código incorrecto. Pedí uno nuevo.", {
        remaining,
      });
    }

    const session = randomToken();
    const actor = recipientActor(req, r);
    await s.db.tx(async (t) => {
      // El estado se vuelve a leer con el sobre bloqueado: el de arriba pudo cambiar (anulado, rechazado, vencido o
      // completado) mientras tanto, y con el viejo se registraba la autenticación en un sobre cerrado.
      const cur = await lockEnvelope(t, e.tenant_id, e.id);
      if (!OTP_OPEN_STATUSES.includes(cur.status)) throw envelopeClosed();
      // Un código se canjea una sola vez (dos verificaciones concurrentes no generan dos sesiones).
      const used = await t.query(`UPDATE otp_challenges SET verified_at = now() WHERE id = $1 AND verified_at IS NULL RETURNING id`, [ch.id]);
      if (!used.length) throw new AppError(400, "otp_expired", "El código ya se usó. Pedí uno nuevo.");
      await t.query(`UPDATE recipients SET authenticated_at = now() WHERE id = $1`, [r.id]);
      await t.query(
        `INSERT INTO signer_sessions (token_hash, recipient_id, method, ip, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${SESSION_HOURS} hours')`,
        [sha256Hex(session), r.id, r.auth_method, actor.ip],
      );
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.authenticated",
        actor,
        data: { method: r.auth_method, destination: maskDestination(ch.destination) },
      });
      // Autoregistrado en un formulario web: con el correo ya verificado sale la invitación de respaldo (una sola vez).
      if (r.self_registered && r.auth_method === "otp_email" && cur.status === "sent") {
        await enqueue(t, "notify", { kind: "invite", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id }, { dedupeKey: `invite-verified:${r.id}` });
      }
      if (r.status === "sent" && cur.status === "sent") {
        const v = await t.query(`UPDATE recipients SET status = 'viewed', viewed_at = now() WHERE id = $1 AND status = 'sent' RETURNING id`, [r.id]);
        if (v.length) await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "recipient.viewed", actor });
      }
    });
    reply.setCookie(SIGNER_COOKIE, session, {
      path: `/v1/signing/${req.params.token}`,
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: SESSION_HOURS * 3600,
    });
    const fresh = await resolveToken(s.db, req.params.token);
    return buildSession(s.db, req.params.token, fresh.recipient, fresh.envelope, true);
  });
}
