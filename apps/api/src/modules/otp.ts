// Autenticación del firmante con código de un solo uso (email, SMS o WhatsApp) y sesión de firmante.
// La sesión es una cookie HttpOnly con path = /v1/signing/<token>: solo viaja a los endpoints de ese link.
import { randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { OtpVerifyInput, type OtpSendResponse } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent } from "../infra/evidence";
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

export function canDelegate(r: any, e: any): boolean {
  return (
    e.status === "sent" &&
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
    if (!["sent", "awaiting_certificates", "completed"].includes(e.status)) throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
    const destination = destinationOf(r);
    if (!destination) throw conflict("otp_no_destination", "No hay a dónde enviar el código");

    const last = await s.db.one<any>(
      `SELECT created_at, (SELECT count(*) FROM otp_challenges WHERE recipient_id = $1 AND created_at > now() - interval '1 hour') AS n
       FROM otp_challenges WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [r.id],
    );
    if (last) {
      const wait = RESEND_COOLDOWN_S - Math.floor((Date.now() - new Date(last.created_at).getTime()) / 1000);
      if (wait > 0) throw new AppError(429, "otp_cooldown", `Esperá ${wait} s para pedir otro código`, { resendInSeconds: wait });
      if (Number(last.n) >= MAX_SENDS_PER_HOUR) throw new AppError(429, "otp_too_many", "Demasiados códigos pedidos. Probá más tarde.");
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);
    const locale = normLocale(r.locale ?? e.locale);
    const m = MSG[locale];
    const channel = METHOD_CHANNEL[method];
    const res = await deliver({
      channel,
      to: destination,
      subject: m.subject,
      text: m.text(code, e.subject),
      locale,
      templateParams: [code],
      tenantId: e.tenant_id,
    });
    await s.db.tx(async (t) => {
      await lockEnvelope(t, e.tenant_id, e.id);
      // Un código nuevo invalida los anteriores.
      await t.query(`UPDATE otp_challenges SET expires_at = LEAST(expires_at, now()) WHERE recipient_id = $1 AND verified_at IS NULL`, [r.id]);
      await t.query(
        `INSERT INTO otp_challenges (id, tenant_id, recipient_id, method, destination, code_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuidv7(), e.tenant_id, r.id, method, destination, codeHash(r.id, code), expiresAt.toISOString()],
      );
      await t.query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, provider, provider_message_id, sent_at)
         VALUES ($1,$2,$3,$4,$5,'otp',$6,'sent',$7,$8,now())`,
        [uuidv7(), e.tenant_id, e.id, r.id, channel, destination, res.provider, res.messageId],
      );
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
    const ch = await s.db.one<any>(
      `SELECT * FROM otp_challenges WHERE recipient_id = $1 AND verified_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [r.id],
    );
    if (!ch) throw new AppError(400, "otp_expired", "El código venció o no existe. Pedí uno nuevo.");
    if (ch.attempts >= ch.max_attempts) throw new AppError(429, "otp_locked", "Demasiados intentos. Pedí un código nuevo.");

    const ok = timingSafeEqual(Buffer.from(codeHash(r.id, input.code)), Buffer.from(ch.code_hash));
    if (!ok) {
      const upd = await s.db.one<any>(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts, max_attempts`, [ch.id]);
      await s.db.tx(async (t) => {
        await lockEnvelope(t, e.tenant_id, e.id);
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
      await lockEnvelope(t, e.tenant_id, e.id);
      await t.query(`UPDATE otp_challenges SET verified_at = now() WHERE id = $1`, [ch.id]);
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
      if (r.status === "sent" && e.status === "sent") {
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
