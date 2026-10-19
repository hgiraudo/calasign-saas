// Páginas públicas de Fase 6: iniciar un workflow desde un link (/wf/:slug), completar sus datos (/w/:token)
// y revisar una negociación como contraparte (/n/:token).
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { NegotiationView, PublicWorkflowRun, PublicWorkflowStart } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useAgrText } from "../lib/i18n-agreements";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";
import { NegotiationPanel } from "./Negotiations";

function PublicShell({ org, children }: { org?: string; children: React.ReactNode }) {
  const ta = useAgrText();
  return (
    <div className="agr-public">
      <div className="agr-public-head">
        <div className="row-wrap">
          <Logo />
          {org && <strong>{org}</strong>}
        </div>
        <LocaleSwitcher compact />
      </div>
      {children}
      <p className="agr-powered">{ta("pub.poweredBy")}</p>
    </div>
  );
}

export function PublicWorkflowStartPage() {
  const { slug } = useParams();
  const ta = useAgrText();
  const nav = useNavigate();
  const [info, setInfo] = useState<PublicWorkflowStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // El workflow arrancó pero su primer paso no es un formulario público (p. ej. una aprobación interna): no es un error.
  const [started, setStarted] = useState(false);
  const trap = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api<PublicWorkflowStart>(`/v1/public/workflows/${encodeURIComponent(slug ?? "")}`)
      .then(setInfo)
      .catch((e) => setError(e instanceof HttpError && e.status === 404 ? ta("pub.notFound") : errorText(e)));
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string | null; runId: string }>(`/v1/public/workflows/${encodeURIComponent(slug ?? "")}/start`, { method: "POST", body: { website: trap.current?.value ?? "" } });
      if (r.token) nav(`/w/${r.token}`, { replace: true });
      else setStarted(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <PublicShell org={info?.organizationName}>
      <div className="card pad stack">
        {error && <ErrorBox error={error} />}
        {!info && !error && <Spinner />}
        {info && (
          <>
            <h1>{info.workflowName}</h1>
            {info.description && <p className="muted">{info.description}</p>}
            {started ? (
              <p role="status">{ta("pub.waiting")}</p>
            ) : (
              <>
                <input ref={trap} tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" style={{ position: "absolute", left: "-5000px" }} />
                <div>
                  <button type="button" className="btn btn-primary" onClick={start} disabled={busy}>
                    {ta("pub.start")}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </PublicShell>
  );
}

export function PublicWorkflowRunPage() {
  const { token } = useParams();
  const ta = useAgrText();
  const [view, setView] = useState<PublicWorkflowRun | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const trap = useRef<HTMLInputElement>(null);
  const load = useCallback(() => {
    api<PublicWorkflowRun>(`/v1/public/workflow-runs/${encodeURIComponent(token ?? "")}`)
      .then((v) => {
        // Un refresco que falló (corte de red) no deja el error en pantalla cuando el siguiente responde bien.
        setView(v);
        setError(null);
      })
      .catch((e) => setError(e instanceof HttpError && e.status === 404 ? ta("pub.notFound") : errorText(e)));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  // Mientras espera (p. ej. la aprobación interna), se refresca para mostrar el link de firma cuando esté.
  useEffect(() => {
    if (!view || view.step || view.signingUrl || !["running", "waiting"].includes(view.status)) return;
    const h = window.setInterval(load, 5000);
    return () => window.clearInterval(h);
  }, [view, load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!view?.step) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api<PublicWorkflowRun>(`/v1/public/workflow-runs/${encodeURIComponent(token ?? "")}/steps/${view.step.index}`, { method: "POST", body: { values, website: trap.current?.value ?? "" } });
      setView(v);
      setValues({});
      setSent(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PublicShell org={view?.organizationName}>
      <div className="card pad stack">
        <ErrorBox error={error} />
        {!view && !error && <Spinner />}
        {view && (
          <>
            <h1>{view.step?.title ?? view.workflowName}</h1>
            {view.step ? (
              <form className="stack" onSubmit={submit}>
                {view.step.description && <p className="muted">{view.step.description}</p>}
                <input ref={trap} tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" style={{ position: "absolute", left: "-5000px" }} />
                {view.step.fields.map((f) => (
                  <label key={f.key} className="field">
                    <span>
                      {f.label}
                      {f.required ? " *" : ""}
                    </span>
                    {f.type === "textarea" ? (
                      <textarea value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} required={f.required} rows={3} />
                    ) : f.type === "select" ? (
                      <select value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} required={f.required}>
                        <option value="">—</option>
                        {(f.options ?? []).map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={f.type === "number" ? "text" : f.type}
                        inputMode={f.type === "number" ? "decimal" : undefined}
                        autoComplete={f.type === "email" ? "email" : undefined}
                        value={values[f.key] ?? ""}
                        onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                        required={f.required}
                      />
                    )}
                  </label>
                ))}
                <div>
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {ta("pub.continue")}
                  </button>
                </div>
              </form>
            ) : view.signingUrl ? (
              <div className="stack">
                <p>{ta("pub.thanks")}</p>
                <div>
                  <a className="btn btn-primary" href={view.signingUrl}>
                    {ta("pub.signNow")}
                  </a>
                </div>
              </div>
            ) : view.status === "completed" ? (
              <p>{ta("pub.done")}</p>
            ) : ["failed", "rejected", "cancelled"].includes(view.status) ? (
              <p>{ta("pub.ended")}</p>
            ) : (
              <p role="status">{sent ? `${ta("pub.thanks")} ${ta("pub.waiting")}` : ta("pub.waiting")}</p>
            )}
          </>
        )}
      </div>
    </PublicShell>
  );
}

export function PublicNegotiationPage() {
  const { token } = useParams();
  const ta = useAgrText();
  const [view, setView] = useState<(NegotiationView & { organizationName?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<NegotiationView & { organizationName?: string }>(`/v1/public/negotiations/${encodeURIComponent(token ?? "")}`)
      .then(setView)
      .catch((e) => setError(e instanceof HttpError && e.status === 404 ? ta("pub.notFound") : errorText(e)));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page" style={{ maxWidth: 1180, margin: "0 auto", padding: "1rem" }}>
      <div className="agr-public-head">
        <div className="row-wrap">
          <Logo />
          {view?.organizationName && <strong>{view.organizationName}</strong>}
        </div>
        <LocaleSwitcher compact />
      </div>
      <ErrorBox error={error} />
      {!view && !error && <Spinner />}
      {view && (
        <>
          <h1>{view.negotiation.title}</h1>
          <p className="muted">
            {ta("neg.participant")} · {view.me ? ta("neg.youAre", { name: view.me.name }) : ""}
          </p>
          <NegotiationPanel base={`/v1/public/negotiations/${encodeURIComponent(token ?? "")}`} mode="participant" initial={view} />
        </>
      )}
      <p className="agr-powered">{ta("pub.poweredBy")}</p>
    </div>
  );
}
