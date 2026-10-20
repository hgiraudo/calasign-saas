import { addCadesSignatureIncremental, finalizeEnvelopePdf, InvalidPdfError, type CertificateRecipient, type StampField } from "@calasign/pdf";
import { certsignStage } from "./certsign";
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent, verifyRows } from "../infra/evidence";
import { enqueue, isLastAttempt, purgeFinishedJobs, requeueStuckJobs, type JobHandler, type JobQueueName } from "../infra/queue";
import { getSealProvider } from "../infra/seal";
import { applyEvidencePipeline, planEvidence } from "./evidence-seal";
import type { BlobStore } from "../infra/storage";
import { decrypt, maskDestination, sha256Hex, uuidv7 } from "../lib/util";
import { deliver } from "../notifications/channels";
import { scrubPii, sendTracked } from "../notifications/outbound";
import { pastExpiry, receivesSignerNotices } from "./envelopes";
import { isUnverifiedSelfRegistered } from "./otp";
import { normLocale, render, type TemplateKind } from "../notifications/templates";
import { loadDocuments } from "./mappers";
import { loadSignatureImages, toStampFields } from "./stamp-fields";
import { finalizeFieldLogic } from "./logic";
import { handleBulkJob } from "./bulk";
import { embeddedAuthLabel } from "./embed";
import { inPersonAuthLabels } from "./experience";
import { handleWebhookJob } from "./webhooks";
import { runAutomaticReminders } from "./reminders";
import { purgeExpiredEnvelopes, purgeOldIntegrationRuns, purgeOldWebhookDeliveries } from "./retention";
import { purgeUnusedDynamicClients } from "./oauth";
import { brandForEnvelope, brandize, mailBranding, productLabel, rebrands, senderFor } from "./white-label/brand";
import { brandLogoForPdf, recheckWhiteLabelDomains } from "./white-label";
import { handlePlatformJob } from "./platform-fanout";
import { recheckVerifiedDomains, tenantBaseUrl } from "./custom-domains";
import { dataSweep } from "./data";
import { identityForCertificate, maskDocNumber } from "./identity/kyc";
import { closeStaleCheckouts, paymentsForCertificate, refundPaymentsOnClosedEnvelopes } from "./billing/payments";
import { cancelPendingSubscriptions } from "./billing/webhooks";
import { runAiSweep } from "./ai";
import { agreementsSweep, handleAgreementsJob } from "./agreements";

interface Deps {
  db: Db;
  blobs: BlobStore;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

const LINK_KINDS: TemplateKind[] = ["invite", "reminder", "completed", "expiry_warning", "certificate_request"];

const waParam = (v: string) => (v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim() || "-";

/**
 * Texto para Telegram: sin el pie de la plataforma y dentro del tope de 4096 caracteres de Telegram.
 */
function telegramText(subject: string, text: string, platformFooter: string | null | undefined): string {
  // Solo el pie que agregó la plataforma, y solo si está al final: con la marca sin pie, un "— Juan" del remitente
  // no se toca.
  const body = platformFooter && text.endsWith(platformFooter) ? text.slice(0, -platformFooter.length) : text;
  const full = `${subject}\n\n${body}`;
  const cps = [...full];
  return cps.length > 4000 ? cps.slice(0, 3999).join("") + "…" : full;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Agrega un párrafo al final del HTML del correo (antes de </body>). */
function withHtmlHint(html: string, hint: string, url: string): string {
  const p = `<p style="font-family:Arial,sans-serif;font-size:13px;color:#475569;text-align:center;margin:12px 0">${escHtml(hint)} <a href="${escHtml(url)}">${escHtml(url)}</a></p>`;
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + p + html.slice(i) : html + p;
}

/** Plantilla de WhatsApp para cada aviso; un aviso sin plantilla propia no sale por WhatsApp. */
function whatsappTemplate(kind: TemplateKind): string | null {
  const w = config.whatsapp;
  switch (kind) {
    case "invite":
    case "reminder":
    case "expiry_warning":
    case "certificate_request":
      return w.template;
    case "completed":
      return w.completedTemplate;
    case "voided":
      return w.voidedTemplate;
    case "declined":
      return w.declinedTemplate;
    default:
      return null;
  }
}
const TELEGRAM_HINT = {
  es: "¿Preferís recibir los avisos por Telegram? Activalo desde la página de firma:",
  "pt-BR": "Prefere receber os avisos pelo Telegram? Ative pela página de assinatura:",
  en: "Prefer to get notifications on Telegram? Turn it on from the signing page:",
} as const;

/**
 * Aviso de completado a quien se registró en un formulario web sin validar su correo: sin adjunto ni link (el link de
 * firma permite bajar el PDF firmado y la dirección no está verificada: podría ser de otra persona). Quien firmó lo
 * descarga desde la página donde firmó.
 */
const UNVERIFIED_COMPLETED_TEXT = {
  es: "El documento quedó firmado. Por seguridad, este correo no trae un link: descargalo desde la página donde firmaste.",
  "pt-BR": "O documento foi assinado. Por segurança, este e-mail não traz um link: baixe-o pela página onde você assinou.",
  en: "The document has been signed. For security, this email has no link: download it from the page where you signed.",
} as const;
const UNVERIFIED_COPY_NOTE = {
  es: "Recibís este correo porque se completó un formulario con esta dirección. Si no fuiste vos, podés ignorarlo.",
  "pt-BR": "Você recebeu este e-mail porque um formulário foi preenchido com este endereço. Se não foi você, pode ignorá-lo.",
  en: "You're receiving this email because a form was filled in with this address. If it wasn't you, you can ignore it.",
} as const;

/** Agrega un párrafo de texto al final del HTML del correo (antes de </body>). */
function withHtmlNote(html: string, note: string): string {
  const p = `<p style="font-family:Arial,sans-serif;font-size:12px;color:#5b6576;text-align:center;margin:12px 0">${escHtml(note)}</p>`;
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + p + html.slice(i) : html + p;
}

export function createJobHandlers(d: Deps): Record<JobQueueName, JobHandler> {
  return {
    notify: (p, job) => notify(d, p, job?.id),
    finalize: async (p, job) => {
      try {
        await finalize(d, p);
      } catch (err) {
        // Un documento que no se puede sellar (InvalidPdfError al sanear un original viejo) falla igual en cada intento:
        // se registra el fallo y se avisa ya, sin reintentar; el aviso lleva el código (anular y reenviar). Las capas
        // ocultas de un original viejo no fallan: el PDF final lleva /OCProperties con el mismo estado.
        // Si registrarlo falla, el error sale y el job se reintenta (y vuelve a llegar acá).
        if (err instanceof InvalidPdfError) {
          await finalizeGaveUp(d, p, err);
          return;
        }
        // Último intento: el sobre no puede quedar en 'finalizing' sin que nadie se entere.
        if (isLastAttempt(job, err)) await finalizeGaveUp(d, p, err).catch((e) => d.log.error({ err: String(e), envelopeId: p.envelopeId }, "no se pudo registrar el fallo de finalización"));
        throw err;
      }
    },
    webhook: (p, job) => handleWebhookJob(d, p, job),
    bulk: (p, job) => handleBulkJob(d, p, job),
    platform: (p, job) => handlePlatformJob(d, p, job),
    agreements: (p, job) => handleAgreementsJob(d, p, job?.id),
  };
}

// ───────────────────────────── Notificaciones ─────────────────────────────

async function notify(
  d: Deps,
  p: { kind: TemplateKind; envelopeId: string; tenantId: string; recipientId?: string; declinedBy?: string; userId?: string; tokenEnc?: string; reason?: string },
  jobId?: number,
) {
  if (p.kind === "password_reset") return notifyPasswordReset(d, p);
  const e = await d.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [p.envelopeId]);
  if (!e) return;
  const org = await d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [e.tenant_id]);
  const sender = e.created_by
    ? await d.db.one<any>(
        `SELECT u.name, u.email, u.locale, EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = $2 AND m.user_id = u.id) AS is_member
           FROM users u WHERE u.id = $1`,
        [e.created_by, e.tenant_id],
      )
    : null;
  const decliner = p.declinedBy ? await d.db.one<any>(`SELECT name, decline_reason FROM recipients WHERE id = $1`, [p.declinedBy]) : null;
  // Marca blanca: la marca del sobre (sub-marca o la de la organización) da colores, logo, plantillas, textos, dominio
  // de los links y remitente (white-label/brand.ts).
  const wl = await brandForEnvelope(d.db, e);
  const mailBrand = (kind: TemplateKind, locale: string | null) => mailBranding(wl, kind, normLocale(locale));
  const sendAs = await senderFor(d.db, wl);
  const from = { from: sendAs.from, replyTo: sendAs.replyTo, dkim: sendAs.dkim };
  const base = {
    // Quien dejó la organización ya no habla en su nombre: los recordatorios y avisos salen con el de la marca u organización.
    senderName: (sender?.is_member ? sender.name : null) ?? (rebrands(wl) || e.brand_id ? wl.name : org?.name) ?? productLabel(wl),
    organizationName: rebrands(wl) || e.brand_id ? wl.name : org?.name ?? "",
    subject: e.subject,
    declinedBy: decliner?.name ?? null,
    reason: p.kind === "voided" ? e.void_reason : decliner?.decline_reason ?? null,
    // finalize_failed por un documento que no se puede sellar (InvalidPdfError: finalizeGaveUp pone su código en
    // `reason`): reintentar no lo resuelve.
    unsealableCode: p.kind === "finalize_failed" && p.reason ? p.reason : null,
  };

  // Avisos al remitente.
  if (p.kind === "sender_completed" || p.kind === "sender_declined") {
    // Solo a miembros actuales: quien dejó la organización no recibe más el asunto ni el link de sus sobres.
    // Un rechazo pide que alguien actúe, así que sin remitente va a los propietarios; el "completado" se omite.
    const isMember = e.created_by
      ? Boolean(await d.db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [e.tenant_id, e.created_by]))
      : false;
    const to: { email: string; name: string; locale: string | null }[] =
      isMember && sender?.email
        ? [sender]
        : p.kind === "sender_declined"
          ? await d.db.query<any>(
              `SELECT u.email, u.name, u.locale FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.tenant_id = $1 AND m.role = 'owner'`,
              [e.tenant_id],
            )
          : [];
    const link = `${await tenantBaseUrl(d.db, e.tenant_id)}/app/envelopes/${e.id}`;
    return notifyStaff(d, e, p.kind, to, (u) => render(p.kind, u.locale ?? e.locale, { ...base, recipientName: u.name, link }, mailBrand(p.kind, u.locale ?? e.locale)), link, () => e.locale, from, jobId);
  }

  // Finalización fallida: a propietarios y administradores de la organización, y al remitente.
  if (p.kind === "finalize_failed") {
    if (e.status !== "finalizing") return;
    const to = await d.db.query<any>(
      `SELECT DISTINCT u.email, u.name, u.locale FROM users u JOIN memberships m ON m.user_id = u.id
       WHERE m.tenant_id = $1 AND (m.role IN ('owner','admin') OR u.id = $2)`,
      [e.tenant_id, e.created_by],
    );
    const link = `${await tenantBaseUrl(d.db, e.tenant_id)}/app/envelopes/${e.id}`;
    return notifyStaff(d, e, p.kind, to, (u) => render("finalize_failed", u.locale ?? e.locale, { ...base, recipientName: u.name, link }, mailBrand("finalize_failed", u.locale ?? e.locale)), link, (u) => u.locale ?? e.locale, from, jobId);
  }

  const r = await d.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [p.recipientId]);
  if (!r) return;
  // Invitaciones/recordatorios obsoletos (el sobre cambió de estado mientras esperaban en la cola).
  if ((p.kind === "invite" || p.kind === "reminder" || p.kind === "expiry_warning") && (e.status !== "sent" || !["sent", "viewed"].includes(r.status))) return;
  // Ya vencido (el barrido todavía no lo pasó a 'expired'): un recordatorio o aviso de vencimiento llevaría a un link
  // que ya no sirve para firmar.
  if ((p.kind === "reminder" || p.kind === "expiry_warning") && pastExpiry(e)) return;
  if (p.kind === "certificate_request" && e.status !== "awaiting_certificates") return;
  // Embebidos (el integrador muestra la ceremonia en su app), en persona (firma en el dispositivo del anfitrión) y
  // autorregistrados sin correo validado: sin invitaciones, recordatorios ni avisos de anulación o rechazo
  // (receivesSignerNotices, la misma regla que usan los recordatorios y la anulación).
  if (["invite", "reminder", "expiry_warning", "voided", "declined"].includes(p.kind) && !receivesSignerNotices(r)) return;
  // Autoregistrado en un formulario web público sin correo verificado: tampoco pedidos de firma con certificado (si no,
  // el formulario serviría para hacer llegar correos a una dirección ajena). El completado sí, pero solo por correo, sin
  // adjunto ni link (el link de firma baja el PDF firmado y la dirección no está verificada): dice que lo descargue desde
  // la página donde firmó, con una nota para quien no completó el formulario.
  const unverified = isUnverifiedSelfRegistered(r);
  if (unverified && p.kind !== "completed") return;

  const locale = r.locale ?? e.locale;
  const token = r.access_token_enc && !unverified ? decrypt(r.access_token_enc) : null;
  const link = token && LINK_KINDS.includes(p.kind) ? `${wl.baseUrl}/s/${token}` : null;
  const m0 = render(p.kind, locale, { ...base, recipientName: r.name, message: p.kind === "invite" ? e.message : null, link }, mailBrand(p.kind, locale));
  const unverifiedNote = `${UNVERIFIED_COMPLETED_TEXT[normLocale(locale)]}\n\n${UNVERIFIED_COPY_NOTE[normLocale(locale)]}`;
  const m = unverified
    ? { ...m0, text: `${m0.text}\n\n${unverifiedNote}`, html: withHtmlNote(withHtmlNote(m0.html, UNVERIFIED_COMPLETED_TEXT[normLocale(locale)]), UNVERIFIED_COPY_NOTE[normLocale(locale)]) }
    : m0;

  // Sin repetidos: los esquemas aceptan ["email","email",…] (también al delegar, desde el link público) y cada repetición
  // era un envío más del mismo aviso al mismo destino.
  const channels: ("email" | "whatsapp" | "telegram")[] = unverified ? ["email"] : [...new Set<"email" | "whatsapp" | "telegram">(r.channels ?? ["email"])];
  // Telegram sin vincular: el correo invita a activarlo desde la página de firma (que genera un link t.me de un solo
  // uso). El token de firma no viaja a Telegram.
  const tgHint = link && channels.includes("telegram") && !r.telegram_chat_id && config.telegram.botUsername ? TELEGRAM_HINT[normLocale(locale)] : null;
  const errors: { text: string; transient: boolean }[] = [];
  let delivered = 0;

  for (const channel of channels) {
    let to: string | null = null;
    if (channel === "email") to = r.email;
    if (channel === "whatsapp") to = r.phone;
    if (channel === "telegram") to = r.telegram_chat_id;
    if (!to) continue; // Telegram sin vincular: va el aviso para vincularlo por los otros canales.
    const waTemplate = channel === "whatsapp" ? whatsappTemplate(p.kind) : null;
    if (channel === "whatsapp" && !waTemplate) {
      d.log.warn({ envelopeId: e.id, kind: p.kind }, "aviso sin plantilla de WhatsApp aprobada (WHATSAPP_*_TEMPLATE): no sale por WhatsApp");
      continue;
    }
    // Cada canal se registra con el job: si otro canal falla y el job se reintenta (o el proceso murió entre canales),
    // el reintento manda solo los canales que todavía no salieron. El registro después del envío no lo marca fallido.
    const out = await sendTracked(
      d.db,
      { tenantId: e.tenant_id, envelopeId: e.id, recipientId: r.id, template: p.kind, jobId, log: d.log },
      {
        channel,
        to,
        subject: m.subject,
        text: channel === "telegram" ? telegramText(m.subject, m.text, m.platformFooter) : m.text + (channel === "email" && tgHint ? `\n\n${tgHint} ${link}` : ""),
        // El aviso para vincular Telegram también en la versión HTML (casi todos los clientes muestran esa).
        html: channel === "email" && tgHint && link ? withHtmlHint(m.html, tgHint, link) : m.html,
        link,
        cta: m.cta,
        locale,
        // WhatsApp rechaza parámetros vacíos o con saltos de línea/tabulaciones.
        templateParams: [base.senderName, e.subject, link ?? "-"].map(waParam),
        ...(waTemplate ? { template: waTemplate } : {}),
        tenantId: e.tenant_id,
        ...(channel === "email" ? from : {}),
      },
    );
    if (out.status === "failed") {
      // Sin el destino: el error termina en los logs y en jobs.last_error.
      errors.push({ text: `${channel}: ${out.error}`, transient: out.transient });
      continue;
    }
    if (out.status === "already") continue; // ya enviado por este job
    if (out.status === "sent") delivered++;
    try {
      await d.db.tx(async (t) => {
        await t.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
        await appendEvent(t, {
          tenantId: e.tenant_id,
          envelopeId: e.id,
          // Dirección suprimida (rebotó o se quejó antes): no sale, y el remitente lo ve en la actividad del sobre.
          type: out.status === "sent" ? "notification.sent" : "notification.suppressed",
          actor: SYSTEM,
          data: {
            recipientId: r.id,
            channel,
            template: p.kind,
            destination: maskDestination(to!),
            ...(out.status === "sent" ? { provider: out.res.provider } : {}),
          },
        });
      });
    } catch (err) {
      d.log.error({ err: scrubPii(String(err)), envelopeId: e.id, channel }, "aviso enviado pero no registrado");
    }
  }
  // Algún canal falló por un error del momento (red, timeout, 5xx o 429 del proveedor): se reintenta el job (solo los
  // canales que no salieron: los que salieron quedan registrados con el job). Si todos los fallos son permanentes
  // (número inválido, plantilla rechazada, chat bloqueado, SMTP 5xx), reintentar no los arregla: quedan registrados
  // (notifications.status = 'failed') y en el log, y el job termina.
  if (errors.some((x) => x.transient)) throw new Error(`no se pudo notificar: ${errors.map((x) => x.text).join("; ")}`);
  if (errors.length) {
    d.log.warn({ envelopeId: e.id, recipientId: r.id, kind: p.kind, errors: errors.map((x) => x.text) }, "aviso con canales fallidos por errores permanentes: no se reintenta");
    return;
  }
  // Ningún canal posible (p. ej. solo Telegram sin vincular y sin otro canal para el link): que quede a la vista.
  if (delivered === 0) d.log.warn({ envelopeId: e.id, recipientId: r.id, kind: p.kind, channels }, "aviso sin ningún canal nuevo: no salió");
}

/**
 * Avisos por correo a personas del equipo (remitente, propietarios, administradores). Cada dirección por separado:
 * si una falla (p. ej. el SMTP rechaza una dirección), las demás igual se avisan y queda registrada la falla. El job
 * se reintenta solo si no salió ninguno; si no, cada reintento les volvería a mandar el aviso a quienes ya lo
 * recibieron (hasta agotar los intentos).
 */
async function notifyStaff(
  d: Deps,
  e: { id: string; tenant_id: string },
  kind: TemplateKind,
  to: { email: string; name: string; locale: string | null }[],
  message: (u: { name: string; locale: string | null }) => { subject: string; text: string; html: string },
  link: string,
  localeOf: (u: { locale: string | null }) => string,
  from: { from?: string | null; replyTo?: string | null; dkim?: { domainName: string; keySelector: string; privateKey: string } | null } = {},
  jobId?: number,
) {
  const errors: { error: string; transient: boolean }[] = [];
  let delivered = 0;
  for (const u of to) {
    if (!u.email) continue;
    const m = message(u);
    // Como notify(): el envío cuenta apenas sale (si después falla el registro, un reintento no repite el correo a
    // quien ya lo recibió) y el registro de una falla no corta el resto.
    const out = await sendTracked(
      d.db,
      { tenantId: e.tenant_id, envelopeId: e.id, template: kind, jobId, log: d.log },
      { channel: "email", to: u.email, subject: m.subject, text: m.text, html: m.html, link, locale: localeOf(u), tenantId: e.tenant_id, ...from },
    );
    // Sin la dirección en el error: termina en los logs y en jobs.last_error.
    if (out.status === "failed") errors.push(out);
    else delivered++;
  }
  // Como notify(): solo se reintenta por errores del momento (con todos permanentes, reintentar no los arregla).
  if (delivered === 0 && errors.some((x) => x.transient)) throw new Error(`no se pudo notificar (${errors.length}): ${errors.map((x) => x.error).join("; ")}`);
  if (errors.length) d.log.warn({ envelopeId: e.id, kind, errors: errors.map((x) => x.error) }, "avisos al equipo con fallos");
}

/** Correo de restablecimiento de contraseña. El token viaja cifrado en el job y se descarta si ya no sirve. */
async function notifyPasswordReset(d: Deps, p: { userId?: string; tokenEnc?: string }) {
  if (!p.userId || !p.tokenEnc) return;
  const token = decrypt(p.tokenEnc);
  const valid = await d.db.one(`SELECT 1 FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`, [sha256Hex(token)]);
  if (!valid) return;
  const u = await d.db.one<any>(`SELECT email, name, locale FROM users WHERE id = $1`, [p.userId]);
  if (!u?.email) return;
  const link = `${config.appUrl}/reset/${token}`;
  const vars = { recipientName: u.name, senderName: "CalaSign", organizationName: "CalaSign", subject: "", link };
  const m = render("password_reset", u.locale, { ...vars, subject: render("password_reset", u.locale, vars).subject });
  try {
    await deliver({ channel: "email", to: u.email, subject: m.subject, text: m.text, html: m.html, link, locale: u.locale });
  } catch (e) {
    // Sin la dirección (ni el link con el token) en el error: termina en jobs.last_error y en los logs. Los
    // proveedores SMTP suelen repetir el destinatario en el rechazo ("550 <ana@…>: user unknown").
    throw new Error(`no se pudo enviar el correo de restablecimiento: ${scrubPii(String(e)).split(token).join("[token]").slice(0, 500)}`);
  }
}

// ───────────────────────────── Finalización y sellado ─────────────────────────────

/** IP de la última apertura (recipient.viewed) del destinatario anterior a su firma; si no hay, la de la última. */
export function certificateViewIp(
  events: { type: string; actor_id: string | null; occurred_at: string | Date; ip?: string | null }[],
  recipientId: string,
  signedAt: string | Date | null,
): string | null {
  const views = events.filter((x) => x.type === "recipient.viewed" && x.actor_id === recipientId);
  if (!views.length) return null;
  const limit = signedAt ? new Date(signedAt).getTime() : null;
  const before = limit === null ? [] : views.filter((x) => new Date(x.occurred_at).getTime() <= limit);
  return ((before.length ? before : views).at(-1)?.ip as string | null | undefined) ?? null;
}

async function finalize(d: Deps, p: { envelopeId: string; tenantId: string }) {
  const e = await d.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [p.envelopeId]);
  if (!e || e.status !== "finalizing") return;
  await finalizeFieldLogic(d.db, e.id);
  const [docs, fields, recips, sigImages, org, sender, events] = await Promise.all([
    loadDocuments(d.db, e.id),
    d.db.query<any>(`SELECT * FROM fields WHERE envelope_id = $1 AND NOT hidden`, [e.id]),
    d.db.query<any>(`SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order, created_at`, [e.id]),
    loadSignatureImages(d.db, d.blobs, e.id),
    d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [e.tenant_id]),
    e.created_by ? d.db.one<any>(`SELECT name, email FROM users WHERE id = $1`, [e.created_by]) : Promise.resolve(null),
    d.db.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [e.id]),
  ]);

  const docBytes = await Promise.all(docs.map((x) => d.blobs.get(x.storage_key)));
  const stampFields: StampField[] = toStampFields(fields, docs, sigImages);

  // IP del certificado sin signed_ip: la de la última apertura ANTERIOR a la firma (la sesión desde la que firmó), no la
  // de la primera (otro dispositivo, días antes) ni una posterior (volvió a abrir el link después de firmar). Sin
  // apertura anterior (o sin fecha de firma), la última.
  const lastViewIp = (r: any) => certificateViewIp(events, r.id, r.signed_at);
  const inPersonLabels = await inPersonAuthLabels(d.db, recips, e.locale);
  const identities = await identityForCertificate(d.db, recips);
  const certRecipients: CertificateRecipient[] = recips.map((r) => ({
    name: r.name,
    role: r.role,
    email: r.email,
    phone: r.phone,
    // Enmascarado como el de la verificación de identidad: el certificado lo reciben todos los destinatarios.
    idDocument: r.id_document_number ? `${(r.id_document_type ?? "").toUpperCase()} ${maskDocNumber(r.id_document_number)}`.trim() : null,
    channels: r.channels,
    authMethod: inPersonLabels.get(r.id) ?? (r.embedded ? embeddedAuthLabel(e.locale) : r.auth_method),
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    viewedAt: r.viewed_at ? new Date(r.viewed_at).toISOString() : null,
    consentedAt: r.consented_at ? new Date(r.consented_at).toISOString() : null,
    signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
    ip: r.signed_ip ?? lastViewIp(r),
    userAgent: r.signed_user_agent ?? null,
    signaturePng: sigImages.get(`${r.id}:signature`) ?? null,
    note: replacementNote(r, recips, e.locale),
    identity: identities.get(r.id) ?? null,
    certificateSignature: r.role === "signer" && r.signature_type === "certificate",
  }));
  let completedAt = new Date().toISOString();
  // El certificado imprime el hash final y afirma que los eventos están encadenados: con la cadena rota (filas editadas)
  // no se sella (el job falla y se avisa) en lugar de darle apariencia de auténtica.
  const chain = verifyRows(events);
  if (!chain.ok) throw new Error(`la cadena de evidencia está rota en el evento ${chain.brokenAt}: no se sella`);
  let chainHead = chain.head || (events[events.length - 1]?.hash ?? "");

  // Adjuntos de los firmantes y branding de la organización. Los de campos ocultos por la lógica no van: el
  // firmante subió el archivo y después eligió una opción que lo deja fuera (p. ej. "no aplica"), y el PDF final
  // igual anexaba ese documento (que podía ser una foto de su cédula).
  const attachRows = await d.db.query<any>(
    `SELECT f.value AS name, f.recipient_id, fl.storage_key, fl.content_type, fl.sha256
     FROM fields f JOIN files fl ON fl.id = f.attachment_file_id
     WHERE f.envelope_id = $1 AND f.type = 'attachment' AND NOT f.hidden ORDER BY f.page, f.y, f.x`,
    [e.id],
  );
  const attachments = await Promise.all(
    attachRows.map(async (x) => ({
      name: x.name ?? "adjunto",
      recipientName: recips.find((r) => r.id === x.recipient_id)?.name ?? "",
      contentType: x.content_type,
      bytes: await d.blobs.get(x.storage_key),
      sha256: x.sha256 as string,
    })),
  );
  const wl = await brandForEnvelope(d.db, e);
  const brandLogo = await brandLogoForPdf(d.db, d.blobs, wl);

  const provider = await getSealProvider();
  const evPlan = await planEvidence(d.db, e);
  const input = {
    documents: docs.map((x, i) => ({ name: x.name, bytes: docBytes[i] })),
    fields: stampFields,
    attachments: attachments.map(({ sha256: _sha, ...x }) => x),
    certificate: {
      envelopeId: e.id,
      subject: e.subject,
      organizationName: e.brand_id || rebrands(wl) ? wl.name : org?.name ?? "",
      senderName: sender?.name ?? org?.name ?? "",
      senderEmail: sender?.email ?? null,
      createdAt: new Date(e.created_at).toISOString(),
      sentAt: e.sent_at ? new Date(e.sent_at).toISOString() : null,
      completedAt,
      locale: e.locale,
      documents: docs.map((x) => ({ name: x.name, pageCount: x.page_count, sha256: x.sha256 })),
      recipients: certRecipients,
      events: events.map((x) => ({
        seq: x.seq,
        type: x.type,
        occurredAt: new Date(x.occurred_at).toISOString(),
        // Marca blanca: las acciones del sistema figuran con el nombre del producto de la marca.
        actor: rebrands(wl) ? brandize(x.actor_label ?? x.actor_type, wl) : x.actor_label ?? x.actor_type,
        ip: x.ip,
      })),
      chainHead,
      // ?b=: la página de verificación muestra la marca aunque se abra desde el dominio de la plataforma.
      verifyUrl: rebrands(wl) || e.brand_id ? `${wl.baseUrl}/verify?b=${encodeURIComponent(wl.key)}` : `${wl.baseUrl}/verify`,
      attachments: attachments.map((x) => ({ name: x.name, recipientName: x.recipientName, sha256: x.sha256, appended: true })),
      payments: await paymentsForCertificate(d.db, e.id, e.locale),
      branding: { primaryColor: wl.theme.primaryColor, logo: brandLogo },
      productName: rebrands(wl) ? productLabel(wl) : undefined,
      ...evPlan.certificate,
    },
  };

  // El certificado dice si lleva sello de tiempo: se fija antes de armar el PDF de la etapa de firma con certificado,
  // que ya incluye la página del certificado (antes quedaba sin definir y afirmaba un sello de tiempo).
  // Con firma con certificado, la página del certificado va dentro del PDF que firman los titulares, antes de saber si el
  // sellado final tendrá sello de tiempo: texto neutro (ni lo afirma ni lo niega).
  (input.certificate as { timestamped?: boolean | null }).timestamped = null;
  // Firma con certificado propio: primero firman los titulares sobre el PDF sin sello; después se sella encima.
  const certStage = await certsignStage(d, e, recips, input);
  if (certStage.kind !== "seal") (input.certificate as { timestamped?: boolean | null }).timestamped = Boolean(config.seal.tsaUrl);
  if (certStage.kind === "waiting") return;
  if (certStage.kind === "seal") {
    completedAt = certStage.completedAt;
    chainHead = certStage.chainHead;
  }
  const sealOnce = (tsaUrl: string | null) =>
    certStage.kind === "seal"
      ? addCadesSignatureIncremental(certStage.workingPdf, provider, { fieldName: "SelloIntegridad", reason: `Sello de integridad ${productLabel(wl)}`, name: productLabel(wl), location: "Cloud", tsaUrl })
      : finalizeEnvelopePdf(input, { provider, tsaUrl, reason: `Sello de integridad ${productLabel(wl)}`, signerName: productLabel(wl), contactInfo: wl.links.supportUrl ?? wl.baseUrl });

  let timestamped = Boolean(config.seal.tsaUrl);
  let tsaError: string | null = null;
  let pdf: Uint8Array;
  try {
    pdf = await sealOnce(config.seal.tsaUrl);
  } catch (err) {
    // Solo una falla de la TSA cae a B-B: otro error (proveedor del sello, KMS) se reintenta con el job (si no, el
    // sobre quedaba completado sin sello de tiempo para siempre por un error ajeno a la TSA).
    if (!config.seal.tsaUrl || config.seal.tsaRequired || (err as Error)?.name !== "TsaError") throw err;
    // La TSA falló: si no es obligatoria, se sella en B-B y queda constancia.
    tsaError = String(err);
    timestamped = false;
    (input.certificate as { timestamped?: boolean }).timestamped = false; // el certificado no afirma un sello de tiempo
    d.log.warn({ envelopeId: e.id, err: tsaError }, "TSA no disponible: sellado sin sello de tiempo");
    pdf = await sealOnce(null);
  }
  // Sello de empresa y PAdES B-LT/B-LTA (revisiones incrementales).
  const evidence = await applyEvidencePipeline(d.db, d.log, e, pdf, evPlan, { timestamped, orgName: org?.name ?? "" });
  pdf = evidence.pdf;

  const fileId = uuidv7();
  const key = `tenants/${e.tenant_id}/envelopes/${e.id}/${fileId}-signed.pdf`;
  const sha = sha256Hex(pdf);
  await d.blobs.put(key, pdf, "application/pdf");

  const completed = await d.db.tx(async (t) => {
    const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
    if (cur?.status !== "finalizing") return false;
    await t.query(
      // chain_head: el hash final impreso en el certificado de este PDF (la verificación pública lo usa sin parsearlo).
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256, chain_head) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5,$6)`,
      [fileId, e.tenant_id, key, pdf.length, sha, /^[0-9a-f]{64}$/.test(chainHead) ? chainHead : null],
    );
    await t.query(
      `UPDATE envelopes SET status = 'completed', completed_at = $2, signed_file_id = $3, updated_at = now(), version = version + 1 WHERE id = $1`,
      [e.id, completedAt, fileId],
    );
    await t.query(`UPDATE recipients SET status = 'completed' WHERE envelope_id = $1 AND role = 'cc'`, [e.id]);
    await appendEvent(t, {
      tenantId: e.tenant_id,
      envelopeId: e.id,
      type: "envelope.completed",
      actor: SYSTEM,
      data: {
        signedSha256: sha,
        certificateChainHead: chainHead,
        seal: {
          provider: provider.id,
          format: evidence.format,
          tsa: timestamped ? config.seal.tsaUrl : null,
          tsaError,
          ltv: evidence.ltv ? { ocsps: evidence.ltv.ocsps, crls: evidence.ltv.crls, certs: evidence.ltv.certs, missingRevocation: evidence.ltv.missingRevocation } : null,
          ltvError: evidence.ltvError,
          companySeal: evidence.companySeal,
          signatureLevel: evPlan.signatureLevel,
        },
      },
    });
    for (const r of recips.filter((x) => x.status !== "delegated" && x.status !== "reassigned"))
      await enqueue(t, "notify", { kind: "completed", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id });
    await enqueue(t, "notify", { kind: "sender_completed", envelopeId: e.id, tenantId: e.tenant_id });
    return true;
  }).catch(async (err) => {
    // Sin fila en `files` el PDF sellado recién subido no lo referencia nada (la retención nunca lo vería).
    await d.blobs.delete(key).catch(() => {});
    throw err;
  });
  // Otra corrida ya completó el sobre: este PDF sellado quedó sin usar.
  if (!completed) await d.blobs.delete(key).catch(() => {});
  // El PDF de trabajo de las firmas con certificado ya está dentro del sellado: sin fila en `files`, la retención no lo
  // borraría nunca (y lleva los adjuntos de los firmantes).
  if (completed && certStage.kind === "seal") await d.blobs.delete(certStage.workingKey).catch(() => {});
  d.log.info({ envelopeId: e.id, sha256: sha, bytes: pdf.length }, "sobre completado y sellado");
}

/**
 * La finalización agotó sus reintentos: queda constancia en la evidencia y se avisa a los administradores.
 * El sobre sigue en 'finalizing' (no se completa ni se pierde nada) hasta que alguien lo reintente con
 * POST /v1/envelopes/:id/retry-finalize.
 */
export async function finalizeGaveUp(d: Deps, p: { envelopeId: string; tenantId: string }, err: unknown) {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  // Documento que no se puede sellar (determinista: reintentar no lo arregla): el código va en el evento y en el aviso.
  const code = err instanceof InvalidPdfError ? err.code : null;
  await d.db.tx(async (t) => {
    const e = await t.one<any>(`SELECT id, tenant_id, status FROM envelopes WHERE id = $1 FOR UPDATE`, [p.envelopeId]);
    if (!e || e.status !== "finalizing") return;
    await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.finalize_failed", actor: SYSTEM, data: { error: message, ...(code ? { code } : {}) } });
    await enqueue(t, "notify", { kind: "finalize_failed", envelopeId: e.id, tenantId: e.tenant_id, ...(code ? { reason: code } : {}) });
  });
  d.log.error({ envelopeId: p.envelopeId, err: message, code }, "la finalización del sobre falló definitivamente");
}

// ───────────────────────────── Tareas periódicas ─────────────────────────────

/** Última purga de jobs terminados de este proceso (ver el paso "jobs-purge"). */
let lastJobsPurgeAt = 0;
const JOBS_PURGE_EVERY_MS = 3600_000;

export async function sweep(d: Deps, signal?: AbortSignal) {
  // Cada tarea por separado: una que falla (p. ej. un proveedor caído) no puede frenar a las demás, en
  // particular el vencimiento de sobres de más abajo.
  const steps: [string, () => Promise<unknown>][] = [
    [
      "requeue",
      async () => {
        // Jobs que agotaron sus intentos con el worker caído: una finalización no puede quedar trabada en silencio.
        for (const j of await requeueStuckJobs(d.db)) {
          if (j.queue === "finalize") await finalizeGaveUp(d, j.payload, new Error("el worker se detuvo durante la finalización (intentos agotados)"));
        }
      },
    ],
    // Jobs terminados hace más de JOBS_RETENTION_DAYS (30): sin esto la tabla crecía para siempre. Retiene los que
    // todavía deduplican (claves atadas a un sobre vivo): ver la política en purgeFinishedJobs (infra/queue.ts). Como
    // mucho una vez por hora por proceso (y una sola a la vez entre procesos, con un candado consultivo).
    [
      "jobs-purge",
      async () => {
        if (Date.now() - lastJobsPurgeAt >= JOBS_PURGE_EVERY_MS) {
          lastJobsPurgeAt = Date.now();
          await purgeFinishedJobs(d.db, { olderThanDays: config.jobs.retentionDays, signal });
        }
        await d.db.query(`DELETE FROM worker_heartbeats WHERE beat_at < now() - interval '1 day'`);
      },
    ],
    ["reminders", () => runAutomaticReminders(d.db)],
    ["retention", () => purgeExpiredEnvelopes(d)],
    // Ejecuciones de CRM y conectores de más de INTEGRATION_RUNS_RETENTION_DAYS (180 por defecto).
    ["integration-runs", () => purgeOldIntegrationRuns(d.db)],
    // Entregas de webhooks de más de WEBHOOK_DELIVERY_RETENTION_DAYS (90 por defecto).
    ["webhook-deliveries", () => purgeOldWebhookDeliveries(d.db)],
    ["ai", () => runAiSweep(d)],
    ["agreements", () => agreementsSweep(d)],
    ["data", () => dataSweep(d)],
    ["domains", () => recheckVerifiedDomains(d)],
    ["white-label-domains", () => recheckWhiteLabelDomains(d)],
    // Apps OAuth registradas dinámicamente (conectores MCP) que nadie autorizó en 30 días.
    ["oauth", () => purgeUnusedDynamicClients(d.db)],
    // Links de descarga temporales (MCP): nada más los borraba.
    // Tokens de formularios web usados: vencen a las 2 h, después no hace falta recordarlos.
    ["web-form-tokens", () => d.db.query(`DELETE FROM web_form_token_uses WHERE used_at < now() - interval '1 day'`)],
    // IDs de Assertion SAML ya usadas (anti-replay): pasado su vencimiento la aserción ya no se acepta.
    ["saml-assertion-ids", () => d.db.query(`DELETE FROM saml_assertion_ids WHERE ctid IN (SELECT ctid FROM saml_assertion_ids WHERE expires_at < now() LIMIT 5000)`)],
    // Tokens de vinculación de Telegram (30 minutos): vencidos hace más de un día ya no hacen falta.
    ["telegram-link-tokens", () => d.db.query(`DELETE FROM telegram_link_tokens WHERE expires_at < now() - interval '1 day'`)],
    // Tokens de sesión del firmante (canje embebido, 0083): vencidos o revocados hace más de un día ya no abren nada
    // (resolveSessionToken los rechaza); de a 5000 por pasada, por los índices de expires_at y revoked_at (0084).
    [
      "signer-session-tokens",
      () =>
        d.db.query(
          `DELETE FROM signer_session_tokens WHERE ctid IN (SELECT ctid FROM signer_session_tokens WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day' LIMIT 5000)`,
        ),
    ],
    [
      "download-links",
      () => d.db.query(`DELETE FROM download_links WHERE ctid IN (SELECT ctid FROM download_links WHERE expires_at < now() - interval '1 day' LIMIT 5000)`),
    ],
    // Claves de idempotencia de más de 7 días: un reintento real llega en minutos u horas (Stripe las guarda 24 h) y
    // los conectores sin clave propia (Zapier, Make) usan una por día. Sin esto la tabla crecía sin límite.
    // De a 5000 por pasada para no bloquear la tabla.
    [
      "idempotency",
      () =>
        d.db.query(
          `DELETE FROM idempotency_keys WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE created_at < now() - interval '7 days' LIMIT 5000)`,
        ),
    ],
  ];
  for (const [name, step] of steps) {
    // Apagado: no se empieza otra tarea (la que está en curso termina sola o la corta el cierre de la base).
    if (signal?.aborted) return;
    try {
      await step();
    } catch (err) {
      d.log.error({ err: String(err), step: name }, "tarea periódica falló");
    }
  }
  if (signal?.aborted) return;
  const expired = await d.db
    .query<any>(`SELECT id, tenant_id FROM envelopes WHERE status IN ('sent','awaiting_certificates') AND expires_at < now() ORDER BY expires_at LIMIT 100`)
    .catch((err) => {
      d.log.error({ err: String(err), step: "expire" }, "tarea periódica falló");
      return [] as any[];
    });
  // De a uno con su propio manejo de errores: un sobre que falla (p. ej. una integración rota de una organización)
  // no frena el vencimiento de los demás ni los pasos de pagos de abajo.
  for (const e of expired) {
    if (signal?.aborted) return;
    try {
      await d.db.tx(async (t) => {
        const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
        if (cur?.status !== "sent" && cur?.status !== "awaiting_certificates") return;
        await t.query(`UPDATE envelopes SET status = 'expired', updated_at = now(), version = version + 1 WHERE id = $1`, [e.id]);
        await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.expired", actor: SYSTEM });
      });
    } catch (err) {
      d.log.error({ err: String(err), envelopeId: e.id, step: "expire" }, "no se pudo vencer el sobre");
    }
  }
  if (signal?.aborted) return;
  // Después del vencimiento, así los sobres que vencieron recién también cierran su checkout.
  await closeStaleCheckouts(d).catch((err) => d.log.error({ err: String(err), step: "payments" }, "tarea periódica falló"));
  await refundPaymentsOnClosedEnvelopes(d).catch((err) => d.log.error({ err: String(err), step: "refunds" }, "tarea periódica falló"));
  // Suscripciones reemplazadas que no se pudieron cancelar en el proveedor al cambiar de suscripción.
  await cancelPendingSubscriptions(d).catch((err) => d.log.error({ err: String(err), step: "subscriptions" }, "tarea periódica falló"));
}

const REPLACED = {
  es: { delegated: "Delegó en", reassigned: "Reasignado a" },
  "pt-BR": { delegated: "Delegou para", reassigned: "Reatribuído a" },
  en: { delegated: "Delegated to", reassigned: "Reassigned to" },
} as const;

/** Nota del certificado para destinatarios reemplazados (delegó / fue reasignado). */
function replacementNote(r: any, all: any[], locale: string): string | null {
  if (r.status !== "delegated" && r.status !== "reassigned") return null;
  const to = all.find((x) => x.id === r.replaced_by);
  const L = REPLACED[(locale in REPLACED ? locale : "es") as keyof typeof REPLACED];
  const base = `${L[r.status as "delegated" | "reassigned"]} ${to?.name ?? "?"}`;
  return r.replace_reason ? `${base}: ${r.replace_reason}` : base;
}
