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
import { lastEmbedSession } from "./embed";
import { lockEnvelope, pastExpiry } from "./envelopes";
import { brandedOtpMessage } from "./white-label/otp-text";
import { assertLinkCurrent, buildSession, recipientActor, resolveToken } from "./signing";

export const SIGNER_COOKIE = "cs_signer";
/** Sesión deslizante: cada uso la estira a 2 h desde ahora, pero nunca más de 8 h desde que se creó. */
const SESSION_HOURS = 2;
const SESSION_MAX_HOURS = 8;
const CODE_TTL_MIN = 10;
const RESEND_COOLDOWN_S = 30;
const MAX_SENDS_PER_HOUR = 8;
/**
 * Tope por día: con 8 por hora y 5 intentos por código eran ~960 intentos diarios sin fin contra 10⁶ códigos (~3 % de
 * acertar en un mes con el link en la mano). 20 por día alcanza de sobra para quien firma de verdad.
 */
const MAX_SENDS_PER_DAY = 20;

const METHOD_CHANNEL = { otp_email: "email", otp_sms: "sms", otp_whatsapp: "whatsapp" } as const;
/**
 * Estados del sobre en que el link admite pedir y validar el código. 'finalizing' y 'completed': quien ya firmó sigue
 * descargando la copia en curso (copy.pdf, también mientras se sella) o el PDF final, y su sesión dura 2 horas desde el último uso.
 */
const OTP_OPEN_STATUSES = ["sent", "awaiting_certificates", "finalizing", "completed"];
/** Un sobre en curso que ya pasó su vencimiento (el barrido todavía no lo marcó) tampoco manda ni canjea códigos. */
const otpOpen = (e: { status: string; expires_at?: string | Date | null }) => OTP_OPEN_STATUSES.includes(e.status) && !(e.status === "sent" && pastExpiry(e));
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

/**
 * Firma dentro de la app del integrador: marcado como embebido o abierto con una URL de firma embebida (una
 * embed_session usada) en las últimas 24 h. La ventana es la misma de embed.ts lastEmbedSession (la que enmarca la
 * página al volver de un proveedor): pasado ese plazo la sesión embebida ya no rige, y un firmante que después abre su
 * link desde el correo vuelve a poder delegar (antes una sesión usada alguna vez lo bloqueaba para siempre).
 */
export async function isEmbeddedSigner(db: Db, r: any): Promise<boolean> {
  if (r.embedded) return true;
  return Boolean(await lastEmbedSession(db, r.id));
}

/** `embedded`: resultado de isEmbeddedSigner (sin él solo cuenta el flag del destinatario). */
export function canDelegate(r: any, e: any, embedded = Boolean(r.embedded)): boolean {
  return (
    e.status === "sent" &&
    !isUnverifiedSelfRegistered(r) &&
    // Embebido: firma dentro de la app del integrador, que es quien decide quién firma (delegar desde el iframe o la
    // pestaña del integrador lo dejaba colgado, sin evento ni vuelta al returnUrl).
    !embedded &&
    (e.allow_delegation ?? true) &&
    (r.role === "signer" || r.role === "approver") &&
    ["sent", "viewed"].includes(r.status)
  );
}

export async function isSignerAuthenticated(db: Db, req: FastifyRequest, r: any): Promise<boolean> {
  if (!r.auth_method || r.auth_method === "link") return true;
  const cookie = req.cookies?.[SIGNER_COOKIE];
  if (!cookie) return false;
  // Valida y estira en un solo UPDATE; la presencial conserva el vencimiento que fijó el anfitrión.
  const row = await db.one(
    `UPDATE signer_sessions SET expires_at = CASE WHEN method = 'in_person' THEN expires_at
       ELSE GREATEST(expires_at, LEAST(now() + interval '${SESSION_HOURS} hours', created_at + interval '${SESSION_MAX_HOURS} hours')) END
     WHERE token_hash = $1 AND recipient_id = $2 AND expires_at > now() RETURNING 1`,
    [sha256Hex(cookie), r.id],
  );
  return Boolean(row);
}

/** Destino normalizado para contar envíos (correo sin mayúsculas ni espacios; teléfono sin separadores). */
export function normalizeOtpDestination(d: string): string {
  const s = d.trim().toLowerCase();
  return s.includes("@") ? s : s.replace(/[\s().-]/g, "");
}

/**
 * Topes de códigos por destino (config.otp: por hora y por día, sumando todos los sobres y organizaciones) y por
 * organización (por hora). Se llama dentro de la transacción del envío, antes de reservar el código.
 */
export async function assertOtpDestinationCapacity(db: Db, tenantId: string, destination: string) {
  const dest = normalizeOtpDestination(destination);
  // Los teléfonos ya se guardan en E.164 (sin separadores) y el correo se compara sin mayúsculas (índice lower(destination)).
  const c = await db.one<{ h: number; d: number; t: number }>(
    `SELECT (SELECT count(*) FROM otp_challenges WHERE lower(destination) = $1 AND created_at > now() - interval '1 hour')::int AS h,
            (SELECT count(*) FROM otp_challenges WHERE lower(destination) = $1 AND created_at > now() - interval '1 day')::int AS d,
            (SELECT count(*) FROM otp_challenges WHERE tenant_id = $2 AND created_at > now() - interval '1 hour')::int AS t`,
    [dest, tenantId],
  );
  if (Number(c?.h ?? 0) >= config.otp.maxPerDestinationHour || Number(c?.d ?? 0) >= config.otp.maxPerDestinationDay) {
    throw new AppError(429, "otp_destination_limit", "Se enviaron demasiados códigos a este destino. Probá más tarde.");
  }
  if (Number(c?.t ?? 0) >= config.otp.maxPerTenantHour) {
    throw new AppError(429, "otp_tenant_limit", "Se enviaron demasiados códigos desde esta organización. Probá más tarde.");
  }
}

function codeHash(recipientId: string, code: string) {
  return sha256Hex(`${recipientId}:${code}`);
}

export async function otpRoutes(app: FastifyInstance, s: Services) {
  type P = { Params: { token: string } };
  const rl = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  // Los endpoints del link (salvo la sesión, el propio OTP y los datos de la firma embebida) exigen el código validado si
  // el destinatario lo requiere. /embed (solo el returnUrl del integrador) lo pide la página una vez, al abrirse y antes
  // del código: con el 401 el firmante embebido con OTP no volvía nunca a la aplicación del integrador al terminar.
  app.addHook("preHandler", async (req: FastifyRequest, _reply: FastifyReply) => {
    const url = req.routeOptions?.url ?? "";
    if (!url.startsWith("/v1/signing/:token/") || url.includes("/otp/") || url === "/v1/signing/:token/embed") return;
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
    if (!otpOpen(e)) throw envelopeClosed();
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
      // Y el link: una corrección del contacto confirmada mientras tanto no le manda un código al destino anterior.
      assertLinkCurrent(await t.one<any>(`SELECT access_token_hash FROM recipients WHERE id = $1`, [r.id]), req.params.token);
      const last = await t.one<any>(
        `SELECT created_at, (SELECT count(*) FROM otp_challenges WHERE recipient_id = $1 AND created_at > now() - interval '1 hour') AS n,
                (SELECT count(*) FROM otp_challenges WHERE recipient_id = $1 AND created_at > now() - interval '1 day') AS day
         FROM otp_challenges WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [r.id],
      );
      if (last) {
        const wait = RESEND_COOLDOWN_S - Math.floor((Date.now() - new Date(last.created_at).getTime()) / 1000);
        if (wait > 0) throw new AppError(429, "otp_cooldown", `Esperá ${wait} s para pedir otro código`, { resendInSeconds: wait });
        if (Number(last.n) >= MAX_SENDS_PER_HOUR) throw new AppError(429, "otp_too_many", "Demasiados códigos pedidos. Probá más tarde.");
        if (Number(last.day) >= MAX_SENDS_PER_DAY) {
          throw new AppError(429, "otp_daily_limit", "Se pidieron demasiados códigos hoy. Probá mañana o pedile al remitente un link nuevo.");
        }
      }
      // Topes por destino (correo o teléfono, de cualquier sobre u organización) y por organización: el de arriba es por
      // destinatario, y con muchos sobres al mismo destino (p. ej. un formulario web con código completado una y otra
      // vez con el correo de otro) se podía bombardear esa dirección.
      await assertOtpDestinationCapacity(t, e.tenant_id, destination);
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
        // Marca blanca: plantilla, nombre del producto y remitente de la marca del sobre (white-label/otp-text.ts).
        ...(await brandedOtpMessage(s.db, e, locale, code, m.subject, m.text)),
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
    if (!otpOpen(e)) throw envelopeClosed();
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
      // Con el link vigente: si una corrección del contacto se confirmó mientras tanto, quien tenía el link anterior no
      // deja autenticado ni "visto" al contacto corregido.
      assertLinkCurrent(await t.one<any>(`SELECT access_token_hash FROM recipients WHERE id = $1`, [r.id]), req.params.token);
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
      // La cookie dura el tope; el vencimiento real lo controla el servidor.
      maxAge: SESSION_MAX_HOURS * 3600,
    });
    const fresh = await resolveToken(s.db, req.params.token);
    return buildSession(s.db, req.params.token, fresh.recipient, fresh.envelope, true);
  });
}
