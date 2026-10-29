import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import nodemailer, { type SMTPSentMessageInfo, type SMTPTransportOptions, type Transporter } from "nodemailer";
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
  /**
   * Para WhatsApp: parámetros del botón URL (índice 0) de la plantilla. Las plantillas de autenticación de Meta
   * (código de verificación) exigen el código también acá, en el botón de copiar código.
   */
  buttonParams?: string[];
  locale?: string;
  /** Para filtrar el buzón de desarrollo por organización. */
  tenantId?: string;
  /** Marca blanca: remitente propio ("Firmas ACME <firmas@acme.com>"); sin esto, MAIL_FROM. */
  from?: string | null;
  replyTo?: string | null;
  /** Firma DKIM con la clave del dominio de correo verificado de la organización. */
  dkim?: { domainName: string; keySelector: string; privateKey: string } | null;
  /**
   * Remitente de reserva (dirección de la plataforma con el nombre de la marca) si SES rechaza el dominio propio por
   * no estar verificado en SES (554). Sin esto, el nombre de `from` con MAIL_FROM.
   */
  fallbackFrom?: string | null;
  /** SMS: remitente alfanumérico de la marca (si el proveedor y el país lo permiten). */
  smsFrom?: string | null;
}

export interface SendResult {
  provider: string;
  messageId: string | null;
  /** El dominio propio fue rechazado por SES (identidad sin verificar) y el correo salió desde la plataforma. */
  identityRejectedDomain?: string | null;
  /**
   * Con identityRejectedDomain: el dominio estaba en espera por un rechazo reciente y el correo salió directo desde la
   * plataforma (sin otro intento). Solo informativo (log/métricas): no vuelve a anotar el aviso en el dominio (solo un
   * rechazo real lo anota; ver noteDkimSendResult).
   */
  identityBackoff?: boolean;
  /** El correo salió firmado con DKIM desde el dominio propio (SES lo aceptó). */
  dkimDomain?: string | null;
}

const mailboxDir = resolve(config.dataDir, "mailbox");
/** Los mensajes del buzón de desarrollo se borran a los 7 días (antes se acumulaban sin límite en DATA_DIR). */
const MAILBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** La purga recorre el buzón entero: se hace en la primera escritura y después cada tantas, no en todas. */
const MAILBOX_PURGE_EVERY = 50;
let mailboxWrites = 0;

/**
 * Subcarpeta por organización (mailbox/<tenantId>/): leer el buzón de una organización ya no abre los mensajes de todas.
 * Un id inesperado (no es una ruta segura) o sin organización va a "_none". Los mensajes viejos en la raíz se siguen leyendo.
 */
function tenantFolder(tenantId: string | null | undefined) {
  return tenantId && /^[A-Za-z0-9_-]{1,64}$/.test(tenantId) ? tenantId : "_none";
}

async function purgeMailbox() {
  const cutoff = Date.now() - MAILBOX_MAX_AGE_MS;
  const purgeDir = async (dir: string, depth: number) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = resolve(dir, e.name);
      if (e.isDirectory() && depth === 0) await purgeDir(p, 1);
      else if (e.isFile() && e.name.endsWith(".json")) {
        const st = await stat(p).catch(() => null);
        if (st && st.mtimeMs < cutoff) await rm(p, { force: true });
      }
    }
  };
  await purgeDir(mailboxDir, 0);
}

async function toMailbox(m: OutboundMessage): Promise<SendResult> {
  const dir = resolve(mailboxDir, tenantFolder(m.tenantId));
  await mkdir(dir, { recursive: true });
  const id = uuidv7();
  await writeFile(
    resolve(dir, `${id}.json`),
    JSON.stringify({
      id,
      tenantId: m.tenantId ?? null,
      channel: m.channel,
      to: m.to,
      // Remitente y HTML: las pruebas de marca blanca revisan que no aparezca la marca de la plataforma.
      from: m.channel === "email" ? (m.from ?? config.mail.from) : m.channel === "sms" ? (m.smsFrom ?? null) : null,
      replyTo: m.replyTo ?? null,
      subject: m.subject,
      text: m.text,
      html: m.html ?? null,
      link: m.link ?? null,
      createdAt: new Date().toISOString(),
    }),
  );
  // Sin esperarla ni hacer fallar el envío: es limpieza.
  if (mailboxWrites++ % MAILBOX_PURGE_EVERY === 0) void purgeMailbox().catch(() => {});
  return { provider: "dev-mailbox", messageId: id };
}

/** Archivos .json de una carpeta del buzón (vacío si no existe). */
async function mailboxFiles(dir: string) {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((f) => f.endsWith(".json")).map((f) => ({ name: f, path: resolve(dir, f) }));
}

export async function readMailbox(tenantId: string | null, limit = 100) {
  try {
    // La raíz tiene los mensajes de antes de las subcarpetas (de todas las organizaciones: se filtran por tenantId).
    const files = await mailboxFiles(mailboxDir);
    if (tenantId === null) {
      const dirs = (await readdir(mailboxDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory());
      for (const d of dirs) files.push(...(await mailboxFiles(resolve(mailboxDir, d.name))));
    } else {
      files.push(...(await mailboxFiles(resolve(mailboxDir, tenantFolder(tenantId)))));
    }
    // Nombres uuidv7: el orden alfabético es el cronológico.
    const recent = files.sort((x, y) => (x.name < y.name ? 1 : x.name > y.name ? -1 : 0)).slice(0, 2000);
    // Un archivo que la purga borró entre el listado y la lectura (o a medio escribir) se saltea, no vacía la respuesta.
    const all = await Promise.all(
      recent.map(async (f) => {
        try {
          return JSON.parse(await readFile(f.path, "utf8"));
        } catch {
          return null;
        }
      }),
    );
    return all.filter((m) => m && (tenantId === null || m.tenantId === tenantId)).slice(0, limit);
  } catch {
    return [];
  }
}

// nodemailer 10 trae sus propios tipos (ya no @types/nodemailer): sin namespace, se importan los tipos por nombre.
let transporter: Transporter<SMTPSentMessageInfo, SMTPTransportOptions> | null = null;

// Timeouts explícitos: los de nodemailer por defecto llegan a 10 minutos de inactividad, lo mismo que espera el sweep
// para devolver a la cola un job "trabado". Un SMTP colgado haría que el aviso vuelva a la cola mientras el primer
// envío sigue vivo, y saldría dos veces. Los parámetros de la URL (p. ej. ?socketTimeout=) siguen teniendo prioridad.
const SMTP_TIMEOUTS = { dnsTimeout: 15_000, connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 60_000 };

/** Solo para pruebas: reemplaza el transporte SMTP (null: se vuelve a crear con SMTP_URL). */
export function setMailTransportForTests(t: Pick<Transporter<SMTPSentMessageInfo, SMTPTransportOptions>, "sendMail"> | null) {
  transporter = t as Transporter<SMTPSentMessageInfo, SMTPTransportOptions> | null;
}

/**
 * Rechazo de SES por remitente sin verificar en SES ("554 Message rejected: Email address is not verified. The
 * following identities failed the check…"). Es permanente: reintentar el mismo remitente no sirve.
 */
export function isSesIdentityRejection(err: unknown): boolean {
  const e = err as any;
  const msg = String(e?.response ?? e?.message ?? e ?? "");
  const is554 = Number(e?.responseCode) === 554 || /(^|\s)554[\s-]/.test(msg);
  return is554 && /not verified|identities failed the check/i.test(msg);
}

/** Nombre visible de un remitente ("Firmas ACME" <a@b.com> → Firmas ACME). */
function displayNameOf(from: string): string | null {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  return m?.[1]?.trim() || null;
}

/** Dirección de la plataforma con el nombre de la marca: reserva si SES rechaza el dominio propio. */
function platformFallbackFrom(m: OutboundMessage): string {
  if (m.fallbackFrom) return m.fallbackFrom;
  const name = m.from ? displayNameOf(m.from) : null;
  return name ? `"${name.replace(/["\\\r\n]/g, "")}" <${addressOf(config.mail.from)}>` : config.mail.from;
}

/** Después de que SES rechaza un dominio propio, durante este tiempo los correos de ese dominio salen directamente desde
 *  la plataforma (sin un intento que se sabe que va a fallar en cada correo). En memoria, por proceso. */
const SES_IDENTITY_BACKOFF_MS = 15 * 60_000;
const sesIdentityBackoff = new Map<string, number>();

function inSesIdentityBackoff(domain: string): boolean {
  const until = sesIdentityBackoff.get(domain.toLowerCase());
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  sesIdentityBackoff.delete(domain.toLowerCase());
  return false;
}

/** Sólo para las pruebas. */
export function resetSesIdentityBackoffForTests() {
  sesIdentityBackoff.clear();
}

export async function sendEmail(m: OutboundMessage): Promise<SendResult> {
  transporter ??= nodemailer.createTransport(new SMTPTransport({ ...SMTP_TIMEOUTS, url: config.mail.smtpUrl! }));
  const send = (msg: OutboundMessage) =>
    transporter!.sendMail({
      from: msg.from ?? config.mail.from,
      // Con un remitente propio sin DKIM (dominio no verificado no llega acá: ver white-label/mail.ts) el sobre SMTP
      // sigue saliendo con la dirección de la plataforma, que es la que el proveedor autoriza (SPF).
      ...(msg.from && !msg.dkim ? { envelope: { from: addressOf(config.mail.from), to: msg.to } } : {}),
      replyTo: msg.replyTo ?? undefined,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      ...(msg.dkim ? { dkim: msg.dkim } : {}),
      // Rebotes y quejas por SNS (docs/CORREO-REBOTES.md).
      ...(isSesSmtp() ? { headers: sesHeaders(config.mail.sesConfigurationSet, msg.tenantId) } : {}),
    });
  const viaPlatform = (msg: OutboundMessage) =>
    send({ ...msg, from: platformFallbackFrom(msg), dkim: null, replyTo: msg.replyTo ?? (msg.from ? addressOf(msg.from) : null) });
  let info: SMTPSentMessageInfo;
  let identityRejectedDomain: string | null = null;
  let dkimDomain: string | null = null;
  let identityBackoff = false;
  if (m.dkim && inSesIdentityBackoff(m.dkim.domainName)) {
    // SES rechazó este dominio hace poco: directo desde la plataforma, sin otro intento fallido. Se informa con
    // identityBackoff (quien llama no vuelve a anotar el aviso: no hubo un rechazo nuevo).
    info = await viaPlatform(m);
    identityRejectedDomain = m.dkim.domainName;
    identityBackoff = true;
  } else {
    try {
      info = await send(m);
      dkimDomain = m.dkim?.domainName ?? null;
    } catch (err) {
      // Dominio propio verificado por DNS (DKIM) pero no como identidad en SES: SES lo rechaza siempre (554). Se reintenta
      // una vez desde la dirección de la plataforma con el nombre de la marca, y quien llama marca el dominio.
      if (!m.dkim || !isSesIdentityRejection(err)) throw err;
      identityRejectedDomain = m.dkim.domainName;
      sesIdentityBackoff.set(identityRejectedDomain.toLowerCase(), Date.now() + SES_IDENTITY_BACKOFF_MS);
      info = await viaPlatform(m);
    }
  }
  // SES por SMTP responde "250 Ok <id de SES>": ese id (no el Message-ID del encabezado) es el que traen los avisos de
  // rebote y queja (mail.messageId) para asociarlos al envío.
  return {
    provider: "smtp",
    messageId: sesMessageId(info.response) ?? info.messageId ?? null,
    ...(identityRejectedDomain ? { identityRejectedDomain } : {}),
    ...(identityBackoff ? { identityBackoff } : {}),
    ...(dkimDomain ? { dkimDomain } : {}),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SMTP de SES: configuration set configurado o el host email-smtp.<región>.amazonaws.com. */
function isSesSmtp(): boolean {
  if (config.mail.sesConfigurationSet) return true;
  try {
    return /^email-smtp(-fips)?\.[a-z0-9-]+\.amazonaws\.com$/i.test(new URL(config.mail.smtpUrl ?? "").hostname);
  } catch {
    return false;
  }
}

/**
 * Encabezados para SES: el configuration set (si hay) y, si el correo es de una organización, la etiqueta
 * tenant=<id>. SES la devuelve en los eventos de rebote/queja del configuration set (mail.tags) y con ella una queja
 * se atribuye a la organización aunque el correo no haya dejado fila en notifications. SES quita los X-SES-* antes de
 * entregar: solo se mandan por SES (con otro SMTP llegarían al destinatario).
 */
export function sesHeaders(configurationSet: string | null | undefined, tenantId?: string | null): Record<string, string> {
  return {
    ...(configurationSet ? { "X-SES-CONFIGURATION-SET": configurationSet } : {}),
    ...(tenantId && UUID_RE.test(tenantId) ? { "X-SES-MESSAGE-TAGS": `tenant=${tenantId.toLowerCase()}` } : {}),
  };
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

/**
 * Idioma de la plantilla para Meta: el del destinatario si está aprobado (WHATSAPP_TEMPLATE_LANGS); si no, español; si
 * el español tampoco está aprobado, el primero de la lista. Pedir un idioma sin aprobar hace que Meta rechace el mensaje
 * (132001).
 */
export function whatsAppLanguage(locale: string | undefined, approved: string[] = config.whatsapp.templateLangs): string {
  const langs = approved.map((x) => x.trim().replace(/-/g, "_")).filter(Boolean);
  const code = WA_LANG[locale ?? "es"] ?? "es";
  if (langs.includes(code)) return code;
  return langs.includes("es") || !langs.length ? "es" : langs[0]!;
}

/** Cuerpo del POST a la Cloud API de WhatsApp (separado para poder probarlo). */
export function whatsAppPayload(m: OutboundMessage) {
  const components: unknown[] = [{ type: "body", parameters: (m.templateParams ?? []).map((text) => ({ type: "text", text })) }];
  if (m.buttonParams?.length) {
    components.push({ type: "button", sub_type: "url", index: "0", parameters: m.buttonParams.map((text) => ({ type: "text", text })) });
  }
  return {
    messaging_product: "whatsapp",
    to: m.to.replace(/^\+/, ""),
    type: "template",
    template: { name: m.template ?? config.whatsapp.template, language: { code: whatsAppLanguage(m.locale) }, components },
  };
}

async function sendWhatsApp(m: OutboundMessage): Promise<SendResult> {
  const { token, phoneNumberId } = config.whatsapp;
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(whatsAppPayload(m)),
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
    if (sms)
      return sms
        .send(m.to, m.text, m.smsFrom ?? undefined)
        .then((x) => ({ provider: sms.id, messageId: x.messageId }))
        .catch((e) => (r ? r : Promise.reject(e)));
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
