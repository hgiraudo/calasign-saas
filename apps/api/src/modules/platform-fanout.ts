// Evidencia → integraciones de plataforma (en la misma transacción del evento, como el outbox de webhooks):
//   · avisos a Slack/Teams según los eventos elegidos por cada integración
//   · exportación del PDF sellado a las conexiones de almacenamiento al completarse el sobre
// Y el handler de la cola "platform" que procesa esos trabajos.
import type { NotificationEvent } from "@calasign/shared";
import type { Db } from "../infra/db";
import { enqueue, type JobContext } from "../infra/queue";
import type { BlobStore } from "../infra/storage";
import { EVIDENCE_TO_NOTIFICATION, deliverNotificationJob } from "./notify-integrations";
import { exportEnvelopeJob, notifyStorageMemberRemoved, queueStorageExports } from "./storage-export";
import { handleCrmJob, queueCrmEvents } from "./crm";
import { handleConnectorJob, queueConnectorEvents } from "./connectors";

export async function queuePlatformFanout(
  db: Db,
  tenantId: string,
  envelopeId: string,
  evidenceType: string,
  seq: number,
  recipientId: string | null,
) {
  const event = EVIDENCE_TO_NOTIFICATION[evidenceType];
  if (event) {
    const its = await db.query<{ id: string }>(`SELECT id FROM notification_integrations WHERE tenant_id = $1 AND active AND $2 = ANY(events)`, [
      tenantId,
      event,
    ]);
    for (const it of its) {
      await enqueue(
        db,
        "platform",
        { kind: "notify", integrationId: it.id, envelopeId, event, recipientId },
        { dedupeKey: `ntf:${it.id}:${envelopeId}:${seq}` },
      );
    }
  }
  if (evidenceType === "envelope.completed") await queueStorageExports(db, tenantId, envelopeId);
  await queueCrmEvents(db, tenantId, envelopeId, evidenceType);
  await queueConnectorEvents(db, tenantId, envelopeId, evidenceType);
}

type PlatformJob =
  | { kind: "notify"; integrationId: string; envelopeId: string; event: NotificationEvent; recipientId: string | null }
  | { kind: "export"; connectionId: string; envelopeId: string }
  | { kind: "crm"; runId: string }
  | { kind: "connector"; runId: string }
  /** Aviso: conexiones de almacenamiento desactivadas porque quien las conectó dejó la organización (member-access.ts). */
  | { kind: "storage_member_removed"; tenantId: string; userId: string; connectionIds: string[] };

export async function handlePlatformJob(
  d: { db: Db; blobs: BlobStore; log?: { error(o: object, m?: string): void } },
  p: PlatformJob,
  job?: JobContext,
) {
  if (p.kind === "notify") return deliverNotificationJob(d.db, p);
  if (p.kind === "export") return exportEnvelopeJob(d.db, d.blobs, p);
  if (p.kind === "crm") return handleCrmJob(d, p, job);
  if (p.kind === "connector") return handleConnectorJob(d, p, job);
  if (p.kind === "storage_member_removed") return notifyStorageMemberRemoved(d.db, p, job, d.log);
}
