// Envío masivo (Fase 4): una plantilla + N filas (CSV o JSON) → N sobres, creados y enviados por la cola.
// Se valida todo antes de crear nada; cada fila se procesa de forma idempotente (un sobre por fila, siempre).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  BULK_MAX_ROWS,
  CreateBulkSendInput,
  PLANS,
  PLAN_IDS,
  EnvelopeFromTemplateInput,
  type BulkRowError,
  type BulkRowInput,
  type BulkSend,
  type BulkSendItem,
  type BulkValidationResult,
} from "@calasign/shared";
import type { Db } from "../infra/db";
import type { Actor } from "../infra/evidence";
import { enqueue, isLastAttempt, type JobContext } from "../infra/queue";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { iso, queryList, uuidv7 } from "../lib/util";
import { assertTemplateAccess, hasPerm } from "./access";
import { csvCell } from "./agreements/common";
import { idempotent } from "./envelopes";
import { ownerCanStillCreate } from "./owner-check";
import { envelopesSentThisMonth, planLimitError, requireFeature, tenantPlan } from "./billing/plans";
import { authenticate, type AuthContext, type Services } from "./context";
import { insertEnvelopeFromTemplate, loadTemplateDetail, loadTemplateForUse, planFromTemplate, type LoadedTemplate } from "./templates";

const CHUNK = 20;
type FromTemplateInput = ReturnType<typeof EnvelopeFromTemplateInput.parse>;

// ───────────────────────────── CSV ─────────────────────────────

/** Archivo CSV mal formado (p. ej. una comilla sin cerrar): va como error del archivo, no de una fila. */
export class CsvFileError extends Error {}

/**
 * Separador: el que más aparece en la primera línea (fuera de comillas) entre coma, punto y coma (Excel en
 * español/portugués) y tabulador; con empate, la coma.
 */
function detectDelimiter(src: string): string {
  const n: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') q = !q;
    else if (!q && (c === "\n" || c === "\r")) break;
    else if (!q && c in n) n[c]++;
  }
  return [";", "\t"].reduce((best, d) => (n[d] > n[best] ? d : best), ",");
}

/**
 * Parser RFC 4180: comillas, comas, punto y coma o tabulador, saltos de línea dentro de comillas. `maxRecords`: deja de
 * leer al pasar esa cantidad de filas no vacías (devuelve maxRecords + 1), así un archivo enorme no se arma entero en
 * memoria. Una comilla sin cerrar al final lanza CsvFileError con la línea donde empieza.
 */
export function parseCsv(text: string, maxRecords = Infinity): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const delim = detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  let line = 1;
  let quoteLine = 0;
  const push = () => {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
    cell = "";
  };
  for (let i = 0; i < src.length && rows.length <= maxRecords; i++) {
    const c = src[i];
    if (c === "\n") line++;
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === "") {
      q = true;
      quoteLine = line;
    } else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") {
        i++;
        line++;
      }
      push();
    } else cell += c;
  }
  if (rows.length > maxRecords) return rows;
  if (q) throw new CsvFileError(`Hay una comilla sin cerrar que empieza en la línea ${quoteLine} del archivo`);
  if (cell !== "" || row.length) push();
  return rows;
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
export function csvToRows(
  text: string,
  roles: { id: string; name: string }[],
): { rows: BulkRowInput[]; columns: string[]; fileErrors: string[]; tooManyRows?: boolean } {
  let table: string[][];
  try {
    // Encabezado + el máximo de filas + 1: con una de más ya se sabe que se pasa, sin leer (ni armar) el resto.
    table = parseCsv(text, BULK_MAX_ROWS + 1);
  } catch (e) {
    if (e instanceof CsvFileError) return { rows: [], columns: [], fileErrors: [e.message] };
    throw e;
  }
  if (table.length === 0) return { rows: [], columns: [], fileErrors: ["El CSV está vacío"] };
  const header = table[0].map((h) => h.trim());
  if (table.length - 1 > BULK_MAX_ROWS) return { rows: [], columns: header, fileErrors: [], tooManyRows: true };
  const fileErrors: string[] = [];
  // Columnas repetidas (también dos alias del mismo dato, p. ej. Cliente.email y Cliente.correo): la última pisaba a la
  // anterior sin aviso.
  const seen = new Map<string, string>();
  const dupCheck = (key: string, h: string) => {
    const prev = seen.get(key);
    if (prev !== undefined) fileErrors.push(prev.toLowerCase() === h.toLowerCase() ? `Columna "${h}" repetida` : `Las columnas "${prev}" y "${h}" son el mismo dato`);
    else seen.set(key, h);
  };
  type Col = { kind: "attr"; roleId: string; attr: string } | { kind: "field"; label: string } | { kind: "subject" } | { kind: "ignore" };
  const cols: Col[] = header.map((h) => {
    const lower = h.toLowerCase();
    if (!h) return { kind: "ignore" };
    if (lower === "subject" || lower === "asunto" || lower === "assunto") {
      dupCheck("subject", h);
      return { kind: "subject" };
    }
    const fm = /^(field|campo)[.:](.+)$/i.exec(h);
    if (fm) {
      dupCheck(`field:${fm[2].trim().toLowerCase()}`, h);
      return { kind: "field", label: fm[2].trim() };
    }
    const dot = h.lastIndexOf(".");
    if (dot > 0) {
      const roleName = h.slice(0, dot).trim().toLowerCase();
      const attrKey = h.slice(dot + 1).trim().toLowerCase();
      // Solo claves propias: "Firmante.constructor" leía la función heredada y no daba el error de dato desconocido.
      const attr = Object.hasOwn(ATTR_ALIASES, attrKey) ? ATTR_ALIASES[attrKey] : undefined;
      const role = roles.find((r) => r.name.toLowerCase() === roleName);
      if (role && attr) {
        dupCheck(`attr:${role.id}:${attr}`, h);
        return { kind: "attr", roleId: role.id, attr };
      }
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
    if (r.tooManyRows) throw badRequest("too_many_rows", `Máximo ${BULK_MAX_ROWS} filas por envío`);
    if (r.fileErrors.length) throw new AppError(422, "invalid_csv", r.fileErrors.join(". "), { fileErrors: r.fileErrors, columns: r.columns });
    rows = r.rows;
    columns = r.columns;
  } else rows = input.rows ?? [];
  if (rows.length === 0) throw badRequest("no_rows", "No hay filas para enviar");
  if (rows.length > BULK_MAX_ROWS) throw badRequest("too_many_rows", `Máximo ${BULK_MAX_ROWS} filas por envío`);
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

/** Clave de una fila para detectar repetidas: destinatarios (rol, nombre, correo, teléfono) y prellenado, sin orden. */
function rowKey(input: FromTemplateInput): string {
  const recips = input.recipients
    .map((r) => [r.roleId ?? `@${(r.role ?? "").toLowerCase()}`, (r.name ?? "").trim().toLowerCase(), (r.email ?? "").trim().toLowerCase(), (r.phone ?? "").trim()])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const prefill = Object.entries(input.prefill ?? {})
    .map(([k, v]) => [k.toLowerCase(), v])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify([recips, prefill]);
}

/** Filas válidas iguales a una anterior. */
export function duplicateRows(prepared: { row: number; input: FromTemplateInput | null }[]): { row: number; sameAs: number }[] {
  const first = new Map<string, number>();
  const out: { row: number; sameAs: number }[] = [];
  for (const p of prepared) {
    if (!p.input) continue;
    const k = rowKey(p.input);
    const prev = first.get(k);
    if (prev !== undefined) out.push({ row: p.row, sameAs: prev });
    else first.set(k, p.row);
  }
  return out;
}

/** Sobres que quedan en el cupo del mes (null: plan sin tope). */
async function quotaLeft(db: Db, tenantId: string) {
  const { plan } = await tenantPlan(db, tenantId);
  if (plan.envelopesPerMonth === null) return { plan, remaining: null as number | null, used: 0 };
  const used = await envelopesSentThisMonth(db, tenantId);
  return { plan, remaining: Math.max(0, plan.envelopesPerMonth - used), used };
}

/** 402 plan_limit si `needed` sobres no entran en el cupo del mes. */
async function assertQuotaFor(db: Db, tenantId: string, needed: number) {
  const q = await quotaLeft(db, tenantId);
  if (q.remaining === null || needed <= q.remaining) return;
  const max = q.plan.envelopesPerMonth!;
  throw planLimitError(`El envío necesita ${needed} sobres y en el cupo del mes del plan ${q.plan.name} quedan ${q.remaining} (de ${max})`, {
    plan: q.plan.id,
    limit: "envelopes_per_month",
    used: q.used,
    max,
    suggestedPlan: PLAN_IDS.find((id) => PLANS[id].envelopesPerMonth === null || PLANS[id].envelopesPerMonth! >= q.used + needed) ?? null,
  });
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
  // onRequest: la credencial se comprueba antes de leer y parsear un cuerpo de hasta 12 MB (si no, sin credencial se
  // podía hacer parsear muchos cuerpos grandes a la vez).
  const big = { onRequest: auth, bodyLimit: 12 * 1024 * 1024 };

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
    const result = validationResult(prepared, columns);
    // Avisos que no impiden enviar: filas repetidas (un sobre repetido a las mismas personas) y cupo del mes insuficiente
    // (crear el envío respondería 402).
    const duplicates = duplicateRows(prepared);
    const { remaining } = await quotaLeft(s.db, A(req).tenantId);
    const warnings: string[] = [];
    if (duplicates.length) {
      warnings.push(`${duplicates.length} fila(s) repiten destinatarios y datos de una anterior: ${duplicates.slice(0, 10).map((d) => `${d.row} (= ${d.sameAs})`).join(", ")}${duplicates.length > 10 ? "…" : ""}`);
    }
    if (remaining !== null && result.valid > remaining) warnings.push(`Hay ${result.valid} filas válidas y en el cupo del mes quedan ${remaining} sobres: el envío se va a rechazar`);
    return { ...result, duplicates, quotaRemaining: remaining, warnings };
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
    // Todo o nada con el cupo del mes: si no entran todas las filas válidas, no se lanza (antes se enviaban hasta
    // agotarlo y el resto fallaba fila por fila). El cupo se vuelve a controlar en cada envío (sendEnvelope).
    await assertQuotaFor(s.db, a.tenantId, result.valid);
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

  // Reintenta las filas fallidas por un problema del momento (cupo, plantilla, error interno). Las que fallaron por sus
  // datos no: hay que corregirlas en un envío nuevo. Mismos permisos que crear el envío, y quien lo lanzó (o quien
  // administra todos los sobres).
  app.post<{ Params: { id: string } }>("/v1/bulk-sends/:id/retry-failed", { preHandler: auth }, async (req) => {
    const a = A(req);
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound("Envío masivo");
    requireFeature((await tenantPlan(s.db, a.tenantId)).plan, "bulk_send", "El envío masivo");
    await s.db.tx(async (t) => {
      const b = await t.one<any>(`SELECT * FROM bulk_sends WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, a.tenantId]);
      if (!b || !canViewBulk(a, b)) throw notFound("Envío masivo");
      if (!ownsBulk(a, b) && !hasPerm(a, "envelopes:manage_all")) throw forbidden("Solo quien lanzó el envío masivo (o quien administra todos los sobres) puede reintentarlo");
      if (b.status === "cancelled") throw conflict("not_retryable", "El envío masivo se canceló");
      const failed = await t.query<any>(`SELECT id, input FROM bulk_send_items WHERE bulk_send_id = $1 AND status = 'failed' ORDER BY row_number`, [b.id]);
      const ids = failed.filter((i) => EnvelopeFromTemplateInput.safeParse(i.input).success).map((i) => i.id as string);
      if (!ids.length) throw conflict("nothing_to_retry", "No hay filas para reintentar (las que tienen errores en sus datos se corrigen en un envío nuevo)");
      await assertQuotaFor(t, a.tenantId, ids.length);
      await t.query(`UPDATE bulk_send_items SET status = 'pending', error = NULL, processed_at = NULL, envelope_id = NULL WHERE id = ANY($1)`, [ids]);
      await t.query(`UPDATE bulk_sends SET status = 'running', completed_at = NULL, updated_at = now() WHERE id = $1`, [b.id]);
      const retry = uuidv7();
      for (let i = 0; i < ids.length; i += CHUNK) {
        await enqueue(t, "bulk", { bulkSendId: b.id, tenantId: a.tenantId, itemIds: ids.slice(i, i + CHUNK) }, { dedupeKey: `bulk:${b.id}:retry:${retry}:${i / CHUNK}` });
      }
    });
    return loadBulk(s.db, a, req.params.id);
  });
}

// ───────────────────────────── Worker ─────────────────────────────

type BulkDeps = { db: Db; log: { info(o: object, m?: string): void; warn(o: object, m?: string): void } };

/** Error de una fila que no se arregla reintentando (plantilla borrada, dueño sin permiso, plan): la fila queda fallida. */
const permanent = (e: unknown) => e instanceof AppError || e instanceof ZodError;

export async function handleBulkJob(d: BulkDeps, p: { bulkSendId: string; tenantId: string; itemIds: string[] }, job?: JobContext) {
  try {
    await runBulkJob(d, p);
  } catch (err) {
    // Un error del momento (base, red) se relanza y la cola reintenta el job (cada fila es idempotente). En el último
    // intento, las filas que quedaron se cierran como fallidas y el envío como terminado: si no, quedaban pendientes y
    // el envío "en curso" para siempre.
    if (isLastAttempt(job, err)) {
      const msg = `No se pudo procesar la fila: ${(err as Error)?.message ?? String(err)}`.slice(0, 2000);
      try {
        await d.db.query(`UPDATE bulk_send_items SET status = 'failed', error = $3, processed_at = now() WHERE bulk_send_id = $1 AND id = ANY($2) AND status IN ('pending','processing')`, [
          p.bulkSendId,
          p.itemIds,
          msg,
        ]);
        await finishIfDone(d, p.bulkSendId);
      } catch (e) {
        d.log.warn({ bulkSendId: p.bulkSendId, err: String(e) }, "no se pudieron cerrar las filas del envío masivo");
      }
    }
    throw err;
  }
}

async function finishIfDone(d: BulkDeps, bulkSendId: string) {
  const left = await d.db.one<any>(`SELECT count(*)::int AS n FROM bulk_send_items WHERE bulk_send_id = $1 AND status IN ('pending','processing')`, [bulkSendId]);
  if ((left?.n ?? 0) === 0) {
    const done = await d.db.query(
      `UPDATE bulk_sends SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 AND status IN ('queued','running') RETURNING id`,
      [bulkSendId],
    );
    if (done.length) d.log.info({ bulkSendId }, "envío masivo terminado");
  }
}

async function runBulkJob(d: BulkDeps, p: { bulkSendId: string; tenantId: string; itemIds: string[] }) {
  const b = await d.db.one<any>(`SELECT * FROM bulk_sends WHERE id = $1`, [p.bulkSendId]);
  if (!b || b.status === "cancelled" || b.status === "completed") return;
  if (b.status === "queued") await d.db.query(`UPDATE bulk_sends SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'`, [b.id]);
  let loaded: LoadedTemplate | null = null;
  let loadError: string | null = null;
  try {
    if (!b.template_id) throw conflict("template_deleted", "La plantilla fue eliminada");
    loaded = await loadTemplateForUse(d.db, b.tenant_id, b.template_id);
  } catch (e) {
    // Solo lo que no se arregla reintentando (plantilla borrada o vacía); un error de la base se relanza.
    if (!permanent(e)) throw e;
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
        if (!loaded) throw conflict("bulk_unavailable", loadError ?? "plantilla no disponible");
        const input = EnvelopeFromTemplateInput.parse(item.input);
        const plan = planFromTemplate(loaded, input);
        const envId = await insertEnvelopeFromTemplate(t, ctx, loaded, input, plan, { bulkSendId: b.id, bulkRow: item.row_number });
        await t.query(`UPDATE bulk_send_items SET status = 'sent', envelope_id = $2, error = NULL, processed_at = now() WHERE id = $1`, [itemId, envId]);
      });
    } catch (e) {
      // Solo los errores de la fila (validación, plantilla, plan) la marcan fallida; los demás se relanzan para que la
      // cola reintente el job (las filas ya enviadas no se repiten).
      if (!permanent(e)) throw e;
      const msg = e instanceof ZodError ? e.issues.map((i) => `${i.path.join(".") || "fila"}: ${i.message}`).join("; ") : (e as Error).message;
      if (e instanceof AppError && e.code === "plan_limit") {
        // Cupo del mes agotado: las filas que faltan (de todo el envío) fallarían igual. Se marcan sin intentarlas.
        await d.db.query(`UPDATE bulk_send_items SET status = 'failed', error = $2, processed_at = now() WHERE bulk_send_id = $1 AND status = 'pending'`, [
          b.id,
          msg.slice(0, 2000),
        ]);
        d.log.warn({ bulkSendId: b.id, itemId }, "envío masivo: la organización llegó al cupo del plan");
        break;
      }
      await d.db.query(`UPDATE bulk_send_items SET status = 'failed', error = $2, processed_at = now() WHERE id = $1 AND status = 'pending'`, [
        itemId,
        msg.slice(0, 2000),
      ]);
      d.log.warn({ bulkSendId: b.id, itemId, err: msg }, "fila de envío masivo falló");
    }
  }
  await finishIfDone(d, b.id);
}
