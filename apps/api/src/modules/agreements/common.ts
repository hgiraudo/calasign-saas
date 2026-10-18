// Utilidades compartidas por los módulos de acuerdos (Fase 6).
import { blocksToText, renderTemplate, type Agreement } from "@calasign/shared";
import type { Db } from "../../infra/db";
import type { BlobStore } from "../../infra/storage";
import { hasPerm, envelopeVisibilitySql } from "../access";
import type { AuthContext } from "../context";
import { iso } from "../../lib/util";

export interface Deps {
  db: Db;
  blobs: BlobStore;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

/** Quita acentos (el buscador no depende de la extensión unaccent: igual en Postgres y PGlite). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Texto de una línea con variables ({{cliente.nombre}}), para títulos, asuntos y destinatarios. */
export function interpolate(src: string | null | undefined, data: unknown, locale = "es"): string {
  if (!src) return "";
  if (!src.includes("{{")) return src;
  try {
    return blocksToText(renderTemplate(src.replace(/\r?\n/g, " "), data, { locale }).blocks).trim();
  } catch {
    return src;
  }
}

/** Lectura de una ruta (a.b.c) en datos JSON, sin evaluar nada. */
export function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setPath(data: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  if (parts.some((p) => p === "__proto__" || p === "constructor" || p === "prototype")) throw new Error("ruta inválida");
  let cur: Record<string, unknown> = data;
  for (const p of parts.slice(0, -1)) {
    if (cur[p] == null || typeof cur[p] !== "object" || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export function toNumberOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replace(/[^\d,.-]/g, "");
  // Sin dígitos no es un número ("a convenir"): Number("") daría 0 y el acuerdo quedaría con valor 0.
  if (!/\d/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** AAAA-MM-DD a partir de "2027-03-01", "01/03/2027" o una fecha ISO; null si no se entiende. */
export function toIsoDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  let y: string, mo: string, d: string;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) [y, mo, d] = [m[3], m[2].padStart(2, "0"), m[1].padStart(2, "0")];
  else return null;
  // Tiene que ser una fecha que exista ("31/02/2027" no): si no, Postgres la rechaza al guardarla como date y la
  // ingesta del acuerdo o el paso del workflow fallan.
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number(y) < 1 || dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return `${y}-${mo}-${d}`;
}

// ───────────────────────────── Repositorio: visibilidad y mapeo ─────────────────────────────

/** Acuerdos visibles: los propios, los de sobres a los que tiene acceso, o todos con envelopes:view_all. */
export function agreementVisibilitySql(a: AuthContext, params: unknown[], alias = "ag"): string {
  if (hasPerm(a, "envelopes:view_all") || hasPerm(a, "envelopes:manage_all")) return "TRUE";
  const own: string[] = [];
  if (a.userId) {
    params.push(a.userId);
    own.push(`${alias}.owner_user_id = $${params.length}`);
  }
  if (a.apiKeyId) {
    params.push(a.apiKeyId);
    own.push(`${alias}.created_by_api_key = $${params.length}`);
  }
  const env = envelopeVisibilitySql(a, params, "ve");
  own.push(`(${alias}.envelope_id IS NOT NULL AND EXISTS (SELECT 1 FROM envelopes ve WHERE ve.id = ${alias}.envelope_id${env}))`);
  return `(${own.join(" OR ")})`;
}

export function canManageAgreement(a: AuthContext, row: { owner_user_id: string | null; created_by_api_key: string | null }): boolean {
  if (hasPerm(a, "envelopes:manage_all")) return true;
  return (a.userId != null && row.owner_user_id === a.userId) || (a.apiKeyId != null && row.created_by_api_key === a.apiKeyId);
}

export function toAgreement(r: any): Agreement {
  return {
    id: r.id,
    source: r.source,
    envelopeId: r.envelope_id,
    title: r.title,
    counterparties: r.counterparties ?? [],
    status: r.status,
    effectiveDate: dateStr(r.effective_date),
    expiryDate: dateStr(r.expiry_date),
    renewalDate: dateStr(r.renewal_date),
    noticeDays: r.notice_days,
    value: r.value == null ? null : Number(r.value),
    currency: r.currency,
    tags: r.tags ?? [],
    metadata: r.metadata ?? {},
    fileName: r.file_name,
    sha256: r.sha256,
    signatures: r.signatures,
    ownerUserId: r.owner_user_id,
    ownerName: r.owner_name ?? null,
    completedAt: iso(r.completed_at),
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    ...(r.excerpt !== undefined ? { excerpt: r.excerpt } : {}),
  };
}

export function dateStr(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/** Recalcula el vector de búsqueda: metadatos visibles + texto del PDF, sin acentos, en español y portugués. */
export async function refreshSearchVector(db: Db, agreementId: string) {
  const r = await db.one<any>(`SELECT title, counterparties, tags, metadata, text_folded FROM agreements WHERE id = $1`, [agreementId]);
  if (!r) return;
  const meta = [
    r.title,
    ...(r.counterparties ?? []).flatMap((c: any) => [c.name, c.email, c.role]),
    ...(r.tags ?? []),
    ...Object.values(r.metadata ?? {}).map((v) => (v == null ? "" : String(v))),
  ]
    .filter(Boolean)
    .join(" ");
  const docText = `${fold(meta)}\n${r.text_folded ?? ""}`.slice(0, 900_000);
  await db.query(`UPDATE agreements SET search_vector = to_tsvector('spanish', $2) || to_tsvector('portuguese', $2) WHERE id = $1`, [agreementId, docText]);
}

// ───────────────────────────── CSV ─────────────────────────────

/** Celda CSV segura (sin inyección de fórmulas en planillas). */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
