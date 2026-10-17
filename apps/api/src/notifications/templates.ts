export type TemplateKind = "invite" | "reminder" | "completed" | "declined" | "voided" | "sender_completed" | "sender_declined";

export interface TemplateVars {
  recipientName: string;
  senderName: string;
  organizationName: string;
  subject: string;
  message?: string | null;
  link?: string | null;
  reason?: string | null;
  declinedBy?: string | null;
}

type Dict = Record<TemplateKind, { subject: (v: TemplateVars) => string; lines: (v: TemplateVars) => string[]; cta?: string }>;

const T: Record<"es" | "pt-BR" | "en", Dict> = {
  es: {
    invite: {
      subject: (v) => `${v.senderName} te envió "${v.subject}" para firmar`,
      lines: (v) => [`Hola ${v.recipientName}:`, `${v.senderName} (${v.organizationName}) te envió un documento para firmar electrónicamente.`],
      cta: "Revisar y firmar",
    },
    reminder: {
      subject: (v) => `Recordatorio: "${v.subject}" espera tu firma`,
      lines: (v) => [`Hola ${v.recipientName}:`, `Te recordamos que ${v.senderName} (${v.organizationName}) está esperando tu firma.`],
      cta: "Revisar y firmar",
    },
    completed: {
      subject: (v) => `Completado: "${v.subject}"`,
      lines: (v) => [`Hola ${v.recipientName}:`, `Todas las partes firmaron "${v.subject}". Podés descargar el documento final con su certificado de finalización.`],
      cta: "Descargar documento",
    },
    declined: {
      subject: (v) => `"${v.subject}" fue rechazado`,
      lines: (v) => [`Hola ${v.recipientName}:`, `${v.declinedBy ?? "Un firmante"} rechazó firmar "${v.subject}". El proceso quedó cancelado.`],
    },
    voided: {
      subject: (v) => `"${v.subject}" fue anulado`,
      lines: (v) => [`Hola ${v.recipientName}:`, `${v.senderName} anuló "${v.subject}". Ya no es necesario que lo firmes.`, v.reason ? `Motivo: ${v.reason}` : ""],
    },
    sender_completed: {
      subject: (v) => `Completado: "${v.subject}"`,
      lines: (v) => [`Hola ${v.recipientName}:`, `Todos los firmantes completaron "${v.subject}". El documento sellado ya está disponible.`],
      cta: "Ver sobre",
    },
    sender_declined: {
      subject: (v) => `Rechazado: "${v.subject}"`,
      lines: (v) => [`Hola ${v.recipientName}:`, `${v.declinedBy ?? "Un firmante"} rechazó "${v.subject}".`, v.reason ? `Motivo: ${v.reason}` : ""],
      cta: "Ver sobre",
    },
  },
  "pt-BR": {
    invite: {
      subject: (v) => `${v.senderName} enviou "${v.subject}" para você assinar`,
      lines: (v) => [`Olá ${v.recipientName},`, `${v.senderName} (${v.organizationName}) enviou um documento para você assinar eletronicamente.`],
      cta: "Revisar e assinar",
    },
    reminder: {
      subject: (v) => `Lembrete: "${v.subject}" aguarda sua assinatura`,
      lines: (v) => [`Olá ${v.recipientName},`, `Lembramos que ${v.senderName} (${v.organizationName}) está aguardando sua assinatura.`],
      cta: "Revisar e assinar",
    },
    completed: {
      subject: (v) => `Concluído: "${v.subject}"`,
      lines: (v) => [`Olá ${v.recipientName},`, `Todas as partes assinaram "${v.subject}". Você pode baixar o documento final com o certificado de conclusão.`],
      cta: "Baixar documento",
    },
    declined: {
      subject: (v) => `"${v.subject}" foi recusado`,
      lines: (v) => [`Olá ${v.recipientName},`, `${v.declinedBy ?? "Um signatário"} recusou assinar "${v.subject}". O processo foi cancelado.`],
    },
    voided: {
      subject: (v) => `"${v.subject}" foi anulado`,
      lines: (v) => [`Olá ${v.recipientName},`, `${v.senderName} anulou "${v.subject}". Não é mais necessário assiná-lo.`, v.reason ? `Motivo: ${v.reason}` : ""],
    },
    sender_completed: {
      subject: (v) => `Concluído: "${v.subject}"`,
      lines: (v) => [`Olá ${v.recipientName},`, `Todos os signatários concluíram "${v.subject}". O documento selado já está disponível.`],
      cta: "Ver envelope",
    },
    sender_declined: {
      subject: (v) => `Recusado: "${v.subject}"`,
      lines: (v) => [`Olá ${v.recipientName},`, `${v.declinedBy ?? "Um signatário"} recusou "${v.subject}".`, v.reason ? `Motivo: ${v.reason}` : ""],
      cta: "Ver envelope",
    },
  },
  en: {
    invite: {
      subject: (v) => `${v.senderName} sent you "${v.subject}" to sign`,
      lines: (v) => [`Hi ${v.recipientName},`, `${v.senderName} (${v.organizationName}) sent you a document to sign electronically.`],
      cta: "Review and sign",
    },
    reminder: {
      subject: (v) => `Reminder: "${v.subject}" is waiting for your signature`,
      lines: (v) => [`Hi ${v.recipientName},`, `${v.senderName} (${v.organizationName}) is still waiting for your signature.`],
      cta: "Review and sign",
    },
    completed: {
      subject: (v) => `Completed: "${v.subject}"`,
      lines: (v) => [`Hi ${v.recipientName},`, `All parties signed "${v.subject}". You can download the final document with its certificate of completion.`],
      cta: "Download document",
    },
    declined: {
      subject: (v) => `"${v.subject}" was declined`,
      lines: (v) => [`Hi ${v.recipientName},`, `${v.declinedBy ?? "A signer"} declined to sign "${v.subject}". The process was cancelled.`],
    },
    voided: {
      subject: (v) => `"${v.subject}" was voided`,
      lines: (v) => [`Hi ${v.recipientName},`, `${v.senderName} voided "${v.subject}". You no longer need to sign it.`, v.reason ? `Reason: ${v.reason}` : ""],
    },
    sender_completed: {
      subject: (v) => `Completed: "${v.subject}"`,
      lines: (v) => [`Hi ${v.recipientName},`, `All signers completed "${v.subject}". The sealed document is available.`],
      cta: "View envelope",
    },
    sender_declined: {
      subject: (v) => `Declined: "${v.subject}"`,
      lines: (v) => [`Hi ${v.recipientName},`, `${v.declinedBy ?? "A signer"} declined "${v.subject}".`, v.reason ? `Reason: ${v.reason}` : ""],
      cta: "View envelope",
    },
  },
};

const MSG_LABEL = { es: "Mensaje", "pt-BR": "Mensagem", en: "Message" } as const;
const FOOTER = {
  es: "Enviado con CalaSign · Firma electrónica en la nube. Si no esperabas este mensaje, podés ignorarlo.",
  "pt-BR": "Enviado com CalaSign · Assinatura eletrônica na nuvem. Se você não esperava esta mensagem, pode ignorá-la.",
  en: "Sent with CalaSign · Cloud e-signature. If you weren't expecting this message, you can ignore it.",
} as const;

export function normLocale(l: string | null | undefined): "es" | "pt-BR" | "en" {
  if (l === "pt-BR" || l === "en") return l;
  return "es";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function render(kind: TemplateKind, localeIn: string | null | undefined, v: TemplateVars) {
  const locale = normLocale(localeIn);
  const t = T[locale][kind];
  const subject = t.subject(v);
  const lines = t.lines(v).filter(Boolean);
  const text = [
    ...lines,
    v.message ? `\n${MSG_LABEL[locale]}: ${v.message}` : "",
    v.link && t.cta ? `\n${t.cta}: ${v.link}` : "",
    `\n— ${FOOTER[locale]}`,
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#0b1f3a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0b1f3a;padding:18px 28px;color:#ffffff;font-size:18px;font-weight:bold">Cala<span style="color:#2ec4b6">Sign</span></td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 6px;font-size:13px;color:#5b6576">${esc(v.organizationName)}</p>
<h1 style="margin:0 0 18px;font-size:20px">${esc(v.subject)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5">${esc(l)}</p>`).join("")}
${v.message ? `<div style="margin:16px 0;padding:12px 14px;background:#f3f5f8;border-left:3px solid #2ec4b6;font-size:14px;white-space:pre-wrap">${esc(v.message)}</div>` : ""}
${v.link && t.cta ? `<p style="margin:24px 0"><a href="${esc(v.link)}" style="background:#0f7c7c;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${esc(t.cta)}</a></p><p style="font-size:12px;color:#5b6576;word-break:break-all">${esc(v.link)}</p>` : ""}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e5e9f0;font-size:12px;color:#5b6576">${esc(FOOTER[locale])}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html, cta: t.cta ?? null };
}
