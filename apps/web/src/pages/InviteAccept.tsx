// Aceptar una invitación (pública): cuenta nueva, cuenta existente con contraseña, o sesión ya iniciada.
import { redirectIfSsoRequired } from "../components/SsoLogin";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { InvitationPreview, MeResponse, TwoFactorChallenge } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { usePasswordText } from "../lib/i18n-password";
import { useAuth } from "../lib/auth";
import { broadcastSessionChange } from "../lib/session-sync";
import { useRoleLabel, useTeamsText } from "../lib/i18n-teams";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";
import { TwoFactorStep } from "../components/TwoFactorStep";
import { productName, useBrandTheme } from "../lib/white-label";

export function InviteAcceptPage() {
  const { token } = useParams();
  const tt = useTeamsText();
  const roleLabel = useRoleLabel();
  const { me, setMe } = useAuth();
  const brand = useBrandTheme();
  const nav = useNavigate();
  const [inv, setInv] = useState<InvitationPreview | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<InvitationPreview>(`/v1/invite/${encodeURIComponent(token ?? "")}`)
      .then(setInv)
      .catch((e) => setError(errorText(e)));
  }, [token]);

  // Con la sesión de la persona invitada no se pide contraseña; pero si el servidor no la acepta (p. ej. una sesión SSO
  // de otra organización), se pide la contraseña en vez de quedar sin salida.
  const [needPassword, setNeedPassword] = useState(false);
  const pw = usePasswordText();
  const loggedAsInvitee = Boolean(me && inv && me.user.email.toLowerCase() === inv.email.toLowerCase()) && !needPassword;

  const done = (m: MeResponse) => {
    setMe(m);
    // La sesión pasó a la organización de la invitación (o a otra cuenta): las demás pestañas se recargan.
    broadcastSessionChange({ kind: "accept", tenantId: m.tenant.id, userId: m.user.id });
    nav("/app", { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = loggedAsInvitee ? {} : inv?.existingAccount ? { password } : { name, password };
      const r = await api<MeResponse | TwoFactorChallenge>(`/v1/invite/${encodeURIComponent(token ?? "")}/accept`, { method: "POST", body });
      if ("twoFactorRequired" in r) setChallenge(r.challengeToken);
      else done(r);
    } catch (err) {
      // Organización con SSO obligatorio: ya quedó como miembro; se ingresa por el IdP.
      if (redirectIfSsoRequired(err)) return;
      const unauth = err instanceof HttpError && err.status === 401 && err.code === "unauthorized";
      if (unauth && loggedAsInvitee) setNeedPassword(true);
      else setError(unauth ? pw("badCredentials") : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const body = () => {
    if (!inv) return error ? <ErrorBox error={error} /> : <Spinner />;
    if (inv.status !== "pending") return <div className="alert alert-warn">{tt("inv.invalid", { status: tt(`team.status.${inv.status}` as const) })}</div>;
    if (challenge) return <TwoFactorStep challengeToken={challenge} onDone={done} onBack={() => setChallenge(null)} />;
    const vars = { org: inv.organizationName, role: roleLabel(inv.role, inv.roleName), inviter: inv.invitedByName ?? "", email: inv.email };
    return (
      <form className="stack" onSubmit={submit}>
        <p>{inv.invitedByName ? tt("inv.body", vars) : tt("inv.bodyNoInviter", vars)}</p>
        {loggedAsInvitee ? (
          <p className="muted">{tt("inv.loggedAs")}</p>
        ) : inv.existingAccount ? (
          <>
            <p className="muted">{tt("inv.existing", vars)}</p>
            <label className="field">
              <span>{tt("inv.password")}</span>
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <p className="muted">{tt("inv.new", vars)}</p>
            <label className="field">
              <span>{tt("inv.name")}</span>
              <input autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>{tt("inv.passwordNew")}</span>
              <input type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </>
        )}
        <ErrorBox error={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>
          {tt("inv.accept")}
        </button>
      </form>
    );
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-head">
          <Logo />
          <LocaleSwitcher compact />
        </div>
        <h1>{inv ? tt("inv.title", { org: inv.organizationName }) : productName(brand)}</h1>
        {body()}
      </div>
    </div>
  );
}
