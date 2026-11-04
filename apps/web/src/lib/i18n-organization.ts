// Textos de Ajustes → Organización (huso horario y canales de terceros).
import { interpolate } from "./interpolate";
import { useI18n } from "./i18n";

const es = {
  "org.card": "Organización",
  "org.cardDesc": "Huso horario del certificado y canales de terceros (SMS, WhatsApp, Telegram).",
  "org.title": "Organización",
  "org.intro":
    "El huso horario con el que se escriben las horas del certificado de finalización y la fecha de los campos «Fecha de firma» del PDF, siempre con su desfase respecto de UTC. Se aplica a los sobres que se completen después del cambio.",
  "org.timeZone": "Huso horario",
  "org.now": "Ahora en ese huso: {time}",
  "org.save": "Guardar",
  "org.saved": "Guardado.",
  "org.readOnly": "Solo un administrador con permiso para cambiar los ajustes puede modificarlo.",
  "org.channels": "Canales de terceros",
  "org.channelsIntro":
    "Por dónde pueden salir los avisos, el código de verificación y el link para firmar en el celular. Un canal apagado no se puede elegir para ningún destinatario y deja de usarse en los sobres en curso: los avisos siguen saliendo por correo, que no se apaga.",
  "org.ch.sms": "SMS (Twilio)",
  "org.ch.smsDesc": "Código de verificación por SMS y link del celular. Recibe el teléfono del firmante y el código o el link.",
  "org.ch.whatsapp": "WhatsApp (Meta)",
  "org.ch.whatsappDesc": "Avisos, código de verificación y link del celular. Recibe el teléfono, el asunto y el link de firma.",
  "org.ch.telegram": "Telegram",
  "org.ch.telegramDesc": "Avisos al chat que vincula el firmante. Recibe el asunto y el link de firma.",
  "org.channelsOtpNote":
    "Si apagás SMS o WhatsApp, un firmante pendiente que se verifica por ese canal recibe el código por el otro al mismo teléfono (si está encendido); si no, no puede pedir el código hasta que el remitente cambie su verificación o vuelvas a encender el canal.",
  "org.channelsSave": "Guardar canales",
};
type Key = keyof typeof es;

const pt: Record<Key, string> = {
  "org.card": "Organização",
  "org.cardDesc": "Fuso horário do certificado e canais de terceiros (SMS, WhatsApp, Telegram).",
  "org.title": "Organização",
  "org.intro":
    "O fuso horário em que são escritas as horas do certificado de conclusão e a data dos campos «Data de assinatura» do PDF, sempre com a diferença em relação ao UTC. Vale para os envelopes concluídos depois da mudança.",
  "org.timeZone": "Fuso horário",
  "org.now": "Agora nesse fuso: {time}",
  "org.save": "Salvar",
  "org.saved": "Salvo.",
  "org.readOnly": "Somente um administrador com permissão para alterar as configurações pode modificá-lo.",
  "org.channels": "Canais de terceiros",
  "org.channelsIntro":
    "Por onde podem sair os avisos, o código de verificação e o link para assinar no celular. Um canal desativado não pode ser escolhido para nenhum destinatário e deixa de ser usado nos envelopes em andamento: os avisos continuam saindo por e-mail, que não se desativa.",
  "org.ch.sms": "SMS (Twilio)",
  "org.ch.smsDesc": "Código de verificação por SMS e link do celular. Recebe o telefone do signatário e o código ou o link.",
  "org.ch.whatsapp": "WhatsApp (Meta)",
  "org.ch.whatsappDesc": "Avisos, código de verificação e link do celular. Recebe o telefone, o assunto e o link de assinatura.",
  "org.ch.telegram": "Telegram",
  "org.ch.telegramDesc": "Avisos no chat que o signatário vincula. Recebe o assunto e o link de assinatura.",
  "org.channelsOtpNote":
    "Se você desativar SMS ou WhatsApp, um signatário pendente que se verifica por esse canal recebe o código pelo outro no mesmo telefone (se estiver ativo); se não, não consegue pedir o código até que o remetente mude a verificação ou você reative o canal.",
  "org.channelsSave": "Salvar canais",
};

const en: Record<Key, string> = {
  "org.card": "Organization",
  "org.cardDesc": "Certificate time zone and third-party channels (SMS, WhatsApp, Telegram).",
  "org.title": "Organization",
  "org.intro":
    "The time zone used for the times in the certificate of completion and for the “Date signed” fields in the PDF, always shown with its offset from UTC. It applies to envelopes completed after the change.",
  "org.timeZone": "Time zone",
  "org.now": "Now in that time zone: {time}",
  "org.save": "Save",
  "org.saved": "Saved.",
  "org.readOnly": "Only an administrator allowed to change settings can modify it.",
  "org.channels": "Third-party channels",
  "org.channelsIntro":
    "Where notifications, the verification code and the link to sign on a phone can go. A channel that's off can't be chosen for any recipient and stops being used in envelopes in progress: notifications keep going out by email, which can't be turned off.",
  "org.ch.sms": "SMS (Twilio)",
  "org.ch.smsDesc": "Verification code by SMS and the phone link. Receives the signer's phone number and the code or the link.",
  "org.ch.whatsapp": "WhatsApp (Meta)",
  "org.ch.whatsappDesc": "Notifications, verification code and the phone link. Receives the phone number, the subject and the signing link.",
  "org.ch.telegram": "Telegram",
  "org.ch.telegramDesc": "Notifications to the chat the signer links. Receives the subject and the signing link.",
  "org.channelsOtpNote":
    "If you turn off SMS or WhatsApp, a pending signer verified through that channel gets the code through the other one to the same phone (if it's on); otherwise they can't request the code until the sender changes their verification or you turn the channel back on.",
  "org.channelsSave": "Save channels",
};

const DICTS: Record<string, Record<Key, string>> = { es, "pt-BR": pt, en };

export function useOrganizationText() {
  const { locale } = useI18n();
  const d = DICTS[locale] ?? es;
  return (k: Key, vars?: Record<string, string | number>) => interpolate(d[k] ?? es[k], vars);
}
