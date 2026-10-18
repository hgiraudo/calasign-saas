// /oauth/authorize — pantalla de consentimiento de OAuth 2.0 (authorization code + PKCE).
// La app de terceros redirige acá; si no hay sesión, RequireAuth manda al login y vuelve con la misma query.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { AuthorizeInfo, AuthorizeResult } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { usePlatformText } from "../lib/i18n-platform";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";

const PARAMS = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"] as const;

export function OAuthConsentPage() {
  const p = usePlatformText();
  const [search] = useSearchParams();
  const query = useMemo(() => {
    const q: Record<string, string> = {};
    for (const k of PARAMS) {
      const v = search.get(k);
      if (v !== null) q[k] = v;
    }
    return q;
  }, [search]);
  const [info, setInfo] = useState<AuthorizeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    api<AuthorizeInfo>(`/v1/oauth/authorize/info?${new URLSearchParams(query)}`)
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [query]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<AuthorizeResult>("/v1/oauth/authorize/decision", { method: "POST", body: { ...query, approve } });
      setLeaving(true);
      window.location.assign(r.redirectTo);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  // Con un esquema propio de app nativa (com.ejemplo.app:/cb) la URL no tiene host: se muestra el esquema, para que
  // la persona vea igual a dónde vuelve (antes decía "Después vas a volver a " sin nada).
  const host = info ? redirectTarget(info.redirectUri) : "";
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <Logo light />
        </span>
        <div style={{ marginLeft: "auto" }}>
          <LocaleSwitcher compact />
        </div>
      </header>
      <main className="content">
        <div className="page narrow" style={{ maxWidth: 520 }}>
          <div className="card pad stack" style={{ marginTop: 24 }}>
            <h1 style={{ margin: 0 }}>{p("consent.title")}</h1>
            {error && !info ? (
              <>
                <p className="muted">{p("consent.invalid")}</p>
                <ErrorBox error={error} />
              </>
            ) : !info ? (
              <Spinner />
            ) : (
              <>
                <p style={{ fontSize: "1.05rem", margin: 0 }}>
                  <strong>{p("consent.wants", { app: info.client.name })}</strong>
                </p>
                <span className="muted small">{p("consent.by", { org: info.client.organizationName })}</span>
                {info.client.description && <p className="small">{info.client.description}</p>}
                <p className="small">{p("consent.as", { user: `${info.user.name} (${info.user.email})`, org: info.organization.name })}</p>
                <div className="stack" style={{ gap: 6 }}>
                  <strong className="small">{p("consent.scopes")}</strong>
                  <ul style={{ margin: 0 }}>
                    {info.scopes.map((s) => (
                      <li key={s.scope}>
                        {p(`scope.${s.scope}`)} <code className="small muted">{s.scope}</code>
                      </li>
                    ))}
                  </ul>
                </div>
                <span className="muted small">{p("consent.redirect", { host })}</span>
                <ErrorBox error={error} />
                {leaving ? (
                  <p className="muted" role="status">
                    {p("consent.redirecting")}
                  </p>
                ) : (
                  <div className="row-end">
                    <button type="button" className="btn" disabled={busy} onClick={() => decide(false)}>
                      {p("consent.deny")}
                    </button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide(true)} autoFocus>
                      {p("consent.allow")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function redirectTarget(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(/:$/, "");
  } catch {
    return uri;
  }
}
