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
  LOCALES,
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
import {
  insertEnvelopeFromTemplate,
  isPrefillable,
  loadTemplateDetail,
  loadTemplateForUse,
  normLabel,
  planFromTemplate,
  templateSendIssues,
  type LoadedTemplate,
} from "./templates";

const CHUNK = 20;
type FromTemplateInput = ReturnType<typeof EnvelopeFromTemplateInput.parse>;

// ───────────────────────────── CSV ─────────────────────────────

/** Archivo CSV mal formado (p. ej. una comilla sin cerrar): va como error del archivo, no de una fila. */
export class CsvFileError extends Error {}

/**
 * Separador: el que más aparece en la primera línea con datos (fuera de comillas; se saltan las líneas vacías del
 * principio) entre coma, punto y coma (Excel en español/portugués) y tabulador; con empate, la coma. Como en el parser,
 * una comilla abre un campo entre comillas solo al principio del campo: una suelta en medio de un campo es un carácter
 * más (no invierte el estado y no esconde los separadores que siguen).
 */
function detectDelimiter(src: string): string {
  const n: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  let fieldStart = true;
  let seenData = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') i++;
        else q = false;
      }
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (seenData) break;
      fieldStart = true;
      continue;
    }
    if (c === '"' && fieldStart) {
      q = true;
      seenData = true;
      fieldStart = false;
    } else if (c in n) {
      n[c]++;
      seenData = true;
      fieldStart = true;
    } else {
      if (c.trim() !== "") seenData = true;
      fieldStart = false;
    }
  }
  return [";", "\t"].reduce((best, d) => (n[d] > n[best] ? d : best), ",");
}

/**
 * Parser RFC 4180: comillas, comas, punto y coma o tabulador, saltos de línea dentro de comillas. `maxRecords`: deja de
 * leer al pasar esa cantidad de filas no vacías (devuelve maxRecords + 1), así un archivo enorme no se arma entero en
 * memoria. Una comilla sin cerrar al final lanza CsvFileError con la línea donde empieza.
 */
export function parseCsv(text: string, maxRecords = Infinity): string[][] {
  return parseCsvWithLines(text, maxRecords).rows;
}

/**
 * parseCsv con la línea del archivo donde empieza cada fila (`lines[i]` es la de `rows[i]`): los errores se informan
 * con el número de línea que se ve al abrir el archivo, contando las líneas vacías y los saltos dentro de comillas.
 */
export function parseCsvWithLines(text: string, maxRecords = Infinity): { rows: string[][]; lines: number[] } {
  const src = text.replace(/^\uFEFF/, "");
  const delim = detectDelimiter(src);
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  let line = 1;
  let quoteLine = 0;
  let recordLine = 1;
  const push = () => {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) {
      rows.push(row);
      lines.push(recordLine);
    }
    row = [];
    cell = "";
    // El salto que cierra la fila ya se contó: la próxima empieza en la línea actual.
    recordLine = line;
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
  if (rows.length > maxRecords) return { rows, lines };
  if (q) throw new CsvFileError(`Hay una comilla sin cerrar que empieza en la línea ${quoteLine} del archivo`);
  if (cell !== "" || row.length) push();
  return { rows, lines };
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
): { rows: BulkRowInput[]; columns: string[]; fileErrors: string[]; tooManyRows?: boolean; lines?: number[] } {
  let table: string[][];
  let lines: number[];
  try {
    // Encabezado + el máximo de filas + 1: con una de más ya se sabe que se pasa, sin leer (ni armar) el resto.
    ({ rows: table, lines } = parseCsvWithLines(text, BULK_MAX_ROWS + 1));
  } catch (e) {
    if (e instanceof CsvFileError) return { rows: [], columns: [], fileErrors: [e.message] };
    throw e;
  }
  if (table.length === 0) return { rows: [], columns: [], fileErrors: ["El CSV está vacío"] };
  // Sin el apóstrofo que agrega una planilla (o csvCell en el modelo) para que un encabezado no se lea como fórmula.
  const header = table[0].map((h) => h.trim().replace(/^'/, "").trim());
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
  type Col = { kind: "attr"; roleId: string; attr: string; whatsapp?: boolean } | { kind: "field"; label: string } | { kind: "subject" } | { kind: "ignore" };
  const cols: Col[] = header.map((h) => {
    const lower = h.toLowerCase();
    if (!h) return { kind: "ignore" };
    if (lower === "subject" || lower === "asunto" || lower === "assunto") {
      dupCheck("subject", h);
      return { kind: "subject" };
    }
    // Primero un dato de un rol (Rol.email): un rol llamado "Campo" o "Field" no se toma por un campo a prellenar.
    const dot = h.lastIndexOf(".");
    const roleName = dot > 0 ? h.slice(0, dot).trim().toLowerCase() : "";
    const attrKey = dot > 0 ? h.slice(dot + 1).trim().toLowerCase() : "";
    // Solo claves propias: "Firmante.constructor" leía la función heredada y no daba el error de dato desconocido.
    const attr = dot > 0 && Object.hasOwn(ATTR_ALIASES, attrKey) ? ATTR_ALIASES[attrKey] : undefined;
    const role = dot > 0 ? roles.find((r) => r.name.trim().toLowerCase() === roleName) : undefined;
    if (role && attr) {
      dupCheck(`attr:${role.id}:${attr}`, h);
      // Rol.whatsapp: el teléfono, y además el canal WhatsApp.
      return { kind: "attr", roleId: role.id, attr, whatsapp: attrKey === "whatsapp" };
    }
    const fm = /^(field|campo)[.:](.+)$/i.exec(h);
    if (fm) {
      dupCheck(`field:${normLabel(fm[2])}`, h);
      return { kind: "field", label: fm[2].trim() };
    }
    if (dot > 0) {
      if (!role) fileErrors.push(`Columna "${h}": no hay ningún rol "${h.slice(0, dot)}" en la plantilla`);
      else fileErrors.push(`Columna "${h}": dato desconocido (usá name, email, phone, channels o locale)`);
      return { kind: "ignore" };
    }
    fileErrors.push(`Columna "${h}" desconocida (formato: Rol.email, field.Etiqueta o subject)`);
    return { kind: "ignore" };
  });
  const rows: BulkRowInput[] = table.slice(1).map((cells) => {
    const byRole = new Map<string, Record<string, unknown>>();
    const whatsapp = new Set<string>();
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
          else if (c.attr === "email") rec.email = v.toLowerCase();
          // Idioma sin distinguir mayúsculas ("PT-br", "pt_BR"): se guarda como lo espera la API (uno de LOCALES).
          else if (c.attr === "locale") rec.locale = LOCALES.find((l) => l.toLowerCase() === v.toLowerCase().replace(/_/g, "-")) ?? v;
          else rec[c.attr] = v;
          if (c.whatsapp) whatsapp.add(c.roleId);
        }
        byRole.set(c.roleId, rec);
      }
    });
    for (const roleId of whatsapp) {
      const rec = byRole.get(roleId)!;
      // Sin columna de canales, los de siempre (correo si hay correo) más WhatsApp.
      const base = Array.isArray(rec.channels) && rec.channels.length ? (rec.channels as string[]) : rec.email ? ["email"] : [];
      rec.channels = [...new Set([...base, "whatsapp"])];
    }
    return { recipients: [...byRole.values()] as BulkRowInput["recipients"], prefill, subject };
  });
  return { rows, columns: header, fileErrors, lines: lines.slice(1) };
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
  // Una columna por etiqueta (sin distinguir mayúsculas ni espacios a los lados, como el prellenado), solo si algún
  // campo con esa etiqueta acepta un valor.
  const labels = new Set<string>();
  for (const f of tpl.fields) {
    if (!f.label?.trim() || !isPrefillable(f)) continue;
    if (labels.has(normLabel(f.label))) continue;
    labels.add(normLabel(f.label));
    header.push(csvCell(`field.${f.label.trim()}`));
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

/**
 * Teléfono como lo escribe la gente o lo deja una planilla: sin espacios, guiones, puntos ni paréntesis, y el prefijo
 * internacional 00 como +. Solo dígitos (sin +) queda así y la fila da un error propio (ver prepareRows): agregarle un
 * + adivinando no es seguro (un número nacional, p. ej. 11 98765-4321 de São Paulo, pasaría a ser de otro país y el
 * mensaje le llegaría a otra persona).
 */
export function normalizePhone(v: string): string {
  const p = v.replace(/[\s\-.()\u00a0]/g, "");
  return /^00[1-9]/.test(p) ? `+${p.slice(2)}` : p;
}

const PHONE_NO_COUNTRY = "falta el código de país: escribilo con + adelante (p. ej. +5491123456789)";

function normalizeRecipient(r: BulkRowInput["recipients"][number]) {
  const x: Record<string, unknown> = { ...r };
  for (const k of Object.keys(x)) if (x[k] === "" || x[k] === null) delete x[k];
  if (typeof x.phone === "string") x.phone = normalizePhone(x.phone);
  if (!x.channels || (Array.isArray(x.channels) && x.channels.length === 0)) {
    x.channels = x.email ? ["email"] : x.phone ? ["whatsapp"] : ["email"];
  }
  return x;
}

/** `lineNumbers`: la línea del archivo de cada fila (CSV); sin ella, la posición en la lista (JSON). */
function prepareRows(
  l: LoadedTemplate,
  rows: BulkRowInput[],
  base: { templateId: string; subject?: string | null; message?: string | null; locale?: string; expiresAt?: string | null },
  lineNumbers?: number[],
) {
  const roleName = new Map(l.tpl.roles.map((r) => [r.id, r.name]));
  return rows.map((row, i): Prepared => {
    const rowNo = lineNumbers?.[i] ?? i + 1;
    const names = row.recipients.map((r) => r.name ?? "").filter(Boolean);
    const recipients = row.recipients.map(normalizeRecipient);
    const candidate = {
      templateId: base.templateId,
      subject: row.subject || base.subject || undefined,
      message: base.message ?? undefined,
      locale: base.locale,
      // null = 30 días en un envío masivo (como si no viniera; ver CreateBulkSendInput.expiresAt): a diferencia de
      // from-template, donde null es sin vencimiento, acá siempre vencen.
      expiresAt: base.expiresAt ?? undefined,
      recipients,
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
          const phone = recipients[idx]?.phone;
          const msg = attr === "phone" && typeof phone === "string" && /^\d+$/.test(phone) ? PHONE_NO_COUNTRY : iss.message;
          return `${who}${attr ? `.${String(attr)}` : ""}: ${msg}`;
        }
        return `${iss.path.join(".") || "fila"}: ${iss.message}`;
      });
      return { row: rowNo, input: null, errors, names };
    }
    try {
      planFromTemplate(l, parsed.data);
      return { row: rowNo, input: parsed.data, errors: [], names };
    } catch (e) {
      return { row: rowNo, input: null, errors: [e instanceof AppError ? e.message : String(e)], names };
    }
  });
}

async function resolveRows(s: Services, a: AuthContext, raw: unknown) {
  const tenantId = a.tenantId;
  const input = CreateBulkSendInput.parse(raw);
  // Una plantilla restringida no se puede usar sin poder verla.
  await assertTemplateAccess(s.db, a, input.templateId, "view");
  // Un vencimiento ya pasado daba sobres que no se podían enviar (cada fila fallaba al procesarse).
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw badRequest("invalid_expiry", "La fecha de vencimiento ya pasó");
  const loaded = await loadTemplateForUse(s.db, tenantId, input.templateId);
  // Lo que impide enviar cualquier sobre de la plantilla (rol firmante sin campo de firma, fórmula colgada), como en los
  // formularios web: antes se validaban las filas y fallaban todas al enviarse.
  const issues = templateSendIssues(loaded).map((i) => i.message);
  if (issues.length) throw new AppError(422, "template_not_sendable", `La plantilla no se puede enviar: ${issues.join(". ")}`, { templateIssues: issues });
  let rows: BulkRowInput[];
  let columns: string[] = [];
  let lines: number[] | undefined;
  if (input.csv !== undefined) {
    assertCsvEncoding(input.csv);
    const r = csvToRows(input.csv, loaded.tpl.roles);
    if (r.tooManyRows) throw badRequest("too_many_rows", `Máximo ${BULK_MAX_ROWS} filas por envío`);
    if (r.fileErrors.length) throw new AppError(422, "invalid_csv", r.fileErrors.join(". "), { fileErrors: r.fileErrors, columns: r.columns });
    rows = r.rows;
    columns = r.columns;
    lines = r.lines;
  } else rows = input.rows ?? [];
  if (rows.length === 0) throw badRequest("no_rows", "No hay filas para enviar");
  if (rows.length > BULK_MAX_ROWS) throw badRequest("too_many_rows", `Máximo ${BULK_MAX_ROWS} filas por envío`);
  const prepared = prepareRows(loaded, rows, {
    templateId: input.templateId,
    subject: input.subject,
    message: input.message,
    locale: input.locale,
    expiresAt: input.expiresAt,
  }, lines);
  return { input, loaded, prepared, columns };
}

/**
 * Un CSV que no estaba en UTF-8 (p. ej. guardado por Excel en Windows-1252) y se leyó como UTF-8 trae U+FFFD donde
 * iban las letras con tilde: los nombres llegaban así a los sobres. La web lo decodifica bien antes de mandarlo; si
 * igual llega con U+FFFD (API, otro cliente), es un error del archivo con la línea.
 */
export function assertCsvEncoding(csv: string) {
  const at = csv.indexOf("\uFFFD");
  if (at < 0) return;
  const line = csv.slice(0, at).split("\n").length;
  const msg = `El archivo tiene caracteres que no se pudieron leer (línea ${line}): guardalo como "CSV UTF-8" y volvé a subirlo`;
  throw new AppError(422, "csv_encoding", msg, { fileErrors: [msg], line });
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
    .map(([k, v]) => [normLabel(k), v])
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

/**
 * Sobres que quedan en el cupo del mes (null: plan sin tope), descontando las filas pendientes de los envíos masivos
 * en curso de la organización: dos envíos lanzados seguidos no pasan el control con el mismo cupo.
 */
async function quotaLeft(db: Db, tenantId: string) {
  const { plan } = await tenantPlan(db, tenantId);
  if (plan.envelopesPerMonth === null) return { plan, remaining: null as number | null, used: 0 };
  const used = await envelopesSentThisMonth(db, tenantId);
  const pending = await db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM bulk_send_items i JOIN bulk_sends b ON b.id = i.bulk_send_id
      WHERE b.tenant_id = $1 AND b.status IN ('queued','running') AND i.status IN ('pending','processing')`,
    [tenantId],
  );
  return { plan, remaining: Math.max(0, plan.envelopesPerMonth - used - (pending?.n ?? 0)), used };
}

/**
 * 402 plan_limit si `needed` sobres no entran en el cupo del mes. Se llama dentro de la transacción que da de alta las
 * filas, con un lock por organización (pg_advisory_xact_lock): dos altas o reintentos simultáneos no ven el mismo cupo
 * libre (cada uno descuenta las filas pendientes que el otro ya confirmó).
 */
async function assertQuotaFor(t: Db, tenantId: string, needed: number) {
  await t.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`bulk-quota:${tenantId}`]);
  const q = await quotaLeft(t, tenantId);
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
  // "retryable": fallidas que "Reintentar fallidas" volvería a encolar: las que guardan el pedido entero (las inválidas
  // por sus datos guardan solo los nombres) y fallaron por algo del momento (retryable; NULL en filas anteriores a la
  // columna, que se reintentaban todas).
  const rows = ids.length
    ? await db.query<any>(
        `SELECT bulk_send_id, CASE WHEN status = 'failed' AND input ? 'templateId' AND retryable IS NOT FALSE THEN 'retryable' ELSE status END AS status, count(*)::int AS n
           FROM bulk_send_items WHERE bulk_send_id = ANY($1) GROUP BY 1, 2`,
        [ids],
      )
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
    failed: n(b.id, "failed") + n(b.id, "retryable"),
    retryable: b.status === "cancelled" ? 0 : n(b.id, "retryable"),
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
      .header("content-disposition", `attachment; filename="envio-masivo.csv"; filename*=UTF-8''${encodeURIComponent(name)}-envio-masivo.csv`)
      .header("cache-control", "private, no-store");
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
    const id = uuidv7();
    const actor: Actor = { type: a.actor.type, id: a.actor.id, label: a.actor.label, ip: a.actor.ip, userAgent: a.actor.userAgent };
    await s.db.tx(async (t) => {
      // La plantilla, FOR SHARE hasta el commit: una edición en curso termina antes (y acá se ve que cambió) y una
      // posterior ve este envío en cola y responde 409 template_in_use_bulk. Si cambió desde que se validaron las
      // filas, se vuelve a validar (las filas podían no cerrar con la versión nueva).
      const cur = await t.one<{ v: string }>(`SELECT updated_at::text AS v FROM templates WHERE id = $1 AND tenant_id = $2 FOR SHARE`, [loaded.tpl.template.id, a.tenantId]);
      if (!cur) throw notFound("Plantilla");
      if (loaded.stamp && cur.v !== loaded.stamp) throw conflict("template_changed", "La plantilla cambió mientras se preparaba el envío: validá el archivo de nuevo y volvé a enviarlo");
      // Todo o nada con el cupo del mes: si no entran todas las filas válidas, no se lanza (antes se enviaban hasta
      // agotarlo y el resto fallaba fila por fila). Dentro de la transacción del alta y con lock por organización:
      // dos POST simultáneos no pasan con el mismo cupo. El cupo se vuelve a controlar en cada envío (sendEnvelope).
      await assertQuotaFor(t, a.tenantId, result.valid);
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
          // expiresAt null queda guardado como "sin indicar": al procesar las filas da 30 días (ver prepareRows).
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
          `INSERT INTO bulk_send_items (id, tenant_id, bulk_send_id, row_number, input, status, error, processed_at, retryable)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            itemId,
            a.tenantId,
            id,
            p.row,
            JSON.stringify(p.input ?? { recipients: p.names.map((name) => ({ name })) }),
            ok ? "pending" : "failed",
            ok ? null : p.errors.join("; ").slice(0, 2000),
            ok ? null : new Date().toISOString(),
            // Inválida por sus datos: se corrige en un envío nuevo, no se reintenta.
            ok ? null : false,
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
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="resultados-${req.params.id}.csv"`)
      .header("cache-control", "private, no-store");
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

  // Reintenta las filas fallidas por un problema del momento (cupo, plan o permisos de quien lo lanzó, error interno o
  // temporal). Las que fallaron por sus datos o por la plantilla no: hay que corregirlas en un envío nuevo. Mismos permisos que crear el envío, y quien lo lanzó (o quien
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
      // Las filas con datos válidos guardan el pedido entero (con templateId); las que fallaron por sus datos, solo los nombres.
      const failed = await t.query<any>(
        `SELECT id, input FROM bulk_send_items WHERE bulk_send_id = $1 AND status = 'failed' AND input ? 'templateId' AND retryable IS NOT FALSE ORDER BY row_number`,
        [b.id],
      );
      const ids = failed.filter((i) => EnvelopeFromTemplateInput.safeParse(i.input).success).map((i) => i.id as string);
      if (!ids.length) throw conflict("nothing_to_retry", "No hay filas para reintentar (las que fallaron por sus datos o por la plantilla se corrigen en un envío nuevo)");
      await assertQuotaFor(t, a.tenantId, ids.length);
      // Nueva ronda: el cierre del último intento de un job anterior (que pudo quedar corriendo) solo toca las filas de
      // su ronda, no las que se reencolan acá.
      const round = (await t.one<{ r: number }>(`SELECT COALESCE(max(retry_round), 0)::int + 1 AS r FROM bulk_send_items WHERE bulk_send_id = $1`, [b.id]))!.r;
      await t.query(`UPDATE bulk_send_items SET status = 'pending', error = NULL, processed_at = NULL, envelope_id = NULL, retryable = NULL, retry_round = $2 WHERE id = ANY($1)`, [ids, round]);
      await t.query(`UPDATE bulk_sends SET status = 'running', completed_at = NULL, updated_at = now() WHERE id = $1`, [b.id]);
      for (let i = 0; i < ids.length; i += CHUNK) {
        await enqueue(t, "bulk", { bulkSendId: b.id, tenantId: a.tenantId, itemIds: ids.slice(i, i + CHUNK), retryRound: round }, { dedupeKey: `bulk:${b.id}:retry:${round}:${i / CHUNK}` });
      }
    });
    return loadBulk(s.db, a, req.params.id);
  });
}

// ───────────────────────────── Worker ─────────────────────────────

type BulkDeps = { db: Db; log: { info(o: object, m?: string): void; warn(o: object, m?: string): void } };
type BulkJobPayload = { bulkSendId: string; tenantId: string; itemIds: string[]; retryRound?: number };

/** Error de una fila que no se arregla reintentando (plantilla borrada, dueño sin permiso, plan): la fila queda fallida. */
const permanent = (e: unknown) => e instanceof AppError || e instanceof ZodError;

/** Códigos de Postgres de un problema del momento: conexión (08xxx), serialización, deadlock, servidor reiniciándose. */
const TRANSIENT_PG = /^(08...|40001|40P01|57P0[123]|53300)$/;
/** Errores de red de Node. */
const TRANSIENT_NET = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED"]);

/**
 * Error del momento (base caída, conexión cortada, serialización o deadlock): se reintenta el job. Cualquier otra
 * excepción es de esa fila (p. ej. un dato que rompe al armar el sobre): se reintenta igual no se arreglaría.
 */
export function isTransientError(e: unknown): boolean {
  for (let cur: any = e, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    const code = typeof cur.code === "string" ? cur.code : "";
    if (TRANSIENT_PG.test(code) || TRANSIENT_NET.has(code)) return true;
    if (/connection (terminated|reset|refused)|Connection terminated unexpectedly|socket hang up/i.test(String(cur.message ?? ""))) return true;
  }
  return false;
}

export async function handleBulkJob(d: BulkDeps, p: BulkJobPayload, job?: JobContext) {
  try {
    await runBulkJob(d, p, job);
  } catch (err) {
    // Un error del momento (base, red) antes o fuera de las filas se relanza y la cola reintenta el job (cada fila es
    // idempotente). En el último intento, las filas de este job que quedaron se cierran como fallidas y el envío como
    // terminado: si no, quedaban pendientes y el envío "en curso" para siempre. Solo las de su ronda: las que
    // "Reintentar fallidas" ya volvió a encolar son de otro job.
    if (isLastAttempt(job, err)) {
      try {
        await bulkJobGaveUp(d, p, err);
      } catch (e) {
        d.log.warn({ bulkSendId: p.bulkSendId, err: String(e) }, "no se pudieron cerrar las filas del envío masivo");
      }
    }
    throw err;
  }
}

/**
 * Un job del masivo no va a correr más (último intento fallido, o el worker murió en el último intento y el barrido lo
 * dio por fallado): sus filas que quedaron se cierran como fallidas y, si no queda nada, el envío como terminado. Solo
 * las de su ronda. Idempotente.
 */
export async function bulkJobGaveUp(d: BulkDeps, p: BulkJobPayload, err: unknown) {
  if (!p?.bulkSendId || !Array.isArray(p.itemIds)) return;
  const msg = `No se pudo procesar la fila: ${(err as Error)?.message ?? String(err)}`.slice(0, 2000);
  await d.db.query(
    `UPDATE bulk_send_items SET status = 'failed', error = $3, processed_at = now(), retryable = true
      WHERE bulk_send_id = $1 AND id = ANY($2) AND status IN ('pending','processing') AND retry_round = $4`,
    [p.bulkSendId, p.itemIds, msg, p.retryRound ?? 0],
  );
  await finishIfDone(d, p.bulkSendId);
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

async function runBulkJob(d: BulkDeps, p: BulkJobPayload, job?: JobContext) {
  const round = p.retryRound ?? 0;
  const b = await d.db.one<any>(`SELECT * FROM bulk_sends WHERE id = $1`, [p.bulkSendId]);
  if (!b || b.status === "cancelled" || b.status === "completed") return;
  if (b.status === "queued") await d.db.query(`UPDATE bulk_sends SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'queued'`, [b.id]);
  let loaded: LoadedTemplate | null = null;
  let loadError: string | null = null;
  // Si las filas que no se pueden armar se pueden reintentar después: plan o permisos de quien lanzó el envío se pueden
  // arreglar; una plantilla borrada o vacía no (habría que lanzar otro envío).
  let loadRetryable = false;
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
    loadRetryable = true;
  }
  // El plan vigente, no el del momento en que se lanzó: si la organización pasó a un plan sin envío masivo (o, para
  // un envío lanzado con API key, sin acceso por API), las filas que faltan no se envían. Lo mismo que los formularios web.
  const { plan } = await tenantPlan(d.db, b.tenant_id);
  if (!plan.features.includes("bulk_send")) {
    loaded = null;
    loadError = `El plan ${plan.name} no incluye el envío masivo`;
    loadRetryable = true;
  } else if (ctx.apiKeyId && !plan.features.includes("api")) {
    loaded = null;
    loadError = `El plan ${plan.name} no incluye el acceso por API`;
    loadRetryable = true;
  }

  for (const itemId of p.itemIds) {
    try {
      await d.db.tx(async (t) => {
        // Bloqueo de la fila: si ya se procesó (reintento del job), no se vuelve a crear el sobre. Solo las de la ronda
        // de este job: una fila que "Reintentar fallidas" volvió a encolar la procesa el job nuevo.
        const item = await t.one<any>(`SELECT * FROM bulk_send_items WHERE id = $1 AND status = 'pending' AND retry_round = $2 FOR UPDATE`, [itemId, round]);
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
      // Un error del momento (conexión, serialización, deadlock) se relanza para que la cola reintente el job (las filas
      // ya enviadas no se repiten), salvo en el último intento: ahí queda fallida solo esta fila y se sigue con las
      // demás. Cualquier otro error es de esta fila (validación, plantilla, plan o una excepción al armar su sobre):
      // la marca fallida y no arrastra al resto del lote.
      const transient = !permanent(e) && isTransientError(e);
      if (transient && !isLastAttempt(job, e)) throw e;
      let msg: string;
      if (e instanceof ZodError) msg = e.issues.map((i) => `${i.path.join(".") || "fila"}: ${i.message}`).join("; ");
      else if (e instanceof AppError) msg = e.message;
      else {
        d.log.warn({ bulkSendId: b.id, itemId, err: String(e) }, transient ? "envío masivo: error del momento en el último intento" : "envío masivo: error inesperado en una fila");
        msg = transient ? "No se pudo procesar la fila (error temporal); podés reintentarla" : "Error interno al crear el sobre de esta fila; podés reintentarla";
      }
      // Se puede reintentar lo del momento o ajeno a la fila (error temporal o interno, cupo, plan o permisos de quien
      // lo lanzó); lo que es de sus datos o de la plantilla (validación, prellenado, plantilla borrada) fallaría igual.
      const retryable = e instanceof AppError ? e.code === "plan_limit" || (e.code === "bulk_unavailable" && loadRetryable) : !(e instanceof ZodError);
      if (e instanceof AppError && e.code === "plan_limit") {
        // Cupo del mes agotado: las filas que faltan (de todo el envío) fallarían igual. Se marcan sin intentarlas.
        await d.db.query(`UPDATE bulk_send_items SET status = 'failed', error = $2, processed_at = now(), retryable = true WHERE bulk_send_id = $1 AND status = 'pending'`, [
          b.id,
          msg.slice(0, 2000),
        ]);
        d.log.warn({ bulkSendId: b.id, itemId }, "envío masivo: la organización llegó al cupo del plan");
        break;
      }
      await d.db.query(`UPDATE bulk_send_items SET status = 'failed', error = $2, processed_at = now(), retryable = $4 WHERE id = $1 AND status = 'pending' AND retry_round = $3`, [
        itemId,
        msg.slice(0, 2000),
        round,
        retryable,
      ]);
      d.log.warn({ bulkSendId: b.id, itemId, err: msg }, "fila de envío masivo falló");
    }
  }
  await finishIfDone(d, b.id);
}
