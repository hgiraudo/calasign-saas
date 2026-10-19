import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CreateEnvelopeInput,
  PutFieldsInput,
  PutRecipientsInput,
  UpdateEnvelopeInput,
  VoidEnvelopeInput,
  type EnvelopeEvent,
  type EnvelopeSummary,
} from "@calasign/shared";
import { InvalidPdfError, preparePdfUpload } from "@calasign/pdf";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { encrypt, iso, queryList, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { config } from "../config";
import { envelopeVisibilitySql } from "./access";
import { authenticate, type AuthContext, type Services } from "./context";
import { loadDetail, loadDocuments } from "./mappers";
import { expandAnchorFields } from "./anchors";
import { setEmbeddedFlags } from "./embed";
import { applyEnvelopeSettings } from "./participants";
import { checkSenderValue, insertEnvelopeField } from "./fieldvalues";
import { applyInPersonFlags } from "./experience";
import { applyIdentityFlags } from "./identity/kyc";
import { applyCertificateFlags } from "./certsign";
import { assignFieldIds, formulaRefs, pruneDanglingConditions, saveFieldLogic } from "./logic";
import { paymentBlocksCompletion } from "./billing/payments";
import { enforceEnvelopeQuota } from "./billing/plans";
import { deleteFilesIfUnused, discardBlobsOnFailure } from "./file-cleanup";
import { envelopeSearchSql } from "./devapi/search";

/** Bloquea el sobre para serializar cambios y eventos. */
export async function lockEnvelope(db: Db, tenantId: string, id: string) {
  const e = await db.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tenantId]);
  if (!e) throw notFound("Sobre");
  return e;
}

function requireDraft(e: any) {
  if (e.status !== "draft") throw conflict("not_draft", "Solo se puede modificar un sobre en borrador");
}

async function touch(db: Db, id: string) {
  await db.query(`UPDATE envelopes SET updated_at = now(), version = version + 1 WHERE id = $1`, [id]);
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
    await db.query(`UPDATE envelopes SET status = 'finalizing', updated_at = now() WHERE id = $1`, [envelopeId]);
    await appendEvent(db, { tenantId, envelopeId, type: "envelope.finalizing", actor });
    await enqueue(db, "finalize", { envelopeId, tenantId }, { dedupeKey: `finalize:${envelopeId}` });
    return;
  }
  for (const r of group.recipients) if (r.status === "created") await activateRecipient(db, tenantId, envelopeId, r);
}

// ───────────────────────────── Idempotencia ─────────────────────────────

async function idempotent<T>(s: Services, req: FastifyRequest, reply: FastifyReply, fn: () => Promise<{ status: number; body: T }>) {
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
  const reqHash = sha256Hex(`${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
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
        params.push(`%${req.query.q}%`);
        where += ` AND (e.subject ILIKE $${params.length} OR EXISTS (SELECT 1 FROM recipients r WHERE r.envelope_id = e.id AND (r.name ILIKE $${params.length} OR r.email ILIKE $${params.length})))`;
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

  app.post("/v1/envelopes", { preHandler: auth }, async (req, reply) =>
    idempotent(s, req, reply, async () => {
      const a = A(req);
      const input = CreateEnvelopeInput.parse(req.body);
      const id = uuidv7();
      const tenant = await s.db.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
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
        await appendEvent(t, { tenantId: a.tenantId, envelopeId: id, type: "envelope.created", actor: a.actor, data: { subject: input.subject } });
      });
      return { status: 201, body: await loadDetail(s.db, a.tenantId, id) };
    }),
  );

  app.get<P>("/v1/envelopes/:id", { preHandler: auth }, async (req) => loadDetail(s.db, A(req).tenantId, req.params.id));

  app.patch<P>("/v1/envelopes/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateEnvelopeInput.parse(req.body);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
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
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      );
      await applyEnvelopeSettings(t, e.id, input);
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
      await t.query(`DELETE FROM envelopes WHERE id = $1`, [e.id]);
      await t.query(`DELETE FROM envelope_events WHERE envelope_id = $1`, [e.id]);
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
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo");
    // Se guarda el PDF normalizado (reescrito por pdf-lib): el visor y el PDF final salen del mismo archivo, así que
    // un PDF "ambiguo" no puede mostrar un contenido y firmar otro. El hash de lo subido queda en la evidencia.
    let info, bytes: Uint8Array;
    try {
      ({ info, bytes } = await preparePdfUpload(uploaded));
    } catch (e) {
      if (e instanceof InvalidPdfError) throw badRequest(e.code, e.message);
      throw e;
    }
    const sha = sha256Hex(bytes);
    const uploadedSha = sha256Hex(uploaded);
    const docId = uuidv7();
    const fileId = uuidv7();
    const key = `tenants/${a.tenantId}/envelopes/${req.params.id}/${fileId}.pdf`;
    // Verificar el sobre antes de subir el archivo.
    const pre = await s.db.one<any>(`SELECT status FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!pre) throw notFound("Sobre");
    requireDraft(pre);
    await s.blobs.put(key, bytes, "application/pdf");
    const name = (file.filename || "documento.pdf").slice(0, 200);
    // Si el sobre dejó de ser borrador (o se borró) entre el chequeo y acá, el PDF subido no lo referencia nada.
    await discardBlobsOnFailure(s.blobs, [key], () => s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      requireDraft(e);
      const pos = await t.one<any>(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM documents WHERE envelope_id = $1`, [e.id]);
      await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',$4,$5)`, [
        fileId,
        a.tenantId,
        key,
        bytes.length,
        sha,
      ]);
      await t.query(
        `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [docId, a.tenantId, e.id, pos.p, name, fileId, info.pageCount, JSON.stringify(info.pages)],
      );
      await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "document.added", actor: a.actor, data: { documentId: docId, name, sha256: sha, uploadedSha256: uploadedSha, pages: info.pageCount } });
      await touch(t, e.id);
    }));
    const d = (await loadDetail(s.db, a.tenantId, req.params.id)).documents.find((x) => x.id === docId);
    reply.code(201);
    return d;
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
    });
    await deleteFilesIfUnused(s.db, s.blobs, [fileId]);
    return reply.code(204).send();
  });

  app.get<P>("/v1/envelopes/:id/documents/:documentId/file", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const d = await s.db.one<any>(
      `SELECT f.storage_key, d.name FROM documents d JOIN files f ON f.id = d.file_id WHERE d.id = $1 AND d.envelope_id = $2 AND d.tenant_id = $3`,
      [req.params.documentId, req.params.id, a.tenantId],
    );
    if (!d) throw notFound("Documento");
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
      const list = input.recipients.map((r) => ({ ...r, id: r.id ?? uuidv7() }));
      const ids = list.map((r) => r.id);
      if (new Set(ids).size !== ids.length) throw badRequest("duplicate_ids", "Ids de destinatarios repetidos");
      const foreign = await t.query(`SELECT id FROM recipients WHERE id = ANY($1) AND envelope_id <> $2`, [ids, e.id]);
      if (foreign.length) throw conflict("id_in_use", "Id de destinatario en uso");
      await t.query(`DELETE FROM recipients WHERE envelope_id = $1 AND NOT (id = ANY($2))`, [e.id, ids]);
      for (const r of list) {
        await t.query(
          `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, locale, channels, telegram_chat_id, id_document_type, id_document_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, routing_order = EXCLUDED.routing_order, name = EXCLUDED.name,
             email = EXCLUDED.email, phone = EXCLUDED.phone, locale = EXCLUDED.locale, channels = EXCLUDED.channels,
             telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, recipients.telegram_chat_id),
             id_document_type = EXCLUDED.id_document_type, id_document_number = EXCLUDED.id_document_number`,
          [
            r.id,
            a.tenantId,
            e.id,
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
      await setEmbeddedFlags(t, e.id, list);
      await applyInPersonFlags(t, e.id, list, a);
      await applyIdentityFlags(t, e.id, list);
      await applyCertificateFlags(t, e.id, list);
      // Los campos de un destinatario que pasó a 'cc' ya no aplican.
      await t.query(`DELETE FROM fields f USING recipients r WHERE f.recipient_id = r.id AND r.envelope_id = $1 AND r.role IN ('cc','approver')`, [e.id]);
      // Campos borrados (con su destinatario o por el cambio de rol): las condiciones que los citaban se quitan.
      await pruneDanglingConditions(t, "fields", e.id);
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
      const docs = new Map((await t.query<any>(`SELECT id, page_count FROM documents WHERE envelope_id = $1`, [e.id])).map((d) => [d.id, d]));
      const signers = new Set(
        (await t.query<any>(`SELECT id FROM recipients WHERE envelope_id = $1 AND role = 'signer'`, [e.id])).map((r) => r.id),
      );
      await t.query(`DELETE FROM fields WHERE envelope_id = $1`, [e.id]);
      for (const [i, f] of input.fields.entries()) {
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
          tenantId: a.tenantId,
          envelopeId: e.id,
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
      await saveFieldLogic(t, "fields", input.fields);
      await touch(t, e.id);
    });
    return loadDetail(s.db, a.tenantId, req.params.id);
  });

  // ───────── Ciclo de vida ─────────

  app.post<P>("/v1/envelopes/:id/send", { preHandler: auth }, async (req, reply) =>
    idempotent(s, req, reply, async () => {
      const a = A(req);
      await s.db.tx((t) => sendEnvelope(t, a.tenantId, req.params.id, a.actor));
      return { status: 200, body: await loadDetail(s.db, a.tenantId, req.params.id) };
    }),
  );

  app.post<P>("/v1/envelopes/:id/void", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = VoidEnvelopeInput.parse(req.body);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "sent" && e.status !== "awaiting_certificates") throw conflict("not_voidable", "Solo se puede anular un sobre enviado y en curso");
      await t.query(`UPDATE envelopes SET status = 'voided', voided_at = now(), void_reason = $2, updated_at = now(), version = version + 1 WHERE id = $1`, [
        e.id,
        input.reason,
      ]);
      await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "envelope.voided", actor: a.actor, data: { reason: input.reason } });
      // También quienes ya firmaron electrónicamente pero tenían pendiente la firma con certificado.
      const notified = await t.query<any>(
        `SELECT id FROM recipients r WHERE envelope_id = $1 AND (status IN ('sent','viewed')
           OR EXISTS (SELECT 1 FROM certificate_signatures c WHERE c.recipient_id = r.id AND c.status = 'pending'))`,
        [e.id],
      );
      for (const r of notified) await enqueue(t, "notify", { kind: "voided", envelopeId: e.id, recipientId: r.id, tenantId: a.tenantId });
    });
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
export function danglingFormulaProblems(fields: { type: string; label: string | null; formula: string | null }[]): string[] {
  const numberLabels = new Set(fields.filter((f) => f.type === "number" && f.label).map((f) => String(f.label).trim().toLowerCase()));
  const problems: string[] = [];
  for (const f of fields) {
    if (!f.formula) continue;
    let refs: string[] = [];
    try {
      refs = formulaRefs(f.formula);
    } catch {
      /* se valida al guardar */
    }
    const missing = refs.filter((r) => !numberLabels.has(r.trim().toLowerCase()));
    if (missing.length) problems.push(`La fórmula de "${f.label ?? "un campo"}" cita ${missing.map((m) => `{${m}}`).join(", ")}, que ya no está en el sobre`);
  }
  return problems;
}

/** Valida y envía un borrador (dentro de la transacción del llamador). */
export async function sendEnvelope(t: Db, tenantId: string, envelopeId: string, actor: Actor) {
  const e = await lockEnvelope(t, tenantId, envelopeId);
  requireDraft(e);
  await enforceEnvelopeQuota(t, tenantId);
  const docs = await loadDocuments(t, e.id);
  const recips = await t.query<any>(`SELECT * FROM recipients WHERE envelope_id = $1`, [e.id]);
  const fields = await t.query<any>(`SELECT recipient_id, type, label, formula FROM fields WHERE envelope_id = $1`, [e.id]);
  const problems: string[] = [];
  if (docs.length === 0) problems.push("Agregá al menos un documento");
  const signers = recips.filter((r) => r.role === "signer");
  if (signers.length === 0 && !recips.some((r) => r.role === "approver")) problems.push("Agregá al menos un firmante");
  for (const s1 of signers) {
    // Quien firma con certificado puede no tener firma visual: su firma va en el certificado.
    if (s1.signature_type !== "certificate" && !fields.some((f) => f.recipient_id === s1.id && f.type === "signature"))
      problems.push(`${s1.name} no tiene ningún campo de firma`);
  }
  if (e.expires_at && new Date(e.expires_at) <= new Date()) problems.push("La fecha de vencimiento ya pasó");
  problems.push(...danglingFormulaProblems(fields));
  // El cobro tiene que quedar a cargo de un firmante: si se le cambió el rol, el sobre no podría completarse.
  const pay = await t.one<any>(`SELECT recipient_id FROM envelope_payments WHERE envelope_id = $1`, [e.id]);
  if (pay && !signers.some((r) => r.id === pay.recipient_id)) problems.push("Quien paga el cobro tiene que ser un firmante");
  if (problems.length) throw new AppError(422, "envelope_incomplete", problems.join(". "), { problems });

  await t.query(`UPDATE envelopes SET status = 'sent', sent_at = now(), updated_at = now(), version = version + 1 WHERE id = $1`, [e.id]);
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
