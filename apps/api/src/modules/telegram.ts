// Webhook del bot de Telegram: vincula el chat del firmante cuando abre t.me/<bot>?start=<token>.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { SYSTEM, appendEvent } from "../infra/evidence";
import { decrypt, sha256Hex } from "../lib/util";
import { sendTelegram } from "../notifications/channels";
import { normLocale } from "../notifications/templates";
import type { Services } from "./context";

const MSG = {
  linked: {
    es: (s: string) => `Listo: vas a recibir por acá los avisos de "${s}".`,
    "pt-BR": (s: string) => `Pronto: você vai receber por aqui os avisos de "${s}".`,
    en: (s: string) => `Done: you'll get notifications for "${s}" here.`,
  },
  cta: { es: "Revisar y firmar", "pt-BR": "Revisar e assinar", en: "Review and sign" },
  unknown: "CalaSign: link inválido o vencido. / Link inválido ou expirado. / Invalid or expired link.",
};

export async function telegramRoutes(app: FastifyInstance, s: Services) {
  app.post("/v1/integrations/telegram/webhook", async (req, reply) => {
    const secret = config.telegram.webhookSecret;
    const got = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    if (!config.telegram.botToken || !secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
      return reply.code(401).send();
    }
    const msg = (req.body as any)?.message;
    const text: string = msg?.text ?? "";
    const chatId = msg?.chat?.id;
    const m = /^\/start\s+([A-Za-z0-9_-]{20,64})$/.exec(text.trim());
    if (!chatId || !m) return { ok: true };

    const token = m[1];
    const r = await s.db.one<any>(`SELECT * FROM recipients WHERE access_token_hash = $1`, [sha256Hex(token)]);
    const e = r ? await s.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [r.envelope_id]) : null;
    if (!r || !e || e.status === "draft") {
      await sendTelegram({ to: String(chatId), text: MSG.unknown, link: null }).catch(() => {});
      return { ok: true };
    }
    await s.db.tx(async (t) => {
      await t.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      await t.query(`UPDATE recipients SET telegram_chat_id = $2 WHERE id = $1`, [r.id, String(chatId)]);
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.telegram_linked",
        actor: { ...SYSTEM, label: "Telegram" },
        data: { recipientId: r.id, chatIdHash: sha256Hex(String(chatId)).slice(0, 16) },
      });
    });
    const locale = normLocale(r.locale ?? e.locale);
    const link = e.status === "sent" && ["sent", "viewed"].includes(r.status) ? `${config.appUrl}/s/${decrypt(r.access_token_enc)}` : null;
    await sendTelegram({ to: String(chatId), text: MSG.linked[locale](e.subject), link, cta: MSG.cta[locale] }).catch((err) =>
      req.log.warn({ err: String(err) }, "no se pudo responder en Telegram"),
    );
    return { ok: true };
  });
}
