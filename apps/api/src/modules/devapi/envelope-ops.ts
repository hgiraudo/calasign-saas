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
import { VALUE_FIELD_TYPES, checkSenderValue, insertEnvelopeField } from "../fieldvalues";
import { applyCertificateFlags } from "../certsign";
import { applyIdentityFlags, providerReady } from "../identity/kyc";
import { explicitRequirements } from "../certsign-requirements";
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
  // Sin telegram_chat_id: el chat vinculado es de quien abrió el link del original (ver replaceRecipients); el
  // destinatario del clon lo vuelve a vincular desde su link.
  "id_document_type",
  "id_document_number",
  "auth_method",
  "embedded",
  "in_person_host_user_id",
  // La verificación de identidad (id_verification_*) y la firma con certificado (signature_type,
  // certificate_requirements) no se copian tal cual: pasan por applyIdentityFlags / applyCertificateFlags, que controlan
  // el plan y el proveedor como un PUT recipients.
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

/**
 * Algo del original que el clon no pudo conservar tal cual (el borrador se crea igual; se informa en la respuesta y en
 * el evento envelope.created):
 * - telegram_relink_required: el chat de Telegram no se copia (es de quien abrió el link del original). Si Telegram
 *   es su único canal (`telegramOnly`), el envío falla (422 telegram_unlinked) hasta cargar telegramChatId o agregar
 *   email/WhatsApp; si no, recibe el link por sus otros canales y vuelve a vincular Telegram desde él.
 * - identity_verification_dropped: verificación de identidad quitada (`reason`: plan sin kyc, proveedor no configurado).
 * - certificate_id_match_dropped: el control de que el certificado corresponda al documento se bajó (no tiene número de
 *   documento cargado), con la marca idDocumentMatchSkipped para la evidencia.
 */
export interface CloneWarning {
  code: "telegram_relink_required" | "identity_verification_dropped" | "certificate_id_match_dropped";
  /** Destinatario del clon. */
  recipientId: string;
  recipient: string;
  reason?: string;
  telegramOnly?: boolean;
  message: string;
}

/** Clona un sobre como borrador nuevo. Devuelve el id y los avisos. Corre dentro de la transacción del llamador. */
export async function cloneEnvelope(t: Services["db"], a: AuthContext, sourceId: string, input: CloneEnvelopeInput): Promise<{ id: string; warnings: CloneWarning[] }> {
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
  const keep = Object.fromEntries(["templateId", "documentTemplateId", "documentProvenance", "agreement"].filter((k) => src.metadata && k in src.metadata).map((k) => [k, src.metadata[k]]));
  // Con metadata propia, las claves reservadas que describen el documento y clonedFrom se conservan igual (como en
  // PATCH, que no deja pisar las reservadas): el integrador no puede borrar ni falsificar la procedencia.
  const metadata = input.metadata
    ? { ...stripReservedMetadata(input.metadata), ...keep, clonedFrom: src.id }
    : { ...stripReservedMetadata(src.metadata), ...keep, clonedFrom: src.id };
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
      // Sin expiresAt, 30 días; con null, sin vencimiento (antes null también daba 30 días).
      input.expiresAt === undefined ? new Date(Date.now() + 30 * 86400_000).toISOString() : input.expiresAt,
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
  const warnings: CloneWarning[] = [];
  const recMap = includeRecipients ? await cloneRecipients(t, a, src.id, id, warnings) : new Map<string, string>();
  await appendEvent(t, {
    tenantId: a.tenantId,
    envelopeId: id,
    type: "envelope.created",
    actor: a.actor,
    data: {
      subject: input.subject ?? src.subject,
      clonedFrom: src.id,
      ...(warnings.length ? { warnings: warnings.map(({ code, recipientId, reason, telegramOnly }) => ({ code, recipientId, reason, telegramOnly })) } : {}),
    },
  });

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
  if (!includeFields) return { id, warnings };

  const fields = await t.query<any>(`SELECT * FROM fields WHERE envelope_id = $1`, [src.id]);
  const fieldMap = new Map<string, string>();
  for (const f of fields) {
    const recipientId = recMap.get(f.recipient_id);
    const documentId = docMap.get(f.document_id);
    if (!recipientId || !documentId) continue;
    const nf = uuidv7();
    fieldMap.set(f.id, nf);
    // Lo que fijó el remitente (solo lectura) se copia siempre. Con includeValues, también lo que escribieron los
    // firmantes, pero solo de los tipos que un remitente puede prellenar y con un valor que pasa su validación: una
    // casilla, fecha, firma o adjunto prellenados en un borrador no se pueden editar ni quitar desde la consola (la API
    // los rechaza al guardar los campos). Una fórmula se recalcula, no se copia.
    let keptValue: string | null = null;
    if (f.read_only) keptValue = f.value;
    else if (input.includeValues && VALUE_FIELD_TYPES.includes(f.type) && !f.formula) {
      try {
        keptValue = checkSenderValue({ type: f.type, label: f.label, options: f.options ?? null, min: f.min_value ?? null, max: f.max_value ?? null, value: f.value }, "Campo");
      } catch {
        keptValue = null;
      }
    }
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
      value: keptValue,
      readOnly: Boolean(f.read_only),
      options: f.options ?? null,
      min: f.min_value ?? null,
      max: f.max_value ?? null,
    });
  }
  await copyFieldLogic(t, "fields", fields, fieldMap);
  return { id, warnings };
}

/** Copia los destinatarios vigentes del original al clon `id`. Devuelve original → clon; los avisos van en `warnings`. */
async function cloneRecipients(t: Services["db"], a: AuthContext, srcId: string, id: string, warnings: CloneWarning[]): Promise<Map<string, string>> {
  // Destinatarios vigentes (no los reemplazados por una delegación o reasignación: su reemplazo ya está en la lista).
  const recMap = new Map<string, string>();
  const recips = await t.query<any>(
    `SELECT id, role, name, id_document_number, id_verification_provider, id_verification_level, signature_type, certificate_requirements
       FROM recipients WHERE envelope_id = $1 AND status NOT IN ('delegated','reassigned') ORDER BY routing_order, created_at, id`,
    [srcId],
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
  // El chat de Telegram no se copia (es de quien abrió el link del original): los canales quedan como estaban (no se
  // agrega email/WhatsApp a quien eligió solo Telegram) y se avisa para volver a vincular. Solo Telegram y sin chat, el
  // envío lo rechaza (telegram_unlinked) hasta cargar telegramChatId o agregar otro canal.
  for (const r of await t.query<{ id: string; name: string; channels: string[] }>(
    `SELECT id, name, channels FROM recipients WHERE envelope_id = $1 AND NOT embedded AND in_person_host_user_id IS NULL AND 'telegram' = ANY(channels)
      ORDER BY routing_order, created_at, id`,
    [id],
  )) {
    const telegramOnly = r.channels.every((c) => c === "telegram");
    warnings.push({
      code: "telegram_relink_required",
      recipientId: r.id,
      recipient: r.name,
      telegramOnly,
      message: telegramOnly
        ? `${r.name}: el chat de Telegram no se copia; cargá telegramChatId o agregá email/WhatsApp antes de enviar`
        : `${r.name}: el chat de Telegram no se copia; recibe el link por sus otros canales y vuelve a vincular Telegram desde él`,
    });
  }
  // Verificación de identidad y firma con certificado: pasan por los mismos controles que PUT recipients, pero lo que el
  // plan o el entorno actual ya no admiten se quita (con aviso) en vez de impedir el clonado.
  const cloned = recips.map((r) => ({ ...r, id: recMap.get(r.id)! }));
  const withIdv = cloned.filter((r) => r.id_verification_provider);
  const hasKyc = withIdv.length > 0 && (await tenantPlan(t, a.tenantId)).plan.features.includes("kyc");
  const idv: { id: string; role: string; idVerification: { provider: any; level?: any } }[] = [];
  for (const r of withIdv) {
    const reason = !hasKyc ? "plan_without_kyc" : !providerReady(r.id_verification_provider) ? "provider_unavailable" : r.role === "cc" ? "not_applicable" : null;
    if (!reason) {
      idv.push({ id: r.id, role: r.role, idVerification: { provider: r.id_verification_provider, level: r.id_verification_level ?? undefined } });
      continue;
    }
    warnings.push({
      code: "identity_verification_dropped",
      recipientId: r.id,
      recipient: r.name,
      reason,
      message:
        reason === "plan_without_kyc"
          ? `${r.name}: se quitó la verificación de identidad (el plan actual no la incluye)`
          : reason === "provider_unavailable"
            ? `${r.name}: se quitó la verificación de identidad (el proveedor ${r.id_verification_provider} no está configurado)`
            : `${r.name}: se quitó la verificación de identidad (no aplica a copias)`,
    });
  }
  await applyIdentityFlags(t, id, idv);
  const certs = cloned.filter((r) => r.signature_type === "certificate" && r.role === "signer");
  await applyCertificateFlags(
    t,
    id,
    certs.map((r) => {
      let req = r.certificate_requirements ?? undefined;
      if (req?.matchIdDocument === true && !String(r.id_document_number ?? "").trim()) {
        // Como downgradeIdMatchSql: sin documento no hay con qué comparar; queda la marca para la evidencia.
        req = { ...explicitRequirements(req), matchIdDocument: false, idDocumentMatchSkipped: true };
        warnings.push({
          code: "certificate_id_match_dropped",
          recipientId: r.id,
          recipient: r.name,
          reason: "missing_id_document",
          message: `${r.name}: no se exige que el certificado corresponda a su documento (no tiene número de documento cargado)`,
        });
      }
      return { id: r.id, role: r.role, signatureType: "certificate" as const, certificateRequirements: req };
    }),
  );
  return recMap;
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
    const { id, warnings } = await s.db.tx((t) => cloneEnvelope(t, a, req.params.id, input));
    reply.code(201);
    return { ...(await loadDetail(s.db, a.tenantId, id)), warnings };
  });

  // Lote: cada elemento se ejecuta como su pedido individual (app.inject con la misma credencial), así aplican la
  // política de acceso, el registro de auditoría y las validaciones de siempre. Cada elemento cuenta para el límite de
  // pedidos de quien llama (se reenvía su IP). Secuencial: el orden de los resultados es el de `ids`.
  app.post("/v1/envelopes/batch", { preHandler: auth }, async (req): Promise<EnvelopeBatchResponse> => {
    const input = EnvelopeBatchInput.parse(req.body);
    const headers: Record<string, string> = { "x-forwarded-for": req.ip, "user-agent": String(req.headers["user-agent"] ?? "calasign-batch") };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    // El mismo host del pedido: sin él, app.inject usa localhost y, fuera de local, la cuenta solo existe en el host
    // de la plataforma (custom-domains.ts): la cookie de sesión se descartaba y cada elemento daba 401. El Origin no se
    // reenvía: el pedido externo ya pasó el control CSRF (y por dentro, sin x-forwarded-proto, no coincidiría).
    if (req.headers.host) headers.host = req.headers.host;
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
