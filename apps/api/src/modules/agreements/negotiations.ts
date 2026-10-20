// Negociación antes de firmar (redlining liviano): el remitente comparte un borrador generado desde una
// plantilla; las contrapartes comentan sobre el texto y proponen cambios a variables o cláusulas; cada
// cambio aceptado crea una versión nueva (con diff); al final, "aceptar" genera el PDF y el sobre.
// También se puede negociar un PDF subido (solo comentarios; al aceptar queda un sobre en borrador).
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AcceptNegotiationInput,
  CreateNegotiationInput,
  NegotiationCommentInput,
  NegotiationParticipantInput,
  NegotiationProposalInput,
  ProposalDecisionInput,
  analyzeTemplate,
  blocksToText,
  diffWords,
  renderTemplate,
  TemplateSyntaxError,
  type NegotiationAuthor,
  type NegotiationParticipant,
  type NegotiationSummary,
  type NegotiationView,
  type ResolvedBlock,
} from "@calasign/shared";
import { extractPdfPlainText, InvalidPdfError, PdfReaderBusyError, preparePdfUpload } from "@calasign/pdf";
import { z } from "zod";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { appendEvent } from "../../infra/evidence";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { encrypt, iso, randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import { hasPerm, requirePerm } from "../access";
import { auditFromRequest } from "../audit";
import { authenticate, type AuthContext, type Services } from "../context";
import { sendPdf } from "../envelopes";
import { discardBlobsOnFailure } from "../file-cleanup";
import { getPath, setPath } from "./common";
import { enqueueNegotiationNotice, enqueueProposalNotice } from "./notices";
import { agreementMetaFromMapping, createEnvelopeFromPdf, insertFileRow, loadClauseMap, loadDocTemplate, renderDocument, storeGeneratedPdf } from "./documents";
import { ownerProblem } from "../owner-check";

// ───────────────────────────── Render de una versión ─────────────────────────────

/** Topes por negociación: los enlaces de participantes son públicos y cada propuesta manda un correo. */
const MAX_COMMENTS = 500;
/** Por contraparte: una sola no puede agotar el cupo de todas. */
const MAX_COMMENTS_PER_PARTICIPANT = 100;
const MAX_PENDING_PROPOSALS_PER_AUTHOR = 20;

/**
 * Cupo de comentarios. Las contrapartes (links públicos) comparten MAX_COMMENTS y cada una tiene a lo sumo
 * MAX_COMMENTS_PER_PARTICIPANT; el remitente y su equipo tienen un cupo aparte de MAX_COMMENTS, así las contrapartes no
 * le dejan sin poder responder. Se llama con la negociación bloqueada (FOR UPDATE).
 */
async function assertCommentCapacity(t: Db, negotiationId: string, by: { type: "user" | "participant"; id: string | null }) {
  const c = await t.one<{ total: number; mine: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE author_id IS NOT DISTINCT FROM $3::text)::int AS mine
       FROM negotiation_comments WHERE negotiation_id = $1 AND author_type = $2`,
    [negotiationId, by.type, by.id],
  );
  if ((c?.total ?? 0) >= MAX_COMMENTS) throw new AppError(429, "too_many_comments", `La negociación llegó al máximo de ${MAX_COMMENTS} comentarios`);
  if (by.type === "participant" && (c?.mine ?? 0) >= MAX_COMMENTS_PER_PARTICIPANT) {
    throw new AppError(429, "too_many_comments", `Llegaste al máximo de ${MAX_COMMENTS_PER_PARTICIPANT} comentarios en esta negociación`);
  }
}

/**
 * Participantes contra los roles de firma del documento: un rol repetido (dos contrapartes firmarían el mismo lugar),
 * un rol que el documento no tiene (no firmaría nada), o más de un rol sin contraparte (al aceptar, el remitente puede
 * firmar uno solo y los demás lugares quedaban sin firmante).
 * Observadores (`observer: true`, p. ej. clientes de la API que mandan roles libres como "Abogado"): su rol es una
 * etiqueta, no se valida contra el documento y reciben copia del sobre. Un observador con un rol de firma del documento
 * es ambiguo (¿firma o no?): 400 observer_signing_role. Sin `observer`, un rol que el documento no tiene sigue siendo
 * 400 unknown_role (un error de tipeo en un rol de firma no puede convertir al firmante en copia en silencio).
 */
export function checkNegotiationRoles(
  participants: { role?: string | null; email: string; observer?: boolean }[],
  markRoles: string[],
  templateRoles: string[],
) {
  const known = new Map<string, string>();
  for (const r of [...templateRoles, ...markRoles]) known.set(r.toLowerCase(), r);
  const seen = new Set<string>();
  for (const p of participants) {
    const role = p.role?.trim();
    if (!role) continue;
    const k = role.toLowerCase();
    if (p.observer) {
      if (known.has(k)) throw badRequest("observer_signing_role", `«${role}» es un rol de firma del documento: un observador no firma (usá otra etiqueta o quitá observer)`);
      continue;
    }
    if (seen.has(k)) throw badRequest("duplicate_role", `El rol «${role}» está asignado a más de una contraparte`);
    seen.add(k);
    if (!known.has(k)) {
      throw badRequest("unknown_role", `El documento no tiene el rol de firma «${role}» (si esta contraparte no firma, mandala con observer: true)`);
    }
  }
  const missing = [...new Set(markRoles.map((r) => r.toLowerCase()))].filter((r) => !seen.has(r));
  if (missing.length > 1) {
    throw badRequest("missing_roles", `Faltan contrapartes para los roles: ${missing.map((r) => known.get(r) ?? r).join(", ")} (el remitente puede firmar solo uno)`, {
      roles: missing.map((r) => known.get(r) ?? r),
    });
  }
}

function clausesFor(n: any): Record<string, string> {
  return { ...(n.clause_snapshot ?? {}), ...(n.clause_overrides ?? {}) };
}

function renderNegotiation(n: any, data = n.data, overrides = n.clause_overrides): { blocks: ResolvedBlock[]; text: string } {
  if (n.source === "pdf") return { blocks: [], text: "" };
  const r = renderTemplate(n.template_source, data, { clauses: { ...(n.clause_snapshot ?? {}), ...(overrides ?? {}) }, locale: n.template_locale, missing: "placeholder" });
  return { blocks: r.blocks, text: blocksToText(r.blocks) };
}

function negotiableVariables(n: any): string[] {
  if (n.source === "pdf") return [];
  const all = analyzeTemplate(n.template_source, clausesFor(n)).variables;
  const allowed: string[] | null = n.negotiable;
  return allowed?.length ? all.filter((v) => allowed.includes(v)) : all;
}

function valueText(v: unknown): string {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// ───────────────────────────── Mapeo ─────────────────────────────

const toParticipant = (r: any): NegotiationParticipant => ({
  id: r.id,
  name: r.name,
  email: r.email,
  role: r.role,
  canPropose: r.can_propose,
  observer: Boolean(r.observer),
  lastSeenAt: iso(r.last_seen_at),
});
const author = (r: any): NegotiationAuthor => ({ type: r.author_type, name: r.author_name });

async function summary(db: Db, n: any): Promise<NegotiationSummary> {
  const [parts, counts] = await Promise.all([
    db.query(`SELECT * FROM negotiation_participants WHERE negotiation_id = $1 ORDER BY created_at`, [n.id]),
    db.one<any>(
      `SELECT (SELECT count(*)::int FROM negotiation_proposals WHERE negotiation_id = $1 AND status = 'pending') AS p,
              (SELECT count(*)::int FROM negotiation_comments WHERE negotiation_id = $1 AND NOT resolved) AS c`,
      [n.id],
    ),
  ]);
  return {
    id: n.id,
    title: n.title,
    status: n.status,
    source: n.source,
    currentVersion: n.current_version,
    participants: parts.map(toParticipant),
    pendingProposals: counts?.p ?? 0,
    openComments: counts?.c ?? 0,
    envelopeId: n.envelope_id,
    createdAt: iso(n.created_at)!,
    updatedAt: iso(n.updated_at)!,
  };
}

async function fullView(db: Db, n: any, me?: any): Promise<NegotiationView> {
  const [versions, comments, proposals, cur] = await Promise.all([
    db.query<any>(`SELECT version, author_type, author_name, summary, created_at FROM negotiation_versions WHERE negotiation_id = $1 ORDER BY version`, [n.id]),
    db.query<any>(`SELECT * FROM negotiation_comments WHERE negotiation_id = $1 ORDER BY created_at`, [n.id]),
    db.query<any>(`SELECT * FROM negotiation_proposals WHERE negotiation_id = $1 ORDER BY created_at`, [n.id]),
    db.one<any>(`SELECT text_snapshot FROM negotiation_versions WHERE negotiation_id = $1 AND version = $2`, [n.id, n.current_version]),
  ]);
  const rendered = renderNegotiation(n);
  const clauses = clausesFor(n);
  const usedClauses = n.source === "pdf" ? [] : analyzeTemplate(n.template_source, clauses).clauses;
  const view: NegotiationView = {
    negotiation: await summary(db, n),
    blocks: rendered.blocks,
    text: n.source === "pdf" ? cur?.text_snapshot ?? "" : rendered.text,
    versions: versions.map((v) => ({ version: v.version, author: author(v), summary: v.summary, createdAt: iso(v.created_at)! })),
    comments: comments.map((c) => ({
      id: c.id,
      version: c.version,
      author: author(c),
      quote: c.quote,
      start: c.start_offset,
      end: c.end_offset,
      body: c.body,
      resolved: c.resolved,
      createdAt: iso(c.created_at)!,
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      version: p.version,
      author: author(p),
      kind: p.kind,
      key: p.key,
      oldValue: p.old_value,
      newValue: p.new_value,
      comment: p.comment,
      status: p.status,
      createdAt: iso(p.created_at)!,
      decidedAt: iso(p.decided_at),
    })),
    variables: negotiableVariables(n).map((path) => ({ path, value: valueText(getPath(n.data, path)) })),
    clauses: usedClauses.filter((slug) => clauses[slug] != null).map((slug) => ({ slug, title: slug, text: clauses[slug] })),
    ...(me ? { me: toParticipant(me) } : {}),
  };
  // Vista de una contraparte (link público): de los demás participantes solo nombre y rol; ni su correo ni cuándo
  // entraron ni el sobre (la página del firmante tampoco muestra a los otros destinatarios).
  if (me) {
    view.negotiation = {
      ...view.negotiation,
      envelopeId: null,
      participants: view.negotiation.participants.map((x) =>
        x.id === me.id ? x : { ...x, email: null, lastSeenAt: null, canPropose: false },
      ),
    } as typeof view.negotiation;
  }
  return view;
}

async function diffFor(db: Db, n: any, from: number, to: number) {
  if (![from, to].every((v) => Number.isInteger(v) && v >= 1 && v <= 1_000_000)) throw badRequest("invalid_version", "Versión inválida");
  const rows = await db.query<any>(`SELECT version, text_snapshot FROM negotiation_versions WHERE negotiation_id = $1 AND version = ANY($2)`, [n.id, [from, to]]);
  const a = rows.find((r) => r.version === from);
  const b = rows.find((r) => r.version === to);
  if (!a || !b) throw notFound("Versión");
  return { from, to, parts: diffWords(a.text_snapshot, b.text_snapshot) };
}

/** Nueva versión con los datos/cláusulas dados. Debe correr en una transacción con la negociación bloqueada. */
async function newVersion(t: Db, n: any, data: Record<string, unknown>, overrides: Record<string, string>, by: NegotiationAuthor, summaryText: string) {
  const version = n.current_version + 1;
  let text: string;
  try {
    text = renderNegotiation(n, data, overrides).text;
  } catch (e) {
    // Una cláusula editada por el remitente con sintaxis inválida: 400 con la línea (antes, un 500).
    if (e instanceof TemplateSyntaxError) throw badRequest("template_syntax", e.message, { line: e.line });
    throw e;
  }
  await t.query(
    `INSERT INTO negotiation_versions (negotiation_id, version, data, clause_overrides, text_snapshot, author_type, author_name, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [n.id, version, JSON.stringify(data), JSON.stringify(overrides), text, by.type, by.name, summaryText.slice(0, 500)],
  );
  await t.query(`UPDATE negotiations SET data = $2, clause_overrides = $3, current_version = $4, updated_at = now() WHERE id = $1`, [
    n.id,
    JSON.stringify(data),
    JSON.stringify(overrides),
    version,
  ]);
  return version;
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function negotiationRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  async function loadForUser(a: AuthContext, id: string, lock = false, db: Db = s.db) {
    const n = await db.one<any>(`SELECT * FROM negotiations WHERE id = $1 AND tenant_id = $2${lock ? " FOR UPDATE" : ""}`, [id, a.tenantId]);
    if (!n) throw notFound("Negociación");
    if (n.created_by !== a.userId && !hasPerm(a, "envelopes:view_all")) throw notFound("Negociación");
    return n;
  }
  /** Cambiar la negociación (versiones, decisiones, cancelar, aceptar) es de quien la creó o de quien gestiona todos los sobres. */
  async function loadForManage(a: AuthContext, id: string, lock = false, db: Db = s.db) {
    const n = await loadForUser(a, id, lock, db);
    if (n.created_by !== a.userId && !hasPerm(a, "envelopes:manage_all")) throw forbidden("Solo quien creó la negociación puede modificarla");
    return n;
  }
  const userAuthor = (a: AuthContext): NegotiationAuthor => ({ type: "user", name: (a.actor.label ?? "Remitente").replace(/\s*<.*>$/, "") });

  async function insertParticipants(t: Db, negotiationId: string, tenantId: string, participants: z.infer<typeof NegotiationParticipantInput>[]) {
    for (const p of participants) {
      const token = randomToken();
      await t.query(
        `INSERT INTO negotiation_participants (id, negotiation_id, tenant_id, name, email, role, can_propose, token_hash, token_enc, observer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuidv7(), negotiationId, tenantId, p.name, p.email, p.role ?? null, p.canPropose ?? true, sha256Hex(token), encrypt(token), p.observer ?? false],
      );
    }
  }

  app.get<{ Querystring: { status?: string } }>("/v1/negotiations", { preHandler: auth }, async (req) => {
    const a = A(req);
    const params: unknown[] = [a.tenantId];
    let where = "tenant_id = $1";
    if (!hasPerm(a, "envelopes:view_all")) {
      params.push(a.userId);
      where += ` AND created_by = $${params.length}`;
    }
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND status = $${params.length}`;
    }
    const rows = await s.db.query(`SELECT * FROM negotiations WHERE ${where} ORDER BY updated_at DESC LIMIT 200`, params);
    return { items: await Promise.all(rows.map((n) => summary(s.db, n))) };
  });

  app.post("/v1/negotiations", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "envelopes:create");
    if (!a.userId) throw forbidden("Las negociaciones las inicia una persona (sesión web)");
    const input = CreateNegotiationInput.parse(req.body);
    const tpl = await loadDocTemplate(s.db, a.tenantId, input.documentTemplateId);
    const clauses = await loadClauseMap(s.db, a.tenantId);
    // Instantánea de las cláusulas que usa la plantilla.
    const used = analyzeTemplate(tpl.source, clauses).clauses;
    const snapshot = Object.fromEntries(used.filter((x) => clauses[x] != null).map((x) => [x, clauses[x]]));
    const id = uuidv7();
    const n = {
      id,
      tenant_id: a.tenantId,
      source: "template",
      template_source: tpl.source,
      template_locale: tpl.locale,
      clause_snapshot: snapshot,
      clause_overrides: {},
      data: input.data,
      negotiable: input.negotiableVariables ?? null,
      current_version: 0,
      title: input.title,
      message: input.message ?? null,
    };
    let text: string;
    let markRoles: string[];
    try {
      text = renderNegotiation(n).text;
      markRoles = renderTemplate(tpl.source, input.data, { clauses: snapshot, locale: tpl.locale, missing: "placeholder" }).marks.map((m) => m.role);
    } catch (e) {
      throw badRequest("template_syntax", e instanceof Error ? e.message : String(e));
    }
    checkNegotiationRoles(input.participants, markRoles, analyzeTemplate(tpl.source, clauses).roles);
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO negotiations (id, tenant_id, title, source, document_template_id, template_source, template_locale, clause_snapshot, negotiable, data, message, created_by)
         VALUES ($1,$2,$3,'template',$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, a.tenantId, input.title, tpl.id, tpl.source, tpl.locale, JSON.stringify(snapshot), input.negotiableVariables ? JSON.stringify(input.negotiableVariables) : null, JSON.stringify(input.data), input.message ?? null, a.userId],
      );
      await t.query(
        `INSERT INTO negotiation_versions (negotiation_id, version, data, clause_overrides, text_snapshot, author_type, author_name, summary) VALUES ($1,1,$2,'{}',$3,'user',$4,'Borrador inicial')`,
        [id, JSON.stringify(input.data), text, userAuthor(a).name],
      );
      await insertParticipants(t, id, a.tenantId, input.participants as any);
      // Invitación por la cola (outbox, misma transacción): con reintentos, marca e idioma (notices.ts).
      await enqueueNegotiationNotice(t, id, "invite", 1);
    });
    const row = await s.db.one<any>(`SELECT * FROM negotiations WHERE id = $1`, [id]);
    await auditFromRequest(s.db, req, a, "negotiation.created", { targetType: "negotiation", targetId: id, data: { title: input.title } });
    reply.code(201);
    return fullView(s.db, row);
  });

  // Negociación sobre un PDF (solo comentarios). Multipart: "meta" (JSON: title, participants) y luego "file".
  app.post("/v1/negotiations/upload", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "envelopes:create");
    if (!a.userId) throw forbidden("Las negociaciones las inicia una persona (sesión web)");
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const name = (file.filename || "").toLowerCase();
    if (/\.(docx?|odt|rtf)$/.test(name) || /word|opendocument/.test(file.mimetype)) {
      throw new AppError(415, "unsupported_format", "Subí un PDF: la conversión de documentos de Word no está disponible");
    }
    const metaField = (file.fields as any).meta;
    let metaRaw: unknown;
    try {
      metaRaw = JSON.parse(metaField && "value" in metaField ? String(metaField.value) : "{}");
    } catch {
      throw badRequest("invalid_meta", "El campo 'meta' no es JSON válido");
    }
    const meta = z
      .object({ title: z.string().trim().min(1).max(300), participants: z.array(NegotiationParticipantInput).min(1).max(20), message: z.string().max(5000).nullable().optional() })
      .parse(metaRaw);
    // PDF normalizado: el texto que se negocia y el documento que se firma salen del mismo archivo.
    let bytes: Uint8Array;
    try {
      bytes = (await preparePdfUpload(new Uint8Array(await file.toBuffer()))).bytes;
    } catch (e) {
      if (e instanceof InvalidPdfError) throw badRequest(e.code, e.message);
      throw e;
    }
    let text = "";
    try {
      // Sin NUL: pdf.js lo devuelve para glifos sin mapeo a Unicode y Postgres lo rechaza en text_snapshot (como fold()).
      text = (await extractPdfPlainText(bytes)).text.replace(/\u0000/g, "");
    } catch (e) {
      // Lectores ocupados: 503 para reintentar. Si no, la negociación quedaba para siempre sin texto que comparar.
      if (e instanceof PdfReaderBusyError) throw new AppError(503, "pdf_reader_busy", e.message);
      /* PDF sin texto */
    }
    const f = await storeGeneratedPdf(s.blobs, a.tenantId, bytes);
    const id = uuidv7();
    await discardBlobsOnFailure(s.blobs, [f.key], () => s.db.tx(async (t) => {
      await insertFileRow(t, a.tenantId, f);
      await t.query(`INSERT INTO negotiations (id, tenant_id, title, source, file_id, message, created_by) VALUES ($1,$2,$3,'pdf',$4,$5,$6)`, [
        id,
        a.tenantId,
        meta.title,
        f.fileId,
        meta.message ?? null,
        a.userId,
      ]);
      await t.query(
        `INSERT INTO negotiation_versions (negotiation_id, version, data, text_snapshot, author_type, author_name, summary) VALUES ($1,1,'{}',$2,'user',$3,'Documento subido')`,
        [id, text, userAuthor(a).name],
      );
      await insertParticipants(t, id, a.tenantId, meta.participants as any);
      await enqueueNegotiationNotice(t, id, "invite", 1);
    }));
    const row = await s.db.one<any>(`SELECT * FROM negotiations WHERE id = $1`, [id]);
    await auditFromRequest(s.db, req, a, "negotiation.created", { targetType: "negotiation", targetId: id, data: { title: meta.title, source: "pdf", sha256: f.sha256 } });
    reply.code(201);
    return fullView(s.db, row);
  });

  app.get<{ Params: { id: string } }>("/v1/negotiations/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const n = await loadForUser(a, req.params.id);
    // canManage: lo mismo que exige loadForManage (la web no ofrece aceptar, cancelar ni decidir si la API lo rechazaría).
    return { ...(await fullView(s.db, n)), canManage: n.created_by === a.userId || hasPerm(a, "envelopes:manage_all") };
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/v1/negotiations/:id/diff", { preHandler: auth }, async (req) => {
    const n = await loadForUser(A(req), req.params.id);
    return diffFor(s.db, n, Number(req.query.from ?? n.current_version - 1), Number(req.query.to ?? n.current_version));
  });

  app.get<{ Params: { id: string } }>("/v1/negotiations/:id/pdf", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const n = await loadForUser(a, req.params.id);
    return sendPdf(reply, await negotiationPdf(n), n.title);
  });

  async function negotiationPdf(n: any): Promise<Uint8Array> {
    if (n.source === "pdf") {
      const f = await s.db.one<any>(`SELECT storage_key FROM files WHERE id = $1`, [n.file_id]);
      return s.blobs.get(f.storage_key);
    }
    return (await renderDocument(s.db, n.tenant_id, { source: n.template_source, data: n.data, locale: n.template_locale, title: n.title, clauses: clausesFor(n) })).pdf;
  }

  // Edición directa del remitente (cambia datos o el texto de una cláusula): versión nueva.
  app.patch<{ Params: { id: string } }>("/v1/negotiations/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = z
      .object({
        data: z.record(z.string(), z.unknown()).optional(),
        clauseOverrides: z.record(z.string(), z.string().max(50_000)).optional(),
        summary: z.string().max(500).optional(),
      })
      .parse(req.body);
    const version = await s.db.tx(async (t) => {
      const n = await loadForManage(a, req.params.id, true, t);
      if (n.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
      if (n.source === "pdf") throw conflict("pdf_source", "Un PDF subido no se edita: subí una versión nueva como otra negociación");
      const v = await newVersion(t, n, input.data ?? n.data, { ...(n.clause_overrides ?? {}), ...(input.clauseOverrides ?? {}) }, userAuthor(a), input.summary ?? "Edición del remitente");
      await enqueueNegotiationNotice(t, n.id, "version", v, { summary: input.summary ?? null });
      return v;
    });
    const n = await loadForUser(a, req.params.id);
    await auditFromRequest(s.db, req, a, "negotiation.updated", {
      targetType: "negotiation",
      targetId: n.id,
      data: { version, fields: Object.keys(input.data ?? {}).slice(0, 50), clauses: Object.keys(input.clauseOverrides ?? {}).slice(0, 50) },
    });
    return fullView(s.db, n);
  });

  app.post<{ Params: { id: string } }>("/v1/negotiations/:id/comments", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = NegotiationCommentInput.parse(req.body);
    const n = await loadForUser(a, req.params.id);
    if (n.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
    // Como los comentarios de las contrapartes: con la negociación bloqueada, no queda un comentario en una negociación
    // ya aceptada o cancelada, ni citando el texto de una versión que dejó de ser la vigente.
    await s.db.tx(async (t) => {
      const locked = await t.one<any>(`SELECT status, current_version FROM negotiations WHERE id = $1 FOR UPDATE`, [n.id]);
      if (locked?.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
      if (locked.current_version !== n.current_version) throw conflict("version_changed", "Hay una versión nueva: revisala y volvé a comentar");
      await assertCommentCapacity(t, n.id, { type: "user", id: a.userId });
      await t.query(
        `INSERT INTO negotiation_comments (id, negotiation_id, version, author_type, author_id, author_name, quote, start_offset, end_offset, body)
         VALUES ($1,$2,$3,'user',$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), n.id, n.current_version, a.userId, userAuthor(a).name, input.quote ?? null, input.start ?? null, input.end ?? null, input.body],
      );
    });
    reply.code(201);
    return fullView(s.db, n);
  });

  app.patch<{ Params: { id: string; commentId: string } }>("/v1/negotiations/:id/comments/:commentId", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = z.object({ resolved: z.boolean() }).parse(req.body);
    const n = await loadForManage(a, req.params.id);
    const r = await s.db.query(`UPDATE negotiation_comments SET resolved = $3 WHERE id = $1 AND negotiation_id = $2 RETURNING id`, [req.params.commentId, n.id, input.resolved]);
    if (!r.length) throw notFound("Comentario");
    return fullView(s.db, n);
  });

  app.post<{ Params: { id: string; proposalId: string } }>("/v1/negotiations/:id/proposals/:proposalId/decision", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = ProposalDecisionInput.parse(req.body);
    const decided = await s.db.tx(async (t) => {
      const n = await loadForManage(a, req.params.id, true, t);
      if (n.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
      const p = await t.one<any>(`SELECT * FROM negotiation_proposals WHERE id = $1 AND negotiation_id = $2 FOR UPDATE`, [req.params.proposalId, n.id]);
      if (!p) throw notFound("Propuesta");
      if (p.status !== "pending") throw conflict("decided", "La propuesta ya fue decidida");
      await t.query(`UPDATE negotiation_proposals SET status = $2, decided_at = now() WHERE id = $1`, [p.id, input.accept ? "accepted" : "rejected"]);
      if (!input.accept) return { negotiationId: n.id, proposal: p, version: null as number | null };
      // Si el texto cambió desde que se hizo la propuesta (edición o otra propuesta aceptada), aceptarla pisaría ese
      // cambio sin que se vea: el "valor actual" que muestra es el de entonces.
      if (p.version !== n.current_version) {
        const now = p.kind === "variable" ? valueText(getPath(n.data, p.key)) : Object.hasOwn(clausesFor(n), p.key) ? clausesFor(n)[p.key] : undefined;
        if (now !== p.old_value) throw conflict("proposal_outdated", "El texto cambió desde que se hizo la propuesta: rechazala y pedí una nueva");
      }
      const data = structuredClone(n.data ?? {});
      const overrides = { ...(n.clause_overrides ?? {}) };
      if (p.kind === "variable") setPath(data, p.key, p.new_value);
      else overrides[p.key] = p.new_value;
      const v = await newVersion(t, n, data, overrides, { type: "participant", name: p.author_name }, `Propuesta aceptada: ${p.kind === "variable" ? p.key : `cláusula ${p.key}`}`);
      await enqueueNegotiationNotice(t, n.id, "version", v, { acceptedKey: p.key });
      return { negotiationId: n.id, proposal: p, version: v as number | null };
    });
    await auditFromRequest(s.db, req, a, input.accept ? "negotiation.proposal_accepted" : "negotiation.proposal_rejected", {
      targetType: "negotiation",
      targetId: decided.negotiationId,
      data: { proposalId: decided.proposal.id, kind: decided.proposal.kind, key: decided.proposal.key, author: decided.proposal.author_name, version: decided.version },
    });
    const n = await loadForUser(a, req.params.id);
    return fullView(s.db, n);
  });

  app.post<{ Params: { id: string } }>("/v1/negotiations/:id/cancel", { preHandler: auth }, async (req) => {
    const a = A(req);
    const n = await loadForManage(a, req.params.id);
    if (n.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
    // Solo si sigue abierta: una aceptación simultánea ya pudo crear (y enviar) el sobre; pisarla la dejaba "cancelada".
    const rejected = await s.db.tx(async (t) => {
      const upd = await t.query(`UPDATE negotiations SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [n.id]);
      if (!upd.length) throw conflict("closed", "La negociación ya está cerrada");
      // Las propuestas sin decidir quedan rechazadas (el CHECK de estados es pending/accepted/rejected): si no, seguían
      // "pendientes" para siempre en una negociación cerrada (contadores, vista de la contraparte).
      const r = await t.query(`UPDATE negotiation_proposals SET status = 'rejected', decided_at = now() WHERE negotiation_id = $1 AND status = 'pending' RETURNING id`, [n.id]);
      return r.length;
    });
    await auditFromRequest(s.db, req, a, "negotiation.cancelled", { targetType: "negotiation", targetId: n.id, data: { title: n.title, pendingProposalsRejected: rejected } });
    return fullView(s.db, await loadForUser(a, n.id));
  });

  // Aceptar: PDF final con la versión actual → sobre a firmar por las contrapartes (por rol) y el remitente si tiene rol.
  app.post<{ Params: { id: string } }>("/v1/negotiations/:id/accept", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = AcceptNegotiationInput.parse(req.body ?? {});
    const n = await loadForManage(a, req.params.id);
    if (n.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
    if (input.expectedVersion !== undefined && input.expectedVersion !== n.current_version) {
      throw conflict("version_changed", "Hay una versión nueva: revisala y volvé a aceptar");
    }
    const pending = await s.db.one<any>(`SELECT count(*)::int AS c FROM negotiation_proposals WHERE negotiation_id = $1 AND status = 'pending'`, [n.id]);
    if (pending?.c) throw conflict("pending_proposals", `Quedan ${pending.c} propuestas sin decidir`);
    const parts = await s.db.query<any>(`SELECT * FROM negotiation_participants WHERE negotiation_id = $1 ORDER BY created_at`, [n.id]);
    let marks: any[] = [];
    let finalPdf: Uint8Array;
    if (n.source === "template") {
      const doc = await renderDocument(s.db, n.tenant_id, { source: n.template_source, data: n.data, locale: n.template_locale, title: n.title, clauses: clausesFor(n) });
      // Como al generar un documento: una cláusula que cita la plantilla y no existe se omitía en silencio y el sobre
      // salía a firmar sin ese texto.
      if (doc.missingClauses.length)
        throw new AppError(422, "missing_clauses", `Cláusulas inexistentes: ${doc.missingClauses.join(", ")}`, { missingClauses: doc.missingClauses });
      if (doc.missing.length) throw new AppError(422, "missing_variables", `Faltan datos: ${doc.missing.join(", ")}`, { missing: doc.missing });
      finalPdf = doc.pdf;
      marks = doc.marks;
    } else {
      finalPdf = await negotiationPdf(n);
    }
    const file = await storeGeneratedPdf(s.blobs, n.tenant_id, finalPdf);
    const tpl = n.document_template_id ? await s.db.one<any>(`SELECT * FROM document_templates WHERE id = $1`, [n.document_template_id]) : null;
    const agreement = tpl ? agreementMetaFromMapping(tpl.agreement_mapping, n.data, n.template_locale) : null;
    const roles = [...new Set(marks.map((m) => m.role.toLowerCase()))];
    // Firmantes: contrapartes con un rol del documento; el resto, copia (los observadores siempre). Si el remitente firma,
    // su rol es el que no tiene contraparte.
    const recipients = parts.map((p) => ({
      role: p.role ?? `copia-${p.id.slice(-4)}`,
      name: p.name,
      email: p.email,
      cc: p.observer ? true : n.source === "pdf" ? false : !(p.role && roles.includes(p.role.toLowerCase())),
    }));
    // El remitente es quien creó la negociación, aunque la acepte alguien que gestiona todos los sobres: el sobre es suyo
    // (si no, no lo veía) y es él quien firma el rol sin contraparte. Si ya no es miembro, queda a nombre de quien acepta.
    const creatorIsMember =
      n.created_by && n.created_by !== a.userId
        ? // Que siga pudiendo crear sobres (no solo que sea miembro): si perdió el permiso, queda a nombre de quien acepta.
          (await ownerProblem(s.db, { tenantId: n.tenant_id, userId: n.created_by, apiKeyId: null }, null)) === null
        : false;
    const ownerId: string | null = creatorIsMember ? n.created_by : a.userId;
    // Si queda a nombre de quien acepta y es una API key, el sobre sigue siendo de la key (si no, quedaba sin dueño).
    const owner = { tenantId: a.tenantId, userId: ownerId, apiKeyId: creatorIsMember ? null : a.apiKeyId, actor: a.actor };
    const missingRoles = roles.filter((r) => !recipients.some((x) => !x.cc && x.role.toLowerCase() === r));
    if (missingRoles.length) {
      const me = await s.db.one<any>(`SELECT name, email FROM users WHERE id = $1`, [ownerId]);
      if (missingRoles.length === 1 && me) recipients.push({ role: marks.find((m) => m.role.toLowerCase() === missingRoles[0]).role, name: me.name, email: me.email, cc: false });
    }
    // Si la negociación cambió o se cerró mientras tanto (o el sobre no se puede crear), el PDF final no lo referencia nada.
    const envelopeId = await discardBlobsOnFailure(s.blobs, [file.key], () => s.db.tx(async (t) => {
      const locked = await t.one<any>(`SELECT status, current_version FROM negotiations WHERE id = $1 FOR UPDATE`, [n.id]);
      if (locked.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
      // El PDF se armó con la versión leída al principio: si mientras tanto se aceptó un cambio o se editó, el sobre
      // saldría con un texto que ya no es el acordado.
      if (locked.current_version !== n.current_version) throw conflict("version_changed", "La negociación cambió mientras se aceptaba: revisá la versión nueva y volvé a aceptar");
      // Una contraparte pudo proponer un cambio después del primer chequeo: con la negociación bloqueada, el sobre no
      // sale con una propuesta sin decidir (quedaría pendiente para siempre en una negociación cerrada).
      const late = await t.one<any>(`SELECT count(*)::int AS c FROM negotiation_proposals WHERE negotiation_id = $1 AND status = 'pending'`, [n.id]);
      if (late?.c) throw conflict("pending_proposals", `Quedan ${late.c} propuestas sin decidir`);
      let envId: string;
      if (n.source === "pdf") {
        // Sin marcas de firma: queda un sobre en borrador para ubicar los campos en el editor.
        envId = await createEnvelopeFromPdf(t, owner, {
          file,
          fileName: `${n.title}.pdf`,
          subject: input.subject ?? n.title,
          message: input.message ?? null,
          // Sobre un PDF subido no hay idioma de plantilla (template_locale queda en su valor por defecto): el de la organización.
          locale: (await t.one<{ default_locale: string | null }>(`SELECT default_locale FROM tenants WHERE id = $1`, [n.tenant_id]))?.default_locale ?? "es",
          recipients: [],
          marks: [],
          metadata: { negotiationId: n.id },
          send: false,
        });
        for (const p of parts) {
          await t.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, channels) VALUES ($1,$2,$3,'signer',1,$4,$5,ARRAY['email'])`, [
            uuidv7(),
            n.tenant_id,
            envId,
            p.name,
            p.email,
          ]);
        }
      } else {
        envId = await createEnvelopeFromPdf(t, owner, {
          file,
          fileName: `${n.title}.pdf`,
          subject: input.subject ?? n.title,
          message: input.message ?? null,
          locale: n.template_locale,
          recipients,
          marks,
          metadata: { negotiationId: n.id, negotiationVersion: n.current_version, ...(n.document_template_id ? { documentTemplateId: n.document_template_id } : {}), ...(agreement ? { agreement } : {}) },
          send: input.send,
        });
      }
      await t.query(`UPDATE negotiations SET status = 'accepted', envelope_id = $2, updated_at = now() WHERE id = $1`, [n.id, envId]);
      await appendEvent(t, { tenantId: n.tenant_id, envelopeId: envId, type: "envelope.negotiated", actor: a.actor, data: { negotiationId: n.id, version: n.current_version } });
      return envId;
    }));
    await auditFromRequest(s.db, req, a, "negotiation.accepted", { targetType: "negotiation", targetId: n.id, data: { envelopeId, version: n.current_version } });
    const env = await s.db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [envelopeId]);
    return { ...(await fullView(s.db, await loadForUser(a, n.id))), envelope: { id: envelopeId, status: env.status }, missing: [] as string[] };
  });

  // ───────── Contrapartes (link público por persona) ─────────

  const rl = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

  async function participantFor(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound("Negociación");
    const p = await s.db.one<any>(`SELECT * FROM negotiation_participants WHERE token_hash = $1`, [sha256Hex(token)]);
    if (!p) throw notFound("Negociación");
    const n = await s.db.one<any>(`SELECT * FROM negotiations WHERE id = $1`, [p.negotiation_id]);
    if (!n) throw notFound("Negociación");
    return { p, n };
  }
  const partAuthor = (p: any): NegotiationAuthor => ({ type: "participant", name: p.name });

  app.get<{ Params: { token: string } }>("/v1/public/negotiations/:token", rl, async (req) => {
    const { p, n } = await participantFor(req.params.token);
    await s.db.query(`UPDATE negotiation_participants SET last_seen_at = now() WHERE id = $1`, [p.id]);
    const org = await s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [n.tenant_id]);
    return { ...(await fullView(s.db, n, p)), organizationName: org?.name ?? "" };
  });

  app.get<{ Params: { token: string }; Querystring: { from?: string; to?: string } }>("/v1/public/negotiations/:token/diff", rl, async (req) => {
    const { n } = await participantFor(req.params.token);
    return diffFor(s.db, n, Number(req.query.from ?? n.current_version - 1), Number(req.query.to ?? n.current_version));
  });

  app.get<{ Params: { token: string } }>("/v1/public/negotiations/:token/pdf", rl, async (req, reply) => {
    const { n } = await participantFor(req.params.token);
    return sendPdf(reply, await negotiationPdf(n), n.title);
  });

  app.post<{ Params: { token: string } }>("/v1/public/negotiations/:token/comments", rl, async (req, reply) => {
    const input = NegotiationCommentInput.parse(req.body);
    const { p, n } = await participantFor(req.params.token);
    if (n.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
    // Como las propuestas: con la negociación bloqueada, un comentario que llega mientras se acepta (o sale una versión
    // nueva) no queda en una negociación cerrada ni citando el texto de una versión que ya no es la vigente.
    await s.db.tx(async (t) => {
      const locked = await t.one<any>(`SELECT status, current_version FROM negotiations WHERE id = $1 FOR UPDATE`, [n.id]);
      if (locked?.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
      if (locked.current_version !== n.current_version) throw conflict("version_changed", "Hay una versión nueva: revisala y volvé a comentar");
      await assertCommentCapacity(t, n.id, { type: "participant", id: p.id });
      await t.query(
        `INSERT INTO negotiation_comments (id, negotiation_id, version, author_type, author_id, author_name, quote, start_offset, end_offset, body)
         VALUES ($1,$2,$3,'participant',$4,$5,$6,$7,$8,$9)`,
        [uuidv7(), n.id, n.current_version, p.id, p.name, input.quote ?? null, input.start ?? null, input.end ?? null, input.body],
      );
    });
    reply.code(201);
    return fullView(s.db, n, p);
  });

  app.post<{ Params: { token: string } }>("/v1/public/negotiations/:token/proposals", rl, async (req, reply) => {
    const input = NegotiationProposalInput.parse(req.body);
    const { p, n } = await participantFor(req.params.token);
    if (n.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
    if (!p.can_propose) throw forbidden("Podés comentar, pero no proponer cambios en esta negociación");
    if (n.source === "pdf") throw conflict("pdf_source", "En un PDF subido solo se puede comentar");
    let old: string;
    if (input.kind === "variable") {
      if (!negotiableVariables(n).includes(input.key)) throw badRequest("not_negotiable", `«${input.key}» no se puede negociar`);
      old = valueText(getPath(n.data, input.key));
    } else {
      const c = clausesFor(n);
      if (!Object.hasOwn(c, input.key) || c[input.key] == null) throw badRequest("unknown_clause", "La cláusula no está en el documento");
      try {
        renderTemplate(input.newValue, {});
      } catch (e) {
        throw badRequest("template_syntax", e instanceof Error ? e.message : String(e));
      }
      old = c[input.key];
    }
    if (old === input.newValue) throw badRequest("no_change", "El valor propuesto es igual al actual");
    // Con la negociación bloqueada: si mientras tanto se aceptó (el sobre ya salió) o cambió de versión, la propuesta
    // no se guarda (quedaría pendiente en una negociación cerrada, o con un "valor actual" que ya no lo es).
    const proposalId = uuidv7();
    await s.db.tx(async (t) => {
      const locked = await t.one<any>(`SELECT status, current_version FROM negotiations WHERE id = $1 FOR UPDATE`, [n.id]);
      if (locked?.status !== "open") throw conflict("closed", "La negociación ya está cerrada");
      if (locked.current_version !== n.current_version) throw conflict("version_changed", "Hay una versión nueva: revisala y volvé a proponer");
      const pend = await t.one<any>(
        `SELECT count(*)::int AS n FROM negotiation_proposals WHERE negotiation_id = $1 AND author_type = 'participant' AND author_id = $2 AND status = 'pending'`,
        [n.id, p.id],
      );
      if ((pend?.n ?? 0) >= MAX_PENDING_PROPOSALS_PER_AUTHOR) {
        throw new AppError(429, "too_many_proposals", `Tenés ${MAX_PENDING_PROPOSALS_PER_AUTHOR} propuestas sin decidir: esperá a que las revisen`);
      }
      await t.query(
        `INSERT INTO negotiation_proposals (id, negotiation_id, version, author_type, author_id, author_name, kind, key, old_value, new_value, comment)
         VALUES ($1,$2,$3,'participant',$4,$5,$6,$7,$8,$9,$10)`,
        [proposalId, n.id, n.current_version, p.id, p.name, input.kind, input.key, old, input.newValue, input.comment ?? null],
      );
      // Aviso al remitente (o a los propietarios) por la cola: con reintentos, marca e idioma (notices.ts).
      await enqueueProposalNotice(t, n.id, proposalId);
    });
    reply.code(201);
    return fullView(s.db, n, p);
  });
}
