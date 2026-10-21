// Recordatorios automáticos (cada N días) y aviso de vencimiento (N días antes). Lo llama el sweeper.
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import { currentSignerGroup, receivesSignerNotices } from "./envelopes";

export async function runAutomaticReminders(db: Db, now = new Date()) {
  const day = now.toISOString().slice(0, 10);

  const due = await db.query<any>(
    `SELECT id, tenant_id FROM envelopes
     -- También esperando firmas con certificado: al firmante con certificado al que le toca se le vuelve a pedir.
     WHERE status IN ('sent','awaiting_certificates') AND reminder_every_days IS NOT NULL
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
          `SELECT status, reminder_every_days, expires_at, (reminder_every_days IS NOT NULL AND COALESCE(last_reminder_at, sent_at) <= $2::timestamptz - make_interval(days => reminder_every_days)
                   AND (expires_at IS NULL OR expires_at > $2::timestamptz)) AS due
             FROM envelopes WHERE id = $1 FOR UPDATE`,
          [e.id, now.toISOString()],
        );
        if ((cur?.status !== "sent" && cur?.status !== "awaiting_certificates") || !cur.due) return;
        const certStage = cur.status === "awaiting_certificates";
        // Cada uno a los N días de SU invitación (no del envío del sobre): al turno que se activó hace minutos le llegaba
        // un recordatorio enseguida de la invitación.
        const cutoff = now.getTime() - Number(cur.reminder_every_days) * 86400_000;
        // Sin vencimiento, un tope de recordatorios automáticos por destinatario (REMINDERS_AUTO_MAX_WITHOUT_EXPIRY): si no,
        // un sobre olvidado le escribía al firmante cada N días para siempre.
        const capped = cur.expires_at == null;
        const underCap = (r: any) => !(capped && Number(r.auto_reminders_sent ?? 0) >= config.reminders.automaticMaxWithoutExpiry);
        // Candidatos con el momento desde el que se cuentan los N días (su invitación, o el pedido de firma con certificado).
        const candidates: { r: any; since: number }[] = certStage
          ? await pendingCertificateSigner(t, e.id).then((c) => (c && receivesSignerNotices(c) && underCap(c) ? [{ r: c, since: new Date(c.requested_at).getTime() }] : []))
          : (await currentSignerGroup(t, e.id)).recipients
              .filter((r) => (r.status === "sent" || r.status === "viewed") && receivesSignerNotices(r) && r.sent_at && underCap(r))
              .map((r) => ({ r, since: new Date(r.sent_at).getTime() }));
        const pending = candidates.filter((c) => c.since <= cutoff).map((c) => c.r);
        let queuedCount = 0;
        for (const r of pending) {
          // Firma con certificado: el mismo pedido (certificate_request, con el link para el Firmador) como recordatorio.
          const queued = certStage
            ? await enqueue(t, "notify", { kind: "certificate_request", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id }, { dedupeKey: `auto-cert-reminder:${r.id}:${day}` })
            : await enqueue(t, "notify", { kind: "reminder", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id }, { dedupeKey: `auto-reminder:${r.id}:${day}` });
          // Solo cuenta para el tope (sobre sin vencimiento). Se pone en 0 al corregir el contacto (link nuevo) o con un
          // recordatorio manual (el remitente sigue esperando la firma). Solo si encoló: con la clave del día ya usada
          // no sale ningún recordatorio y no debe consumir el tope.
          if (queued) queuedCount++;
          if (capped && queued) await t.query(`UPDATE recipients SET auto_reminders_sent = auto_reminders_sent + 1 WHERE id = $1`, [r.id]);
        }
        // Sin nadie a quien recordarle todavía (los pendientes se invitaron hace menos de N días): last_reminder_at queda
        // en la invitación más vieja de ellos, así el sobre vuelve a tocar justo cuando le toca a ese (antes quedaba en
        // "ahora" y su primer recordatorio llegaba hasta 2N días después de la invitación). Siempre en el pasado y sin
        // tocar en menos de N días desde ahora: el sobre no se vuelve a mirar en cada pasada. Si se encoló alguno, o no
        // hay nadie pendiente, "ahora" (el próximo, dentro de N días).
        const notYet = candidates.filter((c) => c.since > cutoff).map((c) => c.since);
        const next = queuedCount === 0 && notYet.length ? new Date(Math.min(...notYet, now.getTime())) : now;
        await t.query(`UPDATE envelopes SET last_reminder_at = $2 WHERE id = $1`, [e.id, next.toISOString()]);
        if (queuedCount) {
          await appendEvent(t, {
            tenantId: e.tenant_id,
            envelopeId: e.id,
            type: "envelope.reminded",
            actor: SYSTEM,
            data: { recipients: queuedCount, automatic: true, ...(certStage ? { stage: "certificates" } : {}) },
          });
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
     WHERE status IN ('sent','awaiting_certificates') AND expires_at IS NOT NULL AND expiry_warning_days IS NOT NULL
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
        if ((cur?.status !== "sent" && cur?.status !== "awaiting_certificates") || recent || !cur.in_window) return;
        // Esperando firmas con certificado: el aviso va al firmante con certificado al que le toca (con su link).
        const pending =
          cur.status === "awaiting_certificates"
            ? await pendingCertificateSigner(t, e.id).then((c) => (c && receivesSignerNotices(c) ? [c] : []))
            : (await currentSignerGroup(t, e.id)).recipients.filter((r) => (r.status === "sent" || r.status === "viewed") && receivesSignerNotices(r));
        // Solo a quien todavía no lo recibió para este vencimiento (la clave incluye el vencimiento: si se extiende, el
        // aviso del nuevo sale). Los jobs no se borran, así que la clave sirve de registro.
        let fresh = 0;
        for (const r of pending) {
          // Con el sent_at del destinatario: si se corrigió el contacto (invitación nueva), el contacto nuevo también lo recibe.
          // En la etapa de certificados, una clave propia: el aviso de la etapa anterior (si lo recibió) no lo cubre.
          const dedupeKey = `expiry-warning:${r.id}:${new Date(cur.expires_at).toISOString()}:${r.sent_at ? new Date(r.sent_at).getTime() : 0}${cur.status === "awaiting_certificates" ? ":cert" : ""}`;
          // También el formato anterior de la clave (sin sent_at): si no, los avisos ya enviados salían otra vez.
          const legacyKey = cur.status === "awaiting_certificates" ? dedupeKey : `expiry-warning:${r.id}:${new Date(cur.expires_at).toISOString()}`;
          if (await t.one(`SELECT 1 FROM jobs WHERE dedupe_key = $1 OR (dedupe_key = $2 AND created_at >= $3::timestamptz)`, [dedupeKey, legacyKey, r.sent_at ?? new Date(0)])) continue;
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

/**
 * Firmante con certificado al que le toca (sobre en awaiting_certificates), con `requested_at`: cuándo se le pidió la
 * firma (al pasar el sobre a esperar certificados, o cuando firmó el anterior). Sin autorregistrados sin correo validado
 * (a ellos no se les manda el pedido: ver notify).
 */
async function pendingCertificateSigner(db: Db, envelopeId: string): Promise<any | null> {
  const c = await db.one<any>(
    `SELECT r.*, GREATEST(cs.created_at, (SELECT max(c2.signed_at) FROM certificate_signatures c2 WHERE c2.envelope_id = cs.envelope_id AND c2.status = 'signed')) AS requested_at
       FROM certificate_signatures cs JOIN recipients r ON r.id = cs.recipient_id
      WHERE cs.envelope_id = $1 AND cs.status = 'pending' ORDER BY cs.position LIMIT 1`,
    [envelopeId],
  );
  if (!c || (c.self_registered && !(c.auth_method === "otp_email" && c.authenticated_at))) return null;
  return c;
}
