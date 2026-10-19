// Plantillas de documentos y biblioteca de cláusulas (Fase 6): editor con vista previa en vivo y "Generar y enviar".
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  analyzeTemplate,
  renderTemplate,
  type Clause,
  type DocumentTemplate,
  type GenerateDocumentResponse,
  type TemplateAnalysis,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n, confirmAction } from "../lib/i18n";
import { useAccess } from "../lib/access";
import { useAgrText } from "../lib/i18n-agreements";
import { AgreementsTabs, DocPreview, parseJsonObject } from "../components/AgreementsUi";
import { ErrorBox, Modal, Spinner } from "../components/ui";

const STARTER = `# Contrato de prestación de servicios

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
`;

const STARTER_DATA = {
  empresa: { nombre: "Mi Empresa S.A." },
  cliente: { nombre: "María Pérez", documento: "001-1234567-8" },
  plazo: 24,
  servicios: [
    { nombre: "Implementación", importe: 1500 },
    { nombre: "Soporte mensual", importe: 200 },
  ],
};

// ───────────────────────────── Listado ─────────────────────────────

export function DocumentTemplatesPage() {
  const ta = useAgrText();
  const { locale } = useI18n();
  const { can } = useAccess();
  const nav = useNavigate();
  const [items, setItems] = useState<DocumentTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ items: DocumentTemplate[] }>("/v1/document-templates")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const d = await api<DocumentTemplate>("/v1/document-templates", {
        method: "POST",
        body: { name: ta("docs.new"), source: STARTER, sampleData: STARTER_DATA, agreementMapping: { title: "Contrato con {{cliente.nombre}}" } },
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

export function DocumentTemplateEditPage() {
  const { id } = useParams();
  const ta = useAgrText();
  const { t } = useI18n();
  const { can } = useAccess();
  const nav = useNavigate();
  const [tpl, setTpl] = useState<DocumentTemplate | null>(null);
  const [clauses, setClauses] = useState<Clause[]>([]);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [sample, setSample] = useState("{}");
  const [mapping, setMapping] = useState({ title: "", value: "", currency: "", effectiveDate: "", expiryDate: "", tags: "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [role, setRole] = useState("Cliente");
  const ref = useRef<HTMLTextAreaElement>(null);
  const editable = can("templates:manage");

  useEffect(() => {
    api<DocumentTemplate>(`/v1/document-templates/${id}`)
      .then((d) => {
        setTpl(d);
        setName(d.name);
        setSource(d.source);
        setSample(JSON.stringify(d.sampleData ?? {}, null, 2));
        setMapping({
          title: d.agreementMapping?.title ?? "",
          value: d.agreementMapping?.value ?? "",
          currency: d.agreementMapping?.currency ?? "",
          effectiveDate: d.agreementMapping?.effectiveDate ?? "",
          expiryDate: d.agreementMapping?.expiryDate ?? "",
          tags: (d.agreementMapping?.tags ?? []).join(", "),
        });
      })
      .catch((e) => setError(errorText(e)));
    api<{ items: Clause[] }>("/v1/clauses").then((r) => setClauses(r.items)).catch(() => undefined);
  }, [id]);

  const clauseMap = useMemo(() => Object.fromEntries(clauses.map((c) => [c.slug, c.body])), [clauses]);
  const sampleObj = useMemo(() => parseJsonObject(sample), [sample]);
  // Vista previa en vivo con el mismo motor que el servidor.
  const preview = useMemo(() => {
    try {
      const r = renderTemplate(source, sampleObj ?? {}, { clauses: clauseMap, locale: tpl?.locale ?? "es", missing: "placeholder" });
      const analysis: TemplateAnalysis = analyzeTemplate(source, clauseMap);
      return { ...r, analysis, error: null as string | null };
    } catch (e) {
      return { blocks: [], missing: [], missingClauses: [], marks: [], analysis: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [source, sampleObj, clauseMap, tpl?.locale]);

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
    setBusy(true);
    setError(null);
    try {
      const d = await api<DocumentTemplate>(`/v1/document-templates/${id}`, {
        method: "PATCH",
        body: {
          name: name.trim(),
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
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (err) {
      setError(errorText(err));
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
      const res = await fetch("/v1/document-templates/render", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, data: sampleObj ?? {}, locale: tpl?.locale, title: name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? res.statusText);
      const url = URL.createObjectURL(await res.blob());
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        // Ventanas emergentes bloqueadas: se descarga en lugar de salir del editor (se perderían cambios).
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name || "documento"}.pdf`;
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
  return (
    <div className="page">
      <AgreementsTabs />
      <Link to="/app/documents" className="muted small">
        {ta("docs.back")}
      </Link>
      <form className="stack" onSubmit={save}>
        <div className="page-head">
          <input className="agr-title-input" value={name} onChange={(e) => setName(e.target.value)} aria-label={ta("docs.name")} disabled={!editable} required />
          <div className="row-wrap">
            {saved && <span className="muted small">✓ {ta("docs.saved")}</span>}
            <button type="button" className="btn" onClick={openPdf}>
              {ta("docs.pdf")}
            </button>
            {editable && (
              <button type="submit" className="btn" disabled={busy}>
                {busy ? t("common.saving") : ta("docs.save")}
              </button>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                // Se genera desde lo guardado en el servidor: si el guardado falla, generar mandaría la versión anterior.
                if (editable && !(await save())) return;
                setGenerating(true);
              }}
              disabled={busy || !!preview.error}
            >
              {ta("docs.generate")}
            </button>
          </div>
        </div>
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
                <button type="button" onClick={() => insert("**", "**", "texto")} disabled={!editable}>
                  <strong>{ta("tb.bold")}</strong>
                </button>
                <button type="button" onClick={() => insert("*", "*", "texto")} disabled={!editable}>
                  <em>{ta("tb.italic")}</em>
                </button>
                <button type="button" onClick={() => insertLine("- ")} disabled={!editable}>
                  {ta("tb.ul")}
                </button>
                <button type="button" onClick={() => insertLine("1. ")} disabled={!editable}>
                  {ta("tb.ol")}
                </button>
                <button type="button" onClick={() => insertLine("| Columna 1 | Columna 2 |\n|---|---|\n| A | B |")} disabled={!editable}>
                  {ta("tb.table")}
                </button>
                <button type="button" onClick={() => insertLine("{{salto}}")} disabled={!editable}>
                  {ta("tb.pagebreak")}
                </button>
                <button type="button" onClick={() => insert("{{", "}}", "cliente.nombre")} disabled={!editable}>
                  {ta("tb.var")}
                </button>
                <button type="button" onClick={() => insertLine("{{#if condicion}}\n…\n{{/if}}")} disabled={!editable}>
                  {ta("tb.if")}
                </button>
                <button type="button" onClick={() => insertLine("{{#each items as item}}\n- {{item.nombre}}\n{{/each}}")} disabled={!editable}>
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
                <input aria-label={ta("tb.role")} value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 110 }} disabled={!editable} />
                <button type="button" onClick={() => insert(`{{firma:${role.trim() || "Cliente"}}}`)} disabled={!editable}>
                  ✍ {ta("tb.signature")}
                </button>
                <button type="button" onClick={() => setShowHelp((x) => !x)} aria-expanded={showHelp}>
                  ? {ta("docs.help")}
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
              <span>{ta("docs.sample")}</span>
              <textarea className="agr-json" value={sample} onChange={(e) => setSample(e.target.value)} spellCheck={false} aria-invalid={!sampleObj} />
              {!sampleObj && <small className="agr-run-err">{ta("docs.sampleInvalid")}</small>}
            </label>
            <fieldset className="field">
              <legend>{ta("docs.mapping")}</legend>
              <div className="grid-2">
                <label className="field">
                  <span>{ta("docs.mapping.title")}</span>
                  <input value={mapping.title} onChange={(e) => setMapping({ ...mapping, title: e.target.value })} placeholder="Contrato con {{cliente.nombre}}" disabled={!editable} />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.value")}</span>
                  <input value={mapping.value} onChange={(e) => setMapping({ ...mapping, value: e.target.value })} placeholder="total" disabled={!editable} />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.currency")}</span>
                  <input value={mapping.currency} onChange={(e) => setMapping({ ...mapping, currency: e.target.value.toUpperCase() })} placeholder="USD" maxLength={3} disabled={!editable} />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.effective")}</span>
                  <input value={mapping.effectiveDate} onChange={(e) => setMapping({ ...mapping, effectiveDate: e.target.value })} placeholder="inicio" disabled={!editable} />
                </label>
                <label className="field">
                  <span>{ta("docs.mapping.expiry")}</span>
                  <input value={mapping.expiryDate} onChange={(e) => setMapping({ ...mapping, expiryDate: e.target.value })} placeholder="vencimiento" disabled={!editable} />
                </label>
              </div>
              <label className="field">
                <span>{ta("docs.mapping.tags")}</span>
                <input value={mapping.tags} onChange={(e) => setMapping({ ...mapping, tags: e.target.value })} disabled={!editable} />
              </label>
            </fieldset>
          </div>
          <div className="stack">
            <h2 className="small muted">{ta("docs.preview")}</h2>
            {preview.error ? <div className="alert alert-error">{ta("docs.syntax")}: {preview.error}</div> : <DocPreview blocks={preview.blocks} />}
            {a && (
              <div className="card pad agr-analysis">
                <div>
                  <strong>{ta("docs.roles")}:</strong> {a.roles.length ? a.roles.map((r) => <code key={r}>{r}</code>) : "—"}
                </div>
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
                {preview.missingClauses.length > 0 && <div className="agr-run-err">{preview.missingClauses.map((c) => `{{clausula:${c}}}`).join(", ")}</div>}
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
      {generating && a && (
        <GenerateModal templateId={tpl.id} analysis={a} initialData={sampleObj ?? {}} onClose={() => setGenerating(false)} onDone={(r) => nav(`/app/envelopes/${r.envelopeId}`)} />
      )}
    </div>
  );
}

function GenerateModal({
  templateId,
  analysis,
  initialData,
  onClose,
  onDone,
}: {
  templateId: string;
  analysis: TemplateAnalysis;
  initialData: Record<string, unknown>;
  onClose: () => void;
  onDone: (r: GenerateDocumentResponse) => void;
}) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [json, setJson] = useState(JSON.stringify(initialData, null, 2));
  const [recipients, setRecipients] = useState(analysis.roles.map((role) => ({ role, name: "", email: "" })));
  const [send, setSend] = useState(true);
  const [allowMissing, setAllowMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = parseJsonObject(json);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!data) return setError(ta("docs.sampleInvalid"));
    setBusy(true);
    setError(null);
    try {
      onDone(
        await api<GenerateDocumentResponse>(`/v1/document-templates/${templateId}/generate`, {
          method: "POST",
          body: { data, recipients: recipients.map((r) => ({ role: r.role, name: r.name.trim(), email: r.email.trim() || null })), send, allowMissing },
        }),
      );
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={ta("gen.title")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <fieldset className="field">
          <legend>{ta("gen.recipients")}</legend>
          {recipients.map((r, i) => (
            <div key={r.role} className="agr-subrow">
              <strong>{r.role}</strong>
              <input
                aria-label={`${r.role} — ${ta("ag.name")}`}
                placeholder={ta("ag.name")}
                value={r.name}
                required
                onChange={(e) => setRecipients(recipients.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <input
                aria-label={`${r.role} — ${ta("ag.email")}`}
                placeholder={ta("ag.email")}
                type="email"
                value={r.email}
                required
                onChange={(e) => setRecipients(recipients.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
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
          <button type="submit" className="btn btn-primary" disabled={busy || !data}>
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
                  {c.category && <span className="badge" style={{ marginLeft: 6 }}>{c.category}</span>}
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

function ClauseModal({ clause, onClose, onSaved }: { clause: Clause | null; onClose: () => void; onSaved: () => void }) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [slug, setSlug] = useState(clause?.slug ?? "");
  const [title, setTitle] = useState(clause?.title ?? "");
  const [category, setCategory] = useState(clause?.category ?? "");
  const [body, setBody] = useState(clause?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  // Doble clic en "Guardar" mandaba dos POST: el segundo respondía "ya existe una cláusula con ese código".
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = { slug: slug.trim(), title: title.trim(), body, category: category.trim() || null };
      if (clause) await api(`/v1/clauses/${clause.id}`, { method: "PATCH", body: payload });
      else await api("/v1/clauses", { method: "POST", body: payload });
      onSaved();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={clause ? ta("cl.edit") : ta("cl.new")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="grid-2">
          <label className="field">
            <span>{ta("cl.titleField")}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="field">
            <span>{ta("cl.slug")}</span>
            <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9_-]{0,59}" required disabled={!!clause} />
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
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
