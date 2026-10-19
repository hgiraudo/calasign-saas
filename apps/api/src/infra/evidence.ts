// Registro de eventos append-only encadenado por hash. Debe llamarse dentro de una transacción
// que ya tomó el lock del sobre (SELECT … FOR UPDATE), para serializar `seq`.
import type { Db } from "./db";
import { canonicalJson, sha256Hex } from "../lib/util";
import { queueWebhookFanout } from "./webhook-outbox";

export const GENESIS_HASH = "0".repeat(64);

export interface Actor {
  type: "user" | "api_key" | "recipient" | "system";
  id?: string | null;
  label?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const SYSTEM: Actor = { type: "system", label: "CalaSign" };

export async function appendEvent(
  db: Db,
  e: { tenantId: string; envelopeId: string; type: string; actor: Actor; data?: Record<string, unknown> },
) {
  const last = await db.one<{ seq: number; hash: string }>(
    `SELECT seq, hash FROM envelope_events WHERE envelope_id = $1 ORDER BY seq DESC LIMIT 1`,
    [e.envelopeId],
  );
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const occurredAt = new Date().toISOString();
  const body = {
    seq,
    type: e.type,
    actor_type: e.actor.type,
    actor_id: e.actor.id ?? null,
    ip: e.actor.ip ?? null,
    user_agent: e.actor.userAgent ?? null,
    data: e.data ?? {},
    occurred_at: occurredAt,
  };
  const hash = sha256Hex(`${prevHash}\n${canonicalJson(body)}`);
  await db.query(
    `INSERT INTO envelope_events (tenant_id, envelope_id, seq, type, actor_type, actor_id, actor_label, ip, user_agent, data, occurred_at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      e.tenantId,
      e.envelopeId,
      seq,
      e.type,
      e.actor.type,
      e.actor.id ?? null,
      e.actor.label ?? null,
      e.actor.ip ?? null,
      e.actor.userAgent ?? null,
      JSON.stringify(body.data),
      occurredAt,
      prevHash,
      hash,
    ],
  );
  await queueWebhookFanout(db, e.tenantId, e.envelopeId, e.type, seq, e.data ?? {}, e.actor.type === "recipient" ? e.actor.id ?? null : null);
  return { seq, hash };
}

/** Recalcula la cadena completa. Devuelve el primer seq roto, o null si está íntegra. */
export async function verifyChain(db: Db, envelopeId: string): Promise<{ ok: boolean; brokenAt: number | null; head: string }> {
  const rows = await db.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [envelopeId]);
  return verifyRows(rows);
}

/** Verifica la cadena sobre filas ya leídas (ordenadas por seq): el certificado usa la misma foto que imprime. */
export function verifyRows(rows: any[]): { ok: boolean; brokenAt: number | null; head: string } {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    const body = {
      seq: r.seq,
      type: r.type,
      actor_type: r.actor_type,
      actor_id: r.actor_id,
      ip: r.ip,
      user_agent: r.user_agent,
      data: r.data,
      occurred_at: new Date(r.occurred_at).toISOString(),
    };
    const h = sha256Hex(`${prev}\n${canonicalJson(body)}`);
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.seq, head: prev };
    prev = h;
  }
  return { ok: true, brokenAt: null, head: prev };
}
