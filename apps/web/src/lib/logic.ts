// Lógica de campos en vivo para el firmante (Fase 4). Usa las mismas funciones que el servidor;
// el servidor vuelve a evaluar todo al completar, esto es solo para mostrarlo.
import { useMemo } from "react";
import { computeLogic, formatSigningDate, signerFixedLogicValue, type Field, type LogicField, type SigningSession } from "@calasign/shared";

/**
 * `adopted`: si el firmante ya adoptó firma e iniciales en esta página. Con eso y los automáticos (nombre, correo y la
 * fecha de hoy con el mismo formato que guarda el servidor) la lógica ve lo mismo que verá /complete; antes un campo
 * condicionado a la propia firma o al propio nombre quedaba oculto acá y obligatorio en el servidor (o al revés).
 */
export function useFieldLogic(session: SigningSession, values: Record<string, string>, adopted: { signature: boolean; initials: boolean }) {
  const { signature: hasSignature, initials: hasInitials } = adopted;
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
        const fixed = signerFixedLogicValue(f.type, {
          hasSignature,
          hasInitials,
          autoValue: (t) =>
            t === "name"
              ? session.recipient.name
              : t === "email"
                ? (session.recipient.email ?? "")
                : formatSigningDate(new Date(), session.recipient.locale),
        });
        if (fixed !== undefined) return fixed;
        if (f.type === "checkbox") return values[id] === "true" ? "true" : "false";
        return values[id] ?? f.value ?? null;
      }
      return otherById.get(id)?.value ?? null;
    };
    // Igual que el servidor: las condiciones sobre un campo calculado miran el valor calculado.
    return computeLogic(all, valueOf);
  }, [session.fields, session.logicFields, session.recipient, values, hasSignature, hasInitials]);
}

/** Muestra un número calculado con el formato local. */
export function formatComputedLocal(v: string | null | undefined, locale: string): string {
  if (v == null || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return new Intl.NumberFormat(locale === "pt-BR" ? "pt-BR" : locale === "en" ? "en-US" : "es-AR", { maximumFractionDigits: 2 }).format(n);
}

/**
 * Monto escrito por el usuario, con el mismo criterio que la API (toNumberOrNull) y el motor de plantillas: 1.234,56 ·
 * 1,234.56 · 1.500.000 · 1,500,000. null si no es un número. Única copia en la web (antes había una por pantalla y
 * cada corrección había que repetirla en todas).
 */
export function parseAmountText(raw: string): number | null {
  let s = raw.trim().replace(/[^\d,.-]/g, "");
  if (!/\d/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  // 1.500.000 / 1,500,000: separador repetido entre grupos de 3 cifras = miles.
  else if (/^-?\d{1,3}([.,])\d{3}(?:\1\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
