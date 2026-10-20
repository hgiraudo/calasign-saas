/**
 * Interpolación de textos de la interfaz, sin dependencias de React (se puede probar con node directamente).
 *
 * - `pluralize` elige la forma "uno|otros" de un texto CRUDO (antes de poner variables: si se eligiera después, un
 *   valor con "|" partiría el texto en otro lugar).
 * - `interpolate` reemplaza TODAS las apariciones de cada `{nombre}` en una sola pasada (un valor que contenga
 *   "{otro}" no se vuelve a interpolar, y "$&"/"$'" en un valor no se interpretan como patrón). Un `{nombre}` sin
 *   variable queda tal cual.
 * - `formatText` combina ambos en el orden correcto: plural primero (si vars.n es número), variables después.
 */

export type TextVars = Record<string, string | number | null | undefined>;

export function pluralize(locale: string, text: string, n: number): string {
  const parts = text.split("|");
  if (parts.length < 2) return text;
  let cat: string;
  // es y pt: 0 va en plural ("0 documentos"). Intl.PluralRules("pt-BR").select(0) devuelve "one" (regla CLDR
  // del portugués brasileño) y daría "0 documento".
  if (n === 0 && /^(es|pt)\b/i.test(locale)) cat = "other";
  else {
    try {
      cat = new Intl.PluralRules(locale).select(n);
    } catch {
      cat = n === 1 ? "one" : "other";
    }
  }
  return cat === "one" ? parts[0] : parts[parts.length - 1];
}

export function interpolate(text: string, vars?: TextVars, fmt: (v: string | number) => string = String): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : undefined;
    return v == null ? m : fmt(v);
  });
}

/** Plural (según vars.n o `n` explícito) y después variables. */
export function formatText(locale: string, text: string, vars?: TextVars, fmt?: (v: string | number) => string, n?: number): string {
  const count = typeof n === "number" ? n : typeof vars?.n === "number" ? vars.n : undefined;
  const s = typeof count === "number" ? pluralize(locale, text, count) : text;
  return interpolate(s, vars, fmt);
}
