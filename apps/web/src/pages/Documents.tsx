// Plantillas de documentos y biblioteca de cláusulas (Fase 6): editor con vista previa en vivo y "Generar y enviar".
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  analyzeTemplate,
  renderTemplate,
  roleKey,
  TemplateSyntaxError,
  type Clause,
  type ClauseUsage,
  type DocumentTemplate,
  type DocumentTemplateSummary,
  type GenerateDocumentResponse,
  type Locale,
  type TemplateAnalysis,
} from "@calasign/shared";
import { api, errorText, fetchResponse, isVersionChanged, readBody } from "../lib/api";
import { formatDateTime, useI18n, confirmAction, placeholderText, LOCALE_LABELS, useUnsavedWarning } from "../lib/i18n";
import { useAccess } from "../lib/access";
import { useAgrText } from "../lib/i18n-agreements";
import { AgreementsTabs, DocPreview, parseJsonObject } from "../components/AgreementsUi";
import { ErrorBox, Modal, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

/** Plantilla inicial e inserciones de la barra, en el idioma de la consola. */
interface Starter {
  source: string;
  data: Record<string, unknown>;
  title: string;
  ins: { text: string; table: string; variable: string; cond: string; each: string; role: string };
}

const STARTERS: Record<Locale, Starter> = {
  es: {
    source: `# Contrato de prestación de servicios

Entre **{{empresa.nombre}}** y **{{cliente.nombre}}** (documento {{cliente.documento}}) se acuerda lo siguiente:

## Servicios
| Servicio | Importe |
|---|---|
{{#each servicios as s}}
| {{s.nombre}} | {{s.importe | money:USD}} |
{{/each}}

{{#if plazo > 12}}
El contrato tiene un plazo de **{{plazo}} meses** con renovación automática.
{{else}}
El contrato tiene un plazo de {{plazo}} meses.
{{/if}}

## Firmas
{{firma:Cliente}}    {{firma:Empresa}}
{{fecha_firma:Cliente}}    {{fecha_firma:Empresa}}
`,
    data: {
      empresa: { nombre: "Mi Empresa S.A." },
      cliente: { nombre: "María Pérez", documento: "001-1234567-8" },
      plazo: 24,
      servicios: [
        { nombre: "Implementación", importe: 1500 },
        { nombre: "Soporte mensual", importe: 200 },
      ],
    },
    title: "Contrato con {{cliente.nombre}}",
    ins: {
      text: "texto",
      table: "| Columna 1 | Columna 2 |\n|---|---|\n| A | B |",
      variable: "cliente.nombre",
      cond: "{{#if condicion}}\n…\n{{/if}}",
      each: "{{#each items as item}}\n- {{item.nombre}}\n{{/each}}",
      role: "Cliente",
    },
  },
  "pt-BR": {
    source: `# Contrato de prestação de serviços

Entre **{{empresa.nome}}** e **{{cliente.nome}}** (documento {{cliente.documento}}) fica acordado o seguinte:

## Serviços
| Serviço | Valor |
|---|---|
{{#each servicos as s}}
| {{s.nome}} | {{s.valor | money:BRL}} |
{{/each}}

{{#if prazo > 12}}
O contrato tem prazo de **{{prazo}} meses** com renovação automática.
{{else}}
O contrato tem prazo de {{prazo}} meses.
{{/if}}

## Assinaturas
{{assinatura:Cliente}}    {{assinatura:Empresa}}
{{data_assinatura:Cliente}}    {{data_assinatura:Empresa}}
`,
    data: {
      empresa: { nome: "Minha Empresa Ltda." },
      cliente: { nome: "Maria Souza", documento: "123.456.789-00" },
      prazo: 24,
      servicos: [
        { nome: "Implantação", valor: 1500 },
        { nome: "Suporte mensal", valor: 200 },
      ],
    },
    title: "Contrato com {{cliente.nome}}",
    ins: {
      text: "texto",
      table: "| Coluna 1 | Coluna 2 |\n|---|---|\n| A | B |",
      variable: "cliente.nome",
      cond: "{{#if condicao}}\n…\n{{/if}}",
      each: "{{#each itens as item}}\n- {{item.nome}}\n{{/each}}",
      role: "Cliente",
    },
  },
  en: {
    source: `# Services agreement

Between **{{company.name}}** and **{{client.name}}** (ID {{client.id}}) the parties agree as follows:

## Services
| Service | Amount |
|---|---|
{{#each services as s}}
| {{s.name}} | {{s.amount | money:USD}} |
{{/each}}

{{#if term > 12}}
The agreement has a term of **{{term}} months** with automatic renewal.
{{else}}
The agreement has a term of {{term}} months.
{{/if}}

## Signatures
{{signature:Client}}    {{signature:Company}}
{{date_signed:Client}}    {{date_signed:Company}}
`,
    data: {
      company: { name: "My Company Inc." },
      client: { name: "Mary Smith", id: "123-45-6789" },
      term: 24,
      services: [
        { name: "Implementation", amount: 1500 },
        { name: "Monthly support", amount: 200 },
      ],
    },
    title: "Agreement with {{client.name}}",
    ins: {
      text: "text",
      table: "| Column 1 | Column 2 |\n|---|---|\n| A | B |",
      variable: "client.name",
      cond: "{{#if condition}}\n…\n{{/if}}",
      each: "{{#each items as item}}\n- {{item.name}}\n{{/each}}",
      role: "Client",
    },
  },
};

const LOCALES_LIST: Locale[] = ["es", "pt-BR", "en"];

// ───────────────────────────── Listado ─────────────────────────────

export function DocumentTemplatesPage() {
  const ta = useAgrText();
  useTitle(ta("docs.title"));
  const { locale } = useI18n();
  const { can } = useAccess();
  const nav = useNavigate();
  const [items, setItems] = useState<DocumentTemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: DocumentTemplateSummary[] }>("/v1/document-templates")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const st = STARTERS[locale] ?? STARTERS.es;
      const d = await api<DocumentTemplate>("/v1/document-templates", {
        method: "POST",
        body: { name: ta("docs.new"), locale, source: st.source, sampleData: st.data, agreementMapping: { title: st.title } },
      });
      nav(`/app/documents/${d.id}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <AgreementsTabs />
      <div className="page-head">
        <div>
          <h1>{ta("docs.title")}</h1>
          <p className="muted">{ta("docs.intro")}</p>
        </div>
        {can("templates:manage") && (
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy}>
            {ta("docs.new")}
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{ta("docs.empty")}</div>
      ) : (
        <div className="card table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{ta("docs.name")}</th>
                <th>{ta("docs.roles")}</th>
                <th>{ta("docs.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => nav(`/app/documents/${d.id}`)}>
                  <td>
                    <Link to={`/app/documents/${d.id}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{d.name}</strong>
                    </Link>
                    {d.syntaxError && <div className="agr-run-err">{ta("docs.syntax")}</div>}
                  </td>
                  <td className="small">{d.analysis?.roles.join(", ") || "—"}</td>
                  <td className="small">{formatDateTime(d.updatedAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Editor ─────────────────────────────

type Mapping = { title: string; value: string; currency: string; effectiveDate: string; expiryDate: string; tags: string };

/** Lo editable de la plantilla (para saber si hay cambios sin guardar). */
interface Draft {
  name: string;
  locale: Locale;
  source: string;
  sample: string;
  mapping: Mapping;
}

function toDraft(d: DocumentTemplate): Draft {
  return {
    name: d.name,
    locale: (LOCALES_LIST as string[]).includes(d.locale) ? (d.locale as Locale) : "es",
    source: d.source,
    sample: JSON.stringify(d.sampleData ?? {}, null, 2),
    mapping: {
      title: d.agreementMapping?.title ?? "",
      value: d.agreementMapping?.value ?? "",
      currency: d.agreementMapping?.currency ?? "",
      effectiveDate: d.agreementMapping?.effectiveDate ?? "",
      expiryDate: d.agreementMapping?.expiryDate ?? "",
      tags: (d.agreementMapping?.tags ?? []).join(", "),
    },
  };
}

/** Comparación sin diferencias de formato (el JSON y las etiquetas vuelven normalizados del servidor). */
function normDraft(d: Draft) {
  const obj = parseJsonObject(d.sample);
  const tags = d.mapping.tags
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(",");
  return JSON.stringify({ ...d, name: d.name.trim(), sample: obj ? stableStringify(obj) : d.sample, mapping: { ...d.mapping, tags } });
}

/**
 * JSON con las claves ordenadas en todos los niveles: Postgres (jsonb) devuelve los datos de ejemplo con otro orden de
 * claves, y sin esto la plantilla recién guardada figuraba con cambios sin guardar.
 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
const sameDraft = (a: Draft, b: Draft) => normDraft(a) === normDraft(b);

export function DocumentTemplateEditPage() {
  const { id } = useParams();
  const ta = useAgrText();
  const { t, locale: uiLocale } = useI18n();
  const { can } = useAccess();
  const nav = useNavigate();
  const ins = (STARTERS[uiLocale] ?? STARTERS.es).ins;
  const [tpl, setTpl] = useState<DocumentTemplate | null>(null);
  const [saved0, setSaved0] = useState<Draft | null>(null);
  const [clauses, setClauses] = useState<Clause[]>([]);
  const [name, setName] = useState("");
  const [docLocale, setDocLocale] = useState<Locale>("es");
  const [source, setSource] = useState("");
  const [sample, setSample] = useState("{}");
  const [mapping, setMapping] = useState<Mapping>({ title: "", value: "", currency: "", effectiveDate: "", expiryDate: "", tags: "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  // 409 version_changed: otra pestaña u otra persona la guardó desde que se cargó.
  const [stale, setStale] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [role, setRole] = useState(ins.role);
  const ref = useRef<HTMLTextAreaElement>(null);
  const editable = can("templates:manage");
  const draft: Draft = { name, locale: docLocale, source, sample, mapping };
  const dirty = editable && !!saved0 && !sameDraft(draft, saved0);
  useUnsavedWarning(dirty);

  const apply = useCallback((d: DocumentTemplate) => {
    const dr = toDraft(d);
    setTpl(d);
    setSaved0(dr);
    setName(dr.name);
    setDocLocale(dr.locale);
    setSource(dr.source);
    setSample(dr.sample);
    setMapping(dr.mapping);
  }, []);

  const loadClauses = useCallback(
    () =>
      api<{ items: Clause[] }>("/v1/clauses")
        .then((r) => setClauses(r.items))
        .catch(() => undefined),
    [],
  );

  useEffect(() => {
    api<DocumentTemplate>(`/v1/document-templates/${id}`)
      .then(apply)
      .catch((e) => setError(errorText(e)));
    void loadClauses();
  }, [id, apply, loadClauses]);

  const reload = async () => {
    if (dirty && !window.confirm(t("edit.reloadConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      apply(await api<DocumentTemplate>(`/v1/document-templates/${id}`));
      await loadClauses();
      setStale(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const clauseMap = useMemo(() => Object.fromEntries(clauses.map((c) => [c.slug, c.body])), [clauses]);
  const sampleObj = useMemo(() => parseJsonObject(sample), [sample]);
  // Vista previa en vivo con el mismo motor que el servidor.
  const preview = useMemo(() => {
    try {
      const r = renderTemplate(source, sampleObj ?? {}, { clauses: clauseMap, locale: docLocale, missing: "placeholder" });
      const analysis: TemplateAnalysis = analyzeTemplate(source, clauseMap);
      return { ...r, analysis, error: null as string | null, reason: null as string | null };
    } catch (e) {
      return {
        blocks: [],
        missing: [],
        missingClauses: [],
        marks: [],
        analysis: null,
        error: e instanceof Error ? e.message : String(e),
        reason: e instanceof TemplateSyntaxError ? (e.reason ?? null) : null,
      };
    }
  }, [source, sampleObj, clauseMap, docLocale]);

  const insert = (before: string, after = "", placeholder = "") => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const sel = source.slice(s, e) || placeholder;
    const next = source.slice(0, s) + before + sel + after + source.slice(e);
    setSource(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + sel.length);
    });
  };
  const insertLine = (text: string) => {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const lineStart = source.lastIndexOf("\n", s - 1) + 1;
    const prefix = s > lineStart ? "\n" : "";
    const next = source.slice(0, s) + prefix + text + "\n" + source.slice(s);
    setSource(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = s + prefix.length + text.length + 1;
      el.setSelectionRange(pos, pos);
    });
  };

  /** Guarda la plantilla; devuelve false si no se pudo (para no generar desde la versión anterior del servidor). */
  const save = async (e?: FormEvent): Promise<boolean> => {
    e?.preventDefault();
    if (!sampleObj) {
      setError(ta("docs.sampleInvalid"));
      return false;
    }
    if (preview.reason === "role_too_long") {
      setError(ta("docs.roleTooLong"));
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const d = await api<DocumentTemplate>(`/v1/document-templates/${id}`, {
        method: "PATCH",
        // Control de edición concurrente: si otra pestaña u otra persona la guardó, 409 en vez de pisar sus cambios.
        headers: tpl ? { "X-Expected-Updated-At": tpl.updatedAt } : undefined,
        body: {
          name: name.trim(),
          locale: docLocale,
          source,
          sampleData: sampleObj,
          agreementMapping: {
            title: mapping.title || null,
            value: mapping.value || null,
            currency: mapping.currency || null,
            // El mapeo se guarda entero (la API lo reemplaza): sin este campo, cada guardado borraba la vigencia puesta por API.
            effectiveDate: mapping.effectiveDate || null,
            expiryDate: mapping.expiryDate || null,
            tags: mapping.tags
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          },
        },
      });
      setTpl(d);
      // Lo enviado queda como guardado (lo tipeado mientras tanto sigue pendiente).
      setSaved0(toDraft(d));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (err) {
      if (isVersionChanged(err)) setStale(true);
      else setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openPdf = async () => {
    setError(null);
    // La ventana se abre en el clic (después de un await los navegadores la bloquean como popup).
    const win = window.open("", "_blank");
    try {
      // fetchResponse: errores como los de api() (sin conexión traducido, 401 al login, 502 sin cuerpo con mensaje).
      const res = await fetchResponse("/v1/document-templates/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, data: sampleObj ?? {}, locale: docLocale, title: name }),
      });
      const url = URL.createObjectURL(await readBody(res.blob()));
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        // Ventanas emergentes bloqueadas: se descarga en lugar de salir del editor (se perderían cambios).
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name || placeholderText("document")}.pdf`;
        a.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      win?.close();
      setError(errorText(e));
    }
  };

  if (!tpl) return <div className="page">{error ? <ErrorBox error={error} /> : <Spinner />}</div>;
  const a = preview.analysis;
  // La API exige al menos un firmante: sin {{firma:X}} no hay roles para generar.
  const noRoles = !!a && a.roles.length === 0;
  const unsigned = a?.unsignedRoles ?? [];
  return (
    <div className="page">
      <AgreementsTabs />
      <Link to="/app/documents" className="muted small">
        {ta("docs.back")}
      </Link>
      <form className="stack" onSubmit={save}>
        <div className="page-head">
          <input
            className="agr-title-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={ta("docs.name")}
            disabled={!editable}
            required
          />
          <div className="row-wrap">
            {saved && <span className="muted small">✓ {ta("docs.saved")}</span>}
            <button type="button" className="btn" onClick={openPdf}>
              {ta("docs.pdf")}
            </button>
            {editable && (
              <button type="submit" className="btn" disabled={busy || stale}>
                {busy ? t("common.saving") : ta("docs.save")}
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                // Se genera desde lo guardado en el servidor: si el guardado falla, generar mandaría la versión anterior.
                if (editable && dirty && !(await save())) return;
                // La biblioteca pudo cambiar en otra pestaña: los firmantes del modal salen de las cláusulas actuales.
                await loadClauses();
                setGenerating(true);
              }}
              disabled={busy || stale || !!preview.error || noRoles || unsigned.length > 0}
              title={noRoles ? ta("docs.noRoles") : undefined}
            >
              {ta("docs.generate")}
            </button>
          </div>
        </div>
        {stale && (
          <div className="alert alert-error row-between" role="alert">
            <span>{ta("docs.versionChanged")}</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={reload}>
              {t("edit.reload")}
            </button>
          </div>
        )}
        <ErrorBox error={error} />
        <div className="agr-split">
          <div className="stack">
            <div>
              <div className="agr-toolbar" role="toolbar" aria-label={ta("docs.editor")}>
                <button type="button" onClick={() => insertLine("# ")} disabled={!editable}>
                  {ta("tb.h1")}
                </button>
                <button type="button" onClick={() => insertLine("## ")} disabled={!editable}>
                  {ta("tb.h2")}
                </button>
                <button type="button" onClick={() => insert("**", "**", ins.text)} disabled={!editable}>
                  <strong>{ta("tb.bold")}</strong>
                </button>
                <button type="button" onClick={() => insert("*", "*", ins.text)} disabled={!editable}>
                  <em>{ta("tb.italic")}</em>
                </button>
                <button type="button" onClick={() => insertLine("- ")} disabled={!editable}>
                  {ta("tb.ul")}
                </button>
                <button type="button" onClick={() => insertLine("1. ")} disabled={!editable}>
                  {ta("tb.ol")}
                </button>
                <button type="button" onClick={() => insertLine(ins.table)} disabled={!editable}>
                  {ta("tb.table")}
                </button>
                <button type="button" onClick={() => insertLine("{{salto}}")} disabled={!editable}>
                  {ta("tb.pagebreak")}
                </button>
                <button type="button" onClick={() => insert("{{", "}}", ins.variable)} disabled={!editable}>
                  {ta("tb.var")}
                </button>
                <button type="button" onClick={() => insertLine(ins.cond)} disabled={!editable}>
                  {ta("tb.if")}
                </button>
                <button type="button" onClick={() => insertLine(ins.each)} disabled={!editable}>
                  {ta("tb.each")}
                </button>
                <select
                  aria-label={ta("tb.clause")}
                  value=""
                  disabled={!editable || clauses.length === 0}
                  onChange={(e) => {
                    if (e.target.value) insertLine(`{{clausula:${e.target.value}}}`);
                  }}
                >
                  <option value="">{ta("tb.clause")}…</option>
                  {clauses.map((c) => (
                    <option key={c.id} value={c.slug}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={ta("tb.role")}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  style={{ width: 110 }}
                  maxLength={80}
                  disabled={!editable}
                />
                <button type="button" onClick={() => insert(`{{firma:${role.trim() || ins.role}}}`)} disabled={!editable}>
                  {ta("tb.signature")}
                </button>
                <button type="button" onClick={() => setShowHelp((x) => !x)} aria-expanded={showHelp}>
                  {ta("docs.help")}
                </button>
              </div>
              <textarea
                ref={ref}
                className="agr-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                spellCheck={false}
                aria-label={ta("docs.editor")}
                readOnly={!editable}
              />
            </div>
            {showHelp && <div className="agr-help">{ta("help.body")}</div>}
            <label className="field">
              <span>{ta("docs.locale")}</span>
              <select value={docLocale} onChange={(e) => setDocLocale(e.target.value as Locale)} disabled={!editable}>
                {LOCALES_LIST.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{ta("docs.sample")}</span>
              <textarea
                className="agr-json"
                value={sample}
                onChange={(e) => setSample(e.target.value)}
                spellCheck={false}
                aria-invalid={!sampleObj}
              />
              {!sampleObj && <small className="agr-run-err">{ta("docs.sampleInvalid")}</small>}
            </label>
            <fieldset className="field">
              <legend>{ta("docs.mapping")}</legend>
              <div className="grid-2">
                <label className="field">
                  <span>{ta("docs.mapping.title")}</span>
                  <input
                    value={mapping.title}
                    onChange={(e) => setMapping({ ...mapping, title: e.target.value })}
                    placeholder={placeholderText("docTitle")}
                    disabled={!editable}
                  />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.value")}</span>
                  <input
                    value={mapping.value}
                    onChange={(e) => setMapping({ ...mapping, value: e.target.value })}
                    placeholder="total"
                    disabled={!editable}
                  />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.currency")}</span>
                  <input
                    value={mapping.currency}
                    onChange={(e) => setMapping({ ...mapping, currency: e.target.value.toUpperCase() })}
                    placeholder="USD"
                    maxLength={3}
                    disabled={!editable}
                  />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.effective")}</span>
                  <input
                    value={mapping.effectiveDate}
                    onChange={(e) => setMapping({ ...mapping, effectiveDate: e.target.value })}
                    placeholder={placeholderText("effectiveVar")}
                    disabled={!editable}
                  />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.expiry")}</span>
                  <input
                    value={mapping.expiryDate}
                    onChange={(e) => setMapping({ ...mapping, expiryDate: e.target.value })}
                    placeholder={placeholderText("expiryVar")}
                    disabled={!editable}
                  />
                </label>
              </div>
              <label className="field">
                <span>{ta("docs.mapping.tags")}</span>
                <input value={mapping.tags} onChange={(e) => setMapping({ ...mapping, tags: e.target.value })} disabled={!editable} />
              </label>
            </fieldset>
          </div>
          <div className="stack">
            <div className="row-between">
              <h2 className="small muted">{ta("docs.preview")}</h2>
              {/* Las cláusulas editadas en otra pestaña no se veían hasta recargar la página. */}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void loadClauses()}>
                {ta("docs.reloadClauses")}
              </button>
            </div>
            {preview.error ? (
              <div className="alert alert-error">
                {ta("docs.syntax")}: {preview.reason === "role_too_long" ? `${ta("docs.roleTooLong")} ` : ""}
                {preview.error}
              </div>
            ) : (
              <DocPreview blocks={preview.blocks} />
            )}
            {a && (
              <div className="card pad agr-analysis">
                <div>
                  <strong>{ta("docs.roles")}:</strong> {a.roles.length ? a.roles.map((r) => <code key={r}>{r}</code>) : "—"}
                </div>
                {noRoles && <div className="agr-run-err">{ta("docs.noRoles")}</div>}
                {unsigned.length > 0 && <div className="agr-run-err">{ta("docs.unsignedRoles", { roles: unsigned.join(", ") })}</div>}
                <div>
                  <strong>{ta("docs.variables")}:</strong>{" "}
                  {a.variables.map((v) => (
                    <code key={v} style={{ marginRight: 4 }}>
                      {v}
                    </code>
                  ))}
                </div>
                {a.loops.length > 0 && (
                  <div>
                    <strong>{ta("docs.loops")}:</strong>{" "}
                    {a.loops.map((l) => (
                      <code key={l.path} style={{ marginRight: 4 }}>
                        {l.path}[{l.fields.join(", ")}]
                      </code>
                    ))}
                  </div>
                )}
                {preview.missing.length > 0 && (
                  <div className="agr-run-err">
                    {ta("docs.missing")}: {preview.missing.join(", ")}
                  </div>
                )}
                {preview.missingClauses.length > 0 && (
                  <div className="agr-run-err">{preview.missingClauses.map((c) => `{{clausula:${c}}}`).join(", ")}</div>
                )}
              </div>
            )}
          </div>
        </div>
        {editable && (
          <div className="row-end">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                if (!confirmAction()) return;
                setError(null);
                try {
                  await api(`/v1/document-templates/${id}`, { method: "DELETE" });
                  // Archivada: lo no guardado ya no importa (sin el aviso de cambios sin guardar al salir).
                  setSaved0(draft);
                  nav("/app/documents");
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              {ta("docs.delete")}
            </button>
          </div>
        )}
      </form>
      {generating && (
        <GenerateModal
          templateId={tpl.id}
          source={tpl.source}
          clauses={clauseMap}
          locale={tpl.locale}
          initialData={sampleObj ?? {}}
          onClose={() => setGenerating(false)}
          onDone={(r) => nav(`/app/envelopes/${r.envelopeId}`)}
        />
      )}
    </div>
  );
}

/** Correo o teléfono con código de país (+…): la API acepta cualquiera de los dos. */
function parseContact(raw: string): { email: string | null; phone: string | null } | null {
  const c = raw.trim();
  if (!c) return null;
  if (c.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) ? { email: c.toLowerCase(), phone: null } : null;
  const phone = c.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(phone) ? { email: null, phone } : null;
}

function GenerateModal({
  templateId,
  source,
  clauses,
  locale,
  initialData,
  onClose,
  onDone,
}: {
  templateId: string;
  source: string;
  clauses: Record<string, string>;
  locale: string;
  initialData: Record<string, unknown>;
  onClose: () => void;
  onDone: (r: GenerateDocumentResponse) => void;
}) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [json, setJson] = useState(JSON.stringify(initialData, null, 2));
  // Por rol (sin distinguir mayúsculas): lo escrito se conserva si el rol desaparece y vuelve al cambiar los datos.
  const [entries, setEntries] = useState<Record<string, { name: string; contact: string }>>({});
  const [send, setSend] = useState(true);
  const [allowMissing, setAllowMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<GenerateDocumentResponse | null>(null);
  const data = parseJsonObject(json);
  // Firmantes según los datos: {{#if garante}}{{firma:Garante}}{{/if}} pide garante solo si la condición se cumple
  // (antes se pedían todos los roles de la plantilla y la API rechazaba el que no tenía marcas).
  const roles = useMemo(() => {
    if (!data) return null;
    try {
      const seen = new Map<string, string>();
      for (const m of renderTemplate(source, data, { clauses, locale }).marks) if (!seen.has(roleKey(m.role))) seen.set(roleKey(m.role), m.role);
      return [...seen.values()];
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, source, clauses, locale]);
  const entry = (role: string) => entries[roleKey(role)] ?? { name: "", contact: "" };
  const setEntry = (role: string, patch: Partial<{ name: string; contact: string }>) =>
    setEntries((x) => ({ ...x, [roleKey(role)]: { ...entry(role), ...patch } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!data) return setError(ta("docs.sampleInvalid"));
    if (!roles?.length) return setError(ta("docs.noRoles"));
    const recipients = [];
    for (const role of roles) {
      const c = parseContact(entry(role).contact);
      if (!c) return setError(ta("gen.contactInvalid", { role }));
      recipients.push({ role, name: entry(role).name.trim(), ...c });
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<GenerateDocumentResponse>(`/v1/document-templates/${templateId}/generate`, {
        method: "POST",
        body: { data, recipients, send, allowMissing },
      });
      // Con avisos (firmantes que no se agregaron), se muestran antes de ir al sobre.
      if (r.warnings?.length) {
        setDone(r);
        setBusy(false);
      } else onDone(r);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  if (done)
    return (
      <Modal title={ta("gen.done")} onClose={() => onDone(done)}>
        <div className="stack">
          <div className="alert alert-warn" role="status">
            <strong>{ta("gen.warnings")}</strong>
            <ul>
              {done.warnings!.map((w, i) => (
                <li key={i}>{w.code === "signer_without_marks" ? ta("gen.skipped", { roles: w.roles.join(", ") }) : w.message}</li>
              ))}
            </ul>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-primary" onClick={() => onDone(done)}>
              {ta("gen.open")}
            </button>
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal title={ta("gen.title")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        {roles !== null && roles.length === 0 && <div className="alert alert-warn">{ta("docs.noRoles")}</div>}
        <fieldset className="field">
          <legend>{ta("gen.recipients")}</legend>
          <small className="muted">{ta("gen.rolesHint")}</small>
          {(roles ?? []).map((role) => (
            <div key={roleKey(role)} className="agr-subrow">
              <strong>{role}</strong>
              <input
                aria-label={`${role} — ${ta("ag.name")}`}
                placeholder={ta("ag.name")}
                value={entry(role).name}
                required
                maxLength={200}
                onChange={(e) => setEntry(role, { name: e.target.value })}
              />
              <input
                aria-label={`${role} — ${ta("gen.contact")}`}
                placeholder={ta("gen.contact")}
                value={entry(role).contact}
                required
                autoComplete="off"
                onChange={(e) => setEntry(role, { contact: e.target.value })}
              />
            </div>
          ))}
        </fieldset>
        <label className="field">
          <span>{ta("gen.json")}</span>
          <textarea className="agr-json" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} aria-invalid={!data} />
        </label>
        <label className="check">
          <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> {ta("gen.send")}
        </label>
        <label className="check">
          <input type="checkbox" checked={allowMissing} onChange={(e) => setAllowMissing(e.target.checked)} /> {ta("gen.allowMissing")}
        </label>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !data || !roles?.length}>
            {busy ? t("common.saving") : ta("gen.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── Cláusulas ─────────────────────────────

export function ClausesPage() {
  const ta = useAgrText();
  const { can } = useAccess();
  const [items, setItems] = useState<Clause[] | null>(null);
  const [editing, setEditing] = useState<Clause | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ items: Clause[] }>("/v1/clauses")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="page">
      <AgreementsTabs />
      <div className="page-head">
        <div>
          <h1>{ta("cl.title")}</h1>
          <p className="muted">{ta("cl.intro")}</p>
        </div>
        {can("templates:manage") && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
            {ta("cl.new")}
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{ta("cl.empty")}</div>
      ) : (
        <div className="stack">
          {items.map((c) => (
            <div key={c.id} className="card pad">
              <div className="row-between">
                <div>
                  <strong>{c.title}</strong> <code className="small">{`{{clausula:${c.slug}}}`}</code>
                  {c.category && (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      {c.category}
                    </span>
                  )}
                </div>
                {can("templates:manage") && (
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(c)}>
                    {ta("cl.edit")}
                  </button>
                )}
              </div>
              <DocPreview blocks={safeRender(c.body)} />
            </div>
          ))}
        </div>
      )}
      {editing && (
        <ClauseModal
          clause={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function safeRender(body: string) {
  try {
    return renderTemplate(body, {}, { missing: "placeholder" }).blocks;
  } catch {
    return [];
  }
}

function ClauseModal({ clause: initial, onClose, onSaved }: { clause: Clause | null; onClose: () => void; onSaved: () => void }) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [clause, setClause] = useState<Clause | null>(initial);
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // Dónde se usa: se muestra antes de guardar (un cambio llega a los documentos nuevos de todas esas plantillas).
  const [usage, setUsage] = useState<ClauseUsage | null>(null);
  // Doble clic en "Guardar" mandaba dos POST: el segundo respondía "ya existe una cláusula con ese código".
  const [busy, setBusy] = useState(false);
  const dirty = !!clause && (title !== clause.title || body !== clause.body || category !== (clause.category ?? ""));
  useUnsavedWarning(dirty || (!clause && (!!slug || !!title || !!body)));
  useEffect(() => {
    if (!initial) return;
    api<ClauseUsage>(`/v1/clauses/${initial.id}/usage`)
      .then(setUsage)
      .catch(() => undefined);
  }, [initial]);

  const reload = async () => {
    if (!clause) return;
    if (dirty && !window.confirm(t("edit.reloadConfirm"))) return;
    try {
      const r = await api<{ items: Clause[] }>("/v1/clauses");
      const c = r.items.find((x) => x.id === clause.id);
      if (!c) return onSaved();
      setClause(c);
      setTitle(c.title);
      setCategory(c.category ?? "");
      setBody(c.body);
      setStale(false);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = { slug: slug.trim(), title: title.trim(), body, category: category.trim() || null };
      if (clause) await api(`/v1/clauses/${clause.id}`, { method: "PATCH", body: payload, headers: { "X-Expected-Updated-At": clause.updatedAt } });
      else await api("/v1/clauses", { method: "POST", body: payload });
      onSaved();
    } catch (err) {
      if (isVersionChanged(err)) setStale(true);
      else setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!clause || !confirmAction()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/clauses/${clause.id}`, { method: "DELETE" });
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const used = usage ? usage.templates.length + usage.clauses.length : 0;
  return (
    <Modal title={clause ? ta("cl.edit") : ta("cl.new")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        {stale && (
          <div className="alert alert-error row-between" role="alert">
            <span>{ta("cl.versionChanged")}</span>
            <button type="button" className="btn btn-sm" onClick={reload}>
              {t("edit.reload")}
            </button>
          </div>
        )}
        <ErrorBox error={error} />
        {clause && usage && (
          <div className={used ? "alert alert-warn" : "muted small"} role="status">
            {used ? (
              <>
                <strong>{ta("cl.usedBy")}:</strong>{" "}
                {usage.templates.length > 0 && (
                  <>
                    {ta("cl.templates")}:{" "}
                    {usage.templates.map((x, i) => (
                      <span key={x.id}>
                        {i > 0 && ", "}
                        <Link to={`/app/documents/${x.id}`}>{x.name}</Link>
                      </span>
                    ))}
                    {usage.clauses.length > 0 && " · "}
                  </>
                )}
                {usage.clauses.length > 0 && (
                  <>
                    {ta("cl.clauses")}: {usage.clauses.map((x) => x.title).join(", ")}
                  </>
                )}
                <div className="small">{ta("cl.usedByWarn")}</div>
              </>
            ) : (
              ta("cl.usedByNone")
            )}
          </div>
        )}
        <div className="grid-2">
          <label className="field">
            <span>{ta("cl.titleField")}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="field">
            <span>{ta("cl.slug")}</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              pattern="[a-z0-9][a-z0-9_-]{0,59}"
              required
              disabled={!!clause}
            />
          </label>
        </div>
        <label className="field">
          <span>{ta("cl.category")}</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} />
        </label>
        <label className="field">
          <span>{ta("cl.body")}</span>
          <textarea className="agr-json" value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
        </label>
        <div className="modal-foot">
          {clause && (
            <button type="button" className="btn btn-ghost" onClick={remove} disabled={busy} style={{ marginRight: "auto" }}>
              {ta("cl.delete")}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || stale}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
