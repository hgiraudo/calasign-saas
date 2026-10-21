// Retención de datos de la plataforma de acuerdos: las ejecuciones de workflows terminadas y las negociaciones cerradas
// guardaban para siempre los datos cargados (formularios públicos, respuestas de servicios, textos negociados, de dónde
// se completó cada correo). Pasado el plazo se borran y quedan los metadatos mínimos: estado, pasos, fechas, nombres,
// ids de los sobres y de los acuerdos (el sobre y su evidencia tienen su propia política de retención).
import type { Deps } from "./common";
import { deleteFilesIfUnused } from "../file-cleanup";

/**
 * Plazo por defecto (días desde que terminó) si la organización no configuró una retención (tenants.retention_days,
 * la misma de los sobres). AGREEMENTS_DATA_RETENTION_DAYS; sin definir, no hay plazo por defecto: sólo se purgan los
 * datos de las organizaciones que configuraron una retención (no se borran datos que nadie pidió borrar).
 */
export function agreementsDataRetentionDays(): number | null {
  const raw = process.env.AGREEMENTS_DATA_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : null;
}

const RUN_TERMINAL = `('completed','failed','rejected','cancelled')`;
const NEGOTIATION_CLOSED = `('accepted','cancelled')`;
/** Vencido: terminado hace más que la retención de la organización (o la de la plataforma). */
const DUE = (alias: string, param: string) => `${alias}.updated_at < now() - make_interval(days => COALESCE(t.retention_days, ${param}::int))`;

/** Borra los datos de las ejecuciones terminadas vencidas. De a `limit` por pasada. Devuelve cuántas purgó. */
export async function purgeWorkflowRunData(d: Deps, opts: { limit?: number; defaultDays?: number | null } = {}): Promise<number> {
  const days = opts.defaultDays ?? agreementsDataRetentionDays();
  const rows = await d.db.query<{ id: string }>(
    `SELECT r.id FROM workflow_runs r JOIN tenants t ON t.id = r.tenant_id
      WHERE r.status IN ${RUN_TERMINAL} AND r.data_purged_at IS NULL AND ${DUE("r", "$1")}
      ORDER BY r.updated_at LIMIT $2`,
    [days, opts.limit ?? 200],
  );
  let purged = 0;
  for (const { id } of rows) {
    try {
      const fileIds = await d.db.tx(async (t) => {
        // Con el run bloqueado y revalidado (un reintento o una cancelación pudo cambiarlo mientras tanto).
        const run = await t.one<any>(
          `SELECT r.context FROM workflow_runs r JOIN tenants t ON t.id = r.tenant_id
            WHERE r.id = $1 AND r.status IN ${RUN_TERMINAL} AND r.data_purged_at IS NULL AND ${DUE("r", "$2")} FOR UPDATE OF r`,
          [id, days],
        );
        if (!run) return null;
        const ids = run.context?.documentsCleaned
          ? []
          : Object.values((run.context?.documents ?? {}) as Record<string, { fileId?: string }>)
              .map((x) => x?.fileId)
              .filter((x): x is string => typeof x === "string");
        // Contexto: sin datos, respuestas, documentos generados ni de dónde se completó cada correo; quedan los ids de
        // los sobres (enlazan con su evidencia).
        await t.query(
          `UPDATE workflow_runs SET
             context = jsonb_build_object('data', '{}'::jsonb, 'documents', '{}'::jsonb, 'http', '{}'::jsonb,
                                          'envelopes', COALESCE(context->'envelopes', '{}'::jsonb), 'documentsCleaned', true),
             started_by_ip = NULL, public_submitter = NULL, public_token_enc = NULL, data_purged_at = now()
           WHERE id = $1`,
          [id],
        );
        // Salidas: solo los ids y la decisión; errores sin el detalle (cuerpo de la respuesta, correos, valores).
        await t.query(
          `UPDATE workflow_run_steps SET
             output = CASE WHEN output IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
               'envelopeId', output->'envelopeId', 'agreementId', output->'agreementId', 'decision', output->'decision', 'status', output->'status')) END,
             error = CASE WHEN error IS NULL THEN NULL ELSE split_part(error, ':', 1) END
           WHERE run_id = $1`,
          [id],
        );
        return ids;
      });
      if (!fileIds) continue;
      purged++;
      // Fuera de la transacción: los PDFs generados que no salieron en un sobre (los de un sobre se conservan).
      if (fileIds.length) await deleteFilesIfUnused(d.db, d.blobs, fileIds);
    } catch (err) {
      d.log.error({ runId: id, err: String(err) }, "no se pudieron borrar los datos de la ejecución vencida");
    }
  }
  return purged;
}

/** Borra los datos de las negociaciones cerradas vencidas. De a `limit` por pasada. Devuelve cuántas purgó. */
export async function purgeNegotiationData(d: Deps, opts: { limit?: number; defaultDays?: number | null } = {}): Promise<number> {
  const days = opts.defaultDays ?? agreementsDataRetentionDays();
  const rows = await d.db.query<{ id: string }>(
    `SELECT n.id FROM negotiations n JOIN tenants t ON t.id = n.tenant_id
      WHERE n.status IN ${NEGOTIATION_CLOSED} AND n.data_purged_at IS NULL AND ${DUE("n", "$1")}
      ORDER BY n.updated_at LIMIT $2`,
    [days, opts.limit ?? 200],
  );
  let purged = 0;
  for (const { id } of rows) {
    try {
      const done = await d.db.tx(async (t) => {
        const n = await t.one(
          `SELECT n.id FROM negotiations n JOIN tenants t ON t.id = n.tenant_id
            WHERE n.id = $1 AND n.status IN ${NEGOTIATION_CLOSED} AND n.data_purged_at IS NULL AND ${DUE("n", "$2")} FOR UPDATE OF n`,
          [id, days],
        );
        if (!n) return false;
        // Quedan título, estado, participantes, versiones (número, autor, resumen, fecha) y el sobre. Se borran los
        // datos de la plantilla, los textos de cada versión, los valores propuestos de variables y los comentarios.
        await t.query(`UPDATE negotiations SET data = '{}'::jsonb, message = NULL, data_purged_at = now() WHERE id = $1`, [id]);
        await t.query(`UPDATE negotiation_versions SET data = '{}'::jsonb, text_snapshot = '' WHERE negotiation_id = $1`, [id]);
        await t.query(`UPDATE negotiation_proposals SET old_value = '', new_value = '', comment = NULL WHERE negotiation_id = $1`, [id]);
        await t.query(`UPDATE negotiation_comments SET body = '', quote = NULL WHERE negotiation_id = $1`, [id]);
        return true;
      });
      if (done) purged++;
    } catch (err) {
      d.log.error({ negotiationId: id, err: String(err) }, "no se pudieron borrar los datos de la negociación vencida");
    }
  }
  return purged;
}

/** Barrido (worker, junto con los demás de acuerdos). */
export async function agreementsRetentionSweep(d: Deps) {
  const runs = await purgeWorkflowRunData(d);
  const negotiations = await purgeNegotiationData(d);
  if (runs || negotiations) d.log.info({ runs, negotiations }, "retención: datos de workflows y negociaciones borrados");
  return { runs, negotiations };
}
