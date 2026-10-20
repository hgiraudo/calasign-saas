// Webhook del bot de Telegram: vincula el chat del firmante cuando abre t.me/<bot>?start=<token de vinculación>.
// El token de vinculación es propio (no el de firma, que no tiene que pasar por Telegram), de un solo uso, vence en
// TELEGRAM_LINK_TTL_MINUTES (30 por defecto) y se guarda como hash (telegram_link_tokens; también cifrado, para reusarlo mientras siga vigente).
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { SYSTEM, appendEvent } from "../infra/evidence";
import type { Db } from "../infra/db";
import { decrypt, encrypt, randomToken, sha256Hex } from "../lib/util";
import { sendTelegram, telegramStartLink } from "../notifications/channels";
import { normLocale } from "../notifications/templates";
import type { Services } from "./context";
import { envelopeBaseUrl } from "./white-label/brand";

const MSG = {
  linked: {
    es: (s: string) => `Listo: vas a recibir por acá los avisos de "${s}".`,
    "pt-BR": (s: string) => `Pronto: você vai receber por aqui os avisos de "${s}".`,
    en: (s: string) => `Done: you'll get notifications for "${s}" here.`,
  },
  cta: { es: "Revisar y firmar", "pt-BR": "Revisar e assinar", en: "Review and sign" },
  unknown: "Link inválido o vencido. / Link inválido ou expirado. / Invalid or expired link.",
  needsOtp:
    "Primero abrí el link de firma e ingresá el código que te enviamos; después volvé a tocar este enlace. / " +
    "Primeiro abra o link de assinatura e informe o código que enviamos; depois toque este link de novo. / " +
    "First open the signing link and enter the code we sent you; then tap this link again.",
};

/**
 * Link t.me con un token de vinculación para el destinatario (null sin bot configurado o sin link de firma). Queda atado
 * al link de firma vigente: si se corrige el contacto (link nuevo), deja de servir. Se reusa uno vigente y sin usar del
 * mismo destinatario y link (guardado también cifrado para poder devolverlo): la página de firma lo pide en cada carga
 * y antes se creaba una fila por cada una. Uno a punto de vencer (menos de 5 minutos) no se reusa.
 */
export async function telegramLinkFor(db: Db, r: { id: string; access_token_hash?: string | null }): Promise<string | null> {
  if (!config.telegram.botUsername || !r.access_token_hash) return null;
  const cur = await db.one<{ token_enc: string }>(
    `SELECT token_enc FROM telegram_link_tokens
      WHERE recipient_id = $1 AND access_token_hash = $2 AND used_at IS NULL AND token_enc IS NOT NULL AND expires_at > now() + interval '5 minutes'
      ORDER BY expires_at DESC LIMIT 1`,
    [r.id, r.access_token_hash],
  );
  if (cur) {
    try {
      return telegramStartLink(decrypt(cur.token_enc));
    } catch {
      // Clave de cifrado rotada: se genera uno nuevo.
    }
  }
  const token = randomToken(24);
  await db.query(
    `INSERT INTO telegram_link_tokens (token_hash, recipient_id, access_token_hash, expires_at, token_enc) VALUES ($1,$2,$3, now() + make_interval(mins => $4), $5)`,
    [sha256Hex(token), r.id, r.access_token_hash, Math.max(1, Math.floor(config.telegram.linkTtlMinutes)), encrypt(token)],
  );
  return telegramStartLink(token);
}

export async function telegramRoutes(app: FastifyInstance, s: Services) {
  app.post("/v1/integrations/telegram/webhook", async (req, reply) => {
    const secret = config.telegram.webhookSecret;
    // Largo en bytes (no en caracteres): con caracteres multibyte timingSafeEqual lanzaba y respondía 500.
    const got = Buffer.from(String(req.headers["x-telegram-bot-api-secret-token"] ?? ""));
    const want = Buffer.from(secret ?? "");
    if (!config.telegram.botToken || !secret || got.length !== want.length || !timingSafeEqual(got, want)) {
      return reply.code(401).send();
    }
    const msg = (req.body as any)?.message;
    const text: string = msg?.text ?? "";
    const chatId = msg?.chat?.id;
    const m = /^\/start\s+([A-Za-z0-9_-]{20,64})$/.exec(text.trim());
    if (!chatId || !m) return { ok: true };

    const linkHash = sha256Hex(m[1]);
    const lt = await s.db.one<any>(`SELECT recipient_id, access_token_hash FROM telegram_link_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [
      linkHash,
    ]);
    const r = lt ? await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1 AND access_token_hash = $2`, [lt.recipient_id, lt.access_token_hash]) : null;
    const e = r ? await s.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [r.envelope_id]) : null;
    if (!r || !e || e.status === "draft") {
      await sendTelegram({ to: String(chatId), text: MSG.unknown, link: null }).catch(() => {});
      return { ok: true };
    }
    const linked = await s.db.tx(async (t): Promise<boolean | "needs_otp"> => {
      const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      // Sobre anulado, rechazado o vencido: ya no hay avisos que recibir y no se suman eventos a su evidencia.
      if (["voided", "declined", "expired"].includes(cur?.status)) return false;
      // Con el sobre bloqueado, el link tiene que seguir vigente: una corrección del contacto (link nuevo, chat
      // desvinculado) o un reemplazo pudo confirmarse mientras tanto, y el chat de quien tenía el link anterior
      // recibiría los avisos (con el link nuevo) de la persona corregida.
      // Con solo el link no se toma el canal de otra persona: no se reemplaza un chat ya vinculado, y si el link pide
      // código (OTP), el titular tiene que haberse autenticado antes (el link reenviado no alcanza para ver el sobre,
      // pero sí servía para recibir los avisos con el asunto y dejar al titular sin ellos).
      // authenticated_at: lo marca el código validado y se borra al corregir el contacto (una validación del contacto
      // anterior no vale para el nuevo).
      if (String(r.auth_method ?? "").startsWith("otp")) {
        const cur = await t.one<{ authenticated_at: string | null }>(`SELECT authenticated_at FROM recipients WHERE id = $1`, [r.id]);
        if (!cur?.authenticated_at) return "needs_otp";
      }
      // Un solo uso: el token se consume con el sobre bloqueado (dos /start con el mismo link no vinculan dos chats).
      const used = await t.query(`UPDATE telegram_link_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING 1`, [linkHash]);
      if (!used.length) return false;
      const upd = await t.query(
        `UPDATE recipients SET telegram_chat_id = $2
          WHERE id = $1 AND access_token_hash = $3 AND (telegram_chat_id IS NULL OR telegram_chat_id = $2) RETURNING id`,
        [r.id, String(chatId), lt.access_token_hash],
      );
      if (!upd.length) return false;
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.telegram_linked",
        actor: { ...SYSTEM, label: "Telegram" },
        data: { recipientId: r.id, chatIdHash: sha256Hex(String(chatId)).slice(0, 16) },
      });
      return true;
    });
    if (linked !== true) {
      await sendTelegram({ to: String(chatId), text: linked === "needs_otp" ? MSG.needsOtp : MSG.unknown, link: null }).catch(() => {});
      return { ok: true };
    }
    const locale = normLocale(r.locale ?? e.locale);
    const link = e.status === "sent" && ["sent", "viewed"].includes(r.status) ? `${await envelopeBaseUrl(s.db, e.tenant_id, e.id)}/s/${decrypt(r.access_token_enc)}` : null;
    await sendTelegram({ to: String(chatId), text: MSG.linked[locale](e.subject), link, cta: MSG.cta[locale] }).catch((err) =>
      req.log.warn({ err: String(err) }, "no se pudo responder en Telegram"),
    );
    return { ok: true };
  });
}
