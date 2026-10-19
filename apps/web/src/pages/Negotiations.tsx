// Negociación antes de firmar (Fase 6): listado, alta, y panel compartido por el remitente y la contraparte
// (documento con selección para comentar, propuestas, versiones con diff).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { DocumentTemplate, NegotiationDiff, NegotiationSummary, NegotiationView } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useAgrText, type AgreementsTextKey } from "../lib/i18n-agreements";
import { AgreementsTabs, DiffView, DocPreview, parseJsonObject } from "../components/AgreementsUi";
import { ErrorBox, Modal, Spinner } from "../components/ui";

function NegStatus({ status }: { status: NegotiationSummary["status"] }) {
  const ta = useAgrText();
  const cls = status === "accepted" ? "badge-completed" : status === "cancelled" ? "badge-voided" : "badge-sent";
  return <span className={`badge ${cls}`}>{ta(`neg.status.${status}` as AgreementsTextKey)}</span>;
}

// ───────────────────────────── Listado y alta ─────────────────────────────

export function NegotiationsPage() {
  const ta = useAgrText();
  const { locale } = useI18n();
  const nav = useNavigate();
  const [items, setItems] = useState<NegotiationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"template" | "pdf" | null>(null);
  useEffect(() => {
    api<{ items: NegotiationSummary[] }>("/v1/negotiations")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  }, []);
  return (
    <div className="page">
      <AgreementsTabs />
      <div className="page-head">
        <div>
          <h1>{ta("neg.title")}</h1>
          <p className="muted">{ta("neg.intro")}</p>
        </div>
        <div className="row-wrap">
          <button type="button" className="btn" onClick={() => setCreating("pdf")}>
            {ta("neg.uploadPdf")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating("template")}>
            {ta("neg.new")}
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{ta("neg.empty")}</div>
      ) : (
        <div className="card table-scroll">
          <table className="table">
            <tbody>
              {items.map((n) => (
                <tr key={n.id} className="clickable" onClick={() => nav(`/app/negotiations/${n.id}`)}>
                  <td>
                    <Link to={`/app/negotiations/${n.id}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{n.title}</strong>
                    </Link>
                    <div className="muted small">{n.participants.map((p) => p.name).join(", ")}</div>
                  </td>
                  <td className="small">{ta("neg.version", { n: n.currentVersion })}</td>
                  <td className="small">
                    {n.pendingProposals > 0 && <span className="badge badge-expired">{n.pendingProposals} ✎</span>} {n.openComments > 0 && <span className="badge">{n.openComments} 💬</span>}
                  </td>
                  <td>
                    <NegStatus status={n.status} />
                  </td>
                  <td className="small muted">{formatDateTime(n.updatedAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateNegotiationModal kind={creating} onClose={() => setCreating(null)} onCreated={(v) => nav(`/app/negotiations/${v.negotiation.id}`)} />}
    </div>
  );
}

function CreateNegotiationModal({ kind, onClose, onCreated }: { kind: "template" | "pdf"; onClose: () => void; onCreated: (v: NegotiationView) => void }) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [json, setJson] = useState("{}");
  const [negotiable, setNegotiable] = useState("");
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [participants, setParticipants] = useState([{ name: "", email: "", role: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind !== "template") return;
    api<{ items: DocumentTemplate[] }>("/v1/document-templates")
      .then((r) => {
        setTemplates(r.items);
        if (r.items[0]) {
          setTemplateId(r.items[0].id);
          setJson(JSON.stringify(r.items[0].sampleData ?? {}, null, 2));
          setParticipants([{ name: "", email: "", role: r.items[0].analysis?.roles[0] ?? "" }]);
        }
      })
      .catch((e) => setError(errorText(e)));
  }, [kind]);
  const data = parseJsonObject(json);
  const tpl = templates.find((x) => x.id === templateId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const parts = participants.filter((p) => p.name.trim() && p.email.trim()).map((p) => ({ name: p.name.trim(), email: p.email.trim(), role: p.role.trim() || null }));
    try {
      if (kind === "pdf") {
        if (!file) return;
        if (!/\.pdf$/i.test(file.name)) throw new Error(ta("neg.wordNotice"));
        const fd = new FormData();
        fd.append("meta", JSON.stringify({ title: title.trim(), participants: parts, message: message || null }));
        fd.append("file", file);
        onCreated(await api<NegotiationView>("/v1/negotiations/upload", { method: "POST", form: fd }));
      } else {
        onCreated(
          await api<NegotiationView>("/v1/negotiations", {
            method: "POST",
            body: {
              title: title.trim(),
              documentTemplateId: templateId,
              data: data ?? {},
              negotiableVariables: negotiable
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
              participants: parts,
              message: message || null,
            },
          }),
        );
      }
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={kind === "pdf" ? ta("neg.uploadPdf") : ta("neg.new")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          <span>{ta("neg.titleField")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        {kind === "pdf" ? (
          <label className="field">
            <span>PDF</span>
            <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
            <small className="muted">{ta("neg.wordNotice")}</small>
          </label>
        ) : (
          <>
            <label className="field">
              <span>{ta("neg.template")}</span>
              <select
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  const x = templates.find((y) => y.id === e.target.value);
                  setJson(JSON.stringify(x?.sampleData ?? {}, null, 2));
                }}
              >
                {templates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{ta("neg.data")}</span>
              <textarea className="agr-json" value={json} onChange={(e) => setJson(e.target.value)} aria-invalid={!data} />
            </label>
            <label className="field">
              <span>{ta("neg.negotiable")}</span>
              <input value={negotiable} onChange={(e) => setNegotiable(e.target.value)} placeholder={tpl?.analysis?.variables.slice(0, 3).join(", ")} />
            </label>
          </>
        )}
        <fieldset className="field">
          <legend>{ta("neg.participants")}</legend>
          {participants.map((p, i) => (
            <div key={i} className="agr-subrow">
              <input aria-label={ta("ag.name")} placeholder={ta("ag.name")} value={p.name} onChange={(e) => setParticipants(participants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} required />
              <input
                aria-label={ta("ag.email")}
                placeholder={ta("ag.email")}
                type="email"
                value={p.email}
                onChange={(e) => setParticipants(participants.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
                required
              />
              {kind === "template" && (
                <select aria-label={ta("neg.role")} value={p.role} onChange={(e) => setParticipants(participants.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
                  <option value="">—</option>
                  {(tpl?.analysis?.roles ?? []).map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              )}
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setParticipants([...participants, { name: "", email: "", role: "" }])}>
              {ta("neg.addParticipant")}
            </button>
          </div>
        </fieldset>
        <label className="field">
          <span>{ta("neg.message")}</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || (kind === "template" && (!templateId || !data))}>
            {ta("neg.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── Panel compartido ─────────────────────────────

/**
 * `base`: "/v1/negotiations/:id" (remitente) o "/v1/public/negotiations/:token" (contraparte).
 * El remitente decide propuestas y acepta; la contraparte comenta y propone.
 */
export function NegotiationPanel({
  base,
  mode,
  initial,
  onView,
}: {
  base: string;
  mode: "sender" | "participant";
  initial: NegotiationView;
  /** Avisa cada vista nueva (p. ej. para que el encabezado de la página muestre el estado al día). */
  onView?: (v: NegotiationView) => void;
}) {
  const ta = useAgrText();
  const { locale } = useI18n();
  const nav = useNavigate();
  const [view, setView] = useState<NegotiationView>(initial);
  const [sel, setSel] = useState<{ quote: string; start: number | null; end: number | null } | null>(null);
  const [comment, setComment] = useState("");
  const [diff, setDiff] = useState<NegotiationDiff | null>(null);
  const [proposing, setProposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = view.negotiation;
  const open = n.status === "open";

  const call = async (path: string, body: unknown, method: "POST" | "PATCH" = "POST") => {
    setBusy(true);
    setError(null);
    try {
      const v = await api<NegotiationView & { envelope?: { id: string } }>(`${base}${path}`, { method, body });
      setView(v);
      onView?.(v);
      return v;
    } catch (e) {
      setError(errorText(e));
      // 409 (p. ej. version_changed): la negociación cambió en el servidor. Se trae la versión nueva para que el
      // remitente la vea antes de volver a aceptar, en vez de aceptar a ciegas un texto que no tiene en pantalla.
      if (e instanceof HttpError && e.status === 409) {
        await api<NegotiationView>(base)
          .then((fresh) => {
            setView(fresh);
            onView?.(fresh);
          })
          .catch(() => {});
      }
      return null;
    } finally {
      setBusy(false);
    }
  };

  const showDiff = async (to: number) => {
    try {
      setDiff(await api<NegotiationDiff>(`${base}/diff?from=${to - 1}&to=${to}`));
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="stack">
      <ErrorBox error={error} />
      {!open && <div className="alert">{ta("neg.closed")}</div>}
      <div className="agr-split-wide">
        <div className="stack">
          <div className="row-between">
            <span className="muted small">{ta("neg.version", { n: n.currentVersion })}</span>
            <a className="btn btn-sm" href={`${base}/pdf`} target="_blank" rel="noreferrer">
              {ta("neg.pdf")}
            </a>
          </div>
          {n.source === "pdf" ? (
            <>
              <div className="alert">{ta("neg.pdfOnly")}</div>
              <div className="agr-doc">
                {view.text.split(/\n{2,}/).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </>
          ) : (
            <DocPreview blocks={view.blocks} text={view.text} onSelect={open ? setSel : undefined} />
          )}
        </div>
        <div className="agr-sticky">
          {open && (
            <div className="card pad stack">
              <strong>{ta("neg.comments")}</strong>
              {sel ? <div className="agr-quote">“{sel.quote}”</div> : <span className="muted small">{ta("neg.selectHint")}</span>}
              <form
                className="stack"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const v = await call("/comments", { body: comment.trim(), quote: sel?.quote ?? null, start: sel?.start ?? null, end: sel?.end ?? null });
                  if (v) {
                    setComment("");
                    setSel(null);
                  }
                }}
              >
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder={ta("neg.commentPlaceholder")} aria-label={ta("neg.commentPlaceholder")} />
                <div className="row-end">
                  <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !comment.trim()}>
                    {sel ? ta("neg.commentOnSelection") : ta("neg.send")}
                  </button>
                </div>
              </form>
            </div>
          )}
          {view.comments.length > 0 && (
            <div className="stack">
              {view.comments.map((c) => (
                <div key={c.id} className={`agr-comment ${c.resolved ? "resolved" : ""}`}>
                  <div className="row-between small">
                    <strong>{c.author.name}</strong>
                    <span className="muted">
                      v{c.version} · {formatDateTime(c.createdAt, locale)}
                    </span>
                  </div>
                  {c.quote && <div className="agr-quote">“{c.quote}”</div>}
                  <div>{c.body}</div>
                  {mode === "sender" && open && (
                    <div className="row-end">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => call(`/comments/${c.id}`, { resolved: !c.resolved }, "PATCH")}>
                        {c.resolved ? ta("neg.reopen") : ta("neg.resolve")}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="card pad stack">
            <div className="row-between">
              <strong>{ta("neg.proposals")}</strong>
              {mode === "participant" && open && n.source === "template" && view.me?.canPropose && (
                <button type="button" className="btn btn-sm" onClick={() => setProposing(true)}>
                  {ta("neg.propose")}
                </button>
              )}
            </div>
            {view.proposals.length === 0 && <span className="muted small">{ta("neg.noProposals")}</span>}
            {view.proposals.map((p) => (
              <div key={p.id} className="agr-proposal small">
                <div className="row-between">
                  <span>
                    <strong>{p.author.name}</strong> · <code>{p.kind === "clause" ? ta("neg.clauseKey", { key: p.key }) : p.key}</code>
                  </span>
                  <span className={`badge ${p.status === "accepted" ? "badge-completed" : p.status === "rejected" ? "badge-declined" : "badge-expired"}`}>{ta(`neg.${p.status}` as AgreementsTextKey)}</span>
                </div>
                {p.kind === "variable" ? (
                  <div>
                    <span className="agr-old">{p.oldValue || "—"}</span> → <span className="agr-new">{p.newValue}</span>
                  </div>
                ) : (
                  <DiffView parts={[{ op: "del", text: p.oldValue }, { op: "ins", text: `\n${p.newValue}` }]} />
                )}
                {p.comment && <div className="muted">“{p.comment}”</div>}
                {mode === "sender" && open && p.status === "pending" && (
                  <div className="row-wrap">
                    <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => call(`/proposals/${p.id}/decision`, { accept: true })}>
                      {ta("neg.accept")}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => call(`/proposals/${p.id}/decision`, { accept: false })}>
                      {ta("neg.reject")}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="card pad stack small">
            <strong>{ta("neg.versions")}</strong>
            {view.versions
              .slice()
              .reverse()
              .map((v) => (
                <div key={v.version} className="row-between">
                  <span>
                    v{v.version} · {v.summary} <span className="muted">({v.author.name})</span>
                  </span>
                  {v.version > 1 && (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => showDiff(v.version)}>
                      {ta("neg.compare")}
                    </button>
                  )}
                </div>
              ))}
          </div>
          {mode === "sender" && (
            <div className="row-wrap">
              {open && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || view.proposals.some((p) => p.status === "pending")}
                  onClick={async () => {
                    const v = await call("/accept", {});
                    if (v?.envelope) nav(`/app/envelopes/${v.envelope.id}`);
                  }}
                >
                  {ta("neg.acceptAll")}
                </button>
              )}
              {open && (
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => call("/cancel", {})}>
                  {ta("neg.cancel")}
                </button>
              )}
              {n.envelopeId && (
                <Link className="btn" to={`/app/envelopes/${n.envelopeId}`}>
                  {ta("neg.envelope")}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
      {diff && (
        <Modal title={`${ta("diff.title")} · v${diff.from} → v${diff.to}`} onClose={() => setDiff(null)} wide>
          <DiffView parts={diff.parts} />
        </Modal>
      )}
      {proposing && (
        <ProposeModal
          view={view}
          busy={busy}
          error={error}
          onClose={() => setProposing(false)}
          onSubmit={async (body) => {
            const v = await call("/proposals", body);
            if (v) setProposing(false);
          }}
        />
      )}
    </div>
  );
}

function ProposeModal({
  view,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  view: NegotiationView;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (b: unknown) => void;
}) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [kind, setKind] = useState<"variable" | "clause">(view.variables.length ? "variable" : "clause");
  const [key, setKey] = useState(view.variables[0]?.path ?? view.clauses[0]?.slug ?? "");
  const current = kind === "variable" ? view.variables.find((v) => v.path === key)?.value ?? "" : view.clauses.find((c) => c.slug === key)?.text ?? "";
  const [value, setValue] = useState(current);
  const [reason, setReason] = useState("");
  useEffect(() => setValue(current), [kind, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title={ta("neg.propose")} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ kind, key, newValue: value, comment: reason || null });
        }}
      >
        <div className="tabs" role="tablist">
          {view.variables.length > 0 && (
            <button
              type="button"
              className={kind === "variable" ? "active" : ""}
              onClick={() => {
                setKind("variable");
                setKey(view.variables[0].path);
              }}
            >
              {ta("neg.proposeVariable")}
            </button>
          )}
          {view.clauses.length > 0 && (
            <button
              type="button"
              className={kind === "clause" ? "active" : ""}
              onClick={() => {
                setKind("clause");
                setKey(view.clauses[0].slug);
              }}
            >
              {ta("neg.proposeClause")}
            </button>
          )}
        </div>
        <select value={key} onChange={(e) => setKey(e.target.value)} aria-label={kind === "variable" ? ta("neg.proposeVariable") : ta("neg.proposeClause")}>
          {(kind === "variable" ? view.variables.map((v) => v.path) : view.clauses.map((c) => c.slug)).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <label className="field">
          <span>{ta("neg.newValue")}</span>
          {kind === "clause" ? <textarea className="agr-json" value={value} onChange={(e) => setValue(e.target.value)} rows={8} /> : <input value={value} onChange={(e) => setValue(e.target.value)} />}
        </label>
        <label className="field">
          <span>{ta("neg.reason")}</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {/* El error de la propuesta se muestra acá: el del panel queda tapado por el modal. */}
        <ErrorBox error={error} />
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !key || value === current}>
            {ta("neg.send")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NegotiationDetailPage() {
  const { id } = useParams();
  const ta = useAgrText();
  const [view, setView] = useState<NegotiationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<NegotiationView>(`/v1/negotiations/${id}`)
      .then(setView)
      .catch((e) => setError(errorText(e)));
  }, [id]);
  useEffect(load, [load]);
  if (!view) return <div className="page">{error ? <ErrorBox error={error} /> : <Spinner />}</div>;
  return (
    <div className="page">
      <AgreementsTabs />
      <Link to="/app/negotiations" className="muted small">
        {ta("neg.back")}
      </Link>
      <div className="page-head">
        <div>
          <h1>{view.negotiation.title}</h1>
          <div className="row-wrap small muted">
            <NegStatus status={view.negotiation.status} />
            <span>{view.negotiation.participants.map((p) => `${p.name}${p.role ? ` (${p.role})` : ""}`).join(", ")}</span>
          </div>
        </div>
      </div>
      {/* El panel es dueño de la vista; el encabezado (estado, participantes) se actualiza con onView. Sin key: si el panel
          se volviera a montar al cambiar de versión, se perdería el aviso de un 409 (version_changed). */}
      <NegotiationPanel base={`/v1/negotiations/${id}`} mode="sender" initial={view} onView={setView} />
    </div>
  );
}
