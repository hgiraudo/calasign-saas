// Descargas del firmante: quedan en la cadena de evidencia del sobre (document.downloaded). La página del firmante
// vuelve a pedir el PDF en cada apertura: se registra una vez por destinatario, archivo y lapso (DEDUPE_MINUTES).
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";

export const DOWNLOAD_DEDUPE_MINUTES = 10;

export type DownloadKind = "document" | "signed" | "copy";

const recentlyRecorded = (db: Db, envelopeId: string, recipientId: string, kind: DownloadKind, documentId: string | null) =>
  db.one(
    `SELECT 1 FROM envelope_events
      WHERE envelope_id = $1 AND type = 'document.downloaded' AND actor_type = 'recipient' AND actor_id = $2
        AND data->>'kind' = $3 AND coalesce(data->>'documentId', '') = $4
        AND occurred_at > now() - make_interval(mins => $5)
      LIMIT 1`,
    [envelopeId, recipientId, kind, documentId ?? "", DOWNLOAD_DEDUPE_MINUTES],
  );

/**
 * Registra la descarga (con el sobre bloqueado, como los demás eventos). No corta la descarga si falla: el archivo ya
 * se autorizó y el error queda en el log.
 */
export async function recordSignerDownload(
  db: Db,
  log: FastifyBaseLogger,
  e: { id: string; tenant_id: string; status: string },
  actor: Actor,
  kind: DownloadKind,
  documentId: string | null = null,
): Promise<void> {
  if (e.status === "draft" || !actor.id) return;
  const recipientId = actor.id;
  try {
    // Lectura previa sin lock: las descargas repetidas no hacen cola sobre el sobre.
    if (await recentlyRecorded(db, e.id, recipientId, kind, documentId)) return;
    await db.tx(async (t) => {
      await t.one(`SELECT id FROM envelopes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [e.id, e.tenant_id]);
      if (await recentlyRecorded(t, e.id, recipientId, kind, documentId)) return;
      await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "document.downloaded", actor, data: { kind, documentId } });
    });
  } catch (err) {
    log.warn({ err, envelopeId: e.id }, "no se pudo registrar la descarga en la evidencia");
  }
}
