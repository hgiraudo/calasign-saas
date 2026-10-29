// Página pública de un formulario web (/f/:slug): la persona deja nombre y correo y entra directo a firmar.
import { useTitle } from "../lib/white-label";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { contrastText, type PublicWebForm, type SubmitWebFormResponse } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useScaleText } from "../lib/i18n-scale";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";
import { BrandFooter } from "../components/BrandFooter";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    o: { sitekey: string; callback: (t: string) => void; "expired-callback": () => void; "error-callback": () => void; language?: string },
  ) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

/** Script de Cloudflare Turnstile (una sola vez por página). */
let turnstileScript: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  const w = window as unknown as { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  turnstileScript ??= new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement("script"), {
      src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
      async: true,
    });
    el.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("turnstile")));
    el.onerror = () => {
      turnstileScript = null;
      reject(new Error("turnstile"));
    };
    document.head.appendChild(el);
  });
  return turnstileScript;
}

/** Desafío anti-bots (solo si la plataforma lo configuró: el formulario trae captchaSiteKey). */
export function Captcha({
  siteKey,
  locale,
  onToken,
  resetSignal,
}: {
  siteKey: string;
  locale: string;
  onToken: (t: string | null) => void;
  resetSignal: number;
}) {
  const st = useScaleText();
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  // Si el script de Cloudflare no carga (red, bloqueador), se avisa con un botón para reintentar: sin esto el botón
  // Continuar quedaba deshabilitado sin explicación.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let gone = false;
    setFailed(false);
    loadTurnstile()
      .then((api) => {
        if (gone || !box.current) return;
        const id = api.render(box.current, {
          sitekey: siteKey,
          callback: (t) => onToken(t),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
          language: locale,
        });
        widget.current = { api, id };
      })
      .catch(() => {
        onToken(null);
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, attempt]);
  // El token es de un solo uso: después de un envío rechazado se pide otro.
  useEffect(() => {
    if (resetSignal && widget.current) {
      onToken(null);
      widget.current.api.reset(widget.current.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);
  return (
    <>
      <div ref={box} />
      {failed && (
        <div className="alert alert-error stack">
          <span>{st("pub.captchaLoadError")}</span>
          <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            ↻ {st("pub.captchaRetry")}
          </button>
        </div>
      )}
    </>
  );
}

export function PublicFormPage() {
  const { slug = "" } = useParams();
  const [params] = useSearchParams();
  const embed = params.get("embed") === "1";
  const nav = useNavigate();
  const st = useScaleText();
  const { locale, setLocale, explicit } = useI18n();
  const [form, setForm] = useState<PublicWebForm | null>(null);
  const [notFound, setNotFound] = useState(false);
  useTitle(notFound ? st("pub.unavailable") : form?.name);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

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
    if (err instanceof HttpError && err.code === "captcha_failed") return st("pub.err.captcha");
    if (err instanceof HttpError && err.code === "form_recent_submission") return st("pub.err.recent");
    if (err instanceof HttpError && err.code === "form_rate_limited") return st("pub.err.busy");
    return errorText(err);
  };

  /**
   * 410 (o 409 form_misconfigured) al enviar: el formulario dejó de recibir envíos mientras la persona lo completaba.
   * Se muestra el estado "no disponible" (con el motivo, si lo hay) en vez de un error que invita a reintentar.
   */
  const markUnavailable = (err: unknown): boolean => {
    if (!(err instanceof HttpError)) return false;
    const reasons: Record<string, PublicWebForm["unavailableReason"]> = {
      form_inactive: "inactive",
      form_expired: "expired",
      form_exhausted: "exhausted",
      form_unavailable: null,
      form_misconfigured: null,
    };
    if (!(err.code in reasons) || (err.status !== 410 && err.code !== "form_misconfigured")) return false;
    setForm((f) => (f ? { ...f, available: false, unavailableReason: reasons[err.code] } : f));
    setError(null);
    return true;
  };

  const send = (formToken: string) =>
    api<SubmitWebFormResponse>(`/v1/public/forms/${encodeURIComponent(slug)}/submit`, {
      method: "POST",
      body: { name: name.trim(), email: email.trim(), phone: phone.trim() || null, locale, formToken, website, embed, captchaToken: captcha },
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
          // Con desafío, el token del desafío pudo quedar gastado en el envío rechazado: no se reusa. Se pide uno nuevo
          // y la persona vuelve a tocar Continuar cuando esté resuelto (ya con el token del formulario renovado).
          if (fresh.available && form.captchaSiteKey) {
            setCaptchaReset((n) => n + 1);
            setError(st("pub.err.formTokenCaptcha"));
            setBusy(false);
            return;
          }
          if (fresh.available) {
            const wait = Number((err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds);
            await new Promise((r) => setTimeout(r, (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) : 3) * 1000 + 300));
            nav((await send(fresh.formToken)).signingPath);
            return;
          }
        } catch (retryErr) {
          if (markUnavailable(retryErr)) {
            setBusy(false);
            return;
          }
          setError(submitError(retryErr));
          if (form.captchaSiteKey) setCaptchaReset((n) => n + 1);
        }
        setBusy(false);
        return;
      }
      if (markUnavailable(err)) {
        setBusy(false);
        return;
      }
      setError(submitError(err));
      // El desafío ya se usó (salvo que el rechazo fuera antes de verificarlo): se pide uno nuevo.
      if (form.captchaSiteKey && !(err instanceof HttpError && err.code === "too_fast")) setCaptchaReset((n) => n + 1);
      setBusy(false);
    }
  };

  const bar = form?.branding?.primaryColor ? { background: form.branding.primaryColor, color: contrastText(form.branding.primaryColor) } : undefined;
  return (
    <div className={`pubform ${embed ? "embed" : ""}`}>
      <header className="pubform-bar" style={bar}>
        {form?.branding?.logoUrl ? (
          <img src={form.branding.logoUrl} alt={form.organizationName} />
        ) : (
          <strong>{form?.organizationName ?? <Logo light />}</strong>
        )}
        <LocaleSwitcher compact />
      </header>
      <main className="pubform-main">
        <div className="card pad pubform-card stack">
          {notFound ? (
            <p>{st("pub.notFound")}</p>
          ) : !form ? (
            error ? (
              <ErrorBox error={error} />
            ) : (
              <Spinner />
            )
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
                  <div className="field">
                    <label className="field">
                      <span>{st("pub.phone")}</span>
                      <input
                        required
                        type="tel"
                        pattern="\+[1-9][0-9]{6,14}"
                        autoComplete="tel"
                        placeholder="+57…"
                        aria-describedby="pub-phone-hint"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value.replace(/[\s()-]/g, ""))}
                      />
                    </label>
                    {/* Fuera del label: si no, el formato se leía dos veces (en el nombre y en la descripción). */}
                    <small id="pub-phone-hint" className="muted small">
                      {st("pub.phoneHint")}
                    </small>
                  </div>
                )}
                {/* Trampa para bots: invisible para las personas. */}
                <label className="hp" aria-hidden="true">
                  Website
                  <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
                </label>
                {form.requireOtp && <p className="muted small">🔒 {st("pub.otpNote")}</p>}
                {/* Sin código por correo no se valida la dirección: la copia final no se manda, se descarga al terminar. */}
                <p className="muted small">{st(form.requireOtp ? "pub.copyNote" : "pub.copyNoteDownload")}</p>
                {form.captchaSiteKey && <Captcha siteKey={form.captchaSiteKey} locale={locale} onToken={setCaptcha} resetSignal={captchaReset} />}
                <ErrorBox error={error} />
                <button type="submit" className="btn btn-accent btn-block" disabled={busy || Boolean(form.captchaSiteKey && !captcha)}>
                  {busy ? st("pub.sending") : `${st("pub.continue")} →`}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
      {!embed && <BrandFooter className="pubform-foot" />}
    </div>
  );
}
