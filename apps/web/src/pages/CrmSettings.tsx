// Ajustes → CRM y ERP: conexiones (OAuth o token), mapeos registro → plantilla, envío desde un registro y actividad.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CHANNELS,
  CRM_PROVIDER_OBJECTS,
  type CrmConnection,
  type CrmMapping,
  type CrmProvider,
  type CrmProviderInfo,
  type CrmRoleMapping,
  type CrmRun,
  type SendFromCrmRecordResponse,
  type TemplateDetail,
  type TemplateSummary,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n, confirmAction } from "../lib/i18n";
import { useCrmText } from "../lib/i18n-crm";
import { ErrorBox, Spinner } from "../components/ui";

type ProvidersResponse = { items: CrmProviderInfo[]; redirectUris: Record<string, string>; webhookUrl: string };

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section style={{ marginTop: 24 }}>
      <div className="row-between">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const TOKEN_FIELDS: Record<CrmProvider, { key: string; label: string; secret?: boolean; type?: string }[]> = {
  hubspot: [{ key: "accessToken", label: "hubspot.token", secret: true }],
  salesforce: [],
  siigo: [
    { key: "username", label: "siigo.username" },
    { key: "accessKey", label: "siigo.accessKey", secret: true },
  ],
  alegra: [
    { key: "email", label: "alegra.email", type: "email" },
    { key: "token", label: "alegra.token", secret: true },
  ],
};

export function CrmSettingsPage() {
  const t = useCrmText();
  const { locale } = useI18n();
  const [params] = useSearchParams();
  const [prov, setProv] = useState<ProvidersResponse | null>(null);
  const [conns, setConns] = useState<CrmConnection[] | null>(null);
  const [maps, setMaps] = useState<CrmMapping[] | null>(null);
  const [runs, setRuns] = useState<CrmRun[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<CrmMapping | "new" | null>(null);

  const load = () =>
    Promise.all([
      api<ProvidersResponse>("/v1/crm/providers").then(setProv),
      api<{ items: CrmConnection[] }>("/v1/crm/connections").then((r) => setConns(r.items)),
      api<{ items: CrmMapping[] }>("/v1/crm/mappings").then((r) => setMaps(r.items)),
      api<{ items: CrmRun[] }>("/v1/crm/runs?limit=30").then((r) => setRuns(r.items)),
      api<{ items: TemplateSummary[] }>("/v1/templates").then((r) => setTemplates(r.items)),
    ]);
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setError(null);
    setNote(null);
    try {
      await fn();
      if (ok) setNote(ok);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    if (params.get("connected")) setNote(t("connected"));
    if (params.get("error")) setError(t("error", { code: params.get("error") ?? "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [names, setNames] = useState<Record<string, string>>({});
  const [tokenForm, setTokenForm] = useState<Record<string, Record<string, string>>>({});
  const setTok = (p: string, k: string, v: string) => setTokenForm((c) => ({ ...c, [p]: { ...(c[p] ?? {}), [k]: v } }));

  const startOAuth = (p: CrmProvider) =>
    act(async () => {
      const r = await api<{ authorizeUrl: string }>(`/v1/crm/oauth/${p}/start`, { method: "POST", body: { name: names[p] || t(`p.${p}`) } });
      window.location.href = r.authorizeUrl;
    });
  const connectToken = (e: FormEvent, p: CrmProvider) => {
    e.preventDefault();
    return act(async () => {
      await api("/v1/crm/connections", { method: "POST", body: { provider: p, name: names[p] || t(`p.${p}`), ...(tokenForm[p] ?? {}) } });
      setTokenForm((c) => ({ ...c, [p]: {} }));
    }, t("connected"));
  };

  const connName = (id: string | null) => conns?.find((c) => c.id === id)?.name ?? "—";

  return (
    <div className="page narrow">
      <Link to="/app/settings" className="muted small">
        {t("back")}
      </Link>
      <div className="page-head">
        <h1>{t("title")}</h1>
      </div>
      <p className="muted">{t("intro")}</p>
      <ErrorBox error={error} />
      {note && (
        <div className="alert alert-success" role="status">
          {note}
        </div>
      )}

      {!prov ? (
        <Spinner />
      ) : (
        <>
          <div className="settings-grid">
            {prov.items.map((pv) => (
              <div key={pv.provider} className="card pad stack">
                <div className="row-between">
                  <strong>{t(`p.${pv.provider}`)}</strong>
                  <span className="badge badge-draft">{t(`kind.${pv.kind}`)}</span>
                </div>
                <label className="field">
                  <span>{t("name")}</span>
                  <input value={names[pv.provider] ?? ""} placeholder={t(`p.${pv.provider}`)} onChange={(e) => setNames((c) => ({ ...c, [pv.provider]: e.target.value }))} />
                </label>
                {(pv.provider === "hubspot" || pv.provider === "salesforce") &&
                  (pv.oauthConfigured ? (
                    <button type="button" className="btn btn-primary" onClick={() => startOAuth(pv.provider)}>
                      {t("connectOAuth")}
                    </button>
                  ) : (
                    <span className="badge badge-voided">{t("notConfigured")}</span>
                  ))}
                {pv.tokenSupported && (
                  <form className="stack" onSubmit={(e) => connectToken(e, pv.provider)}>
                    {TOKEN_FIELDS[pv.provider].map((f) => (
                      <label key={f.key} className="field">
                        <span>{t(f.label)}</span>
                        <input
                          required
                          type={f.secret ? "password" : f.type ?? "text"}
                          autoComplete={f.secret ? "new-password" : "off"}
                          value={tokenForm[pv.provider]?.[f.key] ?? ""}
                          onChange={(e) => setTok(pv.provider, f.key, e.target.value)}
                        />
                      </label>
                    ))}
                    <button className="btn">{t("connectToken")}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
          <details className="card pad" style={{ marginTop: 12 }}>
            <summary className="small">{t("info.redirects")}</summary>
            <ul className="small break">
              {Object.entries(prov.redirectUris).map(([k, v]) => (
                <li key={k}>
                  {t(`p.${k}`)}: <code>{v}</code>
                </li>
              ))}
              <li>
                {t("info.webhook")}: <code>{prov.webhookUrl}</code>
              </li>
            </ul>
          </details>
        </>
      )}

      <Section title={t("connections")}>
        {!conns ? (
          <Spinner />
        ) : conns.length === 0 ? (
          <div className="empty">{t("noConnections")}</div>
        ) : (
          conns.map((c) => (
            <div key={c.id} className="card pad stack">
              <div className="row-between">
                <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                  <strong>
                    {t(`p.${c.provider}`)} · {c.name}
                  </strong>
                  <span className="small muted">
                    {c.accountLabel ?? ""} · {t("lastSuccess")}: {c.lastSuccessAt ? formatDateTime(c.lastSuccessAt, locale) : t("never")}
                  </span>
                </div>
                <span className={`badge ${c.active ? "badge-completed" : "badge-voided"}`}>{c.active ? t("active") : t("inactive")}</span>
              </div>
              {c.lastError && (
                <div className="small" style={{ color: "var(--danger, #b42318)" }}>
                  {t("lastError")}: {c.lastError}
                </div>
              )}
              <div className="row-wrap">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    act(async () => {
                      const r = await api<{ ok: boolean; error: string | null }>(`/v1/crm/connections/${c.id}/test`, { method: "POST" });
                      if (!r.ok) throw new Error(r.error ?? "error");
                    }, t("testOk"))
                  }
                >
                  {t("test")}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/crm/connections/${c.id}`, { method: "PATCH", body: { active: !c.active } }))}>
                  {c.active ? t("inactive") : t("active")}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/crm/connections/${c.id}`, { method: "DELETE" }))}>
                  {t("delete")}
                </button>
              </div>
            </div>
          ))
        )}
      </Section>

      <Section
        title={t("mappings")}
        aside={
          conns && conns.length > 0 && editing === null ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
              {t("newMapping")}
            </button>
          ) : null
        }
      >
        {editing !== null && conns && (
          <MappingEditor
            // Con "Editar" en otro mapeo mientras el editor está abierto, el estado del formulario (inicializado con
            // useState) seguía siendo el del primero y se guardaba sobre el segundo: la key lo vuelve a montar.
            key={editing === "new" ? "new" : editing.id}
            mapping={editing === "new" ? null : editing}
            connections={conns}
            templates={templates}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              load().catch((e) => setError(errorText(e)));
            }}
          />
        )}
        {!maps ? (
          <Spinner />
        ) : maps.length === 0 ? (
          <div className="empty">{t("noMappings")}</div>
        ) : (
          maps.map((m) => (
            <div key={m.id} className="card pad row-between">
              <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>{m.name}</strong>
                <span className="small muted">
                  {connName(m.connectionId)} · {m.objectType} · {t(`m.trigger.${m.trigger}`)}
                  {m.templateId ? ` · ${templates.find((x) => x.id === m.templateId)?.name ?? ""}` : ""}
                </span>
              </div>
              <div className="row-wrap">
                <span className={`badge ${m.active ? "badge-completed" : "badge-voided"}`}>{m.active ? t("active") : t("inactive")}</span>
                <button type="button" className="btn btn-sm" onClick={() => setEditing(m)}>
                  {t("edit")}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/crm/mappings/${m.id}`, { method: "DELETE" }))}>
                  {t("delete")}
                </button>
              </div>
            </div>
          ))
        )}
      </Section>

      {maps && maps.some((m) => m.trigger !== "on_completion") && <SendFromRecord mappings={maps.filter((m) => m.trigger !== "on_completion" && m.active)} onDone={() => load()} />}

      <Section title={t("runs")}>
        {!runs ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <div className="empty">{t("noRuns")}</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="small">{formatDateTime(r.createdAt, locale)}</td>
                    <td>
                      {t(`run.kind.${r.kind}`)}
                      {r.event ? ` · ${r.event}` : ""}
                      <div className="small muted">
                        {r.connectionName ?? ""} {r.objectId ? `· ${r.objectType} ${r.objectId}` : ""}
                      </div>
                      {r.error && <div className="small" style={{ color: "var(--danger, #b42318)" }}>{r.error}</div>}
                    </td>
                    <td>
                      <span className={`badge ${r.status === "succeeded" ? "badge-completed" : r.status === "failed" ? "badge-declined" : "badge-sent"}`}>{t(`run.status.${r.status}`)}</span>
                      <div className="small muted">
                        {r.attempts} {t("run.attempts")}
                      </div>
                    </td>
                    <td className="row-wrap">
                      {r.envelopeId && (
                        <Link className="btn btn-sm" to={`/app/envelopes/${r.envelopeId}`}>
                          {t("openEnvelope")}
                        </Link>
                      )}
                      {r.status === "failed" && (r.kind !== "send" || Boolean(r.detail?.webhook)) && (
                        <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/crm/runs/${r.id}/retry`, { method: "POST" }))}>
                          {t("retry")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ───────────────────────────── Envío desde un registro ─────────────────────────────

function SendFromRecord({ mappings, onDone }: { mappings: CrmMapping[]; onDone: () => Promise<unknown> }) {
  const t = useCrmText();
  const [mappingId, setMappingId] = useState(mappings[0]?.id ?? "");
  const [objectId, setObjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SendFromCrmRecordResponse | null>(null);
  // Si el mapeo elegido se borra o desactiva (o no había ninguno al montar), se elige el primero disponible: si no,
  // el select muestra otro pero se enviaba al viejo (404) o el botón quedaba deshabilitado.
  useEffect(() => {
    if (!mappings.some((m) => m.id === mappingId)) setMappingId(mappings[0]?.id ?? "");
  }, [mappings, mappingId]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await api<SendFromCrmRecordResponse>(`/v1/crm/mappings/${mappingId}/send`, { method: "POST", body: { objectId: objectId.trim() } }));
      setObjectId("");
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("sendTitle")}>
      <form className="card pad stack" onSubmit={submit}>
        <p className="small muted">{t("sendIntro")}</p>
        <ErrorBox error={error} />
        {done && (
          <div className="alert alert-success" role="status">
            {t("sendOk")} <Link to={`/app/envelopes/${done.envelopeId}`}>{t("openEnvelope")}</Link>
          </div>
        )}
        <div className="row-wrap">
          <label className="field grow">
            <span>{t("mappings")}</span>
            <select value={mappingId} onChange={(e) => setMappingId(e.target.value)}>
              {mappings.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>{t("objectId")}</span>
            <input required value={objectId} onChange={(e) => setObjectId(e.target.value)} />
          </label>
        </div>
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy || !mappingId}>
            {t("sendBtn")}
          </button>
        </div>
      </form>
    </Section>
  );
}

// ───────────────────────────── Editor de mapeos ─────────────────────────────

type RoleRow = CrmRoleMapping;

function statusValuesFor(prev: Record<string, string> | undefined, completed: string): Record<string, string> | undefined {
  const next: Record<string, string> = { ...(prev ?? {}) };
  if (completed) next.completed = completed;
  else delete next.completed;
  return Object.keys(next).length ? next : undefined;
}

function MappingEditor({
  mapping,
  connections,
  templates,
  onCancel,
  onSaved,
}: {
  mapping: CrmMapping | null;
  connections: CrmConnection[];
  templates: TemplateSummary[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useCrmText();
  const [connectionId, setConnectionId] = useState(mapping?.connectionId ?? connections[0]?.id ?? "");
  const conn = connections.find((c) => c.id === connectionId);
  const provider = conn?.provider ?? "hubspot";
  const isErp = provider === "siigo" || provider === "alegra";
  const [name, setName] = useState(mapping?.name ?? "");
  const [objectType, setObjectType] = useState<string>(mapping?.objectType ?? CRM_PROVIDER_OBJECTS[provider][0]);
  const [templateId, setTemplateId] = useState<string>(mapping?.templateId ?? "");
  const [trigger, setTrigger] = useState<string>(mapping?.trigger ?? (isErp ? "on_completion" : "manual"));
  const [tProp, setTProp] = useState(mapping?.triggerConfig.property ?? "");
  const [tVal, setTVal] = useState(mapping?.triggerConfig.value ?? "");
  const [onlyTemplate, setOnlyTemplate] = useState(mapping?.triggerConfig.templateId ?? "");
  const [roles, setRoles] = useState<RoleRow[]>(mapping?.roles ?? []);
  const [prefill, setPrefill] = useState(mapping?.prefill ?? []);
  const [statusProperty, setStatusProperty] = useState(mapping?.writeBack.statusProperty ?? "");
  const [completedValue, setCompletedValue] = useState(mapping?.writeBack.statusValues?.completed ?? "");
  const [attachPdf, setAttachPdf] = useState(mapping?.writeBack.attachPdf ?? true);
  const [send, setSend] = useState(mapping?.send ?? true);
  const [active, setActive] = useState(mapping?.active ?? true);
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!CRM_PROVIDER_OBJECTS[provider].includes(objectType as never)) setObjectType(CRM_PROVIDER_OBJECTS[provider][0]);
    if (isErp) setTrigger("on_completion");
    else if (trigger === "on_completion") setTrigger("manual");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);
  useEffect(() => {
    if (!templateId) return setTpl(null);
    api<TemplateDetail>(`/v1/templates/${templateId}`)
      .then((d) => {
        setTpl(d);
        if (!mapping && roles.length === 0) setRoles(d.roles.map((r, i) => ({ role: r.name, source: "contact", index: i, channels: ["email"] }) as RoleRow));
      })
      .catch(() => setTpl(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  const setRole = (i: number, patch: Partial<RoleRow> & Record<string, unknown>) => setRoles((rs) => rs.map((r, j) => (j === i ? ({ ...r, ...patch } as RoleRow) : r)));
  const changeSource = (i: number, source: RoleRow["source"]) =>
    setRoles((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const base = { role: r.role, channels: r.channels };
        if (source === "contact") return { ...base, source, index: 0 } as RoleRow;
        if (source === "contact_role") return { ...base, source, contactRole: "", primary: false } as RoleRow;
        if (source === "property") return { ...base, source, nameProperty: "", emailProperty: "" } as RoleRow;
        return { ...base, source, name: "", email: "" } as RoleRow;
      }),
    );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name,
      objectType,
      templateId: templateId || null,
      roles: isErp ? [] : roles.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "" && v !== null))),
      prefill: isErp ? [] : prefill.filter((p) => p.field && p.property),
      // Se conservan los valores de los otros estados (enviado, rechazado, …), que solo se configuran por API.
      writeBack: { statusProperty: statusProperty || null, statusValues: statusValuesFor(mapping?.writeBack.statusValues, completedValue), attachPdf },
      trigger,
      triggerConfig:
        trigger === "webhook" ? { property: tProp || null, value: tVal || null } : trigger === "on_completion" ? { matchBy: "recipient_id_document", templateId: onlyTemplate || null } : {},
      send,
      active,
    };
    try {
      if (mapping) await api(`/v1/crm/mappings/${mapping.id}`, { method: "PATCH", body });
      else await api("/v1/crm/mappings", { method: "POST", body: { ...body, connectionId } });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const roleNames = tpl?.roles.map((r) => r.name) ?? [];
  const fieldLabels = [...new Set((tpl?.fields ?? []).map((f) => f.label).filter(Boolean) as string[])];

  return (
    <form className="card pad stack" onSubmit={save} style={{ marginBottom: 12 }}>
      <strong>{mapping ? t("editMapping") : t("newMapping")}</strong>
      <ErrorBox error={error} />
      <div className="row-wrap">
        <label className="field grow">
          <span>{t("m.connection")}</span>
          <select value={connectionId} disabled={Boolean(mapping)} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {t(`p.${c.provider}`)} · {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{t("m.name")}</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("m.objectType")}</span>
          <select value={objectType} onChange={(e) => setObjectType(e.target.value)}>
            {CRM_PROVIDER_OBJECTS[provider].map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>{t("m.trigger")}</span>
        <select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          {(isErp ? ["on_completion"] : provider === "hubspot" ? ["manual", "webhook"] : ["manual"]).map((x) => (
            <option key={x} value={x}>
              {t(`m.trigger.${x}`)}
            </option>
          ))}
        </select>
      </label>
      {trigger === "webhook" && (
        <div className="row-wrap">
          <label className="field grow">
            <span>{t("m.triggerProperty")}</span>
            <input required value={tProp} placeholder="dealstage" onChange={(e) => setTProp(e.target.value)} />
          </label>
          <label className="field grow">
            <span>{t("m.triggerValue")}</span>
            <input value={tVal} placeholder="contractsent" onChange={(e) => setTVal(e.target.value)} />
          </label>
        </div>
      )}
      {trigger === "on_completion" && (
        <label className="field">
          <span>{t("m.onlyTemplate")}</span>
          <select value={onlyTemplate} onChange={(e) => setOnlyTemplate(e.target.value)}>
            <option value="">{t("m.anyTemplate")}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {!isErp && (
        <>
          <label className="field">
            <span>{t("m.template")}</span>
            <select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{t("m.noTemplate")}</option>
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>

          <strong className="small">{t("m.roles")}</strong>
          {roles.map((r, i) => (
            <div key={i} className="card pad stack" style={{ background: "var(--surface-2, transparent)" }}>
              <div className="row-wrap">
                <label className="field grow">
                  <span>{t("m.role")}</span>
                  {roleNames.length ? (
                    <select value={r.role} onChange={(e) => setRole(i, { role: e.target.value })}>
                      {[...new Set([r.role, ...roleNames])].filter(Boolean).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input required value={r.role} onChange={(e) => setRole(i, { role: e.target.value })} />
                  )}
                </label>
                <label className="field grow">
                  <span>{t("m.source")}</span>
                  <select value={r.source} onChange={(e) => changeSource(i, e.target.value as RoleRow["source"])}>
                    {(["contact", "contact_role", "property", "fixed"] as const).map((s) => (
                      <option key={s} value={s}>
                        {t(`m.source.${s}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row-wrap">
                {r.source === "contact" && (
                  <label className="field">
                    <span>{t("m.index")}</span>
                    <input type="number" min={0} max={50} value={r.index ?? 0} onChange={(e) => setRole(i, { index: Number(e.target.value) })} />
                  </label>
                )}
                {r.source === "contact_role" && (
                  <>
                    <label className="field grow">
                      <span>{t("m.contactRole")}</span>
                      <input value={r.contactRole ?? ""} disabled={Boolean(r.primary)} onChange={(e) => setRole(i, { contactRole: e.target.value })} />
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={Boolean(r.primary)} onChange={(e) => setRole(i, { primary: e.target.checked })} /> {t("m.primary")}
                    </label>
                  </>
                )}
                {r.source === "property" && (
                  <>
                    <label className="field grow">
                      <span>{t("m.nameProperty")}</span>
                      <input required value={r.nameProperty} onChange={(e) => setRole(i, { nameProperty: e.target.value })} />
                    </label>
                    <label className="field grow">
                      <span>{t("m.emailProperty")}</span>
                      <input value={r.emailProperty ?? ""} onChange={(e) => setRole(i, { emailProperty: e.target.value })} />
                    </label>
                    <label className="field grow">
                      <span>{t("m.phoneProperty")}</span>
                      <input value={r.phoneProperty ?? ""} onChange={(e) => setRole(i, { phoneProperty: e.target.value })} />
                    </label>
                  </>
                )}
                {r.source === "fixed" && (
                  <>
                    <label className="field grow">
                      <span>{t("m.fixedName")}</span>
                      <input required value={r.name} onChange={(e) => setRole(i, { name: e.target.value })} />
                    </label>
                    <label className="field grow">
                      <span>{t("m.fixedEmail")}</span>
                      <input type="email" value={r.email ?? ""} onChange={(e) => setRole(i, { email: e.target.value })} />
                    </label>
                  </>
                )}
              </div>
              <div className="row-between">
                <div className="row-wrap" aria-label={t("m.channels")}>
                  {CHANNELS.filter((c) => c !== "telegram").map((ch) => (
                    <label key={ch} className="check small">
                      <input
                        type="checkbox"
                        checked={r.channels.includes(ch)}
                        onChange={(e) => setRole(i, { channels: e.target.checked ? [...r.channels, ch] : r.channels.filter((x) => x !== ch).length ? r.channels.filter((x) => x !== ch) : r.channels })}
                      />{" "}
                      {ch}
                    </label>
                  ))}
                </div>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setRoles((rs) => rs.filter((_, j) => j !== i))}>
                  {t("m.remove")}
                </button>
              </div>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setRoles((rs) => [...rs, { role: roleNames[rs.length] ?? "", source: "contact", index: rs.length, channels: ["email"] } as RoleRow])}>
              {t("m.addRole")}
            </button>
          </div>

          <strong className="small">{t("m.prefill")}</strong>
          {prefill.map((p, i) => (
            <div key={i} className="row-wrap">
              <label className="field grow">
                <span>{t("m.field")}</span>
                <input list="crm-field-labels" value={p.field} onChange={(e) => setPrefill((ps) => ps.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} />
              </label>
              <label className="field grow">
                <span>{t("m.property")}</span>
                <input value={p.property} onChange={(e) => setPrefill((ps) => ps.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)))} />
              </label>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => setPrefill((ps) => ps.filter((_, j) => j !== i))}>
                {t("m.remove")}
              </button>
            </div>
          ))}
          <datalist id="crm-field-labels">
            {fieldLabels.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setPrefill((ps) => [...ps, { field: "", property: "" }])}>
              {t("m.addPrefill")}
            </button>
          </div>

          <strong className="small">{t("m.writeBack")}</strong>
          <div className="row-wrap">
            <label className="field grow">
              <span>{t("m.statusProperty")}</span>
              <input value={statusProperty} placeholder={provider === "salesforce" ? "CalaSign_Status__c" : "calasign_status"} onChange={(e) => setStatusProperty(e.target.value)} />
            </label>
            <label className="field grow">
              <span>{t("m.completedValue")}</span>
              <input value={completedValue} onChange={(e) => setCompletedValue(e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> {t("m.send")}
          </label>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} /> {t("m.attachPdf")}
      </label>
      <label className="check">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t("m.active")}
      </label>
      <div className="row-end">
        <button type="button" className="btn" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button className="btn btn-primary" disabled={busy}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}
