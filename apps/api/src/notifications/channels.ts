import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import { config } from "../config";
import { uuidv7 } from "../lib/util";

export interface OutboundMessage {
  channel: "email" | "whatsapp" | "telegram";
  to: string;
  subject: string;
  text: string;
  html?: string;
  link?: string | null;
  /** Para WhatsApp: parámetros de la plantilla aprobada. */
  templateParams?: string[];
  locale?: string;
}

export interface SendResult {
  provider: string;
  messageId: string | null;
}

const mailboxDir = resolve(config.dataDir, "mailbox");

async function toMailbox(m: OutboundMessage): Promise<SendResult> {
  await mkdir(mailboxDir, { recursive: true });
  const id = uuidv7();
  await writeFile(
    resolve(mailboxDir, `${id}.json`),
    JSON.stringify({ id, channel: m.channel, to: m.to, subject: m.subject, text: m.text, link: m.link ?? null, createdAt: new Date().toISOString() }),
  );
  return { provider: "dev-mailbox", messageId: id };
}

export async function readMailbox(limit = 100) {
  try {
    const files = (await readdir(mailboxDir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(resolve(mailboxDir, f), "utf8"))));
  } catch {
    return [];
  }
}

let transporter: nodemailer.Transporter | null = null;

async function sendEmail(m: OutboundMessage): Promise<SendResult> {
  transporter ??= nodemailer.createTransport(config.mail.smtpUrl!);
  const info = await transporter.sendMail({ from: config.mail.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
  return { provider: "smtp", messageId: info.messageId ?? null };
}

const WA_LANG: Record<string, string> = { es: "es", "pt-BR": "pt_BR", en: "en" };

async function sendWhatsApp(m: OutboundMessage): Promise<SendResult> {
  const { token, phoneNumberId, template } = config.whatsapp;
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: m.to.replace(/^\+/, ""),
      type: "template",
      template: {
        name: template,
        language: { code: WA_LANG[m.locale ?? "es"] ?? "es" },
        components: [{ type: "body", parameters: (m.templateParams ?? []).map((text) => ({ type: "text", text })) }],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(body?.error ?? body).slice(0, 300)}`);
  return { provider: "whatsapp-cloud", messageId: body?.messages?.[0]?.id ?? null };
}

/** Telegram Bot API. `to` es el chat_id. El link va como botón (Telegram solo acepta https en botones). */
export async function sendTelegram(m: Pick<OutboundMessage, "to" | "text" | "link"> & { cta?: string | null }): Promise<SendResult> {
  const https = m.link?.startsWith("https://");
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: m.to,
      text: https || !m.link ? m.text : `${m.text}\n\n${m.link}`,
      disable_web_page_preview: true,
      ...(https ? { reply_markup: { inline_keyboard: [[{ text: m.cta ?? "Abrir", url: m.link }]] } } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`Telegram API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return { provider: "telegram-bot", messageId: String(body.result?.message_id ?? "") || null };
}

const telegramReady = () => Boolean(config.telegram.botToken);

export async function deliver(m: OutboundMessage & { cta?: string | null }): Promise<SendResult> {
  if (config.devMailbox) {
    const r = await toMailbox(m);
    // En desarrollo, si además hay proveedor real configurado, se envía también.
    if (m.channel === "email" && config.mail.smtpUrl) return sendEmail(m).catch(() => r);
    if (m.channel === "whatsapp" && config.whatsapp.token && config.whatsapp.phoneNumberId) return sendWhatsApp(m).catch(() => r);
    if (m.channel === "telegram" && telegramReady()) return sendTelegram(m).catch(() => r);
    return r;
  }
  if (m.channel === "email") {
    if (!config.mail.smtpUrl) throw new Error("SMTP_URL no configurado");
    return sendEmail(m);
  }
  if (m.channel === "telegram") {
    if (!telegramReady()) throw new Error("Telegram no configurado");
    return sendTelegram(m);
  }
  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) throw new Error("WhatsApp no configurado");
  return sendWhatsApp(m);
}

/** Link t.me para que el firmante vincule su chat. El parámetro es su token de firma (máx. 64 chars). */
export function telegramStartLink(signingToken: string): string | null {
  if (!config.telegram.botUsername) return null;
  return `https://t.me/${config.telegram.botUsername}?start=${signingToken}`;
}
