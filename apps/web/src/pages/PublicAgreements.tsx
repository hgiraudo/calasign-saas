// Páginas públicas de Fase 6: iniciar un workflow desde un link (/wf/:slug), completar sus datos (/w/:token)
// y revisar una negociación como contraparte (/n/:token).
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { NegotiationView, PublicWorkflowRun, PublicWorkflowStart } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useAgrText } from "../lib/i18n-agreements";
import { useI18n } from "../lib/i18n";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";
import { BrandFooter } from "../components/BrandFooter";
import { NegotiationPanel } from "./Negotiations";
import { Captcha } from "./PublicForm";

/** Errores de los links públicos de workflows con texto propio (el resto, el genérico). */
function publicError(e: unknown, ta: ReturnType<typeof useAgrText>): string {
  if (e instanceof HttpError) {
    if (e.code === "captcha_failed") return ta("pub.err.captcha");
    if (e.code === "too_fast") return ta("pub.err.tooFast");
    if (e.code === "form_recent_submission") return ta("pub.err.recent");
    if (e.code === "workflow_inactive") return ta("pub.err.inactive");
    if (e.code === "not_waiting") return ta("pub.err.notWaiting");
    if (e.code === "workflow_rate_limited") return ta("pub.err.rateLimited");
  }
  return errorText(e);
}

/** Errores por campo de un 400 validation_error ({ path, message }), con el texto en el idioma de la página. */
function fieldErrors(e: unknown, fields: { key: string; label: string }[], ta: ReturnType<typeof useAgrText>): Record<string, string> | null {
  if (!(e instanceof HttpError) || e.code !== "validation_error" || !Array.isArray(e.details)) return null;
  // La API valida cada campo con "<etiqueta>: <motivo>" en español; el motivo se traduce y la etiqueta es la del campo.
  const reasons: Record<string, Parameters<typeof ta>[0]> = {
    obligatorio: "pub.err.required",
    "correo inválido": "pub.err.email",
    "número inválido": "pub.err.number",
    "fecha inválida": "pub.err.date",
    "opción inválida": "pub.err.option",
  };
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    const path = String(d?.path ?? "").replace(/^values\./, "");
    const f = fields.find((x) => x.key === path);
    if (!f) continue;
    const msg = String(d?.message ?? "");
    const reason = msg.startsWith(`${f.label}: `) ? msg.slice(f.label.length + 2) : msg;
    out[f.key] = `${f.label}: ${reasons[reason] ? ta(reasons[reason]) : reason}`;
  }
  return Object.keys(out).length ? out : null;
}

function PublicShell({ org, children }: { org?: string; children: React.ReactNode }) {
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
      <BrandFooter className="agr-powered" />
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
  const { locale } = useI18n();
  // Desafío anti-bots (si la plataforma lo configuró): el token es de un solo uso, se pide otro tras un rechazo.
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  useEffect(() => {
    api<PublicWorkflowStart>(`/v1/public/workflows/${encodeURIComponent(slug ?? "")}`)
      .then(setInfo)
      .catch((e) => setError(e instanceof HttpError && e.status === 404 ? ta("pub.notFound") : errorText(e)));
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string | null; runId: string }>(`/v1/public/workflows/${encodeURIComponent(slug ?? "")}/start`, {
        method: "POST",
        body: { website: trap.current?.value ?? "", captchaToken: captcha },
      });
      if (r.token) nav(`/w/${r.token}`, { replace: true });
      else setStarted(true);
    } catch (e) {
      setError(publicError(e, ta));
      setBusy(false);
      if (info?.captchaSiteKey) setCaptchaReset((n) => n + 1);
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
                {info.captchaSiteKey && <Captcha siteKey={info.captchaSiteKey} locale={locale} onToken={setCaptcha} resetSignal={captchaReset} />}
                <div>
                  <button type="button" className="btn btn-primary" onClick={start} disabled={busy || Boolean(info.captchaSiteKey && !captcha)}>
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
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const trap = useRef<HTMLInputElement>(null);
  const url = `/v1/public/workflow-runs/${encodeURIComponent(token ?? "")}`;
  const load = useCallback(
    (opts: { keepError?: boolean } = {}) =>
      api<PublicWorkflowRun>(url)
        .then((v) => {
          // Un refresco que falló (corte de red) no deja el error en pantalla cuando el siguiente responde bien.
          setView(v);
          if (!opts.keepError) setError(null);
        })
        .catch((e) => {
          if (!opts.keepError) setError(e instanceof HttpError && e.status === 404 ? ta("pub.notFound") : errorText(e));
        }),
    [url], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Mientras espera (p. ej. la aprobación interna), se refresca para mostrar el link de firma cuando esté: cada vez más
  // espaciado (de 5 s hasta 60 s) y en pausa con la pestaña oculta; al volver a la pestaña, se consulta enseguida.
  const waiting = Boolean(view && !view.step && !view.signingUrl && ["running", "waiting"].includes(view.status));
  useEffect(() => {
    if (!waiting) return;
    let delay = 5000;
    let h: number | undefined;
    // Un load() en vuelo cuando se desmonta (o termina la espera) no vuelve a programar el sondeo.
    let cancelled = false;
    const schedule = () => {
      window.clearTimeout(h);
      if (cancelled || document.hidden) return;
      h = window.setTimeout(() => {
        delay = Math.min(delay * 2, 60_000);
        void load().finally(schedule);
      }, delay);
    };
    const onVisible = () => {
      if (cancelled) return;
      if (document.hidden) return window.clearTimeout(h);
      delay = 5000;
      void load().finally(schedule);
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(h);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [waiting, load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!view?.step) return;
    setBusy(true);
    setError(null);
    setInvalid({});
    try {
      const v = await api<PublicWorkflowRun>(`${url}/steps/${view.step.index}`, { method: "POST", body: { values, website: trap.current?.value ?? "" } });
      setView(v);
      setValues({});
      setSent(true);
    } catch (err) {
      const byField = fieldErrors(err, view.step.fields, ta);
      if (byField) {
        setInvalid(byField);
        setError(ta("pub.err.fields"));
        return;
      }
      setError(publicError(err, ta));
      // 409 (ya completado) o 410 (workflow desactivado, ejecución cancelada): se trae el estado real para no dejar el
      // formulario en pantalla como si todavía se pudiera enviar.
      if (err instanceof HttpError && (err.status === 409 || err.status === 410)) await load({ keepError: true });
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
                {view.step.fields.map((f) => {
                  const err = invalid[f.key];
                  const a11y = { "aria-invalid": err ? true : undefined, "aria-describedby": err ? `wf-err-${f.key}` : undefined };
                  const set = (v: string) => {
                    setValues({ ...values, [f.key]: v });
                    if (err) setInvalid(({ [f.key]: _gone, ...rest }) => rest);
                  };
                  return (
                    <div key={f.key} className="field">
                      <label className="field">
                        <span>
                          {f.label}
                          {f.required ? " *" : ""}
                        </span>
                        {f.type === "textarea" ? (
                          <textarea value={values[f.key] ?? ""} onChange={(e) => set(e.target.value)} required={f.required} rows={3} {...a11y} />
                        ) : f.type === "select" ? (
                          <select value={values[f.key] ?? ""} onChange={(e) => set(e.target.value)} required={f.required} {...a11y}>
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
                            onChange={(e) => set(e.target.value)}
                            required={f.required}
                            {...a11y}
                          />
                        )}
                      </label>
                      {/* Fuera del label: si no, el error se leía dos veces (en el nombre y en la descripción). */}
                      {err && (
                        <small id={`wf-err-${f.key}`} className="err-text small">
                          {err}
                        </small>
                      )}
                    </div>
                  );
                })}
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
      <BrandFooter className="agr-powered" />
    </div>
  );
}
