// Ajustes → RR. HH. y contratos: conexiones (clave u OAuth) con BambooHR, HiBob, Factorial, Ironclad y Juro, flujos
// registro → plantilla, envío desde un empleado o contrato (con búsqueda) y actividad.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CONNECTOR_PROVIDER_OBJECTS,
  type ConnectorConnection,
  type ConnectorFlow,
  type ConnectorProvider,
  type ConnectorProviderInfo,
  type ConnectorRecordSummary,
  type ConnectorRun,
  type CrmRoleMapping,
  type SendFromConnectorResponse,
  type TemplateDetail,
  type TemplateSummary,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { confirmAction, formatDateTime, useI18n } from "../lib/i18n";
import { useConnText } from "../lib/i18n-connectors";
import { ErrorBox, OrderInput, Spinner } from "../components/ui";
import { useAccess } from "../lib/access";

type ProvidersResponse = { items: ConnectorProviderInfo[]; redirectUris: Record<string, string> };

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

const DOC_SOURCE_OK = (p: ConnectorProvider, objectType: string) => (p === "ironclad" && objectType === "workflow") || p === "juro";
const STATUS_OK = (p: ConnectorProvider, objectType: string) => p === "bamboohr" || (p === "ironclad" && objectType === "record");

export function ConnectorsSettingsPage() {
  const t = useConnText();
  const { locale, t: tc } = useI18n();
  // Conexiones, flujos y reintentos piden además envelopes:view_all en la API (enviar desde un registro, no).
  const canEdit = useAccess().can("envelopes:view_all");
  const [params] = useSearchParams();
  const [prov, setProv] = useState<ProvidersResponse | null>(null);
  const [conns, setConns] = useState<ConnectorConnection[] | null>(null);
  const [flows, setFlows] = useState<ConnectorFlow[] | null>(null);
  const [runs, setRuns] = useState<ConnectorRun[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<ConnectorFlow | "new" | null>(null);

  const load = () =>
    Promise.all([
      api<ProvidersResponse>("/v1/connectors/providers").then(setProv),
      api<{ items: ConnectorConnection[] }>("/v1/connectors/connections").then((r) => setConns(r.items)),
      api<{ items: ConnectorFlow[] }>("/v1/connectors/flows").then((r) => setFlows(r.items)),
      api<{ items: ConnectorRun[] }>("/v1/connectors/runs?limit=30").then((r) => setRuns(r.items)),
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
    // Conectado por OAuth sin poder determinar la cuenta (Factorial sin compañía): el mismo aviso que al probarla.
    if (params.get("connected")) setNote(params.get("warning") === "account_unknown" ? `${t("connected")} ${t("testAccountUnknown")}` : t("connected"));
    if (params.get("error")) setError(t("error", { code: params.get("error") ?? "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [names, setNames] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<Record<string, Record<string, string>>>({});
  const [region, setRegion] = useState("na1");
  const [connecting, setConnecting] = useState<string | null>(null);
  const setCred = (p: string, k: string, v: string) => setCreds((c) => ({ ...c, [p]: { ...(c[p] ?? {}), [k]: v } }));

  const connectKey = async (e: FormEvent, p: ConnectorProvider) => {
    e.preventDefault();
    if (connecting) return; // doble clic: una sola conexión
    setConnecting(p);
    try {
      await act(async () => {
        await api("/v1/connectors/connections", { method: "POST", body: { provider: p, name: names[p] || t(`p.${p}`), credentials: creds[p] ?? {} } });
        setCreds((c) => ({ ...c, [p]: {} }));
      }, t("connected"));
    } finally {
      setConnecting(null);
    }
  };
  const startOAuth = (p: ConnectorProvider) =>
    act(async () => {
      const r = await api<{ authorizeUrl: string }>(`/v1/connectors/oauth/${p}/start`, { method: "POST", body: { name: names[p] || t(`p.${p}`), ...(p === "ironclad" ? { region } : {}) } });
      window.location.href = r.authorizeUrl;
    });

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

      {!canEdit ? (
        <div className="hint" role="note">
          {tc("common.needsViewAll")}
        </div>
      ) : !prov ? (
        <Spinner />
      ) : (
        (["hris", "clm"] as const).map((cat) => (
          <Section key={cat} title={t(`cat.${cat}`)}>
            <div className="settings-grid">
              {prov.items
                .filter((pv) => pv.category === cat)
                .map((pv) => (
                  <div key={pv.provider} className="card pad stack">
                    <strong>{t(`p.${pv.provider}`)}</strong>
                    <label className="field">
                      <span>{t("name")}</span>
                      <input value={names[pv.provider] ?? ""} placeholder={t(`p.${pv.provider}`)} onChange={(e) => setNames((c) => ({ ...c, [pv.provider]: e.target.value }))} />
                    </label>
                    {pv.oauthSupported &&
                      (pv.oauthConfigured ? (
                        <div className="row-wrap">
                          {pv.provider === "ironclad" && (
                            <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label={t("f.region")}>
                              {["na1", "eu1", "demo"].map((r) => (
                                <option key={r}>{r}</option>
                              ))}
                            </select>
                          )}
                          <button type="button" className="btn btn-primary" onClick={() => startOAuth(pv.provider)}>
                            {t("connectOAuth")}
                          </button>
                        </div>
                      ) : (
                        <span className="badge badge-voided">{t("notConfigured")}</span>
                      ))}
                    <form className="stack" onSubmit={(e) => connectKey(e, pv.provider)}>
                      {pv.credentialFields.map((f) => (
                        <label key={f.key} className="field">
                          <span>{t(`f.${f.key}`)}</span>
                          <input
                            required={!f.optional}
                            type={f.secret ? "password" : "text"}
                            autoComplete={f.secret ? "new-password" : "off"}
                            value={creds[pv.provider]?.[f.key] ?? ""}
                            onChange={(e) => setCred(pv.provider, f.key, e.target.value)}
                          />
                        </label>
                      ))}
                      <button className="btn" disabled={connecting !== null}>
                        {t("connectKey")}
                      </button>
                    </form>
                  </div>
                ))}
            </div>
          </Section>
        ))
      )}
      {prov && Object.keys(prov.redirectUris).length > 0 && (
        <details className="card pad" style={{ marginTop: 12 }}>
          <summary className="small">{t("redirects")}</summary>
          <ul className="small break">
            {Object.entries(prov.redirectUris).map(([k, v]) => (
              <li key={k}>
                {t(`p.${k}`)}: <code>{v}</code>
              </li>
            ))}
          </ul>
        </details>
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
              <details>
                <summary className="small">{t("webhook")}</summary>
                <div className="row-wrap">
                  <code className="small break">{c.webhookUrl}</code>
                  <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(c.webhookUrl).then(() => setNote(t("copied")))}>
                    {t("copy")}
                  </button>
                  {canEdit && (
                    <button type="button" className="btn btn-sm" onClick={() => confirmAction() && act(() => api(`/v1/connectors/connections/${c.id}/rotate-webhook`, { method: "POST" }))}>
                      {t("rotate")}
                    </button>
                  )}
                </div>
              </details>
              {canEdit && (
              <div className="row-wrap">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    act(async () => {
                      const r = await api<{ ok: boolean; error: string | null; warning?: string | null }>(`/v1/connectors/connections/${c.id}/test`, { method: "POST" });
                      if (!r.ok) throw new Error(r.error ?? "error");
                      setNote(r.warning === "account_unknown" ? t("testAccountUnknown") : t("testOk"));
                    })
                  }
                >
                  {t("test")}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/connectors/connections/${c.id}`, { method: "PATCH", body: { active: !c.active } }))}>
                  {c.active ? t("deactivate") : t("activate")}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/connectors/connections/${c.id}`, { method: "DELETE" }))}>
                  {t("delete")}
                </button>
              </div>
              )}
            </div>
          ))
        )}
      </Section>

      <Section
        title={t("flows")}
        aside={
          canEdit && conns && conns.length > 0 && editing === null ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing("new")}>
              {t("newFlow")}
            </button>
          ) : null
        }
      >
        {canEdit && editing !== null && conns && (
          <FlowEditor
            key={editing === "new" ? "new" : editing.id}
            flow={editing === "new" ? null : editing}
            connections={conns}
            templates={templates}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              load().catch((e) => setError(errorText(e)));
            }}
          />
        )}
        {!flows ? (
          <Spinner />
        ) : flows.length === 0 ? (
          <div className="empty">{t("noFlows")}</div>
        ) : (
          flows.map((f) => (
            <div key={f.id} className="card pad row-between">
              <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>{f.name}</strong>
                <span className="small muted">
                  {connName(f.connectionId)} · {t(`obj.${f.objectType}`)} · {t(`trg.${f.trigger}`)}
                  {f.templateId ? ` · ${templates.find((x) => x.id === f.templateId)?.name ?? ""}` : ""}
                </span>
              </div>
              <div className="row-wrap">
                <span className={`badge ${f.active ? "badge-completed" : "badge-voided"}`}>{f.active ? t("active") : t("inactive")}</span>
                {canEdit && (
                  <>
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(f)}>
                      {t("edit")}
                    </button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/connectors/flows/${f.id}`, { method: "DELETE" }))}>
                      {t("delete")}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </Section>

      {flows && flows.some((f) => f.active) && <SendFromRecord flows={flows.filter((f) => f.active)} onDone={() => load()} />}

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
                        {r.attempts} {t("attempts")}
                      </div>
                    </td>
                    <td className="row-wrap">
                      {r.envelopeId && (
                        <Link className="btn btn-sm" to={`/app/envelopes/${r.envelopeId}`}>
                          {t("openEnvelope")}
                        </Link>
                      )}
                      {canEdit && r.status === "failed" && (r.kind !== "send" || Boolean(r.detail?.webhook)) && (
                        <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/connectors/runs/${r.id}/retry`, { method: "POST" }))}>
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

// ───────────────────────────── Enviar desde un registro ─────────────────────────────

function SendFromRecord({ flows, onDone }: { flows: ConnectorFlow[]; onDone: () => Promise<unknown> }) {
  const t = useConnText();
  const [flowId, setFlowId] = useState(flows[0]?.id ?? "");
  const flow = flows.find((f) => f.id === flowId) ?? flows[0];
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ConnectorRecordSummary[] | null>(null);
  const [recordId, setRecordId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SendFromConnectorResponse | null>(null);
  // Solo vale la búsqueda del flujo elegido ahora: una respuesta que llegaba después de cambiar de flujo mostraba
  // registros de la otra conexión y "Enviar" los mandaba al flujo nuevo.
  const searchSeq = useRef(0);
  // Si el flujo elegido se borra o desactiva, se pasa al primero disponible y se descartan los registros buscados con
  // el anterior (eran de otra conexión y "Enviar" los mandaba al flujo nuevo).
  useEffect(() => {
    if (flows.some((f) => f.id === flowId)) return;
    searchSeq.current++;
    setFlowId(flows[0]?.id ?? "");
    setResults(null);
  }, [flows, flowId]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!flow) return;
    const mine = ++searchSeq.current;
    setError(null);
    try {
      const r = await api<{ items: ConnectorRecordSummary[] }>(`/v1/connectors/connections/${flow.connectionId}/records?objectType=${flow.objectType}&q=${encodeURIComponent(q)}`);
      if (mine === searchSeq.current) setResults(r.items);
    } catch (err) {
      if (mine === searchSeq.current) setError(errorText(err));
    }
  };
  const send = async (id: string) => {
    if (!flow || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await api<SendFromConnectorResponse>(`/v1/connectors/flows/${flow.id}/send`, { method: "POST", body: { recordId: id } }));
      setRecordId("");
      await onDone().catch(() => undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("sendTitle")}>
      <div className="card pad stack">
        <ErrorBox error={error} />
        {done && (
          <div className="alert alert-success" role="status">
            {t("sendOk")} <Link to={`/app/envelopes/${done.envelopeId}`}>{t("openEnvelope")}</Link>
          </div>
        )}
        <label className="field">
          <span>{t("flows")}</span>
          <select
            value={flowId}
            onChange={(e) => {
              searchSeq.current++;
              setFlowId(e.target.value);
              setResults(null);
            }}
          >
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <form className="row-wrap" onSubmit={search}>
          <input className="grow" value={q} placeholder={t("searchPh")} onChange={(e) => setQ(e.target.value)} aria-label={t("search")} />
          <button className="btn">{t("search")}</button>
        </form>
        {results &&
          (results.length === 0 ? (
            <div className="small muted">{t("noResults")}</div>
          ) : (
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {results.map((r) => (
                <li key={r.id} className="row-between">
                  <span style={{ minWidth: 0 }}>
                    <strong>{r.title}</strong> {r.subtitle && <span className="small muted">· {r.subtitle}</span>}
                  </span>
                  <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => send(r.id)}>
                    {t("sendBtn")}
                  </button>
                </li>
              ))}
            </ul>
          ))}
        <form
          className="row-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (recordId.trim()) void send(recordId.trim());
          }}
        >
          <input className="grow" value={recordId} placeholder={t("recordId")} onChange={(e) => setRecordId(e.target.value)} aria-label={t("recordId")} />
          <button className="btn" disabled={busy || !recordId.trim()}>
            {t("sendBtn")}
          </button>
        </form>
      </div>
    </Section>
  );
}

// ───────────────────────────── Editor de flujos ─────────────────────────────

type RoleRow = CrmRoleMapping;

function FlowEditor({
  flow,
  connections,
  templates,
  onCancel,
  onSaved,
}: {
  flow: ConnectorFlow | null;
  connections: ConnectorConnection[];
  templates: TemplateSummary[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useConnText();
  const [connectionId, setConnectionId] = useState(flow?.connectionId ?? connections[0]?.id ?? "");
  const provider = (connections.find((c) => c.id === connectionId)?.provider ?? "bamboohr") as ConnectorProvider;
  const [name, setName] = useState(flow?.name ?? "");
  const [objectType, setObjectType] = useState<string>(flow?.objectType ?? CONNECTOR_PROVIDER_OBJECTS[provider][0]);
  const [templateId, setTemplateId] = useState(flow?.templateId ?? "");
  const [documentSource, setDocumentSource] = useState<"template" | "record">(flow?.documentSource ?? "template");
  const [roles, setRoles] = useState<RoleRow[]>(flow?.roles ?? []);
  const [prefill, setPrefill] = useState(flow?.prefill ?? []);
  const [uploadSigned, setUploadSigned] = useState(flow?.writeBack.uploadSigned ?? true);
  const [uploadEvidence, setUploadEvidence] = useState(flow?.writeBack.uploadEvidence ?? false);
  const [folder, setFolder] = useState(flow?.writeBack.folder ?? "");
  const [statusProperty, setStatusProperty] = useState(flow?.writeBack.statusProperty ?? "");
  const [completedValue, setCompletedValue] = useState(flow?.writeBack.statusValues?.completed ?? "");
  const [trigger, setTrigger] = useState<"manual" | "webhook">(flow?.trigger ?? "manual");
  const [event, setEvent] = useState(flow?.triggerConfig.event ?? "");
  const [send, setSend] = useState(flow?.send ?? true);
  const [active, setActive] = useState(flow?.active ?? true);
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!CONNECTOR_PROVIDER_OBJECTS[provider].includes(objectType as never)) setObjectType(CONNECTOR_PROVIDER_OBJECTS[provider][0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);
  useEffect(() => {
    if (!DOC_SOURCE_OK(provider, objectType)) setDocumentSource("template");
    if (!STATUS_OK(provider, objectType)) setStatusProperty("");
  }, [provider, objectType]);

  // Roles en pantalla = los de la plantilla elegida (al editar, los guardados mientras sea la misma plantilla).
  const rolesFrom = useRef(flow?.templateId ?? "");
  // Error al leer la plantilla elegida: aparte del de guardar, para que se borre al elegir otra.
  const [tplError, setTplError] = useState<string | null>(null);
  useEffect(() => {
    setTplError(null);
    if (!templateId) return setTpl(null);
    let stale = false;
    api<TemplateDetail>(`/v1/templates/${templateId}`)
      .then((d) => {
        if (stale) return;
        setTpl(d);
        if (rolesFrom.current === templateId) return;
        rolesFrom.current = templateId;
        setRoles(flow && templateId === flow.templateId ? flow.roles : d.roles.map((r, i) => ({ role: r.name, source: "contact", index: i, channels: ["email"] }) as RoleRow));
      })
      .catch((e) => {
        if (stale) return;
        setTpl(null);
        setTplError(errorText(e));
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  const setRole = (i: number, patch: Record<string, unknown>) => setRoles((rs) => rs.map((r, j) => (j === i ? ({ ...r, ...patch } as RoleRow) : r)));
  const changeSource = (i: number, source: RoleRow["source"]) =>
    setRoles((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const base = { role: r.role, channels: r.channels };
        if (source === "contact") return { ...base, source, index: 0 } as RoleRow;
        if (source === "contact_role") return { ...base, source, contactRole: "manager", primary: false } as RoleRow;
        if (source === "property") return { ...base, source, nameProperty: "", emailProperty: "" } as RoleRow;
        return { ...base, source, name: "", email: "" } as RoleRow;
      }),
    );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Se conservan los valores de los otros estados (enviado, rechazado, …), que solo se configuran por API: antes
    // cualquier guardado desde acá los borraba.
    const sv: Record<string, string> = { ...(flow?.writeBack.statusValues ?? {}) };
    if (completedValue) sv.completed = completedValue;
    else delete sv.completed;
    const statusValues = Object.keys(sv).length ? (sv as ConnectorFlow["writeBack"]["statusValues"]) : undefined;
    const body = {
      name,
      objectType,
      templateId,
      documentSource,
      // Sin "" ni null: un correo fijo vacío no pasa la validación de correo de la API (como en los mapeos de CRM).
      roles: roles.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "" && v !== null))),
      prefill: prefill.filter((p) => p.field && p.property),
      writeBack: { uploadSigned, uploadEvidence, folder: folder || null, statusProperty: statusProperty || null, statusValues },
      trigger,
      triggerConfig: { event: event || null },
      send,
      active,
    };
    try {
      if (flow) await api(`/v1/connectors/flows/${flow.id}`, { method: "PATCH", body });
      else await api("/v1/connectors/flows", { method: "POST", body: { ...body, connectionId } });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const fieldLabels = [...new Set((tpl?.fields ?? []).map((f) => f.label).filter(Boolean) as string[])];
  // Mientras carga la plantilla recién elegida (o si no se pudo leer) siguen en pantalla los roles de la anterior:
  // guardar en ese momento los mandaba con la plantilla nueva y el envío fallaba.
  const tplPending = Boolean(templateId) && tpl?.template.id !== templateId;

  return (
    <form className="card pad stack" onSubmit={save} style={{ marginBottom: 12 }}>
      <strong>{flow ? t("editFlow") : t("newFlow")}</strong>
      <ErrorBox error={error ?? tplError} />
      <div className="row-wrap">
        <label className="field grow">
          <span>{t("fl.connection")}</span>
          <select value={connectionId} disabled={Boolean(flow)} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {t(`p.${c.provider}`)} · {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{t("fl.name")}</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <div className="row-wrap">
        <label className="field grow">
          <span>{t("fl.objectType")}</span>
          <select value={objectType} onChange={(e) => setObjectType(e.target.value)}>
            {CONNECTOR_PROVIDER_OBJECTS[provider].map((o) => (
              <option key={o} value={o}>
                {t(`obj.${o}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{t("fl.template")}</span>
          <select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t("fl.pickTemplate")}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {DOC_SOURCE_OK(provider, objectType) && (
        <label className="field">
          <span>{t("fl.docSource")}</span>
          <select value={documentSource} onChange={(e) => setDocumentSource(e.target.value as "template" | "record")}>
            <option value="template">{t("fl.docSource.template")}</option>
            <option value="record">{t("fl.docSource.record")}</option>
          </select>
        </label>
      )}

      {roles.length > 0 && (
        <fieldset className="stack">
          <legend>{t("fl.roles")}</legend>
          {roles.map((r, i) => (
            <div key={`${r.role}-${i}`} className="row-wrap">
              <strong style={{ minWidth: 100 }}>{r.role}</strong>
              <select value={r.source} onChange={(e) => changeSource(i, e.target.value as RoleRow["source"])} aria-label={t("fl.source")}>
                {(["contact", "contact_role", "property", "fixed"] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`src.${s}`)}
                  </option>
                ))}
              </select>
              {r.source === "contact" && (
                <OrderInput min={1} max={50} style={{ width: 80 }} aria-label={t("fl.index")} value={(r.index ?? 0) + 1} onChange={(n) => setRole(i, { index: n - 1 })} />
              )}
              {r.source === "contact_role" && (
                <>
                  <input aria-label={t("fl.contactRole")} placeholder={t("fl.contactRole")} value={r.contactRole ?? ""} disabled={Boolean(r.primary)} onChange={(e) => setRole(i, { contactRole: e.target.value })} />
                  <label className="row-wrap small">
                    <input type="checkbox" checked={Boolean(r.primary)} onChange={(e) => setRole(i, { primary: e.target.checked })} /> {t("fl.primary")}
                  </label>
                </>
              )}
              {r.source === "property" && (
                <>
                  <input required placeholder={t("fl.nameProp")} aria-label={t("fl.nameProp")} value={r.nameProperty} onChange={(e) => setRole(i, { nameProperty: e.target.value })} />
                  <input placeholder={t("fl.emailProp")} aria-label={t("fl.emailProp")} value={r.emailProperty ?? ""} onChange={(e) => setRole(i, { emailProperty: e.target.value })} />
                </>
              )}
              {r.source === "fixed" && (
                <>
                  <input required placeholder={t("fl.fixedName")} aria-label={t("fl.fixedName")} value={r.name} onChange={(e) => setRole(i, { name: e.target.value })} />
                  <input type="email" placeholder={t("fl.fixedEmail")} aria-label={t("fl.fixedEmail")} value={r.email ?? ""} onChange={(e) => setRole(i, { email: e.target.value })} />
                </>
              )}
            </div>
          ))}
        </fieldset>
      )}

      <fieldset className="stack">
        <legend>{t("fl.prefill")}</legend>
        {prefill.map((p, i) => (
          <div key={i} className="row-wrap">
            <input list="conn-fields" placeholder={t("fl.field")} aria-label={t("fl.field")} value={p.field} onChange={(e) => setPrefill((ps) => ps.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} />
            <span>←</span>
            <input placeholder={t("fl.property")} aria-label={t("fl.property")} value={p.property} onChange={(e) => setPrefill((ps) => ps.map((x, j) => (j === i ? { ...x, property: e.target.value } : x)))} />
            <button type="button" className="btn btn-sm" onClick={() => setPrefill((ps) => ps.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <datalist id="conn-fields">
          {fieldLabels.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <div>
          <button type="button" className="btn btn-sm" onClick={() => setPrefill((ps) => [...ps, { field: "", property: "" }])}>
            {t("fl.addPrefill")}
          </button>
        </div>
      </fieldset>

      <fieldset className="stack">
        <legend>{t("fl.writeBack")}</legend>
        <label className="row-wrap">
          <input type="checkbox" checked={uploadSigned} onChange={(e) => setUploadSigned(e.target.checked)} /> {t("fl.uploadSigned")}
        </label>
        <label className="row-wrap">
          <input type="checkbox" checked={uploadEvidence} onChange={(e) => setUploadEvidence(e.target.checked)} /> {t("fl.uploadEvidence")}
        </label>
        <label className="field">
          <span>{t("fl.folder")}</span>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
        {STATUS_OK(provider, objectType) && (
          <div className="row-wrap">
            <label className="field grow">
              <span>{t("fl.statusProperty")}</span>
              <input value={statusProperty} onChange={(e) => setStatusProperty(e.target.value)} />
            </label>
            <label className="field grow">
              <span>{t("fl.completedValue")}</span>
              <input value={completedValue} disabled={!statusProperty} onChange={(e) => setCompletedValue(e.target.value)} />
            </label>
          </div>
        )}
      </fieldset>

      <div className="row-wrap">
        <label className="field grow">
          <span>{t("fl.trigger")}</span>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as "manual" | "webhook")}>
            <option value="manual">{t("trg.manual")}</option>
            <option value="webhook">{t("trg.webhook")}</option>
          </select>
        </label>
        {trigger === "webhook" && (
          <label className="field grow">
            <span>{t("fl.event")}</span>
            <input value={event} onChange={(e) => setEvent(e.target.value)} />
          </label>
        )}
      </div>
      <label className="row-wrap">
        <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> {t("fl.send")}
      </label>
      <label className="row-wrap">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t("fl.active")}
      </label>
      <div className="row-end">
        <button type="button" className="btn" onClick={onCancel}>
          {t("cancel")}
        </button>
        <button className="btn btn-primary" disabled={busy || !templateId || tplPending}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}
