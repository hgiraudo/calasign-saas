// Motor de plantillas de documentos (Fase 6). Lo usan la API (render a PDF) y la web (vista previa).
//
// Sintaxis (texto plano, una línea por bloque):
//   # Título / ## Subtítulo / ### Sección
//   Párrafo con **negrita**, *cursiva* y variables {{cliente.nombre}} o {{precio | money:USD}}
//   - viñeta            1. numerada
//   | Col A | Col B |   (la fila seguida de |---|---| es encabezado)
//   {{#if cliente.empresa}} … {{else}} … {{/if}}      (en su propia línea, o dentro de una línea)
//   {{#each items as item}} … {{/each}}                (en su propia línea; {{@index}} = 1, 2, …)
//   {{clausula:confidencialidad}}                      (inserta una cláusula de la biblioteca)
//   {{firma:Cliente}} {{iniciales:Cliente}} {{fecha_firma:Cliente}} {{nombre_firmante:Cliente}}
//   {{salto}}                                          (salto de página)
//
// Seguridad: no hay evaluación de código. Las condiciones son comparaciones simples y los valores
// de los datos se insertan siempre como texto (nunca se interpretan como marcado ni como marcas).

export type MarkKind = "signature" | "initials" | "date" | "name";

export type Cond =
  | { op: "truthy"; path: string; neg: boolean }
  /** num: texto del literal numérico tal como se escribió ("1.500"); se interpreta al renderizar con el idioma de la plantilla. */
  | { op: "eq" | "ne" | "gt" | "lt" | "ge" | "le"; path: string; value: string | number | boolean; num?: string };

type Inline =
  | { t: "text"; v: string }
  | { t: "var"; path: string; filter: string | null; arg: string | null }
  | { t: "mark"; kind: MarkKind; role: string }
  | { t: "if"; cond: Cond; then: Inline[]; else: Inline[] }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] };

type Node =
  | { k: "heading"; level: 1 | 2 | 3; inl: Inline[] }
  | { k: "para"; lines: Inline[][] }
  | { k: "li"; ordered: boolean; inl: Inline[]; num?: number }
  /** newTable: la fila viene después de una línea en blanco (empieza otra tabla, no continúa la anterior). */
  | { k: "row"; cells: Inline[][]; header: boolean; newTable?: boolean }
  | { k: "pagebreak" }
  | { k: "clause"; slug: string }
  | { k: "if"; cond: Cond; then: Node[]; else: Node[] }
  | { k: "each"; path: string; as: string; body: Node[] };

export type Run = { text: string; b?: boolean; i?: boolean } | { mark: MarkKind; role: string } | { br: true };

export type ResolvedBlock =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  /** start: número del primer ítem de una lista numerada que no empieza en 1 ("3. …"); ausente si empieza en 1. */
  | { type: "list"; ordered: boolean; items: Run[][]; start?: number }
  | { type: "table"; header: Run[][] | null; rows: Run[][][] }
  | { type: "pagebreak" };

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    /** Motivo puntual cuando hace falta distinguirlo (role_too_long, clause_cycle, clause_depth). */
    readonly reason?: string,
  ) {
    super(line > 0 ? `Línea ${line}: ${message}` : message);
  }
}

/** Largo máximo del nombre de un rol de firma ({{firma:Rol}}), como el de los firmantes al generar. */
export const MAX_ROLE_LENGTH = 80;

const MARK_TAGS: Record<string, MarkKind> = {
  firma: "signature",
  assinatura: "signature",
  signature: "signature",
  iniciales: "initials",
  iniciais: "initials",
  initials: "initials",
  fecha_firma: "date",
  data_assinatura: "date",
  date_signed: "date",
  nombre_firmante: "name",
  nome_signatario: "name",
  signer_name: "name",
};

const PATH = String.raw`@?[A-Za-zÀ-ÿ_][\wÀ-ÿ]*(?:\.[\wÀ-ÿ@]+)*`;
// La condición no puede contener "}}": así "{{#if x}}texto{{/if}}" solo en una línea queda como if en línea.
// La condición empieza con un carácter que no es espacio: si no, \s+ y el grupo se disputaban los espacios y una línea
// "{{#if" + miles de espacios costaba O(n²) (la manda también la contraparte de una negociación).
const RE_IF_LINE = /^\s*\{\{#if\s+(\S(?:(?!\}\}).)*)\}\}\s*$/;
const RE_ELSE_LINE = /^\s*\{\{else\}\}\s*$/;
const RE_ENDIF_LINE = /^\s*\{\{\/if\}\}\s*$/;
const RE_EACH_LINE = new RegExp(String.raw`^\s*\{\{#each\s+(${PATH})(?:\s+as\s+([A-Za-z_]\w*))?\s*\}\}\s*$`);
const RE_ENDEACH_LINE = /^\s*\{\{\/each\}\}\s*$/;
const RE_CLAUSE_LINE = /^\s*\{\{\s*(?:cl[aá]usula|clausula|clause)\s*:\s*([\w-]+)\s*\}\}\s*$/i;
const RE_PAGEBREAK = /^\s*(?:\{\{\s*(?:salto|quebra|pagebreak)\s*\}\}|\\pagebreak)\s*$/i;
const RE_HEADING = /^(#{1,3})\s+(.*)$/;
const RE_UL = /^\s*[-•]\s+(.*)$/;
const RE_OL = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const RE_ROW = /^\s*\|(.*)\|\s*$/;
/**
 * Fila separadora de tabla (|---|:---:|). Sin regex: la anterior, con varios \s* seguidos, tardaba tiempo cúbico con
 * "|---|" seguido de muchos espacios (minutos con una propuesta de la contraparte).
 */
function isSepRow(raw: string): boolean {
  const s = raw.trim();
  if (!s.includes("|") || !s.includes("-")) return false;
  const cells = s.replace(/^\|/, "").replace(/\|$/, "").split("|");
  // Cada celda recortada primero: con \s* a los dos lados de partes opcionales la regex volvía a ser cuadrática.
  return cells.every((raw, i) => {
    const c = raw.trim();
    return /^:?-{3,}:?$/.test(c) || (i === cells.length - 1 && cells.length > 1 && /^:?-*:?$/.test(c));
  });
}

// ───────────────────────────── Condiciones ─────────────────────────────

export function parseCond(src: string, line = 0): Cond {
  const s = src.trim();
  const m = new RegExp(String.raw`^(${PATH})\s*(==|!=|>=|<=|>|<)\s*(.+)$`).exec(s);
  if (m) {
    const ops = { "==": "eq", "!=": "ne", ">": "gt", "<": "lt", ">=": "ge", "<=": "le" } as const;
    const lit = m[3].trim();
    const value = parseLiteral(lit, line);
    return { op: ops[m[2] as keyof typeof ops], path: m[1], value, ...(typeof value === "number" && RE_NUM_LIT.test(lit) ? { num: lit } : {}) };
  }
  const t = new RegExp(String.raw`^(!?)\s*(${PATH})$`).exec(s);
  if (t) return { op: "truthy", path: t[2], neg: t[1] === "!" };
  throw new TemplateSyntaxError(`condición inválida: ${s}`, line);
}

/** Literal numérico con separadores de miles o decimales ("1500", "1.500", "2,5", "-3"). */
const RE_NUM_LIT = /^-?[\d.,]*\d[\d.,]*$/;

function parseLiteral(s: string, line: number): string | number | boolean {
  const q = /^"(.*)"$|^'(.*)'$/.exec(s);
  if (q) return q[1] ?? q[2] ?? "";
  if (s === "true" || s === "verdadero") return true;
  if (s === "false" || s === "falso") return false;
  // El valor definitivo depende del idioma de la plantilla ("1.500" es 1500 en es/pt y 1,5 en en, igual que en los
  // datos): se resuelve al renderizar con parseLocaleNumber (Cond.num). Acá solo se valida que sea un número en algún
  // idioma y se deja una lectura de respaldo.
  if (RE_NUM_LIT.test(s)) {
    const n = parseLocaleNumber(s, "es") ?? parseLocaleNumber(s, "en");
    if (n !== null) return n;
  }
  const n = Number(s.replace(",", "."));
  if (s !== "" && Number.isFinite(n)) return n;
  throw new TemplateSyntaxError(`valor inválido en la condición: ${s} (usá comillas para texto)`, line);
}

// ───────────────────────────── Parser de línea (inline) ─────────────────────────────

type Tok = { k: "text"; v: string } | { k: "tag"; v: string } | { k: "star2" } | { k: "star1" };

function tokenizeInline(src: string): Tok[] {
  const out: Tok[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ k: "text", v: buf });
    buf = "";
  };
  let noClose = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && "*{}\\|#".includes(src[i + 1])) {
      buf += src[++i];
      continue;
    }
    if (c === "{" && src[i + 1] === "{" && !noClose) {
      const end = src.indexOf("}}", i + 2);
      // Sin "}}" de acá en adelante no hay más etiquetas: no se vuelve a buscar (era cuadrático con "{{a}" repetido).
      if (end === -1) noClose = true;
      if (end !== -1) {
        flush();
        out.push({ k: "tag", v: src.slice(i + 2, end).trim() });
        i = end + 1;
        continue;
      }
    }
    if (c === "*") {
      flush();
      if (src[i + 1] === "*") {
        out.push({ k: "star2" });
        i++;
      } else out.push({ k: "star1" });
      continue;
    }
    buf += c;
  }
  flush();
  return out;
}

function parseInline(src: string, line: number): Inline[] {
  const toks = tokenizeInline(src);
  let pos = 0;
  // Construcción recursiva con terminadores: "**", "*", "else", "/if".
  function parseSeq(stop: (t: Tok) => boolean): Inline[] {
    const out: Inline[] = [];
    while (pos < toks.length) {
      const t = toks[pos];
      if (stop(t)) return out;
      pos++;
      if (t.k === "text") out.push({ t: "text", v: t.v });
      else if (t.k === "star2") {
        const c = parseSeq((x) => x.k === "star2" || isTag(x, "else") || isTag(x, "/if"));
        if (toks[pos]?.k === "star2") {
          pos++;
          out.push({ t: "b", c });
        } else out.push({ t: "text", v: "**" }, ...c);
      } else if (t.k === "star1") {
        const c = parseSeq((x) => x.k === "star1" || isTag(x, "else") || isTag(x, "/if"));
        if (toks[pos]?.k === "star1") {
          pos++;
          out.push({ t: "i", c });
        } else out.push({ t: "text", v: "*" }, ...c);
      } else out.push(...tagToInline(t.v));
    }
    return out;
  }
  function tagToInline(tag: string): Inline[] {
    const ifm = /^#if\s+(.+)$/.exec(tag);
    if (ifm) {
      const cond = parseCond(ifm[1], line);
      const then = parseSeq((x) => isTag(x, "else") || isTag(x, "/if"));
      let els: Inline[] = [];
      if (toks[pos] && isTag(toks[pos], "else")) {
        pos++;
        els = parseSeq((x) => isTag(x, "/if"));
      }
      if (!toks[pos] || !isTag(toks[pos], "/if")) throw new TemplateSyntaxError("falta {{/if}}", line);
      pos++;
      return [{ t: "if", cond, then, else: els }];
    }
    if (tag === "else" || tag === "/if") throw new TemplateSyntaxError(`{{${tag}}} sin {{#if}}`, line);
    if (/^#each|^\/each/.test(tag)) throw new TemplateSyntaxError("{{#each}} y {{/each}} van en su propia línea", line);
    if (/^(cl[aá]usula|clause)\s*:/i.test(tag)) throw new TemplateSyntaxError("{{clausula:…}} va en su propia línea", line);
    if (/^(salto|quebra|pagebreak)$/i.test(tag)) throw new TemplateSyntaxError("{{salto}} va en su propia línea", line);
    const mk = /^([a-z_]+)\s*:\s*(.+)$/i.exec(tag);
    if (mk && MARK_TAGS[mk[1].toLowerCase()]) {
      const role = mk[2].trim().replace(/\s+/g, " ");
      // El firmante de un rol se indica con ese nombre (máximo 80 caracteres): un rol más largo nunca podría generarse.
      if (role.length > MAX_ROLE_LENGTH) throw new TemplateSyntaxError(`el rol «${role.slice(0, 40)}…» supera los ${MAX_ROLE_LENGTH} caracteres`, line, "role_too_long");
      return [{ t: "mark", kind: MARK_TAGS[mk[1].toLowerCase()], role }];
    }
    const vm = new RegExp(String.raw`^(${PATH})\s*(?:\|\s*([a-z]+)\s*(?::\s*(.+))?)?$`, "i").exec(tag);
    if (!vm) throw new TemplateSyntaxError(`etiqueta inválida: {{${tag}}}`, line);
    const filter = vm[2]?.toLowerCase() ?? null;
    if (filter && !FILTERS.includes(filter)) throw new TemplateSyntaxError(`filtro desconocido: ${filter}`, line);
    let arg = vm[3]?.trim() ?? null;
    if (arg) arg = arg.replace(/^"(.*)"$|^'(.*)'$/, (_m, a, b) => a ?? b);
    // Los decimales van a Intl.NumberFormat, que lanza RangeError fuera de 0–20: mejor un error de sintaxis al guardar.
    if (filter === "number" && arg && !(/^\d{1,2}$/.test(arg) && Number(arg) <= 20)) {
      throw new TemplateSyntaxError(`decimales inválidos en {{${tag}}}: un número de 0 a 20`, line);
    }
    return [{ t: "var", path: vm[1], filter, arg }];
  }
  const res = parseSeq(() => false);
  return res;
}

function isTag(t: Tok, v: string) {
  return t.k === "tag" && t.v === v;
}

// ───────────────────────────── Parser de bloques ─────────────────────────────

export function parseTemplate(source: string): Node[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  function parseNodes(stop: (l: string) => boolean): Node[] {
    const out: Node[] = [];
    let para: Inline[][] | null = null;
    const endPara = () => {
      if (para) out.push({ k: "para", lines: para });
      para = null;
    };
    while (i < lines.length) {
      const raw = lines[i];
      if (stop(raw)) {
        endPara();
        return out;
      }
      const ln = i + 1;
      i++;
      let m: RegExpExecArray | null;
      if ((m = RE_IF_LINE.exec(raw))) {
        endPara();
        const cond = parseCond(m[1], ln);
        const then = parseNodes((l) => RE_ELSE_LINE.test(l) || RE_ENDIF_LINE.test(l));
        let els: Node[] = [];
        if (i < lines.length && RE_ELSE_LINE.test(lines[i])) {
          i++;
          els = parseNodes((l) => RE_ENDIF_LINE.test(l));
        }
        if (i >= lines.length || !RE_ENDIF_LINE.test(lines[i])) throw new TemplateSyntaxError("falta {{/if}}", ln);
        i++;
        out.push({ k: "if", cond, then, else: els });
        continue;
      }
      if ((m = RE_EACH_LINE.exec(raw))) {
        endPara();
        const body = parseNodes((l) => RE_ENDEACH_LINE.test(l));
        if (i >= lines.length) throw new TemplateSyntaxError("falta {{/each}}", ln);
        i++;
        out.push({ k: "each", path: m[1], as: m[2] ?? "item", body });
        continue;
      }
      if (RE_ELSE_LINE.test(raw) || RE_ENDIF_LINE.test(raw)) throw new TemplateSyntaxError(`${raw.trim()} sin {{#if}}`, ln);
      if (RE_ENDEACH_LINE.test(raw)) throw new TemplateSyntaxError("{{/each}} sin {{#each}}", ln);
      if (raw.trim() === "") {
        endPara();
        continue;
      }
      if ((m = RE_CLAUSE_LINE.exec(raw))) {
        endPara();
        out.push({ k: "clause", slug: m[1].toLowerCase() });
        continue;
      }
      if (RE_PAGEBREAK.test(raw)) {
        endPara();
        out.push({ k: "pagebreak" });
        continue;
      }
      if ((m = RE_HEADING.exec(raw))) {
        endPara();
        out.push({ k: "heading", level: m[1].length as 1 | 2 | 3, inl: parseInline(m[2], ln) });
        continue;
      }
      if (isSepRow(raw)) {
        endPara();
        const prev = out[out.length - 1];
        if (prev?.k === "row") prev.header = true;
        continue;
      }
      if ((m = RE_ROW.exec(raw))) {
        endPara();
        // Después de una línea en blanco empieza otra tabla: dos tablas separadas no se fusionan en una.
        const newTable = i >= 2 && lines[i - 2].trim() === "";
        out.push({ k: "row", cells: splitCells(m[1]).map((c) => parseInline(c.trim(), ln)), header: false, ...(newTable ? { newTable } : {}) });
        continue;
      }
      if ((m = RE_OL.exec(raw))) {
        endPara();
        out.push({ k: "li", ordered: true, inl: parseInline(m[2], ln), num: Number(m[1]) });
        continue;
      }
      if ((m = RE_UL.exec(raw))) {
        endPara();
        out.push({ k: "li", ordered: false, inl: parseInline(m[1], ln) });
        continue;
      }
      (para ??= []).push(parseInline(raw.trim(), ln));
    }
    endPara();
    return out;
  }
  const nodes = parseNodes(() => false);
  return nodes;
}

function splitCells(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" && s[i + 1] === "{") inTag = true;
    if (s[i] === "}" && s[i + 1] === "}") inTag = false;
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (s[i] === "|" && !inTag) {
      out.push(cur);
      cur = "";
    } else cur += s[i];
  }
  out.push(cur);
  return out;
}

// ───────────────────────────── Evaluación ─────────────────────────────

export const FILTERS = ["upper", "lower", "number", "money", "date", "default"];

export interface RenderOptions {
  /** Código de la cláusula → texto fuente (misma sintaxis). */
  clauses?: Record<string, string>;
  locale?: string;
  /** Cómo mostrar una variable faltante: "empty" (por defecto) o "placeholder" ([ruta]). */
  missing?: "empty" | "placeholder";
  /**
   * Comportamiento anterior a la validación del grafo de cláusulas, solo para documentos ya guardados (p. ej. la copia
   * de cláusulas de una negociación creada antes): cláusulas que citan cláusulas hasta 3 niveles, y lo que pase de ahí
   * (incluidos los ciclos) se omite sin error. Así una negociación vieja no deja de renderizar. No usar en documentos nuevos.
   */
  legacyClauseRecursion?: boolean;
}

export interface RenderResult {
  blocks: ResolvedBlock[];
  /** Variables usadas sin valor (rutas únicas). */
  missing: string[];
  /** Marcas de firma presentes en el resultado, en orden. */
  marks: { kind: MarkKind; role: string }[];
  /** Cláusulas citadas que no existen en la biblioteca. */
  missingClauses: string[];
  /** Cláusulas que se insertaron en el resultado (para dejar constancia de su versión). */
  usedClauses: string[];
}

type Scope = Map<string, unknown>;

/** Tope de nodos evaluados (incluye cada vuelta de {{#each}} y las cláusulas citadas) y de texto generado. */
export const MAX_RENDER_WORK = 20_000;
// 300 000 caracteres son unas 100 páginas: el PDF se arma en el hilo principal y más texto lo bloqueaba.
export const MAX_RENDER_CHARS = 300_000;
export const MAX_MARKS = 500;
/** Cláusulas que citan cláusulas: niveles de anidamiento admitidos (más es un error, no se descarta en silencio). */
export const MAX_CLAUSE_DEPTH = 8;

const clauseCycleError = (chain: string[]) =>
  new TemplateSyntaxError(`las cláusulas se citan en ciclo: ${chain.map((c) => `{{clausula:${c}}}`).join(" → ")}`, 0, "clause_cycle");
const clauseDepthError = (chain: string[]) =>
  new TemplateSyntaxError(`demasiados niveles de cláusulas que citan cláusulas (máximo ${MAX_CLAUSE_DEPTH}): ${chain.join(" → ")}`, 0, "clause_depth");

/** Clave para comparar roles: sin distinguir mayúsculas ni espacios repetidos ("cliente" y "Cliente" son el mismo). */
export function roleKey(role: string): string {
  return role.trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

export function renderTemplate(source: string, data: unknown, opts: RenderOptions = {}): RenderResult {
  const missing = new Set<string>();
  const missingClauses = new Set<string>();
  const usedClauses = new Set<string>();
  const marks: { kind: MarkKind; role: string }[] = [];
  const locale = opts.locale ?? "es";
  const clauseCache = new Map<string, Node[]>();
  // Roles sin distinguir mayúsculas: todas las marcas usan la grafía de la primera aparición (como analyzeTemplate).
  const roleSpelling = new Map<string, string>();
  const canonRole = (r: string) => {
    const k = roleKey(r);
    let v = roleSpelling.get(k);
    if (v === undefined) roleSpelling.set(k, (v = r.trim().replace(/\s+/g, " ")));
    return v;
  };
  // Presupuesto de salida: {{#each}} anidados (o cláusulas que citan cientos de cláusulas) multiplican el trabajo, y una
  // variable larga repetida en un each multiplica el texto. Sin tope, un pedido de cualquier cuenta colgaba la API.
  let work = 0;
  let chars = 0;
  const tooBig = () => new TemplateSyntaxError(`el documento generado es demasiado grande (máximo ${MAX_RENDER_WORK} bloques o ${MAX_RENDER_CHARS} caracteres)`, 0);
  const charge = (units: number, text = 0) => {
    work += units;
    chars += text;
    if (work > MAX_RENDER_WORK || chars > MAX_RENDER_CHARS) throw tooBig();
  };

  function lookup(path: string, scopes: Scope[]): unknown {
    const parts = path.split(".");
    let cur: unknown;
    let found = false;
    for (let s = scopes.length - 1; s >= 0; s--) {
      if (scopes[s].has(parts[0])) {
        cur = scopes[s].get(parts[0]);
        found = true;
        break;
      }
    }
    // Solo propiedades propias, como en los niveles de abajo: {{constructor}} o {{#if toString}} no leen el prototipo.
    if (!found) cur = isObj(data) && Object.prototype.hasOwnProperty.call(data, parts[0]) ? (data as Record<string, unknown>)[parts[0]] : undefined;
    for (const p of parts.slice(1)) {
      if (cur == null) return undefined;
      if (Array.isArray(cur) && /^\d+$/.test(p)) cur = cur[Number(p)];
      else if (isObj(cur) && Object.prototype.hasOwnProperty.call(cur, p)) cur = (cur as Record<string, unknown>)[p];
      else return undefined;
    }
    return cur;
  }

  function truthy(v: unknown): boolean {
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "string") return v.trim() !== "" && !["false", "0", "no"].includes(v.trim().toLowerCase());
    return Boolean(v);
  }

  function evalCond(c: Cond, scopes: Scope[]): boolean {
    const v = lookup(c.path, scopes);
    if (c.op === "truthy") return c.neg ? !truthy(v) : truthy(v);
    const target = c.num !== undefined ? (toNum(c.num, locale) ?? c.value) : c.value;
    if (c.op === "eq" || c.op === "ne") {
      const eq = typeof target === "number" ? toNum(v, locale) === target : typeof target === "boolean" ? truthy(v) === target : String(v ?? "") === target;
      return c.op === "eq" ? eq : !eq;
    }
    const a = toNum(v, locale);
    const b = typeof target === "number" ? target : toNum(target, locale);
    if (a === null || b === null) return false;
    return c.op === "gt" ? a > b : c.op === "lt" ? a < b : c.op === "ge" ? a >= b : a <= b;
  }

  function format(v: unknown, filter: string | null, arg: string | null, path: string): string {
    if (filter === "default") {
      if (v == null || v === "") return arg ?? "";
    } else if (v == null || v === "" || (typeof v === "object" && !Array.isArray(v))) {
      missing.add(path);
      return opts.missing === "placeholder" ? `[${path}]` : "";
    }
    if (Array.isArray(v)) v = v.map((x) => (isObj(x) ? "" : String(x))).filter(Boolean).join(", ");
    switch (filter) {
      case "upper":
        return String(v).toLocaleUpperCase(locale);
      case "lower":
        return String(v).toLocaleLowerCase(locale);
      case "number": {
        const n = toNum(v, locale);
        return n === null ? String(v) : new Intl.NumberFormat(locale, { maximumFractionDigits: arg ? Number(arg) : 2 }).format(n);
      }
      case "money": {
        const n = toNum(v, locale);
        if (n === null) return String(v);
        try {
          return new Intl.NumberFormat(locale, { style: "currency", currency: (arg ?? "USD").toUpperCase() }).format(n);
        } catch {
          return `${(arg ?? "").toUpperCase()} ${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`.trim();
        }
      }
      case "date": {
        const d = parseDate(v, locale);
        if (!d) return String(v);
        return new Intl.DateTimeFormat(locale, { dateStyle: arg === "long" ? "long" : "short", timeZone: "UTC" }).format(d);
      }
      default:
        return typeof v === "number" ? String(v) : String(v);
    }
  }

  function evalInline(inl: Inline[], scopes: Scope[], style: { b?: boolean; i?: boolean } = {}): Run[] {
    const out: Run[] = [];
    for (const x of inl) {
      if (x.t === "text") {
        charge(0, x.v.length);
        pushText(out, x.v, style);
      } else if (x.t === "var") {
        const v = x.path === "@index" ? String(lookup("@index", scopes) ?? "") : format(lookup(x.path, scopes), x.filter, x.arg, x.path);
        charge(0, v.length);
        pushText(out, v, style);
      }
      else if (x.t === "mark") {
        charge(1);
        // Cada marca es un campo del sobre: el mismo tope que al cargar campos.
        if (marks.length >= MAX_MARKS) throw new TemplateSyntaxError(`el documento tiene demasiadas marcas de firma o campos (máximo ${MAX_MARKS})`, 0);
        const role = canonRole(x.role);
        marks.push({ kind: x.kind, role });
        out.push({ mark: x.kind, role });
      } else if (x.t === "if") out.push(...evalInline(evalCond(x.cond, scopes) ? x.then : x.else, scopes, style));
      else if (x.t === "b") out.push(...evalInline(x.c, scopes, { ...style, b: true }));
      else out.push(...evalInline(x.c, scopes, { ...style, i: true }));
    }
    return out;
  }

  const blocks: ResolvedBlock[] = [];
  // `chain`: cláusulas que se están expandiendo (de afuera hacia adentro), para detectar ciclos.
  function emitNodes(nodes: Node[], scopes: Scope[], chain: string[]) {
    for (const n of nodes) {
      charge(1);
      if (n.k === "if") emitNodes(evalCond(n.cond, scopes) ? n.then : n.else, scopes, chain);
      else if (n.k === "each") {
        const arr = lookup(n.path, scopes);
        if (!Array.isArray(arr)) {
          if (arr == null) missing.add(n.path);
          continue;
        }
        arr.forEach((item, idx) => emitNodes(n.body, [...scopes, new Map<string, unknown>([[n.as, item], ["@index", idx + 1]])], chain));
      } else if (n.k === "clause") {
        // Propias del objeto: un slug como "constructor" no toma lo heredado de Object.prototype.
        const src = opts.clauses && Object.hasOwn(opts.clauses, n.slug) ? opts.clauses[n.slug] : undefined;
        if (src == null) {
          missingClauses.add(n.slug);
          continue;
        }
        // Un ciclo (a → a, a → b → a) duplicaba el texto hasta el tope de niveles y un nivel más profundo se perdía sin
        // aviso: ahora los dos son errores de la plantilla.
        if (opts.legacyClauseRecursion) {
          if (chain.length >= 3) continue;
        } else if (chain.includes(n.slug)) throw clauseCycleError([...chain.slice(chain.indexOf(n.slug)), n.slug]);
        else if (chain.length >= MAX_CLAUSE_DEPTH) throw clauseDepthError([...chain, n.slug]);
        usedClauses.add(n.slug);
        let parsed = clauseCache.get(n.slug);
        if (!parsed) {
          parsed = parseTemplate(src);
          clauseCache.set(n.slug, parsed);
        }
        emitNodes(parsed, scopes, [...chain, n.slug]);
      } else if (n.k === "heading") blocks.push({ type: "heading", level: n.level, runs: evalInline(n.inl, scopes) });
      else if (n.k === "para") {
        const runs: Run[] = [];
        n.lines.forEach((l, idx) => {
          if (idx > 0) runs.push({ br: true });
          runs.push(...evalInline(l, scopes));
        });
        blocks.push({ type: "paragraph", runs });
      } else if (n.k === "li") {
        const last = blocks[blocks.length - 1];
        const runs = evalInline(n.inl, scopes);
        if (last?.type === "list" && last.ordered === n.ordered) last.items.push(runs);
        else blocks.push({ type: "list", ordered: n.ordered, items: [runs], ...(n.ordered && n.num != null && n.num !== 1 ? { start: n.num } : {}) });
      } else if (n.k === "row") {
        charge(n.cells.length); // celdas vacías también ocupan memoria
        const cells = n.cells.map((c) => evalInline(c, scopes));
        const last = blocks[blocks.length - 1];
        if (n.header) {
          if (last?.type === "table" && !n.newTable && !last.header && last.rows.length === 0) last.header = cells;
          else blocks.push({ type: "table", header: cells, rows: [] });
        } else if (last?.type === "table" && !n.newTable) last.rows.push(cells);
        else blocks.push({ type: "table", header: null, rows: [cells] });
      } else if (n.k === "pagebreak") blocks.push({ type: "pagebreak" });
    }
  }
  emitNodes(parseTemplate(source), [], []);
  return { blocks, missing: [...missing], marks, missingClauses: [...missingClauses], usedClauses: [...usedClauses] };
}

function pushText(out: Run[], v: string, style: { b?: boolean; i?: boolean }) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && "text" in last && Boolean(last.b) === Boolean(style.b) && Boolean(last.i) === Boolean(style.i)) last.text += v;
  else out.push({ text: v, ...(style.b ? { b: true } : {}), ...(style.i ? { i: true } : {}) });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const reSep = (c: "." | ",") => (c === "." ? "\\." : ",");

/** Separador decimal del idioma: "." en inglés, "," en español y portugués. */
function decimalSep(locale: string): "." | "," {
  return /^en\b/i.test(locale) ? "." : ",";
}

/**
 * Número escrito por una persona ("1.500", "2,500", "US$ 1.234,56") según el idioma de la plantilla. Con un solo
 * separador seguido de exactamente 3 cifras ("1.500", "2,500") decide el idioma: en es/pt el punto agrupa miles y la
 * coma es decimal; en inglés al revés. Antes "1.500" valía 1,5 en un contrato en español. Con los dos separadores, el
 * último es el decimal y los grupos de miles tienen que ser de 3 cifras; un formato que no cierra (p. ej. "1,2.3") es
 * ambiguo: null, y el valor se imprime tal cual.
 */
export function parseLocaleNumber(v: unknown, locale = "es"): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replace(/[^\d,.-]/g, "");
  // Sin dígitos no es un número ("a convenir", "-"): Number("") daría 0 y el contrato diría "US$ 0,00".
  if (!/\d/.test(s)) return null;
  const dec = decimalSep(locale);
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");
  if (hasDot && hasComma) {
    // 1.234,56 / 1,234.56: el último separador es el decimal y el otro agrupa de a 3.
    const d = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const g = d === "," ? "." : ",";
    const re = new RegExp(String.raw`^-?\d{1,3}(?:${reSep(g)}\d{3})+${reSep(d)}\d+$`);
    if (!re.test(s)) return null;
    s = s.split(g).join("").replace(d, ".");
  } else if (hasDot || hasComma) {
    const sep = hasDot ? "." : ",";
    const parts = s.split(sep);
    if (parts.length > 2) {
      // 1.500.000 / 1,500,000: el mismo separador repetido entre grupos de 3 cifras son miles (no hay otra lectura).
      if (!new RegExp(String.raw`^-?\d{1,3}(?:${reSep(sep)}\d{3})+$`).test(s)) return null;
      s = parts.join("");
    } else if (/^-?[1-9]\d{0,2}$/.test(parts[0]) && /^\d{3}$/.test(parts[1])) {
      // Un solo grupo de 3 cifras ("1.500", "2,500"): miles si el separador no es el decimal del idioma.
      s = sep === dec ? `${parts[0]}.${parts[1]}` : parts.join("");
    } else s = `${parts[0]}.${parts[1]}`;
  }
  if (!/^-?\d*\.?\d+$|^-?\d+\.?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const toNum = parseLocaleNumber;

/**
 * Fecha escrita con barras según el idioma: en inglés mes/día/año (03/01/2027 = 1 de marzo), en español y portugués
 * día/mes/año (03/01/2027 = 3 de enero). AAAA-MM-DD vale en todos.
 */
export function parseLocaleDate(v: unknown, locale = "es"): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  // Día, mes y año explícitos tienen que existir: Date.UTC (y new Date con "2027-02-31") corren el 31/02 al 3 de
  // marzo, y el contrato decía una fecha que nadie escribió. Una fecha inexistente se imprime tal cual vino.
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  // AAAA/M/D: con el año primero no hay ambigüedad, es año/mes/día en cualquier idioma.
  const ymdSlash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?=$|T)/.exec(s);
  const mdy = /^en\b/i.test(locale);
  const parts = slash
    ? { y: +slash[3], m: +(mdy ? slash[1] : slash[2]), d: +(mdy ? slash[2] : slash[1]) }
    : ymdSlash
      ? { y: +ymdSlash[1], m: +ymdSlash[2], d: +ymdSlash[3] }
      : ymd
        ? { y: +ymd[1], m: +ymd[2], d: +ymd[3] }
        : null;
  if (parts) {
    const check = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
    if (check.getUTCFullYear() !== parts.y || check.getUTCMonth() !== parts.m - 1 || check.getUTCDate() !== parts.d) return null;
    if (slash || ymdSlash) return check;
  }
  // Otro texto con barras (03/01/27) no se adivina: new Date lo leería como mes/día en cualquier idioma.
  if (s.includes("/")) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const parseDate = parseLocaleDate;

// ───────────────────────────── Análisis ─────────────────────────────

export interface TemplateAnalysis {
  /** Variables de nivel superior (fuera de bucles), por ruta. */
  variables: string[];
  loops: { path: string; as: string; fields: string[] }[];
  /** Roles de las marcas, sin repetir (sin distinguir mayúsculas: vale la grafía de la primera aparición). */
  roles: string[];
  /** Roles con marcas (iniciales, fecha, nombre) pero sin ningún {{firma:Rol}}: no se puede generar el sobre con ellos. */
  unsignedRoles?: string[];
  clauses: string[];
}

export function analyzeTemplate(source: string, clauses: Record<string, string> = {}): TemplateAnalysis {
  const vars = new Set<string>();
  const loops = new Map<string, { path: string; as: string; fields: Set<string> }>();
  const roles = new Map<string, string>();
  const signed = new Set<string>();
  const usedClauses = new Set<string>();
  const seenClauses = new Set<string>();

  function inl(xs: Inline[], loopVars: Map<string, { path: string; as: string; fields: Set<string> }>) {
    for (const x of xs) {
      if (x.t === "var") addPath(x.path, loopVars);
      else if (x.t === "mark") {
        const k = roleKey(x.role);
        if (!roles.has(k)) roles.set(k, x.role.trim().replace(/\s+/g, " "));
        if (x.kind === "signature") signed.add(k);
      }
      else if (x.t === "if") {
        addPath(x.cond.path, loopVars);
        inl(x.then, loopVars);
        inl(x.else, loopVars);
      } else if (x.t === "b" || x.t === "i") inl(x.c, loopVars);
    }
  }
  function addPath(p: string, loopVars: Map<string, { path: string; as: string; fields: Set<string> }>) {
    if (p === "@index") return;
    const head = p.split(".")[0];
    const loop = loopVars.get(head);
    if (loop) {
      const rest = p.split(".").slice(1).join(".");
      if (rest) loop.fields.add(rest);
    } else vars.add(p);
  }
  function nodes(ns: Node[], loopVars: Map<string, { path: string; as: string; fields: Set<string> }>) {
    for (const n of ns) {
      if (n.k === "heading" || n.k === "li") inl(n.inl, loopVars);
      else if (n.k === "para") n.lines.forEach((l) => inl(l, loopVars));
      else if (n.k === "row") n.cells.forEach((c) => inl(c, loopVars));
      else if (n.k === "if") {
        addPath(n.cond.path, loopVars);
        nodes(n.then, loopVars);
        nodes(n.else, loopVars);
      } else if (n.k === "each") {
        const head = n.path.split(".")[0];
        const outer = loopVars.get(head);
        const entry = loops.get(n.path) ?? { path: n.path, as: n.as, fields: new Set<string>() };
        if (!outer) loops.set(n.path, entry);
        nodes(n.body, new Map([...loopVars, [n.as, entry]]));
        // Lista anidada ({{#each item.lineas as l}} dentro de otra): sus campos son de la lista de afuera. Antes se perdían
        // (la de adentro no se registra) y la de afuera no mostraba "lineas".
        if (outer) {
          const rest = n.path.split(".").slice(1).join(".");
          if (rest) outer.fields.add(rest);
          for (const f of entry.fields) outer.fields.add(rest ? `${rest}.${f}` : f);
        }
      } else if (n.k === "clause") {
        usedClauses.add(n.slug);
        if (!seenClauses.has(n.slug) && Object.hasOwn(clauses, n.slug) && clauses[n.slug] != null) {
          seenClauses.add(n.slug);
          try {
            nodes(parseTemplate(clauses[n.slug]), loopVars);
          } catch {
            /* la cláusula se valida por separado */
          }
        }
      }
    }
  }
  nodes(parseTemplate(source), new Map());
  return {
    variables: [...vars].sort(),
    loops: [...loops.values()].map((l) => ({ path: l.path, as: l.as, fields: [...l.fields].sort() })),
    roles: [...roles.values()],
    unsignedRoles: [...roles].filter(([k]) => !signed.has(k)).map(([, v]) => v),
    clauses: [...usedClauses],
  };
}

// ───────────────────────────── Grafo de cláusulas ─────────────────────────────

/** Cláusulas citadas por un texto, en todas las ramas ({{#if}}/{{else}}, {{#each}}), sin evaluar datos. */
export function clauseRefs(source: string): string[] {
  const out = new Set<string>();
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      if (n.k === "clause") out.add(n.slug);
      else if (n.k === "if") {
        walk(n.then);
        walk(n.else);
      } else if (n.k === "each") walk(n.body);
    }
  };
  walk(parseTemplate(source));
  return [...out];
}

/**
 * Valida que las cláusulas `roots` (con la biblioteca `clauses`) no se citen en ciclo ni pasen de MAX_CLAUSE_DEPTH
 * niveles, mirando todas las ramas (un ciclo dentro de un {{#if}} que hoy no se cumple igual rompería otro documento).
 * Lanza TemplateSyntaxError. Una cláusula con errores de sintaxis no cita nada (se valida por separado).
 * `refCache` (texto de la cláusula → citas) se puede compartir entre llamadas para no volver a parsear los mismos textos.
 */
export function checkClauseGraph(clauses: Record<string, string>, roots: string[], refCache: Map<string, string[]> = new Map()): void {
  const height = new Map<string, number>();
  const visiting = new Set<string>();
  const refsOf = (slug: string) => {
    const src = clauses[slug];
    let r = refCache.get(src);
    if (!r) {
      try {
        r = clauseRefs(src);
      } catch {
        r = [];
      }
      refCache.set(src, r);
    }
    return r;
  };
  const dfs = (slug: string, stack: string[]): number => {
    if (!Object.hasOwn(clauses, slug) || clauses[slug] == null) return 0;
    if (visiting.has(slug)) throw clauseCycleError([...stack.slice(stack.indexOf(slug)), slug]);
    const done = height.get(slug);
    if (done !== undefined) {
      if (stack.length + done > MAX_CLAUSE_DEPTH) throw clauseDepthError([...stack, slug]);
      return done;
    }
    if (stack.length >= MAX_CLAUSE_DEPTH) throw clauseDepthError([...stack, slug]);
    visiting.add(slug);
    stack.push(slug);
    let h = 0;
    for (const c of refsOf(slug)) h = Math.max(h, dfs(c, stack));
    stack.pop();
    visiting.delete(slug);
    height.set(slug, h + 1);
    return h + 1;
  };
  for (const r of roots) dfs(r, []);
}

// ───────────────────────────── Texto plano y diff ─────────────────────────────

export function blocksToText(blocks: ResolvedBlock[]): string {
  const runText = (runs: Run[]) =>
    runs.map((r) => ("text" in r ? r.text : "br" in r ? "\n" : `[${r.mark === "signature" ? "Firma" : r.mark === "initials" ? "Iniciales" : r.mark === "date" ? "Fecha" : "Nombre"}: ${r.role}]`)).join("");
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading" || b.type === "paragraph") out.push(runText(b.runs));
    else if (b.type === "list") b.items.forEach((it, i) => out.push(`${b.ordered ? `${(b.start ?? 1) + i}.` : "•"} ${runText(it)}`));
    else if (b.type === "table") {
      if (b.header) out.push(b.header.map(runText).join(" | "));
      b.rows.forEach((r) => out.push(r.map(runText).join(" | ")));
    } else out.push("");
  }
  return out.join("\n");
}

export type DiffPart = { op: "eq" | "ins" | "del"; text: string };

/** Diff por palabras (Myers sobre tokens). Pensado para versiones de un contrato (miles de palabras). */
export function diffWords(a: string, b: string): DiffPart[] {
  const ta = a.match(/\s+|[^\s]+/g) ?? [];
  const tb = b.match(/\s+|[^\s]+/g) ?? [];
  let pre = 0;
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++;
  let suf = 0;
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++;
  const A = ta.slice(pre, ta.length - suf);
  const B = tb.slice(pre, tb.length - suf);
  const mid = myers(A, B);
  const parts: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.op === op) last.text += text;
    else parts.push({ op, text });
  };
  push("eq", ta.slice(0, pre).join(""));
  for (const p of mid) push(p.op, p.text);
  push("eq", ta.slice(ta.length - suf).join(""));
  return parts;
}

/** Máximo de ediciones (inserciones + borrados de tokens) que se calculan en detalle. */
const MAX_DIFF_EDITS = 2000;

function myers(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m ? [{ op: "ins", text: b.join("") }] : [];
  if (m === 0) return [{ op: "del", text: a.join("") }];
  const max = n + m;
  const coarse: DiffPart[] = [{ op: "del", text: a.join("") }, { op: "ins", text: b.join("") }];
  if (max > 40000) return coarse;
  // El rastro guarda una copia de `v` por cada paso: la memoria crece como D². Con textos muy distintos se
  // corta y se devuelve el cambio en bloque, en vez de agotar la memoria del proceso.
  const maxD = Math.min(max, MAX_DIFF_EDITS);
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let done = false;
  outer: for (let d = 0; d <= maxD; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        done = true;
        break outer;
      }
    }
  }
  if (!done) return coarse;
  // Backtrack
  const ops: DiffPart[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: "eq", text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "ins", text: b[y - 1] });
      else ops.push({ op: "del", text: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}
