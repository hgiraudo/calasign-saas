// Lógica de campos (Fase 4): condiciones de visibilidad y campos número calculados.
// Todo se evalúa en el servidor al completar; la web lo replica solo para mostrarlo en vivo.
import {
  computeFormulas,
  computeHidden,
  formulaRefs,
  parseFormula,
  type FieldCondition,
  type LogicField,
} from "@calasign/shared";
export { computeFormulas, computeHidden, conditionHolds, evaluateFormula, formatComputed, formulaRefs, parseFormula, tokenizeFormula } from "@calasign/shared";
import type { Db } from "../infra/db";
import { badRequest } from "../lib/errors";
import { uuidv7 } from "../lib/util";

// ───────────────────────────── Validación al guardar ─────────────────────────────

/**
 * Valida condiciones y fórmulas de una lista completa de campos (sobre o plantilla):
 * referencias existentes, sin autorreferencias ni ciclos, fórmulas parseables que citen campos número.
 */
export function validateLogic(fields: LogicField[]) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const numberLabels = new Map<string, LogicField>();
  for (const f of fields) {
    if (f.type !== "number" || !f.label) continue;
    const k = f.label.trim().toLowerCase();
    if (numberLabels.has(k) && fields.some((x) => x.formula && formulaRefs(x.formula).some((r) => r.trim().toLowerCase() === k))) {
      throw badRequest("invalid_formula", `Hay dos campos número con la etiqueta "${f.label}" y una fórmula la usa`);
    }
    numberLabels.set(k, f);
  }
  const deps = new Map<string, string[]>();
  fields.forEach((f, i) => {
    const where = `Campo ${i + 1}${f.label ? ` (${f.label})` : ""}`;
    const d: string[] = [];
    for (const c of f.conditions ?? []) {
      if (c.fieldId === f.id) throw badRequest("invalid_condition", `${where}: una condición no puede depender del mismo campo`);
      if (!byId.has(c.fieldId)) throw badRequest("invalid_condition", `${where}: la condición cita un campo que no existe`);
      d.push(c.fieldId);
    }
    if (f.formula) {
      if (f.type !== "number") throw badRequest("invalid_formula", `${where}: solo un campo número puede tener fórmula`);
      let refs: string[];
      try {
        refs = formulaRefs(f.formula);
        parseFormula(f.formula);
      } catch (e) {
        throw badRequest("invalid_formula", `${where}: fórmula inválida (${(e as Error).message})`);
      }
      for (const r of refs) {
        const ref = numberLabels.get(r.trim().toLowerCase());
        if (!ref) throw badRequest("invalid_formula", `${where}: la fórmula cita {${r}}, que no es un campo número del documento`);
        if (ref.id === f.id) throw badRequest("invalid_formula", `${where}: la fórmula no puede citarse a sí misma`);
        d.push(ref.id);
      }
    }
    deps.set(f.id, d);
  });
  // Ciclos (DFS).
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw badRequest("logic_cycle", "Las condiciones o fórmulas forman un ciclo");
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) visit(d);
    state.set(id, 2);
  };
  for (const f of fields) visit(f.id);
}

// ───────────────────────────── Persistencia ─────────────────────────────

/** Asigna ids a los campos que no lo traen (las condiciones se refieren a campos por id). */
export function assignFieldIds<T extends { id?: string }>(list: T[]): void {
  for (const f of list) f.id ??= uuidv7();
}

type LogicInput = { id?: string; type: string; label?: string | null; conditions?: FieldCondition[] | null; formula?: string | null };

/** Valida y guarda condiciones/fórmulas de la lista recién guardada en `fields` o `template_fields`. */
export async function saveFieldLogic(db: Db, table: "fields" | "template_fields", list: LogicInput[]) {
  const norm: LogicField[] = list.map((f) => ({
    id: f.id!,
    type: f.type,
    label: f.label ?? null,
    conditions: f.conditions?.length ? f.conditions : null,
    formula: f.formula?.trim() ? f.formula.trim() : null,
  }));
  validateLogic(norm);
  for (const f of norm) {
    if (!f.conditions && !f.formula) continue;
    // Un campo calculado nunca lo escribe el firmante ni es obligatorio para él.
    await db.query(
      `UPDATE ${table} SET conditions = $2, formula = $3${f.formula ? ", required = false, read_only = false" : ""} WHERE id = $1`,
      [f.id, f.conditions ? JSON.stringify(f.conditions) : null, f.formula],
    );
  }
}

/** Copia condiciones/fórmulas a campos nuevos (plantilla → sobre, sobre → plantilla), traduciendo ids. */
export async function copyFieldLogic(
  db: Db,
  table: "fields" | "template_fields",
  source: { id: string; conditions?: unknown; formula?: string | null }[],
  idMap: Map<string, string>,
) {
  const copied = new Set(idMap.values());
  for (const f of source) {
    const conds = (Array.isArray(f.conditions) ? f.conditions : null) as FieldCondition[] | null;
    if (!conds?.length && !f.formula) continue;
    const newId = idMap.get(f.id);
    if (!newId) continue;
    const mapped = conds?.map((c) => ({ ...c, fieldId: idMap.get(c.fieldId) ?? c.fieldId })).filter((c) => copied.has(c.fieldId)) ?? null;
    await db.query(`UPDATE ${table} SET conditions = $2, formula = $3 WHERE id = $1`, [
      newId,
      mapped?.length ? JSON.stringify(mapped) : null,
      f.formula ?? null,
    ]);
  }
}

/**
 * Quita las condiciones que citan campos que ya no existen (se borraron con su destinatario, rol o documento, o
 * porque el destinatario pasó a copia o aprobador). Una condición huérfana deja el campo oculto para siempre:
 * una firma obligatoria condicionada se saltearía y el firmante completaría sin firmar.
 */
export async function pruneDanglingConditions(db: Db, table: "fields" | "template_fields", ownerId: string) {
  const col = table === "fields" ? "envelope_id" : "template_id";
  const rows = await db.query<any>(`SELECT id, conditions FROM ${table} WHERE ${col} = $1`, [ownerId]);
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const conds = (Array.isArray(r.conditions) ? r.conditions : []) as FieldCondition[];
    if (!conds.length) continue;
    const kept = conds.filter((c) => ids.has(c.fieldId));
    if (kept.length === conds.length) continue;
    await db.query(`UPDATE ${table} SET conditions = $2 WHERE id = $1`, [r.id, kept.length ? JSON.stringify(kept) : null]);
  }
}

const toLogic = (r: any): LogicField => ({
  id: r.id,
  type: r.type,
  label: r.label,
  conditions: Array.isArray(r.conditions) && r.conditions.length ? r.conditions : null,
  formula: r.formula ?? null,
});

/**
 * Al completar un firmante: decide qué campos suyos quedan ocultos y calcula sus fórmulas.
 * `submitted` son los valores que mandó; los de otros destinatarios salen de la base.
 * Marca `hidden` en la base (los ocultos quedan vacíos y no se estampan).
 */
export async function prepareCompletionLogic(db: Db, envelopeId: string, recipientId: string, submitted: Map<string, string>) {
  const rows = await db.query<any>(`SELECT * FROM fields WHERE envelope_id = $1`, [envelopeId]);
  const all = rows.map(toLogic);
  const own = new Set(rows.filter((r) => r.recipient_id === recipientId).map((r) => r.id));
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const valueOf = (id: string): string | null => {
    const r = rowById.get(id);
    if (!r) return null;
    if (own.has(id) && !r.read_only) {
      if (r.type === "checkbox") return submitted.get(id) === "true" ? "true" : "false";
      if (submitted.has(id)) return submitted.get(id) ?? null;
    }
    return r.value ?? null;
  };
  const hidden = computeHidden(all, valueOf);
  const computed = computeFormulas(all, valueOf, hidden);
  const ownHidden = [...hidden].filter((id) => own.has(id));
  await db.query(`UPDATE fields SET hidden = (id = ANY($2)) WHERE recipient_id = $1`, [recipientId, ownHidden]);
  if (ownHidden.length) await db.query(`UPDATE fields SET value = NULL WHERE id = ANY($1)`, [ownHidden]);
  const ownComputed = new Map([...computed].filter(([id]) => own.has(id)));
  return { hidden: new Set(ownHidden), computed: ownComputed };
}

/** Antes de sellar: recalcula todas las fórmulas con los valores finales de todos los firmantes. */
export async function finalizeFieldLogic(db: Db, envelopeId: string) {
  const rows = await db.query<any>(`SELECT * FROM fields WHERE envelope_id = $1`, [envelopeId]);
  if (!rows.some((r) => r.formula)) return;
  const all = rows.map(toLogic);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const hidden = new Set(rows.filter((r) => r.hidden).map((r) => r.id));
  const computed = computeFormulas(all, (id) => rowById.get(id)?.value ?? null, hidden);
  for (const [id, v] of computed) {
    if (rowById.get(id)?.value !== v) await db.query(`UPDATE fields SET value = $2 WHERE id = $1`, [id, v]);
  }
}

/** Campos de otros destinatarios citados por la lógica de este firmante (para evaluarla en vivo en la web). */
export async function signerLogicFields(db: Db, envelopeId: string, recipientId: string) {
  const rows = await db.query<any>(`SELECT id, recipient_id, type, label, value, conditions, formula FROM fields WHERE envelope_id = $1`, [envelopeId]);
  const own = rows.filter((r) => r.recipient_id === recipientId);
  if (!own.some((r) => r.formula || (Array.isArray(r.conditions) && r.conditions.length))) return [];
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const r of own) {
    for (const c of (Array.isArray(r.conditions) ? r.conditions : []) as FieldCondition[]) ids.add(c.fieldId);
    if (r.formula) {
      try {
        for (const l of formulaRefs(r.formula)) labels.add(l.trim().toLowerCase());
      } catch {
        // fórmula inválida: se ignora (no debería pasar, se valida al guardar)
      }
    }
  }
  return rows
    .filter((r) => r.recipient_id !== recipientId && (ids.has(r.id) || (r.type === "number" && r.label && labels.has(r.label.trim().toLowerCase()))))
    .map((r) => ({ id: r.id, label: r.label, type: r.type, value: r.value }));
}
