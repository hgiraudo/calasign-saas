// Renovación de sellos de archivo (PAdES B-LTA, docs/EVIDENCIA.md §2). Un PDF con datos de validación
// (B-LT/B-LTA) vale a largo plazo mientras el certificado de la TSA de su último sello siga vigente. Antes de
// que venza, el barrido agrega un DSS nuevo (OCSP/CRL de hoy, incluida la cadena de esa TSA) y un sello de
// documento nuevo, como revisión incremental. La versión anterior se conserva (historial + /v1/verify por hash).
import type { FastifyInstance } from "fastify";
import { applyLtv, archiveTimestampInfo, validatePdf } from "@calasign/pdf";
import type { ArchiveInfo } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { SYSTEM, appendEvent, type Actor } from "../../infra/evidence";
import type { BlobStore } from "../../infra/storage";
import { AppError, conflict, notFound } from "../../lib/errors";
import { iso, sha256Hex, uuidv7 } from "../../lib/util";
import { authenticate, type Services } from "../context";
import { guardedFetch, trustAnchors } from "../evidence-seal";
import { discardBlobsOnFailure } from "../file-cleanup";

const env = process.env;
export const archiveConfig = () => ({
  enabled: !/^(0|false|no|off)$/i.test(env.ARCHIVE_RENEWAL_ENABLED ?? ""),
  /** Renovar cuando el certificado de la TSA del último sello vence dentro de estos días. */
  days: Number(env.ARCHIVE_RENEWAL_DAYS ?? 180),
  /** No volver a renovar el mismo sobre antes de estos días (evita renovar en cada barrido si la TSA no cambió). */
  minIntervalDays: Number(env.ARCHIVE_RENEWAL_MIN_INTERVAL_DAYS ?? 30),
  batch: Number(env.ARCHIVE_RENEWAL_BATCH ?? 10),
});

interface Deps {
  db: Db;
  blobs: BlobStore;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

async function signedFile(db: Db, envelopeId: string) {
  return db.one<any>(
    `SELECT e.id, e.tenant_id, e.status, e.signed_file_id, e.archive_renewals, f.storage_key, f.sha256 FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`,
    [envelopeId],
  );
}

/** Registra la versión original (v1) si todavía no hay historial. */
async function ensureFirstVersion(db: Db, e: { id: string; tenant_id: string; signed_file_id: string }, validUntil: string | null) {
  await db.query(
    `INSERT INTO envelope_signed_versions (id, tenant_id, envelope_id, file_id, version, reason, valid_until)
     SELECT $1, $2, $3, $4, 1, 'completed', $5 WHERE NOT EXISTS (SELECT 1 FROM envelope_signed_versions WHERE envelope_id = $3)`,
    [uuidv7(), e.tenant_id, e.id, e.signed_file_id, validUntil],
  );
}

/** Calcula hasta cuándo vale el archivo (solo PDF con DSS: los B-B/B-T no se renuevan). */
async function inspectArchive(d: Deps, envelopeId: string) {
  const e = await signedFile(d.db, envelopeId);
  if (!e) return;
  const info = await archiveTimestampInfo(await d.blobs.get(e.storage_key));
  const validUntil = info.hasDss && info.last ? info.last.tsaNotAfter : null;
  await d.db.query(`UPDATE envelopes SET archive_valid_until = $2, archive_checked_at = now() WHERE id = $1`, [e.id, validUntil]);
  await ensureFirstVersion(d.db, e, validUntil);
}

/** Agrega DSS + sello de documento nuevo y guarda la nueva versión. */
export async function renewEnvelopeArchive(d: Deps, envelopeId: string, actor: Actor = SYSTEM) {
  const tsaUrl = config.seal.tsaUrl;
  if (!tsaUrl) throw new AppError(409, "tsa_not_configured", "No hay TSA configurada para renovar el sello de archivo");
  const e = await signedFile(d.db, envelopeId);
  if (!e || e.status !== "completed") throw notFound("Sobre completado");
  const before = await d.blobs.get(e.storage_key);
  const prev = await archiveTimestampInfo(before);
  if (!prev.last) throw conflict("not_timestamped", "El PDF no tiene sello de tiempo: no hay archivo que renovar");

  const anchors = await trustAnchors();
  const r = await applyLtv(before, { level: "B-LTA", tsaUrl, extraCerts: anchors, fetcher: guardedFetch });
  // Verificación: todas las firmas y sellos siguen íntegros y el último es el sello de documento nuevo.
  const report = await validatePdf(r.pdf, { trustAnchors: anchors });
  const broken = report.signatures.filter((x) => !x.integrity.valid);
  if (broken.length) throw new Error(`la renovación rompió la integridad de ${broken.length} firma(s)`);
  const next = await archiveTimestampInfo(r.pdf);
  if (!next.last || next.last.kind !== "document_timestamp" || next.documentTimestamps !== prev.documentTimestamps + 1) {
    throw new Error("la renovación no agregó un sello de documento");
  }
  const sha = sha256Hex(r.pdf);
  const fileId = uuidv7();
  const versionNo = Number((await d.db.one<any>(`SELECT COALESCE(max(version), 1) AS v FROM envelope_signed_versions WHERE envelope_id = $1`, [e.id]))?.v ?? 1) + 1;
  const key = `tenants/${e.tenant_id}/envelopes/${e.id}/${fileId}-signed-v${versionNo}.pdf`;
  await d.blobs.put(key, r.pdf, "application/pdf");
  const notExtended = new Date(next.last.tsaNotAfter) <= new Date(prev.last.tsaNotAfter);
  // Si el PDF cambió mientras tanto (otra renovación ganó) o la transacción falla, la versión subida no la referencia nada.
  await discardBlobsOnFailure(d.blobs, [key], () => d.db.tx(async (t) => {
    const cur = await t.one<any>(`SELECT signed_file_id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
    if (cur?.signed_file_id !== e.signed_file_id) throw conflict("archive_changed", "El PDF cambió mientras se renovaba; se reintenta en el próximo barrido");
    await ensureFirstVersion(t, e, prev.last ? prev.last.tsaNotAfter : null);
    await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5)`, [
      fileId,
      e.tenant_id,
      key,
      r.pdf.length,
      sha,
    ]);
    await t.query(
      `INSERT INTO envelope_signed_versions (id, tenant_id, envelope_id, file_id, version, reason, valid_until) VALUES ($1,$2,$3,$4,$5,'archive_renewal',$6)`,
      [uuidv7(), e.tenant_id, e.id, fileId, versionNo, next.last!.tsaNotAfter],
    );
    await t.query(
      `UPDATE envelopes SET signed_file_id = $2, archive_valid_until = $3, archive_checked_at = now(), archive_renewals = archive_renewals + 1,
         archive_error = $4, updated_at = now() WHERE id = $1`,
      [e.id, fileId, next.last!.tsaNotAfter, notExtended ? "La TSA actual vence igual o antes que la anterior: conviene renovar con otra TSA" : null],
    );
    await appendEvent(t, {
      tenantId: e.tenant_id,
      envelopeId: e.id,
      type: "envelope.archive_renewed",
      actor,
      data: {
        version: versionNo,
        previousSha256: e.sha256,
        signedSha256: sha,
        tsa: next.last!.tsa,
        validUntil: next.last!.tsaNotAfter,
        previousValidUntil: prev.last!.tsaNotAfter,
        dss: { certs: r.report.certs, ocsps: r.report.ocsps, crls: r.report.crls, missingRevocation: r.report.missingRevocation.length },
      },
    });
  }));
  d.log.info({ envelopeId: e.id, version: versionNo, sha256: sha }, "sello de archivo renovado");
  return { version: versionNo, sha256: sha, validUntil: next.last.tsaNotAfter };
}

let lastRun = 0;

/** Barrido: completa la fecha de vencimiento de los archivos nuevos y renueva los que vencen pronto. */
export async function archiveSweep(d: Deps, opts: { days?: number; force?: boolean; envelopeId?: string } = {}) {
  const cfg = archiveConfig();
  if (!cfg.enabled || !config.seal.tsaUrl) return { inspected: 0, renewed: 0, failed: 0 };
  if (!opts.force && Date.now() - lastRun < 3600_000) return { inspected: 0, renewed: 0, failed: 0 };
  lastRun = Date.now();
  const days = opts.days ?? cfg.days;
  let inspected = 0;
  let renewed = 0;
  let failed = 0;
  const pending = await d.db.query<any>(
    `SELECT id FROM envelopes WHERE status = 'completed' AND signed_file_id IS NOT NULL AND archive_checked_at IS NULL AND ($2::uuid IS NULL OR id = $2)
     ORDER BY completed_at LIMIT $1`,
    [cfg.batch * 5, opts.envelopeId ?? null],
  );
  for (const p of pending) {
    try {
      await inspectArchive(d, p.id);
      inspected++;
    } catch (err) {
      d.log.warn({ envelopeId: p.id, err: String(err) }, "no se pudo leer el sello de archivo");
      await d.db.query(`UPDATE envelopes SET archive_checked_at = now(), archive_error = $2 WHERE id = $1`, [p.id, String(err).slice(0, 500)]);
    }
  }
  const due = await d.db.query<any>(
    `SELECT id FROM envelopes WHERE status = 'completed' AND archive_valid_until IS NOT NULL
       AND archive_valid_until < now() + make_interval(days => $1)
       AND (archive_renewals = 0 OR $3::boolean OR archive_checked_at < now() - make_interval(days => $4))
       -- Tras una falla (TSA caída, OCSP inaccesible) no se reintenta en cada barrido horario: una vez por día.
       AND ($3::boolean OR archive_error IS NULL OR archive_checked_at < now() - interval '1 day')
       AND ($5::uuid IS NULL OR id = $5)
     ORDER BY archive_valid_until LIMIT $2`,
    [days, cfg.batch, Boolean(opts.force), cfg.minIntervalDays, opts.envelopeId ?? null],
  );
  for (const e of due) {
    try {
      await renewEnvelopeArchive(d, e.id);
      renewed++;
    } catch (err) {
      failed++;
      d.log.error({ envelopeId: e.id, err: String(err) }, "falló la renovación del sello de archivo");
      await d.db.query(`UPDATE envelopes SET archive_checked_at = now(), archive_error = $2 WHERE id = $1`, [e.id, String(err).slice(0, 500)]);
    }
  }
  return { inspected, renewed, failed };
}

export async function archiveInfo(db: Db, envelopeId: string): Promise<ArchiveInfo> {
  const e = await db.one<any>(`SELECT archive_valid_until, archive_checked_at, archive_renewals, archive_error FROM envelopes WHERE id = $1`, [envelopeId]);
  const versions = await db.query<any>(
    `SELECT v.version, v.reason, v.valid_until, v.created_at, f.sha256 FROM envelope_signed_versions v JOIN files f ON f.id = v.file_id
     WHERE v.envelope_id = $1 ORDER BY v.version`,
    [envelopeId],
  );
  return {
    validUntil: iso(e?.archive_valid_until),
    checkedAt: iso(e?.archive_checked_at),
    renewals: Number(e?.archive_renewals ?? 0),
    error: e?.archive_error ?? null,
    versions: versions.map((v) => ({ version: v.version, reason: v.reason, sha256: v.sha256, validUntil: iso(v.valid_until), createdAt: iso(v.created_at)! })),
  };
}

const MAX_RENEWALS = 50;
const MAX_RENEWALS_PER_DAY = 3;

export async function archiveRoutes(app: FastifyInstance, s: Services, log: Deps["log"]) {
  const auth = authenticate(s);
  const deps = (): Deps => ({ db: s.db, blobs: s.blobs, log });

  app.get<{ Params: { id: string } }>("/v1/envelopes/:id/archive", { preHandler: auth }, async (req) => {
    const e = await s.db.one<any>(`SELECT id, status FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth!.tenantId]);
    if (!e) throw notFound("Sobre");
    if (e.status === "completed") {
      const row = await s.db.one<any>(`SELECT archive_checked_at FROM envelopes WHERE id = $1`, [e.id]);
      // Si falla, queda registrado (como en el barrido): si no, cada consulta volvía a bajar y analizar el PDF.
      if (!row.archive_checked_at) {
        await inspectArchive(deps(), e.id).catch((err) =>
          s.db.query(`UPDATE envelopes SET archive_checked_at = now(), archive_error = $2 WHERE id = $1`, [e.id, String(err).slice(0, 500)]),
        );
      }
    }
    return archiveInfo(s.db, e.id);
  });

  app.post<{ Params: { id: string } }>("/v1/envelopes/:id/archive/renew", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const e = await s.db.one<any>(`SELECT id, archive_renewals FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth!.tenantId]);
    if (!e) throw notFound("Sobre");
    // Cada renovación pide un sello de tiempo (con costo) y guarda otro PDF, más grande, que no se borra: con tope.
    if (Number(e.archive_renewals ?? 0) >= MAX_RENEWALS) {
      throw new AppError(409, "archive_renewal_limit", `El sobre llegó al máximo de ${MAX_RENEWALS} renovaciones del sello de archivo`);
    }
    const recent = await s.db.one<any>(
      `SELECT count(*)::int AS n FROM envelope_signed_versions WHERE envelope_id = $1 AND reason = 'archive_renewal' AND created_at > now() - interval '1 day'`,
      [e.id],
    );
    if ((recent?.n ?? 0) >= MAX_RENEWALS_PER_DAY) {
      throw new AppError(429, "archive_recently_renewed", "El sello de archivo de este sobre ya se renovó varias veces hoy");
    }
    await renewEnvelopeArchive(deps(), e.id, req.auth!.actor);
    return archiveInfo(s.db, e.id);
  });

  if (config.environment === "local") {
    // Solo local: fuerza el barrido (pruebas automáticas).
    app.post("/dev/archive/sweep", async (req) => {
      const b = (req.body ?? {}) as { days?: number; envelopeId?: string };
      return archiveSweep(deps(), { days: b.days, force: true, envelopeId: b.envelopeId });
    });
  }
}
