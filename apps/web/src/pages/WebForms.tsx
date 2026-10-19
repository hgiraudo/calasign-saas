// Formularios web públicos (Fase 4): listado, editor y detalle con link, código para embeber y sobres creados.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { EnvelopeStatus, TemplateDetail, TemplateSummary, WebForm } from "@calasign/shared";
import { PREFILLABLE_FIELD_TYPES } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useScaleText } from "../lib/i18n-scale";
import { ErrorBox, Modal, Spinner, StatusBadge } from "../components/ui";

function CopyButton({ text }: { text: string }) {
  const st = useScaleText();
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          window.setTimeout(() => setOk(false), 1500);
        } catch {
          /* sin permiso de portapapeles */
        }
      }}
    >
      {ok ? `✓ ${st("forms.copied")}` : st("forms.copy")}
    </button>
  );
}

// ───────────────────────────── Editor ─────────────────────────────

function localDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface FixedDraft {
  name: string;
  email: string;
}

function WebFormEditor({ form, initialTemplateId, onClose, onSaved }: { form: WebForm | null; initialTemplateId?: string; onClose: () => void; onSaved: (f: WebForm) => void }) {
  const st = useScaleText();
  const { t } = useI18n();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templateId, setTemplateId] = useState(form?.templateId ?? initialTemplateId ?? "");
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState(form?.name ?? "");
  const [description, setDescription] = useState(form?.description ?? "");
  const [signerRoleId, setSignerRoleId] = useState(form?.signerRoleId ?? "");
  const [fixed, setFixed] = useState<Record<string, FixedDraft>>(
    Object.fromEntries((form?.fixedRecipients ?? []).map((r) => [r.roleId, { name: r.name, email: r.email ?? "" }])),
  );
  // Lo que el editor no muestra de cada destinatario fijo (teléfono, canales, idioma: se cargan por API) se conserva al
  // guardar: antes se mandaba solo nombre y correo con el canal email, y editar cualquier otra cosa del formulario dejaba
  // a un destinatario por WhatsApp sin teléfono ni canal (y sin correo, el guardado ni siquiera era posible).
  const savedFixed = useMemo(() => new Map((form?.fixedRecipients ?? []).map((r) => [r.roleId, r])), [form]);
  const fixedChannels = (roleId: string) => {
    const ch = savedFixed.get(roleId)?.channels;
    return ch && ch.length ? ch : ["email"];
  };
  const [prefill, setPrefill] = useState<Record<string, string>>(form?.prefill ?? {});
  const [active, setActive] = useState(form?.active ?? true);
  const [maxUses, setMaxUses] = useState<string>(form?.maxUses ? String(form.maxUses) : "");
  // Fecha local (el guardado usa 23:59:59 local): con slice del ISO en UTC, en América la fecha corría un día en cada edición.
  const [expiresAt, setExpiresAt] = useState(form?.expiresAt ? localDateInput(form.expiresAt) : "");
  const [requireOtp, setRequireOtp] = useState(form?.requireOtp ?? false);
  const [collectPhone, setCollectPhone] = useState(form?.collectPhone ?? false);
  const [embeddable, setEmbeddable] = useState(form?.embeddable ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (form) return;
    api<{ items: TemplateSummary[] }>("/v1/templates")
      .then((r) => {
        setTemplates(r.items);
        // Una plantilla de la URL que no está en la lista (borrada o sin acceso): el select mostraba la primera pero se
        // seguía usando la de la URL (error al cargarla y "Guardar" deshabilitado).
        setTemplateId((cur) => (r.items.some((x) => x.id === cur) ? cur : (r.items[0]?.id ?? "")));
      })
      .catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!templateId) return;
    // Solo se aplica la respuesta de la plantilla elegida ahora: una respuesta lenta de la anterior (p. ej. la de la
    // URL) dejaba sus roles en pantalla y el formulario se guardaba con un rol que no es de esta plantilla.
    let stale = false;
    // Mientras carga la nueva (o si falla), no quedan los roles de la anterior: "Guardar" seguía habilitado y mandaba
    // la plantilla nueva con el rol firmante y los destinatarios fijos de la otra.
    setTpl(null);
    api<TemplateDetail>(`/v1/templates/${templateId}`)
      .then((d) => {
        if (stale) return;
        setTpl(d);
        // El error de una plantilla anterior (p. ej. la de la URL, inexistente) no queda a la vista.
        setError(null);
        const signers = d.roles.filter((r) => r.role === "signer");
        // Solo vale un rol firmante: si el rol guardado pasó a copia o aprobador, el select mostraba otro firmante pero
        // se guardaba el viejo.
        setSignerRoleId((cur) => (signers.some((r) => r.id === cur) ? cur : (signers[0]?.id ?? "")));
        if (!form) setName((n) => n || d.template.name);
      })
      .catch((e) => !stale && setError(errorText(e)));
    return () => {
      stale = true;
    };
  }, [templateId, form]);

  const otherRoles = (tpl?.roles ?? []).filter((r) => r.id !== signerRoleId);
  const prefillable = useMemo(() => {
    const seen = new Set<string>();
    return (tpl?.fields ?? []).filter((f) => {
      if (f.readOnly || f.formula || !f.label || !PREFILLABLE_FIELD_TYPES.includes(f.type)) return false;
      if (seen.has(f.label)) return false;
      seen.add(f.label);
      return true;
    });
  }, [tpl]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      signerRoleId,
      fixedRecipients: otherRoles.map((r) => ({
        roleId: r.id,
        name: fixed[r.id]?.name?.trim() ?? "",
        email: fixed[r.id]?.email?.trim() || null,
        phone: savedFixed.get(r.id)?.phone ?? null,
        locale: savedFixed.get(r.id)?.locale ?? null,
        channels: fixedChannels(r.id),
      })),
      // Solo etiquetas de esta plantilla: lo cargado para otra plantilla elegida antes quedaba oculto pero se mandaba, y
      // el guardado fallaba con "no hay ningún campo …" sin forma de borrarlo.
      prefill: Object.fromEntries(Object.entries(prefill).filter(([k, v]) => v.trim() && (!tpl || prefillable.some((f) => f.label === k)))),
      active,
      maxUses: maxUses ? Number(maxUses) : null,
      expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      requireOtp,
      collectPhone,
      embeddable,
    };
    try {
      const saved = form
        ? await api<WebForm>(`/v1/web-forms/${form.id}`, { method: "PATCH", body })
        : await api<WebForm>("/v1/web-forms", { method: "POST", body: { ...body, templateId } });
      onSaved(saved);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={form ? st("forms.edit") : st("forms.new")} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <ErrorBox error={error} />
        {!form && (
          <label className="field">
            <span>{st("bulk.template")}</span>
            {templates === null ? (
              <Spinner />
            ) : templates.length === 0 ? (
              <span className="muted small">{st("bulk.noTemplates")}</span>
            ) : (
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {templates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        <label className="field">
          <span>{st("forms.name")}</span>
          <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>
            {st("forms.description")} <span className="muted">({t("common.optional")})</span>
          </span>
          <textarea rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {tpl && (
          <>
            <label className="field">
              <span>{st("forms.signerRole")}</span>
              <select value={signerRoleId} onChange={(e) => setSignerRoleId(e.target.value)}>
                {tpl.roles
                  .filter((r) => r.role === "signer")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            {otherRoles.length > 0 && (
              <fieldset className="field">
                <legend>{st("forms.fixed")}</legend>
                <small className="muted">{st("forms.fixedHint")}</small>
                {otherRoles.map((r) => (
                  <div key={r.id} className="grid-2">
                    <label className="field">
                      <span>
                        {r.name} — {t("field.name")}
                      </span>
                      <input required value={fixed[r.id]?.name ?? ""} onChange={(e) => setFixed((x) => ({ ...x, [r.id]: { ...(x[r.id] ?? { email: "" }), name: e.target.value } }))} />
                    </label>
                    <label className="field">
                      <span>Email</span>
                      <input required={fixedChannels(r.id).includes("email")} type="email" value={fixed[r.id]?.email ?? ""} onChange={(e) => setFixed((x) => ({ ...x, [r.id]: { ...(x[r.id] ?? { name: "" }), email: e.target.value } }))} />
                    </label>
                  </div>
                ))}
              </fieldset>
            )}
            {prefillable.length > 0 && (
              <fieldset className="field">
                <legend>
                  {st("forms.prefill")} <span className="muted">({t("common.optional")})</span>
                </legend>
                <div className="grid-2">
                  {prefillable.map((f) => (
                    <label key={f.id} className="field">
                      <span>{f.label}</span>
                      {f.type === "dropdown" ? (
                        <select value={prefill[f.label!] ?? ""} onChange={(e) => setPrefill((p) => ({ ...p, [f.label!]: e.target.value }))}>
                          <option value="">—</option>
                          {(f.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input value={prefill[f.label!] ?? ""} onChange={(e) => setPrefill((p) => ({ ...p, [f.label!]: e.target.value }))} />
                      )}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </>
        )}
        <fieldset className="field">
          <legend>{st("forms.options")}</legend>
          <div className="grid-2">
            <label className="field">
              <span>{st("forms.maxUses")}</span>
              <input type="number" min={1} placeholder={st("forms.unlimited")} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
            </label>
            <label className="field">
              <span>{st("forms.expiresAt")}</span>
              <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            {st("forms.active")}
          </label>
          <label className="check">
            <input type="checkbox" checked={requireOtp} onChange={(e) => setRequireOtp(e.target.checked)} />
            {st("forms.requireOtp")}
          </label>
          <label className="check">
            <input type="checkbox" checked={collectPhone} onChange={(e) => setCollectPhone(e.target.checked)} />
            {st("forms.collectPhone")}
          </label>
          <label className="check">
            <input type="checkbox" checked={embeddable} onChange={(e) => setEmbeddable(e.target.checked)} />
            {st("forms.embeddable")}
          </label>
        </fieldset>
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !tpl || !name.trim() || !signerRoleId}>
            {busy ? t("common.saving") : st("forms.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Motivo por el que el formulario no se ofrece al público, traducido por código (el texto de la API viene en español). */
function inactiveWhy(f: WebForm, st: ReturnType<typeof useScaleText>): string | null {
  if (f.ownerInactiveCode) return st(`forms.why.${f.ownerInactiveCode}` as const);
  return f.ownerInactiveReason ?? null;
}

// ───────────────────────────── Listado ─────────────────────────────

export function WebFormsPage() {
  const st = useScaleText();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [items, setItems] = useState<WebForm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(Boolean(params.get("template")));

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: WebForm[] }>("/v1/web-forms")).items);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{st("forms.title")}</h1>
          <p className="muted">{st("forms.intro")}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          + {st("forms.new")}
        </button>
      </div>
      <ErrorBox error={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{st("forms.empty")}</div>
      ) : (
        <div className="forms-grid">
          {items.map((f) => (
            <div key={f.id} className="card pad form-card">
              <div className="grow">
                <h3>
                  <Link to={`/app/forms/${f.id}`}>{f.name}</Link> {!f.active && <span className="badge badge-voided">{st("forms.inactive")}</span>}
                  {f.active && inactiveWhy(f, st) && (
                    <span className="badge badge-declined" title={inactiveWhy(f, st) ?? undefined}>
                      {st("forms.ownerInactive")}
                    </span>
                  )}
                </h3>
                {inactiveWhy(f, st) && <p className="small error-text">{inactiveWhy(f, st)}</p>}
                <p className="muted small">
                  {f.templateName} · {st("forms.uses")}: {f.uses}
                  {f.maxUses ? `/${f.maxUses}` : ""}
                </p>
                <div className="link-box">
                  <input readOnly value={f.url} aria-label={st("forms.link")} onFocus={(e) => e.currentTarget.select()} />
                  <CopyButton text={f.url} />
                </div>
              </div>
              <Link className="btn btn-sm" to={`/app/forms/${f.id}`}>
                →
              </Link>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <WebFormEditor
          form={null}
          initialTemplateId={params.get("template") ?? undefined}
          onClose={() => setCreating(false)}
          onSaved={(f) => nav(`/app/forms/${f.id}`)}
        />
      )}
    </div>
  );
}

// ───────────────────────────── Detalle ─────────────────────────────

interface FormEnvelope {
  id: string;
  subject: string;
  status: EnvelopeStatus;
  createdAt: string;
  completedAt: string | null;
  recipients: { name: string; email: string | null; status: string; role: string }[];
}

export function WebFormDetailPage() {
  const { id = "" } = useParams();
  const st = useScaleText();
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const [form, setForm] = useState<WebForm | null>(null);
  const [envs, setEnvs] = useState<FormEnvelope[]>([]);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [f, e] = await Promise.all([api<WebForm>(`/v1/web-forms/${id}`), api<{ items: FormEnvelope[] }>(`/v1/web-forms/${id}/envelopes`)]);
      setForm(f);
      setEnvs(e.items);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!form) return error ? <ErrorBox error={error} /> : <Spinner />;
  const snippet = `<iframe src="${form.url}?embed=1" style="width:100%;min-height:720px;border:0" allow="clipboard-write"></iframe>`;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="muted small">
            <Link to="/app/forms">← {st("forms.title")}</Link>
          </p>
          <h1>
            {form.name} {!form.active && <span className="badge badge-voided">{st("forms.inactive")}</span>}
          </h1>
          <p className="muted small">
            {form.templateName} · {st("forms.uses")}: {form.uses}
            {form.maxUses ? `/${form.maxUses}` : ""}
            {form.expiresAt ? ` · ${st("forms.expiresAt")}: ${formatDateTime(form.expiresAt, locale)}` : ""}
          </p>
        </div>
        <div className="row-wrap">
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            {st("forms.edit")}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
            {st("forms.delete")}
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
      {inactiveWhy(form, st) && (
        <div className="alert alert-warn" role="status">
          <strong>{st("forms.ownerInactive")}:</strong> {inactiveWhy(form, st)}
          <p className="small">{st(form.ownerInactiveCode === "plan_feature" ? "forms.planHint" : "forms.ownerInactiveHint")}</p>
        </div>
      )}
      <div className="card pad stack">
        <label className="field">
          <span>{st("forms.link")}</span>
          <div className="link-box">
            <input readOnly value={form.url} onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={form.url} />
            <a className="btn btn-sm" href={form.url} target="_blank" rel="noreferrer">
              {st("forms.open")} ↗
            </a>
          </div>
        </label>
        {form.embeddable && (
          <label className="field">
            <span>{st("forms.embedSnippet")}</span>
            <textarea className="snippet" readOnly rows={3} value={snippet} onFocus={(e) => e.currentTarget.select()} />
          </label>
        )}
      </div>

      <h2 style={{ marginTop: "1.5rem" }}>{st("forms.envelopes")}</h2>
      {envs.length === 0 ? (
        <div className="empty">{st("forms.noEnvelopes")}</div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <tbody>
              {envs.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => nav(`/app/envelopes/${e.id}`)}>
                  <td>
                    <strong>{e.recipients.find((r) => r.role === "signer")?.name ?? e.subject}</strong>
                    <div className="muted small">{e.recipients.map((r) => r.email ?? r.name).join(", ")}</div>
                  </td>
                  <td className="muted small">{formatDateTime(e.createdAt, locale)}</td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <WebFormEditor
          form={form}
          onClose={() => setEditing(false)}
          onSaved={(f) => {
            setForm(f);
            setEditing(false);
          }}
        />
      )}
      {deleting && (
        <Modal
          title={form.name}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  try {
                    await api(`/v1/web-forms/${form.id}`, { method: "DELETE" });
                    nav("/app/forms");
                  } catch (err) {
                    setError(errorText(err));
                    setDeleting(false);
                  }
                }}
              >
                {st("forms.delete")}
              </button>
            </>
          }
        >
          <p>{st("forms.deleteConfirm")}</p>
        </Modal>
      )}
    </div>
  );
}
