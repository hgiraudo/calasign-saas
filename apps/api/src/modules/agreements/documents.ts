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
  checkClauseGraph,
  clauseRefs as parseRefs,
  parseTemplate,
  renderTemplate,
  roleKey,
  TemplateSyntaxError,
  type AgreementMapping,
  type Clause,
  type DocumentTemplate,
  type DocumentTemplateSummary,
  type GenerateWarning,
  type GenerateRecipientInput,
  type MarkKind,
  type RenderOptions,
  type RenderPreviewResponse,
  type RenderResult,
} from "@calasign/shared";
import { inspectPdf, renderDocumentPdf, type DocMarkPosition } from "@calasign/pdf";
import { z } from "zod";
import type { Db } from "../../infra/db";
import { appendEvent, type Actor } from "../../infra/evidence";
import type { BlobStore } from "../../infra/storage";
import { AppError, assertNotStale, badRequest, conflict, notFound } from "../../lib/errors";
import { iso, likeContains, sha256Hex, uuidv7 } from "../../lib/util";
import { requirePerm } from "../access";
import { auditFromRequest } from "../audit";
import { getTenantBranding } from "../branding";
import { authenticate, type AuthContext, type Services } from "../context";
import { sendEnvelope, idempotent } from "../envelopes";
import { insertEnvelopeField } from "../fieldvalues";
import { discardBlobsOnFailure } from "../file-cleanup";
import { getPath, interpolate, interpolateValue, toIsoDate, toNumberOrNull } from "./common";

// ───────────────────────────── Render ─────────────────────────────

export async function loadClauseMap(db: Db, tenantId: string): Promise<Record<string, string>> {
  const rows = await db.query<any>(`SELECT slug, body FROM clauses WHERE tenant_id = $1`, [tenantId]);
  return Object.fromEntries(rows.map((r) => [r.slug, r.body]));
}

/** Constancia de qué texto se usó: sha256 de la fuente de la plantilla y de cada cláusula insertada. */
export interface DocumentProvenance {
  sourceSha256: string;
  clauses: Record<string, string>;
}

export interface RenderedDocument {
  pdf: Uint8Array;
  marks: DocMarkPosition[];
  pageCount: number;
  missing: string[];
  missingClauses: string[];
  text: string;
  provenance: DocumentProvenance;
  /** Roles de firma que la plantilla declara en cualquier rama. */
  templateRoles: string[];
}

/** Plantilla + datos → PDF. Lanza 400 con la línea si hay un error de sintaxis. */
export async function renderDocument(
  db: Db,
  tenantId: string,
  p: {
    source: string;
    data: unknown;
    locale: string;
    title?: string;
    clauses?: Record<string, string>;
    /**
     * Copia de cláusulas ya guardada (negociaciones): si cita cláusulas en ciclo o con demasiados niveles, se renderiza
     * con el comportamiento anterior (legacyClauseRecursion) en lugar de fallar. Ver renderTemplateCompat.
     */
    legacyClauseFallback?: boolean;
  },
): Promise<RenderedDocument> {
  const clauses = p.clauses ?? (await loadClauseMap(db, tenantId));
  let r;
  try {
    const opts = { clauses, locale: p.locale };
    r = p.legacyClauseFallback ? renderTemplateCompat(p.source, p.data, opts) : renderTemplate(p.source, p.data, opts);
  } catch (e) {
    if (e instanceof TemplateSyntaxError) throw badRequest("template_syntax", e.message, { line: e.line });
    throw e;
  }
  const brand = await getTenantBranding(db, tenantId);
  const org = await db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
  const out = await renderDocumentPdf(r.blocks, { title: p.title, locale: p.locale, accent: brand.primaryColor, footer: org?.name ?? null });
  const provenance: DocumentProvenance = {
    sourceSha256: sha256Hex(p.source),
    clauses: Object.fromEntries(r.usedClauses.sort().map((slug) => [slug, sha256Hex(clauses[slug] ?? "")])),
  };
  // Roles que la plantilla declara en alguna rama (también dentro de un {{#if}} que no se cumplió): solo esos se pueden
  // omitir sin error cuando el documento generado no tiene sus marcas (ver onSkippedRoles).
  const templateRoles = analyzeTemplate(p.source, clauses).roles;
  return { ...out, missing: r.missing, missingClauses: r.missingClauses, text: blocksToText(r.blocks), provenance, templateRoles };
}

/**
 * renderTemplate para documentos guardados antes de que el motor validara el grafo de cláusulas (p. ej. la copia de
 * cláusulas de una negociación creada antes, o editada con una propuesta): si la copia cita cláusulas en ciclo o con
 * más de MAX_CLAUSE_DEPTH niveles, se renderiza en modo compatible (hasta 3 niveles, lo que sigue se omite, como antes)
 * en lugar de dejar la negociación sin poder verse, descargarse ni aceptarse. Documentos nuevos: renderTemplate.
 */
export function renderTemplateCompat(source: string, data: unknown, opts: RenderOptions): RenderResult {
  try {
    return renderTemplate(source, data, opts);
  } catch (e) {
    if (e instanceof TemplateSyntaxError && (e.reason === "clause_cycle" || e.reason === "clause_depth")) {
      return renderTemplate(source, data, { ...opts, legacyClauseRecursion: true });
    }
    throw e;
  }
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
  /**
   * Con este callback, un firmante cuyo rol no tiene ninguna marca en el documento (p. ej. {{#if garante}}{{firma:Garante}}
   * {{/if}} con la condición falsa) no se agrega al sobre y se informa su rol, en vez de 422 unknown_roles. Solo para roles
   * que la plantilla declara (templateRoles): un rol que no figura en ninguna parte sigue dando 422 (p. ej. un error de tipeo).
   */
  onSkippedRoles?: (roles: string[]) => void;
  templateRoles?: string[];
}

/** Crea el sobre a partir de un PDF generado. Debe correr dentro de una transacción. Devuelve el id del sobre. */
export async function createEnvelopeFromPdf(
  t: Db,
  ctx: { tenantId: string; userId: string | null; apiKeyId: string | null; actor: Actor },
  spec: PdfEnvelopeSpec,
): Promise<string> {
  let recipientsIn = spec.recipients;
  if (spec.onSkippedRoles) {
    const marked = new Set(spec.marks.map((m) => roleKey(m.role)));
    const declared = new Set((spec.templateRoles ?? []).map(roleKey));
    const skipped = recipientsIn.filter((r) => !r.cc && !marked.has(roleKey(r.role)) && declared.has(roleKey(r.role)));
    // Si no queda ningún firmante, el error de siempre (unknown_roles): un sobre sin firmantes no sirve.
    if (skipped.length && skipped.length < recipientsIn.filter((r) => !r.cc).length) {
      recipientsIn = recipientsIn.filter((r) => !skipped.includes(r));
      spec.onSkippedRoles(skipped.map((r) => r.role));
    }
  }
  spec = { ...spec, recipients: recipientsIn };
  const signers = spec.recipients.filter((r) => !r.cc);
  // Cada rol de firma es de un solo firmante: con dos "Cliente", las marcas del documento iban todas al último y el
  // otro quedaba sin campos (el envío fallaba con "no tiene ningún campo de firma"; como borrador, pasaba sin aviso).
  const seenRoles = new Set<string>();
  const dupRoles = [...new Set(signers.map((r) => roleKey(r.role)).filter((k) => (seenRoles.has(k) ? true : (seenRoles.add(k), false))))];
  if (dupRoles.length) {
    throw new AppError(422, "duplicate_roles", `Cada rol firma una sola vez; repetidos: ${dupRoles.join(", ")}`, { roles: dupRoles });
  }
  const markRoles = [...new Map(spec.marks.map((m) => [roleKey(m.role), m.role])).values()];
  const byRole = new Map(signers.map((r) => [roleKey(r.role), r]));
  const missingRoles = markRoles.filter((r) => !byRole.has(roleKey(r)));
  if (missingRoles.length) throw new AppError(422, "missing_roles", `Faltan firmantes para: ${missingRoles.join(", ")}`, { missingRoles });
  const unknown = signers.filter((r) => !spec.marks.some((m) => roleKey(m.role) === roleKey(r.role) && m.kind === "signature"));
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
    if (!r.cc) recIds.set(roleKey(r.role), id);
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
    const recipientId = recIds.get(roleKey(m.role));
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
  // Ruta suelta ("monto") o "{{monto}}": el valor de los datos tal cual (un número JSON no pasa por texto y vuelta).
  const raw = (src: string | null | undefined) => (!src ? "" : !src.includes("{{") ? getPath(data, src) : interpolateValue(src, data, locale));
  const out: Record<string, unknown> = {};
  if (mapping.title) out.title = interpolate(mapping.title, data, locale) || undefined;
  const v = toNumberOrNull(raw(mapping.value), locale);
  if (v !== null) out.value = v;
  if (mapping.currency) out.currency = mapping.currency.toUpperCase();
  const eff = toIsoDate(raw(mapping.effectiveDate), locale);
  if (eff) out.effectiveDate = eff;
  const exp = toIsoDate(raw(mapping.expiryDate), locale);
  if (exp) out.expiryDate = exp;
  if (mapping.tags?.length) out.tags = mapping.tags;
  return out;
}

// ───────────────────────────── Mapeo ─────────────────────────────

function analyze(source: string, clauses: Record<string, string>) {
  try {
    return { analysis: analyzeTemplate(source, clauses), syntaxError: null };
  } catch (e) {
    return { analysis: null, syntaxError: e instanceof Error ? e.message : String(e) };
  }
}

function toTemplate(r: any, clauses: Record<string, string>): DocumentTemplate {
  return { ...toSummary(r, analyze(r.source, clauses)), source: r.source };
}

function toSummary(r: any, a: { analysis: DocumentTemplate["analysis"]; syntaxError: string | null }): DocumentTemplateSummary {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    locale: r.locale,
    sampleData: r.sample_data,
    agreementMapping: r.agreement_mapping,
    analysis: a.analysis,
    syntaxError: a.syntaxError,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

/**
 * Análisis del listado, en memoria por (plantilla, updatedAt, estado de la biblioteca de cláusulas): el listado ya no
 * trae la fuente (hasta 200 plantillas de 200 000 caracteres por pedido) ni la vuelve a analizar si nada cambió.
 */
const analysisCache = new Map<string, { analysis: DocumentTemplate["analysis"]; syntaxError: string | null }>();
const ANALYSIS_CACHE_MAX = 2000;

const RE_CLAUSE_TAG = /\{\{\s*(?:cl[aá]usula|clause)\s*:\s*([\w-]+)\s*\}\}/gi;

/** Plantillas (no archivadas) y cláusulas que citan la cláusula `slug` con {{clausula:slug}}. */
export async function clauseUsage(db: Db, tenantId: string, slug: string, exceptClauseId?: string) {
  // Prefiltro por texto (LIKE con el código) y después el análisis real (todas las ramas, sin distinguir la grafía).
  const like = `%${slug.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const cites = (src: string) => {
    try {
      return parseRefs(src).includes(slug);
    } catch {
      // Con un error de sintaxis en otra parte del texto el parser no devuelve nada: se cuenta como uso cualquier
      // {{clausula:slug}} escrito (mejor un 409 de más que borrar una cláusula que se usa).
      return [...src.matchAll(RE_CLAUSE_TAG)].some((m) => m[1] === slug);
    }
  };
  const templates = (
    await db.query<any>(`SELECT id, name, source FROM document_templates WHERE tenant_id = $1 AND archived_at IS NULL AND source ILIKE $2 ESCAPE '\\' ORDER BY name`, [tenantId, like])
  )
    .filter((r) => cites(r.source))
    .map((r) => ({ id: r.id as string, name: r.name as string }));
  const clauses = (await db.query<any>(`SELECT id, slug, title, body FROM clauses WHERE tenant_id = $1 AND body ILIKE $2 ESCAPE '\\' ORDER BY title`, [tenantId, like]))
    .filter((r) => r.id !== exceptClauseId && cites(r.body))
    .map((r) => ({ id: r.id as string, slug: r.slug as string, title: r.title as string }));
  return { templates, clauses };
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
    // Sin la fuente: el editor pide el detalle (GET /v1/document-templates/{id}).
    const rows = await s.db.query<any>(
      `SELECT id, name, description, locale, sample_data, agreement_mapping, created_at, updated_at FROM document_templates WHERE ${where} ORDER BY updated_at DESC LIMIT 200`,
      params,
    );
    const stamp = await s.db.one<any>(`SELECT count(*)::int AS n, max(updated_at) AS u FROM clauses WHERE tenant_id = $1`, [a.tenantId]);
    const clauseStamp = `${stamp?.n ?? 0}:${stamp?.u ? new Date(stamp.u).getTime() : 0}`;
    const keyOf = (r: any) => `${a.tenantId}:${r.id}:${new Date(r.updated_at).getTime()}:${clauseStamp}`;
    const misses = rows.filter((r) => !analysisCache.has(keyOf(r)));
    if (misses.length) {
      const clauses = await loadClauseMap(s.db, a.tenantId);
      const sources = await s.db.query<any>(`SELECT id, source FROM document_templates WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [a.tenantId, misses.map((r) => r.id)]);
      const byId = new Map(sources.map((x) => [x.id, x.source as string]));
      for (const r of misses) {
        const src = byId.get(r.id);
        if (src == null) continue;
        if (analysisCache.size >= ANALYSIS_CACHE_MAX) analysisCache.delete(analysisCache.keys().next().value!);
        analysisCache.set(keyOf(r), analyze(src, clauses));
      }
    }
    return { items: rows.map((r) => toSummary(r, analysisCache.get(keyOf(r)) ?? { analysis: null, syntaxError: null })) };
  });

  app.post("/v1/document-templates", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const input = DocumentTemplateInput.parse(req.body);
    checkTemplateRoles(input.source);
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
    const input = UpdateDocumentTemplateInput.parse(req.body);
    if (input.source != null) checkTemplateRoles(input.source);
    // Control de edición concurrente (X-Expected-Updated-At), con la fila bloqueada: dos pestañas guardando a la vez ya
    // no se pisan en silencio. updated_at estrictamente creciente (dos guardados en el mismo milisegundo daban el mismo).
    const row = await s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT * FROM document_templates WHERE id = $1 AND tenant_id = $2 AND archived_at IS NULL FOR UPDATE`, [req.params.id, a.tenantId]);
      if (!cur) throw notFound("Plantilla de documento");
      assertNotStale(req.headers, cur.updated_at, STALE_DOC_MESSAGE);
      return t.one<any>(
        `UPDATE document_templates SET name = $2, description = $3, locale = $4, source = $5, sample_data = $6, agreement_mapping = $7,
           updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond')
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
    });
    // El texto de la plantilla es lo que firman los documentos que genera: quién lo cambió queda en la auditoría.
    await auditFromRequest(s.db, req, a, "document_template.updated", { targetType: "document_template", targetId: row.id, data: { name: (row as any).name, fields: Object.keys((req.body as object) ?? {}) } });
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
      const warnings: GenerateWarning[] = [];
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
          templateRoles: doc.templateRoles,
          metadata: {
            ...(input.metadata ?? {}),
            documentTemplateId: tpl.id,
            dataSha256: sha256Hex(JSON.stringify(input.data)),
            // Qué versión del texto se firmó (la plantilla y las cláusulas cambian después).
            documentProvenance: doc.provenance,
            ...(agreement ? { agreement } : {}),
          },
          send: input.send,
          onSkippedRoles: (roles) => {
            warnings.length = 0;
            warnings.push({
              code: "signer_without_marks",
              message: `El documento generado no tiene marcas para ${roles.join(", ")} (p. ej. una firma dentro de un {{#if}} que no se cumplió): no se agregaron al sobre`,
              roles,
            });
          },
        }),
      ));
      const env = await s.db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [envelopeId]);
      return { status: 201, body: { envelopeId, status: env.status, missing: doc.missing, pages: doc.pageCount, warnings } };
    }),
  );

  // ───────── Cláusulas ─────────

  app.get("/v1/clauses", { preHandler: auth }, async (req) => ({
    items: (await s.db.query(`SELECT * FROM clauses WHERE tenant_id = $1 ORDER BY category NULLS LAST, title`, [A(req).tenantId])).map(toClause),
  }));

  // Dónde se usa una cláusula (para avisar antes de cambiarla o borrarla).
  app.get<{ Params: { id: string } }>("/v1/clauses/:id/usage", { preHandler: auth }, async (req) => {
    const a = A(req);
    const cur = await s.db.one<any>(`SELECT id, slug FROM clauses WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!cur) throw notFound("Cláusula");
    return clauseUsage(s.db, a.tenantId, cur.slug, cur.id);
  });

  app.post("/v1/clauses", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const input = ClauseInput.parse(req.body);
    checkClauseSyntax(input.body, input.slug, await loadClauseMap(s.db, a.tenantId));
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
    const { cur, row } = await s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT * FROM clauses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, a.tenantId]);
      if (!cur) throw notFound("Cláusula");
      assertNotStale(req.headers, cur.updated_at, STALE_DOC_MESSAGE);
      const input = ClauseInput.parse({ slug: cur.slug, title: cur.title, body: cur.body, category: cur.category, ...(req.body as object) });
      if (input.slug !== cur.slug) throw badRequest("immutable_slug", "El código de una cláusula no se puede cambiar (lo citan las plantillas)");
      // Solo si cambió el texto: cambiar el título o la categoría de una cláusula guardada antes de validar el grafo no
      // tiene que exigir arreglar sus citas.
      if (input.body !== cur.body) checkClauseSyntax(input.body, cur.slug, await loadClauseMap(t, a.tenantId));
      const row = await t.one<any>(
        `UPDATE clauses SET title = $2, body = $3, category = $4, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond') WHERE id = $1 RETURNING *`,
        [cur.id, input.title, input.body, input.category ?? null],
      );
      return { cur, row };
    });
    await auditFromRequest(s.db, req, a, "clause.updated", { targetType: "clause", targetId: cur.id, data: { slug: cur.slug, fields: Object.keys((req.body as object) ?? {}) } });
    return toClause(row);
  });

  app.delete<{ Params: { id: string } }>("/v1/clauses/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "templates:manage");
    const r = await s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT id, slug FROM clauses WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, a.tenantId]);
      if (!cur) throw notFound("Cláusula");
      // En uso: borrarla dejaba esas plantillas sin poder generar (422 missing_clauses) sin aviso al borrar.
      const usage = await clauseUsage(t, a.tenantId, cur.slug, cur.id);
      if (usage.templates.length || usage.clauses.length) {
        const names = [...usage.templates.map((x) => x.name), ...usage.clauses.map((x) => x.title)];
        throw conflict("clause_in_use", `La cláusula se usa en: ${names.slice(0, 10).join(", ")}${names.length > 10 ? "…" : ""}`, usage);
      }
      return t.query<any>(`DELETE FROM clauses WHERE id = $1 RETURNING id, slug, title`, [cur.id]);
    });
    await auditFromRequest(s.db, req, a, "clause.deleted", { targetType: "clause", targetId: r[0].id, data: { slug: r[0].slug, title: r[0].title } });
    return reply.code(204).send();
  });
}

const STALE_DOC_MESSAGE = "Cambió en otra pestaña o lo editó otra persona: recargá para ver la versión actual";

/**
 * Sintaxis de la cláusula y, con ella incluida en la biblioteca, que no se citen en ciclo ni pasen el tope de niveles.
 * El grafo se recorre desde la cláusula y desde todas las que la citan directa o indirectamente (en cualquier rama):
 * una cita nueva puede no pasar el tope desde la editada pero sí desde una cláusula que la incluye.
 */
function checkClauseSyntax(body: string, slug: string, library: Record<string, string>) {
  try {
    renderTemplate(body, {});
    const lib = { ...library, [slug]: body };
    checkClauseGraph(lib, [slug]);
    // Desde cada ancestro que hoy está bien: uno que ya venía roto (guardado antes de validar el grafo, por otra rama)
    // no bloquea editar esta cláusula.
    for (const anc of clauseAncestors(lib, slug)) {
      try {
        checkClauseGraph(library, [anc]);
      } catch {
        continue;
      }
      checkClauseGraph(lib, [anc]);
    }
  } catch (e) {
    if (e instanceof TemplateSyntaxError) throw badRequest("template_syntax", e.message, { line: e.line });
    throw e;
  }
}

/** Cláusulas de la biblioteca que citan `slug` directa o indirectamente (todas las ramas; las que no parsean, no citan). */
function clauseAncestors(lib: Record<string, string>, slug: string): string[] {
  const citedBy = new Map<string, string[]>();
  for (const [k, src] of Object.entries(lib)) {
    if (src == null) continue;
    let refs: string[];
    try {
      refs = parseRefs(src);
    } catch {
      refs = [];
    }
    for (const r of refs) {
      const xs = citedBy.get(r);
      if (xs) xs.push(k);
      else citedBy.set(r, [k]);
    }
  }
  const out = new Set<string>();
  const queue = [slug];
  while (queue.length) {
    for (const p of citedBy.get(queue.pop()!) ?? []) {
      if (p === slug || out.has(p)) continue;
      out.add(p);
      queue.push(p);
    }
  }
  return [...out];
}

/** Roles de más de 80 caracteres: no se guardan (ningún firmante podría tomarlos al generar). */
function checkTemplateRoles(source: string) {
  try {
    parseTemplate(source);
  } catch (e) {
    if (e instanceof TemplateSyntaxError && e.reason === "role_too_long") throw badRequest("template_syntax", e.message, { line: e.line });
  }
}
