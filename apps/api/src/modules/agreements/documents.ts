// Generación de documentos: plantillas con variables, condicionales, bucles y cláusulas → PDF con
// espacios de firma → sobre listo para firmar.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ClauseInput,
  DocumentTemplateInput,
  GenerateDocumentInput,
  RenderDocumentInput,
  UpdateDocumentTemplateInput,
  analyzeTemplate,
  blocksToText,
  renderTemplate,
  TemplateSyntaxError,
  type AgreementMapping,
  type Clause,
  type DocumentTemplate,
  type GenerateRecipientInput,
  type MarkKind,
  type RenderPreviewResponse,
} from "@calasign/shared";
import { inspectPdf, renderDocumentPdf, type DocMarkPosition } from "@calasign/pdf";
import { z } from "zod";
import type { Db } from "../../infra/db";
import { appendEvent, type Actor } from "../../infra/evidence";
import type { BlobStore } from "../../infra/storage";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors";
import { iso, likeContains, sha256Hex, uuidv7 } from "../../lib/util";
import { requirePerm } from "../access";
import { auditFromRequest } from "../audit";
import { getTenantBranding } from "../branding";
import { authenticate, type AuthContext, type Services } from "../context";
import { sendEnvelope, idempotent } from "../envelopes";
import { insertEnvelopeField } from "../fieldvalues";
import { discardBlobsOnFailure } from "../file-cleanup";
import { getPath, interpolate, toIsoDate, toNumberOrNull } from "./common";

// ───────────────────────────── Render ─────────────────────────────

export async function loadClauseMap(db: Db, tenantId: string): Promise<Record<string, string>> {
  const rows = await db.query<any>(`SELECT slug, body FROM clauses WHERE tenant_id = $1`, [tenantId]);
  return Object.fromEntries(rows.map((r) => [r.slug, r.body]));
}

export interface RenderedDocument {
  pdf: Uint8Array;
  marks: DocMarkPosition[];
  pageCount: number;
  missing: string[];
  missingClauses: string[];
  text: string;
}

/** Plantilla + datos → PDF. Lanza 400 con la línea si hay un error de sintaxis. */
export async function renderDocument(
  db: Db,
  tenantId: string,
  p: { source: string; data: unknown; locale: string; title?: string; clauses?: Record<string, string> },
): Promise<RenderedDocument> {
  const clauses = p.clauses ?? (await loadClauseMap(db, tenantId));
  let r;
  try {
    r = renderTemplate(p.source, p.data, { clauses, locale: p.locale });
  } catch (e) {
    if (e instanceof TemplateSyntaxError) throw badRequest("template_syntax", e.message, { line: e.line });
    throw e;
  }
  const brand = await getTenantBranding(db, tenantId);
  const org = await db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
  const out = await renderDocumentPdf(r.blocks, { title: p.title, locale: p.locale, accent: brand.primaryColor, footer: org?.name ?? null });
  return { ...out, missing: r.missing, missingClauses: r.missingClauses, text: blocksToText(r.blocks) };
}

/** Sube el PDF y devuelve los datos del archivo (antes de abrir una transacción). */
export async function storeGeneratedPdf(blobs: BlobStore, tenantId: string, pdf: Uint8Array) {
  const fileId = uuidv7();
  const key = `tenants/${tenantId}/generated/${fileId}.pdf`;
  // Primero se inspecciona: si falla, no queda un PDF subido que nada referencia.
  const info = await inspectPdf(pdf);
  await blobs.put(key, pdf, "application/pdf");
  return { fileId, key, sha256: sha256Hex(pdf), size: pdf.length, info };
}

export async function insertFileRow(db: Db, tenantId: string, f: { fileId: string; key: string; sha256: string; size: number }) {
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',$4,$5)
     ON CONFLICT (id) DO NOTHING`,
    [f.fileId, tenantId, f.key, f.size, f.sha256],
  );
}

const FIELD_TYPE: Record<MarkKind, string> = { signature: "signature", initials: "initials", date: "date_signed", name: "name" };

export interface PdfEnvelopeSpec {
  file: { fileId: string; key: string; sha256: string; size: number; info: { pageCount: number; pages: { width: number; height: number }[] } };
  fileName: string;
  subject: string;
  message?: string | null;
  locale: string;
  expiresAt?: string | null;
  recipients: GenerateRecipientInput[];
  marks: DocMarkPosition[];
  metadata?: Record<string, unknown>;
  send: boolean;
}

/** Crea el sobre a partir de un PDF generado. Debe correr dentro de una transacción. Devuelve el id del sobre. */
export async function createEnvelopeFromPdf(
  t: Db,
  ctx: { tenantId: string; userId: string | null; apiKeyId: string | null; actor: Actor },
  spec: PdfEnvelopeSpec,
): Promise<string> {
  const signers = spec.recipients.filter((r) => !r.cc);
  // Cada rol de firma es de un solo firmante: con dos "Cliente", las marcas del documento iban todas al último y el
  // otro quedaba sin campos (el envío fallaba con "no tiene ningún campo de firma"; como borrador, pasaba sin aviso).
  const seenRoles = new Set<string>();
  const dupRoles = [...new Set(signers.map((r) => r.role.toLowerCase()).filter((k) => (seenRoles.has(k) ? true : (seenRoles.add(k), false))))];
  if (dupRoles.length) {
    throw new AppError(422, "duplicate_roles", `Cada rol firma una sola vez; repetidos: ${dupRoles.join(", ")}`, { roles: dupRoles });
  }
  const markRoles = [...new Set(spec.marks.map((m) => m.role))];
  const byRole = new Map(signers.map((r) => [r.role.toLowerCase(), r]));
  const missingRoles = markRoles.filter((r) => !byRole.has(r.toLowerCase()));
  if (missingRoles.length) throw new AppError(422, "missing_roles", `Faltan firmantes para: ${missingRoles.join(", ")}`, { missingRoles });
  const unknown = signers.filter((r) => !spec.marks.some((m) => m.role.toLowerCase() === r.role.toLowerCase() && m.kind === "signature"));
  if (unknown.length) {
    throw new AppError(422, "unknown_roles", `Estos firmantes no tienen espacio de firma ({{firma:Rol}}) en el documento: ${unknown.map((u) => u.role).join(", ")}`, {
      roles: unknown.map((u) => u.role),
    });
  }
  for (const r of spec.recipients) {
    if (!r.email && !r.phone) throw new AppError(422, "recipient_contact", `${r.name}: falta correo o teléfono`);
  }

  // El asunto puede salir de datos interpolados (sin tope, con saltos de línea o vacío): como en los demás caminos.
  const subject = (spec.subject.replace(/\s+/g, " ").trim() || spec.fileName).slice(0, 300);
  await insertFileRow(t, ctx.tenantId, spec.file);
  const envId = uuidv7();
  await t.query(
    `INSERT INTO envelopes (id, tenant_id, created_by, created_by_api_key, created_via, subject, message, locale, expires_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      envId,
      ctx.tenantId,
      ctx.userId,
      ctx.apiKeyId,
      ctx.apiKeyId ? "api" : "web",
      subject,
      spec.message ?? null,
      spec.locale,
      // Ausente o null: 30 días (ver GenerateDocumentInput.expiresAt; a diferencia de los sobres sueltos, null no es
      // sin vencimiento acá).
      spec.expiresAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
      JSON.stringify(spec.metadata ?? {}),
    ],
  );
  await appendEvent(t, { tenantId: ctx.tenantId, envelopeId: envId, type: "envelope.created", actor: ctx.actor, data: { subject, generated: true } });
  const docId = uuidv7();
  await t.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,$4,$5,$6,$7)`, [
    docId,
    ctx.tenantId,
    envId,
    spec.fileName.slice(0, 200),
    spec.file.fileId,
    spec.file.info.pageCount,
    JSON.stringify(spec.file.info.pages),
  ]);
  await appendEvent(t, {
    tenantId: ctx.tenantId,
    envelopeId: envId,
    type: "document.added",
    actor: ctx.actor,
    data: { documentId: docId, name: spec.fileName, sha256: spec.file.sha256, pages: spec.file.info.pageCount, generated: true },
  });
  // Orden de firma: el indicado, o el orden de aparición de los roles en el documento (en paralelo si no se indica).
  const recIds = new Map<string, string>();
  for (const r of spec.recipients) {
    const id = uuidv7();
    // Solo los firmantes reciben las marcas de su rol: una copia (cc) con el mismo nombre de rol se quedaba con los
    // campos de firma del firmante.
    if (!r.cc) recIds.set(r.role.toLowerCase(), id);
    await t.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, locale, channels)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        ctx.tenantId,
        envId,
        r.cc ? "cc" : "signer",
        r.routingOrder ?? (r.cc ? 99 : 1),
        r.name,
        r.email ?? null,
        r.phone ?? null,
        r.locale ?? null,
        r.channels ?? (r.email ? ["email"] : ["whatsapp"]),
      ],
    );
  }
  for (const m of spec.marks) {
    const recipientId = recIds.get(m.role.toLowerCase());
    if (!recipientId) continue;
    await insertEnvelopeField(t, {
      id: uuidv7(),
      tenantId: ctx.tenantId,
      envelopeId: envId,
      documentId: docId,
      recipientId,
      type: FIELD_TYPE[m.kind],
      page: m.page,
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
      required: true,
      label: null,
      value: null,
      readOnly: false,
      options: null,
      min: null,
      max: null,
    });
  }
  if (spec.send) await sendEnvelope(t, ctx.tenantId, envId, ctx.actor);
  return envId;
}

/** Metadatos para el repositorio a partir del mapeo de la plantilla (se guardan en el sobre). */
export function agreementMetaFromMapping(mapping: AgreementMapping | null | undefined, data: unknown, locale: string) {
  if (!mapping) return null;
  const val = (src: string | null | undefined) => (src ? interpolate(src.includes("{{") ? src : `{{${src}}}`, data, locale) : "");
  const raw = (src: string | null | undefined) => (src && !src.includes("{{") ? getPath(data, src) : val(src));
  const out: Record<string, unknown> = {};
  if (mapping.title) out.title = interpolate(mapping.title, data, locale) || undefined;
  const v = toNumberOrNull(raw(mapping.value));
  if (v !== null) out.value = v;
  if (mapping.currency) out.currency = mapping.currency.toUpperCase();
  const eff = toIsoDate(raw(mapping.effectiveDate));
  if (eff) out.effectiveDate = eff;
  const exp = toIsoDate(raw(mapping.expiryDate));
  if (exp) out.expiryDate = exp;
  if (mapping.tags?.length) out.tags = mapping.tags;
  return out;
}

// ───────────────────────────── Mapeo ─────────────────────────────

function toTemplate(r: any, clauses: Record<string, string>): DocumentTemplate {
  let analysis = null;
  let syntaxError: string | null = null;
  try {
    analysis = analyzeTemplate(r.source, clauses);
  } catch (e) {
    syntaxError = e instanceof Error ? e.message : String(e);
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    locale: r.locale,
    source: r.source,
    sampleData: r.sample_data,
    agreementMapping: r.agreement_mapping,
    analysis,
    syntaxError,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const toClause = (r: any): Clause => ({ id: r.id, slug: r.slug, title: r.title, body: r.body, category: r.category, updatedAt: iso(r.updated_at)! });

export async function loadDocTemplate(db: Db, tenantId: string, id: string) {
  const r = await db.one<any>(`SELECT * FROM document_templates WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL`, [id, tenantId]);
  if (!r) throw notFound("Plantilla de documento");
  return r;
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function documentRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  app.get<{ Querystring: { q?: string } }>("/v1/document-templates", { preHandler: auth }, async (req) => {
    const a = A(req);
    const params: unknown[] = [a.tenantId];
    let where = `tenant_id = $1 AND archived_at IS NULL`;
    if (req.query.q) {
      // % y _ se buscan como texto (como en sobres y plantillas).
      params.push(likeContains(String(req.query.q)));
      where += ` AND name ILIKE $2 ESCAPE '\\'`;
    }
    const rows = await s.db.query(`SELECT * FROM document_templates WHERE ${where} ORDER BY updated_at DESC LIMIT 200`, params);
    const clauses = await loadClauseMap(s.db, a.tenantId);
    return { items: rows.map((r) => toTemplate(r, clauses)) };
  });

  app.post("/v1/document-templates", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const input = DocumentTemplateInput.parse(req.body);
    const tenant = await s.db.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
    const row = await s.db.one(
      `INSERT INTO document_templates (id, tenant_id, name, description, locale, source, sample_data, agreement_mapping, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        uuidv7(),
        a.tenantId,
        input.name,
        input.description ?? null,
        input.locale ?? tenant?.default_locale ?? "es",
        input.source,
        input.sampleData ? JSON.stringify(input.sampleData) : null,
        input.agreementMapping ? JSON.stringify(input.agreementMapping) : null,
        a.userId,
      ],
    );
    await auditFromRequest(s.db, req, a, "document_template.created", { targetType: "document_template", targetId: (row as any).id, data: { name: input.name } });
    reply.code(201);
    return toTemplate(row, await loadClauseMap(s.db, a.tenantId));
  });

  app.get<{ Params: { id: string } }>("/v1/document-templates/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    return toTemplate(await loadDocTemplate(s.db, a.tenantId, req.params.id), await loadClauseMap(s.db, a.tenantId));
  });

  app.patch<{ Params: { id: string } }>("/v1/document-templates/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const cur = await loadDocTemplate(s.db, a.tenantId, req.params.id);
    const input = UpdateDocumentTemplateInput.parse(req.body);
    const row = await s.db.one(
      `UPDATE document_templates SET name = $2, description = $3, locale = $4, source = $5, sample_data = $6, agreement_mapping = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        cur.id,
        input.name ?? cur.name,
        input.description !== undefined ? input.description : cur.description,
        input.locale ?? cur.locale,
        input.source ?? cur.source,
        input.sampleData !== undefined ? (input.sampleData ? JSON.stringify(input.sampleData) : null) : cur.sample_data ? JSON.stringify(cur.sample_data) : null,
        input.agreementMapping !== undefined
          ? input.agreementMapping
            ? JSON.stringify(input.agreementMapping)
            : null
          : cur.agreement_mapping
            ? JSON.stringify(cur.agreement_mapping)
            : null,
      ],
    );
    // El texto de la plantilla es lo que firman los documentos que genera: quién lo cambió queda en la auditoría.
    await auditFromRequest(s.db, req, a, "document_template.updated", { targetType: "document_template", targetId: cur.id, data: { name: (row as any).name, fields: Object.keys((req.body as object) ?? {}) } });
    return toTemplate(row, await loadClauseMap(s.db, a.tenantId));
  });

  app.delete<{ Params: { id: string } }>("/v1/document-templates/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const cur = await loadDocTemplate(s.db, a.tenantId, req.params.id);
    // Archivada (no borrada): negociaciones y workflows pueden referenciarla.
    await s.db.query(`UPDATE document_templates SET archived_at = now() WHERE id = $1`, [cur.id]);
    await auditFromRequest(s.db, req, a, "document_template.deleted", { targetType: "document_template", targetId: cur.id, data: { name: cur.name } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/document-templates/:id/preview", { preHandler: auth }, async (req): Promise<RenderPreviewResponse> => {
    const a = A(req);
    const cur = await loadDocTemplate(s.db, a.tenantId, req.params.id);
    const body = (req.body ?? {}) as { data?: Record<string, unknown> };
    const clauses = await loadClauseMap(s.db, a.tenantId);
    try {
      const r = renderTemplate(cur.source, body.data ?? cur.sample_data ?? {}, { clauses, locale: cur.locale, missing: "placeholder" });
      return { blocks: r.blocks, missing: r.missing, missingClauses: r.missingClauses, analysis: analyzeTemplate(cur.source, clauses) };
    } catch (e) {
      if (e instanceof TemplateSyntaxError) throw badRequest("template_syntax", e.message, { line: e.line });
      throw e;
    }
  });

  // PDF de prueba: de una plantilla guardada (templateId) o de un texto sin guardar (source).
  app.post("/v1/document-templates/render", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = RenderDocumentInput.extend({ templateId: z.string().uuid().optional() }).parse(req.body);
    let source = input.source;
    let locale = input.locale ?? "es";
    let title = input.title ?? "Documento";
    if (input.templateId) {
      const t = await loadDocTemplate(s.db, a.tenantId, input.templateId);
      source ??= t.source;
      locale = input.locale ?? t.locale;
      title = input.title ?? t.name;
    }
    if (source == null) throw badRequest("source_required", "Falta source o templateId");
    const doc = await renderDocument(s.db, a.tenantId, { source, data: input.data, locale, title });
    reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="vista-previa.pdf"`)
      .header("x-calasign-missing", encodeURIComponent(doc.missing.join(",")))
      .header("cache-control", "no-store");
    return reply.send(Buffer.from(doc.pdf));
  });

  // Con Idempotency-Key, como POST /v1/envelopes: un reintento después de un timeout no crea ni envía otro sobre.
  app.post<{ Params: { id: string } }>("/v1/document-templates/:id/generate", { preHandler: auth }, async (req, reply) =>
    idempotent(s, req, reply, async () => {
      const a = A(req);
      requirePerm(a, "envelopes:create");
      const input = GenerateDocumentInput.parse(req.body);
      const tpl = await loadDocTemplate(s.db, a.tenantId, req.params.id);
      const locale = input.locale ?? tpl.locale;
      const doc = await renderDocument(s.db, a.tenantId, { source: tpl.source, data: input.data, locale, title: input.subject ?? tpl.name });
      if (doc.missingClauses.length) throw new AppError(422, "missing_clauses", `Cláusulas inexistentes: ${doc.missingClauses.join(", ")}`, { missingClauses: doc.missingClauses });
      if (doc.missing.length && !input.allowMissing) {
        throw new AppError(422, "missing_variables", `Faltan datos: ${doc.missing.join(", ")}`, { missing: doc.missing });
      }
      const subject = input.subject ?? (interpolate(tpl.agreement_mapping?.title, input.data, locale) || tpl.name);
      const file = await storeGeneratedPdf(s.blobs, a.tenantId, doc.pdf);
      const agreement = agreementMetaFromMapping(tpl.agreement_mapping, input.data, locale);
      // Si no se crea el sobre (p. ej. límite del plan al enviarlo), el PDF generado no lo referencia nada.
      const envelopeId = await discardBlobsOnFailure(s.blobs, [file.key], () => s.db.tx((t) =>
        createEnvelopeFromPdf(t, a, {
          file,
          fileName: `${tpl.name}.pdf`,
          subject,
          message: input.message ?? null,
          locale,
          expiresAt: input.expiresAt ?? null,
          recipients: input.recipients,
          marks: doc.marks,
          metadata: {
            ...(input.metadata ?? {}),
            documentTemplateId: tpl.id,
            dataSha256: sha256Hex(JSON.stringify(input.data)),
            ...(agreement ? { agreement } : {}),
          },
          send: input.send,
        }),
      ));
      const env = await s.db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [envelopeId]);
      return { status: 201, body: { envelopeId, status: env.status, missing: doc.missing, pages: doc.pageCount } };
    }),
  );

  // ───────── Cláusulas ─────────

  app.get("/v1/clauses", { preHandler: auth }, async (req) => ({
    items: (await s.db.query(`SELECT * FROM clauses WHERE tenant_id = $1 ORDER BY category NULLS LAST, title`, [A(req).tenantId])).map(toClause),
  }));

  app.post("/v1/clauses", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const input = ClauseInput.parse(req.body);
    checkClauseSyntax(input.body);
    const row = await s.db
      .one(`INSERT INTO clauses (id, tenant_id, slug, title, body, category) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
        uuidv7(),
        a.tenantId,
        input.slug,
        input.title,
        input.body,
        input.category ?? null,
      ])
      .catch((e) => {
        if (/unique|duplicate/i.test(String(e))) throw conflict("duplicate_slug", "Ya existe una cláusula con ese código");
        throw e;
      });
    await auditFromRequest(s.db, req, a, "clause.created", { targetType: "clause", targetId: (row as any).id, data: { slug: input.slug, title: input.title } });
    reply.code(201);
    return toClause(row);
  });

  app.patch<{ Params: { id: string } }>("/v1/clauses/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const cur = await s.db.one<any>(`SELECT * FROM clauses WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!cur) throw notFound("Cláusula");
    const input = ClauseInput.parse({ slug: cur.slug, title: cur.title, body: cur.body, category: cur.category, ...(req.body as object) });
    if (input.slug !== cur.slug) throw badRequest("immutable_slug", "El código de una cláusula no se puede cambiar (lo citan las plantillas)");
    checkClauseSyntax(input.body);
    const row = await s.db.one(`UPDATE clauses SET title = $2, body = $3, category = $4, updated_at = now() WHERE id = $1 RETURNING *`, [
      cur.id,
      input.title,
      input.body,
      input.category ?? null,
    ]);
    await auditFromRequest(s.db, req, a, "clause.updated", { targetType: "clause", targetId: cur.id, data: { slug: cur.slug, fields: Object.keys((req.body as object) ?? {}) } });
    return toClause(row);
  });

  app.delete<{ Params: { id: string } }>("/v1/clauses/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const r = await s.db.query<any>(`DELETE FROM clauses WHERE id = $1 AND tenant_id = $2 RETURNING id, slug, title`, [req.params.id, a.tenantId]);
    if (!r.length) throw notFound("Cláusula");
    await auditFromRequest(s.db, req, a, "clause.deleted", { targetType: "clause", targetId: r[0].id, data: { slug: r[0].slug, title: r[0].title } });
    return reply.code(204).send();
  });
}

function checkClauseSyntax(body: string) {
  try {
    renderTemplate(body, {});
  } catch (e) {
    if (e instanceof TemplateSyntaxError) throw badRequest("template_syntax", e.message, { line: e.line });
    throw e;
  }
}
