// /developers/* — portal de documentación para integradores (público). Barra lateral, búsqueda, índice de la página y
// rutas propias por sección (/developers/<sección>), con anclas (#…) que se pueden compartir.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useI18n } from "../../lib/i18n";
import { useDocsText, type DocsT } from "../../lib/i18n-docs";
import { LocaleSwitcher, Logo, Spinner } from "../../components/ui";
import { ALL_PAGES, NAV, PAGE_ORDER, pageByPath } from "./nav";
import { groupByTag, useSpec, type TagEntry } from "./spec";
import { tagLabel } from "./reference/tags";
import { LangPrefProvider } from "./ui";
import { IntroPage } from "./content/Intro";
import { QuickstartPage } from "./content/Quickstart";
import { AuthPage } from "./content/Auth";
import { ConceptsPage } from "./content/Concepts";
import {
  AnchorsGuide,
  BrandingGuide,
  BulkGuide,
  CertificateGuide,
  CrmGuide,
  DomainGuide,
  EmbeddedGuide,
  IdentityGuide,
  PaymentsGuide,
  RemindersGuide,
  TemplatesGuide,
  WebFormsGuide,
} from "./content/Guides";
import { HrContractsGuide } from "./content/HrContracts";
import { WebhooksPage } from "./content/Webhooks";
import { ErrorsPage } from "./content/Errors";
import { SdksPage } from "./content/Sdks";
import { AiOverviewPage, ChatGptPage, ClaudePage, GeminiPage, McpPage, OfficePage } from "./content/Ai";
import "./docs.css";

const ReferenceOverview = lazy(() => import("./reference/Reference").then((m) => ({ default: m.ReferenceOverview })));
const ReferenceTag = lazy(() => import("./reference/Reference").then((m) => ({ default: m.ReferenceTag })));

const PAGES: Record<string, () => JSX.Element> = {
  "": IntroPage,
  quickstart: QuickstartPage,
  authentication: AuthPage,
  concepts: ConceptsPage,
  "guides/templates": TemplatesGuide,
  "guides/embedded-signing": EmbeddedGuide,
  "guides/anchors": AnchorsGuide,
  "guides/bulk-send": BulkGuide,
  "guides/web-forms": WebFormsGuide,
  "guides/reminders": RemindersGuide,
  "guides/certificate-signing": CertificateGuide,
  "guides/identity": IdentityGuide,
  "guides/payments": PaymentsGuide,
  "guides/crm": CrmGuide,
  "guides/hr-contracts": HrContractsGuide,
  "guides/custom-domain": DomainGuide,
  "guides/branding": BrandingGuide,
  webhooks: WebhooksPage,
  errors: ErrorsPage,
  sdks: SdksPage,
  ai: AiOverviewPage,
  "ai/mcp": McpPage,
  "ai/claude": ClaudePage,
  "ai/chatgpt": ChatGptPage,
  "ai/gemini": GeminiPage,
  "ai/office": OfficePage,
};

/** Anclas de la página vieja (una sola página larga) → secciones nuevas. */
const LEGACY_HASH: Record<string, string> = {
  mcp: "/developers/ai/mcp",
  oauth: "/developers/authentication#oauth",
  webhooks: "/developers/webhooks",
};

// ───────────────────────────── Tema ─────────────────────────────

type Theme = "auto" | "light" | "dark";
const THEME_KEY = "cs-docs-theme";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === "light" || v === "dark" ? v : "auto";
    } catch {
      return "auto";
    }
  });
  const set = useCallback((t: Theme) => {
    setTheme(t);
    try {
      if (t === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch {
      /* sin almacenamiento */
    }
  }, []);
  return [theme, set];
}

// ───────────────────────────── Búsqueda ─────────────────────────────

interface SearchItem {
  kind: "page" | "section" | "endpoint";
  title: string;
  context: string;
  to: string;
  haystack: string;
  method?: string;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function buildIndex(t: DocsT, tags: TagEntry[], locale: string): SearchItem[] {
  const items: SearchItem[] = [];
  for (const g of NAV) {
    for (const p of g.pages) {
      const to = `/developers${p.path ? `/${p.path}` : ""}`;
      const title = t(p.title);
      items.push({ kind: "page", title, context: t(g.title), to, haystack: norm(`${title} ${p.keywords ?? ""}`) });
      for (const h of p.headings) {
        const ht = t(h.key);
        items.push({ kind: "section", title: ht, context: title, to: `${to}#${h.id}`, haystack: norm(`${ht} ${title}`) });
      }
    }
  }
  for (const tag of tags) {
    const label = tagLabel(tag.name, locale);
    items.push({ kind: "page", title: label, context: t("nav.reference"), to: `/developers/api/${tag.slug}`, haystack: norm(`${label} ${tag.name}`) });
    for (const e of tag.ops) {
      items.push({
        kind: "endpoint",
        title: e.path,
        method: e.method,
        context: e.op.summary ?? label,
        to: `/developers/api/${tag.slug}#${e.anchor}`,
        haystack: norm(`${e.method} ${e.path} ${e.op.summary ?? ""} ${e.op.operationId ?? ""} ${label}`),
      });
    }
  }
  return items;
}

function search(items: SearchItem[], q: string): SearchItem[] {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { it: SearchItem; score: number }[] = [];
  for (const it of items) {
    if (!words.every((w) => it.haystack.includes(w))) continue;
    const title = norm(it.title);
    let score = it.kind === "page" ? 3 : it.kind === "section" ? 2 : 1;
    if (title.startsWith(words[0])) score += 3;
    if (title.includes(norm(q))) score += 2;
    scored.push({ it, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 12).map((x) => x.it);
}

function SearchBox({ tags, onNavigate, onFocus }: { tags: TagEntry[]; onNavigate: () => void; onFocus: () => void }) {
  const t = useDocsText();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const index = useMemo(() => buildIndex(t, tags, locale), [t, tags, locale]);
  const results = useMemo(() => search(index, q), [index, q]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (it: SearchItem) => {
    navigate(it.to);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
    onNavigate();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="docs-search" role="search">
      <label htmlFor="docs-search-input" className="sr-only">
        {t("ui.searchLabel")}
      </label>
      <input
        ref={inputRef}
        id="docs-search-input"
        type="search"
        autoComplete="off"
        placeholder={t("ui.searchPlaceholder")}
        value={q}
        role="combobox"
        aria-expanded={open && q.length > 0}
        aria-controls="docs-search-results"
        aria-activedescendant={open && results[active] ? `docs-sr-${active}` : undefined}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
          onFocus();
        }}
        onFocus={() => {
          setOpen(true);
          onFocus();
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      <kbd className="docs-kbd" aria-hidden="true">
        /
      </kbd>
      {open && q && (
        <ul id="docs-search-results" role="listbox" className="docs-search-results">
          {results.length === 0 ? (
            <li className="docs-search-empty" role="option" aria-selected={false}>
              {t("ui.searchEmpty", { q })}
            </li>
          ) : (
            results.map((it, i) => (
              <li
                key={`${it.kind}-${it.to}-${i}`}
                id={`docs-sr-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(it);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="docs-sr-title">
                  {it.method && <span className={`docs-method m-${it.method}`}>{it.method.toUpperCase()}</span>}
                  {it.kind === "endpoint" ? <code>{it.title}</code> : it.title}
                </span>
                <span className="docs-sr-context">{it.context}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────────── Índice de la página ─────────────────────────────

function useHeadings(container: RefObject<HTMLElement>, key: string) {
  const [items, setItems] = useState<{ id: string; text: string; level: number }[]>([]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const read = () => {
      const hs = [...el.querySelectorAll<HTMLElement>("h2[id], h3[id]")].filter((h) => !h.closest(".docs-card, .ref-index-tag"));
      const next = hs.map((h) => ({
        id: h.id,
        text: (h.childNodes[0]?.textContent ?? h.textContent ?? "").replace(/#$/, "").trim(),
        level: h.tagName === "H2" ? 2 : 3,
      }));
      // Cualquier cambio del DOM (copiar, cambiar de pestaña) dispara el observer: solo se actualiza si cambiaron los
      // títulos, así el índice no se vuelve a dibujar ni rearma su IntersectionObserver en cada mutación.
      setItems((prev) =>
        prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.text === next[i].text && p.level === next[i].level) ? prev : next,
      );
    };
    read();
    const mo = new MutationObserver(() => read());
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [container, key]);
  return items;
}

function useActiveHeading(ids: string[]) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!ids.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: "-70px 0px -65% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

function Toc({ items }: { items: { id: string; text: string; level: number }[] }) {
  const t = useDocsText();
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const active = useActiveHeading(ids);
  if (items.length < 2) return null;
  return (
    <nav className="docs-toc" aria-label={t("ui.onThisPage")}>
      <div className="docs-toc-title">{t("ui.onThisPage")}</div>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={`lvl-${i.level} ${active === i.id ? "active" : ""}`}>
            <a href={`#${i.id}`} aria-current={active === i.id ? "location" : undefined}>
              {i.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ───────────────────────────── Barra lateral ─────────────────────────────

function Sidebar({ tags, open, onClose }: { tags: TagEntry[]; open: boolean; onClose: () => void }) {
  const t = useDocsText();
  const { locale } = useI18n();
  const { pathname } = useLocation();
  const inApi = pathname.startsWith("/developers/api");
  const link = (path: string, label: string, end = false) => (
    <NavLink to={`/developers${path ? `/${path}` : ""}`} end={end} onClick={onClose}>
      {label}
    </NavLink>
  );
  const groups = NAV.map((g) => (
    <div key={g.title} className="docs-nav-group">
      <div className="docs-nav-title">{t(g.title)}</div>
      <ul>
        {g.pages.map((p) => (
          <li key={p.path}>{link(p.path, t(p.navTitle ?? p.title), p.path === "" || p.path === "ai")}</li>
        ))}
      </ul>
    </div>
  ));
  const reference = (
    <div key="ref" className="docs-nav-group">
      <div className="docs-nav-title">{t("nav.reference")}</div>
      <ul>
        <li>{link("api", t("ref.overview"), true)}</li>
        {inApi &&
          tags.map((tag) => (
            <li key={tag.slug} className="docs-nav-sub">
              {link(`api/${tag.slug}`, tagLabel(tag.name, locale))}
            </li>
          ))}
      </ul>
    </div>
  );
  // Referencia antes de "IA y agentes".
  const ordered = [...groups.slice(0, 3), reference, ...groups.slice(3)];
  return (
    <nav id="docs-sidebar" className={`docs-sidebar ${open ? "open" : ""}`} aria-label={t("ui.menu")}>
      <button type="button" className="docs-sidebar-close" onClick={onClose} aria-label={t("ui.closeMenu")}>
        ×
      </button>
      {ordered}
    </nav>
  );
}

// ───────────────────────────── Página ─────────────────────────────

function PrevNext({ path }: { path: string }) {
  const t = useDocsText();
  const i = PAGE_ORDER.indexOf(path);
  if (i < 0) return null;
  const prev = i > 0 ? pageByPath(PAGE_ORDER[i - 1]) : undefined;
  const next = i < PAGE_ORDER.length - 1 ? pageByPath(PAGE_ORDER[i + 1]) : undefined;
  const href = (p: string) => `/developers${p ? `/${p}` : ""}`;
  return (
    <nav className="docs-prevnext" aria-label={`${t("ui.prev")} / ${t("ui.next")}`}>
      {prev ? (
        <Link to={href(prev.path)} className="prev">
          <span className="muted small">← {t("ui.prev")}</span>
          <span>{t(prev.title)}</span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link to={href(next.path)} className="next">
          <span className="muted small">{t("ui.next")} →</span>
          <span>{t(next.title)}</span>
        </Link>
      )}
    </nav>
  );
}

function NotFound() {
  const t = useDocsText();
  return (
    <div className="docs-page-head">
      <h1>404</h1>
      <p>{t("ui.notFound")}</p>
      <Link to="/developers">{t("ui.backHome")}</Link>
    </div>
  );
}

/** Desplaza a la ancla (#id) al cambiar de ruta; si no hay ancla, al principio. Reintenta mientras carga contenido. */
function useScrollToHash() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) {
      window.scrollTo(0, 0);
      return;
    }
    const id = decodeURIComponent(hash.slice(1));
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
      if (++tries < 40) timer = window.setTimeout(attempt, 100);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [pathname, hash]);
}

export function DevelopersPage() {
  const t = useDocsText();
  const { locale } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const sub = location.pathname.replace(/^\/developers\/?/, "").replace(/\/$/, "");
  const inApi = sub === "api" || sub.startsWith("api/");
  const [wantSpec, setWantSpec] = useState(inApi);
  useEffect(() => {
    if (inApi) setWantSpec(true);
  }, [inApi]);
  const { spec } = useSpec(wantSpec);
  const tags = useMemo(() => (spec ? groupByTag(spec) : []), [spec]);
  const headings = useHeadings(mainRef, `${location.pathname}|${locale}`);
  useScrollToHash();

  // Enlaces viejos: /developers#mcp → /developers/ai/mcp
  useEffect(() => {
    if (sub === "" && location.hash && LEGACY_HASH[location.hash.slice(1)]) navigate(LEGACY_HASH[location.hash.slice(1)], { replace: true });
  }, [sub, location.hash, navigate]);

  // Al salir del portal (p. ej. "Obtener API key" → /app) se devuelve el título que tenía la app.
  useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);

  useEffect(() => {
    const page = pageByPath(sub);
    document.title = `${page ? t(page.title) : inApi ? t("nav.reference") : t("intro.title")} · CalaSign Docs`;
  }, [sub, inApi, t]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const nextTheme: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
  const themeIcon =
    theme === "dark" ? (
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    ) : theme === "light" ? (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ) : (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
      </>
    );
  const themeName = theme === "dark" ? t("ui.themeDark") : theme === "light" ? t("ui.themeLight") : t("ui.themeAuto");

  return (
    <LangPrefProvider>
      <div className="docs" data-theme={theme === "auto" ? undefined : theme}>
        <a className="docs-skip" href="#docs-main">
          {t("ui.skip")}
        </a>
        <header className="docs-topbar">
          <button
            type="button"
            className="docs-menu-btn"
            aria-label={t("ui.menu")}
            aria-expanded={menuOpen}
            aria-controls="docs-sidebar"
            onClick={() => setMenuOpen((o) => !o)}
          >
            ☰
          </button>
          <Link to="/developers" className="docs-brand">
            <Logo light />
            <span className="docs-brand-tag">{t("ui.docs")}</span>
          </Link>
          <SearchBox tags={tags} onNavigate={() => setMenuOpen(false)} onFocus={() => setWantSpec(true)} />
          <div className="docs-top-actions">
            <a href="/v1/openapi.json" target="_blank" rel="noopener" className="docs-top-link hide-sm">
              openapi.json
            </a>
            <Link to="/app/settings/api-keys" className="docs-top-link hide-sm">
              {t("ui.getKey")}
            </Link>
            <button
              type="button"
              className="docs-theme-btn"
              onClick={() => setTheme(nextTheme[theme])}
              aria-label={`${t("ui.theme")}: ${themeName}`}
              title={`${t("ui.theme")}: ${themeName}`}
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                {themeIcon}
              </svg>
            </button>
            <LocaleSwitcher compact />
          </div>
        </header>
        <div className="docs-layout">
          {menuOpen && <div className="docs-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
          <Sidebar tags={tags} open={menuOpen} onClose={() => setMenuOpen(false)} />
          <main id="docs-main" ref={mainRef} className="docs-main" tabIndex={-1}>
            <article className={`docs-article ${inApi ? "wide" : ""}`}>
              <Suspense fallback={<Spinner />}>
                <Routes>
                  {ALL_PAGES.map((p) => {
                    const C = PAGES[p.path];
                    return p.path === "" ? <Route key="index" index element={<C />} /> : <Route key={p.path} path={p.path} element={<C />} />;
                  })}
                  <Route path="api" element={<ReferenceOverview />} />
                  <Route path="api/:tag" element={<ReferenceTag />} />
                  <Route path="reference" element={<Navigate to="/developers/api" replace />} />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
              <PrevNext path={sub} />
            </article>
            <Toc items={headings} />
          </main>
        </div>
      </div>
    </LangPrefProvider>
  );
}

export default DevelopersPage;
