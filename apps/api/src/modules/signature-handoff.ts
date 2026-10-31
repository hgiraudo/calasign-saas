// Firma dibujada en el celular («pase» de firma, migración 0124). El firmante, desde su sesión en la computadora
// (/v1/signing/:token/*, con las mismas guardas: código OTP y verificación de identidad por los hooks de otp.ts y
// identity/kyc.ts, consentimiento, turno y sobre en curso acá), pide un link corto /h/<token> y lo copia o lo manda
// por SMS, WhatsApp o Telegram. El celular abre la página pública, dibuja y envía el PNG (una sola vez, antes de que
// venza); la computadora consulta el pase hasta que llega, lo muestra y el firmante lo adopta ahí: la firma la sigue
// completando la sesión del firmante (/complete con `handoffId`), nunca el celular.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CreateSignatureHandoffInput,
  SendSignatureHandoffInput,
  SIGNATURE_HANDOFF_TTL_MINUTES,
  SubmitSignatureHandoffInput,
  type HandoffChannel,
  type PublicSignatureHandoff,
  type SignatureHandoff,
  type SignatureHandoffStatus,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent } from "../infra/evidence";
import { rateLimitIpKey } from "../lib/ip";
import { AppError, conflict, notFound, rateLimitError } from "../lib/errors";
import { decrypt, encrypt, maskDestination, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { deliver } from "../notifications/channels";
import { scrubPii } from "../notifications/outbound";
import { getSmsProvider } from "../notifications/sms";
import { normLocale } from "../notifications/templates";
import type { Services } from "./context";
import { currentSignerGroup, lockEnvelope, pastExpiry } from "./envelopes";
import { normalizeOtpDestination } from "./otp";
import { assertCanComplete, assertLinkCurrent, decodeSignaturePng, recipientActor, resolveToken } from "./signing";
import { brandForEnvelope, envelopeBaseUrl } from "./white-label/brand";

/** Token del pase en la URL: randomToken() de 32 bytes (256 bits) en base64url. */
const HANDOFF_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Pases por destinatario por hora: cada uno es una fila y un link nuevo (el de antes deja de servir). */
const MAX_HANDOFFS_PER_HOUR = 20;
/** Envíos del link por destinatario: espera entre envíos y topes, como el código OTP (otp.ts). */
const SEND_COOLDOWN_S = 30;
const MAX_SENDS_PER_HOUR = 5;
const MAX_SENDS_PER_DAY = 10;

interface HandoffRow {
  id: string;
  tenant_id: string;
  envelope_id: string;
  recipient_id: string;
  access_token_hash: string;
  token_enc: string;
  purpose: "signature" | "initials";
  expires_at: string | Date;
  submitted_at: string | Date | null;
  image_png: string | null;
}

/** Columnas del destinatario que usa este módulo (SELECT * de recipients). */
interface SignerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  routing_order: number;
  consented_at: string | Date | null;
  auth_method: string | null;
  identity_confirmed_at: string | Date | null;
  access_token_hash: string | null;
  telegram_chat_id: string | null;
  locale: string | null;
}

/** Columnas del sobre que usa este módulo (SELECT * de envelopes). */
interface EnvelopeRow {
  id: string;
  tenant_id: string;
  status: string;
  expires_at: string | Date | null;
  locale: string | null;
  subject: string | null;
  created_by: string | null;
  brand_id: string | null;
}

const MSG = {
  es: {
    text: (url: string) =>
      `Abrí este link en tu celular para dibujar tu firma: ${url} . Vence en ${SIGNATURE_HANDOFF_TTL_MINUTES} minutos. Si no lo pediste, ignorá este mensaje.`,
    cta: "Dibujar mi firma",
  },
  "pt-BR": {
    text: (url: string) =>
      `Abra este link no seu celular para desenhar sua assinatura: ${url} . Expira em ${SIGNATURE_HANDOFF_TTL_MINUTES} minutos. Se você não pediu, ignore esta mensagem.`,
    cta: "Desenhar minha assinatura",
  },
  en: {
    text: (url: string) =>
      `Open this link on your phone to draw your signature: ${url} . It expires in ${SIGNATURE_HANDOFF_TTL_MINUTES} minutes. If you didn't request it, ignore this message.`,
    cta: "Draw my signature",
  },
};

/** Pase vencido, ya usado, reemplazado o cuyo sobre ya no se puede firmar: lo mismo para el celular. */
const handoffExpired = () =>
  new AppError(410, "handoff_expired", "El link para dibujar la firma venció o ya no sirve: pedí otro desde la pantalla donde estás firmando");

/** Canales por los que la API puede mandar el link en este entorno (en local, todo cae en el buzón de desarrollo). */
function availableChannels(r: { telegram_chat_id?: string | null }): HandoffChannel[] {
  const out: HandoffChannel[] = [];
  if (getSmsProvider() || config.devMailbox) out.push("sms");
  if ((config.whatsapp.token && config.whatsapp.phoneNumberId) || config.devMailbox) out.push("whatsapp");
  // Telegram no le escribe a un número: solo al chat que el firmante vinculó con el bot (telegram.ts). Sin chat, la web
  // ofrece copiar el link o compartirlo por Telegram desde el propio dispositivo.
  if (r.telegram_chat_id && (config.telegram.botToken || config.devMailbox)) out.push("telegram");
  return out;
}

const handoffUrl = async (db: Db, h: { tenant_id: string; envelope_id: string }, token: string) =>
  `${await envelopeBaseUrl(db, h.tenant_id, h.envelope_id)}/h/${token}`;

/**
 * El destinatario puede preparar una firma ahora: lo mismo que pide /complete antes de aceptar la imagen (sobre en
 * curso, firmante, su turno, consentimiento) y, en persona, la identidad confirmada en el dispositivo del anfitrión.
 */
async function assertCanPrepare(db: Db, r: SignerRow, e: EnvelopeRow) {
  assertCanComplete(e, r, e.status === "sent" ? (await currentSignerGroup(db, e.id)).order : null);
  if (r.auth_method === "in_person" && !r.identity_confirmed_at)
    throw conflict("identity_confirmation_required", "Primero hay que confirmar la identidad en el dispositivo del anfitrión");
}

export async function signatureHandoffRoutes(app: FastifyInstance, s: Services) {
  type P = { Params: { token: string; id?: string } };
  // Por IP (en IPv6, por /64), como el OTP: crear y mandar cuesta (filas y mensajes). La consulta del estado va aparte
  // (pollRl, por firmante).
  const byIp = (max: number) => ({
    config: { rateLimit: { max, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => rateLimitIpKey(req.ip) } },
  });

  /**
   * Pase del destinatario del link (404 si es de otro destinatario o sobre, aunque sea de la misma organización, o si se
   * pidió con un link de firma anterior: una corrección del contacto lo revoca, como en el celular con liveHandoff).
   */
  async function ownHandoff(db: Db, r: SignerRow, e: EnvelopeRow, id: string) {
    const h = await db.one<HandoffRow>(
      `SELECT * FROM signature_handoffs WHERE id = $1 AND recipient_id = $2 AND envelope_id = $3 AND access_token_hash = $4`,
      [id, r.id, e.id, r.access_token_hash],
    );
    if (!h) throw notFound("Pase de firma");
    return h;
  }

  async function toApi(db: Db, h: HandoffRow, r: SignerRow, token: string, sent: SignatureHandoff["sent"] = null): Promise<SignatureHandoff> {
    return {
      id: h.id,
      url: await handoffUrl(db, h, token),
      purpose: h.purpose,
      expiresAt: new Date(h.expires_at).toISOString(),
      channels: availableChannels(r),
      sent,
    };
  }

  /**
   * Manda el link del pase. Se reserva el envío con el sobre bloqueado ANTES de mandarlo (pedidos simultáneos no
   * esquivan la espera ni los topes); si no sale, el envío reservado igual cuenta para la espera, como en el OTP.
   */
  async function sendLink(req: FastifyRequest, r: SignerRow, e: EnvelopeRow, h: HandoffRow, token: string, input: SendSignatureHandoffInput) {
    if (!availableChannels(r).includes(input.channel)) {
      throw conflict(
        "handoff_channel_unavailable",
        input.channel === "telegram"
          ? "Todavía no vinculaste tu Telegram: copiá el link y pegalo en el chat, o elegí otro canal"
          : "Ese canal no está disponible: copiá el link o elegí otro canal",
      );
    }
    const to = input.channel === "telegram" ? String(r.telegram_chat_id) : input.phone!;
    // Los topes por destino se cuentan sobre el destino normalizado (teléfono sin separadores; el chat de Telegram aparte).
    const dest = input.channel === "telegram" ? `tg:${to}` : normalizeOtpDestination(to);
    const sendId = uuidv7();
    await s.db.tx(async (t) => {
      const cur = await lockEnvelope(t, e.tenant_id, e.id);
      const fresh = await t.one<SignerRow>(`SELECT * FROM recipients WHERE id = $1`, [r.id]);
      assertLinkCurrent(fresh, r);
      if (!fresh) throw notFound("Link"); // assertLinkCurrent ya lo cubre: es para el tipo
      await assertCanPrepare(t, fresh, cur);
      const live = await t.one<{ ok: boolean }>(
        `SELECT (expires_at > now() AND submitted_at IS NULL) AS ok FROM signature_handoffs WHERE id = $1 FOR UPDATE`,
        [h.id],
      );
      if (!live?.ok) throw handoffExpired();
      const c = await t.one<{ last: string | null; h: number; d: number; dh: number; dd: number; g: number }>(
        `SELECT (SELECT max(created_at) FROM signature_handoff_sends WHERE recipient_id = $1) AS last,
                (SELECT count(*) FROM signature_handoff_sends WHERE recipient_id = $1 AND created_at > now() - interval '1 hour')::int AS h,
                (SELECT count(*) FROM signature_handoff_sends WHERE recipient_id = $1 AND created_at > now() - interval '1 day')::int AS d,
                (SELECT count(*) FROM signature_handoff_sends WHERE tenant_id = $2 AND destination = $3 AND created_at > now() - interval '1 hour')::int AS dh,
                (SELECT count(*) FROM signature_handoff_sends WHERE tenant_id = $2 AND destination = $3 AND created_at > now() - interval '1 day')::int AS dd,
                (SELECT count(*) FROM signature_handoff_sends WHERE destination = $3 AND created_at > now() - interval '1 hour')::int AS g`,
        [r.id, e.tenant_id, dest],
      );
      const wait = c?.last ? SEND_COOLDOWN_S - Math.floor((Date.now() - new Date(c.last).getTime()) / 1000) : 0;
      if (wait > 0) throw new AppError(429, "handoff_cooldown", `Esperá ${wait} s para volver a mandar el link`, { resendInSeconds: wait });
      if (Number(c?.h ?? 0) >= MAX_SENDS_PER_HOUR || Number(c?.d ?? 0) >= MAX_SENDS_PER_DAY)
        throw new AppError(429, "handoff_send_limit", "Ya mandaste el link demasiadas veces: copialo y pegalo en el chat, o probá más tarde");
      // Los mismos topes por destino que el código OTP (config.otp): quien tiene un link de firma no puede usar la
      // plataforma para llenar de mensajes un teléfono ajeno.
      if (
        Number(c?.dh ?? 0) >= config.otp.maxPerDestinationHour ||
        Number(c?.dd ?? 0) >= config.otp.maxPerDestinationDay ||
        Number(c?.g ?? 0) >= config.otp.maxPerDestinationGlobalHour
      )
        throw new AppError(429, "handoff_destination_limit", "Se mandaron demasiados mensajes a ese destino: copiá el link o probá más tarde");
      await t.query(
        `INSERT INTO signature_handoff_sends (id, tenant_id, handoff_id, recipient_id, channel, destination) VALUES ($1,$2,$3,$4,$5,$6)`,
        [sendId, e.tenant_id, h.id, r.id, input.channel, dest],
      );
    });
    const locale = normLocale(r.locale ?? e.locale);
    const url = await handoffUrl(s.db, h, token);
    // Marca blanca: el SMS sale con el remitente de la marca del sobre, como el código OTP (white-label/otp-text.ts).
    const smsFrom = input.channel === "sms" ? ((await brandForEnvelope(s.db, e)).smsSenderId ?? null) : null;
    let res;
    try {
      res = await deliver({
        channel: input.channel,
        to,
        subject: MSG[locale].cta,
        text: MSG[locale].text(url),
        link: url,
        cta: MSG[locale].cta,
        smsFrom,
        locale,
        // WhatsApp solo acepta plantillas aprobadas por Meta: va la del pedido de firma ({{1}} remitente, {{2}} asunto,
        // {{3}} link), que ya está aprobada y dice de qué sobre se trata. Sin saltos de línea (Meta los rechaza).
        templateParams: [await senderName(s.db, e), String(e.subject ?? "-").replace(/[\r\n\t]+/g, " ") || "-", url],
        template: config.whatsapp.template,
        tenantId: e.tenant_id,
      });
    } catch (err) {
      // Sin el teléfono ni el correo: los errores de Twilio y de WhatsApp traen el destino completo.
      req.log.warn({ err: scrubPii(String(err)), channel: input.channel, envelopeId: e.id }, "no salió el link del pase de firma");
      throw new AppError(502, "handoff_delivery_failed", "No se pudo mandar el link: copialo y pegalo en el chat, o probá de nuevo en unos segundos");
    }
    await s.db.tx(async (t) => {
      const cur = await lockEnvelope(t, e.tenant_id, e.id);
      await t.query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, provider, provider_message_id, sent_at)
         VALUES ($1,$2,$3,$4,$5,'signature_handoff',$6,'sent',$7,$8,now())`,
        [uuidv7(), e.tenant_id, e.id, r.id, input.channel, to, res.provider, res.messageId],
      );
      // Sobre cerrado mientras salía el mensaje: queda el registro del envío, pero no un evento en su evidencia.
      if (cur.status !== "sent" || pastExpiry(cur)) return;
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.signature_handoff_sent",
        actor: recipientActor(req, r),
        data: {
          handoffId: h.id,
          channel: input.channel,
          destination: input.channel === "telegram" ? "telegram" : maskDestination(to),
          provider: res.provider,
        },
      });
    });
    return { channel: input.channel, destination: input.channel === "telegram" ? "Telegram" : maskDestination(to), resendInSeconds: SEND_COOLDOWN_S };
  }

  app.post<P>("/v1/signing/:token/signature-handoffs", byIp(10), async (req, reply) => {
    const input = CreateSignatureHandoffInput.parse(req.body ?? {});
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    await assertCanPrepare(s.db, r, e);
    const token = randomToken();
    const id = uuidv7();
    await s.db.tx(async (t) => {
      const cur = await lockEnvelope(t, e.tenant_id, e.id);
      const fresh = await t.one<SignerRow>(`SELECT * FROM recipients WHERE id = $1`, [r.id]);
      assertLinkCurrent(fresh, r);
      if (!fresh) throw notFound("Link"); // assertLinkCurrent ya lo cubre: es para el tipo
      await assertCanPrepare(t, fresh, cur);
      const n = await t.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM signature_handoffs WHERE recipient_id = $1 AND created_at > now() - interval '1 hour'`,
        [r.id],
      );
      if (Number(n?.n ?? 0) >= MAX_HANDOFFS_PER_HOUR)
        throw new AppError(429, "handoff_too_many", "Pediste demasiados links para el celular: probá más tarde o dibujá la firma en esta pantalla");
      // Un pase nuevo deja sin efecto los anteriores sin usar: un solo link vivo por firmante.
      await t.query(`UPDATE signature_handoffs SET expires_at = LEAST(expires_at, now()) WHERE recipient_id = $1 AND submitted_at IS NULL`, [r.id]);
      await t.query(
        `INSERT INTO signature_handoffs (id, tenant_id, envelope_id, recipient_id, access_token_hash, token_hash, token_enc, purpose, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(mins => $9))`,
        [id, e.tenant_id, e.id, r.id, r.access_token_hash, sha256Hex(token), encrypt(token), input.purpose, SIGNATURE_HANDOFF_TTL_MINUTES],
      );
    });
    const h = (await s.db.one<HandoffRow>(`SELECT * FROM signature_handoffs WHERE id = $1`, [id]))!;
    let sent: SignatureHandoff["sent"] = null;
    if (input.channel) {
      try {
        sent = await sendLink(req, r, e, h, token, { channel: input.channel, phone: input.phone });
      } catch (err) {
        // El pase ya existe (y dejó sin efecto los anteriores): si el envío falla, el error lleva el pase en
        // details.handoff para que el firmante copie el link o lo reenvíe por …/send en vez de perderlo.
        if (!(err instanceof AppError)) throw err;
        const details = err.details && typeof err.details === "object" ? err.details : {};
        throw new AppError(err.status, err.code, err.message, { ...details, handoff: await toApi(s.db, h, r, token, null) });
      }
    }
    return reply.code(201).send(await toApi(s.db, h, r, token, sent));
  });

  app.post<P>("/v1/signing/:token/signature-handoffs/:id/send", byIp(10), async (req) => {
    const input = SendSignatureHandoffInput.parse(req.body);
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    const h = await ownHandoff(s.db, r, e, req.params.id!);
    let token: string;
    try {
      token = decrypt(h.token_enc);
    } catch {
      // Clave de cifrado rotada: este pase ya no se puede reenviar (se pide otro).
      throw handoffExpired();
    }
    const sent = await sendLink(req, r, e, h, token, input);
    return toApi(s.db, h, r, token, sent);
  });

  // La consulta del estado (la computadora pregunta cada 2 s, ~30 por minuto) cuenta por firmante, no por IP: varios
  // firmantes detrás de la misma conexión (una oficina) se repartían 90 por minuto y a partir del cuarto la espera daba
  // 429. La clave es el hash del token de firma (el secreto no queda en el contador). Como cada token inventado tendría su
  // propio cupo, además hay un techo por IP igual al límite global (este tope de ruta lo reemplaza).
  const pollIpCeiling = app.createRateLimit({ max: 600, timeWindow: "1 minute", keyGenerator: (req) => `handoff-poll-ip:${rateLimitIpKey(req.ip)}` });
  const pollRl = {
    config: {
      rateLimit: {
        max: 90,
        timeWindow: "1 minute",
        keyGenerator: (req: FastifyRequest) => `handoff-poll:${sha256Hex(String((req.params as { token?: string } | undefined)?.token ?? ""))}`,
      },
    },
    onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
      const r = await pollIpCeiling(req);
      if (r.isAllowed || !r.isExceeded) return;
      reply.header("retry-after", r.ttlInSeconds);
      throw rateLimitError(req, { statusCode: 429, ttl: r.ttl });
    },
  };

  app.get<P>("/v1/signing/:token/signature-handoffs/:id", pollRl, async (req) => {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    const h = await ownHandoff(s.db, r, e, req.params.id!);
    // Con el sobre anulado, vencido o rechazado (o el firmante ya sin turno), el pase no sirve más: «expired», como le
    // responde el celular (410). Antes seguía en «pending» hasta los 10 minutos y los dos dispositivos se contradecían.
    const usable = await assertCanPrepare(s.db, r, e).then(
      () => true,
      (err) => {
        if (err instanceof AppError) return false;
        throw err;
      },
    );
    const submitted = usable && Boolean(h.submitted_at && h.image_png);
    const out: SignatureHandoffStatus = {
      id: h.id,
      status: submitted ? "submitted" : usable && !h.submitted_at && new Date(h.expires_at).getTime() > Date.now() ? "pending" : "expired",
      expiresAt: new Date(h.expires_at).toISOString(),
      imagePng: submitted ? h.image_png : null,
    };
    return out;
  });

  // ── Página pública del celular (/h/:token): el token del path es el único secreto (lib/redact.ts lo saca de los logs) ──

  /** Pase vigente del token, con su destinatario y sobre todavía en condiciones de firmar. */
  async function liveHandoff(db: Db, token: string, lock = false) {
    if (!HANDOFF_TOKEN_RE.test(token)) throw notFound("Link");
    const h = await db.one<HandoffRow>(`SELECT * FROM signature_handoffs WHERE token_hash = $1${lock ? " FOR UPDATE" : ""}`, [sha256Hex(token)]);
    if (!h) throw notFound("Link");
    if (h.submitted_at) throw conflict("handoff_used", "Esta firma ya se envió: seguí en la pantalla donde estás firmando");
    if (new Date(h.expires_at).getTime() <= Date.now()) throw handoffExpired();
    // El link de firma con el que se pidió sigue siendo el vigente (una corrección del contacto lo revoca).
    const r = await db.one<SignerRow>(`SELECT * FROM recipients WHERE id = $1 AND access_token_hash = $2`, [h.recipient_id, h.access_token_hash]);
    const e = r ? await db.one<EnvelopeRow>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2`, [h.envelope_id, h.tenant_id]) : null;
    if (!r || !e) throw handoffExpired();
    return { h, r, e };
  }

  const publicRl = byIp(20);

  app.get<P>("/v1/public/signature-handoffs/:token", publicRl, async (req) => {
    const { h, r, e } = await liveHandoff(s.db, req.params.token);
    try {
      await assertCanPrepare(s.db, r, e);
    } catch {
      throw handoffExpired();
    }
    const out: PublicSignatureHandoff = {
      purpose: h.purpose,
      expiresAt: new Date(h.expires_at).toISOString(),
      locale: normLocale(r.locale ?? e.locale),
    };
    return out;
  });

  app.post<P>("/v1/public/signature-handoffs/:token", { ...publicRl, bodyLimit: 1024 * 1024 + 4096 }, async (req) => {
    const input = SubmitSignatureHandoffInput.parse(req.body);
    // Mismo criterio que la firma dibujada en la computadora (y que /complete vuelve a aplicar al adoptarla).
    const { h: h0 } = await liveHandoff(s.db, req.params.token);
    const png = await decodeSignaturePng(input.imagePng, h0.purpose === "initials" ? "Iniciales" : "Firma");
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, h0.tenant_id, h0.envelope_id);
      // Con el sobre bloqueado y la fila tomada: dos envíos simultáneos del mismo link no pasan los dos (un solo uso).
      const { h, r } = await liveHandoff(t, req.params.token, true);
      try {
        await assertCanPrepare(t, r, e);
      } catch {
        throw handoffExpired();
      }
      const actor = recipientActor(req, r);
      await t.query(
        `UPDATE signature_handoffs SET submitted_at = now(), submitted_ip = $2, submitted_user_agent = $3, image_png = $4, image_sha256 = $5 WHERE id = $1`,
        [h.id, actor.ip, actor.userAgent, png.toString("base64"), sha256Hex(png)],
      );
      // Evidencia: la firma se dibujó en otro dispositivo (IP y navegador del celular en el actor), sin el token.
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.signature_handoff_submitted",
        actor,
        data: { handoffId: h.id, purpose: h.purpose, sha256: sha256Hex(png) },
      });
    });
    return { submitted: true as const };
  });
}

/** Remitente para la plantilla de WhatsApp: quien envió el sobre o, con una API key, la organización. */
async function senderName(db: Db, e: EnvelopeRow): Promise<string> {
  const u = e.created_by ? await db.one<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [e.created_by]) : null;
  const t = u ? null : await db.one<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [e.tenant_id]);
  return (u?.name ?? t?.name ?? "-").replace(/[\r\n\t]+/g, " ") || "-";
}
