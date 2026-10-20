// Renovación de sellos de archivo (PAdES B-LTA, docs/EVIDENCIA.md §2). Un PDF con datos de validación
// (B-LT/B-LTA) vale a largo plazo mientras el certificado de la TSA de su último sello siga vigente. Antes de
// que venza, el barrido agrega un DSS nuevo (OCSP/CRL de hoy, incluida la cadena de esa TSA) y un sello de
// documento nuevo, como revisión incremental. La versión anterior se conserva (historial + /v1/verify por hash).
import type { FastifyInstance } from "fastify";
import { applyLtv, archiveTimestampInfo, tsaCertificateNotAfter, validatePdf } from "@calasign/pdf";
import type { ArchiveInfo } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { SYSTEM, appendEvent, type Actor } from "../../infra/evidence";
import type { BlobStore } from "../../infra/storage";
import { AppError, conflict, notFound } from "../../lib/errors";
import { iso, sha256Hex, uuidv7 } from "../../lib/util";
import { authenticate, type Services } from "../context";
import { guardedFetch, resolveSealLevel, trustAnchors } from "../evidence-seal";
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
     SELECT $1, $2, $3, $4, 1, 'completed', $5 WHERE NOT EXISTS (SELECT 1 FROM envelope_signed_versions WHERE envelope_id = $3)
     -- Dos inspecciones a la vez (GET /archive y el barrido): la que pierde no falla (antes dejaba un archive_error falso).
     ON CONFLICT (envelope_id, version) DO NOTHING`,
    [uuidv7(), e.tenant_id, e.id, e.signed_file_id, validUntil],
  );
}

/** Marca de un sobre B-T que tiene que completarse a B-LTA (el barrido lo toma enseguida, sin esperar el día). */
const LTV_PENDING = "LTV pendiente";

/** Calcula hasta cuándo vale el archivo (solo PDF con DSS: los B-B/B-T no se renuevan). */
async function inspectArchive(d: Deps, envelopeId: string) {
  const e = await signedFile(d.db, envelopeId);
  if (!e) return;
  const info = await archiveTimestampInfo(await d.blobs.get(e.storage_key));
  const validUntil = info.hasDss && info.last ? info.last.tsaNotAfter : null;
  // Con sello de tiempo pero sin DSS, en una organización con nivel B-LT/B-LTA: el LTV falló al finalizar (TSA u
  // OCSP caídos) y el sobre quedaba en B-T para siempre, sin renovarse ni error visible. Queda marcado "LTV pendiente"
  // (lo toma el barrido aunque la inspección la haya hecho el panel del sobre) y el barrido lo completa.
  const level = info.last && !info.hasDss ? await resolveSealLevel(d.db, e.tenant_id) : null;
  const needsLtv = level === "B-LT" || level === "B-LTA";
  await d.db.query(`UPDATE envelopes SET archive_valid_until = $2, archive_checked_at = now(), archive_error = $3 WHERE id = $1`, [
    e.id,
    validUntil,
    needsLtv ? LTV_PENDING : null,
  ]);
  await ensureFirstVersion(d.db, e, validUntil);
  return { needsLtv };
}

/** Agrega DSS + sello de documento nuevo y guarda la nueva versión. */
export async function renewEnvelopeArchive(d: Deps, envelopeId: string, actor: Actor = SYSTEM) {
  const tsaUrl = config.seal.tsaUrl;
  if (!tsaUrl) throw new AppError(409, "tsa_not_configured", "No hay TSA configurada para renovar el sello de archivo");
  // Una renovación a la vez por sobre (reclamo con vencimiento, por si el proceso muere a mitad), antes de pagar el
  // sello de tiempo y de analizar el PDF.
  // El valor del reclamo identifica a esta renovación: al terminar se suelta solo si sigue siendo el suyo (una que
  // tardó más que el reclamo no borra el de la que tomó la posta).
  const claim = await d.db.query<{ until: string }>(
    // Como texto: un Date de JS pierde los microsegundos y la comparación al soltar no coincidía nunca en Postgres.
    `UPDATE envelopes SET archive_renewing_until = clock_timestamp() + interval '5 minutes'
      WHERE id = $1 AND (archive_renewing_until IS NULL OR archive_renewing_until < now()) RETURNING archive_renewing_until::text AS until`,
    [envelopeId],
  );
  if (!claim.length) throw conflict("archive_renewal_in_progress", "Ya hay una renovación del sello de archivo en curso para este sobre");
  try {
    return await renewClaimed(d, envelopeId, tsaUrl, actor);
  } finally {
    await d.db
      .query(`UPDATE envelopes SET archive_renewing_until = NULL WHERE id = $1 AND archive_renewing_until = $2::timestamptz`, [envelopeId, claim[0].until])
      .catch(() => {});
  }
}

async function renewClaimed(d: Deps, envelopeId: string, tsaUrl: string, actor: Actor) {
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
  // Solo es una renovación de verdad si ya tenía DSS: completar un B-T (upgrade) usa la misma TSA y no es un problema.
  const upgrade = !prev.hasDss;
  const notExtended = !upgrade && new Date(next.last.tsaNotAfter) <= new Date(prev.last.tsaNotAfter);
  // Si el PDF cambió mientras tanto (otra renovación ganó) o la transacción falla, la versión subida no la referencia nada.
  await discardBlobsOnFailure(d.blobs, [key], () => d.db.tx(async (t) => {
    const cur = await t.one<any>(`SELECT signed_file_id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
    if (cur?.signed_file_id !== e.signed_file_id) throw conflict("archive_changed", "El PDF cambió mientras se renovaba; se reintenta en el próximo barrido");
    // Como inspectArchive: un B-T (sin DSS) no tenía validez de archivo; su vencimiento no es el de la TSA.
    await ensureFirstVersion(t, e, prev.hasDss && prev.last ? prev.last.tsaNotAfter : null);
    // La renovación agrega revisiones al mismo PDF: el certificado (y su hash final) es el del archivo anterior.
    await t.query(
      `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256, chain_head)
       VALUES ($1,$2,'signed',$3,'application/pdf',$4,$5,(SELECT chain_head FROM files WHERE id = $6))`,
      [fileId, e.tenant_id, key, r.pdf.length, sha, e.signed_file_id],
    );
    await t.query(
      `INSERT INTO envelope_signed_versions (id, tenant_id, envelope_id, file_id, version, reason, valid_until) VALUES ($1,$2,$3,$4,$5,'archive_renewal',$6)`,
      [uuidv7(), e.tenant_id, e.id, fileId, versionNo, next.last!.tsaNotAfter],
    );
    await t.query(
      `UPDATE envelopes SET signed_file_id = $2, archive_valid_until = $3, archive_checked_at = now(), archive_renewals = archive_renewals + 1,
         archive_error = $4, updated_at = now() WHERE id = $1`,
      [e.id, fileId, next.last!.tsaNotAfter, notExtended ? "La TSA actual vence igual o antes que la anterior: conviene renovar con otra TSA" : null],
    );
    // El repositorio de acuerdos y los enlaces de descarga vigentes pasan a la versión renovada (si no, seguían
    // sirviendo la anterior, sin el sello nuevo, y mostrando otro hash que el sobre).
    await t.query(`UPDATE agreements SET file_id = $3, updated_at = now() WHERE envelope_id = $1 AND file_id = $2`, [e.id, e.signed_file_id, fileId]);
    await t.query(`UPDATE download_links SET file_id = $3 WHERE envelope_id = $1 AND file_id = $2 AND expires_at > now()`, [e.id, e.signed_file_id, fileId]);
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
        previousValidUntil: upgrade ? null : prev.last!.tsaNotAfter,
        ...(upgrade ? { upgrade: true } : {}),
        dss: { certs: r.report.certs, ocsps: r.report.ocsps, crls: r.report.crls, missingRevocation: r.report.missingRevocation.length },
      },
    });
  }));
  d.log.info({ envelopeId: e.id, version: versionNo, sha256: sha }, "sello de archivo renovado");
  return { version: versionNo, sha256: sha, validUntil: next.last.tsaNotAfter };
}

let lastRun = 0;
/** Tests: permite volver a correr el barrido sin `force` antes de la hora. */
export const resetArchiveSweepClock = () => {
  lastRun = 0;
  tsaCache = null;
};

const MAX_RENEWALS = 50;
const MAX_RENEWALS_PER_DAY = 3;

/** Vencimiento del certificado actual de la TSA: una consulta (un sello) cada 6 h como mucho. Las fallas no se cachean. */
const TSA_CACHE_MS = 6 * 3600_000;
let tsaCache: { url: string; notAfter: string; at: number } | null = null;
/** Tests: fija el vencimiento del certificado actual de la TSA (sin consultarla). */
export const primeTsaCacheForTests = (url: string, notAfter: string) => {
  tsaCache = { url, notAfter, at: Date.now() };
};
export async function currentTsaNotAfter(tsaUrl: string): Promise<string | null> {
  if (tsaCache && tsaCache.url === tsaUrl && Date.now() - tsaCache.at < TSA_CACHE_MS) return tsaCache.notAfter;
  try {
    const notAfter = await tsaCertificateNotAfter(tsaUrl);
    tsaCache = { url: tsaUrl, notAfter, at: Date.now() };
    return notAfter;
  } catch {
    return null;
  }
}

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
    // Una inspección que falló (BYOK o almacenamiento caídos) se reintenta una vez por día: si no, ese sobre no se
    // renovaba nunca más y su validez a largo plazo vencía sin aviso. Primero los nunca inspeccionados (los completados
    // recién no quedan detrás de los reintentos). Los "LTV pendiente" van aparte (ya se sabe qué les falta).
    `SELECT id FROM envelopes WHERE status = 'completed' AND signed_file_id IS NOT NULL AND archive_valid_until IS NULL
       AND (archive_checked_at IS NULL
            OR (archive_error IS NOT NULL AND archive_error NOT LIKE 'LTV pendiente%'
                AND ($3::boolean OR archive_checked_at < now() - interval '1 day')))
       AND ($2::uuid IS NULL OR id = $2)
     ORDER BY archive_checked_at NULLS FIRST, completed_at LIMIT $1`,
    [cfg.batch * 5, opts.envelopeId ?? null, Boolean(opts.force)],
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
  // B-T → B-LTA: los marcados "LTV pendiente" (por esta pasada, otra o el panel del sobre), sin volver a inspeccionarlos.
  // Con tope por pasada, y se cortan ante la primera falla (con la TSA caída, cada uno hacía todas las consultas OCSP/CRL).
  const toUpgrade = await d.db.query<any>(
    // Los que fallaron ("LTV pendiente: …") se reintentan una vez por día sin volver a inspeccionarlos (antes cada
    // reintento los re-descargaba y borraba el error visible) y van después de los nuevos: uno que falla siempre no
    // corta a los demás.
    `SELECT id FROM envelopes WHERE status = 'completed' AND archive_valid_until IS NULL
       AND (archive_error = 'LTV pendiente'
            OR (archive_error LIKE 'LTV pendiente:%' AND ($3::boolean OR archive_checked_at < now() - interval '1 day')))
       AND ($2::uuid IS NULL OR id = $2)
     ORDER BY (archive_error = 'LTV pendiente') DESC, completed_at LIMIT $1`,
    [cfg.batch, opts.envelopeId ?? null, Boolean(opts.force)],
  );
  for (const p of toUpgrade) {
    try {
      await renewEnvelopeArchive(d, p.id);
      renewed++;
    } catch (err) {
      // Otra renovación (manual u otro worker) la está haciendo, o ya cambió el PDF: no es una falla.
      if (err instanceof AppError && (err.code === "archive_renewal_in_progress" || err.code === "archive_changed")) continue;
      // Queda a la vista y se reintenta una vez por día (la consulta de pendientes toma los que tienen error).
      failed++;
      await d.db.query(`UPDATE envelopes SET archive_checked_at = now(), archive_error = $2 WHERE id = $1`, [p.id, `${LTV_PENDING}: ${String(err)}`.slice(0, 500)]);
      break;
    }
  }
  const due = await d.db.query<any>(
    `SELECT id, archive_valid_until FROM envelopes WHERE status = 'completed' AND archive_valid_until IS NOT NULL
       AND archive_valid_until < now() + make_interval(days => $1)
       AND (archive_renewals = 0 OR $3::boolean OR archive_checked_at < now() - make_interval(days => $4))
       -- Tras una falla (TSA caída, OCSP inaccesible) no se reintenta en cada barrido horario: una vez por día.
       AND ($3::boolean OR archive_error IS NULL OR archive_checked_at < now() - interval '1 day')
       AND ($5::uuid IS NULL OR id = $5)
       -- El tope de renovaciones de la ruta manual vale también para el barrido.
       AND archive_renewals < $6
     ORDER BY archive_valid_until LIMIT $2`,
    [days, cfg.batch, Boolean(opts.force), cfg.minIntervalDays, opts.envelopeId ?? null, MAX_RENEWALS],
  );
  // Si el último sello ya es del certificado que la TSA usa hoy (o de uno que vence después), renovar no extiende la
  // validez: con una sola TSA cuyo certificado vence dentro de la ventana, cada sobre nuevo se "renovaba" enseguida y
  // después cada 30 días sin ganar nada. Se consulta el certificado actual una vez (con caché) y se saltean esos
  // sobres; como van ordenados por vencimiento, a partir del primero que se saltea se saltean todos. `force` (solo el
  // barrido de desarrollo y los tests) no lo aplica.
  const tsaNotAfter = due.length && !opts.force ? await currentTsaNotAfter(config.seal.tsaUrl) : null;
  for (const e of due) {
    if (tsaNotAfter && new Date(e.archive_valid_until).getTime() >= new Date(tsaNotAfter).getTime()) continue;
    try {
      await renewEnvelopeArchive(d, e.id);
      renewed++;
    } catch (err) {
      // Otra renovación (p. ej. una manual) en curso: no es una falla de este sobre.
      if (err instanceof AppError && err.code === "archive_renewal_in_progress") continue;
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
    let e = await s.db.one<any>(
      `SELECT id, status, archive_renewals, archive_valid_until, archive_checked_at, archive_error FROM envelopes WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, req.auth!.tenantId],
    );
    if (!e) throw notFound("Sobre");
    // Cada renovación pide un sello de tiempo (con costo) y guarda otro PDF, más grande, que no se borra: con tope.
    if (Number(e.archive_renewals ?? 0) >= MAX_RENEWALS) {
      throw new AppError(409, "archive_renewal_limit", `El sobre llegó al máximo de ${MAX_RENEWALS} renovaciones del sello de archivo`);
    }
    // Sin inspeccionar todavía (nunca se abrió el panel ni pasó el barrido): se calcula antes de decidir. Si la
    // inspección falla (BYOK o almacenamiento caídos) se propaga el error: tragarlo terminaba en un 409
    // archive_not_applicable engañoso (sin vencimiento calculado) en vez de la falla real (p. ej. 503).
    if (e.status === "completed" && !e.archive_checked_at) {
      await inspectArchive(deps(), e.id);
      e = await s.db.one<any>(`SELECT id, status, archive_renewals, archive_valid_until, archive_checked_at, archive_error FROM envelopes WHERE id = $1`, [e.id]);
    }
    // Qué se puede pedir a mano (decisión, docs/EVIDENCIA.md §2):
    //  - un archivo (PDF con DSS: B-LT/B-LTA) que vence dentro de la ventana de renovación: es justamente un pedido de
    //    archivo y se renueva con B-LTA aunque hoy la organización use otro nivel (el PDF ya era de archivo);
    //  - un "LTV pendiente" (B-T que tenía que quedar B-LT/B-LTA), solo si el nivel vigente de la organización lo sigue
    //    pidiendo: con B-B/B-T no se fuerza B-LTA sobre un PDF que la organización decidió no archivar.
    // Lo demás es 409: antes cualquier pedido agregaba un sello (con costo) aunque faltaran años para el vencimiento.
    const ltvPending = !e.archive_valid_until && typeof e.archive_error === "string" && e.archive_error.startsWith(LTV_PENDING);
    if (ltvPending) {
      const level = await resolveSealLevel(s.db, req.auth!.tenantId);
      if (level !== "B-LT" && level !== "B-LTA") {
        throw new AppError(409, "archive_not_applicable", `La organización usa el nivel ${level}: el PDF no se completa a un sello de archivo (B-LTA)`);
      }
    } else if (!e.archive_valid_until) {
      throw new AppError(409, "archive_not_applicable", "El PDF no tiene datos de validación a largo plazo (B-LT/B-LTA): no hay sello de archivo que renovar");
    } else if (new Date(e.archive_valid_until).getTime() > Date.now() + archiveConfig().days * 86_400_000) {
      throw new AppError(409, "archive_not_due", "El sello de archivo todavía no está por vencer: se renueva solo cuando se acerca su vencimiento", {
        validUntil: iso(e.archive_valid_until),
      });
    } else {
      // Como el barrido: si el último sello ya es del certificado que la TSA usa hoy (o de uno que vence después), un
      // sello nuevo no extiende la validez y solo cuesta un sello y otro PDF.
      const tsaNotAfter = config.seal.tsaUrl ? await currentTsaNotAfter(config.seal.tsaUrl) : null;
      if (tsaNotAfter && new Date(e.archive_valid_until).getTime() >= new Date(tsaNotAfter).getTime()) {
        throw new AppError(409, "archive_not_due", "Renovar ahora no extendería la validez: el sello de archivo ya es del certificado vigente de la autoridad de sellado de tiempo", {
          validUntil: iso(e.archive_valid_until),
          tsaNotAfter: iso(tsaNotAfter),
        });
      }
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
