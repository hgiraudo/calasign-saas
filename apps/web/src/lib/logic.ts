// Lógica de campos en vivo para el firmante (Fase 4). Usa las mismas funciones que el servidor;
// el servidor vuelve a evaluar todo al completar, esto es solo para mostrarlo.
import { useMemo } from "react";
import { computeFormulas, computeHidden, type Field, type LogicField, type SigningSession } from "@calasign/shared";

export function useFieldLogic(session: SigningSession, values: Record<string, string>) {
  return useMemo(() => {
    const own = session.fields;
    const others = session.logicFields ?? [];
    if (!own.some((f) => f.formula || f.conditions?.length)) return { hidden: new Set<string>(), computed: new Map<string, string | null>() };
    const all: LogicField[] = [
      ...own.map((f: Field) => ({ id: f.id, type: f.type, label: f.label, conditions: f.conditions ?? null, formula: f.formula ?? null })),
      ...others.map((f) => ({ id: f.id, type: f.type, label: f.label, conditions: null, formula: null })),
    ];
    const ownById = new Map(own.map((f) => [f.id, f]));
    const otherById = new Map(others.map((f) => [f.id, f]));
    const valueOf = (id: string): string | null => {
      const f = ownById.get(id);
      if (f) {
        if (f.readOnly) return f.value;
        if (f.type === "checkbox") return values[id] === "true" ? "true" : "false";
        return values[id] ?? f.value ?? null;
      }
      return otherById.get(id)?.value ?? null;
    };
    const hidden = computeHidden(all, valueOf);
    const computed = computeFormulas(all, valueOf, hidden);
    return { hidden, computed };
  }, [session.fields, session.logicFields, values]);
}

/** Muestra un número calculado con el formato local. */
export function formatComputedLocal(v: string | null | undefined, locale: string): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return new Intl.NumberFormat(locale === "pt-BR" ? "pt-BR" : locale === "en" ? "en-US" : "es-AR", { maximumFractionDigits: 2 }).format(n);
}
