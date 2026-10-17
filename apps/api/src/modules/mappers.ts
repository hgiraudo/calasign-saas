import type { Document, Envelope, EnvelopeDetail, Field, Recipient } from "@calasign/shared";
import type { Db } from "../infra/db";
import { iso } from "../lib/util";
import { notFound } from "../lib/errors";

export const toEnvelope = (r: any, signedSha256: string | null = null): Envelope => ({
  id: r.id,
  subject: r.subject,
  message: r.message,
  locale: r.locale,
  status: r.status,
  createdVia: r.created_via,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  sentAt: iso(r.sent_at),
  completedAt: iso(r.completed_at),
  voidedAt: iso(r.voided_at),
  voidReason: r.void_reason,
  expiresAt: iso(r.expires_at),
  metadata: r.metadata ?? {},
  signedSha256,
  reminderEveryDays: r.reminder_every_days ?? null,
  expiryWarningDays: r.expiry_warning_days ?? null,
  allowDelegation: r.allow_delegation ?? true,
});

export const toDocument = (r: any): Document => ({
  id: r.id,
  name: r.name,
  position: r.position,
  pageCount: r.page_count,
  pages: r.pages,
  sha256: r.sha256,
  sizeBytes: Number(r.size_bytes),
});

export const toRecipient = (r: any): Recipient => ({
  id: r.id,
  role: r.role,
  routingOrder: r.routing_order,
  name: r.name,
  email: r.email,
  phone: r.phone,
  locale: r.locale,
  channels: r.channels,
  telegramLinked: Boolean(r.telegram_chat_id),
  embedded: Boolean(r.embedded),
  idDocumentType: r.id_document_type,
  idDocumentNumber: r.id_document_number,
  status: r.status,
  sentAt: iso(r.sent_at),
  viewedAt: iso(r.viewed_at),
  signedAt: iso(r.signed_at),
  declinedAt: iso(r.declined_at),
  declineReason: r.decline_reason,
  authMethod: r.auth_method ?? "link",
  replacedBy: r.replaced_by ?? null,
});

export const toField = (r: any): Field => ({
  id: r.id,
  documentId: r.document_id,
  recipientId: r.recipient_id,
  type: r.type,
  page: r.page,
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
  required: r.required,
  label: r.label,
  value: r.value,
  readOnly: Boolean(r.read_only),
  options: r.options ?? null,
  min: r.min_value ?? null,
  max: r.max_value ?? null,
});

export async function loadDocuments(db: Db, envelopeId: string) {
  return db.query(
    `SELECT d.*, f.sha256, f.size_bytes, f.storage_key FROM documents d JOIN files f ON f.id = d.file_id
     WHERE d.envelope_id = $1 ORDER BY d.position`,
    [envelopeId],
  );
}

export async function loadDetail(db: Db, tenantId: string, envelopeId: string): Promise<EnvelopeDetail> {
  const e = await db.one<any>(
    `SELECT e.*, f.sha256 AS signed_sha256 FROM envelopes e LEFT JOIN files f ON f.id = e.signed_file_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [envelopeId, tenantId],
  );
  if (!e) throw notFound("Sobre");
  const [docs, recips, fields] = await Promise.all([
    loadDocuments(db, envelopeId),
    db.query(`SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order, created_at, id`, [envelopeId]),
    db.query(`SELECT * FROM fields WHERE envelope_id = $1 ORDER BY page, y, x`, [envelopeId]),
  ]);
  return {
    envelope: toEnvelope(e, e.signed_sha256),
    documents: docs.map(toDocument),
    recipients: recips.map(toRecipient),
    fields: fields.map(toField),
  };
}
