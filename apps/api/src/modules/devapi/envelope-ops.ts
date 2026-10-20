// Operaciones sobre sobres para integradores: datos de formulario (valores completados), descarga de adjuntos del
// firmante, clonado de un sobre como borrador nuevo y operaciones en lote (get/void/remind/delete).
import { tenantPlan } from "../billing/plans";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CloneEnvelopeInput,
  EnvelopeBatchInput,
  type EnvelopeBatchResponse,
  type EnvelopeBatchResult,
  type EnvelopeFormData,
  type FormDataField,
  stripReservedMetadata,
} from "@calasign/shared";
import { appendEvent } from "../../infra/evidence";
import { AppError, notFound } from "../../lib/errors";
import { iso, uuidv7 } from "../../lib/util";
import { hasPerm } from "../access";
import { authenticate, type AuthContext, type Services } from "../context";
import { insertEnvelopeField } from "../fieldvalues";
import { copyFieldLogic } from "../logic";
import { loadDetail, loadDocuments } from "../mappers";

/** Campos cuyo valor es una imagen o un archivo: en los datos de formulario solo se informa si se completaron. */
const IMAGE_TYPES = new Set(["signature", "initials"]);

/** Columnas de configuración de un destinatario que se copian al clonar (no las de estado, tokens ni evidencia). */
const RECIPIENT_CONFIG_COLUMNS = [
  "role",
  "routing_order",
  "name",
  "email",
  "phone",
  "locale",
  "channels",
  "telegram_chat_id",
  "id_document_type",
  "id_document_number",
  "auth_method",
  "embedded",
  "in_person_host_user_id",
  "id_verification_provider",
  "id_verification_level",
  "signature_type",
  "certificate_requirements",
] as const;

/** Columnas de configuración del sobre que se copian al clonar. */
const ENVELOPE_CONFIG_COLUMNS = [
  "locale",
  "signature_level",
  "allow_delegation",
  "reminder_every_days",
  "expiry_warning_days",
  "ai_signer_assist",
  "company_seal_certificate_id",
  // Sub-marca (marca blanca): sin ella, el clon de un sobre de un cliente de la revendedora salía con la marca de la organización.
  "brand_id",
] as const;

export async function loadFormData(s: Services, tenantId: string, envelopeId: string): Promise<EnvelopeFormData> {
  const e = await s.db.one<any>(`SELECT id, status, completed_at FROM envelopes WHERE id = $1 AND tenant_id = $2`, [envelopeId, tenantId]);
  if (!e) throw notFound("Sobre");
  const [recips, fields] = await Promise.all([
    s.db.query<any>(
      `SELECT id, name, email, role, status, signed_at FROM recipients WHERE envelope_id = $1 AND status NOT IN ('delegated','reassigned')
       ORDER BY routing_order, created_at, id`,
      [envelopeId],
    ),
    s.db.query<any>(
      `SELECT f.*, fl.content_type AS att_type, fl.size_bytes AS att_size, fl.sha256 AS att_sha, fl.purged_at AS att_purged
         FROM fields f LEFT JOIN files fl ON fl.id = f.attachment_file_id
        WHERE f.envelope_id = $1 ORDER BY f.page, f.y, f.x`,
      [envelopeId],
    ),
  ]);
  // Sin prototipo: con {} un campo con etiqueta "constructor" o "toString" nunca entraba (values[key] ya era la función
  // heredada) y "__proto__" se descartaba al asignarlo.
  const values: Record<string, string> = Object.create(null);
  const toField = (f: any): FormDataField => {
    const isImage = IMAGE_TYPES.has(f.type);
    const att = f.type === "attachment" && f.attachment_file_id && !f.att_purged;
    const value = isImage ? null : f.type === "attachment" ? (att ? f.value : null) : f.value;
    const key = f.label || f.id;
    if (!f.hidden && value !== null && value !== undefined && value !== "" && values[key] === undefined) values[key] = String(value);
    return {
      id: f.id,
      label: f.label,
      type: f.type,
      documentId: f.document_id,
      page: f.page,
      value,
      filled: isImage ? Boolean(f.filled_at || f.value) : value !== null && value !== "",
      hidden: Boolean(f.hidden),
      readOnly: Boolean(f.read_only),
      attachment: att
        ? {
            name: f.value ?? null,
            contentType: f.att_type,
            sizeBytes: Number(f.att_size),
            sha256: f.att_sha,
            downloadPath: `/v1/envelopes/${envelopeId}/attachments/${f.id}`,
          }
        : null,
    };
  };
  return {
    envelopeId: e.id,
    status: e.status,
    completedAt: iso(e.completed_at),
    recipients: recips.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      status: r.status,
      signedAt: iso(r.signed_at),
      fields: fields.filter((f) => f.recipient_id === r.id).map(toField),
    })),
    values,
  };
}

/** Clona un sobre como borrador nuevo. Devuelve el id. Corre dentro de la transacción del llamador. */
export async function cloneEnvelope(t: Services["db"], a: AuthContext, sourceId: string, input: CloneEnvelopeInput): Promise<string> {
  // FOR SHARE: espera a una purga por retención en curso (que bloquea el sobre) y ve su purged_at.
  const src = await t.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2 FOR SHARE`, [sourceId, a.tenantId]);
  if (!src) throw notFound("Sobre");
  // Los originales de un sobre purgado por la política de retención ya no existen: el clon quedaría con documentos vacíos.
  if (src.purged_at) throw new AppError(409, "purged", "Los originales de este sobre se eliminaron por la política de retención: no se puede clonar");
  const includeRecipients = input.includeRecipients ?? true;
  const includeFields = includeRecipients && (input.includeFields ?? true);
  const id = uuidv7();
  // Sin las claves del sistema que lo atan a un proceso del original (workflow, formulario, envío masivo, CRM…): el clon
  // no es parte de ellos. Las que describen el documento (plantilla, acuerdo) se conservan.
  const keep = Object.fromEntries(["templateId", "documentTemplateId", "agreement"].filter((k) => src.metadata && k in src.metadata).map((k) => [k, src.metadata[k]]));
  const metadata = input.metadata ?? { ...stripReservedMetadata(src.metadata), ...keep, clonedFrom: src.id };
  await t.query(
    `INSERT INTO envelopes (id, tenant_id, created_by, created_via, subject, message, expires_at, metadata, created_by_api_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      a.tenantId,
      a.userId,
      a.apiKeyId ? "api" : "web",
      input.subject ?? src.subject,
      input.message !== undefined ? input.message : src.message,
      input.expiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
      JSON.stringify(metadata),
      a.apiKeyId,
    ],
  );
  await t.query(
    `UPDATE envelopes d SET ${ENVELOPE_CONFIG_COLUMNS.map((c) => `${c} = s.${c}`).join(", ")} FROM envelopes s WHERE d.id = $1 AND s.id = $2`,
    [id, src.id],
  );
  // Sin marca blanca en el plan actual, el clon no hereda la sub-marca (sale con la marca de la organización).
  if (src.brand_id && !(await tenantPlan(t, a.tenantId)).plan.features.includes("white_label")) {
    await t.query(`UPDATE envelopes SET brand_id = NULL WHERE id = $1`, [id]);
  }
  // El sello de empresa del original pudo borrarse después (el borrado solo lo quita de borradores y enviados): un
  // borrador que apunta a un certificado sin clave no podría finalizar nunca. Se relee con FOR SHARE, como evidence.ts.
  if (src.company_seal_certificate_id) {
    const cert = await t.one(`SELECT 1 FROM tenant_certificates WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR SHARE`, [src.company_seal_certificate_id, a.tenantId]);
    if (!cert) await t.query(`UPDATE envelopes SET company_seal_certificate_id = NULL WHERE id = $1`, [id]);
  }
  await appendEvent(t, { tenantId: a.tenantId, envelopeId: id, type: "envelope.created", actor: a.actor, data: { subject: input.subject ?? src.subject, clonedFrom: src.id } });

  // Documentos: los archivos son inmutables, el clon referencia los mismos originales.
  const docMap = new Map<string, string>();
  for (const d of await loadDocuments(t, src.id)) {
    const nd = uuidv7();
    docMap.set(d.id, nd);
    await t.query(
      `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [nd, a.tenantId, id, d.position, d.name, d.file_id, d.page_count, JSON.stringify(d.pages)],
    );
    await appendEvent(t, {
      tenantId: a.tenantId,
      envelopeId: id,
      type: "document.added",
      actor: a.actor,
      data: { documentId: nd, name: d.name, sha256: d.sha256, pages: d.page_count, clonedFrom: src.id },
    });
  }
  if (!includeRecipients) return id;

  // Destinatarios vigentes (no los reemplazados por una delegación o reasignación: su reemplazo ya está en la lista).
  const recMap = new Map<string, string>();
  const recips = await t.query<any>(
    `SELECT id FROM recipients WHERE envelope_id = $1 AND status NOT IN ('delegated','reassigned') ORDER BY routing_order, created_at, id`,
    [src.id],
  );
  const cols = RECIPIENT_CONFIG_COLUMNS.join(", ");
  for (const r of recips) {
    const nr = uuidv7();
    recMap.set(r.id, nr);
    await t.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, ${cols}) SELECT $1, tenant_id, $2, ${cols} FROM recipients WHERE id = $3`,
      [nr, id, r.id],
    );
  }
  // El anfitrión de una firma en persona del original pudo dejar la organización: sin él nadie abre la sesión y ese
  // firmante no recibe invitación, así que el sobre quedaba trabado al enviarlo. Como en replaceRecipient, firma por link.
  await t.query(
    `UPDATE recipients r SET in_person_host_user_id = NULL, auth_method = 'link'
      WHERE r.envelope_id = $1 AND r.in_person_host_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = r.tenant_id AND m.user_id = r.in_person_host_user_id)`,
    [id],
  );
  if (!includeFields) return id;

  const fields = await t.query<any>(`SELECT * FROM fields WHERE envelope_id = $1`, [src.id]);
  const fieldMap = new Map<string, string>();
  for (const f of fields) {
    const recipientId = recMap.get(f.recipient_id);
    const documentId = docMap.get(f.document_id);
    if (!recipientId || !documentId) continue;
    const nf = uuidv7();
    fieldMap.set(f.id, nf);
    // Un adjunto no se copia (es un archivo del firmante); las firmas e iniciales tampoco.
    const keepValue = f.read_only || (input.includeValues && !IMAGE_TYPES.has(f.type) && f.type !== "attachment");
    await insertEnvelopeField(t, {
      id: nf,
      tenantId: a.tenantId,
      envelopeId: id,
      documentId,
      recipientId,
      type: f.type,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.required,
      label: f.label,
      value: keepValue ? f.value : null,
      readOnly: Boolean(f.read_only),
      options: f.options ?? null,
      min: f.min_value ?? null,
      max: f.max_value ?? null,
    });
  }
  await copyFieldLogic(t, "fields", fields, fieldMap);
  return id;
}

/** Operación individual que ejecuta cada elemento de un lote (misma política, auditoría y validaciones). */
const BATCH_ROUTE: Record<EnvelopeBatchInput["action"], (id: string, input: EnvelopeBatchInput) => { method: "GET" | "POST" | "DELETE"; url: string; body?: unknown }> = {
  get: (id) => ({ method: "GET", url: `/v1/envelopes/${id}` }),
  void: (id, i) => ({ method: "POST", url: `/v1/envelopes/${id}/void`, body: { reason: i.reason } }),
  remind: (id) => ({ method: "POST", url: `/v1/envelopes/${id}/remind` }),
  delete: (id) => ({ method: "DELETE", url: `/v1/envelopes/${id}` }),
};

export async function envelopeOpsRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  type P = { Params: { id: string; fieldId?: string } };

  app.get<P>("/v1/envelopes/:id/form-data", { preHandler: auth }, async (req) => loadFormData(s, A(req).tenantId, req.params.id));

  app.get<P>("/v1/envelopes/:id/attachments/:fieldId", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.fieldId ?? "")) throw notFound("Adjunto");
    const r = await s.db.one<any>(
      `SELECT f.value, fl.storage_key, fl.content_type FROM fields f JOIN files fl ON fl.id = f.attachment_file_id
        WHERE f.id = $1 AND f.envelope_id = $2 AND f.tenant_id = $3 AND f.type = 'attachment' AND fl.purged_at IS NULL`,
      [req.params.fieldId, req.params.id, a.tenantId],
    );
    if (!r) throw notFound("Adjunto");
    const ext = r.content_type === "application/pdf" ? "pdf" : r.content_type === "image/png" ? "png" : "jpg";
    const base = String(r.value ?? "adjunto").replace(/[^\p{L}\p{N} ._-]+/gu, "").replace(/\.(pdf|png|jpe?g)$/i, "").trim().slice(0, 80) || "adjunto";
    reply
      .header("content-type", r.content_type)
      .header("content-disposition", `attachment; filename="${base.replace(/[^\x20-\x7e]/g, "_")}.${ext}"; filename*=UTF-8''${encodeURIComponent(base)}.${ext}`)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff");
    return reply.send(Buffer.from(await s.blobs.get(r.storage_key)));
  });

  app.post<P>("/v1/envelopes/:id/clone", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    if (!hasPerm(a, "envelopes:create")) throw new AppError(403, "forbidden", "No podés crear sobres", { permission: "envelopes:create" });
    const input = CloneEnvelopeInput.parse(req.body ?? {});
    const id = await s.db.tx((t) => cloneEnvelope(t, a, req.params.id, input));
    reply.code(201);
    return loadDetail(s.db, a.tenantId, id);
  });

  // Lote: cada elemento se ejecuta como su pedido individual (app.inject con la misma credencial), así aplican la
  // política de acceso, el registro de auditoría y las validaciones de siempre. Cada elemento cuenta para el límite de
  // pedidos de quien llama (se reenvía su IP). Secuencial: el orden de los resultados es el de `ids`.
  app.post("/v1/envelopes/batch", { preHandler: auth }, async (req): Promise<EnvelopeBatchResponse> => {
    const input = EnvelopeBatchInput.parse(req.body);
    const headers: Record<string, string> = { "x-forwarded-for": req.ip, "user-agent": String(req.headers["user-agent"] ?? "calasign-batch") };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    const results: EnvelopeBatchResult[] = [];
    for (const id of input.ids) {
      const r = BATCH_ROUTE[input.action](id, input);
      const res = await app.inject({ method: r.method, url: r.url, headers: { ...headers, ...(r.body ? { "content-type": "application/json" } : {}) }, payload: r.body ? JSON.stringify(r.body) : undefined });
      let data: any = undefined;
      try {
        data = res.body ? JSON.parse(res.body) : undefined;
      } catch {
        /* sin cuerpo JSON */
      }
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      results.push(
        ok
          ? { id, ok, status: res.statusCode, ...(data !== undefined ? { data } : {}) }
          : { id, ok, status: res.statusCode, error: { code: data?.error?.code ?? `http_${res.statusCode}`, message: data?.error?.message ?? "Error" } },
      );
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { action: input.action, succeeded, failed: results.length - succeeded, results };
  });
}
