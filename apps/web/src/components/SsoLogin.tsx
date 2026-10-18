// Ingreso con SSO en la pantalla de login: descubrimiento por dominio del correo y errores devueltos por el IdP.
import { useState } from "react";
import { useLocation } from "react-router-dom";
import type { SsoDiscoverResponse } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useIdnText } from "../lib/i18n-identity";
import { ErrorBox } from "./ui";

function withRedirect(startUrl: string, redirect: string) {
  return `${startUrl}${startUrl.includes("?") ? "&" : "?"}redirect=${encodeURIComponent(redirect)}`;
}

/** Si el login con contraseña respondió "sso_required", va directo al IdP. Devuelve true si redirigió. */
export function redirectIfSsoRequired(err: unknown, redirect = "/app"): boolean {
  if (err instanceof HttpError && err.code === "sso_required") {
    const startUrl = (err.details as { startUrl?: string } | undefined)?.startUrl;
    if (startUrl) {
      window.location.assign(withRedirect(startUrl, redirect));
      return true;
    }
  }
  return false;
}

export function SsoErrorNotice() {
  const tx = useIdnText();
  const loc = useLocation();
  const raw = new URLSearchParams(loc.search).get("sso_error");
  // Solo códigos (p. ej. "invalid_state"): un texto libre en la URL permitiría mostrar mensajes falsos en el login.
  const code = raw && /^[a-z0-9_.-]{1,60}$/i.test(raw) ? raw : raw ? "error" : null;
  if (!code) return null;
  // Los códigos que la persona puede resolver (o tiene que pedirle a alguien) tienen un mensaje propio.
  if (code === "sso_plan_limit" || code === "sso_state_invalid") return <ErrorBox error={tx(`login.ssoError.${code}`)} />;
  return <ErrorBox error={tx("login.ssoError", { code })} />;
}

export function SsoLoginBox({ email: initial, redirect }: { email: string; redirect: string }) {
  const tx = useIdnText();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const go = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    setNotFound(false);
    try {
      const r = await api<SsoDiscoverResponse>("/v1/auth/sso/discover", { method: "POST", body: { email } });
      if (r.sso && r.startUrl) {
        window.location.assign(withRedirect(r.startUrl, redirect));
        return;
      }
      setNotFound(true);
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  if (!open)
    return (
      <div className="sso-box">
        <div className="sso-sep" aria-hidden="true">
          <span />
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-block"
          onClick={() => {
            setOpen(true);
            setEmail(initial);
          }}
        >
          🔐 {tx("login.sso")}
        </button>
      </div>
    );
  return (
    <form className="stack sso-box" onSubmit={go}>
      <label className="field">
        <span>{tx("login.ssoEmail")}</span>
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </label>
      {notFound && <p className="muted small">{tx("login.ssoNotFound")}</p>}
      <ErrorBox error={error} />
      <div className="row-end">
        <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
          {tx("login.back")}
        </button>
        <button className="btn btn-primary" disabled={busy || !email}>
          {tx("login.ssoGo")}
        </button>
      </div>
    </form>
  );
}
