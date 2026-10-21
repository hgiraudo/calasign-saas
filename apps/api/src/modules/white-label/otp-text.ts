// Marca blanca del código de verificación del firmante (correo/SMS/WhatsApp): plantilla "otp_code" de la marca,
// nombre del producto en lugar del de la plataforma y remitente propio.
import { fillTemplate } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { maskVars, normLocale } from "../../notifications/templates";
import { brandForEnvelope, brandize, mailBranding, productLabel, senderFor, type ResolvedBrand } from "./brand";

const DEFAULT = {
  es: { subject: "Tu código de verificación de CalaSign", text: 'Tu código para firmar "{{subject}}" es {{code}}. Vence en 10 minutos. No lo compartas.' },
  "pt-BR": { subject: "Seu código de verificação da CalaSign", text: 'Seu código para assinar "{{subject}}" é {{code}}. Expira em 10 minutos. Não compartilhe.' },
  en: { subject: "Your CalaSign verification code", text: 'Your code to sign "{{subject}}" is {{code}}. It expires in 10 minutes. Don\'t share it.' },
} as const;

const CODE_LABEL = { es: "Código", "pt-BR": "Código", en: "Code" } as const;

/** Si la plantilla del código incluye la variable {{code}} (con o sin espacios). */
export function hasCodeVariable(body: string): boolean {
  return /\{\{\s*code\s*\}\}/.test(body);
}

/** Asunto y texto del código con la marca (plantilla propia si la hay). */
export function OTP_MESSAGES(b: ResolvedBrand, localeIn: string, code: string, subject: string, def?: { subject: string; text: (code: string, subject: string) => string }) {
  const locale = normLocale(localeIn);
  const tpl = mailBranding(b, "otp_code", locale).template;
  // Valores enmascarados: la marca blanca reemplaza el nombre de la plataforma en la plantilla, no en el asunto del sobre.
  const { masked: vars, unmask } = maskVars({ code, subject, productName: productLabel(b), organizationName: b.name, supportUrl: b.links.supportUrl ?? "" });
  const s = tpl?.subject?.trim() ? fillTemplate(tpl.subject, vars) : def?.subject ?? fillTemplate(DEFAULT[locale].subject, vars);
  let t = tpl?.body?.trim() ? fillTemplate(tpl.body, vars) : def ? def.text(vars.code, vars.subject) : fillTemplate(DEFAULT[locale].text, vars);
  // Plantilla propia sin {{code}} (guardada antes de que se validara): sin esto el firmante recibía un mensaje sin el
  // código y no podía firmar. Se agrega al final.
  if (tpl?.body?.trim() && !hasCodeVariable(tpl.body)) t = `${t.trimEnd()}\n\n${CODE_LABEL[locale]}: ${vars.code}`;
  return { subject: unmask(brandize(s.replace(/[\r\n]+/g, " "), b)).replace(/[\r\n]+/g, " "), text: unmask(brandize(t, b)) };
}

/** Texto corto del código por SMS (cada segmento cuesta; Twilio corta en 1600): código primero y asunto recortado. */
const SMS_SHORT = {
  es: (code: string, product: string, subject: string) => `${code} es tu código de ${product} para firmar "${subject}". Vence en 10 min. No lo compartas.`,
  "pt-BR": (code: string, product: string, subject: string) => `${code} é seu código da ${product} para assinar "${subject}". Expira em 10 min. Não compartilhe.`,
  en: (code: string, product: string, subject: string) => `${code} is your ${product} code to sign "${subject}". Expires in 10 min. Don't share it.`,
} as const;
const SMS_SUBJECT_MAX = 40;
/** Plantilla propia de la marca: hasta ~2 segmentos. */
export const SMS_OTP_MAX = 320;
/** Más que esto (tope de Twilio) o sin el código: se usa el texto corto. */
const SMS_OTP_HARD_MAX = 1600;

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`;
}

/**
 * Texto del código por SMS: con plantilla "otp_code" de la marca, esa (recortada a SMS_OTP_MAX); si no la hay, si
 * pasa de 1600 caracteres o si al recortarla se pierde el código, el texto corto (código, producto y asunto recortado).
 */
export function otpSmsText(b: ResolvedBrand, localeIn: string, code: string, subject: string): string {
  const locale = normLocale(localeIn);
  const short = SMS_SHORT[locale](code, productLabel(b), clip(subject, SMS_SUBJECT_MAX));
  if (!mailBranding(b, "otp_code", locale).template?.body?.trim()) return short;
  const full = OTP_MESSAGES(b, locale, code, subject).text.trim();
  if (full.length > SMS_OTP_HARD_MAX || !full.includes(code)) return short;
  if (full.length <= SMS_OTP_MAX) return full;
  const cut = clip(full, SMS_OTP_MAX);
  return cut.includes(code) ? cut : short;
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
  return { subject: m.subject, text, from: sender.from, replyTo: sender.replyTo, dkim: sender.dkim, fallbackFrom: sender.fallbackFrom, smsFrom: b.smsSenderId };
}
