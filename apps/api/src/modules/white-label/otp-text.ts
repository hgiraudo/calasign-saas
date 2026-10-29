// Marca blanca del código de verificación del firmante (correo/SMS/WhatsApp): plantilla "otp_code" de la marca,
// nombre del producto en lugar del de la plataforma y remitente propio.
import { fillTemplate } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { maskVars, normLocale } from "../../notifications/templates";
import { brandForEnvelope, brandize, mailBranding, productLabel, senderFor, type ResolvedBrand } from "./brand";

const DEFAULT = {
  es: {
    subject: "Tu código de verificación de CalaSign",
    text: 'Tu código para firmar "{{subject}}" es {{code}}. Vence en 10 minutos. No lo compartas.',
  },
  "pt-BR": {
    subject: "Seu código de verificação da CalaSign",
    text: 'Seu código para assinar "{{subject}}" é {{code}}. Expira em 10 minutos. Não compartilhe.',
  },
  en: { subject: "Your CalaSign verification code", text: 'Your code to sign "{{subject}}" is {{code}}. It expires in 10 minutes. Don\'t share it.' },
} as const;

const CODE_LABEL = { es: "Código", "pt-BR": "Código", en: "Code" } as const;

/** Si la plantilla del código incluye la variable {{code}} (con o sin espacios). */
export function hasCodeVariable(body: string): boolean {
  return /\{\{\s*code\s*\}\}/.test(body);
}

/** Asunto y texto del código con la marca (plantilla propia si la hay). */
export function OTP_MESSAGES(
  b: ResolvedBrand,
  localeIn: string,
  code: string,
  subject: string,
  def?: { subject: string; text: (code: string, subject: string) => string },
) {
  const locale = normLocale(localeIn);
  const tpl = mailBranding(b, "otp_code", locale).template;
  // Valores enmascarados: la marca blanca reemplaza el nombre de la plataforma en la plantilla, no en el asunto del sobre.
  const { masked: vars, unmask } = maskVars({
    code,
    subject,
    productName: productLabel(b),
    organizationName: b.name,
    supportUrl: b.links.supportUrl ?? "",
  });
  const s = tpl?.subject?.trim() ? fillTemplate(tpl.subject, vars) : (def?.subject ?? fillTemplate(DEFAULT[locale].subject, vars));
  let t = tpl?.body?.trim() ? fillTemplate(tpl.body, vars) : def ? def.text(vars.code, vars.subject) : fillTemplate(DEFAULT[locale].text, vars);
  // Plantilla propia sin {{code}} (guardada antes de que se validara): sin esto el firmante recibía un mensaje sin el
  // código y no podía firmar. Se agrega al final.
  if (tpl?.body?.trim() && !hasCodeVariable(tpl.body)) t = `${t.trimEnd()}\n\n${CODE_LABEL[locale]}: ${vars.code}`;
  return { subject: unmask(brandize(s.replace(/[\r\n]+/g, " "), b)).replace(/[\r\n]+/g, " "), text: unmask(brandize(t, b)) };
}

/**
 * Texto corto del código por SMS: sólo caracteres GSM-7 (sin tildes: con una sola letra fuera de GSM-7 el mensaje pasa a
 * UCS-2 y entra en 70 caracteres por segmento en vez de 160), para que entre en un segmento.
 */
const SMS_SHORT = {
  es: (code: string, product: string) => `Tu codigo de ${product}: ${code}. Vence en 10 min. No lo compartas.`,
  "pt-BR": (code: string, product: string) => `Seu codigo da ${product}: ${code}. Expira em 10 min. Nao compartilhe.`,
  en: (code: string, product: string) => `Your ${product} code: ${code}. Expires in 10 min. Don't share it.`,
} as const;
/** Sin el nombre del producto: último recurso si con él no entra en un segmento GSM-7. */
const SMS_SHORT_BARE = {
  es: (code: string) => `Tu codigo de verificacion: ${code}. Vence en 10 min. No lo compartas.`,
  "pt-BR": (code: string) => `Seu codigo de verificacao: ${code}. Expira em 10 min. Nao compartilhe.`,
  en: (code: string) => `Your verification code: ${code}. Expires in 10 min. Don't share it.`,
} as const;
const SMS_PRODUCT_MAX = 30;
/** Plantilla propia de la marca: hasta 2 segmentos (cada segmento se cobra); si no entra, el texto corto. */
export const SMS_OTP_MAX_SEGMENTS = 2;

const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** Ocupan dos septetos (escape + carácter). */
const GSM7_EXTENDED = new Set("^{}\\[~]|€\f");

/**
 * Segmentos que ocupa un SMS: GSM-7 si todos los caracteres lo son (160 por mensaje, 153 por segmento si va partido;
 * los de la tabla extendida cuentan doble), si no UCS-2 (70, o 67 por segmento, en unidades UTF-16).
 */
export function smsSegments(text: string): number {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7_BASIC.has(ch)) septets += 1;
    else if (GSM7_EXTENDED.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  return text.length <= 70 ? 1 : Math.ceil(text.length / 67);
}

/**
 * Nombre del producto en GSM-7: los caracteres que ya lo son quedan (é, ñ, ü, Ç...); el resto se translitera quitando
 * los diacríticos (á→a, ã→a, ç→c, õ→o) y lo que aun así no entra en GSM-7 se descarta. Con una sola letra fuera de
 * GSM-7 el SMS pasa a UCS-2 (70 caracteres) y el texto corto ocupa 2 segmentos.
 */
export function toGsm7(s: string): string {
  let out = "";
  for (const ch of s) {
    if (GSM7_BASIC.has(ch) || GSM7_EXTENDED.has(ch)) {
      out += ch;
      continue;
    }
    for (const c of ch.normalize("NFD").replace(/\p{M}/gu, "")) if (GSM7_BASIC.has(c) || GSM7_EXTENDED.has(c)) out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/**
 * Texto del código por SMS: con plantilla "otp_code" de la marca, esa si entra en SMS_OTP_MAX_SEGMENTS segmentos y
 * lleva el código; si no (o sin plantilla), el texto corto (código y producto, en GSM-7).
 */
export function otpSmsText(b: ResolvedBrand, localeIn: string, code: string, subject: string): string {
  const locale = normLocale(localeIn);
  const product = clip(toGsm7(productLabel(b)), SMS_PRODUCT_MAX);
  let short = product ? SMS_SHORT[locale](code, product) : SMS_SHORT_BARE[locale](code);
  // Último resguardo (p. ej. caracteres de la tabla extendida que cuentan doble): sin el nombre del producto.
  if (smsSegments(short) > 1) short = SMS_SHORT_BARE[locale](code);
  if (!mailBranding(b, "otp_code", locale).template?.body?.trim()) return short;
  const full = OTP_MESSAGES(b, locale, code, subject).text.trim();
  return full.includes(code) && smsSegments(full) <= SMS_OTP_MAX_SEGMENTS ? full : short;
}

/**
 * Lo que otp.ts agrega al mensaje del código: asunto/texto con la marca y remitente propio. `defSubject`/`defText`
 * son los textos de la plataforma (se usan si la marca no tiene plantilla propia); `defText` arma el texto con el código
 * y el asunto (se le pasan enmascarados para que la marca blanca no toque el asunto del sobre). Por SMS, el texto corto
 * de otpSmsText.
 */
export async function brandedOtpMessage(
  db: Db,
  e: { tenant_id: string; brand_id?: string | null; subject: string },
  locale: string,
  code: string,
  defSubject: string,
  defText: (code: string, subject: string) => string,
  channel?: string,
) {
  const b = await brandForEnvelope(db, e);
  const m = OTP_MESSAGES(b, locale, code, e.subject, { subject: defSubject, text: defText });
  const text = channel === "sms" ? otpSmsText(b, locale, code, e.subject) : m.text;
  const sender = await senderFor(db, b);
  return {
    subject: m.subject,
    text,
    from: sender.from,
    replyTo: sender.replyTo,
    dkim: sender.dkim,
    fallbackFrom: sender.fallbackFrom,
    smsFrom: b.smsSenderId,
  };
}
