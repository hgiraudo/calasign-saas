// Tareas periódicas de la IA (las llama el sweeper):
// 1) extracción automática de metadatos de sobres completados (organizaciones con IA y extracción automática);
// 2) alertas de renovación/vencimiento al remitente N días antes.
import type { Db } from "../../infra/db";
import { SYSTEM, appendEvent } from "../../infra/evidence";
import type { BlobStore } from "../../infra/storage";
import { config } from "../../config";
import { uuidv7 } from "../../lib/util";
import { deliver } from "../../notifications/channels";
import { getAiProvider } from "./provider";
import { assertAiAvailable, isAiError, loadEnvelopeDocs, recordAiUse, saveMetadata } from "./service";

interface Deps {
  db: Db;
  blobs: BlobStore;
  log: { warn(o: object, m?: string): void; info(o: object, m?: string): void };
}

const ALERT = {
  es: {
    subject: (s: string, d: string) => `Recordatorio: "${s}" vence o se renueva el ${d}`,
    body: (n: string, s: string, d: string, auto: boolean | null, notice: number | null) =>
      [
        `Hola ${n}:`,
        `El contrato "${s}" ${auto ? "se renueva automáticamente" : "vence"} el ${d}.`,
        notice ? `El contrato prevé un preaviso de ${notice} días.` : "",
        "Revisá si querés renovarlo, renegociarlo o darlo de baja a tiempo.",
        "Datos detectados con IA: verificá la fecha en el documento.",
      ]
        .filter(Boolean)
        .join("\n"),
  },
  "pt-BR": {
    subject: (s: string, d: string) => `Lembrete: "${s}" vence ou é renovado em ${d}`,
    body: (n: string, s: string, d: string, auto: boolean | null, notice: number | null) =>
      [
        `Olá ${n},`,
        `O contrato "${s}" ${auto ? "é renovado automaticamente" : "vence"} em ${d}.`,
        notice ? `O contrato prevê aviso prévio de ${notice} dias.` : "",
        "Verifique se deseja renová-lo, renegociá-lo ou encerrá-lo a tempo.",
        "Dados detectados com IA: confira a data no documento.",
      ]
        .filter(Boolean)
        .join("\n"),
  },
  en: {
    subject: (s: string, d: string) => `Reminder: "${s}" expires or renews on ${d}`,
    body: (n: string, s: string, d: string, auto: boolean | null, notice: number | null) =>
      [
        `Hi ${n},`,
        `The contract "${s}" ${auto ? "renews automatically" : "expires"} on ${d}.`,
        notice ? `The contract requires ${notice} days' notice.` : "",
        "Check whether you want to renew, renegotiate or terminate it in time.",
        "AI-detected data: verify the date in the document.",
      ]
        .filter(Boolean)
        .join("\n"),
  },
} as const;

export async function runAiSweep(d: Deps, now = new Date()) {
  let extracted = 0;
  let alerted = 0;

  // 1) Extracción automática (pocas por pasada: es costosa).
  const pending = await d.db.query<any>(
    `SELECT e.id, e.tenant_id FROM envelopes e JOIN tenants t ON t.id = e.tenant_id
     WHERE e.status = 'completed' AND e.ai_metadata IS NULL AND e.ai_metadata_attempted_at IS NULL
       AND t.ai_enabled AND t.ai_auto_extract
     ORDER BY e.completed_at LIMIT 5`,
  );
  for (const e of pending) {
    await d.db.query(`UPDATE envelopes SET ai_metadata_attempted_at = now() WHERE id = $1`, [e.id]);
    try {
      await assertAiAvailable(d.db, e.tenant_id);
      const docs = await loadEnvelopeDocs(d.db, d.blobs, e.id);
      const r = await getAiProvider().extractMetadata(docs);
      await saveMetadata(d.db, e.id, e.tenant_id, r.result.metadata, r.result.confidence, "ai");
      await recordAiUse(d.db, { tenantId: e.tenant_id, envelopeId: e.id, feature: "extract_metadata", usage: r.usage, actor: SYSTEM, data: { automatic: true } });
      extracted++;
    } catch (err) {
      if (!isAiError(err)) d.log.warn({ envelopeId: e.id, err: String(err) }, "extracción automática de metadatos falló");
    }
  }

  // 2) Alertas de renovación.
  const today = now.toISOString().slice(0, 10);
  const due = await d.db.query<any>(
    `SELECT e.id, e.tenant_id, e.subject, e.locale, e.ai_metadata, e.created_by, u.name AS sender_name, u.email AS sender_email, u.locale AS sender_locale
     FROM envelopes e LEFT JOIN users u ON u.id = e.created_by
     WHERE e.ai_renewal_alert_at IS NOT NULL AND e.ai_renewal_alert_at <= $1::date AND e.ai_renewal_alert_sent_at IS NULL
     LIMIT 50`,
    [today],
  );
  for (const e of due) {
    const m = e.ai_metadata ?? {};
    const date = m.renewalDate ?? m.expiryDate;
    await d.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT ai_renewal_alert_sent_at FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if (cur?.ai_renewal_alert_sent_at) return;
      await t.query(`UPDATE envelopes SET ai_renewal_alert_sent_at = now() WHERE id = $1`, [e.id]);
      await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "ai.renewal_alert", actor: SYSTEM, data: { date, notified: Boolean(e.sender_email) } });
    });
    if (e.sender_email && date) {
      const L = ALERT[(e.sender_locale ?? e.locale) as keyof typeof ALERT] ?? ALERT.es;
      const link = `${config.appUrl}/app/envelopes/${e.id}`;
      try {
        const res = await deliver({
          channel: "email",
          to: e.sender_email,
          subject: L.subject(e.subject, date),
          text: `${L.body(e.sender_name ?? "", e.subject, date, m.autoRenewal ?? null, m.noticePeriodDays ?? null)}\n\n${link}`,
          link,
          locale: e.sender_locale ?? e.locale,
          tenantId: e.tenant_id,
        });
        await d.db.query(
          `INSERT INTO notifications (id, tenant_id, envelope_id, channel, template, destination, status, provider, provider_message_id, sent_at)
           VALUES ($1,$2,$3,'email','ai_renewal_alert',$4,'sent',$5,$6,now())`,
          [uuidv7(), e.tenant_id, e.id, e.sender_email, res.provider, res.messageId],
        );
      } catch (err) {
        d.log.warn({ envelopeId: e.id, err: String(err) }, "no se pudo enviar la alerta de renovación");
      }
    }
    alerted++;
  }
  return { extracted, alerted };
}
