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
       -- Ya vencido (el barrido todavía no lo pasó a 'expired'): sin recordatorio a un link que no sirve.
       AND (expires_at IS NULL OR expires_at > $1::timestamptz)
       AND COALESCE(last_reminder_at, sent_at) <= $1::timestamptz - make_interval(days => reminder_every_days)
     LIMIT 200`,
    [now.toISOString()],
  );
  // Sobres con al menos un aviso encolado en esta pasada (no los seleccionados: alguno puede no tener a quién avisar).
  let reminded = 0;
  let warned = 0;
  for (const e of due) {
    // Un sobre que falla no frena los recordatorios de los demás.
    try {
      await db.tx(async (t) => {
        // Con el sobre bloqueado se vuelve a mirar que el recordatorio siga pendiente: otro barrido (otro worker, o la API
        // con el worker integrado) pudo enviarlo mientras tanto, y se sumaba un segundo envelope.reminded a la evidencia.
        const cur = await t.one<any>(
          `SELECT status, reminder_every_days, (reminder_every_days IS NOT NULL AND COALESCE(last_reminder_at, sent_at) <= $2::timestamptz - make_interval(days => reminder_every_days)
                   AND (expires_at IS NULL OR expires_at > $2::timestamptz)) AS due
             FROM envelopes WHERE id = $1 FOR UPDATE`,
          [e.id, now.toISOString()],
        );
        if (cur?.status !== "sent" || !cur.due) return;
        const group = await currentSignerGroup(t, e.id);
        // Cada uno a los N días de SU invitación (no del envío del sobre): al turno que se activó hace minutos le llegaba
        // un recordatorio enseguida de la invitación.
        const cutoff = now.getTime() - Number(cur.reminder_every_days) * 86400_000;
        const pending = group.recipients.filter(
          (r) => (r.status === "sent" || r.status === "viewed") && receivesSignerNotices(r) && r.sent_at && new Date(r.sent_at).getTime() <= cutoff,
        );
        for (const r of pending)
          await enqueue(t, "notify", { kind: "reminder", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id }, { dedupeKey: `auto-reminder:${r.id}:${day}` });
        await t.query(`UPDATE envelopes SET last_reminder_at = $2 WHERE id = $1`, [e.id, now.toISOString()]);
        if (pending.length) {
          await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.reminded", actor: SYSTEM, data: { recipients: pending.length, automatic: true } });
          reminded++;
        }
      });
    } catch (err) {
      console.error("recordatorio automático falló", e.id, String(err));
    }
  }

  const expiring = await db.query<any>(
    `SELECT id, tenant_id FROM envelopes
     -- También después del primer aviso (una vez por hora): el turno que se activa después también tiene que recibirlo.
     WHERE status = 'sent' AND expires_at IS NOT NULL AND expiry_warning_days IS NOT NULL
       AND (expiry_warning_sent_at IS NULL OR expiry_warning_sent_at < $1::timestamptz - interval '1 hour')
       AND expires_at > $1::timestamptz AND expires_at <= $1::timestamptz + make_interval(days => expiry_warning_days)
     -- Primero los que todavía no recibieron ningún aviso (los re-chequeos horarios no los demoran).
     ORDER BY expiry_warning_sent_at NULLS FIRST
     LIMIT 200`,
    [now.toISOString()],
  );
  for (const e of expiring) {
    // Un sobre que falla no frena los recordatorios de los demás.
    try {
      await db.tx(async (t) => {
        // La ventana se vuelve a mirar con el sobre bloqueado: una corrección que extendió el vencimiento mientras tanto
        // no recibe el aviso ahora (y el del nuevo vencimiento no se pierde).
        const cur = await t.one<any>(
          `SELECT status, expiry_warning_sent_at, expires_at,
                  (expires_at IS NOT NULL AND expiry_warning_days IS NOT NULL AND expires_at > $2::timestamptz
                   AND expires_at <= $2::timestamptz + make_interval(days => expiry_warning_days)) AS in_window
             FROM envelopes WHERE id = $1 FOR UPDATE`,
          [e.id, now.toISOString()],
        );
        const recent = cur?.expiry_warning_sent_at && new Date(cur.expiry_warning_sent_at).getTime() > now.getTime() - 3600_000;
        if (cur?.status !== "sent" || recent || !cur.in_window) return;
        const group = await currentSignerGroup(t, e.id);
        const pending = group.recipients.filter((r) => (r.status === "sent" || r.status === "viewed") && receivesSignerNotices(r));
        // Solo a quien todavía no lo recibió para este vencimiento (la clave incluye el vencimiento: si se extiende, el
        // aviso del nuevo sale). Los jobs no se borran, así que la clave sirve de registro.
        let fresh = 0;
        for (const r of pending) {
          const dedupeKey = `expiry-warning:${r.id}:${new Date(cur.expires_at).toISOString()}`;
          if (await t.one(`SELECT 1 FROM jobs WHERE dedupe_key = $1`, [dedupeKey])) continue;
          await enqueue(t, "notify", { kind: "expiry_warning", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id }, { dedupeKey });
          fresh++;
        }
        await t.query(`UPDATE envelopes SET expiry_warning_sent_at = $2 WHERE id = $1`, [e.id, now.toISOString()]);
        if (fresh) {
          await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.expiry_warning", actor: SYSTEM, data: { recipients: fresh } });
          warned++;
        }
      });
    } catch (err) {
      console.error("recordatorio automático falló", e.id, String(err));
    }
  }
  return { reminded, warned };
}
