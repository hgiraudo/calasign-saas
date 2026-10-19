// Marca y marca blanca: tema, textos, correos/SMS, dominios y CSS propio, por marca (la de la organización y sus
// sub-marcas), con vista previa en vivo de la página de firma y de cada correo. API: /v1/settings/brands.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BRAND_MESSAGE_EVENTS,
  BRAND_TEMPLATE_VARIABLES,
  contrastText,
  customCssProblem,
  LOCALES,
  themeToCss,
  type Brand,
  type BrandAssetKind,
  type BrandConfigInput,
  type BrandEmailPreview,
  type BrandList,
  type BrandMessageEvent,
  type BrandDomain,
  type EmailDomain,
  type Locale,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAccess } from "../lib/access";
import { confirmAction, LOCALE_LABELS, useI18n } from "../lib/i18n";
import { useWlText, type WlKey } from "../lib/i18n-white-label";
import { ErrorBox, Spinner } from "../components/ui";

type Tab = "theme" | "texts" | "email" | "domains" | "advanced";
type Theme = NonNullable<BrandConfigInput["theme"]>;
const COLOR_KEYS = ["primaryColor", "secondaryColor", "backgroundColor", "textColor", "buttonColor", "buttonTextColor", "headerTextColor"] as const;
const LINK_KEYS = ["websiteUrl", "supportUrl", "privacyUrl", "termsUrl"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** Claves de texto frecuentes de la página de firma (para el autocompletado). */
const COMMON_TEXT_KEYS = [
  "sign.poweredBy",
  "sign.doneTitle",
  "sign.doneText",
  "sign.doneAvailable",
  "sign.consentTitle",
  "sign.consentText",
  "sign.finish",
  "sign.decline",
  "sign.invalidTitle",
  "sign.invalidText",
  "sign.sentBy",
  "otp.title",
  "otp.text",
  "approve.doneTitle",
];

/** "" → null y sin plantillas/textos vacíos: lo que acepta PUT /v1/settings/brands/:id. */
function clean(c: BrandConfigInput): BrandConfigInput {
  const nul = <T extends Record<string, unknown>>(o: T | undefined): T | undefined =>
    o ? (Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === "" ? null : v])) as T) : undefined;
  const templates: Record<string, Record<string, unknown>> = {};
  for (const [ev, byLoc] of Object.entries(c.templates ?? {})) {
    for (const [l, tpl] of Object.entries(byLoc ?? {})) {
      const x = nul(tpl as Record<string, unknown>);
      if (x && Object.values(x).some((v) => v)) templates[ev] = { ...(templates[ev] ?? {}), [l]: x };
    }
  }
  const texts: Record<string, Record<string, string>> = {};
  for (const [l, m] of Object.entries(c.texts ?? {})) {
    const e = Object.entries(m ?? {}).filter(([k, v]) => k.trim() && v.trim());
    if (e.length) texts[l] = Object.fromEntries(e.map(([k, v]) => [k.trim(), v]));
  }
  return {
    displayName: c.displayName || null,
    productName: c.productName || null,
    // Sin definir: una sub-marca hereda "ocultar Powered by" de la marca de la organización (mandar false siempre la
    // volvía a mostrar en cuanto se guardaba cualquier cambio de la sub-marca).
    ...(c.hidePoweredBy === undefined ? {} : { hidePoweredBy: Boolean(c.hidePoweredBy) }),
    theme: nul(c.theme),
    customCss: c.customCss?.trim() ? c.customCss : null,
    links: nul(c.links),
    email: nul(c.email),
    templates: templates as BrandConfigInput["templates"],
    texts: texts as BrandConfigInput["texts"],
    sms: nul(c.sms),
  };
}

/** HTML de la vista previa de la página de firma (iframe sin scripts). */
function signerMockHtml(o: { css: string; fontCssUrl: string | null; name: string; logo: string | null; powered: string | null; w: (k: WlKey) => string; theme: Theme }) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const bar = o.theme.primaryColor && HEX.test(o.theme.primaryColor) ? o.theme.primaryColor : "#0b1f3a";
  return `<!doctype html><html><head><meta charset="utf-8">${o.fontCssUrl ? `<link rel="stylesheet" href="${esc(o.fontCssUrl)}">` : ""}<style>
:root{--navy:#0b1f3a;--teal:#14b8a6;--teal-dark:#0d9488;--bg:#eef1f6;--text:#0f172a;--radius:10px;--font:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
body{margin:0;font-family:var(--font);color:var(--text);background:var(--bg);font-size:14px}
.signer{min-height:100vh;display:flex;flex-direction:column;background:var(--bg)}
.signer-bar{background:var(--navy);color:${contrastText(bar)};padding:10px 14px;min-height:44px;display:flex;align-items:center;font-weight:600}
.signer-bar img{max-height:30px;max-width:150px}
main{padding:14px;flex:1}.card{background:#fff;border-radius:var(--radius);padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.muted{color:#64748b;font-size:12px}a{color:var(--teal-dark)}
.doc{height:90px;margin:10px 0;border:1px solid #e2e8f0;border-radius:6px;background:repeating-linear-gradient(180deg,#eef2f7 0 8px,#fff 8px 18px)}
.progress{height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;margin:8px 0}.progress i{display:block;width:60%;height:100%;background:var(--teal)}
.btn{display:inline-block;padding:8px 16px;border-radius:8px;border:1px solid #e2e8f0;font-weight:600;background:#fff}
.btn-primary{background:var(--navy);border-color:var(--navy);color:#fff}
.signer-foot{text-align:center;padding:10px;color:#64748b;font-size:12px}
</style><style>${o.css.replace(/<\//g, "<\\/")}</style></head><body><div class="signer">
<div class="signer-bar">${o.logo ? `<img src="${esc(o.logo)}" alt="">` : esc(o.name)}</div>
<main><div class="card"><p class="muted"><b>${esc(o.w("mock.sender"))}</b> (${esc(o.name)}) ${esc(o.w("mock.sentBy"))}</p><h3 style="margin:4px 0">${esc(o.w("mock.subject"))}</h3>
<div class="progress"><i></i></div><div class="doc"></div><a href="#">${esc(o.w("mock.view"))}</a><p style="margin-top:12px"><span class="btn btn-primary">✍ ${esc(o.w("mock.sign"))}</span> <span class="btn">${esc(o.w("mock.finish"))}</span></p></div></main>
${o.powered ? `<div class="signer-foot">${esc(o.powered)}</div>` : ""}</div></body></html>`;
}

export function BrandingPage() {
  const { t } = useI18n();
  const w = useWlText();
  const { me, refresh } = useAuth();
  const { refresh: refreshAccess } = useAccess();
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [sel, setSel] = useState("default");
  const [tab, setTab] = useState<Tab>("theme");
  const [cfg, setCfg] = useState<BrandConfigInput>({});
  const [name, setName] = useState("");
  const [orgName, setOrgName] = useState(me?.tenant.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Cambios sin guardar en la configuración o el nombre de la marca (si no hay, Guardar no hace el PUT).
  const [dirty, setDirty] = useState(false);
  const [newName, setNewName] = useState("");

  const brand = brands?.find((b) => b.id === sel) ?? null;

  const load = useCallback(async (select?: string) => {
    const r = await api<BrandList>("/v1/settings/brands");
    setBrands(r.items);
    const id = select ?? sel;
    const b = r.items.find((x) => x.id === id) ?? r.items[0];
    setSel(b.id);
    setCfg(b.config ?? {});
    setName(b.name);
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load]);
  useEffect(() => {
    if (me?.tenant.name) setOrgName(me.tenant.name);
  }, [me?.tenant.name]);

  const pick = (id: string) => {
    const b = brands?.find((x) => x.id === id);
    if (!b) return;
    setSel(id);
    setCfg(b.config ?? {});
    setName(b.name);
    setSaved(false);
    setDirty(false);
  };
  const replaceBrand = (b: Brand) => setBrands((list) => (list ?? []).map((x) => (x.id === b.id ? b : x)));

  const set = <K extends keyof BrandConfigInput>(k: K, v: BrandConfigInput[K]) => {
    setCfg((c) => ({ ...c, [k]: v }));
    setSaved(false);
    setDirty(true);
  };
  const setIn = <K extends "theme" | "links" | "email" | "sms">(k: K, field: string, v: unknown) =>
    set(k, { ...((cfg[k] as Record<string, unknown>) ?? {}), [field]: v } as BrandConfigInput[K]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      // El nombre de la organización va primero y por su cuenta: PATCH /v1/settings/branding no exige el plan con
      // marca propia (PUT /v1/settings/brands sí), así que en Free renombrar no puede depender de guardar la marca.
      // Con menos de 2 caracteres el servidor responde el error (antes se ignoraba y se mostraba "Guardado").
      const n = orgName.trim();
      if (sel === "default" && n !== me?.tenant.name) {
        await api("/v1/settings/branding", { method: "PATCH", body: { organizationName: n } });
        await Promise.all([refresh(), refreshAccess()]);
        // El nombre de la marca por defecto es el de la organización (selector de marcas).
        setBrands((list) => (list ?? []).map((x) => (x.isDefault ? { ...x, name: n } : x)));
      }
      if (dirty) {
        const b = await api<Brand>(`/v1/settings/brands/${sel}`, { method: "PUT", body: { config: clean(cfg), ...(sel !== "default" && name.trim() ? { name: name.trim() } : {}) } });
        replaceBrand(b);
        setCfg(b.config);
        setDirty(false);
      }
      setSaved(true);
    });

  const create = () =>
    run(async () => {
      const b = await api<Brand>("/v1/settings/brands", { method: "POST", body: { name: newName.trim() } });
      setNewName("");
      await load(b.id);
    });

  const remove = () => {
    if (sel === "default" || !confirmAction()) return;
    run(async () => {
      await api(`/v1/settings/brands/${sel}`, { method: "DELETE" });
      await load("default");
    });
  };

  const upload = (kind: BrandAssetKind, file: File) =>
    run(async () => {
      const form = new FormData();
      form.append("file", file, file.name);
      replaceBrand(await api<Brand>(`/v1/settings/brands/${sel}/assets/${kind}`, { method: "POST", form }));
    });
  const removeAsset = (kind: BrandAssetKind) =>
    run(async () => {
      replaceBrand(await api<Brand>(`/v1/settings/brands/${sel}/assets/${kind}`, { method: "DELETE" }));
    });

  // ───────── Vista previa en vivo ─────────
  const theme = (cfg.theme ?? {}) as Theme;
  const cssProblem = cfg.customCss ? customCssProblem(cfg.customCss) : null;
  // Lo que una sub-marca no define lo hereda de la marca de la organización (como mergeConfig en el servidor).
  const defaultBrand = brand && !brand.isDefault ? brands?.find((b) => b.isDefault) : undefined;
  const inherited = defaultBrand?.config;
  const effectiveTheme = useMemo(() => {
    // Lo heredado + lo que se está editando. En una sub-marca la base es el tema de la organización: su `effective`
    // ya trae los colores propios guardados, y uno borrado (para heredar) seguía en la vista previa hasta guardar.
    // La marca de la organización no hereda nada: su `effective` es lo guardado (un color borrado seguía a la vista);
    // solo se toma la fuente que el servidor deduce cuando no se eligió.
    const base = defaultBrand ? defaultBrand.effective.theme : { fontSource: brand?.effective.theme.fontSource ?? null };
    const own = Object.fromEntries(Object.entries(theme).filter(([, v]) => v !== null && v !== undefined && v !== ""));
    return { ...base, ...own } as Theme;
  }, [brand, defaultBrand, theme]);
  const hidePowered = cfg.hidePoweredBy ?? inherited?.hidePoweredBy ?? false;
  const product = cfg.productName || inherited?.productName || "CalaSign";
  const inheritedCss = inherited?.customCss ?? "";
  const inheritedName = inherited?.displayName ?? "";
  const mockHtml = useMemo(() => {
    if (!brand) return "";
    const fontFace =
      effectiveTheme.fontSource === "upload" && brand.effective.fontUrl && effectiveTheme.fontFamily
        ? `@font-face{font-family:"${effectiveTheme.fontFamily}";src:url("${brand.effective.fontUrl}")}`
        : null;
    // Una sub-marca suma su CSS al de la organización (mergeConfig los concatena).
    const css = [themeToCss(effectiveTheme as never, { fontFace }), inheritedCss, cssProblem ? "" : cfg.customCss ?? ""].join("\n");
    const google =
      effectiveTheme.fontFamily && (effectiveTheme.fontSource === "google" || (!effectiveTheme.fontSource && !brand.effective.fontUrl))
        ? `https://fonts.googleapis.com/css2?family=${encodeURIComponent(effectiveTheme.fontFamily).replace(/%20/g, "+")}:wght@400;600;700&display=swap`
        : null;
    return signerMockHtml({
      css,
      fontCssUrl: google,
      // Sin nombre visible propio: el heredado o el de la marca (brand.effective.name traía el guardado aunque se borrara).
      name: cfg.displayName || inheritedName || brand.name,
      logo: brand.effective.logoUrl,
      powered: hidePowered ? null : `${w("mock.powered")} ${product}`,
      w,
      theme: effectiveTheme,
    });
  }, [brand, effectiveTheme, cfg.customCss, cfg.displayName, inheritedCss, inheritedName, hidePowered, cssProblem, product, w]);

  if (!brands || !brand) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{w("title")}</h1>
          <p className="muted">{w("intro")}</p>
        </div>
      </div>
      <ErrorBox error={error} />

      <div className="card pad row-wrap" style={{ marginBottom: "1rem" }}>
        <label className="field" style={{ minWidth: 240 }}>
          <span>{w("brand")}</span>
          <select id="brand-select" value={sel} onChange={(e) => pick(e.target.value)}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.isDefault ? `${b.name} — ${w("brand.default")}` : b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{w("brand.newName")}</span>
          <div className="row-wrap">
            <input value={newName} maxLength={120} onChange={(e) => setNewName(e.target.value)} />
            <button type="button" className="btn btn-sm" disabled={busy || newName.trim().length < 2} onClick={create}>
              + {w("brand.create")}
            </button>
          </div>
        </label>
      </div>
      {!brand.isDefault && <p className="muted small">{w("brand.subHint")}</p>}
      <p className="muted small">
        <code>{w("brand.apiHint", { id: brand.id })}</code>
      </p>

      <div className="tabs" role="tablist" style={{ margin: "0.75rem 0" }}>
        {(["theme", "texts", "email", "domains", "advanced"] as Tab[]).map((x) => (
          <button key={x} type="button" role="tab" aria-selected={tab === x} className={`tab ${tab === x ? "active" : ""}`} onClick={() => setTab(x)}>
            {w(`tab.${x}` as WlKey)}
          </button>
        ))}
      </div>

      <div className="brand-layout">
        <div className="card pad stack">
          {tab === "theme" && (
            <>
              {brand.isDefault ? (
                <Field label={w("orgName")}>
                  <input
                    value={orgName}
                    maxLength={120}
                    onChange={(e) => {
                      setOrgName(e.target.value);
                      setSaved(false);
                    }}
                  />
                </Field>
              ) : (
                <Field label={w("brand")}>
                  <input
                    value={name}
                    maxLength={120}
                    onChange={(e) => {
                      setName(e.target.value);
                      setSaved(false);
                      setDirty(true);
                    }}
                  />
                </Field>
              )}
              <Field label={w("displayName")} hint={w("displayNameHint")}>
                <input value={cfg.displayName ?? ""} maxLength={120} onChange={(e) => set("displayName", e.target.value)} />
              </Field>
              <Field label={w("productName")} hint={w("productNameHint")}>
                <input id="wl-product" value={cfg.productName ?? ""} maxLength={60} onChange={(e) => set("productName", e.target.value)} />
              </Field>
              <label className="row-wrap">
                <input id="wl-hide" type="checkbox" checked={hidePowered} onChange={(e) => set("hidePoweredBy", e.target.checked)} />
                <span>{w("hidePoweredBy")}</span>
              </label>

              <h3>{w("colors")}</h3>
              <div className="grid-2">
                {COLOR_KEYS.map((k) => {
                  const v = (theme[k] as string | null | undefined) ?? "";
                  return (
                    <Field key={k} label={w(`color.${k}` as WlKey)}>
                      <div className="row-wrap">
                        <input type="color" className="color-input" value={HEX.test(v) ? v : ((defaultBrand?.effective.theme[k] as string | null | undefined) ?? "#ffffff")} onChange={(e) => setIn("theme", k, e.target.value)} aria-label={w(`color.${k}` as WlKey)} />
                        <input className="color-text" value={v} placeholder="#RRGGBB" maxLength={7} onChange={(e) => setIn("theme", k, e.target.value.trim())} />
                      </div>
                    </Field>
                  );
                })}
              </div>
              <Field label={`${w("radius")}: ${theme.borderRadius ?? "—"} px`}>
                <input type="range" min={0} max={24} value={effectiveTheme.borderRadius ?? 10} onChange={(e) => setIn("theme", "borderRadius", Number(e.target.value))} />
              </Field>

              <h3>{w("font")}</h3>
              <div className="row-wrap">
                <select value={theme.fontSource ?? "system"} onChange={(e) => setIn("theme", "fontSource", e.target.value)}>
                  <option value="system">{w("font.system")}</option>
                  <option value="google">{w("font.google")}</option>
                  <option value="upload">{w("font.upload")}</option>
                </select>
                {theme.fontSource && theme.fontSource !== "system" && (
                  <input placeholder={w("font.family")} value={theme.fontFamily ?? ""} maxLength={60} onChange={(e) => setIn("theme", "fontFamily", e.target.value)} />
                )}
              </div>
              {theme.fontSource === "google" && <small className="muted">{w("font.googleNote")}</small>}
              {theme.fontSource === "upload" && <Asset label={w("asset.font")} kind="font" url={brand.assets.fontUrl} accept=".woff2,.woff,.ttf,.otf" onUpload={upload} onRemove={removeAsset} busy={busy} />}

              <h3>{w("assets")}</h3>
              <Asset label={w("asset.logo")} kind="logo" url={brand.assets.logoUrl} accept="image/png,image/jpeg,image/svg+xml" onUpload={upload} onRemove={removeAsset} busy={busy} />
              <Asset label={w("asset.logoDark")} kind="logoDark" url={brand.assets.logoDarkUrl} dark accept="image/png,image/jpeg,image/svg+xml" onUpload={upload} onRemove={removeAsset} busy={busy} />
              <Asset label={w("asset.favicon")} kind="favicon" url={brand.assets.faviconUrl} accept="image/png,image/svg+xml,image/x-icon,.ico" onUpload={upload} onRemove={removeAsset} busy={busy} />

              <h3>{w("links")}</h3>
              <div className="grid-2">
                {LINK_KEYS.map((k) => (
                  <Field key={k} label={w(`link.${k}` as WlKey)}>
                    <input type="url" placeholder="https://" value={(cfg.links?.[k] as string | null | undefined) ?? ""} onChange={(e) => setIn("links", k, e.target.value.trim())} />
                  </Field>
                ))}
              </div>
            </>
          )}

          {tab === "texts" && <TextsEditor cfg={cfg} onChange={(v) => set("texts", v)} />}

          {tab === "email" && <EmailEditor brand={brand} cfg={cfg} set={set} setIn={setIn} />}

          {tab === "domains" && <DomainsEditor key={brand.id} brand={brand} onBrand={replaceBrand} />}

          {tab === "advanced" && (
            <>
              <Field label={w("css")} hint={w("css.hint")}>
                <textarea rows={12} className="mono" value={cfg.customCss ?? ""} maxLength={20000} onChange={(e) => set("customCss", e.target.value)} spellCheck={false} />
              </Field>
              {cssProblem && <p className="small error-text">{cssProblem}</p>}
              {!brand.isDefault && (
                <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={remove}>
                  {w("brand.delete")}
                </button>
              )}
            </>
          )}

          {tab !== "domains" && (
            <div className="row-wrap">
              <button id="wl-save" type="button" className="btn btn-primary" disabled={busy || Boolean(cssProblem)} onClick={save}>
                {busy ? t("common.saving") : t("common.save")}
              </button>
              {saved && <span className="muted small">✓ {w("saved")}</span>}
            </div>
          )}
        </div>

        <div className="stack">
          <h3>{w("preview.signer")}</h3>
          <iframe title={w("preview.signer")} className="card" style={{ width: "100%", height: 380, border: 0 }} sandbox="" srcDoc={mockHtml} />
          {tab === "email" && <EmailPreview brandId={sel} cfg={cfg} />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function Asset(p: { label: string; kind: BrandAssetKind; url: string | null; accept: string; dark?: boolean; busy: boolean; onUpload: (k: BrandAssetKind, f: File) => void; onRemove: (k: BrandAssetKind) => void }) {
  const w = useWlText();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <span>{p.label}</span>
      <div className="row-wrap">
        {p.url && p.kind !== "font" ? <img className="logo-thumb" src={p.url} alt="" style={p.dark ? { background: "#0b1f3a" } : undefined} /> : p.url ? <span className="small">✓</span> : <span className="muted small">—</span>}
        <label className="btn btn-sm">
          {w("asset.upload")}
          <input
            ref={ref}
            type="file"
            hidden
            accept={p.accept}
            disabled={p.busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onUpload(p.kind, f);
              if (ref.current) ref.current.value = "";
            }}
          />
        </label>
        {p.url && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={p.busy} onClick={() => p.onRemove(p.kind)}>
            {w("asset.remove")}
          </button>
        )}
      </div>
    </div>
  );
}

function TextsEditor({ cfg, onChange }: { cfg: BrandConfigInput; onChange: (v: BrandConfigInput["texts"]) => void }) {
  const w = useWlText();
  const { locale: uiLocale } = useI18n();
  const [locale, setLocale] = useState<Locale>(uiLocale);
  const rows = Object.entries(cfg.texts?.[locale] ?? {});
  const update = (next: [string, string][]) => onChange({ ...(cfg.texts ?? {}), [locale]: Object.fromEntries(next) });
  // Las filas se guardan como objeto: una clave repetida fusionaba dos filas (la nueva pisaba el texto de la otra y
  // desaparecía; "+ Agregar" con una fila sin clave no hacía nada). No se acepta una clave que ya usa otra fila.
  const setKey = (i: number, k: string) => {
    if (rows.some(([x], j) => j !== i && x === k)) return;
    update(rows.map((r, j) => (j === i ? [k, r[1]] : r)));
  };
  const hasBlank = rows.some(([k]) => k === "");
  return (
    <>
      <p className="muted small">{w("texts.intro")}</p>
      <Field label={w("locale")}>
        <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </select>
      </Field>
      <datalist id="wl-text-keys">
        {COMMON_TEXT_KEYS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {rows.map(([k, v], i) => (
        <div key={i} className="row-wrap">
          <input list="wl-text-keys" aria-label={w("texts.key")} placeholder={w("texts.key")} value={k} maxLength={80} onChange={(e) => setKey(i, e.target.value)} />
          <input className="grow" aria-label={w("texts.value")} placeholder={w("texts.value")} value={v} maxLength={1000} onChange={(e) => update(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          <button type="button" className="btn btn-ghost btn-sm" aria-label="✕" onClick={() => update(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" disabled={hasBlank} onClick={() => update([...rows, ["", ""]])}>
        + {w("texts.add")}
      </button>
    </>
  );
}

function EmailEditor(p: {
  brand: Brand;
  cfg: BrandConfigInput;
  set: <K extends keyof BrandConfigInput>(k: K, v: BrandConfigInput[K]) => void;
  setIn: (k: "email" | "sms", field: string, v: unknown) => void;
}) {
  const w = useWlText();
  const { locale: uiLocale } = useI18n();
  const [event, setEvent] = useState<BrandMessageEvent>("invite");
  const [locale, setLocale] = useState<Locale>(uiLocale);
  const tpl = p.cfg.templates?.[event]?.[locale] ?? {};
  const setTpl = (field: "subject" | "body" | "cta", v: string) =>
    p.set("templates", { ...(p.cfg.templates ?? {}), [event]: { ...(p.cfg.templates?.[event] ?? {}), [locale]: { ...tpl, [field]: v } } } as BrandConfigInput["templates"]);
  return (
    <>
      <h3>{w("email.sender")}</h3>
      <div className="grid-2">
        <Field label={w("email.fromName")}>
          <input value={p.cfg.email?.fromName ?? ""} maxLength={100} onChange={(e) => p.setIn("email", "fromName", e.target.value)} />
        </Field>
        <Field label={w("email.fromEmail")} hint={w("email.fromEmailHint")}>
          <input type="email" value={p.cfg.email?.fromEmail ?? ""} onChange={(e) => p.setIn("email", "fromEmail", e.target.value.trim())} />
        </Field>
        <Field label={w("email.replyTo")}>
          <input type="email" value={p.cfg.email?.replyTo ?? ""} onChange={(e) => p.setIn("email", "replyTo", e.target.value.trim())} />
        </Field>
        <Field label={w("sms.senderId")}>
          <input value={p.cfg.sms?.senderId ?? ""} maxLength={11} onChange={(e) => p.setIn("sms", "senderId", e.target.value)} />
        </Field>
      </div>
      <p className="small">
        {w("email.effective")}: <code>{p.brand.emailSender.from}</code>
      </p>
      {p.brand.emailSender.warning && <p className="small error-text">{p.brand.emailSender.warning}</p>}
      <Field label={w("email.footer")}>
        <textarea rows={2} maxLength={1000} value={p.cfg.email?.footer ?? ""} onChange={(e) => p.setIn("email", "footer", e.target.value)} />
      </Field>

      <h3>{w("email.templates")}</h3>
      <div className="row-wrap">
        <select aria-label={w("email.event")} value={event} onChange={(e) => setEvent(e.target.value as BrandMessageEvent)}>
          {BRAND_MESSAGE_EVENTS.map((ev) => (
            <option key={ev} value={ev}>
              {w(`event.${ev}` as WlKey)}
            </option>
          ))}
        </select>
        <select aria-label={w("locale")} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </select>
      </div>
      <Field label={w("email.subject")} hint={w("email.emptyDefault")}>
        <input value={tpl.subject ?? ""} maxLength={300} onChange={(e) => setTpl("subject", e.target.value)} />
      </Field>
      <Field label={w("email.body")} hint={w("email.emptyDefault")}>
        <textarea rows={7} maxLength={10000} value={tpl.body ?? ""} onChange={(e) => setTpl("body", e.target.value)} />
      </Field>
      {event !== "otp_code" && (
        <Field label={w("email.cta")}>
          <input value={tpl.cta ?? ""} maxLength={60} onChange={(e) => setTpl("cta", e.target.value)} />
        </Field>
      )}
      <p className="muted small">
        {w("email.vars")}:{" "}
        {BRAND_TEMPLATE_VARIABLES.map((v) => (
          <code key={v} style={{ marginRight: 6 }}>{`{{${v}}}`}</code>
        ))}
      </p>
      {/* El evento y el idioma elegidos los usa la vista previa del correo (columna derecha). */}
      <EmailPreviewTarget event={event} locale={locale} />
    </>
  );
}

// La vista previa del correo vive en la columna derecha: se comparte el evento/idioma elegidos por un pequeño store.
let previewTarget = { event: "invite" as BrandMessageEvent, locale: "es" as Locale };
const previewListeners = new Set<() => void>();
function EmailPreviewTarget({ event, locale }: { event: BrandMessageEvent; locale: Locale }) {
  useEffect(() => {
    previewTarget = { event, locale };
    previewListeners.forEach((l) => l());
  }, [event, locale]);
  return null;
}

function EmailPreview({ brandId, cfg }: { brandId: string; cfg: BrandConfigInput }) {
  const w = useWlText();
  const [target, setTarget] = useState(previewTarget);
  const [prev, setPrev] = useState<BrandEmailPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const l = () => setTarget({ ...previewTarget });
    previewListeners.add(l);
    // El efecto de EmailPreviewTarget (columna izquierda) corre antes que este y avisa cuando todavía no hay oyente:
    // sin esta lectura la vista previa quedaba con el evento/idioma anteriores (p. ej. "es" con la web en inglés).
    l();
    return () => void previewListeners.delete(l);
  }, []);
  const body = JSON.stringify(clean(cfg));
  useEffect(() => {
    // Con una pausa: no se pide una vista previa por cada tecla.
    // Solo vale la respuesta del último pedido: una más lenta de un pedido anterior dejaba la vista previa vieja.
    let stale = false;
    const id = window.setTimeout(() => {
      api<BrandEmailPreview>(`/v1/settings/brands/${brandId}/preview`, { method: "POST", body: { kind: "email", event: target.event, locale: target.locale, config: JSON.parse(body) } })
        .then((p) => {
          if (stale) return;
          setPrev(p);
          setError(null);
        })
        .catch((e) => !stale && setError(errorText(e)));
    }, 500);
    return () => {
      stale = true;
      window.clearTimeout(id);
    };
  }, [brandId, body, target]);
  return (
    <div className="stack">
      <h3>{w("email.preview")}</h3>
      <ErrorBox error={error} />
      {prev && (
        <>
          <p className="small">
            <b>{prev.from}</b>
            <br />
            {prev.subject}
          </p>
          <iframe title={w("email.preview")} className="card" style={{ width: "100%", height: 460, border: 0 }} sandbox="" srcDoc={prev.html} />
        </>
      )}
    </div>
  );
}

function DomainsEditor({ brand, onBrand }: { brand: Brand; onBrand: (b: Brand) => void }) {
  const w = useWlText();
  const [mail, setMail] = useState<EmailDomain[] | null>(null);
  const [newMail, setNewMail] = useState("");
  const [web, setWeb] = useState(brand.domain?.domain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => api<{ items: EmailDomain[] }>("/v1/settings/email-domains").then((r) => setMail(r.items)), []);
  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
  }, [reload]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const refreshBrand = async () => onBrand(await api<Brand>(`/v1/settings/brands/${brand.id}`));
  const d: BrandDomain | null = brand.domain;
  return (
    <>
      <ErrorBox error={error} />
      <h3>{w("domains.web")}</h3>
      {brand.isDefault ? (
        <p className="muted small">
          <a href="/app/settings/domain">{w("domains.webDefault")}</a>
        </p>
      ) : (
        <>
          <div className="row-wrap">
            <input placeholder="firmas.cliente.com" value={web} onChange={(e) => setWeb(e.target.value.trim().toLowerCase())} />
            <button type="button" className="btn btn-sm" disabled={busy || !web} onClick={() => run(async () => (await api(`/v1/settings/brands/${brand.id}/domain`, { method: "PUT", body: { domain: web } }), refreshBrand()))}>
              {w("domains.add")}
            </button>
          </div>
          {d && (
            <div className="card pad small stack">
              <p>
                <b>{d.domain}</b> — {d.status === "verified" ? `✓ ${w("domains.verified")}` : w("domains.pending")}
              </p>
              <p className="muted">{w("domains.webHint", { target: d.cnameTarget })}</p>
              <code className="break">TXT {d.txtName} = {d.txtValue}</code>
              <code className="break">CNAME {d.domain} → {d.cnameTarget}</code>
              {d.lastError && <p className="error-text">{d.lastError}</p>}
              <div className="row-wrap">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(async () => (await api(`/v1/settings/brands/${brand.id}/domain/verify`, { method: "POST" }), refreshBrand()))}>
                  {w("domains.verify")}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => (await api(`/v1/settings/brands/${brand.id}/domain`, { method: "DELETE" }), refreshBrand()))}>
                  {w("domains.remove")}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <h3>{w("domains.mail")}</h3>
      <p className="muted small">{w("domains.mailHint")}</p>
      <div className="row-wrap">
        <input placeholder="cliente.com" value={newMail} onChange={(e) => setNewMail(e.target.value.trim().toLowerCase())} />
        <button type="button" className="btn btn-sm" disabled={busy || !newMail} onClick={() => run(async () => (await api("/v1/settings/email-domains", { method: "POST", body: { domain: newMail } }), setNewMail(""), reload()))}>
          {w("domains.add")}
        </button>
      </div>
      {(mail ?? []).map((m) => (
        <div key={m.domain} className="card pad small stack">
          <p>
            <b>{m.domain}</b> — {m.status === "verified" ? `✓ ${w("domains.verified")}` : w("domains.pending")}
          </p>
          <table className="table">
            <tbody>
              {m.records.map((r) => (
                <tr key={r.purpose}>
                  <td>{r.ok === true ? "✓" : r.ok === false ? "✕" : "·"}</td>
                  <td>
                    {r.type} <code className="break">{r.name}</code>
                    <br />
                    <code className="break">{r.value}</code>
                  </td>
                  <td className="muted">{r.required ? w("domains.required") : w("domains.optional")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.lastError && <p className="error-text">{m.lastError}</p>}
          <div className="row-wrap">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(async () => (await api(`/v1/settings/email-domains/${m.domain}/verify`, { method: "POST" }), await reload(), refreshBrand()))}>
              {w("domains.verify")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => (await api(`/v1/settings/email-domains/${m.domain}`, { method: "DELETE" }), await reload(), refreshBrand()))}>
              {w("domains.remove")}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
