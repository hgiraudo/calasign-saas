// Resaltado de sintaxis mínimo (sin dependencias) para los bloques de código del portal de desarrolladores.
// No pretende ser un parser: reconoce comentarios, strings, números, palabras clave y algunas formas propias de
// cada lenguaje, lo justo para que los ejemplos se lean bien.

export type Lang = "bash" | "js" | "ts" | "python" | "json" | "xml" | "http" | "text" | "toml";

export interface Token {
  t: string; // clase: c (comentario), s (string), n (número), k (palabra clave), p (propiedad), f (función/flag), v (variable), x (texto)
  v: string;
}

interface Rule {
  re: RegExp;
  t: string | ((m: RegExpExecArray) => string);
}

const JS_KW =
  "async|await|break|case|catch|class|const|continue|default|delete|do|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|yield|type|interface|as";
const PY_KW =
  "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield";

const RULES: Record<Lang, Rule[]> = {
  bash: [
    { re: /#[^\n]*/y, t: "c" },
    { re: /'[^']*'/y, t: "s" },
    { re: /"(?:\\.|[^"\\])*"/y, t: "s" },
    { re: /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/y, t: "v" },
    { re: /(?<=^|\s)--?[A-Za-z][\w-]*/y, t: "f" },
    { re: /\b(?:curl|export|npx|npm|pip|pnpm|claude|gemini|python3?|node|echo|cd|unzip)\b/y, t: "k" },
  ],
  js: [
    { re: /\/\/[^\n]*/y, t: "c" },
    { re: /\/\*[\s\S]*?\*\//y, t: "c" },
    { re: /`(?:\\.|\$\{[^}]*\}|[^`\\])*`/y, t: "s" },
    { re: /'(?:\\.|[^'\\])*'/y, t: "s" },
    { re: /"(?:\\.|[^"\\])*"/y, t: "s" },
    { re: /\b\d+(?:\.\d+)?\b/y, t: "n" },
    { re: new RegExp(`\\b(?:${JS_KW})\\b`, "y"), t: "k" },
    { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y, t: "f" },
  ],
  ts: [],
  python: [
    { re: /#[^\n]*/y, t: "c" },
    { re: /[rbf]?"""[\s\S]*?"""/y, t: "s" },
    { re: /[rbf]?'(?:\\.|[^'\\])*'/y, t: "s" },
    { re: /[rbf]?"(?:\\.|[^"\\])*"/y, t: "s" },
    { re: /\b\d+(?:\.\d+)?\b/y, t: "n" },
    { re: new RegExp(`\\b(?:${PY_KW})\\b`, "y"), t: "k" },
    { re: /@[A-Za-z_][\w.]*/y, t: "f" },
    { re: /\b[A-Za-z_]\w*(?=\s*\()/y, t: "f" },
  ],
  json: [
    { re: /\/\/[^\n]*/y, t: "c" },
    { re: /"(?:\\.|[^"\\])*"(?=\s*:)/y, t: "p" },
    { re: /"(?:\\.|[^"\\])*"/y, t: "s" },
    { re: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/y, t: "n" },
    { re: /\b(?:true|false|null)\b/y, t: "k" },
  ],
  xml: [
    { re: /<!--[\s\S]*?-->/y, t: "c" },
    { re: /<\/?[\w:.-]+/y, t: "k" },
    { re: /\/?>/y, t: "k" },
    { re: /"[^"]*"/y, t: "s" },
    { re: /\b[\w:.-]+(?==)/y, t: "p" },
  ],
  http: [
    { re: /^(?:GET|POST|PUT|PATCH|DELETE|HTTP\/[\d.]+)\b/my, t: "k" },
    { re: /^[A-Za-z-]+(?=:)/my, t: "p" },
    { re: /"(?:\\.|[^"\\])*"/y, t: "s" },
    { re: /\b\d{3}\b/y, t: "n" },
  ],
  toml: [
    { re: /#[^\n]*/y, t: "c" },
    { re: /^\s*\[[^\]\n]*\]/my, t: "k" },
    { re: /"(?:\\.|[^"\\])*"/y, t: "s" },
    { re: /^\s*[\w.-]+(?=\s*=)/my, t: "p" },
  ],
  text: [],
};
RULES.ts = RULES.js;

/** Divide el código en tokens. Lo que no reconoce ninguna regla queda como texto plano. */
export function tokenize(code: string, lang: Lang): Token[] {
  const rules = RULES[lang] ?? [];
  if (!rules.length) return [{ t: "x", v: code }];
  const out: Token[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) out.push({ t: "x", v: plain });
    plain = "";
  };
  while (i < code.length) {
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m.index === i && m[0].length > 0) {
        flush();
        out.push({ t: typeof r.t === "function" ? r.t(m) : r.t, v: m[0] });
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Avanzar una "palabra" de texto plano evita que \b de las reglas coincida en medio de un identificador.
      const w = /[A-Za-z0-9_$]+|[\s\S]/y;
      w.lastIndex = i;
      const m = w.exec(code)!;
      plain += m[0];
      i += m[0].length;
    }
  }
  flush();
  return out;
}
