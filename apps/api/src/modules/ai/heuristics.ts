// Heurísticas deterministas: detección de campos por texto y el comportamiento del proveedor "mock"
// (resumen extractivo, respuestas por coincidencia de palabras, metadatos por expresiones regulares y
// revisión simple del playbook). Sin red ni modelos: sirven en desarrollo, en pruebas y como base que
// se combina con lo que sugiera el modelo real.
import type { PageText, TextLine } from "@calasign/pdf";
import type { ContractMetadata, SuggestedFieldType } from "@calasign/shared";

export interface DocText {
  id: string;
  name: string;
  pages: PageText[];
}

// ───────────────────────────── Normalización ─────────────────────────────

export function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ───────────────────────────── Detección de campos ─────────────────────────────

export interface RawSuggestion {
  documentId: string;
  page: number;
  lineId: string;
  type: SuggestedFieldType;
  roleHint: string | null;
  label: string | null;
  confidence: number;
  source: "heuristic" | "ai";
}

const KEYWORDS: { type: SuggestedFieldType; re: RegExp }[] = [
  { type: "initials", re: /\b(iniciales|inicial|rubrica|rubricas|visto|initials|rubrica do|rubrica de)\b/ },
  { type: "signature", re: /\b(firma|firmas|firmado por|assinatura|assinado por|signature|signed by|sign here|firme aqui)\b/ },
  { type: "date_signed", re: /\b(fecha|data|date|lugar y fecha|local e data)\b/ },
  { type: "name", re: /\b(aclaracion|nombre|nome|name|nombre completo|nome completo|printed name)\b/ },
];

const BLANK = /_{3,}|\.{6,}|-{6,}/;

/** Rol a partir de textos como "Firma del cliente", "Assinatura do locatário", "EL PROVEEDOR". */
export function roleFromLine(text: string): string | null {
  const n = norm(text);
  const m =
    /(?:firma|aclaracion|nombre|fecha|iniciales)\s+(?:del?|de la|de los|de las)\s+([a-z][a-z ]{1,40}?)(?:\s*[:_.(-]|$)/.exec(n) ??
    /(?:assinatura|nome|data|rubrica)\s+(?:do|da|dos|das|de)\s+([a-z][a-z ]{1,40}?)(?:\s*[:_.(-]|$)/.exec(n) ??
    /(?:signature|name|date)\s+of\s+(?:the\s+)?([a-z][a-z ]{1,40}?)(?:\s*[:_.(-]|$)/.exec(n);
  if (!m) return null;
  const role = m[1].replace(/\s+(y|e|and)\s.*$/, "").trim();
  return role.length >= 3 ? role : null;
}

/** Sugerencias por palabras clave + espacio en blanco para completar. */
export function heuristicFieldSuggestions(doc: DocText): RawSuggestion[] {
  const out: RawSuggestion[] = [];
  for (const page of doc.pages) {
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      const n = norm(line.text);
      if (n.length > 140) continue; // párrafos: no son rótulos de firma
      const hasBlank = BLANK.test(line.text);
      const endsWithColon = /:\s*$/.test(line.text);
      // Línea en blanco ("______") con el rótulo en la línea de abajo (típico bloque de firma).
      const below = page.lines[i + 1];
      const onlyBlank = hasBlank && n.replace(/[_.\-\s]/g, "").length === 0;
      const labelText = onlyBlank && below ? below.text : line.text;
      const ln = norm(labelText);
      for (const k of KEYWORDS) {
        if (!k.re.test(ln)) continue;
        if (!hasBlank && !endsWithColon && !onlyBlank) continue;
        out.push({
          documentId: doc.id,
          page: page.page,
          lineId: line.id,
          type: k.type,
          roleHint: roleFromLine(labelText),
          label: labelText.replace(BLANK, "").replace(/[:\s]+$/, "").trim().slice(0, 80) || null,
          confidence: hasBlank ? 0.8 : 0.55,
          source: "heuristic",
        });
        break;
      }
    }
  }
  return out;
}

/** Tamaño por defecto (en puntos) de cada tipo sugerido. */
const DEFAULT_SIZE: Record<SuggestedFieldType, { w: number; h: number }> = {
  signature: { w: 170, h: 40 },
  initials: { w: 60, h: 30 },
  date_signed: { w: 110, h: 16 },
  name: { w: 170, h: 16 },
};

/** Convierte una sugerencia anclada a una línea en un rectángulo normalizado sobre el espacio en blanco. */
export function placeSuggestion(line: TextLine, page: { width: number; height: number }, type: SuggestedFieldType) {
  const size = DEFAULT_SIZE[type];
  const m = BLANK.exec(line.text);
  let x: number;
  let width: number;
  if (m) {
    // Proporción de caracteres: suficiente para ubicar sobre la línea punteada.
    const per = line.width / Math.max(1, line.text.length);
    x = line.x + m.index * per;
    width = Math.max(m[0].length * per, Math.min(size.w, page.width - x - 4));
  } else {
    // Rótulo terminado en ":" → a la derecha del texto.
    x = line.x + line.width + 6;
    width = size.w;
  }
  width = Math.min(Math.max(width, size.w * 0.6), page.width - x - 4);
  if (width < 20) {
    x = Math.max(4, page.width - size.w - 8);
    width = size.w;
  }
  const height = size.h;
  const baseline = line.y + line.height;
  // La firma se dibuja apoyada sobre la línea; los textos, alineados con el renglón.
  const y = type === "signature" || type === "initials" ? baseline - height : line.y + line.height / 2 - height / 2;
  const nx = clamp01(x / page.width);
  const ny = clamp01(y / page.height);
  return {
    x: nx,
    y: ny,
    width: Math.min(width / page.width, 1 - nx),
    height: Math.min(height / page.height, 1 - ny),
  };
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 0.999);

// ───────────────────────────── Texto que se envía ─────────────────────────────

/**
 * Id de línea que ve el modelo: el de la línea (p{página}-l{n}) prefijado con el documento (d{n}, 1-based, en el orden
 * de `docs`). Los ids de línea se repiten entre documentos: sin el prefijo, con varios documentos una sugerencia de la
 * IA caía en el primero que tuviera esa línea.
 */
export function docLineId(docIndex: number, lineId: string): string {
  return `d${docIndex + 1}-${lineId}`;
}

/** Resuelve un id de docLineId contra los documentos (null si no existe). */
export function resolveDocLineId(docs: DocText[], id: string): { documentId: string; page: number; lineId: string } | null {
  const m = /^d(\d+)-(p\d+-l\d+)$/.exec(String(id ?? "").trim());
  if (!m) return null;
  const d = docs[Number(m[1]) - 1];
  if (!d) return null;
  for (const p of d.pages) {
    const l = p.lines.find((x) => x.id === m[2]);
    if (l) return { documentId: d.id, page: p.page, lineId: l.id };
  }
  return null;
}

/**
 * El texto de los documentos va entre etiquetas <documento>: un "<" o ">" en el texto o en el nombre podía cerrarlas
 * (o abrir otras) y hacer pasar texto del documento por instrucciones. Se reemplazan por comillas angulares.
 */
const escapeTags = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›");

/** Texto del documento con marcas de página (y opcionalmente el id de cada línea, para detectar campos). */
export function docsToText(docs: DocText[], opts: { lineIds?: boolean } = {}): string {
  return docs
    .map(
      (d, di) =>
        `<documento id="${d.id}" nombre="${escapeTags(d.name).replace(/"/g, "'")}">\n` +
        d.pages
          .map(
            (p) =>
              `[Página ${p.page + 1}]\n` + p.lines.map((l) => (opts.lineIds ? `[${docLineId(di, l.id)}] ${escapeTags(l.text)}` : escapeTags(l.text))).join("\n"),
          )
          .join("\n\n") +
        `\n</documento>`,
    )
    .join("\n\n");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ───────────────────────────── Citas ─────────────────────────────

export interface FlatLine {
  documentId: string;
  page: number;
  text: string;
  n: string;
}

export function flatten(docs: DocText[]): FlatLine[] {
  return docs.flatMap((d) => d.pages.flatMap((p) => p.lines.map((l) => ({ documentId: d.id, page: p.page, text: l.text, n: norm(l.text) }))));
}

/** Largo mínimo de una cita verificable (normalizada): al menos 20 caracteres o 4 palabras. */
export const QUOTE_MIN_CHARS = 20;
export const QUOTE_MIN_WORDS = 4;
/** Con página citada: largo mínimo de una cita corta sin números (y al menos 2 palabras; con un número alcanza con 3 caracteres). */
export const QUOTE_SHORT_MIN_CHARS = 6;

/**
 * Verifica que una cita aparezca en el texto (normalizado) y devuelve dónde. Verificada solo si es lo bastante larga
 * para no aparecer por casualidad (una cita de 3 letras, "de la", siempre estaba en algún lado) y está en la página que
 * cita el modelo (`page`, desde 1; en cualquier documento); sin página, en cualquier lugar de los documentos. Una cita
 * que está en otra página que la citada no se da por verificada: la página que se muestra sería falsa.
 * Con página citada se aceptan también citas cortas con un número o de al menos QUOTE_SHORT_MIN_CHARS caracteres y 2
 * palabras ("USD 10.000", "30 días", "de la factura"): los montos y plazos son justo lo que se cita, y acotadas a una
 * página es poco probable que coincidan por casualidad. Las cortas tienen que coincidir con palabras y números enteros
 * (no dentro de otro número o palabra). Sin página rige el mínimo de largo.
 */
export function locateQuote(docs: DocText[], quote: string, page?: number | null): { documentId: string | null; page: number; verified: boolean } {
  const q = norm(quote).replace(/["“”«»]/g, "").trim();
  const fallback = { documentId: null, page: page ?? 1, verified: false };
  const wordCount = q.split(" ").filter(Boolean).length;
  const cited = typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : null;
  const longEnough = q.length >= QUOTE_MIN_CHARS || wordCount >= QUOTE_MIN_WORDS;
  const shortOk = cited != null && ((/\d/.test(q) && q.length >= 3) || (q.length >= QUOTE_SHORT_MIN_CHARS && wordCount >= 2));
  if (!longEnough && !shortOk) return fallback;
  // Una cita corta tiene que coincidir con palabras y números enteros: "10%" no está en "110%", "30 días" no está en
  // "130 días" ni "USD 10.000" en "USD 10.000.000" (después no puede seguir una letra, un dígito ni un separador decimal
  // o de miles con más dígitos).
  const escaped = q.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const bounded = longEnough ? null : new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}]|[.,]\\d)`, "u");
  for (const d of docs) {
    for (const p of d.pages) {
      if (cited != null && p.page + 1 !== cited) continue;
      const pageText = norm(p.lines.map((l) => l.text).join(" "));
      if (bounded ? bounded.test(pageText) : pageText.includes(q)) return { documentId: d.id, page: p.page + 1, verified: true };
    }
  }
  return fallback;
}

// ───────────────────────────── Mock: resumen y preguntas ─────────────────────────────

const STOP = new Set(
  "el la los las un una unos unas de del al y o en que por para con sin se su sus es son este esta estos estas lo como mas pero si no a ante cual cuales donde cuando quien qué que o do da dos das um uma e em no na nos nas com por para pelo pela the of and to in on for is are be this that what which who when where how does do el".split(
    " ",
  ),
);

function words(s: string): string[] {
  return norm(s)
    .replace(/[^a-z0-9ñ ]/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function mockSummary(docs: DocText[]) {
  const lines = flatten(docs).filter((l) => l.text.length > 25);
  const picked = lines.slice(0, 4);
  const keyLines = flatten(docs).filter((l) => /\d/.test(l.text) && l.text.length > 10 && !BLANK.test(l.text)).slice(0, 5);
  const summary =
    picked.length > 0
      ? `Este documento (${docs.map((d) => d.name).join(", ")}) trata sobre: ${picked.map((l) => l.text.replace(/\.$/, "")).join(". ")}.`
      : `El documento ${docs.map((d) => d.name).join(", ")} no tiene texto legible para resumir.`;
  return {
    summary,
    keyPoints: keyLines.map((l) => l.text),
    citations: [...picked.slice(0, 2), ...keyLines.slice(0, 2)].map((l) => ({ page: l.page + 1, quote: l.text })),
  };
}

export function mockAnswer(docs: DocText[], question: string) {
  const qw = new Set(words(question));
  const scored = flatten(docs)
    .map((l) => ({ l, score: words(l.text).filter((w) => qw.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  if (scored.length === 0) return { answered: false, answer: "El documento no contiene información sobre esa pregunta.", citations: [] };
  return {
    answered: true,
    answer: `Según el documento: ${scored.map((s) => `«${s.l.text}» (pág. ${s.l.page + 1})`).join("; ")}.`,
    citations: scored.map((s) => ({ page: s.l.page + 1, quote: s.l.text })),
  };
}

// ───────────────────────────── Mock: metadatos ─────────────────────────────

const CURRENCIES: [RegExp, string][] = [
  [/\bUSD\b|US\$|U\$S|dolares/i, "USD"],
  [/\bCOP\b|pesos colombianos/i, "COP"],
  [/\bBRL\b|R\$|reais/i, "BRL"],
  [/\bDOP\b|RD\$|pesos dominicanos/i, "DOP"],
  [/\bHNL\b|lempiras?|\bL\.\s?\d/i, "HNL"],
  [/\bPEN\b|S\/\s?\d|soles/i, "PEN"],
  [/\bEUR\b|€|euros?/i, "EUR"],
];

export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[^\d.,]/g, "").replace(/^[.,]+|[.,]+$/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decimalsAfter = (i: number) => s.length - i - 1;
  if (lastDot >= 0 && lastComma >= 0) {
    // Ambos: el último es el separador decimal (1.500,50 / 1,500.50).
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = decimalsAfter(lastComma) === 3 ? s.replace(/,/g, "") : s.replace(/,/g, ".");
  } else if (lastDot >= 0) {
    s = decimalsAfter(lastDot) === 3 ? s.replace(/\./g, "") : s;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  janeiro: 1, fevereiro: 2, marco: 3, maio: 5, junho: 6, julho: 7, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Fechas dd/mm/aaaa, aaaa-mm-dd o "15 de marzo de 2027" → ISO, con su posición en el texto normalizado. */
export function findDatesAt(text: string): { iso: string; index: number }[] {
  const out: { iso: string; index: number }[] = [];
  const n = norm(text);
  const pad = (v: number) => String(v).padStart(2, "0");
  for (const m of n.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push({ iso: `${m[1]}-${m[2]}-${m[3]}`, index: m.index! });
  for (const m of n.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.push({ iso: `${m[3]}-${pad(mo)}-${pad(d)}`, index: m.index! });
  }
  for (const m of n.matchAll(/\b(\d{1,2}) de ([a-z]+) de (\d{4})\b/g)) {
    const mo = MONTHS[m[2]];
    if (mo) out.push({ iso: `${m[3]}-${pad(mo)}-${pad(Number(m[1]))}`, index: m.index! });
  }
  for (const m of n.matchAll(/\b([a-z]+) (\d{1,2}), (\d{4})\b/g)) {
    const mo = MONTHS[m[1]];
    if (mo) out.push({ iso: `${m[3]}-${pad(mo)}-${pad(Number(m[2]))}`, index: m.index! });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function findDates(text: string): string[] {
  return findDatesAt(text).map((d) => d.iso);
}

export function mockMetadata(docs: DocText[]): { metadata: ContractMetadata; confidence: Record<string, number> } {
  const lines = flatten(docs);
  const all = lines.map((l) => l.text).join("\n");
  const n = norm(all);
  const confidence: Record<string, number> = {};

  // Partes: "entre ACME S.A. ... y Juan Pérez ..." o rótulos "EL CLIENTE: Nombre".
  const parties: ContractMetadata["parties"] = [];
  for (const l of lines) {
    const m = /^(?:el|la|o|a|the)?\s*([a-z ]{3,30}?)\s*:\s*(.{3,120})$/i.exec(l.text);
    if (m && /(cliente|proveedor|contratante|contratista|locador|locatario|arrendador|arrendatario|vendedor|comprador|empleador|trabajador|prestador|client|supplier|contratada|empresa)/i.test(m[1])) {
      const name = m[2].replace(/[,;].*$/, "").trim();
      if (name && !BLANK.test(name)) parties.push({ name, role: norm(m[1]) });
    }
  }
  if (parties.length === 0) {
    const m = /\bentre\s+(.{3,80}?)(?:,|\s+con\b|\s+en adelante\b).{0,200}?\by\s+(.{3,80}?)(?:,|\s+con\b|\s+en adelante\b)/i.exec(all.replace(/\n/g, " "));
    if (m) parties.push({ name: m[1].trim(), role: null }, { name: m[2].trim(), role: null });
  }
  if (parties.length) confidence.parties = 0.6;

  // La fecha que sigue a la palabra clave (una misma línea puede tener inicio y vencimiento).
  const dateNear = (re: RegExp) => {
    for (const l of lines) {
      const m = re.exec(l.n);
      if (!m) continue;
      const dates = findDatesAt(l.text);
      const after = dates.find((d) => d.index >= m.index);
      if (after) return after.iso;
      if (dates.length) return dates[dates.length - 1].iso;
    }
    return null;
  };
  const effectiveDate = dateNear(/(vigencia desde|a partir del?|inicio|entra en vigor|fecha de inicio|effective|inicia)/);
  const expiryDate = dateNear(/(vence|vencimiento|hasta el|finaliza|termina|expira|expiry|expiration|valid until|plazo)/);
  const renewalDate = dateNear(/(renovacion|renova|renewal)/);
  if (effectiveDate) confidence.effectiveDate = 0.6;
  if (expiryDate) confidence.expiryDate = 0.6;
  if (renewalDate) confidence.renewalDate = 0.5;

  const autoRenewal = /(renovacion automatica|se renovara automaticamente|renova automaticamente|renovacao automatica|automatically renew)/.test(n)
    ? true
    : /(no se renovara|sin renovacion automatica|nao sera renovado)/.test(n)
      ? false
      : null;
  if (autoRenewal !== null) confidence.autoRenewal = 0.7;

  const amounts: ContractMetadata["amounts"] = [];
  for (const l of lines) {
    for (const m of l.text.matchAll(/((?:US\$|U\$S|R\$|RD\$|S\/|\$|€|L\.|\b(?:USD|COP|BRL|DOP|HNL|PEN|EUR)\b)\s?[\d.,]*\d|[\d.,]*\d\s?(?:USD|COP|BRL|DOP|HNL|PEN|EUR|d[oó]lares|reais|lempiras|soles|euros))/gi)) {
      const value = parseAmount(m[1]);
      if (value === null || value === 0) continue;
      const cur = CURRENCIES.find(([re]) => re.test(m[1]) || re.test(l.text));
      amounts.push({ value, currency: cur ? cur[1] : null, description: l.text.slice(0, 200) });
    }
  }
  if (amounts.length) confidence.amounts = 0.6;

  const law =
    /(?:leyes de|legislacion de|ley aplicable[: ]+|jurisdiccion de los tribunales de|tribunales de|jurisdiccion de|foro da comarca de|leis da|laws of)\s+(?:la\s+|el\s+|the\s+)?([a-z ,]{3,60}?)(?:[.;,\n]|$)/.exec(n);
  const governingLaw = law ? titleCase(law[1].trim()) : null;
  if (governingLaw) confidence.governingLaw = 0.55;

  const notice = /(\d{1,3})\s*(?:\([a-z ]+\)\s*)?dias?\s+(?:habiles\s+|corridos\s+|naturales\s+)?(?:de\s+)?(?:anticipacion|preaviso|antecedencia|aviso previo|notice)/.exec(n) ?? /notice period of (\d{1,3}) days/.exec(n);
  const noticePeriodDays = notice ? Number(notice[1]) : null;
  if (noticePeriodDays !== null) confidence.noticePeriodDays = 0.65;

  return {
    metadata: { parties: parties.slice(0, 10), effectiveDate, expiryDate, renewalDate, autoRenewal, amounts: amounts.slice(0, 10), governingLaw, noticePeriodDays },
    confidence,
  };
}

function titleCase(s: string) {
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

// ───────────────────────────── Mock: revisión del playbook ─────────────────────────────

/** Regla "X debe ser Y" / "X ≤ N meses" contra el texto: ok, violación o no encontrado. */
export function mockPlaybookReview(docs: DocText[], rules: string[]) {
  const lines = flatten(docs);
  return rules.map((rule) => {
    const r = norm(rule);
    const must = /^(.+?)\s+(?:debe ser|debe estar en|deve ser|must be|tiene que ser|=)\s+(.+)$/.exec(r);
    const limit = /^(.+?)\s*(?:<=|≤|no mayor a|maximo|ate|at most|no puede superar)\s*(\d+)\s*(dias|meses|anos|days|months|years|%)?/.exec(r);
    const topicText = (must?.[1] ?? limit?.[1] ?? r).replace(/^(el|la|los|las|o|a|the)\s+/, "");
    const topicWords = words(topicText);
    const hits = lines.filter((l) => topicWords.length > 0 && topicWords.some((w) => l.n.includes(stem(w))));
    if (hits.length === 0) {
      return { rule, status: "not_found" as const, severity: "medium" as const, explanation: "No se encontró una cláusula sobre este tema.", page: null, quote: null };
    }
    const first = hits[0];
    if (must) {
      const expected = norm(must[2]).replace(/[.]$/, "");
      const ok = hits.find((h) => h.n.includes(expected));
      return ok
        ? { rule, status: "ok" as const, severity: "low" as const, explanation: `La cláusula cumple: menciona «${must[2]}».`, page: ok.page + 1, quote: ok.text }
        : { rule, status: "violation" as const, severity: "high" as const, explanation: `La cláusula no menciona «${must[2]}».`, page: first.page + 1, quote: first.text };
    }
    if (limit) {
      const max = Number(limit[2]);
      for (const h of hits) {
        const num = /(\d{1,4})\s*(?:\([a-z ]+\)\s*)?(dias|meses|anos|days|months|years|%)/.exec(h.n);
        if (num) {
          const v = Number(num[1]);
          return v <= max
            ? { rule, status: "ok" as const, severity: "low" as const, explanation: `El valor (${v} ${num[2]}) está dentro del límite (${max}).`, page: h.page + 1, quote: h.text }
            : { rule, status: "violation" as const, severity: "high" as const, explanation: `El valor (${v} ${num[2]}) supera el límite (${max}).`, page: h.page + 1, quote: h.text };
        }
      }
    }
    return { rule, status: "not_found" as const, severity: "low" as const, explanation: "Hay una cláusula sobre el tema pero no se pudo evaluar automáticamente.", page: first.page + 1, quote: first.text };
  });
}

function stem(w: string) {
  return w.length > 6 ? w.slice(0, w.length - 2) : w;
}

/**
 * Empareja los resultados del modelo con las reglas enviadas: uno por regla, en el orden de entrada. Se busca por
 * número de regla (ruleIndex) y, si falta, por el texto exacto; una regla sin resultado queda not_found y los
 * resultados de reglas que no se enviaron (inventadas o repetidas) se ignoran.
 */
export function pairPlaybookFindings<F extends { ruleIndex?: number | null; rule: string; status: "ok" | "violation" | "not_found"; severity: "low" | "medium" | "high"; explanation: string; page: number | null; quote: string | null }>(
  rules: string[],
  raw: F[],
): { rule: string; status: "ok" | "violation" | "not_found"; severity: "low" | "medium" | "high"; explanation: string; page: number | null; quote: string | null }[] {
  const used = new Set<number>();
  const take = (pred: (f: F) => boolean) => {
    const i = raw.findIndex((f, k) => !used.has(k) && pred(f));
    if (i < 0) return null;
    used.add(i);
    return raw[i];
  };
  return rules.map((rule, i) => {
    const f = take((x) => x.ruleIndex === i + 1) ?? take((x) => (x.ruleIndex == null || x.ruleIndex < 1 || x.ruleIndex > rules.length) && norm(x.rule) === norm(rule));
    if (!f) return { rule, status: "not_found" as const, severity: "medium" as const, explanation: "El modelo no devolvió un resultado para esta regla.", page: null, quote: null };
    return { rule, status: f.status, severity: f.severity, explanation: f.explanation, page: f.page, quote: f.quote };
  });
}
