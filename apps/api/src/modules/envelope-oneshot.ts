// POST /v1/envelopes: alta de un sobre, opcionalmente COMPLETO en una sola llamada (documentos, destinatarios, campos
// y el envío), en lugar de las cinco del flujo paso a paso (crear, subir el PDF, destinatarios, campos, enviar).
//
// - JSON: los documentos van en base64 o por URL https pública (descarga con protección SSRF).
// - multipart/form-data: una parte `payload` con el mismo JSON y los PDF como partes de archivo (sin inflarlos en
//   base64). Cada documento cita su parte con `file`; sin `documents`, cada archivo es un documento, en orden.
//
// Es atómico: todo se valida antes de escribir (PDF, referencias, anclas) y se guarda en una sola transacción, junto
// con el envío; si algo falla, no queda ningún sobre a medias y los PDF subidos al almacenamiento se borran. Respeta
// Idempotency-Key (también en multipart: la huella incluye el sha256 de cada archivo). Reutiliza la misma lógica que
// los endpoints paso a paso (normalización del PDF, destinatarios, anclas, campos y envío).
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  CreateEnvelopeRequest,
  ONE_SHOT_MAX_DOCUMENTS,
  PutFieldsInput,
  type CreateEnvelopeResponse,
  type EnvelopeSigningUrl,
} from "@calasign/shared";
import { config } from "../config";
import { appendEvent } from "../infra/evidence";
import { AppError, badRequest } from "../lib/errors";
import { sha256Hex, uuidv7 } from "../lib/util";
import { expandAnchors } from "./anchors";
import type { AuthContext, Services } from "./context";
import { issueSigningUrl } from "./embed";
import {
  idempotent,
  insertPreparedDocument,
  preparePdfDocument,
  replaceFields,
  replaceRecipients,
  sendEnvelope,
  type PreparedPdfDocument,
  assertEnvelopeLogicOrder,
} from "./envelopes";
import { assignFieldIds } from "./logic";
import { loadDetail } from "./mappers";
import { discardBlobsOnFailure } from "./file-cleanup";
import { applyEnvelopeSettings } from "./participants";
import { applyEnvelopeBrand } from "./white-label/routes";
import { enforceEnvelopeQuota } from "./billing/plans";
import { decodePdfBase64, fetchPdf, fileNameFromUrl, maxBase64Length, PdfSourceError } from "./pdf-source";

/** Tope de todos los PDF de un sobre creado en una llamada (cada uno, además, hasta maxUploadBytes). */
const TOTAL_MAX_BYTES = 2 * config.maxUploadBytes;
/** Cuerpo JSON de POST /v1/envelopes: alcanza para un PDF del tamaño máximo en base64 (para más, multipart). */
export const ONE_SHOT_JSON_BODY_LIMIT = maxBase64Length(config.maxUploadBytes) + 2 * 1024 * 1024;
/** Nombre de la parte JSON en multipart/form-data. */
const PAYLOAD_PART = "payload";
/**
 * Tope del JSON del sobre SIN el base64 de los documentos (el tope general de los cuerpos JSON): el bodyLimit de la
 * ruta se agrandó para el PDF en base64, no para que `metadata` (sin tope propio) u otros atributos lleguen a decenas de MB.
 */
const PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;

interface UploadedPart {
  filename: string;
  bytes: Uint8Array;
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** Lee un multipart/form-data: la parte `payload` (JSON) y los archivos, por nombre de parte. */
async function readMultipart(req: FastifyRequest): Promise<{ body: unknown; files: Map<string, UploadedPart> }> {
  let rawJson: string | null = null;
  const files = new Map<string, UploadedPart>();
  let total = 0;
  const parts = req.parts({
    limits: { files: ONE_SHOT_MAX_DOCUMENTS + 1, fileSize: config.maxUploadBytes, fields: 10, fieldSize: 2 * 1024 * 1024 },
  });
  for await (const part of parts) {
    if (part.type === "field") {
      if (part.fieldname !== PAYLOAD_PART) throw badRequest("unknown_part", `Parte "${part.fieldname}" desconocida: el JSON va en la parte "${PAYLOAD_PART}"`);
      if (rawJson !== null) throw badRequest("duplicate_part", `La parte "${PAYLOAD_PART}" está repetida`);
      rawJson = String(part.value ?? "");
      continue;
    }
    const buf = new Uint8Array(await part.toBuffer());
    if (part.file.truncated) throw new AppError(413, "file_too_large", `El archivo "${part.filename}" supera ${mb(config.maxUploadBytes)}`, { limit: "file" });
    // `payload` también puede llegar como archivo (curl -F 'payload=@sobre.json;type=application/json').
    if (part.fieldname === PAYLOAD_PART) {
      if (rawJson !== null) throw badRequest("duplicate_part", `La parte "${PAYLOAD_PART}" está repetida`);
      if (buf.length > PAYLOAD_MAX_BYTES) throw new AppError(413, "payload_too_large", `La parte "${PAYLOAD_PART}" supera ${mb(PAYLOAD_MAX_BYTES)}`);
      rawJson = Buffer.from(buf).toString("utf8");
      continue;
    }
    if (files.has(part.fieldname)) throw badRequest("duplicate_part", `La parte "${part.fieldname}" está repetida`);
    total += buf.length;
    if (total > TOTAL_MAX_BYTES) throw new AppError(413, "file_too_large", `Los documentos suman más de ${mb(TOTAL_MAX_BYTES)}`, { limit: "total" });
    files.set(part.fieldname, { filename: part.filename || `${part.fieldname}.pdf`, bytes: buf });
  }
  if (rawJson === null) throw badRequest("payload_required", `Falta la parte "${PAYLOAD_PART}" con el JSON del sobre`);
  let body: unknown;
  try {
    body = JSON.parse(rawJson);
  } catch {
    throw badRequest("invalid_json", `La parte "${PAYLOAD_PART}" no es JSON válido`);
  }
  return { body, files };
}

export async function createEnvelopeRoute(s: Services, req: FastifyRequest, reply: FastifyReply) {
  const a = req.auth as AuthContext;
  if (req.isMultipart()) {
    const { body, files } = await readMultipart(req);
    const material = JSON.stringify({ body, files: [...files].map(([k, f]) => [k, f.filename, sha256Hex(f.bytes)]) });
    return idempotent(s, req, reply, () => createEnvelope(s, a, body, files), material);
  }
  return idempotent(s, req, reply, () => createEnvelope(s, a, req.body, new Map()));
}

/** Resuelve `recipient`/`document` de un campo (posición, ref o email) a ids. */
function resolveRef<T extends { id: string }>(
  list: T[],
  ref: unknown,
  byKey: (item: T, key: string) => boolean,
  what: string,
  where: string,
): string {
  if (typeof ref === "number") {
    const it = list[ref];
    if (!it) throw badRequest("invalid_field", `${where}: no hay ${what} en la posición ${ref}`);
    return it.id;
  }
  const key = String(ref).trim().toLowerCase();
  const matches = list.filter((x) => byKey(x, key));
  if (matches.length === 0) throw badRequest("invalid_field", `${where}: no hay ${what} "${ref}"`);
  if (matches.length > 1) throw badRequest("invalid_field", `${where}: "${ref}" coincide con más de un ${what}; usá ref`);
  return matches[0].id;
}

async function createEnvelope(
  s: Services,
  a: AuthContext,
  rawBody: unknown,
  files: Map<string, UploadedPart>,
): Promise<{ status: number; body: CreateEnvelopeResponse }> {
  const input = CreateEnvelopeRequest.parse(rawBody);
  const withoutBase64 = JSON.stringify({ ...input, documents: input.documents?.map(({ base64: _b64, ...d }) => d) });
  if (Buffer.byteLength(withoutBase64) > PAYLOAD_MAX_BYTES) {
    throw new AppError(413, "payload_too_large", `El sobre (sin el base64 de los documentos) supera ${mb(PAYLOAD_MAX_BYTES)}`);
  }
  const send = input.send ?? input.status === "sent";
  const id = uuidv7();

  // ── Documentos: se obtienen y normalizan todos antes de guardar nada.
  const docInputs = input.documents ?? [...files.keys()].map((file) => ({ file }) as { file: string; ref?: string; name?: string; base64?: string; url?: string });
  if (docInputs.length > ONE_SHOT_MAX_DOCUMENTS) throw badRequest("too_many_documents", `Hasta ${ONE_SHOT_MAX_DOCUMENTS} documentos por llamada`, { max: ONE_SHOT_MAX_DOCUMENTS });
  const used = new Set<string>();
  const docs: (PreparedPdfDocument & { ref?: string })[] = [];
  let total = 0;
  for (const [i, d] of docInputs.entries()) {
    const where = `documents[${i}]`;
    let bytes: Uint8Array;
    let fallbackName: string | null = null;
    try {
      if (d.base64 !== undefined) bytes = decodePdfBase64(d.base64);
      else if (d.url !== undefined) {
        bytes = await fetchPdf(d.url);
        fallbackName = fileNameFromUrl(d.url);
      } else {
        const part = files.get(d.file!);
        if (!part) throw badRequest("file_part_missing", `${where}: no llegó la parte de archivo "${d.file}" (multipart/form-data)`);
        if (used.has(d.file!)) throw badRequest("duplicate_document", `${where}: la parte "${d.file}" ya se usó en otro documento`);
        used.add(d.file!);
        bytes = part.bytes;
        fallbackName = part.filename;
      }
    } catch (e) {
      if (e instanceof PdfSourceError) {
        if (e.code === "file_too_large") throw new AppError(413, "file_too_large", `${where}: ${e.message}`, { limit: "file" });
        // base64 inválido o contenido que no es PDF: not_pdf, el mismo código que la subida multipart (preparePdfUpload).
        throw badRequest(e.code === "download_failed" || e.code === "invalid_url" ? "document_fetch_failed" : "not_pdf", `${where}: ${e.message}`);
      }
      throw e;
    }
    total += bytes.length;
    if (total > TOTAL_MAX_BYTES) throw new AppError(413, "file_too_large", `Los documentos suman más de ${mb(TOTAL_MAX_BYTES)}`, { limit: "total" });
    let prepared: PreparedPdfDocument;
    try {
      prepared = await preparePdfDocument(a.tenantId, id, bytes, d.name ?? fallbackName ?? `documento-${i + 1}.pdf`);
    } catch (e) {
      if (e instanceof AppError) throw new AppError(e.status, e.code, `${where}: ${e.message}`, e.details);
      throw e;
    }
    docs.push({ ...prepared, ref: d.ref });
  }
  const unused = [...files.keys()].filter((k) => !used.has(k));
  if (input.documents && unused.length) throw badRequest("unused_file_part", `Partes de archivo que no cita ningún documento: ${unused.join(", ")}`);
  const docRefs = docs.map((d) => d.ref).filter(Boolean);
  if (new Set(docRefs).size !== docRefs.length) throw badRequest("duplicate_ref", "Hay documentos con el mismo ref");

  // ── Destinatarios: ids asignados ya, para que los campos los puedan citar.
  const recipients = (input.recipients ?? []).map(({ ref, ...r }) => ({ ...r, id: r.id ?? uuidv7(), ref }));
  const recRefs = recipients.map((r) => r.ref).filter(Boolean);
  if (new Set(recRefs).size !== recRefs.length) throw badRequest("duplicate_ref", "Hay destinatarios con el mismo ref");
  const signers = recipients.filter((r) => r.role === "signer");

  // ── Campos: `recipient`/`document` → recipientId/documentId; después, anclas y la validación de siempre.
  const docsById = docs.map((d) => ({ ...d, id: d.docId }));
  const rawFields = (input.fields ?? []).map((f, i) => {
    const { recipient, document, ...rest } = f as Record<string, unknown> & { recipient?: unknown; document?: unknown };
    const where = `Campo ${i + 1}`;
    const out: Record<string, unknown> = { ...rest };
    if (recipient !== undefined) {
      out.recipientId = resolveRef(recipients, recipient, (r, k) => r.ref?.toLowerCase() === k || r.email === k, "destinatario", where);
    } else if (out.recipientId === undefined) {
      if (signers.length !== 1) throw badRequest("invalid_field", `${where}: indicá recipient (posición, ref o email del destinatario)`);
      out.recipientId = signers[0].id;
    }
    if (document !== undefined) {
      out.documentId = resolveRef(docsById, document, (d, k) => d.ref?.toLowerCase() === k, "documento", where);
    } else if (out.documentId === undefined && !("anchor" in out)) {
      // Con ancla y sin documento, se busca en todos.
      if (docs.length !== 1) throw badRequest("invalid_field", `${where}: indicá document (posición o ref del documento)`);
      out.documentId = docs[0].docId;
    }
    return out;
  });
  if (rawFields.length && docs.length === 0) throw badRequest("invalid_field", "Hay campos pero ningún documento");
  const expanded = await expandAnchors(
    docs.map((d) => ({ id: d.docId, load: async () => d.bytes })),
    { fields: rawFields },
  );
  const fields = PutFieldsInput.parse(expanded).fields;
  assignFieldIds(fields);

  // ── Escritura: los PDF al almacenamiento y todo lo demás en una transacción (con el envío).
  // Cupo del plan antes de subir los PDF (se vuelve a mirar dentro de la transacción, en sendEnvelope): sin cupo no
  // tiene sentido subir hasta 50 MB al almacenamiento para borrarlos enseguida.
  if (send) await enforceEnvelopeQuota(s.db, a.tenantId);
  const tenant = await s.db.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
  const keys = docs.map((d) => d.key);
  const signingUrls: EnvelopeSigningUrl[] = [];
  const write = async () => {
    // allSettled: si una subida falla, las demás terminan antes de borrar (con Promise.all, una que seguía en vuelo
    // terminaba DESPUÉS del borrado y quedaba un PDF huérfano en el almacenamiento).
    const puts = await Promise.allSettled(docs.map((d) => s.blobs.put(d.key, d.bytes, "application/pdf")));
    const failed = puts.find((p): p is PromiseRejectedResult => p.status === "rejected");
    if (failed) throw failed.reason;
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO envelopes (id, tenant_id, created_by, created_via, subject, message, locale, expires_at, metadata, created_by_api_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          a.tenantId,
          a.userId,
          a.apiKeyId ? "api" : "web",
          input.subject,
          input.message ?? null,
          input.locale ?? tenant?.default_locale ?? "es",
          input.expiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
          JSON.stringify(input.metadata ?? {}),
          a.apiKeyId,
        ],
      );
      await applyEnvelopeSettings(t, id, input);
      await applyEnvelopeBrand(t, a.tenantId, id, input.brandId);
      await appendEvent(t, { tenantId: a.tenantId, envelopeId: id, type: "envelope.created", actor: a.actor, data: { subject: input.subject } });
      for (const d of docs) await insertPreparedDocument(t, a.tenantId, a.actor, id, d);
      if (recipients.length) await replaceRecipients(t, a, id, recipients);
      if (fields.length) {
        await replaceFields(t, a.tenantId, id, fields);
        await assertEnvelopeLogicOrder(t, id);
      }
      if (!send) return;
      await sendEnvelope(t, a.tenantId, id, a.actor);
      // Firmantes embebidos a los que ya les toca: su URL de firma va en la respuesta (sin otra llamada).
      const active = await t.query<any>(
        `SELECT id FROM recipients WHERE envelope_id = $1 AND embedded AND status = 'sent' AND role IN ('signer','approver') ORDER BY routing_order, created_at`,
        [id],
      );
      for (const r of active) signingUrls.push({ recipientId: r.id, ...(await issueSigningUrl(t, a, id, r.id, input.embeddedSigning ?? {})) });
    });
  };
  // Si algo falla (también a mitad de la subida), los PDF ya subidos se borran: no los referencia nada.
  await discardBlobsOnFailure(s.blobs, keys, write);
  const loaded = await loadDetail(s.db, a.tenantId, id);
  // hadSignatures por documento (solo en esta respuesta): las firmas previas del archivo se pierden al sanearlo.
  const had = new Map(docs.map((d) => [d.docId, d.hadSignatures]));
  const detail = { ...loaded, documents: loaded.documents.map((d) => ({ ...d, hadSignatures: had.get(d.id) ?? false })) };
  return { status: 201, body: signingUrls.length ? { ...detail, signingUrls } : detail };
}
