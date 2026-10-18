// Página pública de un formulario web (/f/:slug): la persona deja nombre y correo y entra directo a firmar.
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { PublicWebForm, SubmitWebFormResponse } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useScaleText } from "../lib/i18n-scale";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";

export function PublicFormPage() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const embed = params.get("embed") === "1";
  const nav = useNavigate();
  const st = useScaleText();
  const { locale, setLocale, explicit } = useI18n();
  const [form, setForm] = useState<PublicWebForm | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PublicWebForm>(`/v1/public/forms/${encodeURIComponent(slug)}`)
      .then((f) => {
        setForm(f);
        if (!explicit) setLocale(f.locale, false);
      })
      .catch((e) => (e instanceof HttpError && e.status === 404 ? setNotFound(true) : setError(errorText(e))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Mensaje por código (traducido): el texto de la API llega en español sea cual sea el idioma.
  const submitError = (err: unknown) => {
    if (err instanceof HttpError && err.code === "invalid_form_token") return st("pub.err.formToken");
    if (err instanceof HttpError && err.code === "too_fast") return st("pub.err.tooFast");
    return errorText(err);
  };

  const send = (formToken: string) =>
    api<SubmitWebFormResponse>(`/v1/public/forms/${encodeURIComponent(slug)}/submit`, {
      method: "POST",
      body: { name: name.trim(), email: email.trim(), phone: phone.trim() || null, locale, formToken, website, embed },
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      nav((await send(form.formToken)).signingPath);
    } catch (err) {
      // Token vencido (pestaña abierta mucho tiempo): se pide uno nuevo y, pasada la espera mínima que indica la API
      // (antes respondería too_fast), se reenvía una vez. Los datos cargados se conservan.
      if (err instanceof HttpError && err.code === "invalid_form_token") {
        try {
          const fresh = await api<PublicWebForm>(`/v1/public/forms/${encodeURIComponent(slug)}`);
          setForm(fresh);
          if (fresh.available) {
            const wait = Number((err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds);
            await new Promise((r) => setTimeout(r, (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) : 3) * 1000 + 300));
            nav((await send(fresh.formToken)).signingPath);
            return;
          }
        } catch (retryErr) {
          setError(submitError(retryErr));
        }
        setBusy(false);
        return;
      }
      setError(submitError(err));
      setBusy(false);
    }
  };

  const bar = form?.branding?.primaryColor ? { background: form.branding.primaryColor } : undefined;
  return (
    <div className={`pubform ${embed ? "embed" : ""}`}>
      <header className="pubform-bar" style={bar}>
        {form?.branding?.logoUrl ? <img src={form.branding.logoUrl} alt={form.organizationName} /> : <strong>{form?.organizationName ?? <Logo light />}</strong>}
        <LocaleSwitcher compact />
      </header>
      <main className="pubform-main">
        <div className="card pad pubform-card stack">
          {notFound ? (
            <p>{st("pub.notFound")}</p>
          ) : !form ? (
            error ? <ErrorBox error={error} /> : <Spinner />
          ) : !form.available ? (
            <>
              <h1>{st("pub.unavailable")}</h1>
              <p className="muted">{form.unavailableReason ? st(`pub.unavailable.${form.unavailableReason}` as "pub.unavailable.inactive") : ""}</p>
            </>
          ) : (
            <>
              <div>
                <p className="muted small">{form.organizationName}</p>
                <h1>{form.name}</h1>
                {form.description && <p style={{ whiteSpace: "pre-wrap" }}>{form.description}</p>}
              </div>
              <form className="stack" onSubmit={submit}>
                <h2 className="small muted">{st("pub.yourData")}</h2>
                <label className="field">
                  <span>{st("pub.name")}</span>
                  <input required minLength={2} maxLength={200} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="field">
                  <span>{st("pub.email")}</span>
                  <input required type="email" maxLength={320} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                {form.collectPhone && (
                  <label className="field">
                    <span>{st("pub.phone")}</span>
                    <input required type="tel" pattern="\+[1-9][0-9]{6,14}" autoComplete="tel" placeholder="+57…" value={phone} onChange={(e) => setPhone(e.target.value.replace(/[\s()-]/g, ""))} />
                  </label>
                )}
                {/* Trampa para bots: invisible para las personas. */}
                <label className="hp" aria-hidden="true">
                  Website
                  <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
                </label>
                {form.requireOtp && <p className="muted small">🔒 {st("pub.otpNote")}</p>}
                <p className="muted small">{st("pub.copyNote")}</p>
                <ErrorBox error={error} />
                <button type="submit" className="btn btn-accent btn-block" disabled={busy}>
                  {busy ? st("pub.sending") : `${st("pub.continue")} →`}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
      {!embed && <footer className="pubform-foot">{st("pub.poweredBy")}</footer>}
    </div>
  );
}
