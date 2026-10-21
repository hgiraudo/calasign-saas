import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import type { MeResponse, TwoFactorChallenge } from "@calasign/shared";
import { TwoFactorStep } from "../components/TwoFactorStep";
import { api, errorText, HttpError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { broadcastSessionChange } from "../lib/session-sync";
import { useI18n } from "../lib/i18n";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";
import { SsoErrorNotice, SsoLoginBox, redirectIfSsoRequired } from "../components/SsoLogin";
import { CellPicker } from "../components/DataExtras";
import { usePasswordText } from "../lib/i18n-password";
import { useTitle } from "../lib/white-label";

export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  useTitle(title);
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-head">
          <Logo />
          <LocaleSwitcher compact />
        </div>
        <p className="muted auth-tagline">{t("auth.tagline")}</p>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** Entrar o crear cuenta mueve la cookie: las pestañas de la consola con otra cuenta u organización se recargan. */
function announceLogin(m: MeResponse) {
  broadcastSessionChange({ kind: "login", tenantId: m.tenant.id, userId: m.user.id });
}

export function LoginPage() {
  const { t } = useI18n();
  const pw = usePasswordText();
  const { me, loading, setMe, expired } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? "/app";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  // Cuenta sumada por SSO/SCIM sin otra organización con contraseña: hay que restablecerla (403 password_reset_required).
  const [resetRequired, setResetRequired] = useState(false);

  if (loading) return <Spinner />;
  if (me) return <Navigate to={from} replace />;
  if (challenge) {
    return (
      <AuthShell title={t("auth.login")}>
        <TwoFactorStep
          challengeToken={challenge}
          from={from}
          onBack={() => setChallenge(null)}
          onDone={(m) => {
            setMe(m);
            announceLogin(m);
            nav(from, { replace: true });
          }}
        />
      </AuthShell>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResetRequired(false);
    try {
      const m = await api<MeResponse | TwoFactorChallenge>("/v1/auth/login", { method: "POST", body: { email, password } });
      if ("twoFactorRequired" in m) {
        setChallenge(m.challengeToken);
        return;
      }
      setMe(m);
      announceLogin(m);
      nav(from, { replace: true });
    } catch (err) {
      if (redirectIfSsoRequired(err, from)) return;
      if (err instanceof HttpError && err.code === "password_reset_required") setResetRequired(true);
      // Contraseña incorrecta: "Autenticación requerida" (en español en todos los idiomas) no decía qué pasó.
      else if (err instanceof HttpError && err.status === 401 && err.code === "unauthorized") setError(pw("badCredentials"));
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t("auth.login")}>
      <SsoErrorNotice />
      {expired && (
        <div className="alert alert-warn" role="status">
          {pw("sessionExpired")}
        </div>
      )}
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{t("auth.email")}</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("auth.password")}</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <ErrorBox error={error} />
        {resetRequired && (
          <div className="alert alert-warn" role="alert">
            {pw("resetRequired")}{" "}
            <Link to="/forgot" state={{ email }}>
              {pw("resetRequiredAction")}
            </Link>
          </div>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t("common.loading") : t("auth.login")}
        </button>
        <p className="muted center">
          <Link to="/forgot">{pw("forgotLink")}</Link>
        </p>
        <p className="muted center">
          {t("auth.noAccount")} <Link to="/signup">{t("auth.signup")}</Link>
        </p>
      </form>
      <SsoLoginBox email={email} redirect={from} />
    </AuthShell>
  );
}

export function SignupPage() {
  const { t, locale } = useI18n();
  const { me, loading, setMe } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ organization: "", name: "", email: "", password: "" });
  const [cell, setCell] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) return <Spinner />;
  if (me) return <Navigate to="/app" replace />;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const m = await api<MeResponse>("/v1/auth/signup", { method: "POST", body: { ...form, locale, ...(cell ? { cell } : {}) } });
      setMe(m);
      announceLogin(m);
      nav("/app", { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t("auth.signup")}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{t("auth.organization")}</span>
          <input required autoComplete="organization" value={form.organization} onChange={set("organization")} />
        </label>
        <label className="field">
          <span>{t("auth.name")}</span>
          <input required autoComplete="name" value={form.name} onChange={set("name")} />
        </label>
        <label className="field">
          <span>{t("auth.email")}</span>
          <input type="email" required autoComplete="email" value={form.email} onChange={set("email")} />
        </label>
        <label className="field">
          <span>{t("auth.password")}</span>
          <input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
          />
          <small className="muted">{t("auth.passwordHint")}</small>
        </label>
        <CellPicker value={cell} onChange={setCell} />
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? t("common.loading") : t("auth.signup")}
        </button>
        <p className="muted center">
          {t("auth.haveAccount")} <Link to="/login">{t("auth.login")}</Link>
        </p>
      </form>
    </AuthShell>
  );
}
