// Seguridad: 2FA del usuario y políticas de la organización (exigir 2FA, retención).
import { useEffect, useState, type FormEvent } from "react";
import type { AccountSession, SecuritySettings, TotpEnableResponse, TotpSetupResponse } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAccess } from "../lib/access";
import { useTeamsText } from "../lib/i18n-teams";
import { ErrorBox, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

function RecoveryCodes({ codes }: { codes: string[] }) {
  const tt = useTeamsText();
  return (
    <div className="alert alert-warn stack">
      <strong>{tt("sec.recovery")}</strong>
      <span>{tt("sec.recoveryHelp")}</span>
      <code className="secret" style={{ whiteSpace: "pre-wrap", borderColor: "#fde68a" }}>
        {codes.join("\n")}
      </code>
    </div>
  );
}

function MyTwoFactor() {
  const tt = useTeamsText();
  const { access, refresh } = useAccess();
  const enabled = access?.twoFactor.enabled ?? false;
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Re-autenticación: activar la 2FA o regenerar códigos pide la contraseña (o un ingreso reciente). Se pide solo si
  // la API responde reauth_required (con un ingreso de hace menos de 10 minutos no hace falta).
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState("");
  const withPassword = <T extends object>(body: T) => (password ? { ...body, password } : body);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof HttpError && e.code === "reauth_required" && (e.details as { password?: boolean } | undefined)?.password !== false) {
        setAskPassword(true);
        if (!password) return;
      }
      if (e instanceof HttpError && e.code === "invalid_password") setPassword("");
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(async () => setSetup(await api<TotpSetupResponse>("/v1/me/2fa/setup", { method: "POST", body: withPassword({}) })));
  const enable = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await api<TotpEnableResponse>("/v1/me/2fa/enable", { method: "POST", body: withPassword({ code }) });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      setPassword("");
      setAskPassword(false);
      await refresh();
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await api("/v1/me/2fa/disable", { method: "POST", body: { code } });
      setCode("");
      setCodes(null);
      await refresh();
    });
  };
  const regenerate = () =>
    run(async () => {
      const r = await api<TotpEnableResponse>("/v1/me/2fa/recovery-codes", { method: "POST", body: withPassword({ code }) });
      setCodes(r.recoveryCodes);
      setCode("");
      setPassword("");
      setAskPassword(false);
    });

  return (
    <section className="card pad stack">
      <h2>{tt("sec.my2fa")}</h2>
      <p className="muted">{enabled ? tt("sec.2faOn") : tt("sec.2faOff")}</p>
      {codes && <RecoveryCodes codes={codes} />}
      {askPassword && (
        <div className="stack">
          <label className="field">
            <span>{tt("sec.passwordConfirm")}</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ maxWidth: 320 }}
            />
          </label>
          <span className="muted small">{tt("sec.passwordConfirmHelp")}</span>
        </div>
      )}
      {!enabled && !setup && (
        <div>
          <button type="button" className="btn btn-primary" disabled={busy || (askPassword && !password)} onClick={start}>
            {askPassword ? tt("sec.continue") : tt("sec.setup")}
          </button>
        </div>
      )}
      {!enabled && setup && (
        <form className="stack" onSubmit={enable}>
          <p>{tt("sec.scan")}</p>
          <div style={{ width: 200, height: 200, background: "#fff", padding: 8, border: "1px solid var(--border)", borderRadius: 8 }}>
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} alt="QR" width={184} height={184} />
          </div>
          <code className="small" style={{ wordBreak: "break-all" }}>
            {setup.secret}
          </code>
          <p>{tt("sec.enterCode")}</p>
          <div className="row-wrap">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              aria-label={tt("sec.code")}
              style={{ width: 140, letterSpacing: "0.3em", fontSize: "1.2rem" }}
            />
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>
              {tt("sec.enable")}
            </button>
          </div>
        </form>
      )}
      {enabled && (
        <form className="stack" onSubmit={disable}>
          <p className="muted small">{tt("sec.disableHelp")}</p>
          <div className="row-wrap">
            <input value={code} onChange={(e) => setCode(e.target.value)} aria-label={tt("sec.code")} style={{ width: 180 }} />
            <button className="btn btn-danger" disabled={busy || code.trim().length < 6}>
              {tt("sec.disable")}
            </button>
            <button type="button" className="btn" disabled={busy || code.trim().length !== 6} onClick={regenerate}>
              {tt("sec.regenerate")}
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

function MySessions() {
  const tt = useTeamsText();
  const { logout } = useAuth();
  const [items, setItems] = useState<AccountSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ items: AccountSession[] }>("/v1/me/sessions")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  const close = async (sess: AccountSession) => {
    if (sess.current) return logout();
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/me/sessions/${encodeURIComponent(sess.id)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const closeAll = () => {
    if (!window.confirm(tt("sec.logoutAllConfirm"))) return;
    void logout({ all: true });
  };
  const fmt = (d: string) => new Date(d).toLocaleString();

  return (
    <section className="card pad stack">
      <h2>{tt("sec.sessions")}</h2>
      <p className="muted small">{tt("sec.sessionsHelp")}</p>
      {!items && !error && <Spinner />}
      {items && (
        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((x) => (
            <li
              key={x.id}
              className="row-wrap"
              style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", paddingBottom: 8 }}
            >
              <span className="stack" style={{ gap: 2 }}>
                <strong>
                  {x.userAgent ?? tt("sec.sessionUnknown")}
                  {x.current && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      {tt("sec.sessionCurrent")}
                    </span>
                  )}
                  {x.method === "sso" && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      {tt("sec.sessionSso")}
                    </span>
                  )}
                  {x.rememberMe && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      {tt("sec.sessionRemembered")}
                    </span>
                  )}
                </strong>
                <span className="muted small">
                  {x.ip ?? ""} · {tt("sec.sessionCreated", { date: fmt(x.createdAt) })} · {tt("sec.sessionLastSeen", { date: fmt(x.lastSeenAt) })}
                </span>
              </span>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void close(x)}>
                {tt("sec.sessionClose")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={closeAll}>
          {tt("sec.logoutAll")}
        </button>
      </div>
      <ErrorBox error={error} />
    </section>
  );
}

function OrgPolicies() {
  const tt = useTeamsText();
  const { refresh } = useAccess();
  const [s, setS] = useState<SecuritySettings | null>(null);
  const [days, setDays] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SecuritySettings>("/v1/settings/security")
      .then((r) => {
        setS(r);
        setDays(r.retentionDays ? String(r.retentionDays) : "");
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  const save = async (patch: Partial<SecuritySettings>) => {
    setError(null);
    setMsg(null);
    try {
      const r = await api<SecuritySettings>("/v1/settings/security", { method: "PATCH", body: patch });
      setS(r);
      setMsg(tt("sec.saved"));
      await refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!s) return error ? <ErrorBox error={error} /> : <Spinner />;
  return (
    <section className="card pad stack">
      <h2>{tt("sec.org")}</h2>
      <label className="row-wrap" style={{ alignItems: "flex-start" }}>
        <input type="checkbox" checked={s.require2fa} onChange={(e) => save({ require2fa: e.target.checked })} style={{ marginTop: 4 }} />
        <span>
          <strong>{tt("sec.require2fa")}</strong>
          <div className="muted small">{tt("sec.require2faHelp")}</div>
        </span>
      </label>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          const n = days.trim() ? Number(days) : null;
          // Acortar (o activar) la retención borra archivos para siempre en la próxima pasada: se confirma.
          if (n !== null && (s.retentionDays == null || n < s.retentionDays) && !window.confirm(tt("sec.retentionConfirm", { n: String(n) }))) return;
          void save({ retentionDays: n });
        }}
      >
        <label htmlFor="sec-retention-days">
          <strong>{tt("sec.retention")}</strong>
        </label>
        <span id="sec-retention-help" className="muted small">
          {tt("sec.retentionHelp")}
        </span>
        <div className="row-wrap">
          <input
            id="sec-retention-days"
            aria-describedby="sec-retention-help sec-retention-unit"
            type="number"
            min={1}
            max={36500}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            style={{ width: 120 }}
          />
          <span id="sec-retention-unit" className="muted">
            {tt("sec.days")}
          </span>
          <button className="btn btn-primary">{tt("sec.save")}</button>
        </div>
      </form>
      {msg && (
        <div className="alert alert-success" role="status">
          {msg}
        </div>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

export function SecurityPage() {
  const tt = useTeamsText();
  useTitle(tt("sec.title"));
  const { access, can } = useAccess();
  return (
    <div className="page narrow stack">
      <div className="page-head">
        <h1>{tt("sec.title")}</h1>
      </div>
      {access?.twoFactor.setupRequired && <div className="alert alert-warn">{tt("sec.setupRequired")}</div>}
      <MyTwoFactor />
      <MySessions />
      {can("settings:manage") && !access?.twoFactor.setupRequired && <OrgPolicies />}
    </div>
  );
}
