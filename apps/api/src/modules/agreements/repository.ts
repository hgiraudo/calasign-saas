// Repositorio de acuerdos: cada sobre completado se convierte en un acuerdo buscable; también se
// pueden subir PDF ya firmados fuera de CalaSign ("externos").
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AgreementFieldInput,
  AgreementFilters,
  AgreementMetaInput,
  AgreementViewInput,
  UpdateAgreementInput,
  type AgreementFieldDef,
  type AgreementView,
  type ListAgreementsResponse,
} from "@calasign/shared";
import { extractPdfPlainText, inspectPdf, InvalidPdfError, PdfReaderBusyError, readPdfSignatures } from "@calasign/pdf";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { sha256Hex, uuidv7 } from "../../lib/util";
import { deliver } from "../../notifications/channels";
import { hasPerm, requirePerm } from "../access";
import { auditFromRequest } from "../audit";
import { authenticate, type AuthContext, type Services } from "../context";
import { tenantBaseUrl } from "../custom-domains";
import { sendPdf } from "../envelopes";
import { discardBlobsOnFailure } from "../file-cleanup";
import {
  agreementVisibilitySql,
  canManageAgreement,
  csvCell,
  fold,
  refreshSearchVector,
  toAgreement,
  toIsoDate,
  toNumberOrNull,
  type Deps,
} from "./common";

const AGREEMENT_SELECT = `SELECT ag.*, f.sha256, u.name AS owner_name FROM agreements ag
  JOIN files f ON f.id = ag.file_id LEFT JOIN users u ON u.id = ag.owner_user_id`;

// ───────────────────────────── Ingesta ─────────────────────────────

/** Crea el acuerdo de un sobre completado (idempotente). Devuelve su id. */
export async function ingestEnvelope(d: Pick<Deps, "db" | "blobs" | "log">, envelopeId: string): Promise<string | null> {
  const existing = await d.db.one<any>(`SELECT id FROM agreements WHERE envelope_id = $1`, [envelopeId]);
  if (existing) return existing.id;
  const e = await d.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [envelopeId]);
  if (!e || e.status !== "completed" || !e.signed_file_id) return null;
  const file = await d.db.one<any>(`SELECT storage_key FROM files WHERE id = $1`, [e.signed_file_id]);
  const recips = await d.db.query<any>(
    `SELECT name, email, role FROM recipients WHERE envelope_id = $1 AND status NOT IN ('delegated','reassigned') ORDER BY routing_order, created_at`,
    [envelopeId],
  );
  const bytes = await d.blobs.get(file.storage_key);
  let text = "";
  let signatures = 0;
  try {
    text = (await extractPdfPlainText(bytes)).text;
  } catch (err) {
    // Lectores ocupados: que el job se reintente. Si no, el acuerdo quedaba para siempre sin texto (no aparece en
    // las búsquedas) por algo transitorio.
    if (err instanceof PdfReaderBusyError) throw err;
    d.log.warn({ envelopeId, err: String(err) }, "no se pudo extraer el texto del PDF");
  }
  try {
    signatures = (await readPdfSignatures(bytes)).signatures.length;
  } catch {
    /* sin firmas legibles */
  }
  const meta = (e.metadata?.agreement ?? {}) as Record<string, unknown>;
  const id = uuidv7();
  const inserted = await d.db.one<any>(
    `INSERT INTO agreements (id, tenant_id, source, envelope_id, file_id, file_name, title, counterparties, effective_date, expiry_date,
       value, currency, tags, metadata, signatures, owner_user_id, created_by_api_key, completed_at, text_folded)
     VALUES ($1,$2,'envelope',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (envelope_id) DO NOTHING RETURNING id`,
    [
      id,
      e.tenant_id,
      envelopeId,
      e.signed_file_id,
      `${e.subject}.pdf`.slice(0, 200),
      (typeof meta.title === "string" && meta.title.trim() ? meta.title : e.subject).slice(0, 300),
      JSON.stringify(recips.filter((r) => r.role !== "cc").map((r) => ({ name: r.name, email: r.email ?? null, role: r.role }))),
      toIsoDate(meta.effectiveDate) ?? (e.completed_at ? new Date(e.completed_at).toISOString().slice(0, 10) : null),
      toIsoDate(meta.expiryDate),
      toNumberOrNull(meta.value),
      typeof meta.currency === "string" && /^[A-Z]{3}$/.test(meta.currency) ? meta.currency : null,
      Array.isArray(meta.tags) ? meta.tags.filter((x): x is string => typeof x === "string").slice(0, 30) : [],
      JSON.stringify(typeof meta.metadata === "object" && meta.metadata ? meta.metadata : {}),
      signatures,
      e.created_by,
      e.created_by_api_key ?? null,
      e.completed_at,
      fold(text),
    ],
  );
  if (!inserted) return (await d.db.one<any>(`SELECT id FROM agreements WHERE envelope_id = $1`, [envelopeId]))?.id ?? null;
  await refreshSearchVector(d.db, id);
  d.log.info({ envelopeId, agreementId: id }, "acuerdo agregado al repositorio");
  return id;
}

// ───────────────────────────── Vencimientos ─────────────────────────────

const REMINDER = {
  es: {
    subject: (t: string, d: string) => `Vence el ${d}: ${t}`,
    body: (t: string, d: string, days: number) =>
      `El acuerdo "${t}" vence el ${d} (${days <= 0 ? "hoy" : `en ${days} día${days === 1 ? "" : "s"}`}). Revisalo para renovarlo o darlo de baja a tiempo.`,
    cta: "Ver acuerdo",
  },
  "pt-BR": {
    subject: (t: string, d: string) => `Vence em ${d}: ${t}`,
    body: (t: string, d: string, days: number) =>
      `O acordo "${t}" vence em ${d} (${days <= 0 ? "hoje" : `em ${days} dia${days === 1 ? "" : "s"}`}). Revise para renovar ou encerrar a tempo.`,
    cta: "Ver acordo",
  },
  en: {
    subject: (t: string, d: string) => `Expires on ${d}: ${t}`,
    body: (t: string, d: string, days: number) =>
      `The agreement "${t}" expires on ${d} (${days <= 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}). Review it to renew or terminate it in time.`,
    cta: "View agreement",
  },
} as const;

/** Marca vencidos y avisa a los responsables antes del vencimiento (una vez por fecha de vencimiento). */
export async function agreementExpirySweep(d: Deps) {
  await d.db.query(`UPDATE agreements SET status = 'expired', updated_at = now() WHERE status = 'active' AND expiry_date < current_date`);
  const due = await d.db.query<any>(
    `SELECT ag.id, ag.tenant_id, ag.title, ag.expiry_date, ag.owner_user_id, (ag.expiry_date - current_date) AS days_left
     FROM agreements ag
     WHERE ag.status = 'active' AND ag.expiry_date IS NOT NULL
       AND ag.expiry_date - COALESCE(ag.notice_days, 30) <= current_date
       AND (ag.expiry_notified_for IS NULL OR ag.expiry_notified_for <> ag.expiry_date)
     LIMIT 50`,
  );
  for (const a of due) {
    // Responsable: el dueño si sigue en la organización; si no hay (subido por API) o ya no es miembro, los
    // propietarios. Alguien que dejó la organización no tiene que seguir recibiendo datos de sus acuerdos.
    let to = a.owner_user_id
      ? await d.db.query<any>(`SELECT u.email, u.locale FROM users u JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 WHERE u.id = $1`, [
          a.owner_user_id,
          a.tenant_id,
        ])
      : [];
    if (!to.length) {
      to = await d.db.query<any>(`SELECT u.email, u.locale FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.role = 'owner'`, [
        a.tenant_id,
      ]);
    }
    const base = await tenantBaseUrl(d.db, a.tenant_id);
    const date = String(a.expiry_date instanceof Date ? a.expiry_date.toISOString().slice(0, 10) : a.expiry_date).slice(0, 10);
    for (const u of to) {
      const L = REMINDER[(u.locale in REMINDER ? u.locale : "es") as keyof typeof REMINDER];
      const link = `${base}/app/agreements/${a.id}`;
      try {
        await deliver({
          channel: "email",
          to: u.email,
          subject: L.subject(a.title, date),
          text: `${L.body(a.title, date, Number(a.days_left))}\n\n${L.cta}: ${link}`,
          link,
          tenantId: a.tenant_id,
        });
      } catch (err) {
        d.log.warn({ agreementId: a.id, err: String(err) }, "no se pudo avisar el vencimiento");
      }
    }
    await d.db.query(`UPDATE agreements SET expiry_notified_for = expiry_date WHERE id = $1`, [a.id]);
  }
  return due.length;
}

// ───────────────────────────── Búsqueda ─────────────────────────────

function parseFilters(q: Record<string, string | undefined>): AgreementFilters {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) if (k.startsWith("f.") && v) fields[k.slice(2)] = v;
  return AgreementFilters.parse({
    q: q.q || undefined,
    status: q.status || undefined,
    source: q.source || undefined,
    tag: q.tag || undefined,
    counterparty: q.counterparty || undefined,
    expiresWithinDays: q.expiresWithinDays ? Number(q.expiresWithinDays) : undefined,
    fields: Object.keys(fields).length ? fields : undefined,
  });
}

function whereFor(a: AuthContext, f: AgreementFilters, params: unknown[]): string {
  params.push(a.tenantId);
  const w: string[] = [`ag.tenant_id = $${params.length}`, agreementVisibilitySql(a, params)];
  if (f.q?.trim()) {
    params.push(fold(f.q.trim()));
    const p = `$${params.length}`;
    params.push(`%${fold(f.q.trim()).replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const like = `$${params.length}`;
    w.push(`(ag.search_vector @@ websearch_to_tsquery('spanish', ${p}) OR ag.search_vector @@ websearch_to_tsquery('portuguese', ${p}) OR ag.title ILIKE ${like})`);
  }
  if (f.status) {
    params.push(f.status);
    w.push(`ag.status = $${params.length}`);
  }
  if (f.source) {
    params.push(f.source);
    w.push(`ag.source = $${params.length}`);
  }
  if (f.tag) {
    params.push(f.tag);
    w.push(`$${params.length} = ANY(ag.tags)`);
  }
  if (f.counterparty) {
    params.push(`%${f.counterparty.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    w.push(`ag.counterparties::text ILIKE $${params.length}`);
  }
  if (f.expiresWithinDays !== undefined) {
    params.push(f.expiresWithinDays);
    w.push(`ag.expiry_date IS NOT NULL AND ag.expiry_date >= current_date AND ag.expiry_date <= current_date + $${params.length}::int`);
  }
  for (const [k, v] of Object.entries(f.fields ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
    params.push(k, v);
    w.push(`ag.metadata->>$${params.length - 1} = $${params.length}`);
  }
  return w.join(" AND ");
}

// Vistas guardadas: son de quien las creó, persona (user_id) o API key (created_by_api_key). Se compara solo con un id
// presente: una key no tiene usuario, y `NULL === NULL` hacía que cualquier key fuera "dueña" de las vistas de otras.
const viewVisibleSql = (n: number) => `(shared OR user_id = $${n} OR created_by_api_key = $${n + 1})`;
const viewOwnerParams = (a: AuthContext) => [a.userId, a.userId ? null : a.apiKeyId];
const ownsView = (a: AuthContext, r: { user_id: string | null; created_by_api_key: string | null }) =>
  (a.userId != null && r.user_id === a.userId) || (a.userId == null && a.apiKeyId != null && r.created_by_api_key === a.apiKeyId);

async function loadAgreementForUser(db: Db, a: AuthContext, id: string) {
  const params: unknown[] = [id];
  const vis = agreementVisibilitySql(a, params);
  params.push(a.tenantId);
  const r = await db.one<any>(`${AGREEMENT_SELECT} WHERE ag.id = $1 AND ag.tenant_id = $${params.length} AND ${vis}`, params);
  if (!r) throw notFound("Acuerdo");
  return r;
}

/** Las fechas AAAA-MM-DD tienen que existir ("2027-02-31" pasa el formato, pero Postgres la rechaza: sería un 500). */
function assertRealDates(input: Record<string, unknown>) {
  for (const k of ["effectiveDate", "expiryDate", "renewalDate"]) {
    const v = input[k];
    if (typeof v === "string" && toIsoDate(v) !== v) throw badRequest("invalid_date", `${k}: la fecha no existe`);
  }
}

/** Valida los metadatos personalizados contra los campos definidos por la organización. */
async function checkCustomFields(db: Db, tenantId: string, metadata: Record<string, unknown> | undefined) {
  if (!metadata) return;
  const defs = await db.query<any>(`SELECT key, label, type, options FROM agreement_fields WHERE tenant_id = $1`, [tenantId]);
  const byKey = new Map(defs.map((x) => [x.key, x]));
  for (const [k, v] of Object.entries(metadata)) {
    const def = byKey.get(k);
    if (!def || v == null || v === "") continue;
    if (def.type === "number" && toNumberOrNull(v) === null) throw badRequest("invalid_metadata", `${def.label}: se esperaba un número`);
    if (def.type === "date" && !toIsoDate(v)) throw badRequest("invalid_metadata", `${def.label}: se esperaba una fecha AAAA-MM-DD`);
    if (def.type === "select" && !(def.options ?? []).includes(String(v))) throw badRequest("invalid_metadata", `${def.label}: valor fuera de la lista`);
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function repositoryRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  async function list(a: AuthContext, f: AgreementFilters, cursor: string | undefined, limit: number): Promise<ListAgreementsResponse> {
    const params: unknown[] = [];
    let where = whereFor(a, f, params);
    const countParams = [...params];
    const total = Number((await s.db.one<any>(`SELECT count(*)::int AS n FROM agreements ag WHERE ${where}`, countParams))?.n ?? 0);
    if (cursor) {
      // created_at va en microsegundos (un Date de JS solo tiene ms: con ms se saltaban los acuerdos del mismo
      // milisegundo que el último de la página). Se aceptan también los cursores viejos con fecha ISO.
      const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
      const us = /^\d{1,17}$/.test(ts ?? "") ? ts : ts && !Number.isNaN(Date.parse(ts)) ? String(Date.parse(ts) * 1000) : null;
      if (!us || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? "")) {
        throw badRequest("invalid_cursor", "Cursor inválido");
      }
      params.push(us, id);
      where += ` AND (ag.created_at, ag.id) < ('epoch'::timestamptz + $${params.length - 1}::bigint * interval '1 microsecond', $${params.length}::uuid)`;
    }
    let excerpt = "";
    if (f.q?.trim()) {
      params.push(fold(f.q.trim()));
      excerpt = `, ts_headline('spanish', left(ag.text_folded, 60000), websearch_to_tsquery('spanish', $${params.length}),
        'MaxWords=28, MinWords=10, ShortWord=2, MaxFragments=1, StartSel=«, StopSel=»') AS excerpt`;
    }
    params.push(limit + 1);
    const rows = await s.db.query<any>(
      `SELECT ag.*, ((extract(epoch FROM ag.created_at) * 1000000)::bigint)::text AS cursor_us, f.sha256, u.name AS owner_name ${excerpt} FROM agreements ag JOIN files f ON f.id = ag.file_id
       LEFT JOIN users u ON u.id = ag.owner_user_id WHERE ${where} ORDER BY ag.created_at DESC, ag.id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toAgreement({ ...r, excerpt: f.q ? (r.excerpt && /«/.test(r.excerpt) ? r.excerpt : null) : undefined })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.cursor_us}|${last.id}`).toString("base64url") : null,
      total,
    };
  }

  async function filtersFromQuery(a: AuthContext, q: Record<string, string | undefined>): Promise<AgreementFilters> {
    if (q.viewId) {
      const v = await s.db.one<any>(`SELECT filters FROM agreement_views WHERE id = $1 AND tenant_id = $2 AND ${viewVisibleSql(3)}`, [
        q.viewId,
        a.tenantId,
        ...viewOwnerParams(a),
      ]);
      if (!v) throw notFound("Vista");
      // Lo que venga en la URL refina la vista, filtro por filtro (también los campos propios: antes un `f.x` de la
      // URL reemplazaba TODOS los campos propios de la vista). Para quitar un filtro de la vista se lo manda vacío:
      // `status=`, `expiresWithinDays=`, `f.region=` (la web nunca manda parámetros vacíos por otro motivo).
      const base: Record<string, unknown> = { ...(v.filters ?? {}) };
      const fields: Record<string, string> = { ...((base.fields as Record<string, string> | undefined) ?? {}) };
      for (const [k, x] of Object.entries(q)) {
        if (x !== "" || k === "viewId" || k === "cursor" || k === "limit") continue;
        if (k.startsWith("f.")) delete fields[k.slice(2)];
        else delete base[k];
      }
      const url = parseFilters(q);
      Object.assign(fields, url.fields ?? {});
      const extra = Object.fromEntries(Object.entries(url).filter(([k, x]) => x !== undefined && k !== "fields"));
      return AgreementFilters.parse({ ...base, ...extra, fields: Object.keys(fields).length ? fields : undefined });
    }
    return parseFilters(q);
  }

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/agreements", { preHandler: auth }, async (req) => {
    const a = A(req);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit ?? 25)) || 25));
    return list(a, await filtersFromQuery(a, req.query), req.query.cursor, limit);
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v1/agreements/export.csv", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const f = await filtersFromQuery(a, req.query);
    const params: unknown[] = [];
    const where = whereFor(a, f, params);
    const rows = await s.db.query<any>(
      `SELECT ag.*, f.sha256, u.name AS owner_name FROM agreements ag JOIN files f ON f.id = ag.file_id LEFT JOIN users u ON u.id = ag.owner_user_id
       WHERE ${where} ORDER BY ag.created_at DESC LIMIT 10000`,
      params,
    );
    const defs = await s.db.query<any>(`SELECT key, label FROM agreement_fields WHERE tenant_id = $1 ORDER BY position, created_at`, [a.tenantId]);
    const head = ["id", "titulo", "estado", "origen", "contrapartes", "vigencia_desde", "vencimiento", "renovacion", "valor", "moneda", "etiquetas", "responsable", "sha256", ...defs.map((x) => x.label)];
    const lines = [head.map(csvCell).join(",")];
    for (const r of rows) {
      const ag = toAgreement(r);
      lines.push(
        [
          ag.id,
          ag.title,
          ag.status,
          ag.source,
          ag.counterparties.map((c) => (c.email ? `${c.name} <${c.email}>` : c.name)).join("; "),
          ag.effectiveDate,
          ag.expiryDate,
          ag.renewalDate,
          ag.value,
          ag.currency,
          ag.tags.join("; "),
          ag.ownerName,
          ag.sha256,
          ...defs.map((x) => ag.metadata[x.key] ?? ""),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    await auditFromRequest(s.db, req, a, "agreements.exported", { data: { rows: rows.length } });
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="acuerdos.csv"`);
    return "﻿" + lines.join("\r\n") + "\r\n";
  });

  app.get<{ Params: { id: string } }>("/v1/agreements/:id", { preHandler: auth }, async (req) => toAgreement(await loadAgreementForUser(s.db, A(req), req.params.id)));

  app.get<{ Params: { id: string } }>("/v1/agreements/:id/file", { preHandler: auth }, async (req, reply: FastifyReply) => {
    const r = await loadAgreementForUser(s.db, A(req), req.params.id);
    const f = await s.db.one<any>(`SELECT storage_key, purged_at FROM files WHERE id = $1`, [r.file_id]);
    if (!f || f.purged_at) throw new AppError(410, "file_purged", "El archivo ya no está disponible");
    return sendPdf(reply, await s.blobs.get(f.storage_key), r.title);
  });

  app.patch<{ Params: { id: string } }>("/v1/agreements/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateAgreementInput.parse(req.body);
    assertRealDates(input);
    const r = await loadAgreementForUser(s.db, a, req.params.id);
    if (!canManageAgreement(a, r)) throw forbidden("Solo el responsable del acuerdo (o quien gestiona todos los sobres) puede modificarlo");
    await checkCustomFields(s.db, a.tenantId, input.metadata as Record<string, unknown> | undefined);
    const sets: string[] = [];
    const params: unknown[] = [r.id];
    const set = (col: string, v: unknown, cast = "") => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (input.title !== undefined) set("title", input.title);
    if (input.counterparties !== undefined) set("counterparties", JSON.stringify(input.counterparties), "::jsonb");
    if (input.status !== undefined) set("status", input.status);
    if (input.effectiveDate !== undefined) set("effective_date", input.effectiveDate, "::date");
    if (input.expiryDate !== undefined) {
      set("expiry_date", input.expiryDate, "::date");
      // Nueva fecha: el recordatorio vuelve a corresponder; si ya no está vencido, vuelve a estar vigente.
      if (input.status === undefined && r.status === "expired" && input.expiryDate && input.expiryDate >= new Date().toISOString().slice(0, 10)) set("status", "active");
    }
    if (input.renewalDate !== undefined) set("renewal_date", input.renewalDate, "::date");
    if (input.noticeDays !== undefined) set("notice_days", input.noticeDays);
    if (input.value !== undefined) set("value", input.value);
    if (input.currency !== undefined) set("currency", input.currency);
    if (input.tags !== undefined) set("tags", [...new Set(input.tags)]);
    if (input.metadata !== undefined) set("metadata", JSON.stringify({ ...(r.metadata ?? {}), ...input.metadata }), "::jsonb");
    if (sets.length) {
      await s.db.query(`UPDATE agreements SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
      await refreshSearchVector(s.db, r.id);
      await auditFromRequest(s.db, req, a, "agreement.updated", { targetType: "agreement", targetId: r.id, data: { fields: Object.keys(input) } });
    }
    return toAgreement(await loadAgreementForUser(s.db, a, r.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/agreements/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const r = await loadAgreementForUser(s.db, a, req.params.id);
    if (r.source !== "external") throw conflict("not_external", "Solo se pueden borrar acuerdos externos; los firmados en CalaSign se dan de baja (estado: terminado)");
    if (!canManageAgreement(a, r)) throw forbidden();
    await s.db.query(`DELETE FROM agreements WHERE id = $1`, [r.id]);
    await auditFromRequest(s.db, req, a, "agreement.deleted", { targetType: "agreement", targetId: r.id, data: { title: r.title } });
    return reply.code(204).send();
  });

  // Carga de un acuerdo firmado fuera de CalaSign. Multipart: "meta" (JSON) ANTES que "file" (PDF).
  app.post("/v1/agreements/upload", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const metaField = (file.fields as any).meta;
    const metaRaw = metaField && !Array.isArray(metaField) && "value" in metaField ? String(metaField.value) : "";
    let meta: AgreementMetaInput;
    try {
      meta = AgreementMetaInput.parse(metaRaw ? JSON.parse(metaRaw) : { title: (file.filename || "Acuerdo").replace(/\.pdf$/i, "") });
    } catch (e) {
      if (e instanceof SyntaxError) throw badRequest("invalid_meta", "El campo 'meta' no es JSON válido");
      throw e;
    }
    assertRealDates(meta);
    const bytes = new Uint8Array(await file.toBuffer());
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo");
    try {
      await inspectPdf(bytes);
    } catch (e) {
      if (e instanceof InvalidPdfError) throw badRequest(e.code, e.message);
      throw e;
    }
    await checkCustomFields(s.db, a.tenantId, meta.metadata as Record<string, unknown> | undefined);
    const sha = sha256Hex(bytes);
    const dup = await s.db.one<any>(
      `SELECT ag.id FROM agreements ag JOIN files f ON f.id = ag.file_id WHERE ag.tenant_id = $1 AND f.sha256 = $2 LIMIT 1`,
      [a.tenantId, sha],
    );
    if (dup) throw conflict("duplicate", "Ese PDF ya está en el repositorio", { agreementId: dup.id });
    let text = "";
    let signatures = 0;
    try {
      text = (await extractPdfPlainText(bytes)).text;
    } catch (e) {
      if (e instanceof PdfReaderBusyError) throw new AppError(503, "pdf_reader_busy", e.message);
      /* PDF escaneado o sin texto */
    }
    try {
      signatures = (await readPdfSignatures(bytes)).signatures.length;
    } catch {
      /* sin firmas */
    }
    const fileId = uuidv7();
    const key = `tenants/${a.tenantId}/agreements/${fileId}.pdf`;
    await s.blobs.put(key, bytes, "application/pdf");
    const id = uuidv7();
    // Si la transacción falla, el PDF subido no lo referencia nada (sin fila en `files` la retención nunca lo vería).
    await discardBlobsOnFailure(s.blobs, [key], () => s.db.tx(async (t) => {
      await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',$4,$5)`, [
        fileId,
        a.tenantId,
        key,
        bytes.length,
        sha,
      ]);
      await t.query(
        `INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title, counterparties, status, effective_date, expiry_date, renewal_date,
           notice_days, value, currency, tags, metadata, signatures, owner_user_id, created_by_api_key, text_folded)
         VALUES ($1,$2,'external',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          id,
          a.tenantId,
          fileId,
          (file.filename || "acuerdo.pdf").slice(0, 200),
          meta.title,
          JSON.stringify(meta.counterparties ?? []),
          meta.status ?? "active",
          meta.effectiveDate ?? null,
          meta.expiryDate ?? null,
          meta.renewalDate ?? null,
          meta.noticeDays ?? null,
          meta.value ?? null,
          meta.currency ?? null,
          [...new Set(meta.tags ?? [])],
          JSON.stringify(meta.metadata ?? {}),
          signatures,
          a.userId,
          a.apiKeyId,
          fold(text),
        ],
      );
    }));
    await refreshSearchVector(s.db, id);
    await auditFromRequest(s.db, req, a, "agreement.uploaded", { targetType: "agreement", targetId: id, data: { title: meta.title, sha256: sha } });
    reply.code(201);
    return toAgreement(await loadAgreementForUser(s.db, a, id));
  });

  // ───────── Campos personalizados ─────────

  const toField = (r: any): AgreementFieldDef => ({ id: r.id, key: r.key, label: r.label, type: r.type, options: r.options ?? null });

  app.get("/v1/agreement-fields", { preHandler: auth }, async (req) => ({
    items: (await s.db.query(`SELECT * FROM agreement_fields WHERE tenant_id = $1 ORDER BY position, created_at`, [A(req).tenantId])).map(toField),
  }));

  app.post("/v1/agreement-fields", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "settings:manage");
    const input = AgreementFieldInput.parse(req.body);
    const pos = await s.db.one<any>(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM agreement_fields WHERE tenant_id = $1`, [a.tenantId]);
    const row = await s.db
      .one(
        `INSERT INTO agreement_fields (id, tenant_id, key, label, type, options, position) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [uuidv7(), a.tenantId, input.key, input.label, input.type, input.options ? JSON.stringify(input.options) : null, pos.p],
      )
      .catch((e) => {
        if (String(e).includes("unique") || String(e).includes("duplicate")) throw conflict("duplicate_key", "Ya existe un campo con esa clave");
        throw e;
      });
    reply.code(201);
    return toField(row);
  });

  app.patch<{ Params: { id: string } }>("/v1/agreement-fields/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    requirePerm(a, "settings:manage");
    const cur = await s.db.one<any>(`SELECT * FROM agreement_fields WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!cur) throw notFound("Campo");
    const input = AgreementFieldInput.parse({ key: cur.key, label: cur.label, type: cur.type, options: cur.options, ...(req.body as object) });
    if (input.key !== cur.key) throw badRequest("immutable_key", "La clave de un campo no se puede cambiar");
    const row = await s.db.one(`UPDATE agreement_fields SET label = $2, type = $3, options = $4 WHERE id = $1 RETURNING *`, [
      cur.id,
      input.label,
      input.type,
      input.options ? JSON.stringify(input.options) : null,
    ]);
    return toField(row);
  });

  app.delete<{ Params: { id: string } }>("/v1/agreement-fields/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    requirePerm(a, "settings:manage");
    const r = await s.db.query(`DELETE FROM agreement_fields WHERE id = $1 AND tenant_id = $2 RETURNING id`, [req.params.id, a.tenantId]);
    if (!r.length) throw notFound("Campo");
    return reply.code(204).send();
  });

  // ───────── Vistas guardadas ─────────

  const toView = (r: any, a: AuthContext): AgreementView => ({ id: r.id, name: r.name, filters: r.filters ?? {}, shared: r.shared, mine: ownsView(a, r) });

  app.get("/v1/agreement-views", { preHandler: auth }, async (req) => {
    const a = A(req);
    const rows = await s.db.query(`SELECT * FROM agreement_views WHERE tenant_id = $1 AND ${viewVisibleSql(2)} ORDER BY name`, [
      a.tenantId,
      ...viewOwnerParams(a),
    ]);
    return { items: rows.map((r) => toView(r, a)) };
  });

  app.post("/v1/agreement-views", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = AgreementViewInput.parse(req.body);
    if (input.shared && !hasPerm(a, "settings:manage")) throw forbidden("Compartir una vista con toda la organización requiere settings:manage");
    const row = await s.db.one(
      `INSERT INTO agreement_views (id, tenant_id, user_id, name, filters, shared, created_by_api_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [uuidv7(), a.tenantId, a.userId, input.name, JSON.stringify(input.filters), Boolean(input.shared), a.userId ? null : a.apiKeyId],
    );
    reply.code(201);
    return toView(row, a);
  });

  app.delete<{ Params: { id: string } }>("/v1/agreement-views/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const v = await s.db.one<any>(`SELECT * FROM agreement_views WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!v) throw notFound("Vista");
    // Con una API key (userId null) y una vista creada por otra key (user_id NULL), null === null no la hace dueña.
    if (!ownsView(a, v) && !hasPerm(a, "settings:manage")) throw forbidden();
    await s.db.query(`DELETE FROM agreement_views WHERE id = $1`, [v.id]);
    return reply.code(204).send();
  });
}
