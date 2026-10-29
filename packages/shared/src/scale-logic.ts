// Lógica de campos (Fase 4): condiciones y fórmulas. Sin dependencias de api.ts para evitar ciclos.
import { z } from "zod";

// ───────────────────────────── Lógica de campos ─────────────────────────────

export const CONDITION_OPERATORS = ["equals", "not_equals", "checked", "unchecked", "filled"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** El campo se muestra (y es obligatorio, si lo es) solo si se cumplen TODAS sus condiciones. */
export const FieldCondition = z
  .object({
    fieldId: z.string().uuid(),
    operator: z.enum(CONDITION_OPERATORS),
    value: z.string().max(200).optional().nullable(),
  })
  .refine((c) => !["equals", "not_equals"].includes(c.operator) || c.value != null, { message: "la condición necesita un valor" });
export type FieldCondition = z.infer<typeof FieldCondition>;

export const FieldConditions = z.array(FieldCondition).max(10);

/**
 * Fórmula de un campo número calculado: + - * / y paréntesis; los demás campos número se citan por
 * etiqueta entre llaves, p. ej. `{Precio} * {Cantidad} * 1.21`.
 */
export const FieldFormula = z.string().trim().min(1).max(500);

// ───────────────────────────── Evaluación (compartida por la API y la web) ─────────────────────────────

/** Convierte "1.234,5" / "1234.5" / "1 234,50" en número. null si no es un número. */
export function parseNumberLoose(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  // 1,500,000: la coma repetida entre grupos de 3 cifras son miles (formato en inglés), como en el motor de plantillas
  // (toNum) y en los acuerdos (toNumberOrNull). Antes daba null: el campo lo rechazaba y la fórmula no lo contaba.
  if (/^[-+]?\d{1,3}(,\d{3}){2,}$/.test(s)) s = s.replace(/,/g, "");
  else if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
  // 1.500.000: el punto repetido entre grupos de 3 cifras son miles (el formato habitual en CO y BR). Antes daba null:
  // el campo número rechazaba el valor ("no es un número") y una fórmula que lo citaba lo ignoraba.
  else if (/^[-+]?\d{1,3}(\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, "");
  else s = s.replace(/,/g, "");
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ───────────────────────────── Fórmulas ─────────────────────────────

type Tok = { k: "num"; v: number } | { k: "ref"; v: string } | { k: "op"; v: string };

/** Tokeniza: números (punto o coma decimal), referencias {Etiqueta} y + - * / ( ). */
export function tokenizeFormula(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if ("+-*/()".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
    } else if (c === "{") {
      const end = src.indexOf("}", i + 1);
      if (end < 0) throw new Error("falta cerrar una llave");
      const name = src.slice(i + 1, end).trim();
      if (!name) throw new Error("referencia vacía {}");
      out.push({ k: "ref", v: name });
      i = end + 1;
    } else if (/[0-9.,]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.,]/.test(src[j])) j++;
      const n = parseNumberLoose(src.slice(i, j));
      if (n === null) throw new Error(`número inválido: ${src.slice(i, j)}`);
      out.push({ k: "num", v: n });
      i = j;
    } else {
      throw new Error(`carácter no permitido: ${c}`);
    }
  }
  return out;
}

export type FormulaNode =
  | { t: "num"; v: number }
  | { t: "ref"; v: string }
  | { t: "neg"; e: FormulaNode }
  | { t: "bin"; op: string; a: FormulaNode; b: FormulaNode };

/** Parser recursivo descendente (sin eval): expr := term (('+'|'-') term)*; term := unary (('*'|'/') unary)*. */
export function parseFormula(src: string): FormulaNode {
  const toks = tokenizeFormula(src);
  let p = 0;
  const peek = () => toks[p];
  const expr = (): FormulaNode => {
    let a = term();
    while (peek()?.k === "op" && (peek()!.v === "+" || peek()!.v === "-")) {
      const op = (toks[p++] as { v: string }).v;
      a = { t: "bin", op, a, b: term() };
    }
    return a;
  };
  const term = (): FormulaNode => {
    let a = unary();
    while (peek()?.k === "op" && (peek()!.v === "*" || peek()!.v === "/")) {
      const op = (toks[p++] as { v: string }).v;
      a = { t: "bin", op, a, b: unary() };
    }
    return a;
  };
  const unary = (): FormulaNode => {
    const tk = peek();
    if (!tk) throw new Error("fórmula incompleta");
    if (tk.k === "op" && tk.v === "-") {
      p++;
      return { t: "neg", e: unary() };
    }
    if (tk.k === "op" && tk.v === "+") {
      p++;
      return unary();
    }
    if (tk.k === "op" && tk.v === "(") {
      p++;
      const e = expr();
      if (peek()?.k !== "op" || peek()!.v !== ")") throw new Error("falta cerrar un paréntesis");
      p++;
      return e;
    }
    if (tk.k === "num") {
      p++;
      return { t: "num", v: tk.v };
    }
    if (tk.k === "ref") {
      p++;
      return { t: "ref", v: tk.v };
    }
    throw new Error(`token inesperado: ${tk.v}`);
  };
  if (toks.length === 0) throw new Error("fórmula vacía");
  const root = expr();
  if (p !== toks.length) throw new Error(`sobra "${(toks[p] as { v: unknown }).v}"`);
  return root;
}

export function formulaRefs(src: string): string[] {
  return tokenizeFormula(src)
    .filter((t): t is { k: "ref"; v: string } => t.k === "ref")
    .map((t) => t.v);
}

/** Evalúa; un valor faltante cuenta como 0. Devuelve null si hay división por cero o el resultado no es finito. */
export function evaluateFormula(src: string, lookup: (label: string) => number | null): number | null {
  const node = parseFormula(src);
  const ev = (n: FormulaNode): number => {
    switch (n.t) {
      case "num":
        return n.v;
      case "ref":
        return lookup(n.v) ?? 0;
      case "neg":
        return -ev(n.e);
      case "bin": {
        const a = ev(n.a);
        const b = ev(n.b);
        if (n.op === "+") return a + b;
        if (n.op === "-") return a - b;
        if (n.op === "*") return a * b;
        if (b === 0) return NaN;
        return a / b;
      }
    }
  };
  const r = ev(node);
  return Number.isFinite(r) ? r : null;
}

/** Formato canónico del resultado: hasta 2 decimales, punto decimal. */
export function formatComputed(n: number | null): string | null {
  if (n === null) return null;
  const r = Math.round(n * 100) / 100;
  // Fuera de rango ("Infinity", "1e+21") no es un número que se pueda volver a leer ni estampar.
  if (!Number.isFinite(r) || Math.abs(r) >= 1e15) return null;
  return String(Object.is(r, -0) ? 0 : r);
}

// ───────────────────────────── Condiciones ─────────────────────────────

export interface LogicField {
  id: string;
  type: string;
  label: string | null;
  conditions: FieldCondition[] | null;
  formula: string | null;
}

export function conditionHolds(c: FieldCondition, value: string | null): boolean {
  const v = (value ?? "").trim();
  switch (c.operator) {
    case "checked":
      return v === "true";
    case "unchecked":
      return v !== "true";
    case "filled":
      return v !== "" && v !== "false";
    case "equals":
      return v.toLowerCase() === (c.value ?? "").trim().toLowerCase();
    case "not_equals":
      return v.toLowerCase() !== (c.value ?? "").trim().toLowerCase();
  }
}

/**
 * Calcula qué campos quedan ocultos. Un campo oculto cuenta como vacío para las condiciones de otros
 * (se itera hasta que no cambie nada; la validación impide ciclos).
 */
export function computeHidden(fields: LogicField[], valueOf: (id: string) => string | null): Set<string> {
  const hidden = new Set<string>();
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (let iter = 0; iter < fields.length + 1; iter++) {
    let changed = false;
    for (const f of fields) {
      if (!f.conditions?.length) continue;
      const visible = f.conditions.every((c) => byId.has(c.fieldId) && conditionHolds(c, hidden.has(c.fieldId) ? null : valueOf(c.fieldId)));
      if (!visible && !hidden.has(f.id)) {
        hidden.add(f.id);
        changed = true;
      } else if (visible && hidden.has(f.id)) {
        hidden.delete(f.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return hidden;
}

/**
 * Ocultos y calculados juntos. Una condición que cita un campo con fórmula mira el valor CALCULADO, no el que haya
 * mandado el firmante ni el guardado (antes, mandando "" en el total se ocultaba un campo obligatorio que dependía de él).
 */
export function computeLogic(
  fields: LogicField[],
  valueOf: (id: string) => string | null,
): { hidden: Set<string>; computed: Map<string, string | null> } {
  const isFormula = new Set(fields.filter((f) => f.formula).map((f) => f.id));
  const pre = computeFormulas(fields, valueOf, new Set());
  const hidden = computeHidden(fields, (id) => (isFormula.has(id) ? (pre.get(id) ?? null) : valueOf(id)));
  return { hidden, computed: computeFormulas(fields, valueOf, hidden) };
}

/** Calcula las fórmulas (en orden de dependencias). Los campos ocultos valen 0 y no se calculan. */
export function computeFormulas(fields: LogicField[], valueOf: (id: string) => string | null, hidden: Set<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const numbers = fields.filter((f) => f.type === "number");
  const byLabel = new Map<string, LogicField>();
  for (const f of numbers) if (f.label) byLabel.set(f.label.trim().toLowerCase(), f);
  const visiting = new Set<string>();
  const numOf = (f: LogicField): number | null => {
    if (hidden.has(f.id)) return null;
    if (f.formula) {
      if (!out.has(f.id)) {
        if (visiting.has(f.id)) return null;
        visiting.add(f.id);
        out.set(
          f.id,
          formatComputed(
            evaluateFormula(f.formula, (label) => {
              const ref = byLabel.get(label.trim().toLowerCase());
              return ref ? numOf(ref) : null;
            }),
          ),
        );
        visiting.delete(f.id);
      }
      const v = out.get(f.id);
      return v == null ? null : Number(v);
    }
    const raw = valueOf(f.id);
    return raw == null ? null : parseNumberLoose(raw);
  };
  for (const f of numbers) if (f.formula && !hidden.has(f.id)) numOf(f);
  return out;
}

/** Lo que fija el servidor al completar en los campos propios cuyo valor no decide el firmante. */
export interface SignerFixedValues {
  /** Adoptó una firma (imagen) en este envío. */
  hasSignature: boolean;
  /** Adoptó iniciales en este envío. */
  hasInitials: boolean;
  /** Valor de los automáticos: nombre, correo y fecha de firma (formatSigningDate, sin " UTC"). */
  autoValue: (type: "name" | "email" | "date_signed") => string | null;
}

/**
 * Valor que ve la lógica (condiciones/fórmulas) en un campo propio, no de solo lectura, que fija el servidor: firma,
 * iniciales y automáticos (nombre, correo, fecha). `undefined` si el valor lo decide el firmante. Lo usan la API al
 * completar y la web en vivo, para que las dos oculten/exijan los mismos campos. Las iniciales cuentan como firmadas
 * también con sólo la firma adoptada: es lo que acepta /complete y lo que se estampa (la firma ocupa su lugar).
 * (Los tipos automáticos se repiten acá en vez de importar AUTO_FIELD_TYPES de api.ts, que importa este módulo.)
 */
export function signerFixedLogicValue(type: string, s: SignerFixedValues): string | null | undefined {
  if (type === "signature") return s.hasSignature ? "signed" : null;
  if (type === "initials") return s.hasInitials || s.hasSignature ? "signed" : null;
  if (type === "name" || type === "email" || type === "date_signed") return s.autoValue(type);
  return undefined;
}
