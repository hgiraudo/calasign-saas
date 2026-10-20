// Verificación pública: cualquiera sube un PDF y sabe si es exactamente un documento sellado por CalaSign.
// Se busca por SHA-256 del archivo completo; solo se devuelve lo que ya figura en el certificado de finalización.
import type { FastifyInstance } from "fastify";
import type { VerifyResponse } from "@calasign/shared";
import { config } from "../config";
import { PdfReaderBusyError, readCertificateChainHead } from "@calasign/pdf";
import { verifyRows } from "../infra/evidence";
import { AppError, badRequest } from "../lib/errors";
import { iso, sha256Hex } from "../lib/util";
import type { Services } from "./context";
import { brandForEnvelope } from "./white-label/brand";

export async function verifyRoutes(app: FastifyInstance, s: Services) {
  app.post("/v1/verify", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const file = await req.file({ limits: { fileSize: Math.max(config.maxUploadBytes, 40 * 1024 * 1024) } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const bytes = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo");
    const sha256 = sha256Hex(bytes);

    // Versión vigente o una anterior a una renovación de archivo (B-LTA): un PDF descargado antes de renovar sigue
    // siendo un documento auténtico de CalaSign.
    const hit = await s.db.one<any>(
      `SELECT e.id, e.tenant_id, e.brand_id, e.subject, e.completed_at, t.name AS org, (e.signed_file_id = f.id) AS is_latest,
              f.id AS file_id, f.chain_head,
              v.version, v.reason, v.created_at AS version_created_at,
              (SELECT max(version) FROM envelope_signed_versions WHERE envelope_id = e.id) AS latest_version
       FROM files f
       JOIN envelopes e ON e.tenant_id = f.tenant_id
         AND (e.signed_file_id = f.id OR EXISTS (SELECT 1 FROM envelope_signed_versions x WHERE x.envelope_id = e.id AND x.file_id = f.id))
       JOIN tenants t ON t.id = e.tenant_id
       LEFT JOIN envelope_signed_versions v ON v.envelope_id = e.id AND v.file_id = f.id
       WHERE f.sha256 = $1 AND f.kind = 'signed' AND e.status = 'completed'
       ORDER BY (e.signed_file_id = f.id) DESC LIMIT 1`,
      [sha256],
    );
    if (!hit) return { match: false, sha256 } satisfies VerifyResponse;
    const latest = Number(hit.latest_version ?? hit.version ?? 1);
    const number = hit.version != null ? Number(hit.version) : latest;

    const [participants, completed, rows, printed] = await Promise.all([
      s.db.query<any>(
        `SELECT name, role, signed_at FROM recipients
         WHERE envelope_id = $1 AND role IN ('signer','approver') AND status = 'signed' ORDER BY routing_order, signed_at`,
        [hit.id],
      ),
      s.db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.completed' ORDER BY seq DESC LIMIT 1`, [hit.id]),
      s.db.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [hit.id]),
      // El hash final impreso en el certificado de ESTE PDF: es lo que ata la cadena al documento.
      printedChainHead(s, hit.file_id, hit.chain_head, bytes),
    ]);
    const chain = anchorChain(verifyRows(rows), rows, printed, completed?.data?.certificateChainHead ?? null);
    const seal = completed?.data?.seal ?? {};
    const res: VerifyResponse = {
      match: true,
      sha256,
      // Marca blanca: el nombre de la marca del sobre (sub-marca o nombre visible de la organización).
      envelope: { id: hit.id, subject: hit.subject, organizationName: await brandForEnvelope(s.db, hit).then((b) => b.name || hit.org), completedAt: iso(hit.completed_at) },
      participants: participants.map((p) => ({ name: p.name, role: p.role, signedAt: iso(p.signed_at) })),
      seal: { format: seal.format ?? null, provider: seal.provider ?? null, timestamped: /^PAdES-B-(T|LT|LTA)$/.test(seal.format ?? "") },
      chain: { ok: chain.ok, events: rows.length, head: chain.head, ...(chain.reason ? { reason: chain.reason } : {}) },
      version: {
        number,
        latest,
        isLatest: Boolean(hit.is_latest),
        reason: hit.reason === "archive_renewal" ? "archive_renewal" : "completed",
        createdAt: iso(hit.version_created_at),
      },
    };
    return res;
  });
}

/**
 * Hash final impreso en el certificado del PDF sellado. El sha256 ya coincidió con un archivo sellado: si al sellarlo se
 * guardó files.chain_head, es ese (sin parsear el PDF en el hilo principal). Archivos sellados antes de la columna: se
 * lee del PDF (metadatos o texto) una vez y se guarda ('' = el PDF no lo trae).
 */
async function printedChainHead(s: Services, fileId: string, stored: string | null, bytes: Uint8Array): Promise<string | null> {
  if (stored !== null && stored !== undefined) return stored || null;
  const found = await readCertificateChainHead(bytes).catch((err) => {
    if (err instanceof PdfReaderBusyError) throw new AppError(503, "pdf_reader_busy", err.message);
    throw err;
  });
  await s.db.query(`UPDATE files SET chain_head = $2 WHERE id = $1 AND chain_head IS NULL`, [fileId, found?.head ?? ""]).catch(() => undefined);
  return found?.head ?? null;
}

/**
 * La cadena recalculada solo prueba que es coherente consigo misma: quien puede escribir en la base puede reescribir
 * eventos y recalcular todos los hashes. Se ata al PDF sellado: el hash final impreso en su certificado (o, si el PDF
 * no lo trae legible, el que se guardó en envelope.completed) tiene que ser el hash de algún evento de la cadena.
 * Después del certificado puede haber más eventos (descargas, renovaciones de archivo), por eso no se exige que sea
 * el último.
 */
export function anchorChain(
  chain: { ok: boolean; brokenAt: number | null; head: string },
  rows: { hash: string }[],
  printedHead: string | null,
  storedHead: string | null,
): { ok: boolean; head: string; reason?: "chain_broken" | "certificate_head_mismatch" | "certificate_head_missing" } {
  if (!chain.ok) return { ok: false, head: chain.head, reason: "chain_broken" };
  const anchor = printedHead ?? storedHead;
  if (!anchor) return { ok: false, head: chain.head, reason: "certificate_head_missing" };
  // El valor guardado en la base no puede contradecir al impreso en el PDF.
  if (printedHead && storedHead && printedHead !== storedHead) return { ok: false, head: chain.head, reason: "certificate_head_mismatch" };
  if (!rows.some((r) => r.hash === anchor)) return { ok: false, head: chain.head, reason: "certificate_head_mismatch" };
  return { ok: true, head: chain.head };
}
