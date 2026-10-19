// Filtros avanzados de GET /v1/envelopes (alias `e`): rangos de fechas, sincronización incremental por fecha de
// actualización, metadata (contención jsonb), destinatario, plantilla y origen. Los usa el handler de envelopes.ts.
import { badRequest } from "../../lib/errors";

type Query = Record<string, unknown>;

const one = (v: unknown): string | undefined => (Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : typeof v === "string" ? v : undefined);
const many = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((x): x is string => typeof x === "string");

function date(q: Query, name: string): string | null {
  const v = one(q[name]);
  if (v === undefined || v === "") return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw badRequest("validation_error", `${name}: fecha inválida (ISO 8601)`, [{ path: name, message: "fecha inválida" }]);
  return new Date(t).toISOString();
}

/** Pares de metadata pedidos: `metadata=clave:valor` (repetible) y `metadata[clave]=valor`. */
export function metadataFilters(q: Query): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of many(q.metadata)) {
    const i = raw.indexOf(":");
    if (i <= 0) throw badRequest("validation_error", "metadata: usar clave:valor", [{ path: "metadata", message: "formato clave:valor" }]);
    out[raw.slice(0, i)] = raw.slice(i + 1);
  }
  for (const [k, v] of Object.entries(q)) {
    const m = /^metadata\[(.+)\]$/.exec(k);
    if (m && one(v) !== undefined) out[m[1]] = one(v)!;
  }
  if (Object.keys(out).length > 10) throw badRequest("validation_error", "metadata: máximo 10 filtros", [{ path: "metadata", message: "máximo 10" }]);
  return out;
}

/** Condiciones SQL adicionales (empiezan con " AND"). Agrega sus parámetros a `params`. */
export function envelopeSearchSql(q: Query, params: unknown[], alias = "e"): string {
  let where = "";
  const add = (cond: (p: string) => string, value: unknown) => {
    params.push(value);
    where += ` AND ${cond(`$${params.length}`)}`;
  };
  const ranges: [string, string, string][] = [
    ["created_from", "created_at", ">="],
    ["created_to", "created_at", "<"],
    ["updated_from", "updated_at", ">="],
    ["updated_since", "updated_at", ">="],
    ["updated_to", "updated_at", "<"],
    ["sent_from", "sent_at", ">="],
    ["sent_to", "sent_at", "<"],
    ["completed_from", "completed_at", ">="],
    ["completed_to", "completed_at", "<"],
  ];
  for (const [name, col, op] of ranges) {
    const d = date(q, name);
    if (d) add((p) => `${alias}.${col} ${op} ${p}::timestamptz`, d);
  }
  const meta = metadataFilters(q);
  // Contención jsonb (usa el índice GIN): compara contra valores string, que es como se guarda la metadata de los
  // integradores. Todos los pares en un solo objeto.
  if (Object.keys(meta).length) add((p) => `${alias}.metadata @> ${p}::jsonb`, JSON.stringify(meta));
  const templateId = one(q.template_id);
  if (templateId) {
    if (!/^[0-9a-f-]{36}$/i.test(templateId)) throw badRequest("validation_error", "template_id inválido", [{ path: "template_id", message: "uuid" }]);
    add((p) => `${alias}.metadata @> jsonb_build_object('templateId', ${p}::text)`, templateId.toLowerCase());
  }
  const recipient = one(q.recipient)?.trim().toLowerCase();
  if (recipient) {
    add((p) => `EXISTS (SELECT 1 FROM recipients sr WHERE sr.envelope_id = ${alias}.id AND (lower(sr.email) = ${p} OR sr.phone = ${p}))`, recipient);
  }
  const via = one(q.created_via);
  if (via) {
    if (via !== "api" && via !== "web") throw badRequest("validation_error", "created_via: api o web", [{ path: "created_via", message: "api | web" }]);
    add((p) => `${alias}.created_via = ${p}`, via);
  }
  return where;
}
