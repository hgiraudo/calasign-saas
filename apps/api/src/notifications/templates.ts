import { contrastText, fillTemplate } from "@calasign/shared";
export type TemplateKind =
  | "invite"
  | "reminder"
  | "completed"
  | "declined"
  | "voided"
  | "sender_completed"
  | "sender_declined"
  | "expiry_warning"
  | "certificate_request"
  | "finalize_failed"
  | "password_reset"
  // Avisos de seguridad de la cuenta (security-notices.ts): `date` cuándo (UTC) y `detail` la red de origen enmascarada.
  | "password_changed"
  | "2fa_enabled"
  | "2fa_disabled"
  | "2fa_recovery_regenerated";

/** Avisos de la plataforma de acuerdos (vencimientos y negociaciones): mismo diseño y marca que los de sobres. */
export type AgreementTemplateKind = "agreement_expiry" | "negotiation_invite" | "negotiation_version" | "negotiation_proposal" | "workflow_approval";

/**
 * Avisos a la organización sobre su cuenta (no sobre un sobre): mismo diseño y marca. webhook_deactivated: `detail` es
 * el host del webhook y `reason` el motivo ya traducido. team_invitation: `senderName` quien invita, `detail` el rol y
 * `days` los días hasta que vence.
 */
export type OrgNoticeKind = "webhook_deactivated" | "team_invitation";

export interface TemplateVars {
  recipientName: string;
  senderName: string;
  organizationName: string;
  subject: string;
  message?: string | null;
  link?: string | null;
  reason?: string | null;
  declinedBy?: string | null;
  /** Acuerdos: fecha de vencimiento (AAAA-MM-DD) y días que faltan. */
  date?: string | null;
  days?: number | null;
  /** Negociaciones: resumen del cambio o qué se propone cambiar. */
  detail?: string | null;
  /**
   * finalize_failed: código del error de un documento que no se puede sellar (InvalidPdfError al sanear un original
   * viejo, p. ej. `pdf_form_unsupported`): reintentar no lo resuelve. null o ausente: fallo transitorio agotado.
   */
  unsealableCode?: string | null;
}

type Dict = Record<TemplateKind | AgreementTemplateKind | OrgNoticeKind, { subject: (v: TemplateVars) => string; lines: (v: TemplateVars) => string[]; cta?: string }>;

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
    expiry_warning: {
      subject: (v) => `Por vencer: "${v.subject}" espera tu firma`,
      lines: (v) => [`Hola ${v.recipientName}:`, `El documento que te envió ${v.senderName} (${v.organizationName}) vence pronto. Firmalo antes de que caduque.`],
      cta: "Revisar y firmar",
    },
    certificate_request: {
      subject: (v) => `Firmá con tu certificado digital: "${v.subject}"`,
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        `Todas las partes ya firmaron "${v.subject}". Falta tu firma con certificado digital (token, certificado instalado o archivo .p12), que se hace con el Firmador CalaSign.`,
      ],
      cta: "Firmar con certificado",
    },
    finalize_failed: {
      subject: (v) => `No se pudo completar "${v.subject}"`,
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        ...(v.unsealableCode
          ? [
              `Todas las partes firmaron "${v.subject}", pero el documento no se puede sellar (código ${v.unsealableCode}). No se perdió nada: el sobre quedó en espera.`,
              "Reintentar no lo resuelve: anulá el sobre y envialo de nuevo (con el PDF exportado de nuevo o impreso a PDF). Si necesitás ayuda, escribinos a contacto@calasign.com.",
            ]
          : [
              `Todas las partes firmaron "${v.subject}", pero el sellado del documento final falló después de varios reintentos. No se perdió nada: el sobre quedó en espera.`,
              "Podés reintentarlo desde el detalle del sobre. Si vuelve a fallar, escribinos a contacto@calasign.com.",
            ]),
      ],
      cta: "Ver sobre",
    },
    password_reset: {
      subject: () => "Restablecé tu contraseña de CalaSign",
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        "Recibimos un pedido para restablecer tu contraseña. El link vale 30 minutos y se puede usar una sola vez.",
        "Si no lo pediste, ignorá este correo: tu contraseña no cambia.",
      ],
      cta: "Elegir una contraseña nueva",
    },
    password_changed: {
      subject: () => "Se cambió la contraseña de tu cuenta de CalaSign",
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        `La contraseña de tu cuenta se restableció el ${v.date}${v.detail ? ` (desde la red ${v.detail})` : ""}. Se cerraron todas las sesiones abiertas.`,
        "Si fuiste vos, no tenés que hacer nada. Si no, restablecé tu contraseña ahora y avisá a soporte (contacto@calasign.com).",
      ],
      cta: "Restablecer mi contraseña",
    },
    "2fa_enabled": {
      subject: () => "Se activó la verificación en dos pasos en tu cuenta de CalaSign",
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        `Se activó la verificación en dos pasos en tu cuenta el ${v.date}${v.detail ? ` (desde la red ${v.detail})` : ""}. Se cerraron las demás sesiones.`,
        "Si no fuiste vos, alguien entró a tu cuenta: restablecé tu contraseña y escribí a soporte (contacto@calasign.com) para quitar ese segundo factor.",
      ],
      cta: "Revisar la seguridad de mi cuenta",
    },
    "2fa_disabled": {
      subject: () => "Se desactivó la verificación en dos pasos en tu cuenta de CalaSign",
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        `Se desactivó la verificación en dos pasos de tu cuenta el ${v.date}${v.detail ? ` (desde la red ${v.detail})` : ""}. Se cerraron las demás sesiones.`,
        "Si no fuiste vos, restablecé tu contraseña ahora y volvé a activarla.",
      ],
      cta: "Revisar la seguridad de mi cuenta",
    },
    "2fa_recovery_regenerated": {
      subject: () => "Se generaron códigos de recuperación nuevos para tu cuenta de CalaSign",
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        `Se generaron códigos de recuperación nuevos para la verificación en dos pasos el ${v.date}${v.detail ? ` (desde la red ${v.detail})` : ""}. Los anteriores ya no sirven.`,
        "Si no fuiste vos, restablecé tu contraseña ahora y regenerá los códigos.",
      ],
      cta: "Revisar la seguridad de mi cuenta",
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
    agreement_expiry: {
      subject: (v) => `Vence el ${v.date}: ${v.subject}`,
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        `El acuerdo "${v.subject}" vence el ${v.date} (${(v.days ?? 0) <= 0 ? "hoy" : `en ${v.days} día${v.days === 1 ? "" : "s"}`}). Revisalo para renovarlo o darlo de baja a tiempo.`,
      ],
      cta: "Ver acuerdo",
    },
    negotiation_invite: {
      subject: (v) => `${v.organizationName} te invita a revisar "${v.subject}"`,
      lines: (v) => [`Hola ${v.recipientName}:`, `${v.organizationName} compartió un borrador para que lo revises, comentes y propongas cambios antes de firmarlo.`],
      cta: "Revisar",
    },
    negotiation_version: {
      subject: (v) => `Nueva versión de "${v.subject}"`,
      lines: (v) => [`Hola ${v.recipientName}:`, `Hay una nueva versión de "${v.subject}".`, v.detail ?? ""],
      cta: "Revisar",
    },
    negotiation_proposal: {
      subject: (v) => `${v.senderName} propuso un cambio en "${v.subject}"`,
      lines: (v) => [`Hola ${v.recipientName}:`, `${v.senderName} propone cambiar ${v.detail ?? ""} en "${v.subject}".`],
      cta: "Revisar",
    },
    workflow_approval: {
      subject: (v) => `Aprobación pendiente: ${v.subject}`,
      lines: (v) => [`Hola ${v.recipientName}:`, `El workflow "${v.subject}" espera tu aprobación (paso "${v.detail ?? ""}").`],
      cta: "Revisar y decidir",
    },
    webhook_deactivated: {
      subject: () => "CalaSign: se desactivó un webhook de tu organización",
      lines: (v) => [
        `Hola ${v.recipientName}:`,
        `Se desactivó el webhook que entrega eventos a ${v.detail ?? ""}: no va a recibir más eventos hasta que alguien lo reactive.`,
        v.reason ?? "",
      ],
      cta: "Revisalo y reactivalo en Ajustes → Integraciones",
    },
    team_invitation: {
      subject: (v) => `Te invitaron a ${v.organizationName} en CalaSign`,
      lines: (v) => [
        `${v.senderName} te invitó a sumarte a ${v.organizationName} en CalaSign con el rol ${v.detail ?? ""}.`,
        `La invitación vence en ${v.days ?? 0} días.`,
      ],
      cta: "Aceptar invitación",
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
    expiry_warning: {
      subject: (v) => `Prestes a expirar: "${v.subject}" aguarda sua assinatura`,
      lines: (v) => [`Olá ${v.recipientName},`, `O documento enviado por ${v.senderName} (${v.organizationName}) expira em breve. Assine antes que expire.`],
      cta: "Revisar e assinar",
    },
    certificate_request: {
      subject: (v) => `Assine com seu certificado digital: "${v.subject}"`,
      lines: (v) => [
        `Olá ${v.recipientName},`,
        `Todas as partes já assinaram "${v.subject}". Falta a sua assinatura com certificado digital (token, certificado instalado ou arquivo .p12), feita com o Firmador CalaSign.`,
      ],
      cta: "Assinar com certificado",
    },
    finalize_failed: {
      subject: (v) => `Não foi possível concluir "${v.subject}"`,
      lines: (v) => [
        `Olá ${v.recipientName},`,
        ...(v.unsealableCode
          ? [
              `Todas as partes assinaram "${v.subject}", mas o documento não pode ser selado (código ${v.unsealableCode}). Nada foi perdido: o envelope ficou em espera.`,
              "Tentar novamente não resolve: anule o envelope e envie-o de novo (com o PDF exportado novamente ou impresso como PDF). Se precisar de ajuda, escreva para contacto@calasign.com.",
            ]
          : [
              `Todas as partes assinaram "${v.subject}", mas a selagem do documento final falhou após várias tentativas. Nada foi perdido: o envelope ficou em espera.`,
              "Você pode tentar novamente pelo detalhe do envelope. Se falhar de novo, escreva para contacto@calasign.com.",
            ]),
      ],
      cta: "Ver envelope",
    },
    password_reset: {
      subject: () => "Redefina sua senha da CalaSign",
      lines: (v) => [
        `Olá ${v.recipientName},`,
        "Recebemos um pedido para redefinir sua senha. O link vale 30 minutos e pode ser usado uma única vez.",
        "Se você não pediu, ignore este e-mail: sua senha não muda.",
      ],
      cta: "Escolher uma nova senha",
    },
    password_changed: {
      subject: () => "A senha da sua conta CalaSign foi alterada",
      lines: (v) => [
        `Olá ${v.recipientName},`,
        `A senha da sua conta foi redefinida em ${v.date}${v.detail ? ` (a partir da rede ${v.detail})` : ""}. Todas as sessões abertas foram encerradas.`,
        "Se foi você, não precisa fazer nada. Se não, redefina sua senha agora e avise o suporte (contacto@calasign.com).",
      ],
      cta: "Redefinir minha senha",
    },
    "2fa_enabled": {
      subject: () => "A verificação em duas etapas foi ativada na sua conta CalaSign",
      lines: (v) => [
        `Olá ${v.recipientName},`,
        `A verificação em duas etapas foi ativada na sua conta em ${v.date}${v.detail ? ` (a partir da rede ${v.detail})` : ""}. As demais sessões foram encerradas.`,
        "Se não foi você, alguém entrou na sua conta: redefina sua senha e escreva para o suporte (contacto@calasign.com) para remover esse segundo fator.",
      ],
      cta: "Revisar a segurança da minha conta",
    },
    "2fa_disabled": {
      subject: () => "A verificação em duas etapas foi desativada na sua conta CalaSign",
      lines: (v) => [
        `Olá ${v.recipientName},`,
        `A verificação em duas etapas da sua conta foi desativada em ${v.date}${v.detail ? ` (a partir da rede ${v.detail})` : ""}. As demais sessões foram encerradas.`,
        "Se não foi você, redefina sua senha agora e ative-a novamente.",
      ],
      cta: "Revisar a segurança da minha conta",
    },
    "2fa_recovery_regenerated": {
      subject: () => "Novos códigos de recuperação foram gerados para sua conta CalaSign",
      lines: (v) => [
        `Olá ${v.recipientName},`,
        `Novos códigos de recuperação da verificação em duas etapas foram gerados em ${v.date}${v.detail ? ` (a partir da rede ${v.detail})` : ""}. Os anteriores não valem mais.`,
        "Se não foi você, redefina sua senha agora e gere os códigos novamente.",
      ],
      cta: "Revisar a segurança da minha conta",
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
    agreement_expiry: {
      subject: (v) => `Vence em ${v.date}: ${v.subject}`,
      lines: (v) => [
        `Olá ${v.recipientName},`,
        `O acordo "${v.subject}" vence em ${v.date} (${(v.days ?? 0) <= 0 ? "hoje" : `em ${v.days} dia${v.days === 1 ? "" : "s"}`}). Revise para renovar ou encerrar a tempo.`,
      ],
      cta: "Ver acordo",
    },
    negotiation_invite: {
      subject: (v) => `${v.organizationName} convida você a revisar "${v.subject}"`,
      lines: (v) => [`Olá ${v.recipientName},`, `${v.organizationName} compartilhou um rascunho para você revisar, comentar e propor mudanças antes de assiná-lo.`],
      cta: "Revisar",
    },
    negotiation_version: {
      subject: (v) => `Nova versão de "${v.subject}"`,
      lines: (v) => [`Olá ${v.recipientName},`, `Há uma nova versão de "${v.subject}".`, v.detail ?? ""],
      cta: "Revisar",
    },
    negotiation_proposal: {
      subject: (v) => `${v.senderName} propôs uma mudança em "${v.subject}"`,
      lines: (v) => [`Olá ${v.recipientName},`, `${v.senderName} propõe mudar ${v.detail ?? ""} em "${v.subject}".`],
      cta: "Revisar",
    },
    workflow_approval: {
      subject: (v) => `Aprovação pendente: ${v.subject}`,
      lines: (v) => [`Olá ${v.recipientName},`, `O workflow "${v.subject}" aguarda sua aprovação (etapa "${v.detail ?? ""}").`],
      cta: "Revisar e decidir",
    },
    webhook_deactivated: {
      subject: () => "CalaSign: um webhook da sua organização foi desativado",
      lines: (v) => [
        `Olá ${v.recipientName},`,
        `O webhook que entrega eventos para ${v.detail ?? ""} foi desativado: ele não vai receber mais eventos até que alguém o reative.`,
        v.reason ?? "",
      ],
      cta: "Revise e reative em Configurações → Integrações",
    },
    team_invitation: {
      subject: (v) => `Você foi convidado para ${v.organizationName} na CalaSign`,
      lines: (v) => [
        `${v.senderName} convidou você para participar de ${v.organizationName} na CalaSign com o perfil ${v.detail ?? ""}.`,
        `O convite expira em ${v.days ?? 0} dias.`,
      ],
      cta: "Aceitar convite",
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
    expiry_warning: {
      subject: (v) => `Expiring soon: "${v.subject}" is waiting for your signature`,
      lines: (v) => [`Hi ${v.recipientName},`, `The document ${v.senderName} (${v.organizationName}) sent you expires soon. Please sign it before it expires.`],
      cta: "Review and sign",
    },
    certificate_request: {
      subject: (v) => `Sign with your digital certificate: "${v.subject}"`,
      lines: (v) => [
        `Hi ${v.recipientName},`,
        `Everyone has signed "${v.subject}". Your digital-certificate signature (token, installed certificate or .p12 file) is still pending; it is done with the CalaSign Signer app.`,
      ],
      cta: "Sign with certificate",
    },
    finalize_failed: {
      subject: (v) => `"${v.subject}" could not be completed`,
      lines: (v) => [
        `Hi ${v.recipientName},`,
        ...(v.unsealableCode
          ? [
              `Everyone signed "${v.subject}", but the document can't be sealed (code ${v.unsealableCode}). Nothing was lost: the envelope is on hold.`,
              "Retrying won't fix it: void the envelope and send it again (with the PDF exported again or printed to PDF). If you need help, write to contacto@calasign.com.",
            ]
          : [
              `Everyone signed "${v.subject}", but sealing the final document failed after several retries. Nothing was lost: the envelope is on hold.`,
              "You can retry it from the envelope page. If it fails again, write to contacto@calasign.com.",
            ]),
      ],
      cta: "View envelope",
    },
    password_reset: {
      subject: () => "Reset your CalaSign password",
      lines: (v) => [
        `Hi ${v.recipientName},`,
        "We received a request to reset your password. The link is valid for 30 minutes and can be used once.",
        "If you didn't ask for this, ignore this email: your password stays the same.",
      ],
      cta: "Choose a new password",
    },
    password_changed: {
      subject: () => "Your CalaSign password was changed",
      lines: (v) => [
        `Hi ${v.recipientName},`,
        `Your account password was reset on ${v.date}${v.detail ? ` (from network ${v.detail})` : ""}. All open sessions were signed out.`,
        "If this was you, there's nothing to do. If not, reset your password now and contact support (contacto@calasign.com).",
      ],
      cta: "Reset my password",
    },
    "2fa_enabled": {
      subject: () => "Two-step verification was turned on for your CalaSign account",
      lines: (v) => [
        `Hi ${v.recipientName},`,
        `Two-step verification was turned on for your account on ${v.date}${v.detail ? ` (from network ${v.detail})` : ""}. Your other sessions were signed out.`,
        "If this wasn't you, someone got into your account: reset your password and write to support (contacto@calasign.com) to remove that second factor.",
      ],
      cta: "Review my account security",
    },
    "2fa_disabled": {
      subject: () => "Two-step verification was turned off for your CalaSign account",
      lines: (v) => [
        `Hi ${v.recipientName},`,
        `Two-step verification was turned off for your account on ${v.date}${v.detail ? ` (from network ${v.detail})` : ""}. Your other sessions were signed out.`,
        "If this wasn't you, reset your password now and turn it back on.",
      ],
      cta: "Review my account security",
    },
    "2fa_recovery_regenerated": {
      subject: () => "New recovery codes were generated for your CalaSign account",
      lines: (v) => [
        `Hi ${v.recipientName},`,
        `New two-step verification recovery codes were generated on ${v.date}${v.detail ? ` (from network ${v.detail})` : ""}. The previous ones no longer work.`,
        "If this wasn't you, reset your password now and regenerate the codes.",
      ],
      cta: "Review my account security",
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
    agreement_expiry: {
      subject: (v) => `Expires on ${v.date}: ${v.subject}`,
      lines: (v) => [
        `Hi ${v.recipientName},`,
        `The agreement "${v.subject}" expires on ${v.date} (${(v.days ?? 0) <= 0 ? "today" : `in ${v.days} day${v.days === 1 ? "" : "s"}`}). Review it to renew or terminate it in time.`,
      ],
      cta: "View agreement",
    },
    negotiation_invite: {
      subject: (v) => `${v.organizationName} invites you to review "${v.subject}"`,
      lines: (v) => [`Hi ${v.recipientName},`, `${v.organizationName} shared a draft for you to review, comment on and propose changes before signing it.`],
      cta: "Review",
    },
    negotiation_version: {
      subject: (v) => `New version of "${v.subject}"`,
      lines: (v) => [`Hi ${v.recipientName},`, `There is a new version of "${v.subject}".`, v.detail ?? ""],
      cta: "Review",
    },
    negotiation_proposal: {
      subject: (v) => `${v.senderName} proposed a change to "${v.subject}"`,
      lines: (v) => [`Hi ${v.recipientName},`, `${v.senderName} proposes changing ${v.detail ?? ""} in "${v.subject}".`],
      cta: "Review",
    },
    workflow_approval: {
      subject: (v) => `Approval pending: ${v.subject}`,
      lines: (v) => [`Hi ${v.recipientName},`, `The workflow "${v.subject}" is waiting for your approval (step "${v.detail ?? ""}").`],
      cta: "Review and decide",
    },
    webhook_deactivated: {
      subject: () => "CalaSign: a webhook in your organization was disabled",
      lines: (v) => [
        `Hi ${v.recipientName},`,
        `The webhook that delivers events to ${v.detail ?? ""} was disabled: it won't receive any more events until someone turns it back on.`,
        v.reason ?? "",
      ],
      cta: "Review it and turn it back on in Settings → Integrations",
    },
    team_invitation: {
      subject: (v) => `You've been invited to ${v.organizationName} on CalaSign`,
      lines: (v) => [`${v.senderName} invited you to join ${v.organizationName} on CalaSign as ${v.detail ?? ""}.`, `The invitation expires in ${v.days ?? 0} days.`],
      cta: "Accept invitation",
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

export interface MailBranding {
  primaryColor?: string | null;
  logoUrl?: string | null;
  footer?: string | null;
  /** Marca blanca: nombre del producto que reemplaza a la plataforma (null: la plataforma). */
  productName?: string | null;
  /** Marca blanca total: sin el pie "Enviado con …" ni el logotipo de la plataforma. */
  hidePoweredBy?: boolean;
  /** Nombre visible de la marca (encabezado sin logo). */
  brandName?: string | null;
  secondaryColor?: string | null;
  buttonColor?: string | null;
  buttonTextColor?: string | null;
  /** Texto del encabezado sin logo (sobre el color principal); sin él, blanco u oscuro según contraste. */
  headerTextColor?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  fontFamily?: string | null;
  /** Hoja de Google Fonts (los clientes de correo que no la cargan usan la pila de respaldo). */
  fontCssUrl?: string | null;
  borderRadius?: number | null;
  supportUrl?: string | null;
  /** Plantilla propia de la organización para este evento e idioma ({{variables}}). */
  template?: { subject?: string | null; body?: string | null; cta?: string | null } | null;
}

/** Nombre de la plataforma (lo que se reemplaza en marca blanca). */
export const PLATFORM_NAME = "CalaSign";

/** Reemplaza el nombre de la plataforma por el de la marca (y quita el correo de contacto de la plataforma). */
export function brandText(s: string, brand: Pick<MailBranding, "productName" | "hidePoweredBy" | "brandName" | "supportUrl">): string {
  const name = brand.productName || (brand.hidePoweredBy ? brand.brandName : null);
  if (!name) return s;
  return s
    .replace(/contacto@calasign\.com/gi, brand.supportUrl || name)
    .replace(/calasign\.com/gi, brand.supportUrl || name)
    .replace(/CalaSign/g, name);
}

/** Marca de un valor ajeno a la plantilla (caracteres de uso privado): brandText no la toca. */
const SLOT_RE = /\uE000(\d+)\uE001/g;

/**
 * Cambia cada valor de texto por una marca para armar la plantilla, pasarle brandText y recién ahí volver a poner
 * los valores: así la marca blanca reemplaza el nombre de la plataforma solo en los textos propios, nunca en el
 * asunto del sobre, los nombres o el mensaje que escribió el usuario ("Migración desde CalaSign" queda igual).
 */
export function maskVars<V extends object>(v: V): { masked: V; unmask: (s: string) => string } {
  const vals: string[] = [];
  const masked: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string" && x !== "") {
      masked[k] = `\uE000${vals.length}\uE001`;
      vals.push(x);
    } else masked[k] = x;
  }
  return { masked: masked as V, unmask: (s) => s.replace(SLOT_RE, (_m, i: string) => vals[Number(i)] ?? "") };
}

const okHex = (c: string | null | undefined): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);
const okFont = (f: string | null | undefined): f is string => typeof f === "string" && /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(f);

export function render(kind: TemplateKind | AgreementTemplateKind | OrgNoticeKind, localeIn: string | null | undefined, v: TemplateVars, brand: MailBranding = {}) {
  const color = okHex(brand.primaryColor) ? brand.primaryColor : null;
  const accent = okHex(brand.secondaryColor) ? brand.secondaryColor : "#2ec4b6";
  const btn = okHex(brand.buttonColor) ? brand.buttonColor : color ?? "#0f7c7c";
  // Sin color de texto propio, blanco u oscuro según el fondo del botón (blanco fijo no se leía sobre uno claro).
  const btnText = okHex(brand.buttonTextColor) ? brand.buttonTextColor : contrastText(btn);
  const headBg = color ?? "#0b1f3a";
  const headText = okHex(brand.headerTextColor) ? brand.headerTextColor : contrastText(headBg);
  const bg = okHex(brand.backgroundColor) ? brand.backgroundColor : "#f3f5f8";
  const ink = okHex(brand.textColor) ? brand.textColor : "#0b1f3a";
  const radius = typeof brand.borderRadius === "number" && brand.borderRadius >= 0 && brand.borderRadius <= 24 ? brand.borderRadius : 6;
  const font = okFont(brand.fontFamily) ? `'${brand.fontFamily}',Arial,Helvetica,sans-serif` : "Arial,Helvetica,sans-serif";
  const locale = normLocale(localeIn);
  const t = T[locale][kind];
  const B = (s: string) => brandText(s, brand);
  const tpl = brand.template ?? null;
  // La marca blanca se aplica a la plantilla con los valores enmascarados; después se ponen los valores reales.
  const mv = maskVars(v);
  // finalize_failed: la explicación estándar del fallo (sin el saludo), para {{reason}} en una plantilla propia.
  const finalizeDetail = kind === "finalize_failed" ? t.lines(mv.masked).slice(1).map((l) => mv.unmask(B(l))) : [];
  const vars: Record<string, string> = {
    recipientName: v.recipientName,
    senderName: v.senderName,
    organizationName: v.organizationName,
    subject: v.subject,
    message: v.message ?? "",
    link: v.link ?? "",
    reason: v.reason ?? (finalizeDetail.length ? finalizeDetail.join("\n") : ""),
    declinedBy: v.declinedBy ?? "",
    productName: brand.productName || brand.brandName || PLATFORM_NAME,
    supportUrl: brand.supportUrl ?? "",
    // finalize_failed: código del error de un documento que no se puede sellar.
    code: v.unsealableCode ?? "",
  };
  const mvars = maskVars(vars);
  // {{message}} con o sin espacios (fillTemplate acepta los dos): si la plantilla lo incluye, no se repite el mensaje.
  const tplHasMessage = Boolean(tpl?.body && /\{\{\s*message\s*\}\}/.test(tpl.body));
  const subject = tpl?.subject?.trim()
    ? mvars.unmask(B(fillTemplate(tpl.subject, mvars.masked))).replace(/[\r\n]+/g, " ").trim()
    : mv.unmask(B(t.subject(mv.masked)));
  const lines = (
    tpl?.body?.trim()
      ? fillTemplate(tpl.body, mvars.masked)
          .split(/\n\s*\n/)
          .map((p) => mvars.unmask(B(p.trim())))
      : t.lines(mv.masked).map((l) => mv.unmask(B(l)))
  ).filter(Boolean);
  // Plantilla propia de finalize_failed sin {{reason}} ni {{code}} y un documento que no se puede sellar: se agrega la
  // explicación estándar (reintentar no lo resuelve; sin esto, el aviso no decía qué hacer).
  if (tpl?.body?.trim() && v.unsealableCode && finalizeDetail.length && !/\{\{\s*(reason|code)\s*\}\}/.test(tpl.body)) lines.push(...finalizeDetail);
  const cta = tpl?.cta?.trim() ? tpl.cta.trim() : t.cta ?? null;
  const footer = brand.hidePoweredBy ? null : B(FOOTER[locale]);
  const text = [
    ...lines,
    v.message && !tplHasMessage ? `\n${MSG_LABEL[locale]}: ${v.message}` : "",
    v.link && cta ? `\n${cta}: ${v.link}` : "",
    brand.footer ? `\n${brand.footer}` : "",
    footer ? `\n— ${footer}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const headerName = brand.brandName || v.organizationName;
  const fontLink = brand.fontCssUrl && /^https:\/\/fonts\.googleapis\.com\//.test(brand.fontCssUrl) ? `<link rel="stylesheet" href="${esc(brand.fontCssUrl)}">` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8">${fontLink}</head><body style="margin:0;background:${bg};font-family:${font};color:${ink}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:${Math.max(radius, 4)}px;overflow:hidden">
${
    brand.logoUrl
      ? `<tr><td style="background:#ffffff;padding:18px 28px;border-top:5px solid ${color ?? "#0b1f3a"};border-bottom:1px solid #e5e9f0"><img src="${esc(brand.logoUrl)}" alt="${esc(headerName)}" style="max-height:44px;max-width:220px;display:block"></td></tr>`
      : color || brand.productName || brand.hidePoweredBy || brand.brandName
        ? `<tr><td style="background:${headBg};padding:18px 28px;color:${headText};font-size:18px;font-weight:bold">${esc(headerName || brand.productName || "")}</td></tr>`
        : `<tr><td style="background:#0b1f3a;padding:18px 28px;color:#ffffff;font-size:18px;font-weight:bold">Cala<span style="color:#2ec4b6">Sign</span></td></tr>`
  }
<tr><td style="padding:28px">
<p style="margin:0 0 6px;font-size:13px;color:#5b6576">${esc(v.organizationName)}</p>
<h1 style="margin:0 0 18px;font-size:20px">${esc(v.subject)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.5;white-space:pre-wrap">${esc(l)}</p>`).join("")}
${v.message && !tplHasMessage ? `<div style="margin:16px 0;padding:12px 14px;background:${bg};border-left:3px solid ${accent};font-size:14px;white-space:pre-wrap">${esc(v.message)}</div>` : ""}
${v.link && cta ? `<p style="margin:24px 0"><a href="${esc(v.link)}" style="background:${btn};color:${btnText};text-decoration:none;padding:12px 22px;border-radius:${radius}px;font-weight:bold;display:inline-block">${esc(cta)}</a></p><p style="font-size:12px;color:#5b6576;word-break:break-all">${esc(v.link)}</p>` : ""}
</td></tr>
${
    brand.footer || footer
      ? `<tr><td style="padding:16px 28px;border-top:1px solid #e5e9f0;font-size:12px;color:#5b6576">${brand.footer ? `<p style="margin:0 0 8px;white-space:pre-wrap">${esc(brand.footer)}</p>` : ""}${footer ? esc(footer) : ""}</td></tr>`
      : ""
  }
</table></td></tr></table></body></html>`;
  // platformFooter: el pie exacto que se agregó al texto (los canales que no lo muestran lo sacan solo si está).
  return { subject, text, html, cta, platformFooter: footer ? `\n— ${footer}` : null };
}
