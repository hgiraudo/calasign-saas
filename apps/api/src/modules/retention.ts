// Políticas de retención: a los N días de terminado un sobre (completado, anulado, rechazado o vencido) se borran los
// originales, las imágenes de firma, los adjuntos y las fotos de identidad. Se conservan el PDF sellado (si lo hay: ya
// los contiene) y el registro de eventos.
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import type { BlobStore } from "../infra/storage";
import { AppError } from "../lib/errors";
import { authenticate, type Services } from "./context";
import { signerTokenHash } from "./signer-token";

interface Deps {
  db: Db;
  blobs: BlobStore;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

/** Segundos de un "día" de retención. Solo fuera de producción se puede acortar (pruebas). */
function daySeconds() {
  const v = Number(process.env.RETENTION_DAY_SECONDS);
  return !config.production && Number.isFinite(v) && v > 0 ? v : 86400;
}

/** Días que se guardan las ejecuciones de CRM y conectores (INTEGRATION_RUNS_RETENTION_DAYS, por defecto 180). */
export function integrationRunsRetentionDays() {
  const v = Number(process.env.INTEGRATION_RUNS_RETENTION_DAYS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 180;
}

/**
 * Ejecuciones de CRM y conectores (crm_runs, connector_runs) más viejas que la retención: guardan ids de registros
 * y errores del proveedor y crecían sin límite. De a 5000 por tabla y pasada para no bloquear. Las pendientes también
 * (a esa edad ningún trabajo las va a retomar). Devuelve cuántas borró de cada tabla.
 */
export async function purgeOldIntegrationRuns(db: Db, days = integrationRunsRetentionDays()) {
  const out: Record<string, number> = {};
  for (const table of ["crm_runs", "connector_runs"] as const) {
    const r = await db.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE created_at < now() - make_interval(days => $1::int) LIMIT 5000) RETURNING id`,
      [days],
    );
    out[table] = r.length;
  }
  return out;
}

/**
 * Entregas de webhooks (webhook_deliveries) de más de WEBHOOK_DELIVERY_RETENTION_DAYS (90): guardan el payload con los
 * datos del sobre (asunto, nombres y correos de los firmantes) y la respuesta del receptor, y crecían sin límite. De a
 * 5000 por pasada. Devuelve cuántas borró.
 */
export async function purgeOldWebhookDeliveries(db: Db, days = config.webhooks.deliveryRetentionDays) {
  const r = await db.query(
    `DELETE FROM webhook_deliveries WHERE ctid IN (SELECT ctid FROM webhook_deliveries WHERE created_at < now() - make_interval(days => $1::int) LIMIT 5000) RETURNING id`,
    [days],
  );
  return r.length;
}

/** Archivos borrables de un sobre: originales, imágenes de firma y adjuntos de firmantes. */
async function purgeableFiles(db: Db, envelopeId: string) {
  return db.query<any>(
    `SELECT f.id, f.kind, f.storage_key FROM files f WHERE f.purged_at IS NULL AND f.kind <> 'signed' AND f.id IN (
       SELECT d.file_id FROM documents d WHERE d.envelope_id = $1
       UNION SELECT a.image_file_id FROM adopted_signatures a JOIN recipients r ON r.id = a.recipient_id WHERE r.envelope_id = $1
       UNION SELECT fl.attachment_file_id FROM fields fl WHERE fl.envelope_id = $1 AND fl.attachment_file_id IS NOT NULL
       UNION SELECT ic.file_id FROM identity_captures ic JOIN identity_verifications iv ON iv.id = ic.verification_id WHERE iv.envelope_id = $1)
     -- Los PDF de un sobre creado desde plantilla (o de una plantilla creada desde un sobre) son el MISMO archivo:
     -- no se borra lo que todavía usa una plantilla u otro sobre sin purgar.
     AND NOT EXISTS (SELECT 1 FROM template_documents td WHERE td.file_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM agreements ag WHERE ag.file_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM negotiations ng WHERE ng.file_id = f.id)
     AND NOT EXISTS (
       SELECT 1 FROM documents d2 JOIN envelopes e2 ON e2.id = d2.envelope_id
       WHERE d2.file_id = f.id AND d2.envelope_id <> $1 AND e2.purged_at IS NULL)`,
    [envelopeId],
  );
}

/**
 * Cuándo terminó el sobre (para contar los días de retención). También los anulados, rechazados y vencidos: si no, sus
 * originales, adjuntos, imágenes de firma y fotos de documentos de identidad no se borraban nunca.
 */
const CLOSED_STATUSES = ["completed", "voided", "declined", "expired"];
const CLOSED_AT = `CASE e.status WHEN 'completed' THEN e.completed_at WHEN 'voided' THEN e.voided_at WHEN 'expired' THEN e.expires_at
  ELSE (SELECT max(r.declined_at) FROM recipients r WHERE r.envelope_id = e.id) END`;

export async function purgeExpiredEnvelopes(d: Deps, opts: { tenantId?: string; ignoreAge?: boolean; limit?: number } = {}) {
  const params: unknown[] = [];
  let where = `e.status IN ('completed','voided','declined','expired') AND e.purged_at IS NULL AND t.retention_days IS NOT NULL`;
  if (!opts.ignoreAge) {
    params.push(daySeconds());
    where += ` AND ${CLOSED_AT} < now() - make_interval(secs => t.retention_days * $${params.length}::double precision)`;
  }
  if (opts.tenantId) {
    params.push(opts.tenantId);
    where += ` AND e.tenant_id = $${params.length}`;
  }
  params.push(opts.limit ?? 50);
  const due = await d.db.query<any>(
    `SELECT e.id, e.tenant_id, t.retention_days FROM envelopes e JOIN tenants t ON t.id = e.tenant_id WHERE ${where}
     ORDER BY ${CLOSED_AT} LIMIT $${params.length}`,
    params,
  );
  let purged = 0;
  for (const e of due) {
    // Todo con el sobre bloqueado: un clon o una plantilla "desde sobre" que lee el sobre a la vez (FOR SHARE) espera,
    // y no queda apuntando a un original que se está borrando.
    const ok = await d.db.tx(async (t) => {
      // La política se vuelve a mirar acá: si un administrador la extendió o la quitó mientras corría la pasada, el resto
      // del lote no se borra. Sin bloquear la organización (los borrados en el almacenamiento pueden tardar y todo lo
      // que la bloquea, de IA a miembros, quedaba esperando).
      const cur = await t.one<any>(
        `SELECT e.status, e.purged_at, t.retention_days,
                (${CLOSED_AT} < now() - make_interval(secs => t.retention_days * $2::double precision)) AS due
           FROM envelopes e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1 FOR UPDATE OF e`,
        [e.id, daySeconds()],
      );
      if (!CLOSED_STATUSES.includes(cur?.status) || cur.purged_at || cur.retention_days == null) return false;
      if (!opts.ignoreAge && !cur.due) return false;
      const files = await purgeableFiles(t, e.id);
      const done: any[] = [];
      let failed = 0;
      for (const f of files) {
        try {
          await d.blobs.delete(f.storage_key);
          done.push(f);
        } catch (err) {
          failed++;
          d.log.error({ envelopeId: e.id, fileId: f.id, err: String(err) }, "retención: no se pudo borrar el archivo");
        }
      }
      if (done.length) await t.query(`UPDATE files SET purged_at = now() WHERE id = ANY($1::uuid[])`, [done.map((f) => f.id)]);
      if (failed) return false; // Se reintenta en la próxima pasada.
      await t.query(`UPDATE envelopes SET purged_at = now(), updated_at = now() WHERE id = $1`, [e.id]);
      // Las entregas de webhooks del sobre llevan en el payload su asunto y los datos de los firmantes.
      await t.query(`DELETE FROM webhook_deliveries WHERE envelope_id = $1`, [e.id]);
      const kinds: Record<string, number> = {};
      for (const f of done) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "envelope.purged",
        actor: SYSTEM,
        data: { retentionDays: cur.retention_days, files: done.length, kinds, kept: cur.status === "completed" ? ["signed_pdf", "events"] : ["events"], status: cur.status },
      });
      return true;
    });
    if (ok) purged++;
  }
  // Originales (también los de una plantilla, kind 'template', que comparten sus sobres) que al purgar su sobre todavía
  // usaba una plantilla, otro sobre o un acuerdo: cuando ya solo los
  // referencian sobres purgados, se borran (si no, quedaban para siempre y se seguían sirviendo).
  const orphans = await d.db.query<any>(
    `SELECT f.id, f.storage_key FROM files f
      WHERE f.purged_at IS NULL AND f.kind <> 'signed'
        AND EXISTS (SELECT 1 FROM documents dd JOIN envelopes ee ON ee.id = dd.envelope_id WHERE dd.file_id = f.id AND ee.purged_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM documents dd JOIN envelopes ee ON ee.id = dd.envelope_id WHERE dd.file_id = f.id AND ee.purged_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM template_documents td WHERE td.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM agreements ag WHERE ag.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM negotiations ng WHERE ng.file_id = f.id)
        ${opts.tenantId ? "AND f.tenant_id = $1" : ""}
      LIMIT 100`,
    opts.tenantId ? [opts.tenantId] : [],
  );
  for (const f of orphans) {
    try {
      await d.blobs.delete(f.storage_key);
      await d.db.query(`UPDATE files SET purged_at = now() WHERE id = $1 AND purged_at IS NULL`, [f.id]);
    } catch (err) {
      d.log.error({ fileId: f.id, err: String(err) }, "retención: no se pudo borrar el archivo");
    }
  }
  if (purged) d.log.info({ purged }, "retención aplicada");
  return { purged, candidates: due.length };
}

/** 410 de un original borrado por retención. Solo un sobre completado tiene PDF firmado. */
export function purgedOriginal(status: string) {
  return new AppError(
    410,
    "purged",
    status === "completed"
      ? "El original se eliminó por la política de retención; el PDF firmado sigue disponible"
      : "El original se eliminó por la política de retención",
  );
}

export async function retentionRoutes(app: FastifyInstance, s: Services, log: Deps["log"]) {
  // Documentos cuyo original ya se borró por retención: 410 en lugar de un error interno.
  app.addHook("preHandler", async (req) => {
    const url = req.routeOptions?.url;
    const p = (req.params ?? {}) as Record<string, string>;
    // La ruta del sobre lo mira en su handler, después de autenticar (envelopes.ts). La del firmante, atada a su token:
    // sin eso respondía 410 (y el estado) para documentos de cualquier sobre.
    if (url === "/v1/signing/:token/documents/:documentId/file") {
      if (!/^[0-9a-f-]{36}$/i.test(p.documentId ?? "") || !p.token) return;
      // El link permanente o un token de sesión del canje embebido (signer-token.ts).
      const hash = await signerTokenHash(s.db, p.token);
      if (!hash) return;
      const r = await s.db.one<any>(
        `SELECT f.purged_at, e.status FROM documents d JOIN files f ON f.id = d.file_id JOIN envelopes e ON e.id = d.envelope_id
          JOIN recipients rc ON rc.envelope_id = d.envelope_id AND rc.access_token_hash = $2
         WHERE d.id = $1`,
        [p.documentId, hash],
      );
      // Anulado o vencido: que responda el handler (sobre cerrado), no "original borrado".
      if (r?.purged_at && !["voided", "expired"].includes(r.status)) throw purgedOriginal(r.status);
    }
    // "Plantilla desde sobre" lo mira su handler, con el sobre bloqueado y después de autenticar (templates.ts).
  });

  // Solo local: aplica la retención ya, ignorando la antigüedad (pruebas de punta a punta).
  if (config.environment === "local" && !config.production) {
    const auth = authenticate(s);
    app.post("/dev/retention/run", { preHandler: auth }, async (req) => {
      return purgeExpiredEnvelopes({ db: s.db, blobs: s.blobs, log }, { tenantId: req.auth!.tenantId, ignoreAge: true });
    });
  }
}
