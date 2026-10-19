// Envío masivo (Fase 4): una plantilla + N filas (CSV o JSON) → N sobres, creados y enviados por la cola.
// Se valida todo antes de crear nada; cada fila se procesa de forma idempotente (un sobre por fila, siempre).
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateBulkSendInput,
  EnvelopeFromTemplateInput,
  type BulkRowError,
  type BulkRowInput,
  type BulkSend,
  type BulkSendItem,
  type BulkValidationResult,
} from "@calasign/shared";
import type { Db } from "../infra/db";
import type { Actor } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { iso, queryList, uuidv7 } from "../lib/util";
import { assertTemplateAccess, hasPerm } from "./access";
import { csvCell } from "./agreements/common";
import { idempotent } from "./envelopes";
import { ownerCanStillCreate } from "./owner-check";
import { tenantPlan } from "./billing/plans";
import { authenticate, type AuthContext, type Services } from "./context";
import { insertEnvelopeFromTemplate, loadTemplateDetail, loadTemplateForUse, planFromTemplate, type LoadedTemplate } from "./templates";

const CHUNK = 20;
type FromTemplateInput = ReturnType<typeof EnvelopeFromTemplateInput.parse>;

// ───────────────────────────── CSV ─────────────────────────────

/** Parser RFC 4180: comillas, comas o punto y coma (Excel en español/portugués), saltos de línea dentro de comillas. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delim = count(";") > count(",") ? ";" : count("\t") > count(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === "") {
      q = true;
    } else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const ATTR_ALIASES: Record<string, keyof BulkRowInput["recipients"][number]> = {
  name: "name",
  nombre: "name",
  nome: "name",
  email: "email",
  correo: "email",
  "e-mail": "email",
  phone: "phone",
  telefono: "phone",
  teléfono: "phone",
  telefone: "phone",
  whatsapp: "phone",
  channels: "channels",
  canales: "channels",
  canais: "channels",
  locale: "locale",
  idioma: "locale",
  iddocumenttype: "idDocumentType",
  iddocumentnumber: "idDocumentNumber",
  documento: "idDocumentNumber",
};

/** Convierte las filas de un CSV en filas de envío. Las columnas se interpretan contra los roles de la plantilla. */
export function csvToRows(text: string, roles: { id: string; name: string }[]): { rows: BulkRowInput[]; columns: string[]; fileErrors: string[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], columns: [], fileErrors: ["El CSV está vacío"] };
  const header = table[0].map((h) => h.trim());
  const fileErrors: string[] = [];
  type Col = { kind: "attr"; roleId: string; attr: string } | { kind: "field"; label: string } | { kind: "subject" } | { kind: "ignore" };
  const cols: Col[] = header.map((h) => {
    const lower = h.toLowerCase();
    if (!h) return { kind: "ignore" };
    if (lower === "subject" || lower === "asunto" || lower === "assunto") return { kind: "subject" };
    const fm = /^(field|campo)[.:](.+)$/i.exec(h);
    if (fm) return { kind: "field", label: fm[2].trim() };
    const dot = h.lastIndexOf(".");
    if (dot > 0) {
      const roleName = h.slice(0, dot).trim().toLowerCase();
      const attrKey = h.slice(dot + 1).trim().toLowerCase();
      // Solo claves propias: "Firmante.constructor" leía la función heredada y no daba el error de dato desconocido.
      const attr = Object.hasOwn(ATTR_ALIASES, attrKey) ? ATTR_ALIASES[attrKey] : undefined;
      const role = roles.find((r) => r.name.toLowerCase() === roleName);
      if (role && attr) return { kind: "attr", roleId: role.id, attr };
      if (!role) fileErrors.push(`Columna "${h}": no hay ningún rol "${h.slice(0, dot)}" en la plantilla`);
      else fileErrors.push(`Columna "${h}": dato desconocido (usá name, email, phone, channels o locale)`);
      return { kind: "ignore" };
    }
    fileErrors.push(`Columna "${h}" desconocida (formato: Rol.email, field.Etiqueta o subject)`);
    return { kind: "ignore" };
  });
  const rows: BulkRowInput[] = table.slice(1).map((cells) => {
    const byRole = new Map<string, Record<string, unknown>>();
    const prefill: Record<string, string> = {};
    let subject: string | null = null;
    cols.forEach((c, i) => {
      const v = (cells[i] ?? "").trim();
      if (c.kind === "subject") subject = v || null;
      else if (c.kind === "field") {
        if (v) prefill[c.label] = v;
      } else if (c.kind === "attr") {
        const rec = byRole.get(c.roleId) ?? { roleId: c.roleId };
        if (v) {
          if (c.attr === "channels") rec.channels = v.toLowerCase().split(/[|\s,/+]+/).filter(Boolean);
          else rec[c.attr] = c.attr === "email" ? v.toLowerCase() : v;
        }
        byRole.set(c.roleId, rec);
      }
    });
    return { recipients: [...byRole.values()] as BulkRowInput["recipients"], prefill, subject };
  });
  return { rows, columns: header, fileErrors };
}

/** CSV de ejemplo para una plantilla: una columna por dato de cada rol y por campo prellenable con etiqueta. */
export function csvSkeleton(tpl: Awaited<ReturnType<typeof loadTemplateDetail>>): string {
  // Lo que sale de la plantilla (asunto, roles, etiquetas, opciones) va con csvCell: una etiqueta "=HYPERLINK(…)" se
  // ejecutaba al abrir el modelo en Excel. El teléfono de ejemplo es fijo y empieza con "+" (csvCell le agregaría un ').
  const header: string[] = [csvCell("subject")];
  const example: string[] = [csvCell(tpl.template.subject ?? tpl.template.name)];
  for (const r of tpl.roles) {
    header.push(...[`${r.name}.name`, `${r.name}.email`, `${r.name}.phone`, `${r.name}.channels`].map(csvCell));
    example.push(csvCell(`Nombre ${r.name}`), csvCell(`${r.name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@example.com`), csvEscape("+5491100000000"), "email");
  }
  const labels = new Set<string>();
  for (const f of tpl.fields) {
    if (!f.label || f.readOnly || f.formula) continue;
    if (!["text", "number", "dropdown", "company", "title"].includes(f.type)) continue;
    if (labels.has(f.label)) continue;
    labels.add(f.label);
    header.push(csvCell(`field.${f.label}`));
    example.push(csvCell(f.type === "dropdown" ? (f.options?.[0] ?? "") : f.type === "number" ? "100" : ""));
  }
  return `${header.join(",")}\r\n${example.join(",")}\r\n`;
}

// ───────────────────────────── Validación ─────────────────────────────

interface Prepared {
  row: number;
  input: FromTemplateInput | null;
  errors: string[];
  names: string[];
}

function normalizeRecipient(r: BulkRowInput["recipients"][number]) {
  const x: Record<string, unknown> = { ...r };
  for (const k of Object.keys(x)) if (x[k] === "" || x[k] === null) delete x[k];
  if (!x.channels || (Array.isArray(x.channels) && x.channels.length === 0)) {
    x.channels = x.email ? ["email"] : x.phone ? ["whatsapp"] : ["email"];
  }
  return x;
}

function prepareRows(l: LoadedTemplate, rows: BulkRowInput[], base: { templateId: string; subject?: string | null; message?: string | null; locale?: string; expiresAt?: string | null }) {
  const roleName = new Map(l.tpl.roles.map((r) => [r.id, r.name]));
  return rows.map((row, i): Prepared => {
    const names = row.recipients.map((r) => r.name ?? "").filter(Boolean);
    const candidate = {
      templateId: base.templateId,
      subject: row.subject || base.subject || undefined,
      message: base.message ?? undefined,
      locale: base.locale,
      expiresAt: base.expiresAt ?? undefined,
      recipients: row.recipients.map(normalizeRecipient),
      prefill: row.prefill,
      metadata: row.metadata,
      send: true,
    };
    const parsed = EnvelopeFromTemplateInput.safeParse(candidate);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((iss) => {
        const [k, idx, attr] = iss.path;
        if (k === "recipients" && typeof idx === "number") {
          const r = row.recipients[idx];
          const who = (r?.roleId && roleName.get(r.roleId)) || r?.role || `destinatario ${idx + 1}`;
          return `${who}${attr ? `.${String(attr)}` : ""}: ${iss.message}`;
        }
        return `${iss.path.join(".") || "fila"}: ${iss.message}`;
      });
      return { row: i + 1, input: null, errors, names };
    }
    try {
      planFromTemplate(l, parsed.data);
      return { row: i + 1, input: parsed.data, errors: [], names };
    } catch (e) {
      return { row: i + 1, input: null, errors: [e instanceof AppError ? e.message : String(e)], names };
    }
  });
}

async function resolveRows(s: Services, a: AuthContext, raw: unknown) {
  const tenantId = a.tenantId;
  const input = CreateBulkSendInput.parse(raw);
  // Una plantilla restringida no se puede usar sin poder verla.
  await assertTemplateAccess(s.db, a, input.templateId, "view");
  const loaded = await loadTemplateForUse(s.db, tenantId, input.templateId);
  let rows: BulkRowInput[];
  let columns: string[] = [];
  if (input.csv !== undefined) {
    const r = csvToRows(input.csv, loaded.tpl.roles);
    if (r.fileErrors.length) throw new AppError(422, "invalid_csv", r.fileErrors.join(". "), { fileErrors: r.fileErrors, columns: r.columns });
    rows = r.rows;
    columns = r.columns;
  } else rows = input.rows ?? [];
  if (rows.length === 0) throw badRequest("no_rows", "No hay filas para enviar");
  if (rows.length > 5000) throw badRequest("too_many_rows", "Máximo 5000 filas por envío");
  const prepared = prepareRows(loaded, rows, {
    templateId: input.templateId,
    subject: input.subject,
    message: input.message,
    locale: input.locale,
    expiresAt: input.expiresAt,
  });
  return { input, loaded, prepared, columns };
}

function validationResult(prepared: Prepared[], columns: string[]): BulkValidationResult {
  const errors: BulkRowError[] = prepared.filter((p) => p.errors.length).map((p) => ({ row: p.row, errors: p.errors }));
  return { total: prepared.length, valid: prepared.length - errors.length, invalid: errors.length, errors, columns };
}

// ───────────────────────────── Lectura ─────────────────────────────

/**
 * Un envío masivo crea sobres a nombre de quien lo lanzó: lo ve quien lo creó o quien ve todos los sobres, y lo cancela
 * quien lo creó o quien administra todos los sobres (como con los sobres sueltos).
 */
function ownsBulk(a: AuthContext, b: any): boolean {
  if (a.apiKeyId) return b.actor?.type === "api_key" && b.actor?.id === a.apiKeyId;
  return Boolean(a.userId) && b.created_by === a.userId;
}

function canViewBulk(a: AuthContext, b: any): boolean {
  return hasPerm(a, "envelopes:view_all") || hasPerm(a, "envelopes:manage_all") || ownsBulk(a, b);
}

async function loadBulk(db: Db, a: AuthContext, id: string): Promise<BulkSend> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Envío masivo");
  const b = await db.one<any>(`SELECT * FROM bulk_sends WHERE id = $1 AND tenant_id = $2`, [id, a.tenantId]);
  if (!b || !canViewBulk(a, b)) throw notFound("Envío masivo");
  return toBulk(b, await countsFor(db, [b.id]));
}

async function countsFor(db: Db, ids: string[]) {
  const rows = ids.length
    ? await db.query<any>(`SELECT bulk_send_id, status, count(*)::int AS n FROM bulk_send_items WHERE bulk_send_id = ANY($1) GROUP BY 1, 2`, [ids])
    : [];
  return (id: string, status: string) => rows.find((r) => r.bulk_send_id === id && r.status === status)?.n ?? 0;
}

function toBulk(b: any, n: (id: string, status: string) => number): BulkSend {
  return {
    id: b.id,
    name: b.name,
    templateId: b.template_id,
    templateName: b.template_name,
    status: b.status,
    total: b.total,
    sent: n(b.id, "sent"),
    failed: n(b.id, "failed"),
    cancelled: n(b.id, "cancelled"),
    pending: n(b.id, "pending") + n(b.id, "processing"),
    createdAt: iso(b.created_at)!,
    completedAt: iso(b.completed_at),
    cancelledAt: iso(b.cancelled_at),
  };
}

const toItem = (r: any): BulkSendItem => ({
  id: r.id,
  row: r.row_number,
  status: r.status,
  envelopeId: r.envelope_id,
  recipients: (r.input?.recipients ?? []).map((x: any) => x.name).filter(Boolean),
  error: r.error,
  processedAt: iso(r.processed_at),
});

// ───────────────────────────── Rutas ─────────────────────────────

export async function bulkRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  const big = { preHandler: auth, bodyLimit: 12 * 1024 * 1024 };

  app.get<{ Params: { id: string } }>("/v1/templates/:id/bulk-csv", { preHandler: auth }, async (req, reply) => {
    const tpl = await loadTemplateDetail(s.db, A(req).tenantId, req.params.id);
    const name = tpl.template.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "plantilla";
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="envio-masivo.csv"; filename*=UTF-8''${encodeURIComponent(name)}-envio-masivo.csv`);
    return "﻿" + csvSkeleton(tpl);
  });

  app.post("/v1/bulk-sends/validate", big, async (req) => {
    const { prepared, columns } = await resolveRows(s, A(req), req.body);
    return validationResult(prepared, columns);
  });

  // Con Idempotency-Key: si la respuesta se pierde y se reintenta, no se arma (ni se manda) un segundo envío masivo.
  app.post("/v1/bulk-sends", big, async (req, reply) =>
    idempotent(s, req, reply, async () => {
    const a = A(req);
    const { input, loaded, prepared, columns } = await resolveRows(s, a, req.body);
    const result = validationResult(prepared, columns);
    if (result.invalid > 0 && !input.skipInvalid) {
      throw new AppError(422, "rows_invalid", `${result.invalid} de ${result.total} filas tienen errores`, result);
    }
    if (result.valid === 0) throw new AppError(422, "rows_invalid", "Ninguna fila es válida", result);
    const id = uuidv7();
    const actor: Actor = { type: a.actor.type, id: a.actor.id, label: a.actor.label, ip: a.actor.ip, userAgent: a.actor.userAgent };
    await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO bulk_sends (id, tenant_id, template_id, template_name, name, status, total, options, actor, created_by)
         VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)`,
        [
          id,
          a.tenantId,
          loaded.tpl.template.id,
          loaded.tpl.template.name,
          input.name ?? null,
          prepared.length,
          JSON.stringify({ subject: input.subject ?? null, message: input.message ?? null, locale: input.locale ?? null, expiresAt: input.expiresAt ?? null }),
          JSON.stringify(actor),
          a.userId,
        ],
      );
      const pendingIds: string[] = [];
      for (const p of prepared) {
        const itemId = uuidv7();
        const ok = p.errors.length === 0;
        if (ok) pendingIds.push(itemId);
        await t.query(
          `INSERT INTO bulk_send_items (id, tenant_id, bulk_send_id, row_number, input, status, error, processed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            itemId,
            a.tenantId,
            id,
            p.row,
            JSON.stringify(p.input ?? { recipients: p.names.map((name) => ({ name })) }),
            ok ? "pending" : "failed",
            ok ? null : p.errors.join("; ").slice(0, 2000),
            ok ? null : new Date().toISOString(),
          ],
        );
      }
      for (let i = 0; i < pendingIds.length; i += CHUNK) {
        await enqueue(t, "bulk", { bulkSendId: id, tenantId: a.tenantId, itemIds: pendingIds.slice(i, i + CHUNK) }, { dedupeKey: `bulk:${id}:${i / CHUNK}` });
      }
    });
    return { status: 201, body: await loadBulk(s.db, a, id) };
    }),
  );

  app.get("/v1/bulk-sends", { preHandler: auth }, async (req) => {
    const a = A(req);
    const all = hasPerm(a, "envelopes:view_all") || hasPerm(a, "envelopes:manage_all");
    const rows = await s.db.query<any>(
      all
        ? `SELECT * FROM bulk_sends WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`
        : a.apiKeyId
          ? `SELECT * FROM bulk_sends WHERE tenant_id = $1 AND actor->>'type' = 'api_key' AND actor->>'id' = $2 ORDER BY created_at DESC LIMIT 100`
          : `SELECT * FROM bulk_sends WHERE tenant_id = $1 AND created_by = $2 ORDER BY created_at DESC LIMIT 100`,
      all ? [a.tenantId] : [a.tenantId, a.apiKeyId ?? a.userId],
    );
    const n = await countsFor(s.db, rows.map((r) => r.id));
    return { items: rows.map((b) => toBulk(b, n)) };
  });

  app.get<{ Params: { id: string } }>("/v1/bulk-sends/:id", { preHandler: auth }, async (req) => loadBulk(s.db, A(req), req.params.id));

  app.get<{ Params: { id: string }; Querystring: { status?: string; offset?: string; limit?: string } }>(
    "/v1/bulk-sends/:id/items",
    { preHandler: auth },
    async (req) => {
      const a = A(req);
      await loadBulk(s.db, a, req.params.id);
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit ?? 100)) || 100));
      // Acotado: un offset enorme (1e21) se escribía en el SQL como "1e+21" y respondía 500.
      const offset = Math.min(1_000_000_000, Math.max(0, Math.trunc(Number(req.query.offset ?? 0)) || 0));
      const params: unknown[] = [req.params.id];
      let where = `bulk_send_id = $1`;
      const statuses = queryList(req.query.status);
      if (statuses.length) {
        params.push(statuses);
        where += ` AND status = ANY($2)`;
      }
      const total = (await s.db.one<any>(`SELECT count(*)::int AS n FROM bulk_send_items WHERE ${where}`, params))?.n ?? 0;
      const rows = await s.db.query<any>(`SELECT * FROM bulk_send_items WHERE ${where} ORDER BY row_number LIMIT ${limit} OFFSET ${offset}`, params);
      return { items: rows.map(toItem), total };
    },
  );

  app.get<{ Params: { id: string } }>("/v1/bulk-sends/:id/results.csv", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    await loadBulk(s.db, a, req.params.id);
    const rows = await s.db.query<any>(`SELECT * FROM bulk_send_items WHERE bulk_send_id = $1 ORDER BY row_number`, [req.params.id]);
    const lines = [["row", "status", "envelopeId", "recipients", "error"].join(",")];
    // csvCell: los nombres vienen de datos externos; sin neutralizar, "=…" se ejecuta como fórmula en la planilla.
    for (const r of rows.map(toItem)) lines.push([r.row, r.status, r.envelopeId ?? "", r.recipients.join(" | "), r.error ?? ""].map(csvCell).join(","));
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="resultados-${req.params.id}.csv"`);
    return "﻿" + lines.join("\r\n") + "\r\n";
  });

  app.post<{ Params: { id: string } }>("/v1/bulk-sends/:id/cancel", { preHandler: auth }, async (req) => {
    const a = A(req);
    await s.db.tx(async (t) => {
      const b = await t.one<any>(`SELECT * FROM bulk_sends WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, a.tenantId]);
      if (!b || !canViewBulk(a, b)) throw notFound("Envío masivo");
      if (!ownsBulk(a, b) && !hasPerm(a, "envelopes:manage_all")) throw forbidden("Solo quien lanzó el envío masivo (o quien administra todos los sobres) puede cancelarlo");
      if (!["queued", "running"].includes(b.status)) throw conflict("not_cancellable", "El envío ya terminó");
      await t.query(`UPDATE bulk_sends SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1`, [b.id]);
      await t.query(`UPDATE bulk_send_items SET status = 'cancelled', processed_at = now() WHERE bulk_send_id = $1 AND status = 'pending'`, [b.id]);
    });
    return loadBulk(s.db, a, req.params.id);
  });
}

// ───────────────────────────── Worker ─────────────────────────────

export async function handleBulkJob(
  d: { db: Db; log: { info(o: object, m?: string): void; warn(o: object, m?: string): void } },
  p: { bulkSendId: string; tenantId: string; itemIds: string[] },
) {
  const b = await d.db.one<any>(`SELECT * FROM bulk_sends WHERE id = $1`, [p.bulkSendId]);
  if (!b || b.status === "cancelled" || b.status === "completed") return;
  if (b.status === "queued") await d.db.query(`UPDATE bulk_sends SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'`, [b.id]);
  let loaded: LoadedTemplate | null = null;
  let loadError: string | null = null;
  try {
    if (!b.template_id) throw new Error("La plantilla fue eliminada");
    loaded = await loadTemplateForUse(d.db, b.tenant_id, b.template_id);
  } catch (e) {
    loadError = (e as Error).message;
  }
  const actor = b.actor as Actor;
  const ctx = { tenantId: b.tenant_id, userId: b.created_by, apiKeyId: actor.type === "api_key" ? actor.id ?? null : null, actor };
  // Los sobres salen a nombre de quien lanzó el envío: si mientras tanto dejó la organización, perdió el permiso o
  // se revocó su API key, las filas que faltan no se envían.
  const ownerGone = await ownerCanStillCreate(d.db, { tenantId: ctx.tenantId, userId: ctx.apiKeyId ? null : ctx.userId, apiKeyId: ctx.apiKeyId }, b.template_id);
  if (ownerGone) {
    loaded = null;
    loadError = ownerGone;
  }
  // El plan vigente, no el del momento en que se lanzó: si la organización pasó a un plan sin envío masivo (o, para
  // un envío lanzado con API key, sin acceso por API), las filas que faltan no se envían. Lo mismo que los formularios web.
  const { plan } = await tenantPlan(d.db, b.tenant_id);
  if (!plan.features.includes("bulk_send")) {
    loaded = null;
    loadError = `El plan ${plan.name} no incluye el envío masivo`;
  } else if (ctx.apiKeyId && !plan.features.includes("api")) {
    loaded = null;
    loadError = `El plan ${plan.name} no incluye el acceso por API`;
  }

  for (const itemId of p.itemIds) {
    try {
      await d.db.tx(async (t) => {
        // Bloqueo de la fila: si ya se procesó (reintento del job), no se vuelve a crear el sobre.
        const item = await t.one<any>(`SELECT * FROM bulk_send_items WHERE id = $1 AND status = 'pending' FOR UPDATE`, [itemId]);
        if (!item) return;
        const cur = await t.one<any>(`SELECT status FROM bulk_sends WHERE id = $1`, [b.id]);
        if (cur?.status === "cancelled") {
          await t.query(`UPDATE bulk_send_items SET status = 'cancelled', processed_at = now() WHERE id = $1`, [itemId]);
          return;
        }
        if (!loaded) throw new Error(loadError ?? "plantilla no disponible");
        const input = EnvelopeFromTemplateInput.parse(item.input);
        const plan = planFromTemplate(loaded, input);
        const envId = await insertEnvelopeFromTemplate(t, ctx, loaded, input, plan, { bulkSendId: b.id, bulkRow: item.row_number });
        await t.query(`UPDATE bulk_send_items SET status = 'sent', envelope_id = $2, error = NULL, processed_at = now() WHERE id = $1`, [itemId, envId]);
      });
    } catch (e) {
      const msg = e instanceof AppError ? e.message : (e as Error).message ?? String(e);
      await d.db.query(`UPDATE bulk_send_items SET status = 'failed', error = $2, processed_at = now() WHERE id = $1 AND status = 'pending'`, [
        itemId,
        msg.slice(0, 2000),
      ]);
      d.log.warn({ bulkSendId: b.id, itemId, err: msg }, "fila de envío masivo falló");
    }
  }
  const left = await d.db.one<any>(`SELECT count(*)::int AS n FROM bulk_send_items WHERE bulk_send_id = $1 AND status IN ('pending','processing')`, [b.id]);
  if ((left?.n ?? 0) === 0) {
    await d.db.query(`UPDATE bulk_sends SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'running'`, [b.id]);
    d.log.info({ bulkSendId: b.id }, "envío masivo terminado");
  }
}
