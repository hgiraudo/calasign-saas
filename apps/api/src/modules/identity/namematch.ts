// Coincidencia entre lo declarado por el remitente (nombre, número de documento) y lo leído del documento.
// Pensado para nombres latinoamericanos: el documento suele traer más nombres y apellidos que los declarados
// ("José Pérez" vs "JOSE ANTONIO PEREZ GOMEZ"), así que el puntaje mide qué parte de lo DECLARADO aparece
// en el documento, tolerando acentos, mayúsculas, guiones y errores menores de tipeo.
import type { NameMatchResult } from "@calasign/shared";

const PARTICLES = new Set(["de", "del", "la", "las", "los", "da", "das", "do", "dos", "e", "y", "van", "von"]);

export function normalizeName(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-zñ\s'-]/g, " ")
    .replace(/['-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !PARTICLES.has(t));
}

export function normalizeDocumentNumber(s: string | null | undefined): string {
  return (s ?? "").normalize("NFD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Dos tokens coinciden si son iguales, uno es inicial del otro, o difieren en poco (≥ 85 % de similitud). */
function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return true;
  const max = Math.max(a.length, b.length);
  return max >= 4 && 1 - levenshtein(a, b) / max >= 0.85;
}

/** Fracción de los tokens declarados que aparecen en el nombre del documento (cada token del documento se usa una vez). */
export function nameScore(declared: string, extracted: string): number {
  const d = normalizeName(declared);
  const x = normalizeName(extracted);
  if (d.length === 0 || x.length === 0) return 0;
  const used = new Set<number>();
  let hits = 0;
  for (const t of d) {
    const i = x.findIndex((u, idx) => !used.has(idx) && tokenMatches(t, u));
    if (i >= 0) {
      used.add(i);
      hits++;
    }
  }
  // Un solo token declarado no alcanza para identificar a nadie: exige al menos dos coincidencias si el documento tiene más.
  if (d.length === 1 && x.length > 1) return hits ? 0.5 : 0;
  return hits / d.length;
}

export function matchIdentity(
  declared: { name: string; documentNumber: string | null },
  extracted: { fullName: string | null; firstName: string | null; lastName: string | null; documentNumber: string | null },
  threshold: number,
): NameMatchResult {
  const fullName = extracted.fullName ?? [extracted.firstName, extracted.lastName].filter(Boolean).join(" ");
  const score = Math.round(nameScore(declared.name, fullName) * 1000) / 1000;
  let documentNumberMatched: boolean | null = null;
  if (declared.documentNumber && extracted.documentNumber) {
    documentNumberMatched = normalizeDocumentNumber(declared.documentNumber) === normalizeDocumentNumber(extracted.documentNumber);
  } else if (declared.documentNumber && !extracted.documentNumber) {
    documentNumberMatched = false;
  }
  return { score, matched: score >= threshold, threshold, documentNumberMatched };
}
