// Recuperación de contraseña: pedir el link (/forgot) y elegir la contraseña nueva (/reset/:token).
import { useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, errorText, HttpError } from "../lib/api";
import { currentLocale, formatNumber, formatText, interpolate, useI18n } from "../lib/i18n";
import { usePasswordText } from "../lib/i18n-password";
import { ErrorBox } from "../components/ui";
import { AuthShell } from "./Auth";

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const pw = usePasswordText();
  // Desde el login (p. ej. "restablecé tu contraseña") llega el correo ya escrito.
  const initialEmail = (useLocation().state as { email?: string } | null)?.email ?? "";
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/v1/auth/password/forgot", { method: "POST", body: { email } });
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={pw("forgotTitle")}>
      {sent ? (
        <div className="stack">
          <p role="status">{pw("sent")}</p>
          <p className="muted center">
            <Link to="/login">{pw("backToLogin")}</Link>
          </p>
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <p className="muted">{pw("forgotIntro")}</p>
          <label className="field">
            <span>{t("auth.email")}</span>
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <ErrorBox error={error} />
          <button className="btn btn-primary btn-block" disabled={busy}>
            {busy ? t("common.loading") : pw("send")}
          </button>
          <p className="muted center">
            <Link to="/login">{pw("backToLogin")}</Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}

interface ResetResult {
  createdCredentials?: { tenantId: string; tenantName: string | null; apiKeys: number; scimTokens: number; serviceApps: number; invitations: number }[];
  revokedCredentials?: { apiKeys: number; invitations: number } | null;
}

type PwText = ReturnType<typeof usePasswordText>;
const countList = (pw: PwText, items: readonly (readonly [Parameters<PwText>[0], number])[]) =>
  items.filter(([, n]) => n > 0).map(([k, n]) => formatText(currentLocale(), pw(k), { n }, (v) => (typeof v === "number" ? formatNumber(v) : v)));

/** Avisos después de restablecer: lo revocado (si se pidió) y las credenciales creadas que siguen activas, por organización. */
function resetNotice(r: ResetResult | undefined, pw: PwText): { revoked: string | null; active: string[] } {
  const rv = r?.revokedCredentials;
  const revokedItems = rv ? countList(pw, [["revokedApiKeys", rv.apiKeys], ["revokedInvitations", rv.invitations]]) : [];
  const active = (r?.createdCredentials ?? [])
    .map((c) => {
      const items = countList(pw, [
        ["activeApiKeys", c.apiKeys],
        ["activeScimTokens", c.scimTokens],
        ["activeServiceApps", c.serviceApps],
        ["activeInvitations", c.invitations],
      ]);
      return items.length ? `${c.tenantName ?? c.tenantId}: ${items.join(", ")}` : null;
    })
    .filter((x): x is string => Boolean(x));
  return { revoked: revokedItems.length ? interpolate(pw("revokedNotice"), { items: revokedItems.join(", ") }) : null, active };
}

export function ResetPasswordPage() {
  const { t } = useI18n();
  const pw = usePasswordText();
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [revokeCreated, setRevokeCreated] = useState(false);
  const [notice, setNotice] = useState<{ revoked: string | null; active: string[] }>({ revoked: null, active: [] });
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError(pw("mismatch"));
      return;
    }
    setBusy(true);
    try {
      const r = await api<ResetResult | undefined>("/v1/auth/password/reset", { method: "POST", body: { token, password, revokeCreatedCredentials: revokeCreated } });
      setNotice(resetNotice(r, pw));
      setDone(true);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400 && err.code === "invalid_token") setInvalid(true);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (done || invalid) {
    return (
      <AuthShell title={pw("resetTitle")}>
        <div className="stack">
          <p role="status">{done ? pw("done") : pw("invalid")}</p>
          {done && notice.revoked && (
            <p className="hint" role="note">
              {notice.revoked}
            </p>
          )}
          {done && notice.active.length > 0 && (
            <div className="hint" role="note">
              <p>{pw("activeNotice")}</p>
              <ul>
                {notice.active.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted center">
            {done ? <Link to="/login">{pw("backToLogin")}</Link> : <Link to="/forgot">{pw("requestNew")}</Link>}
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={pw("resetTitle")}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{pw("newPassword")}</span>
          <input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
          <small className="muted">{t("auth.passwordHint")}</small>
        </label>
        <label className="field">
          <span>{pw("confirmPassword")}</span>
          <input type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={revokeCreated} onChange={(e) => setRevokeCreated(e.target.checked)} />
          <span>
            {pw("revokeCreated")}
            <br />
            <small className="muted">{pw("revokeCreatedHint")}</small>
          </span>
        </label>
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t("common.loading") : pw("save")}
        </button>
      </form>
    </AuthShell>
  );
}
