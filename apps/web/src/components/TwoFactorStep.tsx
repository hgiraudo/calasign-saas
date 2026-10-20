// Segundo paso del ingreso: código TOTP o de recuperación.
import { redirectIfSsoRequired } from "./SsoLogin";
import { useState, type FormEvent } from "react";
import type { MeResponse } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useTeamsText } from "../lib/i18n-teams";
import { ErrorBox } from "./ui";

export function TwoFactorStep({
  challengeToken,
  onDone,
  onBack,
  from = "/app",
}: {
  challengeToken: string;
  onDone: (m: MeResponse) => void;
  onBack: () => void;
  /** A dónde volver después del ingreso por SSO (la página que se pidió antes del login). */
  from?: string;
}) {
  const tt = useTeamsText();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await api<MeResponse>("/v1/auth/2fa/verify", { method: "POST", body: { challengeToken, code } }));
    } catch (err) {
      // Invitación a una organización con SSO obligatorio: ya es miembro, se ingresa por el IdP.
      if (redirectIfSsoRequired(err, from)) return;
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={submit}>
      <h2>{tt("login.2faTitle")}</h2>
      <p className="muted">{tt("login.2faHelp")}</p>
      <input
        autoFocus
        autoComplete="one-time-code"
        inputMode="text"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-label={tt("sec.code")}
        style={{ letterSpacing: "0.2em", fontSize: "1.2rem", textAlign: "center" }}
      />
      <ErrorBox error={error} />
      <button className="btn btn-primary btn-block" disabled={busy || code.trim().length < 6}>
        {tt("login.verify")}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onBack}>
        {tt("login.back")}
      </button>
    </form>
  );
}
