import { addCadesSignatureIncremental, finalizeEnvelopePdf, type CertificateRecipient, type StampField } from "@calasign/pdf";
import { certsignStage } from "./certsign";
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import { enqueue, requeueStuckJobs, type JobHandler, type JobQueueName } from "../infra/queue";
import { getSealProvider } from "../infra/seal";
import { applyEvidencePipeline, planEvidence } from "./evidence-seal";
import type { BlobStore } from "../infra/storage";
import { decrypt, maskDestination, sha256Hex, uuidv7 } from "../lib/util";
import { deliver, telegramStartLink } from "../notifications/channels";
import { normLocale, render, type TemplateKind } from "../notifications/templates";
import { loadDocuments } from "./mappers";
import { loadSignatureImages, toStampFields } from "./stamp-fields";
import { finalizeFieldLogic } from "./logic";
import { handleBulkJob } from "./bulk";
import { embeddedAuthLabel } from "./embed";
import { inPersonAuthLabels } from "./experience";
import { handleWebhookJob } from "./webhooks";
import { runAutomaticReminders } from "./reminders";
import { purgeExpiredEnvelopes } from "./retention";
import { purgeUnusedDynamicClients } from "./oauth";
import { brandForEnvelope, brandize, mailBranding, productLabel, rebrands, senderFor } from "./white-label/brand";
import { brandLogoForPdf, recheckWhiteLabelDomains } from "./white-label";
import { handlePlatformJob } from "./platform-fanout";
import { recheckVerifiedDomains, tenantBaseUrl } from "./custom-domains";
import { dataSweep } from "./data";
import { identityForCertificate } from "./identity/kyc";
import { closeStaleCheckouts, paymentsForCertificate, refundPaymentsOnClosedEnvelopes } from "./billing/payments";
import { runAiSweep } from "./ai";
import { agreementsSweep, handleAgreementsJob } from "./agreements";

interface Deps {
  db: Db;
  blobs: BlobStore;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

const LINK_KINDS: TemplateKind[] = ["invite", "reminder", "completed", "expiry_warning", "certificate_request"];
const TELEGRAM_HINT = {
  es: "¿Preferís recibir los avisos por Telegram?",
  "pt-BR": "Prefere receber os avisos pelo Telegram?",
  en: "Prefer to get notifications on Telegram?",
} as const;

export function createJobHandlers(d: Deps): Record<JobQueueName, JobHandler> {
  return {
    notify: (p) => notify(d, p),
    finalize: async (p, job) => {
      try {
        await finalize(d, p);
      } catch (err) {
        // Último intento: el sobre no puede quedar en 'finalizing' sin que nadie se entere.
        if (job.attempts >= job.maxAttempts) await finalizeGaveUp(d, p, err).catch((e) => d.log.error({ err: String(e), envelopeId: p.envelopeId }, "no se pudo registrar el fallo de finalización"));
        throw err;
      }
    },
    webhook: (p, job) => handleWebhookJob(d, p, job),
    bulk: (p) => handleBulkJob(d, p),
    platform: (p, job) => handlePlatformJob(d, p, job),
    agreements: (p) => handleAgreementsJob(d, p),
  };
}

// ───────────────────────────── Notificaciones ─────────────────────────────

async function notify(
  d: Deps,
  p: { kind: TemplateKind; envelopeId: string; tenantId: string; recipientId?: string; declinedBy?: string; userId?: string; tokenEnc?: string },
) {
  if (p.kind === "password_reset") return notifyPasswordReset(d, p);
  const e = await d.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [p.envelopeId]);
  if (!e) return;
  const org = await d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [e.tenant_id]);
  const sender = e.created_by ? await d.db.one<any>(`SELECT name, email, locale FROM users WHERE id = $1`, [e.created_by]) : null;
  const decliner = p.declinedBy ? await d.db.one<any>(`SELECT name, decline_reason FROM recipients WHERE id = $1`, [p.declinedBy]) : null;
  // Marca blanca: la marca del sobre (sub-marca o la de la organización) da colores, logo, plantillas, textos, dominio
  // de los links y remitente (white-label/brand.ts).
  const wl = await brandForEnvelope(d.db, e);
  const mailBrand = (kind: TemplateKind, locale: string | null) => mailBranding(wl, kind, normLocale(locale));
  const sendAs = await senderFor(d.db, wl);
  const from = { from: sendAs.from, replyTo: sendAs.replyTo, dkim: sendAs.dkim };
  const base = {
    senderName: sender?.name ?? (rebrands(wl) || e.brand_id ? wl.name : org?.name) ?? productLabel(wl),
    organizationName: rebrands(wl) || e.brand_id ? wl.name : org?.name ?? "",
    subject: e.subject,
    declinedBy: decliner?.name ?? null,
    reason: p.kind === "voided" ? e.void_reason : decliner?.decline_reason ?? null,
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
    return notifyStaff(d, e, p.kind, to, (u) => render(p.kind, u.locale ?? e.locale, { ...base, recipientName: u.name, link }, mailBrand(p.kind, u.locale ?? e.locale)), link, () => e.locale, from);
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
    return notifyStaff(d, e, p.kind, to, (u) => render("finalize_failed", u.locale ?? e.locale, { ...base, recipientName: u.name, link }, mailBrand("finalize_failed", u.locale ?? e.locale)), link, (u) => u.locale ?? e.locale, from);
  }

  const r = await d.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [p.recipientId]);
  if (!r) return;
  // Invitaciones/recordatorios obsoletos (el sobre cambió de estado mientras esperaban en la cola).
  if ((p.kind === "invite" || p.kind === "reminder" || p.kind === "expiry_warning") && (e.status !== "sent" || !["sent", "viewed"].includes(r.status))) return;
  if (p.kind === "certificate_request" && e.status !== "awaiting_certificates") return;
  // Firma embebida: el integrador muestra la ceremonia en su app; no se mandan invitaciones ni avisos.
  if ((p.kind === "invite" || p.kind === "reminder" || p.kind === "expiry_warning") && (r.embedded || r.auth_method === "in_person")) return;
  // Autoregistrado en un formulario web público: sin correo verificado no se le escribe (salvo la copia final).
  // Ningún otro aviso: ni rechazos, anulaciones o pedidos de firma con certificado; si no, el formulario serviría
  // para hacer llegar correos a una dirección ajena. Ya tiene el link en la pantalla del formulario.
  if (p.kind !== "completed" && r.self_registered && !(r.auth_method === "otp_email" && r.authenticated_at)) return;

  const locale = r.locale ?? e.locale;
  const token = r.access_token_enc ? decrypt(r.access_token_enc) : null;
  const link = token && LINK_KINDS.includes(p.kind) ? `${wl.baseUrl}/s/${token}` : null;
  const m = render(p.kind, locale, { ...base, recipientName: r.name, message: p.kind === "invite" ? e.message : null, link }, mailBrand(p.kind, locale));

  // Sin repetidos: los esquemas aceptan ["email","email",…] (también al delegar, desde el link público) y cada repetición
  // era un envío más del mismo aviso al mismo destino.
  const channels: ("email" | "whatsapp" | "telegram")[] = [...new Set<"email" | "whatsapp" | "telegram">(r.channels ?? ["email"])];
  const tgLink = token && channels.includes("telegram") && !r.telegram_chat_id ? telegramStartLink(token) : null;
  const errors: string[] = [];
  let delivered = 0;

  for (const channel of channels) {
    let to: string | null = null;
    if (channel === "email") to = r.email;
    if (channel === "whatsapp") to = r.phone;
    if (channel === "telegram") to = r.telegram_chat_id;
    if (!to) continue; // Telegram sin vincular: va el link de vinculación por los otros canales.
    const nid = uuidv7();
    try {
      const extra = tgLink ? `\n\n${TELEGRAM_HINT[locale as keyof typeof TELEGRAM_HINT] ?? TELEGRAM_HINT.es} ${tgLink}` : "";
      const res = await deliver({
        channel,
        to,
        subject: m.subject,
        text: channel === "telegram" ? `${m.subject}\n\n${m.text.replace(/\n— .*$/s, "")}` : m.text + (channel === "email" ? extra : ""),
        html: m.html,
        link,
        cta: m.cta,
        locale,
        templateParams: [base.senderName, e.subject, link ?? ""],
        tenantId: e.tenant_id,
        ...(channel === "email" ? from : {}),
      });
      await d.db.query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, provider, provider_message_id, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'sent',$8,$9,now())`,
        [nid, e.tenant_id, e.id, r.id, channel, p.kind, to, res.provider, res.messageId],
      );
      await d.db.tx(async (t) => {
        await t.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
        await appendEvent(t, {
          tenantId: e.tenant_id,
          envelopeId: e.id,
          type: "notification.sent",
          actor: SYSTEM,
          data: { recipientId: r.id, channel, template: p.kind, destination: maskDestination(to!), provider: res.provider },
        });
      });
      delivered++;
    } catch (err) {
      errors.push(`${channel}: ${String(err)}`);
      await d.db.query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,'failed',$8)`,
        [nid, e.tenant_id, e.id, r.id, channel, p.kind, to, String(err).slice(0, 1000)],
      );
    }
  }
  // Si no salió por ningún canal, reintentar el job.
  if (delivered === 0 && errors.length) throw new Error(`no se pudo notificar: ${errors.join("; ")}`);
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
) {
  const errors: string[] = [];
  let delivered = 0;
  for (const u of to) {
    if (!u.email) continue;
    const m = message(u);
    try {
      const res = await deliver({ channel: "email", to: u.email, subject: m.subject, text: m.text, html: m.html, link, locale: localeOf(u), tenantId: e.tenant_id, ...from });
      await d.db.query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, channel, template, destination, status, provider, provider_message_id, sent_at)
         VALUES ($1,$2,$3,'email',$4,$5,'sent',$6,$7,now())`,
        [uuidv7(), e.tenant_id, e.id, kind, u.email, res.provider, res.messageId],
      );
      delivered++;
    } catch (err) {
      errors.push(`${u.email}: ${String(err)}`);
      await d.db.query(
        `INSERT INTO notifications (id, tenant_id, envelope_id, channel, template, destination, status, error) VALUES ($1,$2,$3,'email',$4,$5,'failed',$6)`,
        [uuidv7(), e.tenant_id, e.id, kind, u.email, String(err).slice(0, 1000)],
      );
    }
  }
  if (delivered === 0 && errors.length) throw new Error(`no se pudo notificar: ${errors.join("; ")}`);
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
  await deliver({ channel: "email", to: u.email, subject: m.subject, text: m.text, html: m.html, link, locale: u.locale });
}

// ───────────────────────────── Finalización y sellado ─────────────────────────────

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

  const ev = (r: any, type: string) => events.find((x) => x.type === type && x.actor_id === r.id);
  const inPersonLabels = await inPersonAuthLabels(d.db, recips, e.locale);
  const identities = await identityForCertificate(d.db, recips);
  const certRecipients: CertificateRecipient[] = recips.map((r) => ({
    name: r.name,
    role: r.role,
    email: r.email,
    phone: r.phone,
    idDocument: r.id_document_number ? `${(r.id_document_type ?? "").toUpperCase()} ${r.id_document_number}`.trim() : null,
    channels: r.channels,
    authMethod: inPersonLabels.get(r.id) ?? (r.embedded ? embeddedAuthLabel(e.locale) : r.auth_method),
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    viewedAt: r.viewed_at ? new Date(r.viewed_at).toISOString() : null,
    consentedAt: r.consented_at ? new Date(r.consented_at).toISOString() : null,
    signedAt: r.signed_at ? new Date(r.signed_at).toISOString() : null,
    ip: r.signed_ip ?? ev(r, "recipient.viewed")?.ip ?? null,
    userAgent: r.signed_user_agent ?? null,
    signaturePng: sigImages.get(`${r.id}:signature`) ?? null,
    note: replacementNote(r, recips, e.locale),
    identity: identities.get(r.id) ?? null,
    certificateSignature: r.role === "signer" && r.signature_type === "certificate",
  }));
  let completedAt = new Date().toISOString();
  let chainHead = events[events.length - 1]?.hash ?? "";

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
      payments: await paymentsForCertificate(d.db, e.id),
      branding: { primaryColor: wl.theme.primaryColor, logo: brandLogo },
      productName: rebrands(wl) ? productLabel(wl) : undefined,
      ...evPlan.certificate,
    },
  };

  // Firma con certificado propio: primero firman los titulares sobre el PDF sin sello; después se sella encima.
  const certStage = await certsignStage(d, e, recips, input);
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
    if (!config.seal.tsaUrl || config.seal.tsaRequired) throw err;
    // La TSA falló: si no es obligatoria, se sella en B-B y queda constancia.
    tsaError = String(err);
    timestamped = false;
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
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`,
      [fileId, e.tenant_id, key, pdf.length, sha],
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
  await d.db.tx(async (t) => {
    const e = await t.one<any>(`SELECT id, tenant_id, status FROM envelopes WHERE id = $1 FOR UPDATE`, [p.envelopeId]);
    if (!e || e.status !== "finalizing") return;
    await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.finalize_failed", actor: SYSTEM, data: { error: message } });
    await enqueue(t, "notify", { kind: "finalize_failed", envelopeId: e.id, tenantId: e.tenant_id });
  });
  d.log.error({ envelopeId: p.envelopeId, err: message }, "la finalización del sobre falló definitivamente");
}

// ───────────────────────────── Tareas periódicas ─────────────────────────────

export async function sweep(d: Deps) {
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
    ["reminders", () => runAutomaticReminders(d.db)],
    ["retention", () => purgeExpiredEnvelopes(d)],
    ["ai", () => runAiSweep(d)],
    ["agreements", () => agreementsSweep(d)],
    ["data", () => dataSweep(d)],
    ["domains", () => recheckVerifiedDomains(d)],
    ["white-label-domains", () => recheckWhiteLabelDomains(d)],
    // Apps OAuth registradas dinámicamente (conectores MCP) que nadie autorizó en 30 días.
    ["oauth", () => purgeUnusedDynamicClients(d.db)],
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
    try {
      await step();
    } catch (err) {
      d.log.error({ err: String(err), step: name }, "tarea periódica falló");
    }
  }
  const expired = await d.db.query<any>(`SELECT id, tenant_id FROM envelopes WHERE status IN ('sent','awaiting_certificates') AND expires_at < now() LIMIT 100`);
  for (const e of expired) {
    await d.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if (cur?.status !== "sent" && cur?.status !== "awaiting_certificates") return;
      await t.query(`UPDATE envelopes SET status = 'expired', updated_at = now(), version = version + 1 WHERE id = $1`, [e.id]);
      await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.expired", actor: SYSTEM });
    });
  }
  // Después del vencimiento, así los sobres que vencieron recién también cierran su checkout.
  await closeStaleCheckouts(d).catch((err) => d.log.error({ err: String(err), step: "payments" }, "tarea periódica falló"));
  await refundPaymentsOnClosedEnvelopes(d).catch((err) => d.log.error({ err: String(err), step: "refunds" }, "tarea periódica falló"));
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
