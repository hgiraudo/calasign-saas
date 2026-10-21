import { purgedOriginal } from "./retention";
import { applyEnvelopeBrand } from "./white-label/routes";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  PutFieldsInput,
  PutRecipientsInput,
  UpdateEnvelopeInput,
  VoidEnvelopeInput,
  type EnvelopeEvent,
  type EnvelopeSummary, RESERVED_METADATA_KEYS, TELEGRAM_ONLY_MESSAGE, telegramOnlyWithoutChat } from "@calasign/shared";
import { InvalidPdfError, preparePdfUpload } from "@calasign/pdf";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import { AppError, assertNotStale, badRequest, conflict, notFound, STALE_GENERIC_MESSAGE } from "../lib/errors";
import { BUMP_UPDATED_AT, encrypt, iso, likeContains, queryList, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { config } from "../config";
import { assertEnvelopeAccess, envelopeVisibilitySql } from "./access";
import { authenticate, type AuthContext, type Services } from "./context";
import { loadDetail, loadDocuments } from "./mappers";
import { expandAnchorFields } from "./anchors";
import { setEmbeddedFlags } from "./embed";
import { applyEnvelopeSettings } from "./participants";
import { checkSenderValue, insertEnvelopeField } from "./fieldvalues";
import { applyInPersonFlags } from "./experience";
import { applyIdentityFlags } from "./identity/kyc";
import { MISSING_ID_DOCUMENT_SQL, applyCertificateFlags, discardCertsignFiles } from "./certsign";
import { downgradeIdMatchSql } from "./certsign-requirements";
import { assignFieldIds, formulaRefs, pruneDanglingConditions, saveFieldLogic } from "./logic";
import { paymentBlocksCompletion } from "./billing/payments";
import { enforceEnvelopeQuota, requireFeature, tenantPlan } from "./billing/plans";
import { providerConfigured } from "./billing/providers";
import { deleteFilesIfUnused, discardBlobsOnFailure } from "./file-cleanup";
import { createEnvelopeRoute, ONE_SHOT_JSON_BODY_LIMIT } from "./envelope-oneshot";
import { envelopeSearchSql } from "./devapi/search";

/** Bloquea el sobre para serializar cambios y eventos. */
/**
 * Vencido aunque el barrido todavía no lo haya pasado a 'expired' (corre cada 30 s, de a tandas, y con el worker
 * caído puede tardar más): firmar, rechazar o adjuntar después de expires_at no vale.
 */
export function pastExpiry(e: { expires_at?: string | Date | null }): boolean {
  return e.expires_at != null && new Date(e.expires_at).getTime() <= Date.now();
}

export async function lockEnvelope(db: Db, tenantId: string, id: string) {
  const e = await db.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tenantId]);
  if (!e) throw notFound("Sobre");
  return e;
}

function requireDraft(e: any) {
  if (e.status !== "draft") throw conflict("not_draft", "Solo se puede modificar un sobre en borrador");
}

async function touch(db: Db, id: string) {
  // Estrictamente creciente (now() es la hora de inicio de la transacción: una que esperó el lock lo hacía retroceder y
  // el control de edición concurrente daba un 409 falso).
  await db.query(`UPDATE envelopes SET updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [id]);
}

/** Destinatarios firmantes del grupo de ruteo actual (el menor routing_order con firmantes pendientes). */
export async function currentSignerGroup(db: Db, envelopeId: string) {
  const pending = await db.query<any>(
    `SELECT * FROM recipients WHERE envelope_id = $1 AND role IN ('signer','approver') AND status NOT IN ('signed','declined','delegated','reassigned')
     ORDER BY routing_order`,
    [envelopeId],
  );
  if (pending.length === 0) return { order: null as number | null, recipients: [] as any[] };
  const order = pending[0].routing_order;
  return { order, recipients: pending.filter((r) => r.routing_order === order) };
}

/**
 * Si al destinatario se le mandan invitaciones, recordatorios y avisos de vencimiento. No a los embebidos (el
 * integrador muestra la ceremonia en su app), a los en persona (firma en el dispositivo del anfitrión) ni a un
 * autorregistrado sin correo validado. El job de notificaciones aplica la misma regla; los recordatorios cuentan solo
 * a quienes la cumplen, así la evidencia no dice que se le recordó a alguien a quien no se le escribió.
 */
export function receivesSignerNotices(r: { embedded?: boolean; auth_method?: string; self_registered?: boolean; authenticated_at?: unknown }) {
  if (r.embedded || r.auth_method === "in_person") return false;
  if (r.self_registered && !(r.auth_method === "otp_email" && r.authenticated_at)) return false;
  return true;
}

/** Genera (si falta) el token del destinatario y lo deja en estado 'sent'. Encola la invitación. */
export async function activateRecipient(db: Db, tenantId: string, envelopeId: string, r: any, kind: "invite" | "completed" = "invite") {
  if (!r.access_token_hash) {
    const token = randomToken();
    await db.query(`UPDATE recipients SET access_token_hash = $2, access_token_enc = $3 WHERE id = $1`, [
      r.id,
      sha256Hex(token),
      encrypt(token),
    ]);
  }
  if (kind === "invite") {
    await db.query(`UPDATE recipients SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'created'`, [r.id]);
  }
  await enqueue(db, "notify", { kind, envelopeId, recipientId: r.id, tenantId }, { dedupeKey: `${kind}:${r.id}` });
}

/** Envía las invitaciones al siguiente grupo o pasa el sobre a finalización si no quedan firmantes. */
export async function advanceRouting(db: Db, tenantId: string, envelopeId: string, actor: Actor) {
  const group = await currentSignerGroup(db, envelopeId);
  if (group.order === null) {
    // Cobro al firmar: el sobre se completa recién con el pago confirmado.
    if (await paymentBlocksCompletion(db, tenantId, envelopeId, actor)) return;
    await db.query(`UPDATE envelopes SET status = 'finalizing', updated_at = ${BUMP_UPDATED_AT} WHERE id = $1`, [envelopeId]);
    await appendEvent(db, { tenantId, envelopeId, type: "envelope.finalizing", actor });
    await enqueue(db, "finalize", { envelopeId, tenantId }, { dedupeKey: `finalize:${envelopeId}` });
    return;
  }
  for (const r of group.recipients) if (r.status === "created") await activateRecipient(db, tenantId, envelopeId, r);
}

// ───────────────────────────── Idempotencia ─────────────────────────────

/**
 * Ejecuta `fn` respetando el encabezado Idempotency-Key. `hashMaterial` reemplaza al cuerpo JSON en la huella del
 * pedido cuando el cuerpo no es JSON (multipart/form-data: la parte JSON y el sha256 de cada archivo).
 */
export async function idempotent<T>(
  s: Services,
  req: FastifyRequest,
  reply: FastifyReply,
  fn: () => Promise<{ status: number; body: T }>,
  hashMaterial?: string,
) {
  let key = req.headers["idempotency-key"] as string | undefined;
  if (!key) {
    const r = await fn();
    reply.code(r.status);
    return r.body;
  }
  if (key.length > 200) throw badRequest("invalid_idempotency_key", "Idempotency-Key demasiado larga");
  const a = req.auth!;
  const tenantId = a.tenantId;
  // La clave vale por credencial, no por organización: dos integraciones de la misma organización que usen la misma
  // clave y el mismo cuerpo (p. ej. el id de un pedido) recibían una la respuesta guardada de la otra; su sobre no se
  // creaba y veía uno que quizá no puede ver. Se guarda con el prefijo de quien llama (key, app OAuth o persona).
  const principal = a.oauth ? `o:${a.oauth.clientId}:${a.userId ?? a.apiKeyId ?? ""}` : a.apiKeyId ? `k:${a.apiKeyId}` : `u:${a.userId ?? ""}`;
  key = `${principal}|${key}`;
  const reqHash = sha256Hex(`${req.method} ${req.url} ${hashMaterial ?? JSON.stringify(req.body ?? null)}`);
  // Se reserva la clave ANTES de ejecutar (status_code 0 = en curso): dos pedidos simultáneos con la misma
  // clave no pueden ejecutarse los dos. Una reserva vieja que quedó en curso (el proceso murió a mitad del
  // pedido) se descarta: si no, esa clave respondería idempotency_in_progress para siempre.
  await s.db.query(
    `DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 AND status_code = 0 AND created_at < now() - interval '10 minutes'`,
    [tenantId, key],
  );
  const reserved = await s.db.query(
    `INSERT INTO idempotency_keys (tenant_id, key, request_hash, status_code, response) VALUES ($1,$2,$3,0,'{}'::jsonb)
     ON CONFLICT DO NOTHING RETURNING key`,
    [tenantId, key, reqHash],
  );
  if (!reserved.length) {
    const prev = await s.db.one<any>(`SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`, [tenantId, key]);
    if (prev && prev.request_hash !== reqHash) throw conflict("idempotency_mismatch", "Idempotency-Key reutilizada con otro pedido");
    if (!prev || prev.status_code === 0) throw conflict("idempotency_in_progress", "Ya hay un pedido en curso con esta Idempotency-Key; reintentá en unos segundos");
    reply.code(prev.status_code);
    reply.header("idempotent-replay", "true");
    return prev.response;
  }
  let r: { status: number; body: T };
  try {
    r = await fn();
  } catch (e) {
    // Falló: se libera la clave para que el cliente pueda reintentar.
    await s.db.query(`DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2 AND status_code = 0`, [tenantId, key]).catch(() => {});
    throw e;
  }
  await s.db.query(`UPDATE idempotency_keys SET status_code = $3, response = $4 WHERE tenant_id = $1 AND key = $2`, [
    tenantId,
    key,
    r.status,
    JSON.stringify(r.body),
  ]);
  reply.code(r.status);
  return r.body;
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function envelopeRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  type P = { Params: { id: string; documentId?: string } };
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  app.get<{ Querystring: { status?: string; q?: string; cursor?: string; limit?: string } }>(
    "/v1/envelopes",
    { preHandler: auth },
    async (req) => {
      const { tenantId } = A(req);
      const rawLimit = Number(req.query.limit ?? 25);
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 25;
      const params: unknown[] = [tenantId];
      let where = `e.tenant_id = $1`;
      where += envelopeVisibilitySql(A(req), params);
      const statuses = queryList(req.query.status);
      if (statuses.length) {
        params.push(statuses);
        where += ` AND e.status = ANY($${params.length})`;
      }
      if (req.query.q) {
        // Sin escapar, "%" o "_" eran comodines: buscar "50%" o "a_b" traía cualquier sobre.
        params.push(likeContains(String(req.query.q)));
        const q = `$${params.length} ESCAPE '\\'`;
        where += ` AND (e.subject ILIKE ${q} OR EXISTS (SELECT 1 FROM recipients r WHERE r.envelope_id = e.id AND (r.name ILIKE ${q} OR r.email ILIKE ${q})))`;
      }
      // Filtros avanzados (fechas, metadata, destinatario, plantilla, origen): devapi/search.ts.
      where += envelopeSearchSql(req.query as Record<string, unknown>, params);
      if (req.query.cursor) {
        // created_at va en microsegundos (Postgres guarda µs; un Date de JS solo ms): con ms, los sobres creados en el
        // mismo milisegundo que el último de la página (p. ej. varios en una misma transacción) se saltaban.
        // Se aceptan también los cursores viejos con fecha ISO.
        const [ts, id] = Buffer.from(req.query.cursor, "base64url").toString().split("|");
        const us = /^\d{1,17}$/.test(ts ?? "") ? ts : ts && !Number.isNaN(Date.parse(ts)) ? String(Date.parse(ts) * 1000) : null;
        if (!us || !/^[0-9a-f-]{36}$/i.test(id ?? "")) throw badRequest("invalid_cursor", "Cursor inválido");
        params.push(us, id);
        where += ` AND (e.created_at, e.id) < ('epoch'::timestamptz + $${params.length - 1}::bigint * interval '1 microsecond', $${params.length}::uuid)`;
      }
      params.push(limit + 1);
      const rows = await s.db.query<any>(
        `SELECT e.*, ((extract(epoch FROM e.created_at) * 1000000)::bigint)::text AS cursor_us FROM envelopes e WHERE ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.id);
      const recips = ids.length
        ? await s.db.query<any>(
            `SELECT envelope_id, name, status, role FROM recipients WHERE envelope_id = ANY($1) ORDER BY routing_order, created_at`,
            [ids],
          )
        : [];
      const items: EnvelopeSummary[] = page.map((e) => ({
        id: e.id,
        subject: e.subject,
        status: e.status,
        createdAt: iso(e.created_at)!,
        sentAt: iso(e.sent_at),
        completedAt: iso(e.completed_at),
        expiresAt: iso(e.expires_at),
        updatedAt: iso(e.updated_at)!,
        metadata: e.metadata ?? {},
        recipients: recips.filter((r) => r.envelope_id === e.id).map((r) => ({ name: r.name, status: r.status, role: r.role })),
      }));
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last ? Buffer.from(`${last.cursor_us}|${last.id}`).toString("base64url") : null;
      return { items, nextCursor };
    },
  );

  // Alta de un sobre. Además del borrador vacío de siempre, acepta el sobre completo en una sola llamada (documentos,
  // destinatarios, campos y el envío), en JSON o multipart/form-data: ver envelope-oneshot.ts.
  // Autenticación en onRequest (antes de leer el cuerpo): con el bodyLimit agrandado para el PDF en base64, cualquiera
  // sin credenciales hacía que el servidor recibiera y parseara hasta ~35 MB de JSON antes de responder 401.
  app.post("/v1/envelopes", { onRequest: auth, bodyLimit: ONE_SHOT_JSON_BODY_LIMIT }, async (req, reply) => createEnvelopeRoute(s, req, reply));

  // canManage: si quien consulta puede modificarlo (anular, corregir, reasignar, compartir); quien lo ve por un grupo,
  // como anfitrión o con envelopes:view_all solo lo ve. La web oculta esas acciones en vez de mostrar un 403.
  app.get<P>("/v1/envelopes/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const d = await loadDetail(s.db, a.tenantId, req.params.id);
    const canManage = await assertEnvelopeAccess(s.db, a, req.params.id, "manage").then(
      () => true,
      () => false,
    );
    return { ...d, canManage };
  });

  app.patch<P>("/v1/envelopes/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateEnvelopeInput.parse(req.body);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
      assertNotStale(req.headers, e.updated_at);
      await t.query(
        `UPDATE envelopes SET subject = COALESCE($2, subject), message = CASE WHEN $3::boolean THEN $4 ELSE message END,
           locale = COALESCE($5, locale), expires_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE expires_at END,
           metadata = COALESCE($8::jsonb, metadata)
         WHERE id = $1`,
        [
          e.id,
          input.subject ?? null,
          input.message !== undefined,
          input.message ?? null,
          input.locale ?? null,
          input.expiresAt !== undefined,
          input.expiresAt ?? null,
          // Las claves del sistema que ya tenía el borrador (plantilla, CRM, acuerdo…) se conservan: el cliente no las
          // puede fijar, pero tampoco borrarlas al reescribir sus metadatos.
          input.metadata ? JSON.stringify({ ...input.metadata, ...pickReservedMetadata(e.metadata) }) : null,
        ],
      );
      await applyEnvelopeSettings(t, e.id, input);
      await applyEnvelopeBrand(t, a.tenantId, e.id, input.brandId);
      await touch(t, e.id);
    });
    return loadDetail(s.db, a.tenantId, req.params.id);
  });

  app.delete<P>("/v1/envelopes/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    let fileIds: string[] = [];
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
      fileIds = (await t.query<any>(`SELECT file_id FROM documents WHERE envelope_id = $1`, [e.id])).map((d) => d.file_id);
      // Los eventos primero, con el sobre todavía en borrador: la base solo deja borrar evidencia de un borrador
      // (migración 0072). Queda constancia en la auditoría de la organización (envelope.deleted, audit.ts).
      (req as FastifyRequest & { auditBefore?: Record<string, unknown> }).auditBefore = { subject: e.subject };
      await t.query(`DELETE FROM envelope_events WHERE envelope_id = $1`, [e.id]);
      // Sin FK al sobre: las entregas de webhooks (con su asunto y firmantes en el payload) se borran a mano.
      await t.query(`DELETE FROM webhook_deliveries WHERE envelope_id = $1`, [e.id]);
      await t.query(`DELETE FROM envelopes WHERE id = $1`, [e.id]);
    });
    // Los PDF del borrador que no usa nadie más (una plantilla, otro sobre) se borran del almacenamiento.
    await deleteFilesIfUnused(s.db, s.blobs, fileIds);
    return reply.code(204).send();
  });

  // ───────── Documentos ─────────

  app.post<P>("/v1/envelopes/:id/documents", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const uploaded = new Uint8Array(await file.toBuffer());
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo", { limit: "file" });
    // Verificar el sobre antes de normalizar el PDF (CPU y un lugar del tope de procesamiento) y de subirlo.
    const pre = await s.db.one<any>(`SELECT status FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!pre) throw notFound("Sobre");
    requireDraft(pre);
    const doc = await preparePdfDocument(a.tenantId, req.params.id, uploaded, file.filename || "documento.pdf");
    await s.blobs.put(doc.key, doc.bytes, "application/pdf");
    // Si el sobre dejó de ser borrador (o se borró) entre el chequeo y acá, el PDF subido no lo referencia nada.
    await discardBlobsOnFailure(s.blobs, [doc.key], () => s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
      await insertPreparedDocument(t, a.tenantId, a.actor, e.id, doc);
      await assertDocumentLimits(t, "envelope", e.id);
      await touch(t, e.id);
      // La revisión con IA contra el playbook era de los documentos anteriores: no queda a la vista como vigente.
      await t.query(`UPDATE envelopes SET ai_review = NULL WHERE id = $1`, [e.id]);
    }));
    const d = (await loadDetail(s.db, a.tenantId, req.params.id)).documents.find((x) => x.id === doc.docId);
    reply.code(201);
    // hadSignatures y formAppearanceMismatch: solo en la respuesta de la subida (avisos del saneamiento del PDF).
    return d && { ...d, hadSignatures: doc.hadSignatures, formAppearanceMismatch: doc.formAppearanceMismatch };
  });

  app.delete<P>("/v1/envelopes/:id/documents/:documentId", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    let fileId: string | null = null;
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
      const d = await t.one<any>(`DELETE FROM documents WHERE id = $1 AND envelope_id = $2 RETURNING id, name, file_id`, [req.params.documentId, e.id]);
      if (!d) throw notFound("Documento");
      fileId = d.file_id;
      await pruneDanglingConditions(t, "fields", e.id);
      await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "document.removed", actor: a.actor, data: { documentId: d.id, name: d.name } });
      await touch(t, e.id);
      // La revisión con IA contra el playbook era de los documentos anteriores: no queda a la vista como vigente.
      await t.query(`UPDATE envelopes SET ai_review = NULL WHERE id = $1`, [e.id]);
    });
    await deleteFilesIfUnused(s.db, s.blobs, [fileId]);
    return reply.code(204).send();
  });

  app.get<P>("/v1/envelopes/:id/documents/:documentId/file", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const d = await s.db.one<any>(
      `SELECT f.storage_key, f.purged_at, d.name, e.status FROM documents d JOIN files f ON f.id = d.file_id JOIN envelopes e ON e.id = d.envelope_id
        WHERE d.id = $1 AND d.envelope_id = $2 AND d.tenant_id = $3`,
      [req.params.documentId, req.params.id, a.tenantId],
    );
    if (!d) throw notFound("Documento");
    // Acá (después de autenticar y de comprobar que el documento es de este sobre y organización), no en un hook previo.
    if (d.purged_at) throw purgedOriginal(d.status);
    reply.header("content-type", "application/pdf").header("cache-control", "private, max-age=300");
    return reply.send(Buffer.from(await s.blobs.get(d.storage_key)));
  });

  // ───────── Destinatarios y campos ─────────

  app.put<P>("/v1/envelopes/:id/recipients", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = PutRecipientsInput.parse(req.body);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
      assertNotStale(req.headers, e.updated_at);
      const before = await envelopeLogicOrderProblems(t, e.id);
      await replaceRecipients(t, a, e.id, input.recipients);
      // Reordenar destinatarios también puede dejar una condición citando a alguien que firma después.
      await assertEnvelopeLogicOrder(t, e.id, before);
      await touch(t, e.id);
    });
    return loadDetail(s.db, a.tenantId, req.params.id);
  });

  app.put<P>("/v1/envelopes/:id/fields", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = PutFieldsInput.parse(await expandAnchorFields(s, a.tenantId, req.params.id, req.body));
    assignFieldIds(input.fields);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
      assertNotStale(req.headers, e.updated_at);
      const before = await envelopeLogicOrderProblems(t, e.id);
      await replaceFields(t, a.tenantId, e.id, input.fields);
      // Al diseñar la lógica (no al enviar: sobres y plantillas ya armadas no dejan de poder enviarse).
      await assertEnvelopeLogicOrder(t, e.id, before);
      await touch(t, e.id);
    });
    return loadDetail(s.db, a.tenantId, req.params.id);
  });

  // ───────── Ciclo de vida ─────────

  app.post<P>("/v1/envelopes/:id/send", { preHandler: auth }, async (req, reply) =>
    idempotent(s, req, reply, async () => {
      const a = A(req);
      await s.db.tx((t) => sendEnvelope(t, a.tenantId, req.params.id, a.actor, req.headers));
      return { status: 200, body: await loadDetail(s.db, a.tenantId, req.params.id) };
    }),
  );

  app.post<P>("/v1/envelopes/:id/void", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = VoidEnvelopeInput.parse(req.body);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "sent" && e.status !== "awaiting_certificates") throw conflict("not_voidable", "Solo se puede anular un sobre enviado y en curso");
      // X-Expected-Updated-At opcional (el MCP lo manda con la versión que el usuario aprobó en la vista previa).
      assertNotStale(req.headers, e.updated_at, STALE_GENERIC_MESSAGE);
      await t.query(`UPDATE envelopes SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [
        e.id,
        input.reason,
      ]);
      await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "envelope.voided", actor: a.actor, data: { reason: input.reason } });
      // También quienes ya firmaron electrónicamente pero tenían pendiente la firma con certificado.
      // Embebidos, en persona y autorregistrados sin correo validado no reciben el aviso (receivesSignerNotices).
      const notified = (
        await t.query<any>(
          `SELECT * FROM recipients r WHERE envelope_id = $1 AND (status IN ('sent','viewed')
             OR EXISTS (SELECT 1 FROM certificate_signatures c WHERE c.recipient_id = r.id AND c.status = 'pending'))`,
          [e.id],
        )
      ).filter(receivesSignerNotices);
      for (const r of notified) await enqueue(t, "notify", { kind: "voided", envelopeId: e.id, recipientId: r.id, tenantId: a.tenantId });
    });
    // Firma con certificado a medias: el PDF de trabajo y los preparados ya no se usan (si un borrado falla, la
    // retención lo reintenta al purgar el sobre).
    await discardCertsignFiles(s.db, s.blobs, req.params.id).catch((err) => req.log.warn({ err: String(err), envelopeId: req.params.id }, "no se pudieron borrar los PDF de la firma con certificado"));
    return loadDetail(s.db, a.tenantId, req.params.id);
  });

  // Reintento manual de una finalización que agotó sus intentos (el sobre quedó en 'finalizing').
  app.post<P>("/v1/envelopes/:id/retry-finalize", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "finalizing") throw conflict("not_finalizing", "El sobre no está esperando la finalización");
      const busy = await t.one(
        `SELECT 1 FROM jobs WHERE queue = 'finalize' AND status IN ('pending','running') AND payload->>'envelopeId' = $1 LIMIT 1`,
        [e.id],
      );
      if (busy) throw conflict("finalize_in_progress", "La finalización ya está en curso");
      await enqueue(t, "finalize", { envelopeId: e.id, tenantId: e.tenant_id }, { dedupeKey: `finalize:${e.id}:retry:${uuidv7()}` });
      await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "envelope.finalize_retried", actor: a.actor });
    });
    reply.code(202);
    return { queued: true };
  });

  app.post<P>("/v1/envelopes/:id/remind", { preHandler: auth }, async (req) => {
    const a = A(req);
    let notified = 0;
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      // X-Expected-Updated-At opcional (el MCP lo manda con la versión que el usuario aprobó en la vista previa).
      assertNotStale(req.headers, e.updated_at, STALE_GENERIC_MESSAGE);
      // Un recordatorio manual cada 10 minutos por sobre: cada uno puede ser un SMS o WhatsApp (con costo) por firmante,
      // y sin esto solo limitaba el rate limit de la ruta.
      const recent = await t.one(
        `SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.reminded' AND actor_type <> 'system' AND occurred_at > now() - interval '10 minutes' LIMIT 1`,
        [e.id],
      );
      if (recent) throw new AppError(429, "reminded_recently", "Ya se mandó un recordatorio hace unos minutos: esperá un poco antes de mandar otro");
      // Tope diario por sobre (y por lo tanto por destinatario): sin él, uno cada 10 minutos eran hasta 144 mensajes por
      // día al mismo firmante.
      const today = await t.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.reminded' AND actor_type <> 'system' AND occurred_at > now() - interval '24 hours'`,
        [e.id],
      );
      if ((today?.n ?? 0) >= config.reminders.manualMaxPerDay) {
        throw new AppError(429, "reminder_daily_limit", `Ya se mandaron ${config.reminders.manualMaxPerDay} recordatorios en las últimas 24 horas: probá mañana`);
      }
      if (e.status === "awaiting_certificates") {
        // Firma con certificado pendiente: se le vuelve a avisar al firmante al que le toca (sin dedupe: es un recordatorio).
        const pending = await t.one<any>(
          `SELECT cs.recipient_id, r.self_registered, r.auth_method, r.authenticated_at
             FROM certificate_signatures cs JOIN recipients r ON r.id = cs.recipient_id
            WHERE cs.envelope_id = $1 AND cs.status = 'pending' ORDER BY cs.position LIMIT 1`,
          [e.id],
        );
        // El pedido de firma con certificado no se le manda a un autorregistrado sin correo validado (ver notify).
        if (pending && !(pending.self_registered && !(pending.auth_method === "otp_email" && pending.authenticated_at))) {
          await enqueue(t, "notify", { kind: "certificate_request", envelopeId: e.id, recipientId: pending.recipient_id, tenantId: a.tenantId });
          notified = 1;
          await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "envelope.reminded", actor: a.actor, data: { recipients: 1, stage: "certificates" } });
        }
        return;
      }
      if (e.status !== "sent") throw conflict("not_in_progress", "El sobre no está en curso");
      const group = await currentSignerGroup(t, e.id);
      for (const r of group.recipients.filter((r) => (r.status === "sent" || r.status === "viewed") && receivesSignerNotices(r))) {
        await enqueue(t, "notify", { kind: "reminder", envelopeId: e.id, recipientId: r.id, tenantId: a.tenantId });
        // El remitente volvió a pedir la firma: el tope de recordatorios automáticos (sin vencimiento) vuelve a contar.
        await t.query(`UPDATE recipients SET auto_reminders_sent = 0 WHERE id = $1`, [r.id]);
        notified++;
      }
      if (notified) await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "envelope.reminded", actor: a.actor, data: { recipients: notified } });
    });
    return { notified };
  });

  app.get<P>("/v1/envelopes/:id/events", { preHandler: auth }, async (req) => {
    const a = A(req);
    const e = await s.db.one(`SELECT 1 FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!e) throw notFound("Sobre");
    const rows = await s.db.query<any>(`SELECT * FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [req.params.id]);
    const items: EnvelopeEvent[] = rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      actorType: r.actor_type,
      actorLabel: r.actor_label,
      ip: r.ip,
      userAgent: r.user_agent,
      data: r.data,
      occurredAt: iso(r.occurred_at)!,
      hash: r.hash,
    }));
    return { items };
  });

  app.get<P>("/v1/envelopes/:id/signed.pdf", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await s.db.one<any>(
      `SELECT e.subject, f.storage_key FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1 AND e.tenant_id = $2 AND e.status = 'completed'`,
      [req.params.id, a.tenantId],
    );
    if (!r) throw notFound("Documento firmado");
    return sendPdf(reply, await s.blobs.get(r.storage_key), r.subject);
  });
}

export function sendPdf(reply: FastifyReply, bytes: Uint8Array, name: string) {
  const safe = name.replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().slice(0, 80) || "documento";
  reply
    .header("content-type", "application/pdf")
    .header("content-disposition", `attachment; filename="${safe.replace(/[^\x20-\x7e]/g, "_")}.pdf"; filename*=UTF-8''${encodeURIComponent(safe)}.pdf`)
    .header("cache-control", "private, no-store");
  return reply.send(Buffer.from(bytes));
}

/**
 * Fórmulas que citan un campo número que ya no está (se borró con su destinatario o su documento, el rol de la
 * plantilla no firma, o una corrección en vuelo lo quitó): se calcularían con 0 y el PDF firmado diría, p. ej.,
 * "Total: 0". PUT fields lo valida; los demás caminos que borran campos, no.
 */
/**
 * Un problema que impide enviar o guardar (envelope_incomplete, logic_order): código estable y parámetros para que el
 * cliente lo traduzca, y el texto en español de siempre (el `message` del error es la unión de estos textos).
 */
export interface Problem {
  code: string;
  params: Record<string, string | number>;
  message: string;
}

/**
 * El error 422 con la lista de problemas: `message` une los textos, `details.problems` es la lista de textos (como siempre:
 * hay clientes que la leen así) y `details.issues` trae cada uno con código y parámetros, para traducirlos.
 */
export function problemsError(code: "envelope_incomplete" | "logic_order", problems: Problem[]): AppError {
  return new AppError(422, code, problems.map((p) => p.message).join(". "), { problems: problems.map((p) => p.message), issues: problems });
}

export function danglingFormulaProblems(fields: { type: string; label: string | null; formula: string | null }[]): Problem[] {
  const numberLabels = new Set(fields.filter((f) => f.type === "number" && f.label).map((f) => String(f.label).trim().toLowerCase()));
  const problems: Problem[] = [];
  for (const f of fields) {
    if (!f.formula) continue;
    let refs: string[] = [];
    try {
      refs = formulaRefs(f.formula);
    } catch {
      /* se valida al guardar */
    }
    const missing = refs.filter((r) => !numberLabels.has(r.trim().toLowerCase()));
    if (missing.length) {
      const refs = missing.map((m) => `{${m}}`).join(", ");
      problems.push({
        code: "formula_missing_ref",
        // Sin nombre, sin params.field: la consola cae al message (no muestra "La fórmula de \"\"…").
        params: f.label ? { field: f.label, refs } : { refs },
        message: `La fórmula de ${f.label ? `"${f.label}"` : "un campo"} cita ${refs}, que ya no está en el sobre`,
      });
    }
  }
  return problems;
}

type ParsedRecipients = ReturnType<typeof PutRecipientsInput.parse>["recipients"];
type ParsedFields = ReturnType<typeof PutFieldsInput.parse>["fields"];

/**
 * Reemplaza los destinatarios de un borrador (ya bloqueado por el llamador) por `recipients`. La usan PUT recipients y
 * POST /v1/envelopes con el sobre completo.
 */
export async function replaceRecipients(t: Db, a: AuthContext, envelopeId: string, recipients: ParsedRecipients) {
  const list = recipients.map((r) => ({ ...r, id: r.id ?? uuidv7() }));
  const ids = list.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw badRequest("duplicate_ids", "Ids de destinatarios repetidos");
  const foreign = await t.query(`SELECT id FROM recipients WHERE id = ANY($1) AND envelope_id <> $2`, [ids, envelopeId]);
  if (foreign.length) throw conflict("id_in_use", "Id de destinatario en uso");
  // Solo Telegram sin telegramChatId (PutRecipientsInput no lo rechaza): vale si el destinatario ya vinculó su Telegram.
  const unlinked = list.flatMap((r, i) => (telegramOnlyWithoutChat(r) ? [{ r, i }] : []));
  if (unlinked.length) {
    // Con el mismo correo y teléfono: si cambiaron, el upsert descarta el chat vinculado (es de la persona anterior).
    const linked = new Map(
      (await t.query<any>(`SELECT id, email, phone FROM recipients WHERE envelope_id = $1 AND id = ANY($2) AND telegram_chat_id IS NOT NULL`, [envelopeId, unlinked.map((x) => x.r.id)])).map((x) => [x.id, x]),
    );
    const bad = unlinked.filter((x) => {
      const row = linked.get(x.r.id);
      return !row || row.email !== (x.r.email ?? null) || row.phone !== (x.r.phone ?? null);
    });
    if (bad.length) {
      throw new AppError(400, "validation_error", bad.map((x) => `recipients.${x.i}: ${TELEGRAM_ONLY_MESSAGE}`).join("; "), bad.map((x) => ({ path: `recipients.${x.i}`, message: TELEGRAM_ONLY_MESSAGE })));
    }
  }
  // Borrar al pagador elimina en cascada el cobro configurado y el sobre salía sin cobrar, sin aviso (sendEnvelope solo
  // ve un cobro que ya no existe). Como en las correcciones: primero se quita o se reasigna el cobro.
  const payer = await t.one<any>(`SELECT r.name FROM envelope_payments p JOIN recipients r ON r.id = p.recipient_id WHERE p.envelope_id = $1 AND NOT (p.recipient_id = ANY($2))`, [
    envelopeId,
    ids,
  ]);
  if (payer) throw conflict("recipient_is_payer", `${payer.name} tiene el cobro del sobre a su cargo: quitá o cambiá el cobro antes de quitarlo`);
  await t.query(`DELETE FROM recipients WHERE envelope_id = $1 AND NOT (id = ANY($2))`, [envelopeId, ids]);
  for (const r of list) {
    await t.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, locale, channels, telegram_chat_id, id_document_type, id_document_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, routing_order = EXCLUDED.routing_order, name = EXCLUDED.name,
         email = EXCLUDED.email, phone = EXCLUDED.phone, locale = EXCLUDED.locale, channels = EXCLUDED.channels,
         -- El chat de Telegram vinculado es de la persona que abrió su link: si cambió el correo o el teléfono, la fila
         -- reutilizada es otra persona y el link del nuevo destinatario no puede ir al chat del anterior.
         telegram_chat_id = CASE WHEN recipients.email IS DISTINCT FROM EXCLUDED.email OR recipients.phone IS DISTINCT FROM EXCLUDED.phone
                                 THEN EXCLUDED.telegram_chat_id ELSE COALESCE(EXCLUDED.telegram_chat_id, recipients.telegram_chat_id) END,
         id_document_type = EXCLUDED.id_document_type, id_document_number = EXCLUDED.id_document_number`,
      [
        r.id,
        a.tenantId,
        envelopeId,
        r.role,
        r.routingOrder,
        r.name,
        r.email ?? null,
        r.phone ?? null,
        r.locale ?? null,
        r.channels,
        r.telegramChatId ?? null,
        r.idDocumentType ?? null,
        r.idDocumentNumber ?? null,
      ],
    );
    await t.query(`UPDATE recipients SET auth_method = $2 WHERE id = $1`, [r.id, r.authMethod ?? "link"]);
  }
  await setEmbeddedFlags(t, envelopeId, list);
  // Un PUT que no manda `embedded` conserva el flag de la base: la regla "embebido sin OTP" se mira sobre lo guardado.
  const otpEmbedded = await t.one<{ name: string }>(
    `SELECT name FROM recipients WHERE envelope_id = $1 AND embedded AND auth_method IN ('otp_email','otp_sms','otp_whatsapp') LIMIT 1`,
    [envelopeId],
  );
  if (otpEmbedded) throw badRequest("validation_error", `${otpEmbedded.name}: un firmante embebido no usa código OTP (lo autentica tu aplicación)`);
  await applyInPersonFlags(t, envelopeId, list, a);
  await applyIdentityFlags(t, envelopeId, list);
  await applyCertificateFlags(t, envelopeId, list);
  // Los campos de un destinatario que pasó a 'cc' ya no aplican.
  await t.query(`DELETE FROM fields f USING recipients r WHERE f.recipient_id = r.id AND r.envelope_id = $1 AND r.role IN ('cc','approver')`, [envelopeId]);
  // Campos borrados (con su destinatario o por el cambio de rol): las condiciones que los citaban se quitan.
  await pruneDanglingConditions(t, "fields", envelopeId);
}

/**
 * Reemplaza los campos de un borrador (ya bloqueado por el llamador) por `fields` (ya validados, con las anclas
 * expandidas y con id). La usan PUT fields y POST /v1/envelopes con el sobre completo.
 */
export async function replaceFields(t: Db, tenantId: string, envelopeId: string, fields: ParsedFields) {
  const docs = new Map((await t.query<any>(`SELECT id, page_count FROM documents WHERE envelope_id = $1`, [envelopeId])).map((d) => [d.id, d]));
  const signers = new Set(
    (await t.query<any>(`SELECT id FROM recipients WHERE envelope_id = $1 AND role = 'signer'`, [envelopeId])).map((r) => r.id),
  );
  await t.query(`DELETE FROM fields WHERE envelope_id = $1`, [envelopeId]);
  for (const [i, f] of fields.entries()) {
    const d = docs.get(f.documentId);
    if (!d) throw badRequest("invalid_field", `Campo ${i + 1}: documento inexistente`);
    if (f.page >= d.page_count) throw badRequest("invalid_field", `Campo ${i + 1}: página fuera de rango`);
    if (!signers.has(f.recipientId)) throw badRequest("invalid_field", `Campo ${i + 1}: el destinatario no es firmante de este sobre`);
    let value: string | null;
    try {
      value = checkSenderValue({ ...f, label: f.label ?? null }, `Campo ${i + 1}`);
    } catch (err) {
      throw badRequest("invalid_field", (err as Error).message);
    }
    await insertEnvelopeField(t, {
      id: f.id ?? uuidv7(),
      tenantId: tenantId,
      envelopeId: envelopeId,
      documentId: f.documentId,
      recipientId: f.recipientId,
      type: f.type,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.required,
      label: f.label ?? null,
      value,
      readOnly: Boolean(f.readOnly && value),
      options: f.options ?? null,
      min: f.min ?? null,
      max: f.max ?? null,
    });
  }
  await saveFieldLogic(t, "fields", fields);
}

/** PDF ya normalizado y listo para guardar como documento de un sobre. */
export interface PreparedPdfDocument {
  docId: string;
  fileId: string;
  key: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
  pages: unknown;
  sha256: string;
  uploadedSha256: string;
  /** El archivo subido traía firmas digitales: el saneamiento las elimina (ni la copia guardada ni el PDF final las conservan). */
  hadSignatures: boolean;
  /** Aviso no bloqueante: alguna apariencia de formulario no se pudo regenerar (NeedAppearances) y se fijó la guardada. */
  formAppearanceMismatch: boolean;
}

/**
 * Normaliza un PDF subido (reescrito por pdf-lib): el visor y el PDF final salen del mismo archivo, así que un PDF
 * "ambiguo" no puede mostrar un contenido y firmar otro. El hash de lo subido queda en la evidencia. No guarda nada.
 */
export async function preparePdfDocument(tenantId: string, envelopeId: string, uploaded: Uint8Array, filename: string): Promise<PreparedPdfDocument> {
  let info, bytes: Uint8Array;
  try {
    ({ info, bytes } = await preparePdfUpload(uploaded));
  } catch (e) {
    if (e instanceof InvalidPdfError) throw badRequest(e.code, e.message);
    throw e;
  }
  const fileId = uuidv7();
  return {
    docId: uuidv7(),
    fileId,
    key: `tenants/${tenantId}/envelopes/${envelopeId}/${fileId}.pdf`,
    name: (filename || "documento.pdf").slice(0, 200),
    bytes,
    pageCount: info.pageCount,
    pages: info.pages,
    sha256: sha256Hex(bytes),
    uploadedSha256: sha256Hex(uploaded),
    hadSignatures: info.hadSignatures,
    formAppearanceMismatch: info.formAppearanceMismatch,
  };
}

/** Registra un PDF ya subido al almacenamiento como el último documento del borrador (bloqueado por el llamador). */
export async function insertPreparedDocument(t: Db, tenantId: string, actor: Actor, envelopeId: string, d: PreparedPdfDocument) {
  const pos = await t.one<any>(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM documents WHERE envelope_id = $1`, [envelopeId]);
  await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',$4,$5)`, [
    d.fileId,
    tenantId,
    d.key,
    d.bytes.length,
    d.sha256,
  ]);
  await t.query(
    `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [d.docId, tenantId, envelopeId, pos.p, d.name, d.fileId, d.pageCount, JSON.stringify(d.pages)],
  );
  await appendEvent(t, {
    tenantId,
    envelopeId,
    type: "document.added",
    actor,
    data: { documentId: d.docId, name: d.name, sha256: d.sha256, uploadedSha256: d.uploadedSha256, pages: d.pageCount, ...(d.hadSignatures ? { hadSignatures: true } : {}) },
  });
}

/**
 * Tamaño máximo de un sobre (o plantilla). El PDF final (worker) y la copia en curso (API) cargan todos los documentos y
 * adjuntos en memoria a la vez: sin tope, un sobre con 40 PDF de 25 MB tumbaba el proceso que atiende a todos.
 */
export const ENVELOPE_LIMITS = { documents: 30, pages: 1000, bytes: 100 * 1024 * 1024, attachmentFields: 20 };

/** Lanza si los documentos de un sobre o plantilla superan ENVELOPE_LIMITS (con el registro ya bloqueado). */
export async function assertDocumentLimits(t: Db, kind: "envelope" | "template", id: string) {
  const r = await t.one<{ n: number; pages: number; bytes: string }>(
    kind === "envelope"
      ? `SELECT count(*)::int AS n, COALESCE(sum(d.page_count), 0)::int AS pages, COALESCE(sum(f.size_bytes), 0)::bigint AS bytes
           FROM documents d JOIN files f ON f.id = d.file_id WHERE d.envelope_id = $1`
      : `SELECT count(*)::int AS n, COALESCE(sum(d.page_count), 0)::int AS pages, COALESCE(sum(f.size_bytes), 0)::bigint AS bytes
           FROM template_documents d JOIN files f ON f.id = d.file_id WHERE d.template_id = $1`,
    [id],
  );
  const L = ENVELOPE_LIMITS;
  if ((r?.n ?? 0) > L.documents) throw badRequest("too_many_documents", `Máximo ${L.documents} documentos`, { max: L.documents });
  if ((r?.pages ?? 0) > L.pages) throw badRequest("too_many_pages", `Máximo ${L.pages} páginas en total`);
  // 413 file_too_large, como un archivo que supera el máximo de subida o el total de POST /v1/envelopes.
  // details.limit "total": la suma de los documentos (un archivo solo que supera el máximo de subida lleva "file").
  if (Number(r?.bytes ?? 0) > L.bytes)
    throw new AppError(413, "file_too_large", `Los documentos superan ${Math.round(L.bytes / 1024 / 1024)} MB en total`, { limit: "total", maxBytes: L.bytes });
}

/**
 * Una condición que cita un campo de OTRO firmante se evalúa cuando completa el dueño del campo condicionado: si el otro
 * firma después (o en el mismo turno), se decide con un valor que todavía no existe y no se vuelve a evaluar (un campo
 * obligatorio quedaba oculto o uno que debía ocultarse se estampaba). Se exige que el campo citado sea fijo (solo
 * lectura) o de alguien que firma antes.
 */
type LogicFields = {
  id: string;
  recipient_id: string;
  label: string | null;
  conditions: unknown;
  read_only?: boolean;
  type?: string;
  formula?: string | null;
}[];
type LogicRecips = { id: string; name: string; routing_order: number }[];

/**
 * Cada condición fuera de orden, con una clave estable (campo citado + destinatario cuyo campo depende de él) y el
 * mensaje legible. Si el campo citado es una fórmula, cuentan los campos que la fórmula cita (también de forma
 * transitiva): un total que depende del monto de alguien que firma después también se decidiría sin ese valor.
 */
function logicOrderIssues(fields: LogicFields, recips: LogicRecips): ({ key: string } & Problem)[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const numberByLabel = new Map(fields.filter((f) => f.type === "number" && f.label).map((f) => [f.label!.trim().toLowerCase(), f]));
  const order = new Map(recips.map((r) => [r.id, r.routing_order]));
  const name = new Map(recips.map((r) => [r.id, r.name]));
  /** Los campos con valor propio de los que sale el valor de `src` (él mismo, o las hojas de su fórmula). */
  const leaves = (src: LogicFields[number], seen = new Set<string>()): LogicFields[number][] => {
    if (seen.has(src.id)) return [];
    seen.add(src.id);
    if (!src.formula) return [src];
    let refs: string[] = [];
    try {
      refs = formulaRefs(src.formula);
    } catch {
      return [];
    }
    return refs.flatMap((r) => {
      const ref = numberByLabel.get(r.trim().toLowerCase());
      return ref ? leaves(ref, seen) : [];
    });
  };
  const out: ({ key: string } & Problem)[] = [];
  for (const f of fields) {
    const conds = Array.isArray(f.conditions) ? (f.conditions as { fieldId: string }[]) : [];
    for (const c of conds) {
      const cited = byId.get(c.fieldId);
      if (!cited) continue;
      for (const src of leaves(cited)) {
        if (src.recipient_id === f.recipient_id || src.read_only) continue;
        if ((order.get(src.recipient_id) ?? 0) >= (order.get(f.recipient_id) ?? 0)) {
          const via = src.id === cited.id ? "" : ` (a través de la fórmula de "${cited.label ?? "?"}")`;
          out.push({
            // Ids estables: el del campo citado por la condición (las condiciones lo referencian, así que se conserva)
            // y los destinatarios. No el del campo dependiente ni el de la hoja de una fórmula (se buscan por etiqueta):
            // un PUT sin ids o por anclas los regenera en cada guardado y el problema previo parecía nuevo.
            key: `${cited.id}|${src.recipient_id}|${f.recipient_id}`,
            code: src.id === cited.id ? "logic_order" : "logic_order_formula",
            params: {
              field: f.label ?? "?",
              recipient: name.get(f.recipient_id) ?? "?",
              source: name.get(src.recipient_id) ?? "?",
              ...(src.id === cited.id ? {} : { formula: cited.label ?? "?" }),
            },
            message: `El campo "${f.label ?? "?"}" de ${name.get(f.recipient_id) ?? "?"} depende de un campo de ${name.get(src.recipient_id) ?? "?"}${via}, que firma después o al mismo tiempo`,
          });
        }
      }
    }
  }
  return out;
}

export function signerWithoutSignature(name: string): Problem {
  return { code: "signer_without_signature", params: { name }, message: `${name} no tiene ningún campo de firma` };
}

export function logicOrderProblems(fields: LogicFields, recips: LogicRecips): string[] {
  return [...new Set(logicOrderIssues(fields, recips).map((i) => i.message))];
}

/**
 * before: las claves (campo citado|destinatario que depende de él) de los problemas que ya había antes del cambio. Solo se rechazan los nuevos:
 * un sobre o plantilla armados antes de esta regla (o un cambio que no toca la lógica, como el correo o el nombre de
 * un destinatario) no quedan bloqueados.
 */
/** Los problemas que no estaban antes (claves de logicOrderKeys), sin repetir el mismo texto. */
export function newLogicOrderProblems(fields: LogicFields, recips: LogicRecips, before: readonly string[] = []): Problem[] {
  const prev = new Set(before);
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const i of logicOrderIssues(fields, recips)) {
    if (prev.has(i.key) || seen.has(i.message)) continue;
    seen.add(i.message);
    out.push({ code: i.code, params: i.params, message: i.message });
  }
  return out;
}

/** Las claves de los problemas de orden (para comparar antes y después de un cambio). */
export function logicOrderKeys(fields: LogicFields, recips: LogicRecips): string[] {
  return logicOrderIssues(fields, recips).map((i) => i.key);
}

export async function assertLogicOrder(fields: LogicFields, recips: LogicRecips, before: readonly string[] = []) {
  const problems = newLogicOrderProblems(fields, recips, before);
  if (problems.length) throw problemsError("logic_order", problems);
}

function pickReservedMetadata(m: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RESERVED_METADATA_KEYS) if (m && k in m) out[k] = m[k];
  return out;
}

const envelopeLogicRows = async (t: Db, envelopeId: string) =>
  [
    await t.query<any>(`SELECT id, recipient_id, label, conditions, read_only, type, formula FROM fields WHERE envelope_id = $1`, [envelopeId]),
    await t.query<any>(`SELECT id, name, routing_order FROM recipients WHERE envelope_id = $1`, [envelopeId]),
  ] as const;

const templateLogicRows = async (t: Db, templateId: string) =>
  [
    await t.query<any>(`SELECT id, role_id AS recipient_id, label, conditions, read_only, type, formula FROM template_fields WHERE template_id = $1`, [templateId]),
    await t.query<any>(`SELECT id, name, routing_order FROM template_roles WHERE template_id = $1`, [templateId]),
  ] as const;

/** Las claves de los problemas de orden que ya tiene un sobre (antes de un cambio: ver assertLogicOrder). */
export async function envelopeLogicOrderProblems(t: Db, envelopeId: string) {
  return logicOrderIssues(...(await envelopeLogicRows(t, envelopeId))).map((i) => i.key);
}

export async function templateLogicOrderProblems(t: Db, templateId: string) {
  return logicOrderIssues(...(await templateLogicRows(t, templateId))).map((i) => i.key);
}

/** El orden de la lógica de un sobre (después de guardar campos o destinatarios, o de crearlo en un paso). */
export async function assertEnvelopeLogicOrder(t: Db, envelopeId: string, before: readonly string[] = []) {
  const [fields, recips] = await envelopeLogicRows(t, envelopeId);
  await assertLogicOrder(fields, recips, before);
}

/** Lo mismo para una plantilla (los roles hacen de destinatarios). */
export async function assertTemplateLogicOrder(t: Db, templateId: string, before: readonly string[] = []) {
  const [fields, recips] = await templateLogicRows(t, templateId);
  await assertLogicOrder(fields, recips, before);
}

/** Valida y envía un borrador (dentro de la transacción del llamador). */
/** `headers`: los del pedido de envío (X-Expected-Updated-At opcional: si el borrador cambió desde que se revisó, 409). */
export async function sendEnvelope(t: Db, tenantId: string, envelopeId: string, actor: Actor, headers?: Record<string, unknown>) {
  const e = await lockEnvelope(t, tenantId, envelopeId);
  // Primero not_draft: si otra pestaña ya lo envió, la consola va al detalle (no a "recargá el borrador").
  requireDraft(e);
  // Se envía lo que se revisó: si otra pestaña u otra persona cambió el borrador mientras tanto, 409 version_changed.
  // El encabezado no entra en el hash de la Idempotency-Key (método, URL y cuerpo): reintentar el mismo envío sigue
  // devolviendo la respuesta guardada.
  if (headers) assertNotStale(headers, e.updated_at);
  await enforceEnvelopeQuota(t, tenantId);
  await assertDocumentLimits(t, "envelope", e.id);
  const docs = await loadDocuments(t, e.id);
  const recips = await t.query<any>(`SELECT * FROM recipients WHERE envelope_id = $1`, [e.id]);
  const fields = await t.query<any>(`SELECT recipient_id, type, label, formula FROM fields WHERE envelope_id = $1`, [e.id]);
  const problems: Problem[] = [];
  if (docs.length === 0) problems.push({ code: "no_documents", params: {}, message: "Agregá al menos un documento" });
  // Cada adjunto puede pesar 10 MB y todos se agregan al PDF final.
  if (fields.filter((f) => f.type === "attachment").length > ENVELOPE_LIMITS.attachmentFields)
    problems.push({
      code: "too_many_attachment_fields",
      params: { max: ENVELOPE_LIMITS.attachmentFields },
      message: `Máximo ${ENVELOPE_LIMITS.attachmentFields} campos de adjunto por sobre`,
    });
  const signers = recips.filter((r) => r.role === "signer");
  if (signers.length === 0 && !recips.some((r) => r.role === "approver"))
    problems.push({ code: "no_signers", params: {}, message: "Agregá al menos un firmante" });
  for (const s1 of signers) {
    // Quien firma con certificado puede no tener firma visual: su firma va en el certificado.
    if (s1.signature_type !== "certificate" && !fields.some((f) => f.recipient_id === s1.id && f.type === "signature"))
      problems.push(signerWithoutSignature(s1.name));
  }
  // Exige que el certificado corresponda a su documento pero no tiene el número cargado. Un sobre creado desde una
  // plantilla (formulario web, envío masivo, CRM, conectores, lowcode…) no lo pidió a mano para esta persona: el control
  // se baja con la marca para la evidencia en vez de trabar el envío. Si el remitente lo pidió a mano, es un problema.
  if (typeof e.metadata?.templateId === "string")
    await t.query(
      `UPDATE recipients SET certificate_requirements = ${downgradeIdMatchSql("certificate_requirements", "id_document_number")}
        WHERE envelope_id = $1 AND ${MISSING_ID_DOCUMENT_SQL}`,
      [e.id],
    );
  for (const m of await t.query<{ name: string }>(`SELECT name FROM recipients WHERE envelope_id = $1 AND ${MISSING_ID_DOCUMENT_SQL} ORDER BY routing_order, name`, [e.id]))
    problems.push({ code: "missing_id_document", params: { name: m.name }, message: `${m.name}: para exigir que el certificado corresponda a su documento hay que cargar el número de documento` });
  if (e.expires_at && new Date(e.expires_at) <= new Date())
    problems.push({ code: "expiry_past", params: {}, message: "La fecha de vencimiento ya pasó" });
  problems.push(...danglingFormulaProblems(fields));
  // El cobro tiene que quedar a cargo de un firmante: si se le cambió el rol, el sobre no podría completarse.
  const pay = await t.one<any>(`SELECT recipient_id, provider FROM envelope_payments WHERE envelope_id = $1`, [e.id]);
  if (pay) {
    // El cobro se configuró con el plan y el proveedor de ese momento: si la organización bajó a un plan sin cobros, o
    // el proveedor ya no está configurado, el sobre no se envía (si no, se cobraba sin el plan o el firmante quedaba
    // trabado con un pago imposible). Cubre todos los caminos de envío, que pasan por acá.
    requireFeature((await tenantPlan(t, tenantId)).plan, "payments", "El cobro al firmar");
    if (!providerConfigured(pay.provider)) {
      throw badRequest("provider_not_configured", `El proveedor de cobro ${pay.provider} no está configurado en este entorno`);
    }
  }
  if (pay && !signers.some((r) => r.id === pay.recipient_id))
    problems.push({ code: "payer_not_signer", params: {}, message: "Quien paga el cobro tiene que ser un firmante" });
  if (problems.length) throw problemsError("envelope_incomplete", problems);

  await t.query(`UPDATE envelopes SET status = 'sent', sent_at = now(), updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [e.id]);
  await appendEvent(t, {
    tenantId: tenantId,
    envelopeId: e.id,
    type: "envelope.sent",
    actor: actor,
    data: {
      documents: docs.map((d) => ({ id: d.id, name: d.name, sha256: d.sha256 })),
      recipients: recips.map((r) => ({ id: r.id, name: r.name, role: r.role, routingOrder: r.routing_order, channels: r.channels })),
    },
  });
  // Todos los destinatarios reciben token ya (los CC lo usan al final para descargar).
  for (const r of recips) {
    if (!r.access_token_hash) {
      const token = randomToken();
      await t.query(`UPDATE recipients SET access_token_hash = $2, access_token_enc = $3 WHERE id = $1`, [r.id, sha256Hex(token), encrypt(token)]);
    }
  }
  await advanceRouting(t, tenantId, e.id, actor);
}
