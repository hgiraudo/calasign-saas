import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { config } from "../config";
import { uuidv7 } from "../lib/util";
import { getSmsProvider } from "./sms";

export interface OutboundMessage {
  channel: "email" | "whatsapp" | "telegram" | "sms";
  to: string;
  subject: string;
  text: string;
  html?: string;
  link?: string | null;
  /** Para WhatsApp: parámetros de la plantilla aprobada. */
  templateParams?: string[];
  /** Para WhatsApp: plantilla a usar (por defecto, la del pedido de firma). */
  template?: string;
  locale?: string;
  /** Para filtrar el buzón de desarrollo por organización. */
  tenantId?: string;
  /** Marca blanca: remitente propio ("Firmas ACME <firmas@acme.com>"); sin esto, MAIL_FROM. */
  from?: string | null;
  replyTo?: string | null;
  /** Firma DKIM con la clave del dominio de correo verificado de la organización. */
  dkim?: { domainName: string; keySelector: string; privateKey: string } | null;
  /** SMS: remitente alfanumérico de la marca (si el proveedor y el país lo permiten). */
  smsFrom?: string | null;
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
    JSON.stringify({
      id,
      tenantId: m.tenantId ?? null,
      channel: m.channel,
      to: m.to,
      // Remitente y HTML: las pruebas de marca blanca revisan que no aparezca la marca de la plataforma.
      from: m.channel === "email" ? m.from ?? config.mail.from : m.channel === "sms" ? m.smsFrom ?? null : null,
      replyTo: m.replyTo ?? null,
      subject: m.subject,
      text: m.text,
      html: m.html ?? null,
      link: m.link ?? null,
      createdAt: new Date().toISOString(),
    }),
  );
  return { provider: "dev-mailbox", messageId: id };
}

export async function readMailbox(tenantId: string | null, limit = 100) {
  try {
    const files = (await readdir(mailboxDir)).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 2000);
    const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(resolve(mailboxDir, f), "utf8"))));
    return all.filter((m) => tenantId === null || m.tenantId === tenantId).slice(0, limit);
  } catch {
    return [];
  }
}

let transporter: nodemailer.Transporter | null = null;

// Timeouts explícitos: los de nodemailer por defecto llegan a 10 minutos de inactividad, lo mismo que espera el sweep
// para devolver a la cola un job "trabado". Un SMTP colgado haría que el aviso vuelva a la cola mientras el primer
// envío sigue vivo, y saldría dos veces. Los parámetros de la URL (p. ej. ?socketTimeout=) siguen teniendo prioridad.
const SMTP_TIMEOUTS = { dnsTimeout: 15_000, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 60_000 };

async function sendEmail(m: OutboundMessage): Promise<SendResult> {
  transporter ??= nodemailer.createTransport(new SMTPTransport({ ...SMTP_TIMEOUTS, url: config.mail.smtpUrl! }));
  const info = await transporter.sendMail({
    from: m.from ?? config.mail.from,
    // Con un remitente propio sin DKIM (dominio no verificado no llega acá: ver white-label/mail.ts) el sobre SMTP
    // sigue saliendo con la dirección de la plataforma, que es la que el proveedor autoriza (SPF).
    ...(m.from && !m.dkim ? { envelope: { from: addressOf(config.mail.from), to: m.to } } : {}),
    replyTo: m.replyTo ?? undefined,
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
    ...(m.dkim ? { dkim: m.dkim } : {}),
    // Rebotes y quejas por SNS (docs/CORREO-REBOTES.md).
    ...(config.mail.sesConfigurationSet ? { headers: { "X-SES-CONFIGURATION-SET": config.mail.sesConfigurationSet } } : {}),
  });
  // SES por SMTP responde "250 Ok <id de SES>": ese id (no el Message-ID del encabezado) es el que traen los avisos de
  // rebote y queja (mail.messageId) para asociarlos al envío.
  return { provider: "smtp", messageId: sesMessageId(info.response) ?? info.messageId ?? null };
}

/** Id de mensaje de SES en la respuesta SMTP ("250 Ok 0100018f…-000000"). */
export function sesMessageId(response: string | undefined | null): string | null {
  const m = /^250 Ok (\S+)\s*$/i.exec(String(response ?? "").trim());
  return m?.[1] ?? null;
}

/** "Nombre <a@b.com>" → "a@b.com". */
function addressOf(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
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
        name: m.template ?? template,
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
  if (m.channel === "sms") {
    const sms = getSmsProvider();
    // Sin buzón de desarrollo no se escribe nada en disco: el SMS lleva el código de verificación del firmante.
    if (!sms && !config.devMailbox) throw new Error("SMS no configurado");
    const r = config.devMailbox ? await toMailbox(m) : null;
    if (sms) return sms.send(m.to, m.text, m.smsFrom ?? undefined).then((x) => ({ provider: sms.id, messageId: x.messageId })).catch((e) => (r ? r : Promise.reject(e)));
    return r!;
  }
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

/**
 * Link t.me para que el firmante vincule su chat. El parámetro es un token de vinculación propio, de un solo uso y
 * de vida corta (telegram.ts telegramLinkFor), nunca el token de firma: el link pasa por los servidores de Telegram.
 */
export function telegramStartLink(linkToken: string): string | null {
  if (!config.telegram.botUsername) return null;
  return `https://t.me/${config.telegram.botUsername}?start=${linkToken}`;
}
