// Piezas de UI del portal de desarrolladores: bloques de código con pestañas y copiar, avisos, tablas, títulos con
// ancla y un mini renderizador de marcado (`código`, **negrita**, [enlace](url), listas) para los textos traducidos.
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { tokenize, type Lang } from "./highlight";
import { useDocsText } from "../../lib/i18n-docs";

// ───────────────────────────── Marcado inline ─────────────────────────────

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function isInternal(href: string) {
  return (
    href.startsWith("/") &&
    !href.startsWith("//") &&
    !href.startsWith("/v1/") &&
    !href.startsWith("/integrations/") &&
    !href.startsWith("/.well-known")
  );
}

export function SmartLink({ href, children }: { href: string; children: ReactNode }) {
  if (isInternal(href)) return <Link to={href}>{children}</Link>;
  if (href.startsWith("#")) return <a href={href}>{children}</a>;
  const external = /^https?:\/\//.test(href);
  return (
    <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </a>
  );
}

/** Texto con `código`, **negrita** y [enlaces](url). */
export function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    const s = m[0];
    if (m[1]) parts.push(<code key={i++}>{s.slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={i++}>{s.slice(2, -2)}</strong>);
    else {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)!;
      parts.push(
        <SmartLink key={i++} href={mm[2]}>
          <Inline text={mm[1]} />
        </SmartLink>,
      );
    }
    last = m.index! + s.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Bloques: párrafos separados por línea en blanco, listas con "- " o "1. ". */
export function Md({ text, className }: { text: string; className?: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className={`md ${className ?? ""}`}>
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*- /.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*- /, "")} />
                </li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+\. /.test(l))) {
          return (
            <ol key={i}>
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*\d+\. /, "")} />
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline text={l} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// ───────────────────────────── Títulos con ancla ─────────────────────────────

function Anchor({ id }: { id: string }) {
  const t = useDocsText();
  return (
    <a className="docs-anchor" href={`#${id}`} aria-label={t("ui.linkTo")}>
      #
    </a>
  );
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="docs-h2">
      {children}
      <Anchor id={id} />
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="docs-h3">
      {children}
      <Anchor id={id} />
    </h3>
  );
}

// ───────────────────────────── Copiar ─────────────────────────────

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useDocsText();
  const [done, setDone] = useState(false);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="docs-copy"
      aria-label={label ?? t("ui.copyCode")}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      <span aria-hidden="true">{done ? "✓" : "⧉"}</span> {done ? t("ui.copied") : t("ui.copy")}
      <span className="sr-only" aria-live="polite">
        {done ? t("ui.copied") : ""}
      </span>
    </button>
  );
}

// ───────────────────────────── Código ─────────────────────────────

export function Highlighted({ code, lang }: { code: string; lang: Lang }) {
  const toks = useMemo(() => tokenize(code, lang), [code, lang]);
  return (
    <code className={`lang-${lang}`}>
      {toks.map((tk, i) =>
        tk.t === "x" ? (
          <Fragment key={i}>{tk.v}</Fragment>
        ) : (
          <span key={i} className={`tk-${tk.t}`}>
            {tk.v}
          </span>
        ),
      )}
    </code>
  );
}

export function Code({ code, lang = "text", title }: { code: string; lang?: Lang; title?: string }) {
  return (
    <div className="docs-code">
      <div className="docs-code-head">
        <span className="docs-code-title">{title ?? LANG_LABEL[lang]}</span>
        <CopyButton text={code} />
      </div>
      <pre tabIndex={0}>
        <Highlighted code={code} lang={lang} />
      </pre>
    </div>
  );
}

const LANG_LABEL: Record<Lang, string> = {
  bash: "Shell",
  js: "JavaScript",
  ts: "TypeScript",
  python: "Python",
  json: "JSON",
  xml: "XML",
  http: "HTTP",
  text: "",
  toml: "TOML",
};

export interface CodeTab {
  /** Clave de preferencia compartida entre bloques: curl, node, python, sdk-python, sdk-node… */
  id: string;
  label: string;
  lang: Lang;
  code: string;
}

const PREF_KEY = "cs-docs-lang";

interface LangPref {
  pref: string;
  setPref: (id: string) => void;
}
const LangPrefContext = createContext<LangPref>({ pref: "curl", setPref: () => undefined });

export function LangPrefProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<string>(() => {
    try {
      return localStorage.getItem(PREF_KEY) ?? "curl";
    } catch {
      return "curl";
    }
  });
  const setPref = useCallback((id: string) => {
    setPrefState(id);
    try {
      localStorage.setItem(PREF_KEY, id);
    } catch {
      /* sin almacenamiento: la preferencia vale solo en esta visita */
    }
  }, []);
  return <LangPrefContext.Provider value={{ pref, setPref }}>{children}</LangPrefContext.Provider>;
}

let tabsSeq = 0;

/** Bloque de código con pestañas por lenguaje. La pestaña elegida se recuerda y se aplica a todos los bloques. */
export function CodeTabs({ tabs, title }: { tabs: CodeTab[]; title?: string }) {
  const { pref, setPref } = useContext(LangPrefContext);
  const [uid] = useState(() => `ct${++tabsSeq}`);
  const active = tabs.find((x) => x.id === pref) ?? tabs[0];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (tabs.length === 1) return <Code code={tabs[0].code} lang={tabs[0].lang} title={title ?? tabs[0].label} />;
  const onKey = (e: KeyboardEvent, i: number) => {
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") n = 0;
    if (e.key === "End") n = tabs.length - 1;
    if (n >= 0) {
      e.preventDefault();
      setPref(tabs[n].id);
      refs.current[n]?.focus();
    }
  };
  return (
    <div className="docs-code">
      <div className="docs-code-head">
        <div role="tablist" aria-label={title ?? "code"} className="docs-tabs">
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              ref={(el) => (refs.current[i] = el)}
              type="button"
              role="tab"
              id={`${uid}-t-${tab.id}`}
              aria-selected={tab.id === active.id}
              aria-controls={`${uid}-p`}
              tabIndex={tab.id === active.id ? 0 : -1}
              className={tab.id === active.id ? "on" : ""}
              onClick={() => setPref(tab.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <CopyButton text={active.code} />
      </div>
      <pre id={`${uid}-p`} role="tabpanel" aria-labelledby={`${uid}-t-${active.id}`} tabIndex={0}>
        <Highlighted code={active.code} lang={active.lang} />
      </pre>
    </div>
  );
}

// ───────────────────────────── Bloques de contenido ─────────────────────────────

export function Callout({ kind = "info", title, children }: { kind?: "info" | "warn" | "tip" | "new"; title?: string; children: ReactNode }) {
  const icon = kind === "warn" ? "⚠" : kind === "tip" ? "✦" : kind === "new" ? "★" : "ℹ";
  return (
    <aside className={`docs-callout docs-callout-${kind}`}>
      <span className="docs-callout-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        {title && <strong className="docs-callout-title">{title}</strong>}
        {typeof children === "string" ? <Md text={children} /> : children}
      </div>
    </aside>
  );
}

export function DataTable({ head, rows, className }: { head: ReactNode[]; rows: ReactNode[][]; className?: string }) {
  return (
    <div className="docs-table-wrap" tabIndex={0}>
      <table className={`docs-table ${className ?? ""}`}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Method({ method }: { method: string }) {
  return <span className={`docs-method m-${method.toLowerCase()}`}>{method.toUpperCase()}</span>;
}

export function Endpoint({ method, path }: { method: string; path: string }) {
  return (
    <span className="docs-endpoint">
      <Method method={method} />
      <code>{path}</code>
    </span>
  );
}

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="docs-steps">{children}</ol>;
}

export function Step({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <li className="docs-step">
      <div className="docs-step-title">{title}</div>
      {children && <div className="docs-step-body">{children}</div>}
    </li>
  );
}

export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="docs-cards">{children}</div>;
}

export function Card({
  icon,
  title,
  children,
  to,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  to?: string;
  action?: ReactNode;
}) {
  return (
    <div className="docs-card">
      {icon && (
        <div className="docs-card-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="docs-card-title">{to ? <SmartLink href={to}>{title}</SmartLink> : title}</h3>
      {children && <div className="docs-card-body">{typeof children === "string" ? <Md text={children} /> : children}</div>}
      {action && <div className="docs-card-action">{action}</div>}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "new" | "warn" | "ok" }) {
  return <span className={`docs-badge docs-badge-${tone}`}>{children}</span>;
}

/** Página: título, entradilla y contenido. */
export function DocPage({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <>
      <header className="docs-page-head">
        <h1>{title}</h1>
        {lead && <Md text={lead} className="docs-lead" />}
      </header>
      {children}
    </>
  );
}
