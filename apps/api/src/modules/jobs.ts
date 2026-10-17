import { finalizeEnvelopePdf, type CertificateRecipient, type StampField } from "@calasign/pdf";
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import { enqueue, requeueStuckJobs, type JobHandler, type JobQueueName } from "../infra/queue";
import { getSealProvider } from "../infra/seal";
import type { BlobStore } from "../infra/storage";
import { decrypt, maskDestination, sha256Hex, uuidv7 } from "../lib/util";
import { deliver, telegramStartLink } from "../notifications/channels";
import { render, type TemplateKind } from "../notifications/templates";
import { loadDocuments } from "./mappers";
import { finalizeFieldLogic } from "./logic";
import { handleBulkJob } from "./bulk";
import { embeddedAuthLabel } from "./embed";
import { inPersonAuthLabels } from "./experience";
import { handleWebhookJob } from "./webhooks";
import { runAutomaticReminders } from "./reminders";
import { purgeExpiredEnvelopes } from "./retention";
import { getLogoForPdf, getTenantBranding } from "./branding";
import { handlePlatformJob } from "./platform-fanout";
import { tenantBaseUrl } from "./custom-domains";
import { identityForCertificate } from "./identity/kyc";

interface Deps {
  db: Db;
  blobs: BlobStore;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

const LINK_KINDS: TemplateKind[] = ["invite", "reminder", "completed", "expiry_warning"];
const TELEGRAM_HINT = {
  es: "¿Preferís recibir los avisos por Telegram?",
  "pt-BR": "Prefere receber os avisos pelo Telegram?",
  en: "Prefer to get notifications on Telegram?",
} as const;

export function createJobHandlers(d: Deps): Record<JobQueueName, JobHandler> {
  return {
    notify: (p) => notify(d, p),
    finalize: (p) => finalize(d, p),
    webhook: (p, job) => handleWebhookJob(d, p, job),
    bulk: (p) => handleBulkJob(d, p),
    platform: (p) => handlePlatformJob(d, p),
  };
}

// ───────────────────────────── Notificaciones ─────────────────────────────

async function notify(d: Deps, p: { kind: TemplateKind; envelopeId: string; tenantId: string; recipientId?: string; declinedBy?: string }) {
  const e = await d.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [p.envelopeId]);
  if (!e) return;
  const org = await d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [e.tenant_id]);
  const sender = e.created_by ? await d.db.one<any>(`SELECT name, email, locale FROM users WHERE id = $1`, [e.created_by]) : null;
  const decliner = p.declinedBy ? await d.db.one<any>(`SELECT name, decline_reason FROM recipients WHERE id = $1`, [p.declinedBy]) : null;
  const brand = await getTenantBranding(d.db, e.tenant_id);
  const mailBrand = {
    primaryColor: brand.primaryColor,
    // Los clientes de correo no muestran SVG: solo PNG/JPG.
    logoUrl: brand.logoContentType === "image/svg+xml" ? null : brand.logoUrl,
    footer: brand.emailFooter,
  };
  const base = {
    senderName: sender?.name ?? org?.name ?? "CalaSign",
    organizationName: org?.name ?? "",
    subject: e.subject,
    declinedBy: decliner?.name ?? null,
    reason: p.kind === "voided" ? e.void_reason : decliner?.decline_reason ?? null,
  };

  // Avisos al remitente.
  if (p.kind === "sender_completed" || p.kind === "sender_declined") {
    if (!sender?.email) return;
    const link = `${await tenantBaseUrl(d.db, e.tenant_id)}/app/envelopes/${e.id}`;
    const m = render(p.kind, sender.locale ?? e.locale, { ...base, recipientName: sender.name, link }, mailBrand);
    const res = await deliver({ channel: "email", to: sender.email, subject: m.subject, text: m.text, html: m.html, link, locale: e.locale, tenantId: e.tenant_id });
    await d.db.query(
      `INSERT INTO notifications (id, tenant_id, envelope_id, channel, template, destination, status, provider, provider_message_id, sent_at)
       VALUES ($1,$2,$3,'email',$4,$5,'sent',$6,$7,now())`,
      [uuidv7(), e.tenant_id, e.id, p.kind, sender.email, res.provider, res.messageId],
    );
    return;
  }

  const r = await d.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [p.recipientId]);
  if (!r) return;
  // Invitaciones/recordatorios obsoletos (el sobre cambió de estado mientras esperaban en la cola).
  if ((p.kind === "invite" || p.kind === "reminder" || p.kind === "expiry_warning") && (e.status !== "sent" || !["sent", "viewed"].includes(r.status))) return;
  // Firma embebida: el integrador muestra la ceremonia en su app; no se mandan invitaciones ni avisos.
  if ((p.kind === "invite" || p.kind === "reminder" || p.kind === "expiry_warning") && (r.embedded || r.auth_method === "in_person")) return;

  const locale = r.locale ?? e.locale;
  const token = r.access_token_enc ? decrypt(r.access_token_enc) : null;
  const link = token && LINK_KINDS.includes(p.kind) ? `${await tenantBaseUrl(d.db, e.tenant_id)}/s/${token}` : null;
  const m = render(p.kind, locale, { ...base, recipientName: r.name, message: p.kind === "invite" ? e.message : null, link }, mailBrand);

  const channels: ("email" | "whatsapp" | "telegram")[] = r.channels ?? ["email"];
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

// ───────────────────────────── Finalización y sellado ─────────────────────────────

async function finalize(d: Deps, p: { envelopeId: string; tenantId: string }) {
  const e = await d.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [p.envelopeId]);
  if (!e || e.status !== "finalizing") return;
  await finalizeFieldLogic(d.db, e.id);
  const [docs, fields, recips, sigs, org, sender, events] = await Promise.all([
    loadDocuments(d.db, e.id),
    d.db.query<any>(`SELECT * FROM fields WHERE envelope_id = $1 AND NOT hidden`, [e.id]),
    d.db.query<any>(`SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order, created_at`, [e.id]),
    d.db.query<any>(
      `SELECT a.recipient_id, a.purpose, f.storage_key FROM adopted_signatures a JOIN files f ON f.id = a.image_file_id
       JOIN recipients r ON r.id = a.recipient_id WHERE r.envelope_id = $1`,
      [e.id],
    ),
    d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [e.tenant_id]),
    e.created_by ? d.db.one<any>(`SELECT name, email FROM users WHERE id = $1`, [e.created_by]) : Promise.resolve(null),
    d.db.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [e.id]),
  ]);

  const docBytes = await Promise.all(docs.map((x) => d.blobs.get(x.storage_key)));
  const sigImages = new Map<string, Uint8Array>();
  for (const s of sigs) sigImages.set(`${s.recipient_id}:${s.purpose}`, await d.blobs.get(s.storage_key));
  const docIndex = new Map(docs.map((x, i) => [x.id, i]));

  const stampFields: StampField[] = fields.map((f) => ({
    documentIndex: docIndex.get(f.document_id)!,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    type: f.type,
    value: f.value,
    imagePng:
      f.type === "signature"
        ? sigImages.get(`${f.recipient_id}:signature`) ?? null
        : f.type === "initials"
          ? sigImages.get(`${f.recipient_id}:initials`) ?? sigImages.get(`${f.recipient_id}:signature`) ?? null
          : null,
  }));

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
  }));
  const completedAt = new Date().toISOString();
  const chainHead = events[events.length - 1]?.hash ?? "";

  // Adjuntos de los firmantes y branding de la organización.
  const attachRows = await d.db.query<any>(
    `SELECT f.value AS name, f.recipient_id, fl.storage_key, fl.content_type, fl.sha256
     FROM fields f JOIN files fl ON fl.id = f.attachment_file_id
     WHERE f.envelope_id = $1 AND f.type = 'attachment' ORDER BY f.page, f.y, f.x`,
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
  const brand = await getTenantBranding(d.db, e.tenant_id);
  const brandLogo = await getLogoForPdf(d.db, d.blobs, brand);

  const provider = await getSealProvider();
  const input = {
    documents: docs.map((x, i) => ({ name: x.name, bytes: docBytes[i] })),
    fields: stampFields,
    attachments: attachments.map(({ sha256: _sha, ...x }) => x),
    certificate: {
      envelopeId: e.id,
      subject: e.subject,
      organizationName: org?.name ?? "",
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
        actor: x.actor_label ?? x.actor_type,
        ip: x.ip,
      })),
      chainHead,
      verifyUrl: `${config.appUrl}/verify`,
      attachments: attachments.map((x) => ({ name: x.name, recipientName: x.recipientName, sha256: x.sha256, appended: true })),
      branding: { primaryColor: brand.primaryColor, logo: brandLogo },
    },
  };

  let timestamped = Boolean(config.seal.tsaUrl);
  let tsaError: string | null = null;
  let pdf: Uint8Array;
  try {
    pdf = await finalizeEnvelopePdf(input, { provider, tsaUrl: config.seal.tsaUrl });
  } catch (err) {
    if (!config.seal.tsaUrl || config.seal.tsaRequired) throw err;
    // La TSA falló: si no es obligatoria, se sella en B-B y queda constancia.
    tsaError = String(err);
    timestamped = false;
    d.log.warn({ envelopeId: e.id, err: tsaError }, "TSA no disponible: sellado sin sello de tiempo");
    pdf = await finalizeEnvelopePdf(input, { provider, tsaUrl: null });
  }

  const fileId = uuidv7();
  const key = `tenants/${e.tenant_id}/envelopes/${e.id}/${fileId}-signed.pdf`;
  const sha = sha256Hex(pdf);
  await d.blobs.put(key, pdf, "application/pdf");

  await d.db.tx(async (t) => {
    const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
    if (cur?.status !== "finalizing") return;
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
        seal: { provider: provider.id, format: timestamped ? "PAdES-B-T" : "PAdES-B-B", tsa: timestamped ? config.seal.tsaUrl : null, tsaError },
      },
    });
    for (const r of recips.filter((x) => x.status !== "delegated" && x.status !== "reassigned"))
      await enqueue(t, "notify", { kind: "completed", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id });
    await enqueue(t, "notify", { kind: "sender_completed", envelopeId: e.id, tenantId: e.tenant_id });
  });
  d.log.info({ envelopeId: e.id, sha256: sha, bytes: pdf.length }, "sobre completado y sellado");
}

// ───────────────────────────── Tareas periódicas ─────────────────────────────

export async function sweep(d: Deps) {
  await requeueStuckJobs(d.db);
  await runAutomaticReminders(d.db);
  await purgeExpiredEnvelopes(d);
  const expired = await d.db.query<any>(`SELECT id, tenant_id FROM envelopes WHERE status = 'sent' AND expires_at < now() LIMIT 100`);
  for (const e of expired) {
    await d.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if (cur?.status !== "sent") return;
      await t.query(`UPDATE envelopes SET status = 'expired', updated_at = now(), version = version + 1 WHERE id = $1`, [e.id]);
      await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.expired", actor: SYSTEM });
    });
  }
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
