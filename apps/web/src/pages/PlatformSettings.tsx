// Ajustes de plataforma: apps OAuth, avisos a canales (Slack, Teams, Discord…), Zapier/Make, almacenamiento en la nube y dominio propio.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_KINDS,
  OAUTH_SCOPES,
  type ConnectedApp,
  type CreateOAuthAppResponse,
  type CustomDomain,
  type NotificationIntegration,
  type NotificationKind,
  type OAuthApp,
  type OAuthGrantType,
  type OAuthScope,
  type Permission,
  type StorageConnection,
  type StorageExport,
  type StorageProvider,
  type StorageProviderInfo,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n, confirmAction, placeholderText, interpolate } from "../lib/i18n";
import { usePlatformText } from "../lib/i18n-platform";
import { useConnText } from "../lib/i18n-connectors";
import { useRoleLabel } from "../lib/i18n-teams";
import { ErrorBox, Spinner } from "../components/ui";
import { canManagePerms, PlanNotice, useAccess } from "../lib/access";

// ───────────────────────────── Comunes ─────────────────────────────

function Page({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  const p = usePlatformText();
  return (
    <div className="page narrow">
      <Link to="/app/settings" className="muted small">
        {p("common.back")}
      </Link>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <p className="muted">{intro}</p>
      {children}
    </div>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const p = usePlatformText();
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <span className="small muted">{label}</span>
      <div className="secret-row">
        <code className="secret break">{value}</code>
        <button
          type="button"
          className="btn btn-sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              /* copia manual */
            }
          }}
        >
          {copied ? p("common.copied") : p("common.copy")}
        </button>
      </div>
    </div>
  );
}

/** Ejecuta una acción, recarga y muestra el error si falla. */
function useAct(reload: () => Promise<unknown>) {
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return { error, setError, act };
}

// ───────────────────────────── Apps OAuth ─────────────────────────────

export function OAuthAppsPage() {
  const p = usePlatformText();
  const { can } = useAccess();
  if (!can("api_keys:manage")) {
    return (
      <Page title={p("oauth.title")} intro={p("oauth.connected.intro")}>
        <ConnectedApps />
      </Page>
    );
  }
  return <OAuthAppsAdmin />;
}

function OAuthAppsAdmin() {
  const p = usePlatformText();
  const roleLabel = useRoleLabel();
  const { locale } = useI18n();
  const [apps, setApps] = useState<OAuthApp[] | null>(null);
  const [shown, setShown] = useState<{ clientId: string; secret: string | null } | null>(null);
  const load = () => api<{ items: OAuthApp[] }>("/v1/oauth/apps").then((r) => setApps(r.items));
  const { error, setError, act } = useAct(load);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [grants, setGrants] = useState<OAuthGrantType[]>(["client_credentials"]);
  const [redirects, setRedirects] = useState("");
  const [scopes, setScopes] = useState<OAuthScope[]>(["envelopes:read", "envelopes:write"]);
  const [confidential, setConfidential] = useState(true);
  // "member", "admin" o "custom:<id>". Como en las API keys: la API rechaza (403) un rol con permisos que quien crea la
  // app no tiene, y con solo Miembro/Administrador alguien con un rol personalizado con api_keys:manage no podía crear
  // ninguna app de servicio.
  const [role, setRole] = useState("member");
  const { access, hasFeature } = useAccess();
  const inPlan = hasFeature("api");
  const [roleOptions, setRoleOptions] = useState<{ value: string; role: string; name: string | null; permissions: Permission[] }[]>([]);
  useEffect(() => {
    api<{ items: { id: string; name: string; permissions: Permission[] }[]; builtin: { role: string; permissions: Permission[] }[] }>("/v1/roles")
      .then((r) =>
        setRoleOptions([
          ...r.builtin.filter((b) => b.role !== "owner").map((b) => ({ value: b.role, role: b.role, name: null, permissions: b.permissions })),
          ...r.items.map((x) => ({ value: `custom:${x.id}`, role: "custom", name: x.name, permissions: x.permissions })),
        ]),
      )
      .catch(() => undefined);
  }, []);
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || !access || roleOptions.length === 0) return;
    defaulted.current = true;
    if (access.role === "owner") return;
    const grantable = (o: { permissions: Permission[] }) => o.permissions.every((x) => access.permissions.includes(x));
    if (roleOptions.some((o) => o.value === "member" && grantable(o))) return;
    const first = roleOptions.find(grantable);
    if (first) setRole((cur) => (cur === "member" ? first.value : cur));
  }, [access, roleOptions]);
  const [busy, setBusy] = useState(false);
  // Permisos del rol de una app de servicio (o del rol elegido): la API rechaza crear, rotar o revocar una app cuyo rol
  // tiene permisos que quien está en la sesión no tiene (assertCanGrantRole / assertCanManageServiceApp).
  const permsOfRole = (r: string | null, roleId: string | null) =>
    !r ? [] : roleOptions.find((o) => o.value === (r === "custom" ? `custom:${roleId}` : r))?.permissions ?? null;
  const roleGrantable = canManagePerms(access, roleOptions.find((o) => o.value === role)?.permissions);

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<CreateOAuthAppResponse>("/v1/oauth/apps", {
        method: "POST",
        body: {
          name,
          description: description || null,
          grantTypes: grants,
          // Solo con "authorization_code" (el campo se oculta sin ese tipo): lo escrito antes de destildarlo se mandaba
          // igual y una URI inválida que ya no se veía hacía fallar el alta.
          redirectUris: grants.includes("authorization_code")
            ? redirects
                .split(/\s+/)
                .map((x) => x.trim())
                .filter(Boolean)
            : [],
          scopes,
          confidential: grants.includes("client_credentials") ? true : confidential,
          ...(grants.includes("client_credentials") ? (role.startsWith("custom:") ? { role: "custom", roleId: role.slice(7) } : { role }) : {}),
        },
      });
      setShown({ clientId: r.app.clientId, secret: r.clientSecret });
      setName("");
      setDescription("");
      setRedirects("");
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const origin = window.location.origin;
  return (
    <Page title={p("oauth.title")} intro={p("oauth.intro")}>
      <p className="small muted">
        {p("oauth.endpoints", { authorize: `${origin}/oauth/authorize`, token: `${origin}/oauth/token`, revoke: `${origin}/oauth/revoke` })}
      </p>
      <PlanNotice feature="api" />

      <form onSubmit={create} className="card pad stack" aria-label={p("oauth.new")}>
        <h2 style={{ margin: 0 }}>{p("oauth.new")}</h2>
        <div className="row-wrap">
          <label className="field grow">
            <span>{p("oauth.name")}</span>
            <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholderText("integration")} />
          </label>
          <label className="field grow">
            <span>{p("oauth.description")}</span>
            <input maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <fieldset className="field">
          <span>{p("oauth.grants")}</span>
          <div className="stack" style={{ gap: 4 }}>
            {(["client_credentials", "authorization_code"] as const).map((g) => (
              <label key={g} className="check">
                <input type="checkbox" checked={grants.includes(g)} onChange={(e) => setGrants((cur) => toggle(cur, g, e.target.checked))} /> {p(`oauth.grant.${g}`)}
              </label>
            ))}
          </div>
        </fieldset>
        {grants.includes("authorization_code") && (
          <>
            <label className="field">
              <span>{p("oauth.redirects")}</span>
              <textarea rows={2} required value={redirects} onChange={(e) => setRedirects(e.target.value)} placeholder={`https://app.${placeholderText("domain")}/oauth/callback`} />
            </label>
            {!grants.includes("client_credentials") && (
              <label className="check">
                <input type="checkbox" checked={confidential} onChange={(e) => setConfidential(e.target.checked)} /> {p("oauth.confidential")}
              </label>
            )}
          </>
        )}
        {grants.includes("client_credentials") && (
          <label className="field" style={{ maxWidth: 320 }}>
            <span>{p("oauth.role")}</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {(roleOptions.length ? roleOptions : [{ value: "member", role: "member", name: null, permissions: null }, { value: "admin", role: "admin", name: null, permissions: null }]).map((o) => (
                <option key={o.value} value={o.value} disabled={!canManagePerms(access, o.permissions)}>
                  {o.name ?? roleLabel(o.role)}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="field">
          <span>{p("oauth.scopes")}</span>
          <div className="chips">
            {OAUTH_SCOPES.map((s) => (
              <label key={s} className="check" title={p(`scope.${s}`)}>
                <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes((cur) => toggle(cur, s, e.target.checked))} /> <code>{s}</code>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy || !name.trim() || grants.length === 0 || scopes.length === 0 || !inPlan || (grants.includes("client_credentials") && !roleGrantable)}>
            {p("oauth.create")}
          </button>
        </div>
      </form>

      {shown && (
        <div className="alert alert-success stack" role="status">
          {shown.secret && <strong>{p("oauth.secretOnce")}</strong>}
          {/* Clave por valor: al rotar el secreto (o crear otra app) el "Copiado" del anterior no queda sobre el nuevo. */}
          <CopyBox key={shown.clientId} label={p("oauth.clientId")} value={shown.clientId} />
          {shown.secret && <CopyBox key={shown.secret} label={p("oauth.clientSecret")} value={shown.secret} />}
        </div>
      )}

      <ErrorBox error={error} />

      {!apps ? (
        <Spinner />
      ) : apps.length === 0 ? (
        <div className="empty">{p("oauth.empty")}</div>
      ) : (
        apps.map((a) => (
          <div key={a.id} className="card pad stack">
            <div className="row-between">
              <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>{a.name}</strong>
                <code className="small break">{a.clientId}</code>
                <span className="muted small">
                  {a.grantTypes.map((g) => p(`oauth.grant.${g}`)).join(" · ")}
                  {a.role ? ` · ${roleLabel(a.role, roleOptions.find((o) => o.value === `custom:${a.roleId}`)?.name)}` : ""} · {a.confidential ? <code>{a.secretPrefix}…</code> : p("oauth.public")}
                </span>
                <span className="small">{a.scopes.map((s) => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}</span>
                {a.redirectUris.length > 0 && <span className="muted small break">{a.redirectUris.join(" · ")}</span>}
                <span className="muted small">
                  {formatDateTime(a.createdAt, locale)} · {p("oauth.activeTokens", { n: a.activeTokens })}
                </span>
              </div>
              <span className={`badge ${a.revokedAt ? "badge-voided" : "badge-completed"}`}>{a.revokedAt ? p("oauth.revoked") : p("common.active")}</span>
            </div>
            {!a.revokedAt && canManagePerms(access, permsOfRole(a.role, a.roleId)) && (
              <div className="row-wrap">
                {/* Rotar también exige poder hacerse cargo de la app (la API lo informa en canTakeOver). */}
                {a.confidential && a.canTakeOver !== false && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      confirmAction() &&
                      act(async () => {
                        const r = await api<CreateOAuthAppResponse>(`/v1/oauth/apps/${a.id}/rotate-secret`, { method: "POST" });
                        setShown({ clientId: r.app.clientId, secret: r.clientSecret });
                      })
                    }
                  >
                    {p("oauth.rotate")}
                  </button>
                )}
                <span className="grow" />
                <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/oauth/apps/${a.id}`, { method: "DELETE" }))}>
                  {p("oauth.revoke")}
                </button>
              </div>
            )}
          </div>
        ))
      )}

      <ConnectedApps />
    </Page>
  );
}

function ConnectedApps() {
  const p = usePlatformText();
  const { locale } = useI18n();
  const [items, setItems] = useState<ConnectedApp[] | null>(null);
  const load = () => api<{ items: ConnectedApp[] }>("/v1/oauth/connected-apps").then((r) => setItems(r.items));
  const { error, setError, act } = useAct(load);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="stack" style={{ marginTop: 28 }}>
      <h2>{p("oauth.connected")}</h2>
      <p className="muted small">{p("oauth.connected.intro")}</p>
      <ErrorBox error={error} />
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{p("oauth.connected.empty")}</div>
      ) : (
        items.map((c) => (
          <div key={c.clientId} className="card pad row-between">
            <div className="stack" style={{ gap: 2 }}>
              <strong>{c.name}</strong>
              <span className="muted small">
                {c.unverified ? p("consent.unverifiedTag") : c.organizationName} · {formatDateTime(c.authorizedAt, locale)}
              </span>
              <span className="small">{c.scopes.map((s) => p(`scope.${s}`)).join(" · ")}</span>
            </div>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/oauth/connected-apps/${c.clientId}`, { method: "DELETE" }))}>
              {p("oauth.disconnect")}
            </button>
          </div>
        ))
      )}
    </section>
  );
}

// ───────────────────────────── Avisos a canales ─────────────────────────────

/** Nombre de cada plataforma y un ejemplo de su URL de webhook entrante. */
/** `name`: prefijo del canal ("#", "~") o "" para un equipo; el nombre de ejemplo va en el idioma de la interfaz. */
const CHANNELS: Record<NotificationKind, { label: string; url: string; name: string }> = {
  slack: { label: "Slack", url: "https://hooks.slack.com/services/…", name: "#" },
  teams: { label: "Microsoft Teams", url: "https://….powerplatform.com/powerautomate/automations/direct/workflows/…", name: "" },
  discord: { label: "Discord", url: "https://discord.com/api/webhooks/…", name: "#" },
  google_chat: { label: "Google Chat", url: "https://chat.googleapis.com/v1/spaces/…/messages?key=…", name: "" },
  mattermost: { label: "Mattermost", url: "https://mattermost.{domain}/hooks/…", name: "~" },
  rocketchat: { label: "Rocket.Chat", url: "https://chat.{domain}/hooks/…", name: "#" },
  webex: { label: "Webex", url: "https://webexapis.com/v1/webhooks/incoming/…", name: "" },
};
const channelNamePlaceholder = (k: NotificationKind) => (CHANNELS[k].name ? `${CHANNELS[k].name}${placeholderText("chatChannel")}` : placeholderText("chatTeam"));
const channelUrlPlaceholder = (k: NotificationKind) => interpolate(CHANNELS[k].url, { domain: placeholderText("domain") });

export function NotificationIntegrationsPage() {
  const p = usePlatformText();
  const { locale, t } = useI18n();
  // La API pide además envelopes:view_all para cambiar avisos (reciben datos de todos los sobres).
  const canEdit = useAccess().can("envelopes:view_all");
  const [items, setItems] = useState<NotificationIntegration[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = () => api<{ items: NotificationIntegration[] }>("/v1/notification-integrations").then((r) => setItems(r.items));
  const { error, setError, act } = useAct(load);
  const [kind, setKind] = useState<NotificationKind>("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["envelope.completed", "envelope.declined"]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/v1/notification-integrations", { method: "POST", body: { kind, name, url, events } });
      setName("");
      setUrl("");
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={p("ntf.title")} intro={p("ntf.intro")}>
      {!canEdit ? (
        <div className="hint" role="note">
          {t("common.needsViewAll")}
        </div>
      ) : (
      <form onSubmit={add} className="card pad stack">
        <fieldset className="field">
          <span>{p("ntf.kind")}</span>
          <div className="chips" role="radiogroup">
            {NOTIFICATION_KINDS.map((k) => (
              <label key={k} className="check">
                <input type="radio" name="ntf-kind" value={k} checked={kind === k} onChange={() => setKind(k)} /> {CHANNELS[k].label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="hint" role="note">
          <strong>{p("ntf.how")}</strong> — {p(`ntf.how.${kind}`)}
        </div>
        <div className="row-wrap">
          <label className="field grow">
            <span>{p("ntf.name")}</span>
            <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={channelNamePlaceholder(kind)} />
          </label>
        </div>
        <label className="field">
          <span>{p("ntf.url")}</span>
          <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder={channelUrlPlaceholder(kind)} />
        </label>
        <fieldset className="field">
          <span>{p("ntf.events")}</span>
          <div className="chips">
            {NOTIFICATION_EVENTS.map((ev) => (
              <label key={ev} className="check">
                <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))} />{" "}
                {p(`ntf.ev.${ev}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy || !url || !name || events.length === 0}>
            {p("ntf.add")}
          </button>
        </div>
      </form>
      )}

      <ErrorBox error={error} />
      {note && (
        <div className="alert alert-success" role="status">
          {note}
        </div>
      )}

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{p("ntf.empty")}</div>
      ) : (
        items.map((it) => (
          <div key={it.id} className="card pad stack">
            <div className="row-between">
              <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>
                  {CHANNELS[it.kind]?.label ?? it.kind} · {it.name}
                </strong>
                <code className="small break">{it.urlHint}</code>
                <span className="muted small">{it.events.map((ev) => p(`ntf.ev.${ev}`)).join(" · ")}</span>
                <span className="muted small">
                  {it.lastSentAt ? p("ntf.last", { when: formatDateTime(it.lastSentAt, locale), status: it.lastStatus ? `HTTP ${it.lastStatus}` : it.lastError ?? "—" }) : p("common.never")}
                </span>
                {it.lastError && <span className="small" style={{ color: "#b91c1c" }}>{it.lastError}</span>}
              </div>
              <span className={`badge ${it.active ? "badge-completed" : "badge-voided"}`}>{it.active ? p("common.active") : p("common.inactive")}</span>
            </div>
            {canEdit && (
            <div className="row-wrap">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  act(async () => {
                    // Como en almacenamiento: el aviso de una prueba anterior no queda a la vista, y una prueba fallida
                    // se muestra como error (antes salía en el recuadro verde de éxito).
                    setNote(null);
                    const r = await api<{ ok: boolean; error: string | null }>(`/v1/notification-integrations/${it.id}/test`, { method: "POST" });
                    if (r.ok) setNote(p("ntf.testOk"));
                    else setError(p("ntf.testFail", { error: r.error ?? "?" }));
                  })
                }
              >
                {p("common.test")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/notification-integrations/${it.id}`, { method: "PATCH", body: { active: !it.active } }))}>
                {it.active ? p("common.deactivate") : p("common.activate")}
              </button>
              <span className="grow" />
              <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/notification-integrations/${it.id}`, { method: "DELETE" }))}>
                {p("common.delete")}
              </button>
            </div>
            )}
          </div>
        ))
      )}
    </Page>
  );
}

// ───────────────────────────── Zapier / Make ─────────────────────────────

export function AutomationPage() {
  const p = usePlatformText();
  return (
    <Page title={p("auto.title")} intro={p("auto.intro")}>
      <ol className="card pad stack" style={{ paddingLeft: 36 }}>
        <li>{p("auto.step1")}</li>
        <li>{p("auto.step2")}</li>
        <li>{p("auto.step3")}</li>
        <li>{p("auto.step4")}</li>
      </ol>
      <h2>{p("auto.recipes")}</h2>
      <ul>
        <li>{p("auto.r1")}</li>
        <li>{p("auto.r2")}</li>
        <li>{p("auto.r3")}</li>
      </ul>
      <div className="row-wrap">
        <Link className="btn" to="/app/settings/integrations">
          {p("auto.toWebhooks")}
        </Link>
        <Link className="btn" to="/app/settings/api-keys">
          {p("auto.toKeys")}
        </Link>
        <Link className="btn btn-ghost" to="/developers">
          /developers
        </Link>
      </div>
    </Page>
  );
}

// ───────────────────────────── Almacenamiento ─────────────────────────────

export function StoragePage() {
  const p = usePlatformText();
  const { locale, t } = useI18n();
  // La API pide además envelopes:view_all para conectar o cambiar destinos (reciben los PDF de todos los sobres).
  const canEdit = useAccess().can("envelopes:view_all");
  const [params] = useSearchParams();
  const [providers, setProviders] = useState<StorageProviderInfo[] | null>(null);
  const [conns, setConns] = useState<StorageConnection[] | null>(null);
  const [exports, setExports] = useState<StorageExport[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = () =>
    Promise.all([
      api<{ items: StorageProviderInfo[] }>("/v1/storage/providers").then((r) => setProviders(r.items)),
      api<{ items: StorageConnection[] }>("/v1/storage/connections").then((r) => setConns(r.items)),
      // El historial lista asuntos de sobres de toda la organización: la API lo limita a envelopes:view_all.
      canEdit ? api<{ items: StorageExport[] }>("/v1/storage/exports?limit=25").then((r) => setExports(r.items)) : Promise.resolve(setExports([])),
    ]);
  const { error, setError, act } = useAct(load);

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    if (params.get("connected")) setNote(p("sto.connected"));
    if (params.get("error")) setError(p("sto.error", { code: params.get("error") ?? "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [oauthName, setOauthName] = useState<Record<string, string>>({});
  const [oauthFolder, setOauthFolder] = useState<Record<string, string>>({});
  const cn = useConnText();
  const [siteUrl, setSiteUrl] = useState("");
  const [library, setLibrary] = useState("");
  const [withEvidence, setWithEvidence] = useState<Record<string, boolean>>({});
  const startOAuth = (prov: StorageProvider) =>
    act(async () => {
      const r = await api<{ authorizeUrl: string }>(`/v1/storage/oauth/${prov}/start`, {
        method: "POST",
        body: {
          name: oauthName[prov] || p(`sto.p.${prov}`),
          folder: oauthFolder[prov] ?? "",
          includeEvidence: Boolean(withEvidence[prov]),
          ...(prov === "sharepoint" ? { siteUrl, library: library || undefined } : {}),
        },
      });
      window.location.href = r.authorizeUrl;
    });

  const [s3, setS3] = useState({ name: "", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", bucket: "", prefix: "calasign", accessKeyId: "", secretAccessKey: "" });
  const [busy, setBusy] = useState(false);
  const addS3 = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/v1/storage/connections/s3", { method: "POST", body: { ...s3, name: s3.name || s3.bucket } });
      setS3((cur) => ({ ...cur, accessKeyId: "", secretAccessKey: "" }));
      setNote(p("sto.connected"));
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof s3) => (e: { target: { value: string } }) => setS3((cur) => ({ ...cur, [k]: e.target.value }));

  return (
    <Page title={p("sto.title")} intro={p("sto.intro")}>
      <ErrorBox error={error} />
      {note && (
        <div className="alert alert-success" role="status">
          {note}
        </div>
      )}

      {!canEdit ? (
        <div className="hint" role="note">
          {t("common.needsViewAll")}
        </div>
      ) : (
      <>
      {!providers ? (
        <Spinner />
      ) : (
        <div className="settings-grid">
          {providers
            .filter((pv) => pv.provider !== "s3")
            .map((pv) => (
              <div key={pv.provider} className="card pad stack">
                <strong>{p(`sto.p.${pv.provider}`)}</strong>
                {pv.configured ? (
                  <>
                    <label className="field">
                      <span>{p("sto.name")}</span>
                      <input value={oauthName[pv.provider] ?? ""} placeholder={p(`sto.p.${pv.provider}`)} onChange={(e) => setOauthName((c) => ({ ...c, [pv.provider]: e.target.value }))} />
                    </label>
                    <label className="field">
                      <span>{p("sto.folder")}</span>
                      <input value={oauthFolder[pv.provider] ?? ""} placeholder="CalaSign" onChange={(e) => setOauthFolder((c) => ({ ...c, [pv.provider]: e.target.value }))} />
                      <span className="small muted">{p("sto.folder.hint")}</span>
                    </label>
                    {pv.provider === "sharepoint" && (
                      <>
                        <label className="field">
                          <span>{cn("sto.siteUrl")}</span>
                          <input type="url" required value={siteUrl} placeholder="https://empresa.sharepoint.com/sites/Legal" onChange={(e) => setSiteUrl(e.target.value)} />
                        </label>
                        <label className="field">
                          <span>{cn("sto.library")}</span>
                          <input value={library} onChange={(e) => setLibrary(e.target.value)} />
                        </label>
                      </>
                    )}
                    <label className="row-wrap small">
                      <input type="checkbox" checked={Boolean(withEvidence[pv.provider])} onChange={(e) => setWithEvidence((c) => ({ ...c, [pv.provider]: e.target.checked }))} />
                      {cn("sto.evidence")}
                    </label>
                    <button type="button" className="btn btn-primary" disabled={pv.provider === "sharepoint" && !siteUrl} onClick={() => startOAuth(pv.provider)}>
                      {p("sto.connect")}
                    </button>
                  </>
                ) : (
                  <span className="badge badge-voided">{p("common.notConfigured")}</span>
                )}
              </div>
            ))}
        </div>
      )}

      <form onSubmit={addS3} className="card pad stack" style={{ marginTop: 16 }}>
        <strong>{p("sto.p.s3")}</strong>
        <div className="row-wrap">
          <label className="field grow">
            <span>{p("sto.s3.endpoint")}</span>
            <input type="url" required value={s3.endpoint} onChange={set("endpoint")} />
          </label>
          <label className="field">
            <span>{p("sto.s3.region")}</span>
            <input required value={s3.region} onChange={set("region")} />
          </label>
        </div>
        <div className="row-wrap">
          <label className="field grow">
            <span>{p("sto.s3.bucket")}</span>
            <input required value={s3.bucket} onChange={set("bucket")} />
          </label>
          <label className="field grow">
            <span>{p("sto.s3.prefix")}</span>
            <input value={s3.prefix} onChange={set("prefix")} />
          </label>
          <label className="field grow">
            <span>{p("sto.name")}</span>
            <input value={s3.name} onChange={set("name")} placeholder={s3.bucket} />
          </label>
        </div>
        <div className="row-wrap">
          <label className="field grow">
            <span>{p("sto.s3.key")}</span>
            <input required autoComplete="off" value={s3.accessKeyId} onChange={set("accessKeyId")} />
          </label>
          <label className="field grow">
            <span>{p("sto.s3.secret")}</span>
            <input required type="password" autoComplete="new-password" value={s3.secretAccessKey} onChange={set("secretAccessKey")} />
          </label>
        </div>
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy}>
            {p("sto.s3.add")}
          </button>
        </div>
      </form>
      </>
      )}

      <h2 style={{ marginTop: 24 }}>{p("sto.connections")}</h2>
      {!conns ? (
        <Spinner />
      ) : conns.length === 0 ? (
        <div className="empty">{p("sto.empty")}</div>
      ) : (
        conns.map((c) => (
          <div key={c.id} className="card pad stack">
            <div className="row-between">
              <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>
                  {p(`sto.p.${c.provider}`).split(" (")[0]} · {c.name}
                </strong>
                <span className="muted small break">
                  {c.accountLabel ? `${c.accountLabel} · ` : ""}
                  <code>{c.target}</code>
                </span>
                <span className="muted small">{c.lastSuccessAt ? p("sto.lastOk", { when: formatDateTime(c.lastSuccessAt, locale) }) : p("common.never")}</span>
                {c.lastError && <span className="small" style={{ color: "#b91c1c" }}>{c.lastError}</span>}
              </div>
              <span className={`badge ${c.active ? "badge-completed" : "badge-voided"}`}>{c.active ? p("common.active") : p("common.inactive")}</span>
            </div>
            {canEdit && (
            <div className="row-wrap">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  act(async () => {
                    // Sin esto, el "prueba correcta" de otra conexión seguía a la vista junto al error de esta.
                    setNote(null);
                    const r = await api<{ ok: boolean; ref: string | null; error: string | null }>(`/v1/storage/connections/${c.id}/test`, { method: "POST" });
                    if (r.ok) setNote(p("sto.testOk", { ref: r.ref ?? "" }));
                    else setError(r.error);
                  })
                }
              >
                {p("common.test")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/storage/connections/${c.id}`, { method: "PATCH", body: { active: !c.active } }))}>
                {c.active ? p("common.deactivate") : p("common.activate")}
              </button>
              <label className="row-wrap small">
                <input
                  type="checkbox"
                  checked={c.includeEvidence}
                  onChange={(e) => act(() => api(`/v1/storage/connections/${c.id}`, { method: "PATCH", body: { includeEvidence: e.target.checked } }))}
                />
                {cn("sto.evidence")}
              </label>
              <span className="grow" />
              <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api(`/v1/storage/connections/${c.id}`, { method: "DELETE" }))}>
                {p("common.delete")}
              </button>
            </div>
            )}
          </div>
        ))
      )}

      {canEdit && <h2 style={{ marginTop: 24 }}>{p("sto.exports")}</h2>}
      {!canEdit ? null : !exports ? (
        <Spinner />
      ) : exports.length === 0 ? (
        <div className="empty">{p("sto.exports.empty")}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <tbody>
              {exports.map((x) => (
                <tr key={x.id}>
                  <td className="small">{formatDateTime(x.createdAt, locale)}</td>
                  <td>
                    <Link to={`/app/envelopes/${x.envelopeId}`}>{x.envelopeSubject}</Link>
                    <div className="muted small">{x.connectionName}</div>
                  </td>
                  <td className="small">
                    <span className={`badge ${x.status === "succeeded" ? "badge-completed" : x.status === "failed" ? "badge-declined" : "badge-sent"}`}>{p(`sto.st.${x.status}`)}</span>
                    <div className="muted break">{x.status === "succeeded" ? x.remoteRef : x.error}</div>
                  </td>
                  <td>
                    {canEdit && (x.status === "failed" || (x.status === "pending" && Date.now() - new Date(x.updatedAt).getTime() > 15 * 60_000)) && (
                      <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/storage/exports/${x.id}/retry`, { method: "POST" }))}>
                        {p("common.retry")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

// ───────────────────────────── Dominio propio ─────────────────────────────

export function CustomDomainPage() {
  const p = usePlatformText();
  const { locale } = useI18n();
  const [dom, setDom] = useState<CustomDomain | null | undefined>(undefined);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  // Sin el plan se puede ver, verificar y quitar el dominio actual, pero no configurar otro (PUT responde 402).
  const inPlan = useAccess().hasFeature("custom_domain");
  const load = () => api<{ domain: CustomDomain | null }>("/v1/domains").then((r) => setDom(r.domain));
  const { error, setError, act } = useAct(load);

  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Record = ({ type, host, value }: { type: string; host: string; value: string }) => (
    <div style={{ overflowX: "auto" }}>
      <table className="table">
        <thead>
          <tr>
            <th>{p("dom.type")}</th>
            <th>{p("dom.host")}</th>
            <th>{p("dom.value")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>{type}</code>
            </td>
            <td>
              <code className="break">{host}</code>
            </td>
            <td>
              <code className="break">{value}</code>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <Page title={p("dom.title")} intro={p("dom.intro")}>
      <PlanNotice feature="custom_domain" />
      <ErrorBox error={error} />
      {dom === undefined ? (
        <Spinner />
      ) : (
        <>
          <form
            className="card pad row-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (saving) return;
              // Reemplaza el dominio actual (quizás ya verificado): se confirma antes.
              if (dom && input.trim().toLowerCase() !== dom.domain && !confirmAction()) return;
              setSaving(true);
              void act(() => api("/v1/domains", { method: "PUT", body: { domain: input } }).then(() => setInput(""))).finally(() => setSaving(false));
            }}
          >
            <label className="field grow">
              <span>{p("dom.domain")}</span>
              <input required value={input} onChange={(e) => setInput(e.target.value)} placeholder={dom?.domain ?? "firmas.tuempresa.com"} />
            </label>
            <div style={{ alignSelf: "flex-end" }}>
              <button className="btn btn-primary" disabled={saving || !inPlan}>{p("dom.set")}</button>
            </div>
          </form>

          {dom && (
            <div className="card pad stack">
              <div className="row-between">
                <strong className="break">{dom.domain}</strong>
                <span className={`badge ${dom.status === "verified" ? "badge-completed" : "badge-expired"}`}>{p(`dom.status.${dom.status}`)}</span>
              </div>
              {dom.status === "verified" ? (
                <p className="small">{p("dom.verifiedAt", { when: formatDateTime(dom.verifiedAt, locale), domain: dom.domain })}</p>
              ) : (
                <>
                  <p className="small">{p("dom.step1")}</p>
                  <Record type="TXT" host={dom.txtName} value={dom.txtValue} />
                  <p className="small">{p("dom.step2")}</p>
                  <Record type="CNAME" host={dom.domain} value={dom.cnameTarget} />
                  <p className="small">{p("dom.step3")}</p>
                </>
              )}
              {dom.lastCheckedAt && <span className="muted small">{p("dom.lastCheck", { when: formatDateTime(dom.lastCheckedAt, locale) })}</span>}
              {dom.lastError && dom.status !== "verified" && <span className="small" style={{ color: "#b91c1c" }}>{dom.lastError}</span>}
              <div className="row-wrap">
                {dom.status !== "verified" && (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => act(() => api("/v1/domains/verify", { method: "POST" }))}>
                    {p("dom.verify")}
                  </button>
                )}
                <span className="grow" />
                <button type="button" className="btn btn-sm btn-danger" onClick={() => confirmAction() && act(() => api("/v1/domains", { method: "DELETE" }))}>
                  {p("dom.remove")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
