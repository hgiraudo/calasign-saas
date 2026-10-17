// Validación y normalización de valores de campos (los escribe el remitente al prellenar o el firmante al completar).
import type { Db } from "../infra/db";

export interface FieldSpec {
  type: string;
  required?: boolean;
  label?: string | null;
  options?: string[] | null;
  min?: number | null;
  max?: number | null;
}

/** Convierte "1.234,5" / "1234.5" / "1 234,50" en número. null si no es un número. */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Valida un valor escrito para un campo de texto/número/desplegable/empresa/cargo.
 * Devuelve el valor normalizado o un mensaje de error.
 */
export function checkValue(f: FieldSpec, raw: string | null | undefined): { value: string | null } | { error: string } {
  const v = (raw ?? "").trim();
  if (!v) return f.required ? { error: "obligatorio" } : { value: null };
  if (f.type === "number") {
    const n = parseNumber(v);
    if (n === null) return { error: "no es un número" };
    if (f.min != null && n < f.min) return { error: `mínimo ${f.min}` };
    if (f.max != null && n > f.max) return { error: `máximo ${f.max}` };
    return { value: v };
  }
  if (f.type === "dropdown") {
    if (!(f.options ?? []).includes(v)) return { error: "opción inválida" };
    return { value: v };
  }
  return { value: v.slice(0, 2000) };
}

export const VALUE_FIELD_TYPES = ["text", "number", "dropdown", "company", "title"];

/** Inserta un campo de sobre con todas sus propiedades (las de Fase 1 y las de productividad). */
export async function insertEnvelopeField(
  db: Db,
  p: {
    id: string;
    tenantId: string;
    envelopeId: string;
    documentId: string;
    recipientId: string;
    type: string;
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    required: boolean;
    label: string | null;
    value: string | null;
    readOnly: boolean;
    options: string[] | null;
    min: number | null;
    max: number | null;
  },
) {
  await db.query(
    `INSERT INTO fields (id, tenant_id, envelope_id, document_id, recipient_id, type, page, x, y, width, height, required, label,
       value, read_only, options, min_value, max_value)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      p.id,
      p.tenantId,
      p.envelopeId,
      p.documentId,
      p.recipientId,
      p.type,
      p.page,
      p.x,
      p.y,
      p.width,
      p.height,
      p.required,
      p.label,
      p.value,
      p.readOnly,
      p.options ? JSON.stringify(p.options) : null,
      p.min,
      p.max,
    ],
  );
}

/** Valida el valor prellenado por el remitente. Lanza un mensaje legible si no corresponde. */
export function checkSenderValue(f: FieldSpec & { readOnly?: boolean; value?: string | null }, where: string): string | null {
  if (f.value == null || f.value === "") return null;
  if (!VALUE_FIELD_TYPES.includes(f.type)) throw new Error(`${where}: el tipo ${f.type} no admite valor prellenado`);
  const r = checkValue({ ...f, required: false }, f.value);
  if ("error" in r) throw new Error(`${where}: valor prellenado inválido (${r.error})`);
  return r.value;
}
