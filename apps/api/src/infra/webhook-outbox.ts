// Puente evidencia → webhooks: cada evento de negocio relevante encola un "fanout" en la misma
// transacción que lo registra (outbox). Si la organización no tiene endpoints activos, no encola nada.
import type { Db } from "./db";
import { enqueue } from "./queue";
import { queuePlatformFanout } from "../modules/platform-fanout";
import { queueAgreementEvents } from "../modules/agreements";
import { tenantPlan } from "../modules/billing/plans";

/** Tipo de evento de evidencia → tipos de webhook que dispara. */
const MAP: Record<string, string[]> = {
  "envelope.sent": ["envelope.sent"],
  "envelope.completed": ["envelope.completed"],
  "envelope.voided": ["envelope.voided"],
  "envelope.expired": ["envelope.expired"],
  "recipient.viewed": ["recipient.viewed"],
  "recipient.signed": ["recipient.signed"],
  "recipient.declined": ["recipient.declined", "envelope.declined"],
};

export async function queueWebhookFanout(
  db: Db,
  tenantId: string,
  envelopeId: string,
  evidenceType: string,
  seq: number,
  data: Record<string, unknown>,
  recipientId: string | null,
) {
  await queuePlatformFanout(db, tenantId, envelopeId, evidenceType, seq, recipientId);
  await queueAgreementEvents(db, envelopeId, evidenceType);
  const types = MAP[evidenceType];
  if (!types) return;
  const has = await db.one(`SELECT 1 FROM webhook_endpoints WHERE tenant_id = $1 AND active LIMIT 1`, [tenantId]);
  if (!has) return;
  // Los endpoints creados en un plan anterior quedan, pero solo reciben eventos si el plan incluye webhooks.
  const { plan } = await tenantPlan(db, tenantId);
  if (!plan.features.includes("webhooks")) return;
  for (const type of types) {
    await enqueue(
      db,
      "webhook",
      { kind: "fanout", tenantId, envelopeId, type, recipientId, reason: typeof data.reason === "string" ? data.reason : null },
      { dedupeKey: `whfan:${envelopeId}:${seq}:${type}` },
    );
  }
}
