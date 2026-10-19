// Recordatorios automáticos (cada N días) y aviso de vencimiento (N días antes). Lo llama el sweeper.
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import { currentSignerGroup, receivesSignerNotices } from "./envelopes";

export async function runAutomaticReminders(db: Db, now = new Date()) {
  const day = now.toISOString().slice(0, 10);

  const due = await db.query<any>(
    `SELECT id, tenant_id FROM envelopes
     WHERE status = 'sent' AND reminder_every_days IS NOT NULL
       AND COALESCE(last_reminder_at, sent_at) <= $1::timestamptz - make_interval(days => reminder_every_days)
     LIMIT 200`,
    [now.toISOString()],
  );
  for (const e of due) {
    await db.tx(async (t) => {
      // Con el sobre bloqueado se vuelve a mirar que el recordatorio siga pendiente: otro barrido (otro worker, o la API
      // con el worker integrado) pudo enviarlo mientras tanto, y se sumaba un segundo envelope.reminded a la evidencia.
      const cur = await t.one<any>(
        `SELECT status, (reminder_every_days IS NOT NULL AND COALESCE(last_reminder_at, sent_at) <= $2::timestamptz - make_interval(days => reminder_every_days)) AS due
           FROM envelopes WHERE id = $1 FOR UPDATE`,
        [e.id, now.toISOString()],
      );
      if (cur?.status !== "sent" || !cur.due) return;
      const group = await currentSignerGroup(t, e.id);
      const pending = group.recipients.filter((r) => (r.status === "sent" || r.status === "viewed") && receivesSignerNotices(r));
      for (const r of pending)
        await enqueue(t, "notify", { kind: "reminder", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id }, { dedupeKey: `auto-reminder:${r.id}:${day}` });
      await t.query(`UPDATE envelopes SET last_reminder_at = $2 WHERE id = $1`, [e.id, now.toISOString()]);
      if (pending.length)
        await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.reminded", actor: SYSTEM, data: { recipients: pending.length, automatic: true } });
    });
  }

  const expiring = await db.query<any>(
    `SELECT id, tenant_id FROM envelopes
     WHERE status = 'sent' AND expires_at IS NOT NULL AND expiry_warning_days IS NOT NULL AND expiry_warning_sent_at IS NULL
       AND expires_at > $1::timestamptz AND expires_at <= $1::timestamptz + make_interval(days => expiry_warning_days)
     LIMIT 200`,
    [now.toISOString()],
  );
  for (const e of expiring) {
    await db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT status, expiry_warning_sent_at, expires_at FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if (cur?.status !== "sent" || cur.expiry_warning_sent_at) return;
      const group = await currentSignerGroup(t, e.id);
      const pending = group.recipients.filter((r) => (r.status === "sent" || r.status === "viewed") && receivesSignerNotices(r));
      for (const r of pending)
        await enqueue(t, "notify", { kind: "expiry_warning", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id }, {
          // La clave incluye el vencimiento: si se extiende (corrección en vuelo), el aviso del nuevo vencimiento sale.
          dedupeKey: `expiry-warning:${r.id}:${new Date(cur.expires_at).toISOString()}`,
        });
      await t.query(`UPDATE envelopes SET expiry_warning_sent_at = $2 WHERE id = $1`, [e.id, now.toISOString()]);
      if (pending.length)
        await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.expiry_warning", actor: SYSTEM, data: { recipients: pending.length } });
    });
  }
  return { reminded: due.length, warned: expiring.length };
}
