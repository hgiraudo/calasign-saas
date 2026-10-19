// Ajustes del bloque Identidad: verificación de identidad (KYC), inicio de sesión único (SSO) y SCIM.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { IdentitySettings, IdvLevel, IdvProvider, ScimSettings, SsoSettings, SsoSettingsInput } from "@calasign/shared";
import { IDV_LEVELS, MOCK_DECISIONS } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n, confirmAction } from "../lib/i18n";
import { useIdnText, type IdnKey } from "../lib/i18n-identity";
import { ErrorBox, OrderInput, Spinner } from "../components/ui";
import { SsoDomainVerification } from "../components/DataExtras";

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<T>(path)
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, [path]);
  return { data, setData, error, setError };
}

function Page({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="page idn-page">
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{intro}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  return (
    <div className="idn-copy">
      <span className="muted small">{label}</span>
      <code className="secret">{value}</code>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(value)} aria-label={`${t("common.copy")} ${label}`}>
        ⧉
      </button>
    </div>
  );
}

// ───────────────────────────── Verificación de identidad ─────────────────────────────

export function IdentitySettingsPage() {
  const tx = useIdnText();
  const { data, setData, error, setError } = useLoad<IdentitySettings>("/v1/settings/identity");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;
  const mockAvailable = data.providers.find((p) => p.id === "mock")?.configured;
  // El proveedor guardado puede no estar configurado (por defecto es "mock", que en producción no se ofrece): el select
  // mostraba el primero configurado pero se mandaba el guardado, y la API rechazaba todo guardado
  // (identity_provider_unavailable). Con un solo proveedor configurado no había forma de elegirlo.
  const configured = data.providers.filter((p) => p.configured);
  const defaultProvider = configured.some((p) => p.id === data.defaultProvider) ? data.defaultProvider : configured[0]?.id;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setData(
        await api<IdentitySettings>("/v1/settings/identity", {
          method: "PATCH",
          body: {
            ...(defaultProvider ? { defaultProvider } : {}),
            defaultLevel: data.defaultLevel,
            nameMatchThreshold: data.nameMatchThreshold,
            maxAttempts: data.maxAttempts,
            ...(mockAvailable ? { mock: { decision: data.mock.decision, extractedName: data.mock.extractedName || null } } : {}),
          },
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={tx("settings.identity")} intro={tx("idset.intro")}>
      <form className="stack" onSubmit={save}>
        <div className="card pad stack">
          <h2>{tx("idset.providers")}</h2>
          <ul className="idn-providers">
            {data.providers.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong>
                <span className={`badge ${p.configured ? "badge-completed" : ""}`}>{p.configured ? tx("idset.configured") : tx("idset.notConfigured")}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">{tx("idset.envHint")}</p>
          <div className="idn-grid">
            <label className="field">
              <span>{tx("idset.defaultProvider")}</span>
              <select value={defaultProvider ?? ""} onChange={(e) => setData({ ...data, defaultProvider: e.target.value as IdvProvider })}>
                {configured.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{tx("idset.defaultLevel")}</span>
              <select value={data.defaultLevel} onChange={(e) => setData({ ...data, defaultLevel: e.target.value as IdvLevel })}>
                {IDV_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {tx(`idv.level.${l}` as IdnKey)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>
                {tx("idset.threshold")}: {Math.round(data.nameMatchThreshold * 100)} %
              </span>
              <input
                type="range"
                min={50}
                max={100}
                step={5}
                value={Math.round(data.nameMatchThreshold * 100)}
                onChange={(e) => setData({ ...data, nameMatchThreshold: Number(e.target.value) / 100 })}
              />
              <small className="muted">{tx("idset.thresholdHint")}</small>
            </label>
            <label className="field">
              <span>{tx("idset.maxAttempts")}</span>
              {/* Con `Number(valor) || 1`, borrar dejaba un 1 fijo y tipear "5" daba 15 (fuera de 1–10: el guardado fallaba). */}
              <OrderInput min={1} max={10} value={data.maxAttempts} onChange={(n) => setData({ ...data, maxAttempts: n })} />
            </label>
          </div>
        </div>
        {mockAvailable && (
          <div className="card pad stack">
            <h2>{tx("idset.mockTitle")}</h2>
            <p className="muted small">{tx("idset.mockIntro")}</p>
            <div className="idn-grid">
              <label className="field">
                <span>{tx("idset.mockDecision")}</span>
                <select value={data.mock.decision} onChange={(e) => setData({ ...data, mock: { ...data.mock, decision: e.target.value as (typeof MOCK_DECISIONS)[number] } })}>
                  {MOCK_DECISIONS.map((d) => (
                    <option key={d} value={d}>
                      {tx(`idset.mockDecision.${d}` as IdnKey)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{tx("idset.mockName")}</span>
                <input value={data.mock.extractedName ?? ""} onChange={(e) => setData({ ...data, mock: { ...data.mock, extractedName: e.target.value } })} />
                <small className="muted">{tx("idset.mockNameHint")}</small>
              </label>
            </div>
          </div>
        )}
        <ErrorBox error={error} />
        {saved && <p className="alert alert-success">{tx("sso.saved")}</p>}
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy}>
            {tx("common.save")}
          </button>
        </div>
      </form>
    </Page>
  );
}

// ───────────────────────────── SSO ─────────────────────────────

export function SsoSettingsPage() {
  const tx = useIdnText();
  const { data, setData, error, setError } = useLoad<SsoSettings>("/v1/settings/sso");
  const [secret, setSecret] = useState("");
  const [cert, setCert] = useState("");
  const [domains, setDomains] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;

  const oidc = data.oidc ?? { issuer: "", clientId: "", scopes: "openid email profile", hasClientSecret: false };
  const saml = data.saml ?? { entryPoint: "", idpIssuer: "", idpCertFingerprint: null, emailAttribute: null };
  const domainText = domains ?? data.domains.join(", ");

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const body: SsoSettingsInput = {
      enabled: data.enabled,
      protocol: data.protocol,
      domains: domainText
        .split(/[\s,;]+/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
      jitEnabled: data.jitEnabled,
      jitRole: data.jitRole,
      // La API rechaza "exigir" sin SSO habilitado (sso_disabled): sin esto, apagar el SSO fallaba siempre.
      enforce: data.enabled && data.enforce,
      oidc: data.protocol === "oidc" && oidc.issuer ? { issuer: oidc.issuer, clientId: oidc.clientId, scopes: oidc.scopes, ...(secret ? { clientSecret: secret } : {}) } : null,
      // Sin certificado nuevo, el servidor conserva el actual.
      saml:
        data.protocol === "saml" && saml.entryPoint
          ? { entryPoint: saml.entryPoint, idpIssuer: saml.idpIssuer, ...(cert.trim() ? { idpCert: cert } : {}), emailAttribute: saml.emailAttribute || null }
          : null,
    };
    try {
      setData(await api<SsoSettings>("/v1/settings/sso", { method: "PUT", body }));
      setSecret("");
      setCert("");
      setDomains(null);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const sp = data.serviceProvider;
  return (
    <Page title={tx("settings.sso")} intro={tx("sso.intro")}>
      <form className="stack" onSubmit={save}>
        <div className="card pad stack">
          <label className="check">
            <input
              type="checkbox"
              checked={data.enabled}
              // Con el SSO apagado no se puede exigir: la casilla "exigir" queda deshabilitada y desmarcada.
              onChange={(e) => setData({ ...data, enabled: e.target.checked, enforce: e.target.checked ? data.enforce : false })}
            />
            <span>{tx("sso.enabled")}</span>
          </label>
          <div className="idn-grid">
            <label className="field">
              <span>{tx("sso.protocol")}</span>
              <select value={data.protocol} onChange={(e) => setData({ ...data, protocol: e.target.value as "oidc" | "saml" })}>
                <option value="oidc">OpenID Connect (OIDC)</option>
                <option value="saml">SAML 2.0</option>
              </select>
            </label>
            <label className="field">
              <span>{tx("sso.domains")}</span>
              <input value={domainText} onChange={(e) => setDomains(e.target.value)} placeholder="empresa.com, empresa.com.br" />
              <small className="muted">{tx("sso.domainsHint")}</small>
            </label>
          </div>
          {data.protocol === "oidc" ? (
            <div className="idn-grid">
              <label className="field">
                <span>{tx("sso.issuer")}</span>
                <input value={oidc.issuer} onChange={(e) => setData({ ...data, oidc: { ...oidc, issuer: e.target.value } })} placeholder="https://login.microsoftonline.com/<tenant>/v2.0" />
              </label>
              <label className="field">
                <span>{tx("sso.clientId")}</span>
                <input value={oidc.clientId} onChange={(e) => setData({ ...data, oidc: { ...oidc, clientId: e.target.value } })} />
              </label>
              <label className="field">
                <span>{tx("sso.clientSecret")}</span>
                <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={oidc.hasClientSecret ? tx("sso.clientSecretKeep") : ""} />
              </label>
              <label className="field">
                <span>{tx("sso.scopes")}</span>
                <input value={oidc.scopes} onChange={(e) => setData({ ...data, oidc: { ...oidc, scopes: e.target.value } })} />
              </label>
            </div>
          ) : (
            <div className="idn-grid">
              <label className="field">
                <span>{tx("sso.entryPoint")}</span>
                <input value={saml.entryPoint} onChange={(e) => setData({ ...data, saml: { ...saml, entryPoint: e.target.value } })} />
              </label>
              <label className="field">
                <span>{tx("sso.idpIssuer")}</span>
                <input value={saml.idpIssuer} onChange={(e) => setData({ ...data, saml: { ...saml, idpIssuer: e.target.value } })} />
              </label>
              <label className="field idn-wide">
                <span>{tx("sso.idpCert")}</span>
                <textarea rows={4} value={cert} onChange={(e) => setCert(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />
                {saml.idpCertFingerprint && <small className="muted">{tx("sso.idpCertCurrent", { fp: saml.idpCertFingerprint })}</small>}
              </label>
              <label className="field">
                <span>{tx("sso.emailAttribute")}</span>
                <input value={saml.emailAttribute ?? ""} onChange={(e) => setData({ ...data, saml: { ...saml, emailAttribute: e.target.value } })} />
              </label>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={data.jitEnabled} onChange={(e) => setData({ ...data, jitEnabled: e.target.checked })} />
            <span>{tx("sso.jit")}</span>
          </label>
          {data.jitEnabled && (
            <label className="field idn-narrow">
              <span>{tx("sso.jitRole")}</span>
              <select value={data.jitRole} onChange={(e) => setData({ ...data, jitRole: e.target.value as "admin" | "member" })}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={data.enforce} onChange={(e) => setData({ ...data, enforce: e.target.checked })} disabled={!data.enabled} />
            <span>{tx("sso.enforce")}</span>
          </label>
        </div>
        <ErrorBox error={error} />
        {saved && <p className="alert alert-success">{tx("sso.saved")}</p>}
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy}>
            {tx("common.save")}
          </button>
        </div>
      </form>
      <div className="card pad stack">
        <h2>{tx("sso.spTitle")}</h2>
        {data.protocol === "oidc" ? (
          <CopyRow label={tx("sso.redirectUri")} value={sp.oidcRedirectUri} />
        ) : (
          <>
            <CopyRow label={tx("sso.entityId")} value={sp.samlEntityId} />
            <CopyRow label={tx("sso.acs")} value={sp.samlAcsUrl} />
            <CopyRow label={tx("sso.metadata")} value={sp.samlMetadataUrl} />
          </>
        )}
        <CopyRow label={tx("sso.loginUrl")} value={sp.loginUrl} />
      </div>
      <SsoDomainVerification refreshKey={data.domains.join(",")} />
    </Page>
  );
}

// ───────────────────────────── SCIM ─────────────────────────────

export function ScimSettingsPage() {
  const tx = useIdnText();
  const { locale } = useI18n();
  const { data, setData, error, setError } = useLoad<ScimSettings>("/v1/settings/scim");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;

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
  const reload = async () => setData(await api<ScimSettings>("/v1/settings/scim"));

  return (
    <Page title={tx("settings.scim")} intro={tx("scim.intro")}>
      <div className="card pad stack">
        <CopyRow label={tx("scim.baseUrl")} value={data.baseUrl} />
        <label className="field idn-narrow">
          <span>{tx("scim.defaultRole")}</span>
          <select
            value={data.defaultRole}
            disabled={busy}
            onChange={(e) => run(async () => setData(await api<ScimSettings>("/v1/settings/scim", { method: "PATCH", body: { defaultRole: e.target.value } })))}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      <div className="card pad stack">
        <h2>{tx("scim.tokens")}</h2>
        {secret && (
          <div className="alert alert-warn stack">
            <strong>{tx("scim.secretOnce")}</strong>
            <code className="secret">{secret}</code>
          </div>
        )}
        <form
          className="row-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api<{ secret: string }>("/v1/settings/scim/tokens", { method: "POST", body: { name } });
              setSecret(r.secret);
              setName("");
              await reload();
            });
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("scim.tokenName")} aria-label={tx("scim.tokenName")} required />
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            {tx("scim.create")}
          </button>
        </form>
        <ErrorBox error={error} />
        {data.tokens.length === 0 ? (
          <p className="muted">{tx("scim.none")}</p>
        ) : (
          <ul className="idn-tokens">
            {data.tokens.map((t) => (
              <li key={t.id}>
                <div>
                  <strong>{t.name}</strong> <code>{t.prefix}…</code>
                  <div className="muted small">
                    {tx("scim.lastUsed")}: {t.lastUsedAt ? formatDateTime(t.lastUsedAt, locale) : tx("scim.never")}
                  </div>
                </div>
                {t.revokedAt ? (
                  <span className="badge">{tx("scim.revoked")}</span>
                ) : (
                  <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => confirmAction() && run(async () => {
                    await api(`/v1/settings/scim/tokens/${t.id}`, { method: "DELETE" });
                    await reload();
                  })}>
                    {tx("scim.revoke")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}
