// Workflows sin código (Fase 6): listado, editor de pasos (lista vertical), ejecuciones y detalle con aprobación.
import { useCallback, useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CollectField, DocumentTemplateSummary, Member, Workflow, WorkflowRun, WorkflowRunSummary, WorkflowStep, WorkflowStepType } from "@calasign/shared";
import { WORKFLOW_STEP_TYPES } from "@calasign/shared";
import { api, errorText, uuid } from "../lib/api";
import { allowNextNavigation, confirmAction, formatDateTime, placeholderText, useI18n, useUnsavedWarning } from "../lib/i18n";
import { useAccess } from "../lib/access";
import { useAuth } from "../lib/auth";
import { useAgrText, type AgreementsTextKey } from "../lib/i18n-agreements";
import { AgreementsTabs, parseJsonObject } from "../components/AgreementsUi";
import { ErrorBox, Modal, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

type WorkflowWithSecret = Workflow & { signingSecret?: string };

function RunStatus({ status }: { status: WorkflowRun["status"] }) {
  const ta = useAgrText();
  const cls = status === "completed" ? "badge-completed" : status === "failed" || status === "rejected" ? "badge-declined" : status === "cancelled" ? "badge-voided" : "badge-sent";
  return <span className={`badge ${cls}`}>{ta(`run.status.${status}` as AgreementsTextKey)}</span>;
}

// ───────────────────────────── Listado ─────────────────────────────

export function WorkflowsPage() {
  const ta = useAgrText();
  useTitle(ta("wf.title"));
  const { can } = useAccess();
  const nav = useNavigate();
  const [items, setItems] = useState<Workflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: Workflow[] }>("/v1/workflows")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <div className="page">
      <AgreementsTabs />
      <div className="page-head">
        <div>
          <h1>{ta("wf.title")}</h1>
          <p className="muted">{ta("wf.intro")}</p>
        </div>
        {can("templates:manage") && (
          <Link className="btn btn-primary" to="/app/workflows/new">
            {ta("wf.new")}
          </Link>
        )}
      </div>
      <ErrorBox error={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{ta("wf.empty")}</div>
      ) : (
        <div className="card table-scroll">
          <table className="table">
            <tbody>
              {items.map((w) => (
                <tr key={w.id} className="clickable" onClick={() => nav(`/app/workflows/${w.id}`)}>
                  <td>
                    <Link to={`/app/workflows/${w.id}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{w.name}</strong>
                    </Link>
                    <div className="muted small">{w.steps.map((s) => ta(`step.${s.type}` as AgreementsTextKey)).join(" → ")}</div>
                  </td>
                  <td className="small">{w.runs.running > 0 ? ta("wf.running", { n: w.runs.running }) : `${w.runs.total}`}</td>
                  <td>{!w.active && <span className="badge badge-voided">—</span>}</td>
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

// uuid() de lib/api: crypto.randomUUID no existe fuera de contextos seguros (p. ej. http://IP) y agregar un paso fallaba.
const uid = () => uuid();

function newStep(type: WorkflowStepType, ta: (k: AgreementsTextKey) => string, me: string | null): WorkflowStep {
  const name = ta(`step.${type}` as AgreementsTextKey);
  switch (type) {
    case "collect_data":
      return { id: uid(), name, type, config: { title: name, target: "cliente", fields: [{ key: "nombre", label: ta("wf.def.name"), type: "text", required: true }, { key: "email", label: ta("wf.def.email"), type: "email", required: true }] } };
    case "approval":
      return { id: uid(), name, type, config: { approverUserId: me ?? "", message: null } };
    case "generate_document":
      return { id: uid(), name, type, config: { documentTemplateId: "", output: "documento", allowMissing: false } };
    case "send_for_signature":
      return { id: uid(), name, type, config: { document: "documento", envelopeKey: "firma", subject: `${ta("wf.def.subject")} {{cliente.nombre}}`, recipients: [{ role: ta("wf.def.role"), name: "{{cliente.nombre}}", email: "{{cliente.email}}" }] } };
    case "wait_for_completion":
      return { id: uid(), name, type, config: { envelopeKey: "firma" } };
    case "http_request":
      return { id: uid(), name, type, config: { url: "https://", method: "POST", headers: null, bodyTemplate: null, saveAs: null } };
    case "update_repository":
      return { id: uid(), name, type, config: { envelopeKey: "firma", tags: [], metadata: null } };
  }
}

const parseList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Lista separada por comas. El texto escrito se guarda tal cual mientras se tipea: si el input mostraba la lista ya
 * normalizada (join), la coma y el espacio recién tipeados desaparecían y no se podía cargar más de un valor.
 */
function ListInput({ value, onChange, ...rest }: { value: string[]; onChange: (v: string[]) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [text, setText] = useState(value.join(", "));
  // Cambio desde afuera (p. ej. se borró una fila y esta pasó a mostrar otra): se vuelve a mostrar la lista.
  useEffect(() => {
    if (parseList(text).join("\u0000") !== value.join("\u0000")) setText(value.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.join("\u0000")]);
  return (
    <input
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
    />
  );
}

function F({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function StepConfig({ step, onChange, members, templates }: { step: WorkflowStep; onChange: (s: WorkflowStep) => void; members: Member[]; templates: DocumentTemplateSummary[] }) {
  const ta = useAgrText();
  const { t: tc } = useI18n();
  const set = (patch: Record<string, unknown>) => onChange({ ...step, config: { ...step.config, ...patch } } as WorkflowStep);
  switch (step.type) {
    case "collect_data": {
      const c = step.config;
      const setField = (i: number, patch: Partial<CollectField>) => set({ fields: c.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
      return (
        <>
          <div className="grid-2">
            <F label={ta("cfg.title")}>
              <input value={c.title} onChange={(e) => set({ title: e.target.value })} />
            </F>
            <F label={ta("cfg.target")}>
              <input value={c.target ?? ""} onChange={(e) => set({ target: e.target.value || null })} placeholder={placeholderText("collectTarget")} />
            </F>
          </div>
          <fieldset className="field">
            <legend>{ta("cfg.fields")}</legend>
            {c.fields.map((f, i) => (
              <div key={i} className="agr-subrow">
                <input aria-label={ta("fields.label")} value={f.label} onChange={(e) => setField(i, { label: e.target.value })} placeholder={ta("fields.label")} />
                <input aria-label={ta("fields.key")} value={f.key} onChange={(e) => setField(i, { key: e.target.value })} placeholder={ta("fields.key")} />
                <select aria-label={ta("fields.type")} value={f.type} onChange={(e) => setField(i, { type: e.target.value as CollectField["type"] })}>
                  {(["text", "textarea", "email", "number", "date", "select"] as const).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
                {f.type === "select" && (
                  <ListInput aria-label={ta("fields.options")} value={f.options ?? []} onChange={(options) => setField(i, { options })} placeholder="A, B" />
                )}
                <label className="check">
                  <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> {ta("cfg.required")}
                </label>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ fields: c.fields.filter((_, j) => j !== i) })} aria-label={tc("common.delete")}>
                  ×
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  // Con `campo${cantidad + 1}`, quitar un campo y agregar otro repetía una clave existente: los dos campos
                  // compartían el valor en el formulario público (escribir en uno llenaba el otro).
                  let n = c.fields.length + 1;
                  while (c.fields.some((f) => f.key === `campo${n}`)) n++;
                  set({ fields: [...c.fields, { key: `campo${n}`, label: ta("wf.def.field"), type: "text", required: false }] });
                }}
              >
                {ta("cfg.addField")}
              </button>
            </div>
          </fieldset>
        </>
      );
    }
    case "approval":
      return (
        <div className="grid-2">
          <F label={ta("cfg.approver")}>
            <select value={step.config.approverUserId} onChange={(e) => set({ approverUserId: e.target.value })}>
              <option value="">—</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} ({m.email})
                </option>
              ))}
            </select>
          </F>
          <F label={ta("cfg.message")}>
            <input value={step.config.message ?? ""} onChange={(e) => set({ message: e.target.value || null })} />
          </F>
        </div>
      );
    case "generate_document":
      return (
        <div className="grid-2">
          <F label={ta("cfg.template")}>
            <select value={step.config.documentTemplateId} onChange={(e) => set({ documentTemplateId: e.target.value })}>
              <option value="">—</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </F>
          <F label={ta("cfg.output")}>
            <input value={step.config.output} onChange={(e) => set({ output: e.target.value })} />
          </F>
          <label className="check">
            <input type="checkbox" checked={!!step.config.allowMissing} onChange={(e) => set({ allowMissing: e.target.checked })} /> {ta("cfg.allowMissing")}
          </label>
        </div>
      );
    case "send_for_signature": {
      const c = step.config;
      const setR = (i: number, patch: Record<string, unknown>) => set({ recipients: c.recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
      return (
        <>
          <div className="grid-2">
            <F label={ta("cfg.document")}>
              <input value={c.document} onChange={(e) => set({ document: e.target.value })} />
            </F>
            <F label={ta("cfg.envelopeKey")}>
              <input value={c.envelopeKey} onChange={(e) => set({ envelopeKey: e.target.value })} />
            </F>
          </div>
          <F label={ta("cfg.subject")}>
            <input value={c.subject} onChange={(e) => set({ subject: e.target.value })} />
          </F>
          <fieldset className="field">
            <legend>{ta("cfg.recipients")}</legend>
            {c.recipients.map((r, i) => (
              <div key={i} className="agr-subrow">
                <input aria-label={ta("neg.role")} value={r.role} onChange={(e) => setR(i, { role: e.target.value })} placeholder={ta("neg.role")} />
                <input aria-label={ta("ag.name")} value={r.name} onChange={(e) => setR(i, { name: e.target.value })} placeholder="{{cliente.nombre}}" />
                <input aria-label={ta("ag.email")} value={r.email ?? ""} onChange={(e) => setR(i, { email: e.target.value })} placeholder="{{cliente.email}}" />
                <label className="check">
                  <input type="checkbox" checked={!!r.cc} onChange={(e) => setR(i, { cc: e.target.checked })} /> {ta("cfg.cc")}
                </label>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ recipients: c.recipients.filter((_, j) => j !== i) })} aria-label={tc("common.delete")}>
                  ×
                </button>
              </div>
            ))}
            <div>
              <button type="button" className="btn btn-sm" onClick={() => set({ recipients: [...c.recipients, { role: "", name: "", email: "" }] })}>
                {ta("cfg.addRecipient")}
              </button>
            </div>
          </fieldset>
        </>
      );
    }
    case "wait_for_completion":
      return (
        <F label={ta("cfg.envelopeKey")}>
          <input value={step.config.envelopeKey} onChange={(e) => set({ envelopeKey: e.target.value })} />
        </F>
      );
    case "http_request":
      return (
        <>
          <div className="grid-2">
            <F label={ta("cfg.url")}>
              <input type="url" value={step.config.url} onChange={(e) => set({ url: e.target.value })} />
            </F>
            <div className="grid-2">
              <F label={ta("cfg.method")}>
                <select value={step.config.method} onChange={(e) => set({ method: e.target.value })}>
                  <option>POST</option>
                  <option>PUT</option>
                </select>
              </F>
              <F label={ta("cfg.saveAs")}>
                <input value={step.config.saveAs ?? ""} onChange={(e) => set({ saveAs: e.target.value || null })} />
              </F>
            </div>
          </div>
          <F label={ta("cfg.body")}>
            <textarea className="agr-json" value={step.config.bodyTemplate ?? ""} onChange={(e) => set({ bodyTemplate: e.target.value || null })} placeholder='{"cliente": {{cliente.nombre}}}' />
          </F>
        </>
      );
    case "update_repository":
      return (
        <div className="grid-2">
          <F label={ta("cfg.envelopeKey")}>
            <input value={step.config.envelopeKey} onChange={(e) => set({ envelopeKey: e.target.value })} />
          </F>
          <F label={ta("cfg.tags")}>
            <ListInput value={step.config.tags ?? []} onChange={(tags) => set({ tags })} />
          </F>
          <F label={ta("cfg.expiry")}>
            <input value={step.config.expiryDate ?? ""} onChange={(e) => set({ expiryDate: e.target.value || null })} placeholder="{{contrato.vencimiento}}" />
          </F>
          <F label={ta("cfg.value")}>
            <input value={step.config.value ?? ""} onChange={(e) => set({ value: e.target.value || null })} placeholder="{{total}}" />
          </F>
        </div>
      );
  }
}

export function WorkflowEditPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const ta = useAgrText();
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const { me: session } = useAuth();
  const nav = useNavigate();
  const [wf, setWf] = useState<WorkflowWithSecret | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [publicStart, setPublicStart] = useState(false);
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [templates, setTemplates] = useState<DocumentTemplateSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<WorkflowStepType>("collect_data");
  const [starting, setStarting] = useState(false);
  const editable = can("templates:manage");

  const loadRuns = useCallback(() => {
    if (isNew) return;
    api<{ items: WorkflowRunSummary[] }>(`/v1/workflow-runs?workflowId=${id}`)
      .then((r) => setRuns(r.items))
      .catch(() => undefined);
  }, [id, isNew]);

  useEffect(() => {
    api<{ items: Member[] }>("/v1/members").then((r) => setMembers(r.items)).catch(() => undefined);
    api<{ items: DocumentTemplateSummary[] }>("/v1/document-templates").then((r) => setTemplates(r.items)).catch(() => undefined);
    if (isNew) {
      setName(ta("wf.new"));
      return;
    }
    api<WorkflowWithSecret>(`/v1/workflows/${id}`)
      .then((w) => {
        setWf(w);
        setName(w.name);
        setDescription(w.description ?? "");
        setActive(w.active);
        setPublicStart(w.publicStart);
        setSteps(w.steps);
      })
      .catch((e) => setError(errorText(e)));
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const me = session?.user.id ?? null;
  const move = (i: number, d: number) => {
    const next = [...steps];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    setSteps(next);
  };

  const draft = { name: name.trim(), description: description.trim() || null, active, publicStart, steps };
  // Sin cambios no se guarda al iniciar: cada "Iniciar" dejaba un PATCH y un "workflow.updated" en la auditoría.
  const dirty = !wf || JSON.stringify(draft) !== JSON.stringify({ name: wf.name, description: wf.description, active: wf.active, publicStart: wf.publicStart, steps: wf.steps });
  // Aviso al salir: un flujo nuevo solo si ya se escribió algo; uno existente, cuando ya cargó y difiere de lo guardado.
  useUnsavedWarning(
    editable && (isNew ? !!(description.trim() || steps.length || (name.trim() && name.trim() !== ta("wf.new"))) : !!wf && dirty),
  );

  /** Guarda el flujo; devuelve false si no se pudo (para no iniciar una ejecución con la versión anterior). */
  const save = async (e?: FormEvent): Promise<boolean> => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = draft;
      // X-Expected-Updated-At: si otra pestaña u otra persona lo guardó mientras tanto, 409 version_changed en vez de
      // pisar sus cambios.
      const w = isNew
        ? await api<WorkflowWithSecret>("/v1/workflows", { method: "POST", body })
        : await api<WorkflowWithSecret>(`/v1/workflows/${id}`, { method: "PATCH", body, headers: wf ? { "X-Expected-Updated-At": wf.updatedAt } : undefined });
      if (isNew) {
        // Recién guardado: pasar a la URL del flujo creado no es salir con cambios sin guardar.
        allowNextNavigation();
        nav(`/app/workflows/${w.id}`, { replace: true });
      }
      setWf(w);
      setSteps(w.steps);
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

  return (
    <div className="page">
      <AgreementsTabs />
      <Link to="/app/workflows" className="muted small">
        {ta("wf.back")}
      </Link>
      <form className="stack" onSubmit={save}>
        <div className="page-head">
          <input className="agr-title-input" value={name} onChange={(e) => setName(e.target.value)} aria-label={ta("wf.name")} required disabled={!editable} />
          <div className="row-wrap">
            {saved && <span className="muted small">✓ {ta("wf.saved")}</span>}
            {wf && wf.active && (
              <button
                type="button"
                className="btn"
                // Con "activo" destildado, guardar antes desactivaba el flujo y la ejecución fallaba ("desactivado").
                disabled={busy || !active}
                onClick={async () => {
                  // La ejecución usa lo guardado en el servidor: sin guardar antes, los pasos editados se ignoraban.
                  if (editable && dirty && !(await save())) return;
                  setStarting(true);
                }}
              >
                {ta("wf.start")}
              </button>
            )}
            {editable && (
              <button type="submit" className="btn btn-primary" disabled={busy || steps.length === 0}>
                {busy ? t("common.saving") : ta("wf.save")}
              </button>
            )}
          </div>
        </div>
        <ErrorBox error={error} />
        <div className="agr-split-wide">
          <div className="stack">
            <fieldset className="stack" disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }}>
              <label className="field">
                <span>{ta("wf.description")}</span>
                <input value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              <div className="row-wrap">
                <label className="check">
                  <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {ta("wf.active")}
                </label>
                <label className="check">
                  <input type="checkbox" checked={publicStart} onChange={(e) => setPublicStart(e.target.checked)} /> {ta("wf.public")}
                </label>
              </div>
              <h2>{ta("wf.steps")}</h2>
              <ol className="agr-steps">
                {steps.map((s, i) => (
                  <li key={s.id} className="agr-step">
                    <div className="agr-step-head">
                      <span className="agr-step-num" aria-hidden="true" />
                      <div className="grow">
                        <div className="agr-step-type">{ta(`step.${s.type}` as AgreementsTextKey)}</div>
                        <input aria-label={ta("step.name")} value={s.name} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? ({ ...x, name: e.target.value } as WorkflowStep) : x)))} />
                      </div>
                      <div className="agr-step-actions">
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={ta("wf.moveUp")} title={ta("wf.moveUp")}>
                          ↑
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={ta("wf.moveDown")} title={ta("wf.moveDown")}>
                          ↓
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label={ta("wf.remove")} title={ta("wf.remove")}>
                          ×
                        </button>
                      </div>
                    </div>
                    <div className="agr-step-body">
                      <StepConfig step={s} members={members} templates={templates} onChange={(ns) => setSteps(steps.map((x, j) => (j === i ? ns : x)))} />
                    </div>
                  </li>
                ))}
              </ol>
              <div className="row-wrap">
                <select value={adding} onChange={(e) => setAdding(e.target.value as WorkflowStepType)} aria-label={ta("wf.addStep")}>
                  {WORKFLOW_STEP_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {ta(`step.${x}` as AgreementsTextKey)}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn" onClick={() => setSteps([...steps, newStep(adding, ta, me)])}>
                  {ta("wf.addStep")}
                </button>
              </div>
            </fieldset>
          </div>
          <div className="agr-sticky">
            {wf?.publicUrl && (
              <div className="card pad stack small">
                <strong>{ta("wf.publicUrl")}</strong>
                <a href={wf.publicUrl} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>
                  {wf.publicUrl}
                </a>
              </div>
            )}
            {wf?.signingSecret && (
              <div className="card pad stack small">
                <strong>{ta("wf.secret")}</strong>
                <code style={{ wordBreak: "break-all" }}>{wf.signingSecret}</code>
              </div>
            )}
            {!isNew && (
              <div className="card pad stack">
                <strong>{ta("wf.runs")}</strong>
                {runs.length === 0 ? (
                  <span className="muted small">{ta("wf.noRuns")}</span>
                ) : (
                  runs.slice(0, 20).map((r) => (
                    <Link key={r.id} to={`/app/workflow-runs/${r.id}`} className="row-between small">
                      <span>{formatDateTime(r.createdAt, locale)}</span>
                      <RunStatus status={r.status} />
                    </Link>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </form>
      {starting && wf && (
        <StartModal
          workflowId={wf.id}
          onClose={() => setStarting(false)}
          onStarted={(r) => {
            setStarting(false);
            nav(`/app/workflow-runs/${r.id}`);
          }}
        />
      )}
    </div>
  );
}

function StartModal({ workflowId, onClose, onStarted }: { workflowId: string; onClose: () => void; onStarted: (r: WorkflowRun) => void }) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [json, setJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  // Sin esto, un doble clic iniciaba dos ejecuciones (y, con un paso de firma, mandaba dos sobres).
  // El ref corta también dos clics seguidos, antes de que el botón llegue a deshabilitarse.
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const data = parseJsonObject(json);
  return (
    <Modal title={ta("wf.start")} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (inFlight.current) return;
          inFlight.current = true;
          setBusy(true);
          setError(null);
          try {
            onStarted(await api<WorkflowRun>(`/v1/workflows/${workflowId}/runs`, { method: "POST", body: { data: data ?? {} } }));
          } catch (err) {
            setError(errorText(err));
            inFlight.current = false;
            setBusy(false);
          }
        }}
      >
        <ErrorBox error={error} />
        <label className="field">
          <span>{ta("wf.startData")}</span>
          <textarea className="agr-json" value={json} onChange={(e) => setJson(e.target.value)} aria-invalid={!data} />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!data || busy}>
            {ta("wf.start")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── Ejecución ─────────────────────────────

export function WorkflowRunPage() {
  const { id } = useParams();
  const ta = useAgrText();
  const { locale } = useI18n();
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Error del refresco, aparte del de las acciones: se limpia cuando el refresco vuelve a responder.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  // Solo se aplica la respuesta más reciente: un refresco pedido antes de aprobar o cancelar que respondía después
  // volvía a mostrar el paso pendiente (con los botones habilitados) y un segundo clic fallaba.
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    api<WorkflowRun>(`/v1/workflow-runs/${id}`)
      .then((r) => {
        if (mine !== seq.current) return;
        setRun(r);
        setLoadError(null);
      })
      .catch((e) => mine === seq.current && setLoadError(errorText(e)));
  }, [id]);
  useEffect(load, [load]);
  // Mientras está en curso, se refresca.
  useEffect(() => {
    if (!run || !["running", "waiting"].includes(run.status)) return;
    const h = window.setInterval(load, 4000);
    return () => window.clearInterval(h);
  }, [run, load]);

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<WorkflowRun>(path, { method: "POST", body });
      // Descarta los refrescos que estaban en camino (traen el estado de antes de la acción).
      seq.current++;
      setRun(r);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // El comentario es de una decisión: una vez registrada se limpia (si no, aparecía ya escrito en la aprobación siguiente).
  const decide = async (index: number, approve: boolean) => {
    if (await act(`/v1/workflow-runs/${id}/steps/${index}/decision`, { approve, comment: comment.trim() || null })) setComment("");
  };

  if (!run) return <div className="page">{loadError ? <ErrorBox error={loadError} /> : <Spinner />}</div>;
  const failedStep = run.steps.find((s) => s.status === "failed");
  return (
    <div className="page">
      <AgreementsTabs />
      <Link to={`/app/workflows/${run.workflowId}`} className="muted small">
        {ta("run.back")}
      </Link>
      <div className="page-head">
        <div>
          <h1>{run.workflowName}</h1>
          <div className="row-wrap small muted">
            <RunStatus status={run.status} />
            <span>
              {ta("run.startedBy")}: {run.startedBy ?? "—"} · {formatDateTime(run.createdAt, locale)}
            </span>
          </div>
        </div>
        <div className="row-wrap">
          {run.canManage !== false && run.status === "failed" && !run.dataPurgedAt && failedStep && failedStep.type !== "approval" && failedStep.type !== "wait_for_completion" && (
            <button type="button" className="btn" disabled={busy} onClick={() => act(`/v1/workflow-runs/${run.id}/retry`)}>
              {ta("run.retry")}
            </button>
          )}
          {/* Un run fallado también se cancela (anula los sobres que dejó en firma). */}
          {run.canManage !== false && ["running", "waiting", "failed"].includes(run.status) && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => confirmAction() && act(`/v1/workflow-runs/${run.id}/cancel`)}>
              {ta("run.cancel")}
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={error ?? loadError} />
      {run.dataPurgedAt && (
        <div className="alert" role="status" style={{ marginBottom: "1rem" }}>
          {ta("run.purged")} <span className="muted small">({formatDateTime(run.dataPurgedAt, locale)})</span>
        </div>
      )}
      {run.collectUrl && (
        <div className="card pad small stack" style={{ marginBottom: "1rem" }}>
          <strong>{ta("run.collectLink")}</strong>
          <a href={run.collectUrl} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>
            {run.collectUrl}
          </a>
        </div>
      )}
      <div className="agr-split-wide">
        <div className="card pad">
          {run.steps.map((s) => (
            <div key={s.index} className="agr-run-step">
              <span className={`agr-dot agr-dot-${s.status}`} aria-hidden="true" />
              <div>
                <div>
                  <strong>{s.name}</strong> <span className="muted small">· {ta(`step.${s.type}` as AgreementsTextKey)}</span>
                </div>
                {s.error && <div className="agr-run-err">{s.error}</div>}
                {s.output && Object.keys(s.output).length > 0 && <div className="agr-run-out">{formatOutput(s.output)}</div>}
                {s.output?.envelopeId ? (
                  <Link className="small" to={`/app/envelopes/${String(s.output.envelopeId)}`}>
                    → {String(s.output.envelopeId).slice(0, 8)}…
                  </Link>
                ) : null}
                {s.type === "approval" && s.status === "waiting" && s.canDecide && (
                  <div className="stack" style={{ marginTop: "0.6rem" }}>
                    <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={ta("run.comment")} aria-label={ta("run.comment")} />
                    <div className="row-wrap">
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(s.index, true)}>
                        {ta("run.approve")}
                      </button>
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => decide(s.index, false)}>
                        {ta("run.reject")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="small muted" style={{ textAlign: "right" }}>
                {ta(`stepst.${s.status}` as AgreementsTextKey)}
                {s.attempts > 1 && <div>{ta("run.attempts", { n: s.attempts })}</div>}
              </div>
            </div>
          ))}
        </div>
        <div className="card pad stack">
          <strong>{ta("run.data")}</strong>
          {run.redacted ? (
            <p className="muted small">{ta("run.redacted")}</p>
          ) : (
            <pre className="agr-run-out">{JSON.stringify(run.context.data, null, 2)}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

function formatOutput(o: Record<string, unknown>) {
  return Object.entries(o)
    .filter(([k]) => k !== "envelopeId")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("\n");
}
