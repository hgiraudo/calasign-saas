// Repositorio de acuerdos (Fase 6): búsqueda, filtros, vistas guardadas, detalle editable, carga externa y campos propios.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Agreement, AgreementFieldDef, AgreementStatus, AgreementView, Counterparty, ListAgreementsResponse } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDate, useI18n } from "../lib/i18n";
import { useAccess } from "../lib/access";
import { useAgrText } from "../lib/i18n-agreements";
import { AgreementsTabs } from "../components/AgreementsUi";
import { ErrorBox, Modal, Spinner } from "../components/ui";

export function AgreementStatusBadge({ status }: { status: AgreementStatus }) {
  const ta = useAgrText();
  return <span className={`badge agr-status-${status}`}>{ta(`status.${status}`)}</span>;
}

function money(v: number | null, cur: string | null, locale: string) {
  if (v == null) return "—";
  try {
    return cur ? new Intl.NumberFormat(locale, { style: "currency", currency: cur }).format(v) : new Intl.NumberFormat(locale).format(v);
  } catch {
    return `${cur ?? ""} ${v}`;
  }
}

/** Fragmento con «…» del servidor → resaltado. */
function Excerpt({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <div className="agr-excerpt">
      …{parts.map((p, i) => (p.startsWith("«") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}…
    </div>
  );
}

// ───────────────────────────── Listado ─────────────────────────────

export function AgreementsPage() {
  const ta = useAgrText();
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ListAgreementsResponse | null>(null);
  const [fields, setFields] = useState<AgreementFieldDef[]>([]);
  const [views, setViews] = useState<AgreementView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(params.get("q") ?? "");
  const [uploading, setUploading] = useState(false);
  const [editingFields, setEditingFields] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = params.toString();
  // Solo se aplica la respuesta de la búsqueda más reciente (una lenta no pisa a la nueva).
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const r = await api<ListAgreementsResponse>(`/v1/agreements?${query}`);
      if (mine === seq.current) setData(r);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    }
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);
  const loadMeta = useCallback(() => {
    api<{ items: AgreementFieldDef[] }>("/v1/agreement-fields").then((r) => setFields(r.items)).catch(() => undefined);
    api<{ items: AgreementView[] }>("/v1/agreement-views").then((r) => setViews(r.items)).catch(() => undefined);
  }, []);
  useEffect(loadMeta, [loadMeta]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete("cursor");
    setParams(next, { replace: true });
  };

  useEffect(() => {
    const h = window.setTimeout(() => {
      if ((params.get("q") ?? "") !== q) setParam("q", q.trim());
    }, 350);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const loadMore = async () => {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const next = new URLSearchParams(params);
      next.set("cursor", data.nextCursor);
      const more = await api<ListAgreementsResponse>(`/v1/agreements?${next.toString()}`);
      setData({ ...more, items: [...data.items, ...more.items] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const currentFilters = () => {
    const f: Record<string, unknown> = {};
    const fieldsF: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      if (k === "viewId" || k === "cursor" || !v) continue;
      if (k.startsWith("f.")) fieldsF[k.slice(2)] = v;
      else if (k === "expiresWithinDays") f[k] = Number(v);
      else f[k] = v;
    }
    if (Object.keys(fieldsF).length) f.fields = fieldsF;
    return f;
  };

  const exportUrl = `/v1/agreements/export.csv?${query}`;

  return (
    <div className="page">
      <AgreementsTabs />
      <div className="page-head">
        <div>
          <h1>{ta("repo.title")}</h1>
          <p className="muted">{ta("repo.intro")}</p>
        </div>
        <div className="row-wrap">
          {can("settings:manage") && (
            <button type="button" className="btn" onClick={() => setEditingFields(true)}>
              {ta("repo.fields")}
            </button>
          )}
          <a className="btn" href={exportUrl} download>
            {ta("repo.export")}
          </a>
          <button type="button" className="btn btn-primary" onClick={() => setUploading(true)}>
            {ta("repo.upload")}
          </button>
        </div>
      </div>

      <div className="agr-filters" role="search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={ta("repo.search")} aria-label={ta("repo.search")} />
        <select value={params.get("status") ?? ""} onChange={(e) => setParam("status", e.target.value)} aria-label={ta("col.status")}>
          <option value="">{ta("repo.allStatus")}</option>
          {(["active", "expired", "terminated"] as const).map((s) => (
            <option key={s} value={s}>
              {ta(`status.${s}`)}
            </option>
          ))}
        </select>
        <select value={params.get("source") ?? ""} onChange={(e) => setParam("source", e.target.value)} aria-label={ta("col.source")}>
          <option value="">{ta("repo.allSources")}</option>
          <option value="envelope">{ta("source.envelope")}</option>
          <option value="external">{ta("source.external")}</option>
        </select>
        <select value={params.get("expiresWithinDays") ?? ""} onChange={(e) => setParam("expiresWithinDays", e.target.value)} aria-label={ta("repo.expiringIn")}>
          <option value="">{ta("repo.anyTime")}</option>
          {[30, 60, 90, 180].map((n) => (
            <option key={n} value={n}>
              {ta("repo.expiringIn")} {ta("repo.days", { n })}
            </option>
          ))}
        </select>
        {fields
          .filter((f) => f.type === "select")
          .map((f) => (
            <select key={f.id} value={params.get(`f.${f.key}`) ?? ""} onChange={(e) => setParam(`f.${f.key}`, e.target.value)} aria-label={f.label}>
              <option value="">{f.label}</option>
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ))}
        <select
          value={params.get("viewId") ?? ""}
          onChange={(e) => {
            const next = new URLSearchParams();
            if (e.target.value) next.set("viewId", e.target.value);
            setQ("");
            setParams(next, { replace: true });
          }}
          aria-label={ta("repo.views")}
        >
          <option value="">{ta("repo.views")}…</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.shared ? " ⦿" : ""}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-sm" onClick={() => setSavingView(true)}>
          {ta("repo.saveView")}
        </button>
        {params.get("viewId") && views.find((v) => v.id === params.get("viewId"))?.mine && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              await api(`/v1/agreement-views/${params.get("viewId")}`, { method: "DELETE" }).catch((e) => setError(errorText(e)));
              setParams(new URLSearchParams(), { replace: true });
              loadMeta();
            }}
          >
            {ta("repo.deleteView")}
          </button>
        )}
      </div>

      <ErrorBox error={error} />
      {data === null ? (
        <Spinner />
      ) : data.items.length === 0 ? (
        <div className="empty">{query ? ta("repo.noResults") : ta("repo.empty")}</div>
      ) : (
        <>
          <p className="muted small">{ta("repo.total", { n: data.total })}</p>
          <div className="card table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{ta("col.title")}</th>
                  <th>{ta("col.counterparties")}</th>
                  <th>{ta("col.status")}</th>
                  <th>{ta("col.expiry")}</th>
                  <th>{ta("col.value")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => nav(`/app/agreements/${a.id}`)}>
                    <td>
                      <Link to={`/app/agreements/${a.id}`} onClick={(e) => e.stopPropagation()}>
                        <strong>{a.title}</strong>
                      </Link>
                      <div className="chips" style={{ marginTop: 4 }}>
                        <span className="badge">{ta(`source.${a.source}`)}</span>
                        {a.tags.map((tg) => (
                          <span key={tg} className="badge badge-draft">
                            {tg}
                          </span>
                        ))}
                      </div>
                      {a.excerpt && <Excerpt text={a.excerpt} />}
                    </td>
                    <td className="small">{a.counterparties.map((c) => c.name).join(", ") || "—"}</td>
                    <td>
                      <AgreementStatusBadge status={a.status} />
                    </td>
                    <td className="small">{a.expiryDate ? formatDate(`${a.expiryDate}T12:00:00Z`, locale) : "—"}</td>
                    <td className="small">{money(a.value, a.currency, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.nextCursor && (
            <div className="row-end" style={{ marginTop: "1rem" }}>
              <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t("common.loading") : ta("repo.loadMore")}
              </button>
            </div>
          )}
        </>
      )}

      {uploading && (
        <UploadModal
          fields={fields}
          onClose={() => setUploading(false)}
          onDone={(a) => {
            setUploading(false);
            nav(`/app/agreements/${a.id}`);
          }}
        />
      )}
      {editingFields && (
        <FieldsModal
          fields={fields}
          onClose={() => {
            setEditingFields(false);
            loadMeta();
          }}
        />
      )}
      {savingView && (
        <SaveViewModal
          filters={currentFilters()}
          canShare={can("settings:manage")}
          onClose={() => setSavingView(false)}
          onSaved={(v) => {
            setSavingView(false);
            loadMeta();
            setParams(new URLSearchParams({ viewId: v.id }), { replace: true });
          }}
        />
      )}
    </div>
  );
}

function SaveViewModal({ filters, canShare, onClose, onSaved }: { filters: Record<string, unknown>; canShare: boolean; onClose: () => void; onSaved: (v: AgreementView) => void }) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onSaved(await api<AgreementView>("/v1/agreement-views", { method: "POST", body: { name: name.trim(), filters, shared } }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={ta("repo.saveView")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          <span>{ta("repo.viewName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} autoFocus />
        </label>
        {canShare && (
          <label className="check">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> {ta("repo.shareView")}
          </label>
        )}
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────── Metadatos (compartido por alta y detalle) ─────────────────────────────

interface MetaDraft {
  title: string;
  status: AgreementStatus;
  effectiveDate: string;
  expiryDate: string;
  renewalDate: string;
  noticeDays: string;
  value: string;
  currency: string;
  tags: string;
  counterparties: Counterparty[];
  metadata: Record<string, string>;
}

function draftFrom(a: Agreement | null): MetaDraft {
  return {
    title: a?.title ?? "",
    status: a?.status ?? "active",
    effectiveDate: a?.effectiveDate ?? "",
    expiryDate: a?.expiryDate ?? "",
    renewalDate: a?.renewalDate ?? "",
    noticeDays: a?.noticeDays != null ? String(a.noticeDays) : "",
    value: a?.value != null ? String(a.value) : "",
    currency: a?.currency ?? "",
    tags: (a?.tags ?? []).join(", "),
    counterparties: a?.counterparties ?? [],
    metadata: Object.fromEntries(Object.entries(a?.metadata ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)])),
  };
}

function draftToBody(d: MetaDraft, fields: AgreementFieldDef[]) {
  const metadata: Record<string, string | number | null> = {};
  for (const f of fields) {
    const v = d.metadata[f.key] ?? "";
    metadata[f.key] = v === "" ? null : f.type === "number" ? Number(v.replace(",", ".")) : v;
  }
  return {
    title: d.title.trim(),
    status: d.status,
    effectiveDate: d.effectiveDate || null,
    expiryDate: d.expiryDate || null,
    renewalDate: d.renewalDate || null,
    noticeDays: d.noticeDays ? Number(d.noticeDays) : null,
    value: d.value ? Number(d.value.replace(",", ".")) : null,
    currency: d.currency.trim().toUpperCase() || null,
    tags: d.tags
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    counterparties: d.counterparties.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), email: c.email?.trim() || null, role: c.role?.trim() || null })),
    metadata,
  };
}

function MetaForm({ d, setD, fields, readOnly }: { d: MetaDraft; setD: (d: MetaDraft) => void; fields: AgreementFieldDef[]; readOnly?: boolean }) {
  const ta = useAgrText();
  const up = (patch: Partial<MetaDraft>) => setD({ ...d, ...patch });
  return (
    <fieldset className="stack" disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }}>
      <label className="field">
        <span>{ta("ag.titleField")}</span>
        <input value={d.title} onChange={(e) => up({ title: e.target.value })} required maxLength={300} />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>{ta("ag.status")}</span>
          <select value={d.status} onChange={(e) => up({ status: e.target.value as AgreementStatus })}>
            {(["active", "expired", "terminated"] as const).map((s) => (
              <option key={s} value={s}>
                {ta(`status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{ta("ag.notice")}</span>
          <input type="number" min={0} max={3650} value={d.noticeDays} onChange={(e) => up({ noticeDays: e.target.value })} placeholder="30" />
        </label>
        <label className="field">
          <span>{ta("ag.effective")}</span>
          <input type="date" value={d.effectiveDate} onChange={(e) => up({ effectiveDate: e.target.value })} />
        </label>
        <label className="field">
          <span>{ta("ag.expiry")}</span>
          <input type="date" value={d.expiryDate} onChange={(e) => up({ expiryDate: e.target.value })} />
        </label>
        <label className="field">
          <span>{ta("ag.renewal")}</span>
          <input type="date" value={d.renewalDate} onChange={(e) => up({ renewalDate: e.target.value })} />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>{ta("ag.value")}</span>
            <input inputMode="decimal" value={d.value} onChange={(e) => up({ value: e.target.value })} />
          </label>
          <label className="field">
            <span>{ta("ag.currency")}</span>
            <input value={d.currency} onChange={(e) => up({ currency: e.target.value.toUpperCase().slice(0, 3) })} placeholder="USD" maxLength={3} />
          </label>
        </div>
      </div>
      <label className="field">
        <span>{ta("ag.tags")}</span>
        <input value={d.tags} onChange={(e) => up({ tags: e.target.value })} />
      </label>
      {fields.length > 0 && (
        <fieldset className="field">
          <legend>{ta("ag.custom")}</legend>
          <div className="grid-2">
            {fields.map((f) => (
              <label key={f.id} className="field">
                <span>{f.label}</span>
                {f.type === "select" ? (
                  <select value={d.metadata[f.key] ?? ""} onChange={(e) => up({ metadata: { ...d.metadata, [f.key]: e.target.value } })}>
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={f.type === "date" ? "date" : "text"}
                    inputMode={f.type === "number" ? "decimal" : undefined}
                    value={d.metadata[f.key] ?? ""}
                    onChange={(e) => up({ metadata: { ...d.metadata, [f.key]: e.target.value } })}
                  />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="field">
        <legend>{ta("ag.counterparties")}</legend>
        {d.counterparties.map((c, i) => (
          <div key={i} className="agr-subrow">
            <input aria-label={ta("ag.name")} placeholder={ta("ag.name")} value={c.name} onChange={(e) => up({ counterparties: d.counterparties.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <input
              aria-label={ta("ag.email")}
              placeholder={ta("ag.email")}
              type="email"
              value={c.email ?? ""}
              onChange={(e) => up({ counterparties: d.counterparties.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) })}
            />
            <input aria-label={ta("ag.role")} placeholder={ta("ag.role")} value={c.role ?? ""} onChange={(e) => up({ counterparties: d.counterparties.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} />
            <button type="button" className="btn btn-sm btn-ghost" aria-label="×" onClick={() => up({ counterparties: d.counterparties.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}
        <div>
          <button type="button" className="btn btn-sm" onClick={() => up({ counterparties: [...d.counterparties, { name: "", email: null, role: null }] })}>
            {ta("ag.addCounterparty")}
          </button>
        </div>
      </fieldset>
    </fieldset>
  );
}

function UploadModal({ fields, onClose, onDone }: { fields: AgreementFieldDef[]; onClose: () => void; onDone: (a: Agreement) => void }) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [d, setD] = useState<MetaDraft>(draftFrom(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.append("meta", JSON.stringify(draftToBody({ ...d, title: d.title || file.name.replace(/\.pdf$/i, "") }, fields)));
    fd.append("file", file);
    try {
      onDone(await api<Agreement>("/v1/agreements/upload", { method: "POST", form: fd }));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Modal title={ta("up.title")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <ErrorBox error={error} />
        <label className="field">
          <span>{ta("up.file")}</span>
          <input
            type="file"
            accept="application/pdf"
            required
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !d.title) setD({ ...d, title: f.name.replace(/\.pdf$/i, "") });
            }}
          />
        </label>
        <MetaForm d={d} setD={setD} fields={fields} />
        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !file}>
            {busy ? t("common.saving") : ta("up.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FieldsModal({ fields, onClose }: { fields: AgreementFieldDef[]; onClose: () => void }) {
  const ta = useAgrText();
  const { t } = useI18n();
  const [list, setList] = useState(fields);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<AgreementFieldDef["type"]>("text");
  const [options, setOptions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const f = await api<AgreementFieldDef>("/v1/agreement-fields", {
        method: "POST",
        body: {
          key: key.trim(),
          label: label.trim(),
          type,
          options:
            type === "select"
              ? options
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean)
              : null,
        },
      });
      setList([...list, f]);
      setKey("");
      setLabel("");
      setOptions("");
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Modal title={ta("fields.title")} onClose={onClose} wide>
      <div className="stack">
        <p className="muted small">{ta("fields.intro")}</p>
        <ErrorBox error={error} />
        {list.length > 0 && (
          <table className="table">
            <tbody>
              {list.map((f) => (
                <tr key={f.id}>
                  <td>
                    <strong>{f.label}</strong> <code className="small">{f.key}</code>
                  </td>
                  <td className="small">
                    {ta(`fields.type.${f.type}`)}
                    {f.options?.length ? `: ${f.options.join(", ")}` : ""}
                  </td>
                  <td className="row-end">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={async () => {
                        await api(`/v1/agreement-fields/${f.id}`, { method: "DELETE" }).catch((e) => setError(errorText(e)));
                        setList(list.filter((x) => x.id !== f.id));
                      }}
                    >
                      {t("common.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="agr-subrow" onSubmit={add}>
          <label className="field">
            <span>{ta("fields.label")}</span>
            <input
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (!key || key === slug(label)) setKey(slug(e.target.value));
              }}
              required
            />
          </label>
          <label className="field">
            <span>{ta("fields.key")}</span>
            <input value={key} onChange={(e) => setKey(e.target.value)} pattern="[a-z][a-z0-9_]{0,39}" required />
          </label>
          <label className="field">
            <span>{ta("fields.type")}</span>
            <select value={type} onChange={(e) => setType(e.target.value as AgreementFieldDef["type"])}>
              {(["text", "number", "date", "select"] as const).map((x) => (
                <option key={x} value={x}>
                  {ta(`fields.type.${x}`)}
                </option>
              ))}
            </select>
          </label>
          {type === "select" && (
            <label className="field">
              <span>{ta("fields.options")}</span>
              <input value={options} onChange={(e) => setOptions(e.target.value)} required />
            </label>
          )}
          <button type="submit" className="btn btn-primary">
            {ta("fields.add")}
          </button>
        </form>
      </div>
    </Modal>
  );
}

function slug(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "c_$1")
    .slice(0, 40);
}

// ───────────────────────────── Detalle ─────────────────────────────

export function AgreementDetailPage() {
  const { id } = useParams();
  const ta = useAgrText();
  const { t } = useI18n();
  const nav = useNavigate();
  const [a, setA] = useState<Agreement | null>(null);
  const [fields, setFields] = useState<AgreementFieldDef[]>([]);
  const [d, setD] = useState<MetaDraft>(draftFrom(null));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    api<Agreement>(`/v1/agreements/${id}`)
      .then((x) => {
        setA(x);
        setD(draftFrom(x));
      })
      .catch((e) => setError(errorText(e)));
    api<{ items: AgreementFieldDef[] }>("/v1/agreement-fields").then((r) => setFields(r.items)).catch(() => undefined);
  }, [id]);

  const dirty = useMemo(() => a && JSON.stringify(draftFrom(a)) !== JSON.stringify(d), [a, d]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const x = await api<Agreement>(`/v1/agreements/${id}`, { method: "PATCH", body: draftToBody(d, fields) });
      setA(x);
      setD(draftFrom(x));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!a) return <div className="page">{error ? <ErrorBox error={error} /> : <Spinner />}</div>;
  return (
    <div className="page">
      <AgreementsTabs />
      <Link to="/app/agreements" className="muted small">
        {ta("ag.back")}
      </Link>
      <div className="page-head">
        <div>
          <h1>{a.title}</h1>
          <div className="row-wrap">
            <AgreementStatusBadge status={a.status} />
            <span className="badge">{ta(`source.${a.source}`)}</span>
          </div>
        </div>
        <div className="row-wrap">
          <a className="btn" href={`/v1/agreements/${a.id}/file`} download>
            {ta("ag.download")}
          </a>
          {a.envelopeId && (
            <Link className="btn" to={`/app/envelopes/${a.envelopeId}`}>
              {ta("ag.envelope")}
            </Link>
          )}
          {a.source === "external" && (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>
              {ta("ag.delete")}
            </button>
          )}
        </div>
      </div>
      <div className="agr-split-wide">
        <form className="card pad stack" onSubmit={save}>
          <h2>{ta("ag.details")}</h2>
          <ErrorBox error={error} />
          <MetaForm d={d} setD={setD} fields={fields} />
          <div className="row-end">
            {saved && <span className="muted small">✓ {ta("ag.saved")}</span>}
            <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
              {busy ? t("common.saving") : ta("ag.save")}
            </button>
          </div>
        </form>
        <div className="card pad stack small">
          <div>
            <div className="muted">{ta("ag.owner")}</div>
            <div>{a.ownerName ?? "—"}</div>
          </div>
          <div>
            <div className="muted">{ta("ag.signatures")}</div>
            <div>{a.signatures}</div>
          </div>
          <div>
            <div className="muted">{ta("ag.hash")}</div>
            <code style={{ wordBreak: "break-all" }}>{a.sha256}</code>
          </div>
        </div>
      </div>
      {confirmDelete && (
        <Modal title={ta("ag.delete")} onClose={() => setConfirmDelete(false)}>
          <p>{ta("ag.deleteConfirm")}</p>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                try {
                  await api(`/v1/agreements/${a.id}`, { method: "DELETE" });
                  nav("/app/agreements");
                } catch (e) {
                  setError(errorText(e));
                  setConfirmDelete(false);
                }
              }}
            >
              {ta("ag.delete")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
