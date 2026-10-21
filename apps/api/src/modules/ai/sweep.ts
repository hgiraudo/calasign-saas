// Tareas periódicas de la IA (las llama el sweeper):
// 1) extracción automática de metadatos de sobres completados (organizaciones con IA y extracción automática);
// 2) alertas de renovación/vencimiento al remitente N días antes.
import type { Db } from "../../infra/db";
import { SYSTEM, appendEvent } from "../../infra/evidence";
import type { BlobStore } from "../../infra/storage";
import { enqueue } from "../../infra/queue";
import { sendTracked } from "../../notifications/outbound";
import { brandForEnvelope, senderFor } from "../white-label/brand";
import { tenantBaseUrl } from "../custom-domains";
import { aiProviderStatus, getAiProvider } from "./provider";
import { assertAiAvailable, inputEstimate, isAiError, loadEnvelopeDocs, recordAiUse, saveMetadata, withAiReservation, callModel } from "./service";
import { AppError } from "../../lib/errors";
import { InvalidPdfError } from "@calasign/pdf";
import { planAiCapSql } from "../billing/plans";
import { AI_NOTICE_VERSION } from "@calasign/shared";

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

/** Primer día del mes siguiente (UTC, como el corte del presupuesto mensual). */
/**
 * Tope de intentos seguidos de la extracción automática que terminan en un error no clasificado o en un proceso caído
 * a mitad (o en timeout del proveedor): cada uno se cobra, así que pasado el tope el sobre no se vuelve a tomar.
 */
export const AI_EXTRACT_MAX_FAILURES = 3;

/**
 * ¿El error es del documento o de la respuesta del modelo para ESTE documento (reintentar da lo mismo y se vuelve a
 * cobrar)? El modelo se negó (422 ai_refused) o devolvió algo inválido (502 ai_bad_output), los originales se purgaron
 * (410) o no están (404), el PDF no se puede leer (InvalidPdfError, 422 pdf_too_heavy) o los metadatos no validan
 * (ZodError en saveMetadata). Cualquier otro 4xx también: es del pedido, no del momento.
 */
export function isTerminalExtractError(err: unknown): boolean {
  if (err instanceof InvalidPdfError) return true;
  if ((err as Error)?.name === "ZodError") return true;
  if (!(err instanceof AppError)) return false;
  if (["ai_refused", "ai_bad_output", "purged", "not_found", "pdf_too_heavy"].includes(err.code)) return true;
  return err.status >= 400 && err.status < 500;
}

export function nextMonthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export async function runAiSweep(d: Deps, now = new Date()) {
  let extracted = 0;
  let alerted = 0;

  // 1) Extracción automática (pocas por pasada: es costosa). Sin proveedor de IA en el servidor (producción sin clave)
  // no se toma ningún sobre: cada pasada reclamaba la tanda, fallaba con ai_unavailable y gastaba un intento y la
  // ventana de 30 días de reintentos (a los 30 días quedaban sin extraer para siempre aunque se configurara la clave).
  const pending = aiProviderStatus().name === "none" ? [] : await d.db.query<any>(
    `SELECT e.id, e.tenant_id FROM envelopes e JOIN tenants t ON t.id = e.tenant_id
     WHERE e.status = 'completed' AND e.ai_metadata IS NULL AND e.purged_at IS NULL
       -- Los reintentos, solo durante 30 días desde el primer intento (un error que no se arregla no se intenta para siempre).
       -- Sin intento: salvo que espere al mes siguiente por presupuesto agotado (retry_at futuro).
       AND ((e.ai_metadata_attempted_at IS NULL AND (e.ai_metadata_retry_at IS NULL OR e.ai_metadata_retry_at <= now()))
            OR (e.ai_metadata_retry_at < now() AND COALESCE(e.ai_metadata_first_attempt_at, e.ai_metadata_attempted_at) > now() - interval '30 days'))
       -- Con la clave BYOK fallando no se puede leer el PDF: esos sobres esperan a que se recupere.
       AND t.byok_status <> 'failing'
       -- Los que agotaron los intentos (errores no clasificados o procesos caídos a mitad) no se toman más.
       AND e.ai_metadata_failures < ${AI_EXTRACT_MAX_FAILURES}
       AND t.ai_enabled AND t.ai_auto_extract
       -- Con el aviso de tratamiento de datos vigente aceptado (si cambió, la IA queda suspendida hasta aceptarlo).
       AND t.ai_notice_version = $1 AND t.ai_notice_accepted_at IS NOT NULL
       -- Organizaciones sin presupuesto este mes quedan para después (sin esto, sus sobres ocupaban la tanda siempre).
       -- El presupuesto efectivo es el de la organización sin pasar el tope del plan (0: el plan no incluye IA).
       AND COALESCE((SELECT sum(u.input_tokens + u.output_tokens) FROM ai_usage u
                      WHERE u.tenant_id = t.id AND u.created_at >= date_trunc('month', now()) AND u.feature <> '_reserved'), 0)
           < LEAST(t.ai_monthly_token_budget::bigint, ${planAiCapSql("t.billing_plan")})
     ORDER BY e.ai_metadata_retry_at NULLS FIRST, e.completed_at LIMIT 5`,
    [AI_NOTICE_VERSION],
  );
  for (const e of pending) {
    // Se reclama el sobre: con varios workers (cada uno corre el barrido), dos tomaban el mismo y el modelo se llamaba
    // (y se cobraba) dos veces. El reclamo es un arriendo de 6 h (ai_metadata_retry_at): si el proceso muere a mitad o
    // el error no se reconoce abajo, el sobre se vuelve a tomar pasado ese plazo (dentro de la ventana de 30 días). Antes
    // quedaba con retry_at NULL y no se reintentaba nunca. El reclamo suma un intento (ai_metadata_failures): las salidas
    // que no son un intento cobrado lo devuelven abajo; uno no clasificado o un proceso caído quedan contados, y pasado
    // el tope el sobre no se vuelve a tomar (cada intento se cobra).
    const claimed = await d.db.query(`UPDATE envelopes SET ai_metadata_attempted_at = now(), ai_metadata_retry_at = now() + interval '6 hours',
          ai_metadata_first_attempt_at = COALESCE(ai_metadata_first_attempt_at, now()),
          ai_metadata_failures = ai_metadata_failures + 1
        WHERE id = $1 AND ai_metadata_failures < $2
          AND ((ai_metadata_attempted_at IS NULL AND (ai_metadata_retry_at IS NULL OR ai_metadata_retry_at <= now())) OR ai_metadata_retry_at < now())
        RETURNING id`, [e.id, AI_EXTRACT_MAX_FAILURES]);
    if (!claimed.length) continue;
    try {
      await assertAiAvailable(d.db, e.tenant_id, { reserve: false }); // antes de analizar el PDF
      const docs = await loadEnvelopeDocs(d.db, d.blobs, e.id);
      const rid = await assertAiAvailable(d.db, e.tenant_id, { estimate: inputEstimate(docs), envelopeId: e.id });
      const r = await withAiReservation(
        d.db,
        { tenantId: e.tenant_id, reservationId: rid, envelopeId: e.id, feature: "extract_metadata", actor: SYSTEM },
        () => callModel(() => getAiProvider().extractMetadata(docs)),
      );
      await saveMetadata(d.db, e.id, e.tenant_id, r.result.metadata, r.result.confidence, "ai");
      await d.db.query(`UPDATE envelopes SET ai_metadata_retry_at = NULL, ai_metadata_failures = 0 WHERE id = $1`, [e.id]);
      await recordAiUse(d.db, { reservationId: rid, tenantId: e.tenant_id, envelopeId: e.id, feature: "extract_metadata", usage: r.usage, actor: SYSTEM, data: { automatic: true } });
      extracted++;
    } catch (err) {
      // Presupuesto del mes agotado (o IA apagada): no es un intento, queda para cuando vuelva a haber. Un sobre que
      // solo no entra en lo que queda (o choca con otras llamadas en curso) espera 6 h: si se volvía a tomar en cada
      // pasada ocupaba la tanda de todas las organizaciones.
      const det = (err as AppError)?.details as { used?: number; budget?: number } | undefined;
      const code = (err as AppError)?.code;
      // IA apagada, aviso sin aceptar o plan sin IA: no es un intento; el sobre vuelve a la cola sin fecha (la consulta
      // de arriba no lo toma mientras siga así).
      const off = isAiError(err) && code !== "ai_budget_exceeded";
      const monthSpent = code === "ai_budget_exceeded" && det?.used != null && det.budget != null && det.used >= det.budget;
      // No entra en lo que queda del presupuesto (o choca con llamadas en curso): reintento en 6 h. Antes quedaba con
      // ai_metadata_retry_at NULL y no se volvía a tomar nunca.
      const budgetBusy = code === "ai_budget_exceeded" && !monthSpent;
      // Falla transitoria (BYOK o almacenamiento caídos, lector de PDF ocupado): no cuenta como intento, se reintenta más tarde.
      // También el proveedor de IA saturado o caído (429, 5xx, sin conexión: callModel lo traduce a 503 ai_rate_limited o
      // 502 ai_unavailable); antes contaba como intento y ese sobre no se volvía a tomar nunca.
      const transient = (err as AppError)?.status === 503 || (err as AppError)?.code === "ai_unavailable";
      // El proveedor rechazó el pedido (clave revocada, modelo mal configurado, saldo agotado): suele ser de la
      // configuración, no del sobre; se reintenta en 6 h (antes de esta pasada se perdía para siempre).
      // Un timeout (504 ai_timeout) también espera 6 h: el documento es pesado y cada intento se cobra.
      const rejected = code === "ai_request_rejected";
      // Del documento o de la respuesta del modelo para este documento: reintentar da lo mismo (y se cobra de nuevo).
      const terminal = !off && !transient && !rejected && code !== "ai_budget_exceeded" && isTerminalExtractError(err);
      // Las salidas que no son un intento fallido del sobre devuelven el intento que sumó el reclamo.
      const giveBack = `ai_metadata_failures = GREATEST(ai_metadata_failures - 1, 0)`;
      if (off) await d.db.query(`UPDATE envelopes SET ai_metadata_attempted_at = NULL, ai_metadata_retry_at = NULL, ${giveBack},
           -- Solo si este era el primer intento (el reclamo pone las dos con el mismo now()): si no, cada vez reiniciaba
           -- la ventana de 30 días.
           ai_metadata_first_attempt_at = CASE WHEN ai_metadata_first_attempt_at = ai_metadata_attempted_at THEN NULL ELSE ai_metadata_first_attempt_at END
         WHERE id = $1`, [e.id]);
      // Presupuesto del mes agotado: se reintenta el primer día del mes siguiente. Sin intento (attempted_at NULL): no
      // abre ni consume la ventana de 30 días (si no, un sobre del día 1 quedaba afuera al mes siguiente).
      else if (monthSpent) await d.db.query(`UPDATE envelopes SET ai_metadata_attempted_at = NULL, ai_metadata_retry_at = $2, ${giveBack},
           ai_metadata_first_attempt_at = CASE WHEN ai_metadata_first_attempt_at = ai_metadata_attempted_at THEN NULL ELSE ai_metadata_first_attempt_at END
         WHERE id = $1`, [e.id, nextMonthStart(now).toISOString()]);
      else if (budgetBusy) await d.db.query(`UPDATE envelopes SET ai_metadata_retry_at = now() + interval '6 hours', ${giveBack} WHERE id = $1`, [e.id]);
      // Transitoria: se reintenta en una hora (no en la próxima pasada).
      else if (transient) await d.db.query(`UPDATE envelopes SET ai_metadata_retry_at = now() + interval '1 hour', ${giveBack} WHERE id = $1`, [e.id]);
      else if (rejected) await d.db.query(`UPDATE envelopes SET ai_metadata_retry_at = now() + interval '6 hours', ${giveBack} WHERE id = $1`, [e.id]);
      // Error del documento: no se reintenta (antes quedaba el arriendo y se volvía a cobrar cada 6 h durante 30 días).
      else if (terminal) await d.db.query(`UPDATE envelopes SET ai_metadata_retry_at = NULL WHERE id = $1`, [e.id]);
      // Cualquier otro error (y un timeout del proveedor: documento pesado, cada intento se cobra): queda el arriendo
      // del reclamo (reintento en 6 h, dentro de la ventana de 30 días) con el intento contado; con el tope alcanzado,
      // no se reintenta más.
      else await d.db.query(`UPDATE envelopes SET ai_metadata_retry_at = NULL WHERE id = $1 AND ai_metadata_failures >= $2`, [e.id, AI_EXTRACT_MAX_FAILURES]);
      if (transient) d.log.warn({ envelopeId: e.id, err: String(err) }, "extracción automática postergada (falla transitoria)");
      else if (terminal) d.log.info({ envelopeId: e.id, code, err: String(err) }, "extracción automática descartada (error del documento)");
      else if (!isAiError(err)) d.log.warn({ envelopeId: e.id, err: String(err) }, "extracción automática de metadatos falló");
    }
  }

  // 2) Alertas de renovación.
  const today = now.toISOString().slice(0, 10);
  const due = await d.db.query<any>(
    `SELECT e.id, e.tenant_id, e.subject, e.locale, e.ai_metadata, e.created_by, u.name AS sender_name, u.email AS sender_email, u.locale AS sender_locale
     FROM envelopes e
     -- Solo si el remitente sigue en la organización: a alguien que se fue no se le mandan datos de sus contratos.
     LEFT JOIN users u ON u.id = e.created_by AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.tenant_id = e.tenant_id)
     -- Con la IA apagada o los avisos en 0 en la organización no sale ninguno (aunque estuviera programado).
     JOIN tenants t ON t.id = e.tenant_id AND t.ai_enabled AND t.ai_renewal_alert_days > 0
     WHERE e.ai_renewal_alert_at IS NOT NULL AND e.ai_renewal_alert_at <= $1::date AND e.ai_renewal_alert_sent_at IS NULL
     LIMIT 50`,
    [today],
  );
  for (const e of due) {
    const m = e.ai_metadata ?? {};
    const date = m.renewalDate ?? m.expiryDate;
    // La fecha ya pasó (p. ej. las alertas se acumularon con la IA apagada): no se avisa de una renovación vencida, se
    // da por cerrada.
    if (!date || String(date) < today) {
      await d.db.query(`UPDATE envelopes SET ai_renewal_alert_sent_at = now() WHERE id = $1 AND ai_renewal_alert_sent_at IS NULL`, [e.id]);
      continue;
    }
    // El correo sale por la cola de avisos (notify), encolado en la misma transacción que la marca de enviado: si el
    // envío falla, el job se reintenta (antes se marcaba enviado y un fallo de SMTP la perdía). Pasa por sendTracked
    // (direcciones suprimidas, registro) y con el remitente de la marca, como el resto de los avisos al equipo.
    const claimed = await d.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT ai_renewal_alert_sent_at FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if (cur?.ai_renewal_alert_sent_at) return false;
      await t.query(`UPDATE envelopes SET ai_renewal_alert_sent_at = now() WHERE id = $1`, [e.id]);
      await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "ai.renewal_alert", actor: SYSTEM, data: { date, notified: Boolean(e.sender_email) } });
      if (e.sender_email) {
        await enqueue(t, "notify", { kind: "ai_renewal_alert", envelopeId: e.id, tenantId: e.tenant_id, date: String(date) }, { dedupeKey: `ai-renewal:${e.id}:${date}` });
      }
      return true;
    });
    // Otro barrido (otro worker) ya la mandó: no se repite el correo.
    if (!claimed) continue;
    alerted++;
  }
  return { extracted, alerted };
}

/**
 * Job de aviso (cola notify, kind "ai_renewal_alert"): el correo de la alerta de renovación al remitente. Solo si sigue
 * en la organización; con la marca del sobre (remitente, dominio de los links) y por sendTracked (suprimidas, registro
 * en notifications, sin repetir en un reintento del job). Un error del momento relanza para que la cola reintente.
 */
export async function notifyAiRenewalAlert(
  d: { db: Db; log: { warn(o: object, m?: string): void; error(o: object, m?: string): void } },
  p: { envelopeId: string; tenantId: string; date?: string },
  jobId?: number,
) {
  const e = await d.db.one<any>(
    `SELECT e.id, e.tenant_id, e.brand_id, e.subject, e.locale, e.ai_metadata, u.name AS sender_name, u.email AS sender_email, u.locale AS sender_locale
       FROM envelopes e
       JOIN users u ON u.id = e.created_by AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.tenant_id = e.tenant_id)
      WHERE e.id = $1`,
    [p.envelopeId],
  );
  if (!e?.sender_email) return;
  const m = e.ai_metadata ?? {};
  const date = p.date ?? m.renewalDate ?? m.expiryDate;
  if (!date) return;
  const locale = e.sender_locale ?? e.locale;
  const L = ALERT[locale as keyof typeof ALERT] ?? ALERT.es;
  // Con el dominio propio de la organización, como el resto de los avisos al equipo.
  const link = `${await tenantBaseUrl(d.db, e.tenant_id)}/app/envelopes/${e.id}`;
  const sendAs = await senderFor(d.db, await brandForEnvelope(d.db, e));
  const out = await sendTracked(
    d.db,
    { tenantId: e.tenant_id, envelopeId: e.id, template: "ai_renewal_alert", jobId, log: d.log },
    {
      channel: "email",
      to: e.sender_email,
      subject: L.subject(e.subject, date),
      text: `${L.body(e.sender_name ?? "", e.subject, date, m.autoRenewal ?? null, m.noticePeriodDays ?? null)}\n\n${link}`,
      link,
      locale,
      tenantId: e.tenant_id,
      from: sendAs.from,
      replyTo: sendAs.replyTo,
      dkim: sendAs.dkim,
    },
  );
  if (out.status === "failed") {
    if (out.transient) throw new Error(`no se pudo enviar la alerta de renovación: ${out.error}`);
    d.log.warn({ envelopeId: e.id, err: out.error }, "no se pudo enviar la alerta de renovación");
  }
}
