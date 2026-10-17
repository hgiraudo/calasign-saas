// Políticas de retención: a los N días de completado un sobre se borran los originales, las imágenes de
// firma y los adjuntos. Se conservan el PDF sellado (que ya los contiene) y el registro de eventos.
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import type { BlobStore } from "../infra/storage";
import { AppError } from "../lib/errors";
import { authenticate, type Services } from "./context";

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

/** Archivos borrables de un sobre: originales, imágenes de firma y adjuntos de firmantes. */
async function purgeableFiles(db: Db, envelopeId: string) {
  return db.query<any>(
    `SELECT f.id, f.kind, f.storage_key FROM files f WHERE f.purged_at IS NULL AND f.kind <> 'signed' AND f.id IN (
       SELECT d.file_id FROM documents d WHERE d.envelope_id = $1
       UNION SELECT a.image_file_id FROM adopted_signatures a JOIN recipients r ON r.id = a.recipient_id WHERE r.envelope_id = $1
       UNION SELECT fl.attachment_file_id FROM fields fl WHERE fl.envelope_id = $1 AND fl.attachment_file_id IS NOT NULL)`,
    [envelopeId],
  );
}

export async function purgeExpiredEnvelopes(d: Deps, opts: { tenantId?: string; ignoreAge?: boolean; limit?: number } = {}) {
  const params: unknown[] = [];
  let where = `e.status = 'completed' AND e.purged_at IS NULL AND t.retention_days IS NOT NULL`;
  if (!opts.ignoreAge) {
    params.push(daySeconds());
    where += ` AND e.completed_at < now() - make_interval(secs => t.retention_days * $${params.length}::double precision)`;
  }
  if (opts.tenantId) {
    params.push(opts.tenantId);
    where += ` AND e.tenant_id = $${params.length}`;
  }
  params.push(opts.limit ?? 50);
  const due = await d.db.query<any>(
    `SELECT e.id, e.tenant_id, t.retention_days FROM envelopes e JOIN tenants t ON t.id = e.tenant_id WHERE ${where}
     ORDER BY e.completed_at LIMIT $${params.length}`,
    params,
  );
  let purged = 0;
  for (const e of due) {
    const files = await purgeableFiles(d.db, e.id);
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
    await d.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT status, purged_at FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if (cur?.status !== "completed" || cur.purged_at) return;
      if (done.length) await t.query(`UPDATE files SET purged_at = now() WHERE id = ANY($1::uuid[])`, [done.map((f) => f.id)]);
      if (failed) return; // Se reintenta en la próxima pasada.
      await t.query(`UPDATE envelopes SET purged_at = now(), updated_at = now() WHERE id = $1`, [e.id]);
      const kinds: Record<string, number> = {};
      for (const f of done) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "envelope.purged",
        actor: SYSTEM,
        data: { retentionDays: e.retention_days, files: done.length, kinds, kept: ["signed_pdf", "events"] },
      });
    });
    if (!failed) purged++;
  }
  if (purged) d.log.info({ purged }, "retención aplicada");
  return { purged, candidates: due.length };
}

export async function retentionRoutes(app: FastifyInstance, s: Services, log: Deps["log"]) {
  // Documentos cuyo original ya se borró por retención: 410 en lugar de un error interno.
  app.addHook("preHandler", async (req) => {
    const url = req.routeOptions?.url;
    const p = (req.params ?? {}) as Record<string, string>;
    if (url === "/v1/envelopes/:id/documents/:documentId/file" || url === "/v1/signing/:token/documents/:documentId/file") {
      if (!/^[0-9a-f-]{36}$/i.test(p.documentId ?? "")) return;
      const r = await s.db.one<any>(`SELECT f.purged_at FROM documents d JOIN files f ON f.id = d.file_id WHERE d.id = $1`, [p.documentId]);
      if (r?.purged_at) throw new AppError(410, "purged", "El original se eliminó por la política de retención; el PDF firmado sigue disponible");
    }
    if (url === "/v1/templates/from-envelope/:envelopeId" && /^[0-9a-f-]{36}$/i.test(p.envelopeId ?? "")) {
      const r = await s.db.one<any>(`SELECT purged_at FROM envelopes WHERE id = $1`, [p.envelopeId]);
      if (r?.purged_at) throw new AppError(410, "purged", "Los originales de este sobre se eliminaron por la política de retención");
    }
  });

  // Solo local: aplica la retención ya, ignorando la antigüedad (pruebas de punta a punta).
  if (config.environment === "local" && !config.production) {
    const auth = authenticate(s);
    app.post("/dev/retention/run", { preHandler: auth }, async (req) => {
      return purgeExpiredEnvelopes({ db: s.db, blobs: s.blobs, log }, { tenantId: req.auth!.tenantId, ignoreAge: true });
    });
  }
}
