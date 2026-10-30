// Campos de un sobre listos para estampar en el PDF (con la imagen de firma/iniciales de cada destinatario).
// Lo usan el sellado final y la copia en curso que puede bajar un firmante antes de que firmen todos.
import type { StampField } from "@calasign/pdf";
import { normalizeTimeZone, signingDateForDisplay } from "@calasign/shared";
import type { Db } from "../infra/db";
import type { BlobStore } from "../infra/storage";

export async function loadSignatureImages(db: Db, blobs: BlobStore, envelopeId: string): Promise<Map<string, Uint8Array>> {
  const sigs = await db.query<any>(
    `SELECT a.recipient_id, a.purpose, f.storage_key FROM adopted_signatures a JOIN files f ON f.id = a.image_file_id
     JOIN recipients r ON r.id = a.recipient_id WHERE r.envelope_id = $1`,
    [envelopeId],
  );
  const images = await Promise.all(sigs.map((s) => blobs.get(s.storage_key)));
  return new Map(sigs.map((s, i) => [`${s.recipient_id}:${s.purpose}`, images[i]]));
}

/** Cuándo firmó cada destinatario y en qué huso se escribió su fecha de firma (el de la organización en ese momento). */
export type SigningMoments = Map<string, { at: Date; timeZone: string | null }>;

/**
 * Instante de la firma de cada destinatario que ya firmó, con el huso que registró su evento de firma
 * (recipient.signed / recipient.approved, `data.timeZone`; null en los firmados antes de que se registrara).
 */
export async function loadSigningMoments(db: Db, envelopeId: string): Promise<SigningMoments> {
  const rows = await db.query<{ id: string; signed_at: string | Date; time_zone: string | null }>(
    `SELECT r.id, r.signed_at,
            (SELECT ev.data->>'timeZone' FROM envelope_events ev
              WHERE ev.envelope_id = r.envelope_id AND ev.actor_type = 'recipient' AND ev.actor_id = r.id::text
                AND ev.type IN ('recipient.signed', 'recipient.approved')
              ORDER BY ev.seq DESC LIMIT 1) AS time_zone
       FROM recipients r WHERE r.envelope_id = $1 AND r.signed_at IS NOT NULL`,
    [envelopeId],
  );
  return new Map(rows.map((r) => [r.id, { at: new Date(r.signed_at), timeZone: r.time_zone }]));
}

/**
 * `timeZone`: el huso actual de la organización, para las fechas de firma sin huso registrado. `moments`: el instante y
 * el huso de cada firma; la fecha guardada se escribió en ese huso y su desfase es el de ese día (si la organización
 * cambió de huso, o pasó a horario de verano, entre la firma y el sellado, el rótulo sigue siendo el de la firma).
 */
export function toStampFields(
  fields: any[],
  docs: any[],
  sigImages: Map<string, Uint8Array>,
  timeZone: string,
  moments: SigningMoments = new Map(),
): StampField[] {
  const docIndex = new Map(docs.map((x, i) => [x.id, i]));
  const dateLabel = (f: { recipient_id: string; value: string }) => {
    const m = moments.get(f.recipient_id);
    return signingDateForDisplay(f.value, m?.timeZone ? normalizeTimeZone(m.timeZone) : timeZone, m?.at);
  };
  return fields.map((f) => ({
    documentIndex: docIndex.get(f.document_id)!,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    type: f.type,
    // La fecha de firma se guarda sin zona, en el huso de la organización; en el PDF se aclara cuál ("… UTC−03:00").
    // Los valores fijos del remitente, tal cual.
    value: f.type === "date_signed" && !f.read_only && typeof f.value === "string" ? dateLabel(f) : f.value,
    imagePng:
      f.type === "signature"
        ? (sigImages.get(`${f.recipient_id}:signature`) ?? null)
        : f.type === "initials"
          ? (sigImages.get(`${f.recipient_id}:initials`) ?? sigImages.get(`${f.recipient_id}:signature`) ?? null)
          : null,
  }));
}
