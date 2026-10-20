// Recuperación de contraseña: pedir el link (/forgot) y elegir la contraseña nueva (/reset/:token).
import { useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { api, errorText, HttpError } from "../lib/api";
import { useI18n } from "../lib/i18n";
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
  revokedCredentials?: { apiKeys: number; scimTokens: number; serviceApps: number; invitations: number };
  twoFactorCleared?: boolean;
}

/** Avisos después de restablecer: credenciales revocadas y 2FA borrada (si pasó). */
function resetNotice(r: ResetResult | undefined, pw: ReturnType<typeof usePasswordText>): string[] {
  const out: string[] = [];
  const c = r?.revokedCredentials;
  if (c) {
    const items = (
      [
        ["revokedApiKeys", c.apiKeys],
        ["revokedScimTokens", c.scimTokens],
        ["revokedServiceApps", c.serviceApps],
        ["revokedInvitations", c.invitations],
      ] as const
    )
      .filter(([, n]) => n > 0)
      .map(([k, n]) => pw(k).replace("{n}", String(n)));
    if (items.length) out.push(pw("revokedNotice").replace("{items}", items.join(", ")));
  }
  if (r?.twoFactorCleared) out.push(pw("twoFactorCleared"));
  return out;
}

export function ResetPasswordPage() {
  const { t } = useI18n();
  const pw = usePasswordText();
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<string[]>([]);
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
      const r = await api<ResetResult | undefined>("/v1/auth/password/reset", { method: "POST", body: { token, password } });
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
          {done && notice.map((n) => <p key={n} className="hint" role="note">{n}</p>)}
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
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t("common.loading") : pw("save")}
        </button>
      </form>
    </AuthShell>
  );
}
