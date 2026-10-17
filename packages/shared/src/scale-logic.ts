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
