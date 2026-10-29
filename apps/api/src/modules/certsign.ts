// Firma con certificado propio del firmante (Fase 5). El titular firma un hash en su dispositivo con el
// "Firmador CalaSign" (token PKCS#11, almacén de Windows o archivo .p12); la clave nunca sale de ahí.
//
// Ciclo:
//   1. Todos firman electrónicamente como siempre. Si hay firmantes con certificado, el worker arma el PDF final
//      SIN el sello de la plataforma (PDF de trabajo) y el sobre pasa a "awaiting_certificates".
//   2. En orden de ruteo, cada firmante con certificado abre su link, obtiene un código de un solo uso y lo usa
//      en el Firmador: GET sesión → POST certificado (controles + preparación) → POST firma (CMS + inserción).
//   3. Cada firma es una revisión incremental PAdES (con sello de tiempo): no invalida las anteriores.
//   4. Con la última, el sobre vuelve a "finalizing" y el worker agrega el sello de la plataforma y LTV.
//
// Decisión: el certificado de finalización se genera ANTES de las firmas con certificado (no se le puede agregar
// una página después sin romperlas). Por eso solo dice "firmará con certificado digital"; los datos del
// certificado (titular, emisor, serie, vigencia, hora) quedan en la propia firma del PDF, en los eventos de
// evidencia y en el reporte de /verify y /v1/validate.
import { createHash, randomInt } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CertsignCertificateInput,
  CertsignSignatureInput,
  type CertsignPairing,
  type CertsignPrepared,
  type CertsignResult,
  type CertsignSessionInfo,
  type EnvelopeCertificateProgress,
  type FirmadorDownload,
  type SigningCertificateStep,
} from "@calasign/shared";
import {
  checkSigningCertificate,
  commonName,
  completeExternalSignature,
  fetchCrl,
  fetchOcsp,
  parseCert,
  statusFromCrl,
  statusFromOcsp,
  pemToDerList,
  prepareExternalSignature,
  renderEnvelopePdf,
  validatePdf,
  type FinalizeInput,
} from "@calasign/pdf";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent, SYSTEM, type Actor } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import type { BlobStore } from "../infra/storage";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { BUMP_UPDATED_AT, iso, sha256Hex, uuidv7 } from "../lib/util";
import { authenticate, clientInfo, type Services } from "./context";
import { envelopeBaseUrl } from "./white-label/brand";
import { lockEnvelope, pastExpiry } from "./envelopes";
import { guardedFetch, trustAnchors } from "./evidence-seal";
import { recipientActor, resolveToken } from "./signing";
import { explicitRequirementsJson, idMatchSkipped, normalizeRequirements } from "./certsign-requirements";
import { deleteBlobsQuietly } from "./file-cleanup";
export { normalizeRequirements };

const CODE_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sin 0/O, 1/I/L

// ───────────────────────────── Destinatarios ─────────────────────────────

/** Aplica signatureType / certificateRequirements después del upsert de destinatarios (solo las claves presentes). */
export async function applyCertificateFlags(
  db: Db,
  envelopeId: string,
  list: { id: string; role?: string; signatureType?: "electronic" | "certificate"; certificateRequirements?: unknown }[],
) {
  for (const r of list) {
    if (r.signatureType === undefined && r.certificateRequirements === undefined) continue;
    if (r.signatureType === "certificate" && (r.role ?? "signer") !== "signer")
      throw badRequest("certificate_not_applicable", "Solo un firmante puede firmar con certificado");
    await db.query(
      `UPDATE recipients SET signature_type = COALESCE($3, signature_type),
         certificate_requirements = CASE WHEN $4::boolean THEN $5::jsonb ELSE certificate_requirements END
       WHERE id = $1 AND envelope_id = $2`,
      [r.id, envelopeId, r.signatureType ?? null, r.certificateRequirements !== undefined, explicitRequirementsJson(r.certificateRequirements)],
    );
  }
  // Un rol que dejó de ser firmante no puede seguir con firma con certificado.
  await db.query(
    `UPDATE recipients SET signature_type = 'electronic' WHERE envelope_id = $1 AND role <> 'signer' AND signature_type = 'certificate'`,
    [envelopeId],
  );
  // Exigir que el certificado corresponda al documento sin cargar el documento: antes el control se salteaba en silencio
  // y firmaba cualquier certificado válido. Solo los destinatarios de este guardado (un alta suelta no se traba por otro).
  const missing = await db.one<{ name: string }>(
    `SELECT name FROM recipients WHERE envelope_id = $1 AND id = ANY($2::uuid[]) AND ${MISSING_ID_DOCUMENT_SQL} ORDER BY routing_order, name LIMIT 1`,
    [envelopeId, list.map((r) => r.id)],
  );
  if (missing) throw missingIdDocument(missing.name, 400);
}

/** Firmante con certificado que exige corresponder al documento de identidad y no tiene el número cargado. */
export const MISSING_ID_DOCUMENT_SQL = `role = 'signer' AND signature_type = 'certificate'
  AND COALESCE((certificate_requirements->>'matchIdDocument')::boolean, false) AND COALESCE(btrim(id_document_number), '') = ''`;

export function missingIdDocument(name: string, status: 400 | 422) {
  return new AppError(
    status,
    "missing_id_document",
    `${name}: para exigir que el certificado corresponda a su documento de identidad hay que cargar el número de documento`,
    { recipient: name },
  );
}

/**
 * Borra los PDF de trabajo y los preparados de un sobre que ya no se va a firmar con certificado (anulado, vencido o
 * purgado): no tienen fila en `files`, así que la retención de archivos no los ve. Primero el archivo y después la
 * referencia: si un borrado falla queda la fila y se reintenta (en la purga por retención). Devuelve false si quedó alguno.
 */
export async function discardCertsignFiles(db: Db, blobs: BlobStore, envelopeId: string): Promise<boolean> {
  let ok = true;
  // Códigos sin usar: ya no sirven (el sobre está cerrado).
  await db.query(`UPDATE certsign_sessions SET status = 'expired' WHERE envelope_id = $1 AND status IN ('created','prepared')`, [envelopeId]);
  const sessions = await db.query<{ id: string; prepared_key: string }>(
    `SELECT id, prepared_key FROM certsign_sessions WHERE envelope_id = $1 AND prepared_key IS NOT NULL`,
    [envelopeId],
  );
  for (const x of sessions) {
    try {
      await blobs.delete(x.prepared_key);
      await db.query(`UPDATE certsign_sessions SET prepared_key = NULL WHERE id = $1 AND prepared_key = $2`, [x.id, x.prepared_key]);
    } catch {
      ok = false;
    }
  }
  // Preparados reemplazados que todavía esperaban el margen del barrido: el sobre está cerrado, ya no los baja nadie.
  for (const x of await db.query<{ storage_key: string }>(`SELECT storage_key FROM certsign_stale_blobs WHERE envelope_id = $1`, [envelopeId])) {
    try {
      await blobs.delete(x.storage_key);
      await db.query(`DELETE FROM certsign_stale_blobs WHERE storage_key = $1`, [x.storage_key]);
    } catch {
      ok = false;
    }
  }
  const cs = await db.one<{ working_key: string }>(`SELECT working_key FROM envelope_certsign WHERE envelope_id = $1`, [envelopeId]);
  if (cs) {
    try {
      await blobs.delete(cs.working_key);
      await db.query(`DELETE FROM envelope_certsign WHERE envelope_id = $1 AND working_key = $2`, [envelopeId, cs.working_key]);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** Margen antes de borrar un preparado reemplazado: el Firmador puede estar bajándolo o firmándolo todavía. */
export const STALE_PREPARED_GRACE_MS = 10 * 60_000;

/** El archivo ya no existe (se reemplazó y el barrido lo borró, o se purgó). */
function isMissingBlob(e: unknown): boolean {
  const x = e as { code?: string; name?: string; Code?: string; $metadata?: { httpStatusCode?: number } } | null;
  return x?.code === "ENOENT" || x?.name === "NoSuchKey" || x?.name === "NotFound" || x?.Code === "NoSuchKey" || x?.$metadata?.httpStatusCode === 404;
}

/** El PDF preparado de la sesión; si ya no está (una preparación más nueva lo reemplazó), 409 document_changed. */
async function getPreparedBlob(blobs: BlobStore, key: string): Promise<Uint8Array> {
  try {
    return await blobs.get(key);
  } catch (e) {
    if (isMissingBlob(e)) throw conflict("document_changed", "El documento se volvió a preparar: firmá de nuevo");
    throw e;
  }
}

/**
 * Barrido: preparados reemplazados (pasado el margen), PDF de trabajo de sobres cerrados y PDF preparados de códigos
 * que vencieron sin usarse (o de sesiones ya cerradas que todavía los referencian). De a `limit` por pasada. Devuelve
 * cuántos borró.
 */
export async function sweepCertsignPrepared(db: Db, blobs: BlobStore, limit = 200): Promise<number> {
  // Preparados reemplazados por otra preparación de la misma sesión, pasado el margen.
  const stale = await db.query<{ storage_key: string }>(
    `SELECT storage_key FROM certsign_stale_blobs WHERE superseded_at < now() - make_interval(secs => $1) ORDER BY superseded_at LIMIT $2`,
    [STALE_PREPARED_GRACE_MS / 1000, limit],
  );
  let removed = 0;
  for (const x of stale) {
    try {
      await blobs.delete(x.storage_key);
      await db.query(`DELETE FROM certsign_stale_blobs WHERE storage_key = $1`, [x.storage_key]);
      removed++;
    } catch {
      /* se reintenta en la próxima pasada */
    }
  }
  // PDF de trabajo de sobres anulados o vencidos cuyo borrado falló en su momento: sin esto quedaban hasta la purga por
  // retención, que no corre en organizaciones sin retention_days.
  const closed = await db.query<{ envelope_id: string }>(
    `SELECT c.envelope_id FROM envelope_certsign c JOIN envelopes e ON e.id = c.envelope_id
      WHERE e.status IN ('voided','expired','declined') ORDER BY c.updated_at LIMIT $1`,
    [limit],
  );
  for (const x of closed) if (await discardCertsignFiles(db, blobs, x.envelope_id).catch(() => false)) removed++;
  return removed + (await sweepSessionPrepared(db, blobs, limit));
}

async function sweepSessionPrepared(db: Db, blobs: BlobStore, limit: number): Promise<number> {
  const rows = await db.query<{ id: string; prepared_key: string }>(
    `SELECT id, prepared_key FROM certsign_sessions
      WHERE prepared_key IS NOT NULL AND (status IN ('expired','failed','completed') OR expires_at < now())
      ORDER BY expires_at LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const x of rows) {
    try {
      await blobs.delete(x.prepared_key);
      const upd = await db.query(
        `UPDATE certsign_sessions SET prepared_key = NULL, status = CASE WHEN status IN ('created','prepared') THEN 'expired' ELSE status END
          WHERE id = $1 AND prepared_key = $2 RETURNING id`,
        [x.id, x.prepared_key],
      );
      n += upd.length;
    } catch {
      /* se reintenta en la próxima pasada */
    }
  }
  return n;
}

// ───────────────────────────── Worker: PDF de trabajo y sello final ─────────────────────────────

export type CertsignStage =
  | { kind: "none" }
  | { kind: "waiting" }
  | { kind: "seal"; workingPdf: Uint8Array; workingKey: string; completedAt: string; chainHead: string };

/**
 * Se llama en el worker de finalización, con el PDF todavía sin armar.
 * - none: no hay firmantes con certificado → flujo normal.
 * - waiting: se armó el PDF de trabajo (o ya existía) y faltan firmas con certificado → no sellar todavía.
 * - seal: ya firmaron todos con certificado → sellar ESTE PDF (incremental) con fecha de completado `completedAt`.
 */
export async function certsignStage(
  d: { db: Db; blobs: BlobStore; log: { info(o: object, m?: string): void } },
  e: any,
  recips: any[],
  input: FinalizeInput,
): Promise<CertsignStage> {
  const certSigners = recips.filter((r) => r.role === "signer" && r.signature_type === "certificate" && r.status === "signed");
  if (!certSigners.length) return { kind: "none" };
  const row = await d.db.one<any>(`SELECT * FROM envelope_certsign WHERE envelope_id = $1`, [e.id]);
  if (row?.ready)
    return {
      kind: "seal",
      workingPdf: await d.blobs.get(row.working_key),
      workingKey: row.working_key,
      completedAt: new Date(row.completed_at).toISOString(),
      chainHead: row.chain_head,
    };
  if (row) return { kind: "waiting" };

  const working = await renderEnvelopePdf(input);
  const sha = sha256Hex(working);
  const key = `tenants/${e.tenant_id}/envelopes/${e.id}/certsign/${uuidv7()}-working.pdf`;
  await d.blobs.put(key, working, "application/pdf");
  const ordered = [...certSigners].sort(
    (a, b) => a.routing_order - b.routing_order || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id),
  );
  const stored = await d.db
    .tx(async (t) => {
      const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if (cur?.status !== "finalizing") return false;
      if (await t.one(`SELECT 1 FROM envelope_certsign WHERE envelope_id = $1`, [e.id])) return false;
      await t.query(
        `INSERT INTO envelope_certsign (envelope_id, tenant_id, working_key, working_sha256, completed_at, chain_head) VALUES ($1,$2,$3,$4,$5,$6)`,
        [e.id, e.tenant_id, key, sha, input.certificate.completedAt, input.certificate.chainHead],
      );
      for (const [i, r] of ordered.entries()) {
        await t.query(
          `INSERT INTO certificate_signatures (id, tenant_id, envelope_id, recipient_id, position, field_name) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (recipient_id) DO NOTHING`,
          [uuidv7(), e.tenant_id, e.id, r.id, i + 1, `FirmaCertificado${i + 1}`],
        );
      }
      await t.query(`UPDATE envelopes SET status = 'awaiting_certificates', updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [
        e.id,
      ]);
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "envelope.awaiting_certificates",
        actor: SYSTEM,
        data: { workingSha256: sha, signers: ordered.map((r, i) => ({ recipientId: r.id, name: r.name, position: i + 1 })) },
      });
      await enqueue(
        t,
        "notify",
        { kind: "certificate_request", envelopeId: e.id, recipientId: ordered[0].id, tenantId: e.tenant_id },
        { dedupeKey: `certificate_request:${ordered[0].id}` },
      );
      return true;
    })
    .catch(async (err) => {
      await d.blobs.delete(key).catch(() => {});
      throw err;
    });
  // Otra corrida ya armó el PDF de trabajo (o el sobre cambió de estado): este no lo referencia nada.
  if (!stored) await d.blobs.delete(key).catch(() => {});
  d.log.info({ envelopeId: e.id, signers: ordered.length }, "sobre esperando firmas con certificado");
  return { kind: "waiting" };
}

// ───────────────────────────── Sesión del firmante ─────────────────────────────

async function currentPending(db: Db, envelopeId: string) {
  return db.one<any>(`SELECT * FROM certificate_signatures WHERE envelope_id = $1 AND status = 'pending' ORDER BY position LIMIT 1`, [envelopeId]);
}

/** Bloque `certificateSigning` de la sesión del firmante (null si firma solo electrónicamente). */
export async function certificateStepFor(db: Db, r: any, e: any): Promise<SigningCertificateStep | null> {
  if (r.signature_type !== "certificate") return null;
  const requirements = normalizeRequirements(r.certificate_requirements, Boolean(r.id_document_number));
  const rows = await db.query<any>(`SELECT * FROM certificate_signatures WHERE envelope_id = $1 ORDER BY position`, [e.id]);
  const mine = rows.find((x) => x.recipient_id === r.id);
  const pending = rows.find((x) => x.status === "pending");
  const signedCount = rows.filter((x) => x.status === "signed").length;
  const status: SigningCertificateStep["status"] =
    mine?.status === "signed" ? "signed" : e.status === "awaiting_certificates" && pending?.recipient_id === r.id ? "your_turn" : "waiting";
  return {
    status,
    position: mine?.position ?? 0,
    total: rows.length,
    signedCount,
    requirements,
    certificate:
      mine?.status === "signed"
        ? {
            subject: mine.subject,
            issuer: mine.issuer,
            commonName: mine.common_name,
            serialNumber: mine.serial_number,
            notBefore: iso(mine.not_before)!,
            notAfter: iso(mine.not_after)!,
            sha256: mine.cert_sha256,
            trusted: Boolean(mine.trusted),
          }
        : null,
  };
}

function newCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

const codeHash = (code: string) => sha256Hex(`certsign:${code.toUpperCase().replace(/[^A-Z0-9]/g, "")}`);

async function sessionByCode(db: Db, code: string) {
  if (!/^[A-Za-z0-9-]{8,20}$/.test(code)) throw notFound("Código");
  const s = await db.one<any>(`SELECT * FROM certsign_sessions WHERE code_hash = $1`, [codeHash(code)]);
  if (!s) throw notFound("Código");
  if (s.status === "completed") throw new AppError(410, "code_used", "Este código ya se usó");
  if (s.status === "expired" || new Date(s.expires_at) < new Date())
    throw new AppError(410, "code_expired", "El código venció: generá uno nuevo desde el link de firma");
  if (s.status === "failed") throw new AppError(410, "code_failed", "El código quedó inválido: generá uno nuevo desde el link de firma");
  return s;
}

/** El firmante sigue siendo el de turno y el PDF no cambió desde que se generó el código. */
async function assertStillCurrent(db: Db, s: any) {
  const e = await db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [s.envelope_id]);
  if (!e || e.status !== "awaiting_certificates" || pastExpiry(e))
    throw new AppError(410, "envelope_closed", "El sobre ya no espera firmas con certificado");
  const pending = await currentPending(db, e.id);
  if (pending?.recipient_id !== s.recipient_id) throw conflict("not_your_turn", "No es el turno de este firmante");
  const cs = await db.one<any>(`SELECT * FROM envelope_certsign WHERE envelope_id = $1`, [e.id]);
  if (!cs || cs.working_sha256 !== s.working_sha256) throw conflict("document_changed", "El documento cambió: generá un código nuevo");
  return { e, cs, pending };
}

function parseChain(chain: string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const c of chain) {
    if (c.includes("BEGIN CERTIFICATE")) out.push(...pemToDerList(c));
    else {
      const b = Buffer.from(c.replace(/\s+/g, ""), "base64");
      if (b.length < 100) throw badRequest("invalid_certificate", "Certificado ilegible");
      out.push(new Uint8Array(b));
    }
  }
  if (!out.length) throw badRequest("invalid_certificate", "Falta el certificado");
  return out;
}

/**
 * Revocación del certificado del firmante y de las intermedias (OCSP y, si no hay respuesta concluyente, CRL), con las
 * URLs del propio certificado vía guardedFetch (SSRF). Decisión: se rechaza solo si alguno está REVOCADO; si el
 * respondedor no contesta o no hay URLs, la firma sigue y la evidencia queda con "not_checked" (y una advertencia),
 * para no bloquear firmas por una caída de la CA. La raíz (autofirmada) no se consulta.
 */
export interface CertsignRevocation {
  status: "good" | "revoked" | "not_checked";
  /** Fuente de la respuesta para el certificado del firmante. */
  source: "ocsp" | "crl" | null;
  /** Qué certificado de la cadena está revocado (si alguno). */
  revokedSubject?: string;
  checkedAt: string;
}

const REVOCATION_DEADLINE_MS = 20_000;

export async function checkChainRevocation(chainDer: Uint8Array[], fetcher = guardedFetch): Promise<CertsignRevocation> {
  const checkedAt = new Date();
  const run = async (): Promise<CertsignRevocation> => {
    const certs = chainDer.map(parseCert);
    if (certs.length < 2) return { status: "not_checked", source: null, checkedAt: checkedAt.toISOString() };
    let leafStatus: CertsignRevocation["status"] = "not_checked";
    let leafSource: CertsignRevocation["source"] = null;
    let allGood = true;
    for (let i = 0; i < certs.length - 1; i++) {
      const cert = certs[i];
      const issuer = certs[i + 1];
      let st: "good" | "revoked" | null = null;
      let src: "ocsp" | "crl" | null = null;
      const ocsp = await fetchOcsp(cert, issuer, fetcher);
      const fromOcsp = ocsp ? await statusFromOcsp(ocsp, cert, issuer, checkedAt) : null;
      if (fromOcsp && fromOcsp.status !== "unknown") {
        st = fromOcsp.status;
        src = "ocsp";
      } else {
        const crl = await fetchCrl(cert, fetcher);
        const fromCrl = crl ? await statusFromCrl(crl, cert, issuer, checkedAt) : null;
        if (fromCrl && fromCrl.status !== "unknown") {
          st = fromCrl.status;
          src = "crl";
        }
      }
      if (st === "revoked") {
        const cn = commonName(cert.subject);
        return { status: "revoked", source: i === 0 ? src : leafSource, revokedSubject: cn ?? undefined, checkedAt: checkedAt.toISOString() };
      }
      if (st !== "good") allGood = false;
      if (i === 0) {
        leafStatus = st === "good" ? "good" : "not_checked";
        leafSource = src;
      }
    }
    return { status: allGood ? leafStatus : "not_checked", source: leafSource, checkedAt: checkedAt.toISOString() };
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<CertsignRevocation>((res) => {
    timer = setTimeout(() => res({ status: "not_checked", source: null, checkedAt: checkedAt.toISOString() }), REVOCATION_DEADLINE_MS);
  });
  try {
    return await Promise.race([
      run().catch(() => ({ status: "not_checked", source: null, checkedAt: checkedAt.toISOString() }) as CertsignRevocation),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function certsignRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const rl = (max: number) => ({ config: { rateLimit: { max, timeWindow: "1 minute" } } });

  // Firmante: código de un solo uso para el Firmador (pasa por las compuertas de OTP / identidad del link).
  app.post<{ Params: { token: string } }>("/v1/signing/:token/certsign/pairing", rl(20), async (req) => {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    if (r.signature_type !== "certificate") throw conflict("not_certificate_signer", "Este destinatario no firma con certificado");
    if (e.status !== "awaiting_certificates") throw conflict("not_ready", "Todavía no es momento de firmar con certificado");
    const pending = await currentPending(s.db, e.id);
    if (pending?.recipient_id !== r.id) throw conflict("not_your_turn", "Todavía no es tu turno de firmar con certificado");
    const cs = await s.db.one<any>(`SELECT * FROM envelope_certsign WHERE envelope_id = $1`, [e.id]);
    const code = newCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const { ip, userAgent } = clientInfo(req);
    const stale = await s.db.tx(async (t) => {
      // Los PDF preparados de los códigos anteriores ya no los usa nada (no tienen fila en `files`): se borran después.
      const expired = await t.query<{ prepared_key: string | null }>(
        `UPDATE certsign_sessions SET status = 'expired' WHERE recipient_id = $1 AND status IN ('created','prepared') RETURNING prepared_key`,
        [r.id],
      );
      await t.query(
        `INSERT INTO certsign_sessions (id, code_hash, tenant_id, envelope_id, recipient_id, working_sha256, expires_at, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), codeHash(code), e.tenant_id, e.id, r.id, cs.working_sha256, expiresAt.toISOString(), ip, userAgent],
      );
      return expired.map((x) => x.prepared_key).filter((k): k is string => Boolean(k));
    });
    await deleteBlobsQuietly(s.blobs, stale);
    const apiBase = await envelopeBaseUrl(s.db, e.tenant_id, e.id);
    const res: CertsignPairing = {
      code,
      apiBase,
      deepLink: `calasign-firmador://sign?api=${encodeURIComponent(apiBase)}&code=${encodeURIComponent(code)}`,
      expiresAt: expiresAt.toISOString(),
    };
    return res;
  });

  // Firmador: datos de la sesión.
  app.get<{ Params: { code: string } }>("/v1/certsign/sessions/:code", rl(60), async (req) => {
    const sess = await sessionByCode(s.db, req.params.code);
    const { e, cs } = await assertStillCurrent(s.db, sess);
    const r = await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [sess.recipient_id]);
    const org = await s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [e.tenant_id]);
    const pages = await s.db.one<any>(`SELECT COALESCE(sum(page_count), 0)::int AS n FROM documents WHERE envelope_id = $1`, [e.id]);
    const info: CertsignSessionInfo = {
      status: sess.status,
      expiresAt: iso(sess.expires_at)!,
      organizationName: org?.name ?? "",
      envelopeSubject: e.subject,
      signerName: r.name,
      idDocument: r.id_document_number ? `${(r.id_document_type ?? "").toUpperCase()} ${r.id_document_number}`.trim() : null,
      documentSha256: cs.working_sha256,
      documentPages: Number(pages?.n ?? 0),
      requirements: normalizeRequirements(r.certificate_requirements, Boolean(r.id_document_number)),
    };
    return info;
  });

  // Firmador: el PDF de trabajo (para que el titular vea lo que firma).
  app.get<{ Params: { code: string } }>("/v1/certsign/sessions/:code/document", rl(30), async (req, reply) => {
    const sess = await sessionByCode(s.db, req.params.code);
    const { cs } = await assertStillCurrent(s.db, sess);
    reply.header("content-type", "application/pdf").header("cache-control", "private, no-store");
    return reply.send(Buffer.from(await s.blobs.get(cs.working_key)));
  });

  // Firmador: certificado elegido → controles → preparación (devuelve el hash a firmar).
  app.post<{ Params: { code: string } }>("/v1/certsign/sessions/:code/certificate", { ...rl(30), bodyLimit: 256 * 1024 }, async (req) => {
    const input = CertsignCertificateInput.parse(req.body);
    const sess = await sessionByCode(s.db, req.params.code);
    const { e, cs, pending } = await assertStillCurrent(s.db, sess);
    const r = await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [sess.recipient_id]);
    const reqs = normalizeRequirements(r.certificate_requirements, Boolean(r.id_document_number));
    // Se pedía que corresponda al documento pero el destinatario no tiene número de documento (sobre creado antes del
    // control al guardar, o desde una plantilla, un reemplazo…): no se traba el sobre; se firma sin ese control
    // (normalizeRequirements ya lo deja en false) y la evidencia registra que no se pudo comparar.
    // Documento indicado por quien delegó (no por el remitente): la evidencia registra la procedencia del número.
    const idMatch = {
      ...(idMatchSkipped(r.certificate_requirements, r.id_document_number) ? { idDocumentMatch: "skipped_missing_id_document" as const } : {}),
      ...(r.certificate_requirements?.idDocumentSource === "delegator" ? { idDocumentSource: "delegator" as const } : {}),
    };
    let chainIn: Uint8Array[];
    try {
      chainIn = parseChain(input.chain);
    } catch (err) {
      throw err instanceof AppError ? err : badRequest("invalid_certificate", "Certificado ilegible");
    }
    let check;
    try {
      check = await checkSigningCertificate(chainIn, {
        allowedIssuers: reqs.allowedIssuers,
        trustAnchors: await trustAnchors(),
        requireTrusted: reqs.requireQualified,
        idDocumentNumber: reqs.matchIdDocument ? r.id_document_number : null,
      });
    } catch (err) {
      throw badRequest("invalid_certificate", `Certificado ilegible: ${(err as Error).message}`);
    }
    // Revocación: solo si pasó los demás controles (evita consultas de red con certificados que igual se rechazan).
    let revocation: CertsignRevocation | null = null;
    if (check.ok) {
      revocation = await checkChainRevocation(check.chainDer);
      if (revocation.status === "revoked") {
        check.errors.push(
          revocation.revokedSubject && revocation.revokedSubject !== check.commonName
            ? `un certificado de la cadena está revocado (${revocation.revokedSubject})`
            : "el certificado está revocado",
        );
        check.ok = false;
      } else if (revocation.status === "not_checked") {
        check.warnings.push("no se pudo verificar si el certificado está revocado (la autoridad certificante no respondió)");
      }
    }
    const actor = recipientActorFromSession(req, r);
    if (!check.ok) {
      await s.db.tx(async (t) => {
        await lockEnvelope(t, e.tenant_id, e.id);
        // Con el sobre bloqueado se vuelve a mirar: entre el control de arriba y acá pasó la consulta de revocación (red);
        // un sobre anulado o vencido mientras tanto no suma el rechazo a su evidencia.
        await assertStillCurrent(t, sess);
        await appendEvent(t, {
          tenantId: e.tenant_id,
          envelopeId: e.id,
          type: "recipient.certificate_rejected",
          actor,
          data: {
            recipientId: r.id,
            subject: check.subject,
            issuer: check.issuer,
            serialNumber: check.serialNumber,
            certSha256: check.sha256,
            errors: check.errors,
            ...(revocation ? { revocation: revocation.status, revocationSource: revocation.source } : {}),
            ...idMatch,
          },
        });
      });
      throw new AppError(422, "certificate_rejected", check.errors.join(". "), { errors: check.errors, warnings: check.warnings });
    }
    const working = await s.blobs.get(cs.working_key);
    let prep;
    try {
      prep = await prepareExternalSignature(working, check.chainDer, {
        fieldName: pending.field_name,
        reason: "Firma con certificado digital",
        name: check.commonName ?? r.name,
        location: "Cloud",
      });
    } catch (err) {
      throw badRequest("certificate_unsupported", (err as Error).message);
    }
    // Un nombre por preparación: volver a mandar el certificado con el mismo código no pisa el PDF que otro pedido de la
    // misma sesión (el Firmador bajando /prepared o firmando) todavía está usando.
    const key = `tenants/${e.tenant_id}/envelopes/${e.id}/certsign/${sess.id}-${uuidv7()}-prepared.pdf`;
    await s.blobs.put(key, prep.preparedPdf, "application/pdf");
    // Solo si la sesión sigue abierta: una firma concurrente ya pudo completarla (o un código nuevo, vencerla).
    const replaced = await s.db
      .tx(async (t) => {
        const cur = await t.one<{ status: string; prepared_key: string | null }>(
          `SELECT status, prepared_key FROM certsign_sessions WHERE id = $1 FOR UPDATE`,
          [sess.id],
        );
        if (!cur || !["created", "prepared"].includes(cur.status)) return null;
        await t.query(
          `UPDATE certsign_sessions SET status = 'prepared', prepared_key = $2, byte_range = $3, signed_attrs = $4, chain_der = $5,
             signature_algorithm = $6, named_curve = $7, cert_check = $8 WHERE id = $1`,
          [
            sess.id,
            key,
            JSON.stringify(prep.byteRange),
            Buffer.from(prep.signedAttrsDer).toString("base64"),
            JSON.stringify(check.chainDer.map((d) => Buffer.from(d).toString("base64"))),
            prep.signatureAlgorithm,
            prep.namedCurve,
            JSON.stringify({ ...check, chainDer: undefined, revocation, ...idMatch }),
          ],
        );
        // El preparado anterior de esta misma sesión ya no es el vigente (una firma sobre él se rechaza: ver abajo), pero
        // el Firmador puede estar bajándolo todavía: lo borra el barrido pasado un margen (STALE_PREPARED_GRACE_MS).
        if (cur.prepared_key)
          await t.query(`INSERT INTO certsign_stale_blobs (storage_key, tenant_id, envelope_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
            cur.prepared_key,
            e.tenant_id,
            e.id,
          ]);
        return { previous: cur.prepared_key };
      })
      .catch(async (err) => {
        await s.blobs.delete(key).catch(() => {});
        throw err;
      });
    if (!replaced) {
      // La sesión ya se completó o venció: el PDF recién preparado no lo referencia nada.
      await s.blobs.delete(key).catch(() => {});
      throw new AppError(410, "code_used", "Este código ya no es válido: generá uno nuevo desde el link de firma");
    }
    const res: CertsignPrepared = {
      digestToSign: Buffer.from(prep.digestToSign).toString("base64"),
      dataToSign: Buffer.from(prep.signedAttrsDer).toString("base64"),
      signatureAlgorithm: prep.signatureAlgorithm,
      namedCurve: prep.namedCurve,
      certificate: {
        subject: check.subject,
        issuer: check.issuer,
        commonName: check.commonName,
        serialNumber: check.serialNumber,
        notBefore: check.notBefore,
        notAfter: check.notAfter,
        sha256: check.sha256,
        trusted: check.trusted,
      },
      warnings: check.warnings,
    };
    return res;
  });

  // Firmador: el PDF preparado (con el espacio de la firma y el ByteRange). El Firmador recalcula el hash del
  // documento sobre estos bytes y verifica que la revisión anterior sea idéntica al PDF de trabajo anunciado: así no
  // firma atributos que no correspondan al documento que el titular puede ver.
  app.get<{ Params: { code: string } }>("/v1/certsign/sessions/:code/prepared", rl(30), async (req, reply) => {
    const sess = await sessionByCode(s.db, req.params.code);
    if (sess.status !== "prepared" || !sess.prepared_key) throw conflict("not_prepared", "Primero hay que enviar el certificado");
    await assertStillCurrent(s.db, sess);
    const pdf = await getPreparedBlob(s.blobs, sess.prepared_key);
    reply.header("content-type", "application/pdf").header("cache-control", "private, no-store");
    return reply.send(Buffer.from(pdf));
  });

  // Firmador: firma del hash → CMS + inserción incremental → avance.
  app.post<{ Params: { code: string } }>("/v1/certsign/sessions/:code/signature", rl(30), async (req) => {
    const input = CertsignSignatureInput.parse(req.body);
    const sess = await sessionByCode(s.db, req.params.code);
    if (sess.status !== "prepared") throw conflict("not_prepared", "Primero hay que enviar el certificado");
    await assertStillCurrent(s.db, sess);
    const r = await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [sess.recipient_id]);
    const chainDer = (sess.chain_der as string[]).map((b) => new Uint8Array(Buffer.from(b, "base64")));
    const prepared = {
      preparedPdf: await getPreparedBlob(s.blobs, sess.prepared_key),
      byteRange: sess.byte_range as [number, number, number, number],
      signedAttrsDer: new Uint8Array(Buffer.from(sess.signed_attrs, "base64")),
      signatureAlgorithm: sess.signature_algorithm,
      namedCurve: sess.named_curve,
    };
    const signature = new Uint8Array(Buffer.from(input.signature, "base64"));
    let pdf: Uint8Array;
    let timestamped = Boolean(config.seal.tsaUrl);
    try {
      pdf = await completeExternalSignature(prepared, chainDer, signature, { tsaUrl: config.seal.tsaUrl });
    } catch (err) {
      const msg = (err as Error).message;
      if (/no corresponde/.test(msg)) throw new AppError(422, "signature_invalid", "La firma no corresponde al certificado o al documento");
      if (!config.seal.tsaUrl || config.seal.tsaRequired || /espacio reservado/.test(msg)) throw badRequest("signature_failed", msg);
      timestamped = false;
      req.log.warn({ err: msg }, "TSA no disponible: firma con certificado sin sello de tiempo");
      pdf = await completeExternalSignature(prepared, chainDer, signature, { tsaUrl: null });
    }
    // Control final: la firma nueva y las anteriores siguen íntegras.
    const report = await validatePdf(pdf, { trustAnchors: await trustAnchors() });
    if (!report.signatures.length || !report.signatures.every((x) => x.integrity.valid))
      throw badRequest("signature_failed", "El PDF firmado no verifica");
    const check = sess.cert_check as any;
    const sha = sha256Hex(pdf);
    const key = `tenants/${sess.tenant_id}/envelopes/${sess.envelope_id}/certsign/${uuidv7()}-working.pdf`;
    await s.blobs.put(key, pdf, "application/pdf");
    const actor = recipientActorFromSession(req, r);
    let envelopeStatus = "awaiting_certificates";
    let superseded: string[] = [];
    await s.db
      .tx(async (t) => {
        const e = await lockEnvelope(t, sess.tenant_id, sess.envelope_id);
        const cur = await t.one<any>(`SELECT status, prepared_key FROM certsign_sessions WHERE id = $1 FOR UPDATE`, [sess.id]);
        if (cur?.status !== "prepared") throw new AppError(410, "code_used", "Este código ya se usó");
        // Control optimista: si el certificado se volvió a mandar mientras tanto (preparación nueva), esta firma es de los
        // atributos anteriores y el PDF que se armó sale de un preparado que ya no es el vigente.
        if (cur.prepared_key !== sess.prepared_key) throw conflict("document_changed", "El documento se volvió a preparar: firmá de nuevo");
        const { pending, cs: prev } = await assertStillCurrent(t, sess);
        // El PDF de trabajo anterior y el preparado de esta sesión ya no los usa nada (ninguno tiene fila en `files`,
        // así que la retención no los ve): se borran después de confirmar.
        superseded = [prev.working_key, sess.prepared_key].filter(Boolean);
        await t.query(`UPDATE envelope_certsign SET working_key = $2, working_sha256 = $3, updated_at = now() WHERE envelope_id = $1`, [
          e.id,
          key,
          sha,
        ]);
        await t.query(
          `UPDATE certificate_signatures SET status = 'signed', subject = $2, issuer = $3, common_name = $4, serial_number = $5, not_before = $6,
           not_after = $7, cert_sha256 = $8, trusted = $9, identity_source = $10, signed_at = now(), signed_pdf_sha256 = $11 WHERE id = $1`,
          [
            pending.id,
            check.subject,
            check.issuer,
            check.commonName,
            check.serialNumber,
            check.notBefore,
            check.notAfter,
            check.sha256,
            Boolean(check.trusted),
            check.identityMatch?.source ?? null,
            sha,
          ],
        );
        await t.query(`UPDATE certsign_sessions SET status = 'completed', completed_at = now(), prepared_key = NULL WHERE id = $1`, [sess.id]);
        await appendEvent(t, {
          tenantId: e.tenant_id,
          envelopeId: e.id,
          type: "recipient.certificate_signed",
          actor,
          data: {
            recipientId: r.id,
            position: pending.position,
            fieldName: pending.field_name,
            subject: check.subject,
            issuer: check.issuer,
            serialNumber: check.serialNumber,
            notBefore: check.notBefore,
            notAfter: check.notAfter,
            certSha256: check.sha256,
            trusted: Boolean(check.trusted),
            identityMatch: check.identityMatch?.source ?? null,
            // Se pedía corresponder al documento pero no había documento con qué comparar: el control no se aplicó.
            ...(check.idDocumentMatch ? { idDocumentMatch: check.idDocumentMatch } : {}),
            // El número de documento lo indicó quien delegó la firma.
            ...(check.idDocumentSource ? { idDocumentSource: check.idDocumentSource } : {}),
            // Estado de revocación al momento de preparar la firma ("not_checked" si la CA no respondió).
            revocation: check.revocation?.status ?? "not_checked",
            revocationSource: check.revocation?.source ?? null,
            revocationCheckedAt: check.revocation?.checkedAt ?? null,
            signatureAlgorithm: sess.signature_algorithm,
            timestamped,
            signedPdfSha256: sha,
          },
        });
        const next = await currentPending(t, e.id);
        if (next) {
          await enqueue(
            t,
            "notify",
            { kind: "certificate_request", envelopeId: e.id, recipientId: next.recipient_id, tenantId: e.tenant_id },
            { dedupeKey: `certificate_request:${next.recipient_id}` },
          );
        } else {
          await t.query(`UPDATE envelope_certsign SET ready = true, updated_at = now() WHERE envelope_id = $1`, [e.id]);
          await t.query(`UPDATE envelopes SET status = 'finalizing', updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [e.id]);
          await appendEvent(t, {
            tenantId: e.tenant_id,
            envelopeId: e.id,
            type: "envelope.finalizing",
            actor: SYSTEM,
            data: { afterCertificateSignatures: true },
          });
          await enqueue(t, "finalize", { envelopeId: e.id, tenantId: e.tenant_id }, { dedupeKey: `finalize-certsign:${e.id}` });
          envelopeStatus = "finalizing";
        }
      })
      .catch(async (err) => {
        // El PDF firmado ya subido no lo referencia nada si la transacción no se confirmó.
        await s.blobs.delete(key).catch(() => {});
        throw err;
      });
    await deleteBlobsQuietly(s.blobs, superseded);
    const res: CertsignResult = { status: "completed", signedPdfSha256: sha, envelopeStatus };
    return res;
  });

  // Remitente: progreso de las firmas con certificado.
  app.get<{ Params: { id: string } }>("/v1/envelopes/:id/certificate-signatures", { preHandler: auth }, async (req) => {
    const e = await s.db.one<any>(`SELECT id FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth!.tenantId]);
    if (!e) throw notFound("Sobre");
    const rows = await s.db.query<any>(
      `SELECT c.*, r.name FROM certificate_signatures c JOIN recipients r ON r.id = c.recipient_id WHERE c.envelope_id = $1 ORDER BY c.position`,
      [e.id],
    );
    const res: EnvelopeCertificateProgress = {
      signers: rows.map((x) => ({
        recipientId: x.recipient_id,
        name: x.name,
        position: x.position,
        status: x.status,
        commonName: x.common_name,
        issuer: x.issuer,
        serialNumber: x.serial_number,
        signedAt: iso(x.signed_at),
      })),
    };
    return res;
  });

  // Descargas del Firmador CalaSign (si hay binarios compilados en FIRMADOR_DIST_DIR).
  const distDir = resolve(process.env.FIRMADOR_DIST_DIR ?? resolve(config.repoRoot, "packages/firmador/dist"));
  // El SHA-256 de cada binario (decenas de MB) se calcula una vez por versión del archivo, no en cada pedido.
  const hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  const listDownloads = (): FirmadorDownload[] => {
    if (!existsSync(distDir)) return [];
    const out: FirmadorDownload[] = [];
    for (const f of readdirSync(distDir)) {
      const m = /^calasign-firmador-(windows-x64|linux-x64|macos-arm64|macos-x64)(\.exe)?$/.exec(f);
      if (!m) continue;
      const p = resolve(distDir, f);
      const st = statSync(p);
      let cached = hashCache.get(f);
      if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
        cached = { size: st.size, mtimeMs: st.mtimeMs, sha256: createHash("sha256").update(readFileSync(p)).digest("hex") };
        hashCache.set(f, cached);
      }
      out.push({
        platform: m[1] as FirmadorDownload["platform"],
        file: f,
        sizeBytes: st.size,
        sha256: cached.sha256,
        url: `/v1/firmador/download/${encodeURIComponent(f)}`,
      });
    }
    return out;
  };
  app.get("/v1/firmador/downloads", async () => ({ items: listDownloads() }));
  app.get<{ Params: { file: string } }>("/v1/firmador/download/:file", rl(20), async (req, reply) => {
    const item = listDownloads().find((x) => x.file === req.params.file);
    if (!item) throw notFound("Archivo");
    reply.header("content-type", "application/octet-stream").header("content-disposition", `attachment; filename="${item.file}"`);
    return reply.send(createReadStream(resolve(distDir, item.file)));
  });
}

function recipientActorFromSession(req: FastifyRequest, r: any): Actor {
  return { ...recipientActor(req, r), label: `${r.name} (Firmador CalaSign)` };
}
