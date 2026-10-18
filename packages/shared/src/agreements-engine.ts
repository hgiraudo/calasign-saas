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
  | { op: "eq" | "ne" | "gt" | "lt" | "ge" | "le"; path: string; value: string | number | boolean };

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
  | { k: "li"; ordered: boolean; inl: Inline[] }
  | { k: "row"; cells: Inline[][]; header: boolean }
  | { k: "pagebreak" }
  | { k: "clause"; slug: string }
  | { k: "if"; cond: Cond; then: Node[]; else: Node[] }
  | { k: "each"; path: string; as: string; body: Node[] };

export type Run = { text: string; b?: boolean; i?: boolean } | { mark: MarkKind; role: string } | { br: true };

export type ResolvedBlock =
  | { type: "heading"; level: 1 | 2 | 3; runs: Run[] }
  | { type: "paragraph"; runs: Run[] }
  | { type: "list"; ordered: boolean; items: Run[][] }
  | { type: "table"; header: Run[][] | null; rows: Run[][][] }
  | { type: "pagebreak" };

export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Línea ${line}: ${message}`);
  }
}

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
const RE_IF_LINE = /^\s*\{\{#if\s+((?:(?!\}\}).)+)\}\}\s*$/;
const RE_ELSE_LINE = /^\s*\{\{else\}\}\s*$/;
const RE_ENDIF_LINE = /^\s*\{\{\/if\}\}\s*$/;
const RE_EACH_LINE = new RegExp(String.raw`^\s*\{\{#each\s+(${PATH})(?:\s+as\s+([A-Za-z_]\w*))?\s*\}\}\s*$`);
const RE_ENDEACH_LINE = /^\s*\{\{\/each\}\}\s*$/;
const RE_CLAUSE_LINE = /^\s*\{\{\s*(?:cl[aá]usula|clausula|clause)\s*:\s*([\w-]+)\s*\}\}\s*$/i;
const RE_PAGEBREAK = /^\s*(?:\{\{\s*(?:salto|quebra|pagebreak)\s*\}\}|\\pagebreak)\s*$/i;
const RE_HEADING = /^(#{1,3})\s+(.*)$/;
const RE_UL = /^\s*[-•]\s+(.*)$/;
const RE_OL = /^\s*\d+[.)]\s+(.*)$/;
const RE_ROW = /^\s*\|(.*)\|\s*$/;
const RE_SEP = /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/;

// ───────────────────────────── Condiciones ─────────────────────────────

export function parseCond(src: string, line = 0): Cond {
  const s = src.trim();
  const m = new RegExp(String.raw`^(${PATH})\s*(==|!=|>=|<=|>|<)\s*(.+)$`).exec(s);
  if (m) {
    const ops = { "==": "eq", "!=": "ne", ">": "gt", "<": "lt", ">=": "ge", "<=": "le" } as const;
    return { op: ops[m[2] as keyof typeof ops], path: m[1], value: parseLiteral(m[3].trim(), line) };
  }
  const t = new RegExp(String.raw`^(!?)\s*(${PATH})$`).exec(s);
  if (t) return { op: "truthy", path: t[2], neg: t[1] === "!" };
  throw new TemplateSyntaxError(`condición inválida: ${s}`, line);
}

function parseLiteral(s: string, line: number): string | number | boolean {
  const q = /^"(.*)"$|^'(.*)'$/.exec(s);
  if (q) return q[1] ?? q[2] ?? "";
  if (s === "true" || s === "verdadero") return true;
  if (s === "false" || s === "falso") return false;
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
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && "*{}\\|#".includes(src[i + 1])) {
      buf += src[++i];
      continue;
    }
    if (c === "{" && src[i + 1] === "{") {
      const end = src.indexOf("}}", i + 2);
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
    if (mk && MARK_TAGS[mk[1].toLowerCase()]) return [{ t: "mark", kind: MARK_TAGS[mk[1].toLowerCase()], role: mk[2].trim() }];
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
      if (RE_SEP.test(raw) && raw.includes("-")) {
        endPara();
        const prev = out[out.length - 1];
        if (prev?.k === "row") prev.header = true;
        continue;
      }
      if ((m = RE_ROW.exec(raw))) {
        endPara();
        out.push({ k: "row", cells: splitCells(m[1]).map((c) => parseInline(c.trim(), ln)), header: false });
        continue;
      }
      if ((m = RE_OL.exec(raw))) {
        endPara();
        out.push({ k: "li", ordered: true, inl: parseInline(m[1], ln) });
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
}

export interface RenderResult {
  blocks: ResolvedBlock[];
  /** Variables usadas sin valor (rutas únicas). */
  missing: string[];
  /** Marcas de firma presentes en el resultado, en orden. */
  marks: { kind: MarkKind; role: string }[];
  /** Cláusulas citadas que no existen en la biblioteca. */
  missingClauses: string[];
}

type Scope = Map<string, unknown>;

export function renderTemplate(source: string, data: unknown, opts: RenderOptions = {}): RenderResult {
  const missing = new Set<string>();
  const missingClauses = new Set<string>();
  const marks: { kind: MarkKind; role: string }[] = [];
  const locale = opts.locale ?? "es";
  const clauseCache = new Map<string, Node[]>();

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
    if (!found) cur = isObj(data) ? (data as Record<string, unknown>)[parts[0]] : undefined;
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
    const target = c.value;
    if (c.op === "eq" || c.op === "ne") {
      const eq = typeof target === "number" ? toNum(v) === target : typeof target === "boolean" ? truthy(v) === target : String(v ?? "") === target;
      return c.op === "eq" ? eq : !eq;
    }
    const a = toNum(v);
    const b = typeof target === "number" ? target : toNum(target);
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
        const n = toNum(v);
        return n === null ? String(v) : new Intl.NumberFormat(locale, { maximumFractionDigits: arg ? Number(arg) : 2 }).format(n);
      }
      case "money": {
        const n = toNum(v);
        if (n === null) return String(v);
        try {
          return new Intl.NumberFormat(locale, { style: "currency", currency: (arg ?? "USD").toUpperCase() }).format(n);
        } catch {
          return `${(arg ?? "").toUpperCase()} ${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`.trim();
        }
      }
      case "date": {
        const d = parseDate(v);
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
      if (x.t === "text") pushText(out, x.v, style);
      else if (x.t === "var") pushText(out, x.path === "@index" ? String(lookup("@index", scopes) ?? "") : format(lookup(x.path, scopes), x.filter, x.arg, x.path), style);
      else if (x.t === "mark") {
        marks.push({ kind: x.kind, role: x.role });
        out.push({ mark: x.kind, role: x.role });
      } else if (x.t === "if") out.push(...evalInline(evalCond(x.cond, scopes) ? x.then : x.else, scopes, style));
      else if (x.t === "b") out.push(...evalInline(x.c, scopes, { ...style, b: true }));
      else out.push(...evalInline(x.c, scopes, { ...style, i: true }));
    }
    return out;
  }

  const blocks: ResolvedBlock[] = [];
  function emitNodes(nodes: Node[], scopes: Scope[], depth: number) {
    for (const n of nodes) {
      if (n.k === "if") emitNodes(evalCond(n.cond, scopes) ? n.then : n.else, scopes, depth);
      else if (n.k === "each") {
        const arr = lookup(n.path, scopes);
        if (!Array.isArray(arr)) {
          if (arr == null) missing.add(n.path);
          continue;
        }
        arr.forEach((item, idx) => emitNodes(n.body, [...scopes, new Map<string, unknown>([[n.as, item], ["@index", idx + 1]])], depth));
      } else if (n.k === "clause") {
        const src = opts.clauses?.[n.slug];
        if (src == null) {
          missingClauses.add(n.slug);
          continue;
        }
        if (depth >= 3) continue; // cláusulas que citan cláusulas: máximo 3 niveles (evita ciclos)
        let parsed = clauseCache.get(n.slug);
        if (!parsed) {
          parsed = parseTemplate(src);
          clauseCache.set(n.slug, parsed);
        }
        emitNodes(parsed, scopes, depth + 1);
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
        else blocks.push({ type: "list", ordered: n.ordered, items: [runs] });
      } else if (n.k === "row") {
        const cells = n.cells.map((c) => evalInline(c, scopes));
        const last = blocks[blocks.length - 1];
        if (n.header) {
          if (last?.type === "table" && !last.header && last.rows.length === 0) last.header = cells;
          else blocks.push({ type: "table", header: cells, rows: [] });
        } else if (last?.type === "table") last.rows.push(cells);
        else blocks.push({ type: "table", header: null, rows: [cells] });
      } else if (n.k === "pagebreak") blocks.push({ type: "pagebreak" });
    }
  }
  emitNodes(parseTemplate(source), [], 0);
  return { blocks, missing: [...missing], marks, missingClauses: [...missingClauses] };
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

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replace(/[^\d,.-]/g, "");
  // Sin dígitos no es un número ("a convenir", "-"): Number("") daría 0 y el contrato diría "US$ 0,00".
  if (!/\d/.test(s)) return null;
  // 1.234,56 → 1234.56 ; 1,234.56 → 1234.56
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  // 1.500.000 / 1,500,000: el mismo separador repetido entre grupos de 3 cifras son miles (no hay otra lectura).
  // Antes daba NaN: {{valor | money:COP}} salía sin formato y {{#if valor > 1000000}} era falso.
  else if (/^-?\d{1,3}([.,])\d{3}(?:\1\d{3})+$/.test(s)) s = s.replace(/[.,]/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  // Día, mes y año explícitos tienen que existir: Date.UTC (y new Date con "2027-02-31") corren el 31/02 al 3 de
  // marzo, y el contrato decía una fecha que nadie escribió. Una fecha inexistente se imprime tal cual vino.
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})(?=$|T)/.exec(s);
  const parts = dmy ? { y: +dmy[3], m: +dmy[2], d: +dmy[1] } : ymd ? { y: +ymd[1], m: +ymd[2], d: +ymd[3] } : null;
  if (parts) {
    const check = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
    if (check.getUTCFullYear() !== parts.y || check.getUTCMonth() !== parts.m - 1 || check.getUTCDate() !== parts.d) return null;
    if (dmy) return check;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ───────────────────────────── Análisis ─────────────────────────────

export interface TemplateAnalysis {
  /** Variables de nivel superior (fuera de bucles), por ruta. */
  variables: string[];
  loops: { path: string; as: string; fields: string[] }[];
  roles: string[];
  clauses: string[];
}

export function analyzeTemplate(source: string, clauses: Record<string, string> = {}): TemplateAnalysis {
  const vars = new Set<string>();
  const loops = new Map<string, { path: string; as: string; fields: Set<string> }>();
  const roles = new Set<string>();
  const usedClauses = new Set<string>();
  const seenClauses = new Set<string>();

  function inl(xs: Inline[], loopVars: Map<string, { path: string; as: string; fields: Set<string> }>) {
    for (const x of xs) {
      if (x.t === "var") addPath(x.path, loopVars);
      else if (x.t === "mark") roles.add(x.role);
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
      } else if (n.k === "clause") {
        usedClauses.add(n.slug);
        if (!seenClauses.has(n.slug) && clauses[n.slug] != null) {
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
    roles: [...roles],
    clauses: [...usedClauses],
  };
}

// ───────────────────────────── Texto plano y diff ─────────────────────────────

export function blocksToText(blocks: ResolvedBlock[]): string {
  const runText = (runs: Run[]) =>
    runs.map((r) => ("text" in r ? r.text : "br" in r ? "\n" : `[${r.mark === "signature" ? "Firma" : r.mark === "initials" ? "Iniciales" : r.mark === "date" ? "Fecha" : "Nombre"}: ${r.role}]`)).join("");
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "heading" || b.type === "paragraph") out.push(runText(b.runs));
    else if (b.type === "list") b.items.forEach((it, i) => out.push(`${b.ordered ? `${i + 1}.` : "•"} ${runText(it)}`));
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
