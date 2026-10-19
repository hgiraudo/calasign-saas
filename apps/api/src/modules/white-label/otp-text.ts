// Marca blanca del código de verificación del firmante (correo/SMS/WhatsApp): plantilla "otp_code" de la marca,
// nombre del producto en lugar del de la plataforma y remitente propio.
import { fillTemplate } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { normLocale } from "../../notifications/templates";
import { brandForEnvelope, brandize, mailBranding, productLabel, senderFor, type ResolvedBrand } from "./brand";

const DEFAULT = {
  es: { subject: "Tu código de verificación de CalaSign", text: 'Tu código para firmar "{{subject}}" es {{code}}. Vence en 10 minutos. No lo compartas.' },
  "pt-BR": { subject: "Seu código de verificação da CalaSign", text: 'Seu código para assinar "{{subject}}" é {{code}}. Expira em 10 minutos. Não compartilhe.' },
  en: { subject: "Your CalaSign verification code", text: 'Your code to sign "{{subject}}" is {{code}}. It expires in 10 minutes. Don\'t share it.' },
} as const;

/** Asunto y texto del código con la marca (plantilla propia si la hay). */
export function OTP_MESSAGES(b: ResolvedBrand, localeIn: string, code: string, subject: string, def?: { subject: string; text: string }) {
  const locale = normLocale(localeIn);
  const tpl = mailBranding(b, "otp_code", locale).template;
  const vars = { code, subject, productName: productLabel(b), organizationName: b.name, supportUrl: b.links.supportUrl ?? "" };
  const s = tpl?.subject?.trim() ? fillTemplate(tpl.subject, vars) : def?.subject ?? fillTemplate(DEFAULT[locale].subject, vars);
  const t = tpl?.body?.trim() ? fillTemplate(tpl.body, vars) : def?.text ?? fillTemplate(DEFAULT[locale].text, vars);
  return { subject: brandize(s.replace(/[\r\n]+/g, " "), b), text: brandize(t, b) };
}

/**
 * Lo que otp.ts agrega al mensaje del código: asunto/texto con la marca y remitente propio. `defSubject`/`defText`
 * son los textos de la plataforma (se usan si la marca no tiene plantilla propia).
 */
export async function brandedOtpMessage(db: Db, e: { tenant_id: string; brand_id?: string | null; subject: string }, locale: string, code: string, defSubject: string, defText: string) {
  const b = await brandForEnvelope(db, e);
  const m = OTP_MESSAGES(b, locale, code, e.subject, { subject: defSubject, text: defText });
  const sender = await senderFor(db, b);
  return { subject: m.subject, text: m.text, from: sender.from, replyTo: sender.replyTo, dkim: sender.dkim, smsFrom: b.smsSenderId };
}
