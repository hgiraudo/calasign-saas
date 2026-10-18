// Plantillas: documentos + roles + campos reutilizables, y creación de sobres a partir de una plantilla.
import type { FastifyInstance } from "fastify";
import {
  CreateTemplateInput,
  EnvelopeFromTemplateInput,
  PutTemplateFieldsInput,
  PutTemplateRolesInput,
  TemplateFromEnvelopeInput,
  UpdateTemplateInput,
  type TemplateDetail,
  type TemplateField,
  type TemplateSummary,
} from "@calasign/shared";
import { InvalidPdfError, inspectPdf } from "@calasign/pdf";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import { AppError, badRequest, notFound } from "../lib/errors";
import { iso, sha256Hex, uuidv7 } from "../lib/util";
import { assertTemplateAccess, templateVisibilitySql } from "./access";
import { authenticate, type AuthContext, type Services } from "./context";
import { sendEnvelope } from "./envelopes";
import { checkSenderValue, insertEnvelopeField } from "./fieldvalues";
import { assignFieldIds, copyFieldLogic, saveFieldLogic } from "./logic";
import { loadDetail, loadDocuments, toDocument } from "./mappers";

const toTemplate = (r: any) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  subject: r.subject,
  message: r.message,
  locale: r.locale,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toTemplateField = (r: any): TemplateField => ({
  id: r.id,
  documentId: r.document_id,
  roleId: r.role_id,
  type: r.type,
  page: r.page,
  x: r.x,
  y: r.y,
  width: r.width,
  height: r.height,
  required: r.required,
  label: r.label,
  value: r.value,
  readOnly: Boolean(r.read_only),
  options: r.options ?? null,
  min: r.min_value ?? null,
  max: r.max_value ?? null,
  conditions: Array.isArray(r.conditions) && r.conditions.length ? r.conditions : null,
  formula: r.formula ?? null,
});

async function loadTemplateDocuments(db: Db, templateId: string) {
  return db.query(
    `SELECT d.*, f.sha256, f.size_bytes, f.storage_key FROM template_documents d JOIN files f ON f.id = d.file_id
     WHERE d.template_id = $1 ORDER BY d.position`,
    [templateId],
  );
}

export async function loadTemplateDetail(db: Db, tenantId: string, id: string): Promise<TemplateDetail> {
  const t = await db.one<any>(`SELECT * FROM templates WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!t) throw notFound("Plantilla");
  const [docs, roles, fields] = await Promise.all([
    loadTemplateDocuments(db, id),
    db.query<any>(`SELECT * FROM template_roles WHERE template_id = $1 ORDER BY routing_order, position, id`, [id]),
    db.query<any>(`SELECT * FROM template_fields WHERE template_id = $1 ORDER BY page, y, x`, [id]),
  ]);
  return {
    template: toTemplate(t),
    documents: docs.map(toDocument),
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      routingOrder: r.routing_order,
      signatureType: r.signature_type ?? "electronic",
      certificateRequirements: r.certificate_requirements ?? null,
    })),
    fields: fields.map(toTemplateField),
  };
}

async function lockTemplate(db: Db, tenantId: string, id: string) {
  const t = await db.one<any>(`SELECT * FROM templates WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tenantId]);
  if (!t) throw notFound("Plantilla");
  return t;
}

async function touch(db: Db, id: string) {
  await db.query(`UPDATE templates SET updated_at = now() WHERE id = $1`, [id]);
}

async function insertTemplateField(db: Db, tenantId: string, templateId: string, f: Omit<TemplateField, "id" | "conditions" | "formula"> & { id?: string }) {
  await db.query(
    `INSERT INTO template_fields (id, tenant_id, template_id, document_id, role_id, type, page, x, y, width, height, required, label,
       value, read_only, options, min_value, max_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      f.id ?? uuidv7(),
      tenantId,
      templateId,
      f.documentId,
      f.roleId,
      f.type,
      f.page,
      f.x,
      f.y,
      f.width,
      f.height,
      f.required,
      f.label,
      f.value,
      f.readOnly,
      f.options ? JSON.stringify(f.options) : null,
      f.min,
      f.max,
    ],
  );
}

export async function templateRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  type P = { Params: { id: string; documentId?: string; envelopeId?: string } };
  const A = (req: any) => req.auth as AuthContext;

  app.get<{ Querystring: { q?: string } }>("/v1/templates", { preHandler: auth }, async (req) => {
    const a = A(req);
    const params: unknown[] = [a.tenantId];
    let where = `t.tenant_id = $1`;
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where += ` AND (t.name ILIKE $${params.length} OR t.description ILIKE $${params.length})`;
    }
    where += templateVisibilitySql(a, params);
    const rows = await s.db.query<any>(`SELECT t.* FROM templates t WHERE ${where} ORDER BY t.updated_at DESC LIMIT 200`, params);
    const ids = rows.map((r) => r.id);
    const [docs, roles] = ids.length
      ? await Promise.all([
          s.db.query<any>(`SELECT template_id, count(*)::int AS n FROM template_documents WHERE template_id = ANY($1) GROUP BY template_id`, [ids]),
          s.db.query<any>(`SELECT template_id, name, role FROM template_roles WHERE template_id = ANY($1) ORDER BY routing_order, position`, [ids]),
        ])
      : [[], []];
    const items: TemplateSummary[] = rows.map((r) => ({
      ...toTemplate(r),
      documentCount: docs.find((d: any) => d.template_id === r.id)?.n ?? 0,
      roles: roles.filter((x: any) => x.template_id === r.id).map((x: any) => ({ name: x.name, role: x.role })),
    }));
    return { items };
  });

  app.post("/v1/templates", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateTemplateInput.parse(req.body);
    const id = uuidv7();
    const tenant = await s.db.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
    await s.db.query(
      `INSERT INTO templates (id, tenant_id, name, description, subject, message, locale, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, a.tenantId, input.name, input.description ?? null, input.subject ?? null, input.message ?? null, input.locale ?? tenant?.default_locale ?? "es", a.userId],
    );
    reply.code(201);
    return loadTemplateDetail(s.db, a.tenantId, id);
  });

  app.get<P>("/v1/templates/:id", { preHandler: auth }, async (req) => loadTemplateDetail(s.db, A(req).tenantId, req.params.id));

  app.patch<P>("/v1/templates/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateTemplateInput.parse(req.body);
    await s.db.tx(async (t) => {
      const tpl = await lockTemplate(t, a.tenantId, req.params.id);
      await t.query(
        `UPDATE templates SET name = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           subject = CASE WHEN $5::boolean THEN $6 ELSE subject END,
           message = CASE WHEN $7::boolean THEN $8 ELSE message END,
           locale = COALESCE($9, locale), updated_at = now()
         WHERE id = $1`,
        [
          tpl.id,
          input.name ?? null,
          input.description !== undefined,
          input.description ?? null,
          input.subject !== undefined,
          input.subject ?? null,
          input.message !== undefined,
          input.message ?? null,
          input.locale ?? null,
        ],
      );
    });
    return loadTemplateDetail(s.db, a.tenantId, req.params.id);
  });

  app.delete<P>("/v1/templates/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await s.db.query(`DELETE FROM templates WHERE id = $1 AND tenant_id = $2 RETURNING id`, [req.params.id, a.tenantId]);
    if (!r.length) throw notFound("Plantilla");
    return reply.code(204).send();
  });

  // ───────── Documentos ─────────

  app.post<P>("/v1/templates/:id/documents", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const bytes = new Uint8Array(await file.toBuffer());
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo");
    let info;
    try {
      info = await inspectPdf(bytes);
    } catch (e) {
      if (e instanceof InvalidPdfError) throw badRequest(e.code, e.message);
      throw e;
    }
    const pre = await s.db.one(`SELECT 1 FROM templates WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!pre) throw notFound("Plantilla");
    const fileId = uuidv7();
    const docId = uuidv7();
    const key = `tenants/${a.tenantId}/templates/${req.params.id}/${fileId}.pdf`;
    await s.blobs.put(key, bytes, "application/pdf");
    const name = (file.filename || "documento.pdf").slice(0, 200);
    await s.db.tx(async (t) => {
      const tpl = await lockTemplate(t, a.tenantId, req.params.id);
      const pos = await t.one<any>(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM template_documents WHERE template_id = $1`, [tpl.id]);
      await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'template',$3,'application/pdf',$4,$5)`, [
        fileId,
        a.tenantId,
        key,
        bytes.length,
        sha256Hex(bytes),
      ]);
      await t.query(
        `INSERT INTO template_documents (id, tenant_id, template_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [docId, a.tenantId, tpl.id, pos.p, name, fileId, info.pageCount, JSON.stringify(info.pages)],
      );
      await touch(t, tpl.id);
    });
    reply.code(201);
    return (await loadTemplateDetail(s.db, a.tenantId, req.params.id)).documents.find((d) => d.id === docId);
  });

  app.delete<P>("/v1/templates/:id/documents/:documentId", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    await s.db.tx(async (t) => {
      const tpl = await lockTemplate(t, a.tenantId, req.params.id);
      const r = await t.query(`DELETE FROM template_documents WHERE id = $1 AND template_id = $2 RETURNING id`, [req.params.documentId, tpl.id]);
      if (!r.length) throw notFound("Documento");
      await touch(t, tpl.id);
    });
    return reply.code(204).send();
  });

  app.get<P>("/v1/templates/:id/documents/:documentId/file", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const d = await s.db.one<any>(
      `SELECT f.storage_key FROM template_documents d JOIN files f ON f.id = d.file_id WHERE d.id = $1 AND d.template_id = $2 AND d.tenant_id = $3`,
      [req.params.documentId, req.params.id, a.tenantId],
    );
    if (!d) throw notFound("Documento");
    reply.header("content-type", "application/pdf").header("cache-control", "private, max-age=300");
    return reply.send(Buffer.from(await s.blobs.get(d.storage_key)));
  });

  // ───────── Roles y campos ─────────

  app.put<P>("/v1/templates/:id/roles", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = PutTemplateRolesInput.parse(req.body);
    await s.db.tx(async (t) => {
      const tpl = await lockTemplate(t, a.tenantId, req.params.id);
      const list = input.roles.map((r) => ({ ...r, id: r.id ?? uuidv7() }));
      const ids = list.map((r) => r.id);
      if (new Set(ids).size !== ids.length) throw badRequest("duplicate_ids", "Ids de roles repetidos");
      const names = list.map((r) => r.name.toLowerCase());
      if (new Set(names).size !== names.length) throw badRequest("duplicate_roles", "Hay dos roles con el mismo nombre");
      const foreign = await t.query(`SELECT id FROM template_roles WHERE id = ANY($1) AND template_id <> $2`, [ids, tpl.id]);
      if (foreign.length) throw badRequest("id_in_use", "Id de rol en uso");
      await t.query(`DELETE FROM template_roles WHERE template_id = $1 AND NOT (id = ANY($2))`, [tpl.id, ids]);
      for (const [i, r] of list.entries()) {
        await t.query(
          `INSERT INTO template_roles (id, tenant_id, template_id, name, role, routing_order, position) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, routing_order = EXCLUDED.routing_order, position = EXCLUDED.position`,
          [r.id, a.tenantId, tpl.id, r.name, r.role, r.routingOrder, i],
        );
        if (r.signatureType === "certificate" && r.role !== "signer") throw badRequest("certificate_not_applicable", "Solo un rol firmante puede firmar con certificado");
        if (r.signatureType !== undefined || r.certificateRequirements !== undefined) {
          await t.query(
            `UPDATE template_roles SET signature_type = COALESCE($2, signature_type),
               certificate_requirements = CASE WHEN $3::boolean THEN $4::jsonb ELSE certificate_requirements END WHERE id = $1`,
            [r.id, r.signatureType ?? null, r.certificateRequirements !== undefined, r.certificateRequirements ? JSON.stringify(r.certificateRequirements) : null],
          );
        }
      }
      await t.query(`UPDATE template_roles SET signature_type = 'electronic' WHERE template_id = $1 AND role <> 'signer'`, [tpl.id]);
      await t.query(`DELETE FROM template_fields f USING template_roles r WHERE f.role_id = r.id AND r.template_id = $1 AND r.role = 'cc'`, [tpl.id]);
      await touch(t, tpl.id);
    });
    return loadTemplateDetail(s.db, a.tenantId, req.params.id);
  });

  app.put<P>("/v1/templates/:id/fields", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = PutTemplateFieldsInput.parse(req.body);
    assignFieldIds(input.fields);
    await s.db.tx(async (t) => {
      const tpl = await lockTemplate(t, a.tenantId, req.params.id);
      const docs = new Map((await t.query<any>(`SELECT id, page_count FROM template_documents WHERE template_id = $1`, [tpl.id])).map((d) => [d.id, d]));
      const signerRoles = new Set(
        (await t.query<any>(`SELECT id FROM template_roles WHERE template_id = $1 AND role = 'signer'`, [tpl.id])).map((r) => r.id),
      );
      await t.query(`DELETE FROM template_fields WHERE template_id = $1`, [tpl.id]);
      for (const [i, f] of input.fields.entries()) {
        const d = docs.get(f.documentId);
        if (!d) throw badRequest("invalid_field", `Campo ${i + 1}: documento inexistente`);
        if (f.page >= d.page_count) throw badRequest("invalid_field", `Campo ${i + 1}: página fuera de rango`);
        if (!signerRoles.has(f.roleId)) throw badRequest("invalid_field", `Campo ${i + 1}: el rol no es firmante en esta plantilla`);
        let value: string | null;
        try {
          value = checkSenderValue({ ...f, label: f.label ?? null }, `Campo ${i + 1}`);
        } catch (err) {
          throw badRequest("invalid_field", (err as Error).message);
        }
        await insertTemplateField(t, a.tenantId, tpl.id, {
          id: f.id,
          documentId: f.documentId,
          roleId: f.roleId,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required ?? true,
          label: f.label ?? null,
          value,
          readOnly: Boolean(f.readOnly && value),
          options: f.options ?? null,
          min: f.min ?? null,
          max: f.max ?? null,
        });
      }
      await saveFieldLogic(t, "template_fields", input.fields);
      await touch(t, tpl.id);
    });
    return loadTemplateDetail(s.db, a.tenantId, req.params.id);
  });

  // ───────── Plantilla desde un sobre existente ─────────

  app.post<P>("/v1/templates/from-envelope/:envelopeId", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = TemplateFromEnvelopeInput.parse(req.body ?? {});
    const env = await s.db.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.envelopeId, a.tenantId]);
    if (!env) throw notFound("Sobre");
    const id = uuidv7();
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO templates (id, tenant_id, name, description, subject, message, locale, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, a.tenantId, input.name, input.description ?? null, env.subject, env.message, env.locale, a.userId],
      );
      const docs = await loadDocuments(t, env.id);
      const docMap = new Map<string, string>();
      for (const d of docs) {
        const nd = uuidv7();
        docMap.set(d.id, nd);
        // Los archivos son inmutables: la plantilla referencia el mismo archivo original.
        await t.query(
          `INSERT INTO template_documents (id, tenant_id, template_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [nd, a.tenantId, id, d.position, d.name, d.file_id, d.page_count, JSON.stringify(d.pages)],
        );
      }
      // Los destinatarios reemplazados (delegó / reasignado) no son un rol: su reemplazo ya está en la lista.
      const recips = await t.query<any>(
        `SELECT * FROM recipients WHERE envelope_id = $1 AND status NOT IN ('delegated','reassigned') ORDER BY routing_order, created_at, id`,
        [env.id],
      );
      const roleMap = new Map<string, string>();
      let signerN = 0;
      let ccN = 0;
      let approverN = 0;
      for (const [i, r] of recips.entries()) {
        const rid = uuidv7();
        roleMap.set(r.id, rid);
        const role = r.role === "cc" ? "cc" : r.role === "approver" ? "approver" : "signer";
        const name = role === "cc" ? `Copia ${++ccN}` : role === "approver" ? `Aprobador ${++approverN}` : `Firmante ${++signerN}`;
        await t.query(`INSERT INTO template_roles (id, tenant_id, template_id, name, role, routing_order, position) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
          rid,
          a.tenantId,
          id,
          name,
          role,
          r.routing_order,
          i,
        ]);
        if (r.role === "signer" && r.signature_type === "certificate")
          await t.query(`UPDATE template_roles SET signature_type = 'certificate', certificate_requirements = $2 WHERE id = $1`, [
            rid,
            r.certificate_requirements ? JSON.stringify(r.certificate_requirements) : null,
          ]);
      }
      const fields = await t.query<any>(`SELECT * FROM fields WHERE envelope_id = $1`, [env.id]);
      const fieldMap = new Map<string, string>();
      for (const f of fields) {
        const roleId = roleMap.get(f.recipient_id);
        const documentId = docMap.get(f.document_id);
        if (!roleId || !documentId) continue;
        fieldMap.set(f.id, uuidv7());
        await insertTemplateField(t, a.tenantId, id, {
          id: fieldMap.get(f.id),
          documentId,
          roleId,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
          label: f.label,
          // Solo se conservan los valores que fijó el remitente, no lo que escribieron los firmantes.
          value: f.read_only ? f.value : null,
          readOnly: Boolean(f.read_only),
          options: f.options ?? null,
          min: f.min_value ?? null,
          max: f.max_value ?? null,
        });
      }
      await copyFieldLogic(t, "template_fields", fields, fieldMap);
    });
    reply.code(201);
    return loadTemplateDetail(s.db, a.tenantId, id);
  });

  // ───────── Sobre desde plantilla ─────────

  app.post("/v1/envelopes/from-template", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = EnvelopeFromTemplateInput.parse(req.body);
    // Una plantilla restringida (compartida solo con algunos grupos) no se puede usar sin poder verla.
    await assertTemplateAccess(s.db, a, input.templateId, "view");
    const loaded = await loadTemplateForUse(s.db, a.tenantId, input.templateId);
    const plan = planFromTemplate(loaded, input);
    const envId = await s.db.tx((t) => insertEnvelopeFromTemplate(t, { tenantId: a.tenantId, userId: a.userId, apiKeyId: a.apiKeyId, actor: a.actor }, loaded, input, plan));
    reply.code(201);
    return loadDetail(s.db, a.tenantId, envId);
  });
}

// ───────────────────────────── Creación de sobres desde plantilla (reutilizable) ─────────────────────────────
// La usan /v1/envelopes/from-template, el envío masivo y los formularios web.

type FromTemplateInput = ReturnType<typeof EnvelopeFromTemplateInput.parse>;

export interface LoadedTemplate {
  tpl: TemplateDetail;
  row: any;
  docs: any[];
}

export async function loadTemplateForUse(db: Db, tenantId: string, templateId: string): Promise<LoadedTemplate> {
  const tpl = await loadTemplateDetail(db, tenantId, templateId);
  const row = await db.one<any>(`SELECT * FROM templates WHERE id = $1`, [tpl.template.id]);
  const docs = await loadTemplateDocuments(db, tpl.template.id);
  if (docs.length === 0) throw badRequest("template_empty", "La plantilla no tiene documentos");
  return { tpl, row, docs };
}

export interface TemplatePlan {
  assigned: Map<string, FromTemplateInput["recipients"][number]>;
  /** Valor final de cada campo de la plantilla (prellenado o el fijado en la plantilla). */
  values: Map<string, string | null>;
}

/** Valida destinatarios y prellenado contra la plantilla, sin tocar la base. Lanza AppError con el problema. */
export function planFromTemplate(l: LoadedTemplate, input: FromTemplateInput): TemplatePlan {
  const { tpl } = l;
  const byName = new Map(tpl.roles.map((r) => [r.name.toLowerCase(), r]));
  const assigned = new Map<string, FromTemplateInput["recipients"][number]>();
  for (const r of input.recipients) {
    const role = r.roleId ? tpl.roles.find((x) => x.id === r.roleId) : byName.get((r.role ?? "").toLowerCase());
    if (!role) throw badRequest("unknown_role", `Rol desconocido: ${r.roleId ?? r.role}`);
    if (assigned.has(role.id)) throw badRequest("duplicate_role", `El rol ${role.name} tiene más de un destinatario`);
    assigned.set(role.id, r);
  }
  const missingRoles = tpl.roles.filter((r) => !assigned.has(r.id));
  if (missingRoles.length) {
    throw new AppError(422, "roles_missing", `Faltan destinatarios para: ${missingRoles.map((r) => r.name).join(", ")}`, {
      roles: missingRoles.map((r) => r.name),
    });
  }

  // Prellenado: por id de campo o por etiqueta (sin distinguir mayúsculas).
  const prefill = new Map<string, string>();
  for (const [k, v] of Object.entries(input.prefill ?? {})) {
    const matches = tpl.fields.filter((f) => f.id === k || (f.label && f.label.toLowerCase() === k.toLowerCase()));
    if (matches.length === 0) throw badRequest("unknown_prefill", `No hay ningún campo "${k}" en la plantilla`);
    for (const f of matches) prefill.set(f.id, v);
  }
  const values = new Map<string, string | null>();
  for (const f of tpl.fields) {
    const pre = prefill.get(f.id);
    let value = f.value;
    if (pre !== undefined) {
      if (f.readOnly) throw badRequest("readonly_field", `El campo "${f.label ?? f.id}" es de solo lectura en la plantilla`);
      try {
        value = checkSenderValue({ ...f, value: pre }, `Campo "${f.label ?? f.id}"`);
      } catch (err) {
        throw badRequest("invalid_prefill", (err as Error).message);
      }
    }
    values.set(f.id, value);
  }
  return { assigned, values };
}

export interface FromTemplateContext {
  tenantId: string;
  userId: string | null;
  apiKeyId: string | null;
  actor: Actor;
}

/** Crea el sobre (y lo envía si input.send) dentro de la transacción del llamador. Devuelve su id. */
export async function insertEnvelopeFromTemplate(
  t: Db,
  ctx: FromTemplateContext,
  l: LoadedTemplate,
  input: FromTemplateInput,
  plan: TemplatePlan,
  extraMetadata: Record<string, unknown> = {},
  /** Recibe rol de la plantilla → id del destinatario creado. */
  onRecipients?: (byRole: Map<string, string>) => void,
): Promise<string> {
  const { tpl, row: tplRow, docs: tplDocs } = l;
  const envId = uuidv7();
  const tenant = await t.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [ctx.tenantId]);
  const subject = input.subject ?? tplRow.subject ?? tplRow.name;
  await t.query(
    `INSERT INTO envelopes (id, tenant_id, created_by, created_via, subject, message, locale, expires_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      envId,
      ctx.tenantId,
      ctx.userId,
      ctx.apiKeyId ? "api" : "web",
      subject,
      input.message !== undefined ? input.message : tplRow.message,
      input.locale ?? tplRow.locale ?? tenant?.default_locale ?? "es",
      input.expiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
      JSON.stringify({ ...(input.metadata ?? {}), ...extraMetadata, templateId: tpl.template.id }),
    ],
  );
  await appendEvent(t, {
    tenantId: ctx.tenantId,
    envelopeId: envId,
    type: "envelope.created",
    actor: ctx.actor,
    data: { subject, templateId: tpl.template.id, templateName: tplRow.name, ...extraMetadata },
  });
  const docMap = new Map<string, string>();
  for (const d of tplDocs) {
    const nd = uuidv7();
    docMap.set(d.id, nd);
    await t.query(
      `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [nd, ctx.tenantId, envId, d.position, d.name, d.file_id, d.page_count, JSON.stringify(d.pages)],
    );
    await appendEvent(t, {
      tenantId: ctx.tenantId,
      envelopeId: envId,
      type: "document.added",
      actor: ctx.actor,
      data: { documentId: nd, name: d.name, sha256: d.sha256, pages: d.page_count, fromTemplate: true },
    });
  }
  const recMap = new Map<string, string>();
  for (const role of tpl.roles) {
    const r = plan.assigned.get(role.id)!;
    const rid = uuidv7();
    recMap.set(role.id, rid);
    await t.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, locale, channels, telegram_chat_id, id_document_type, id_document_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        rid,
        ctx.tenantId,
        envId,
        role.role,
        role.routingOrder,
        r.name,
        r.email ?? null,
        r.phone ?? null,
        r.locale ?? null,
        r.channels ?? ["email"],
        r.telegramChatId ?? null,
        r.idDocumentType ?? null,
        r.idDocumentNumber ?? null,
      ],
    );
    // Firma con certificado: la hereda del rol de la plantilla (sobres, envíos masivos y formularios web).
    await t.query(
      `UPDATE recipients SET signature_type = tr.signature_type, certificate_requirements = tr.certificate_requirements
       FROM template_roles tr WHERE recipients.id = $1 AND tr.id = $2 AND tr.signature_type = 'certificate' AND recipients.role = 'signer'`,
      [rid, role.id],
    );
  }
  onRecipients?.(recMap);
  const fieldMap = new Map<string, string>();
  for (const f of tpl.fields) {
    const recipientId = recMap.get(f.roleId);
    const documentId = docMap.get(f.documentId);
    if (!recipientId || !documentId) continue;
    const value = plan.values.get(f.id) ?? null;
    fieldMap.set(f.id, uuidv7());
    await insertEnvelopeField(t, {
      id: fieldMap.get(f.id)!,
      tenantId: ctx.tenantId,
      envelopeId: envId,
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
      value,
      readOnly: Boolean(f.readOnly && value),
      options: f.options,
      min: f.min,
      max: f.max,
    });
  }
  await copyFieldLogic(t, "fields", tpl.fields, fieldMap);
  if (input.send) await sendEnvelope(t, ctx.tenantId, envId, ctx.actor);
  return envId;
}
