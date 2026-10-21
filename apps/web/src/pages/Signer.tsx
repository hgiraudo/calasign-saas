// Experiencia del firmante: /s/:token. Sin cuenta, mobile-first.
import { useFieldLogic } from "../lib/logic";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import type { CompleteSigningInput, Field, SignatureImageInput, SigningSession } from "@calasign/shared";
import { AUTO_FIELD_TYPES, ATTACHMENT_MAX_BYTES, contrastText, formatSigningDate, parseNumberLoose, signingDateForDisplay } from "@calasign/shared";
import { api, errorText, fetchResponse, HttpError, problemFields, readBody } from "../lib/api";
import { formatDate, formatDateTime, useI18n } from "../lib/i18n";
import { DocumentView } from "../components/DocumentView";
import { SignaturePad } from "../components/SignaturePad";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";
import { DeclineModal } from "../components/DeclineModal";
import { isEmbedded, isTabReturn, tokenOfBase, useEmbedBridge } from "../lib/embed";
import { DelegateModal, isStaleError, OtpGate } from "../components/SignerExtras";
import { useSignerText } from "../lib/i18n-signer";
import { InPersonBlocked, InPersonDone, InPersonHandover, RequestCopyButton, useFocusOnMount } from "../components/ExperienceExtras";
import { useExpText } from "../lib/i18n-experience";
import { IdentityGate } from "../components/IdentityGate";
import { PaymentGate, SignerPaymentAfterSign } from "../components/BillingExtras";
import { AiSignerAssist } from "../components/AiPanels";
import { SignerCertificateStep } from "../components/CertSign";
import { BrandFooter } from "../components/BrandFooter";
import { brandTheme, setBrandTheme } from "../lib/white-label";

type Adopted = SignatureImageInput & { dataUrl: string };

/**
 * Descarga del PDF por fetch: con un <a href>, un error (sesión vencida, sobre anulado, copia ocupada) reemplazaba la
 * página por el JSON de la API y el firmante quedaba fuera de la app. Con 401 se recarga la sesión (vuelve el OTP).
 */
function SignerDownload({ path, name, label, primary, onAuth }: { path: string; name: string; label: string; primary?: boolean; onAuth: () => unknown }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetchResponse(path);
      // Navegadores dentro de apps en iOS (Instagram, Facebook…) ignoran la descarga de un blob: ahí, con el pedido ya
      // comprobado, se abre el PDF directamente, como antes.
      if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !/Safari\//.test(navigator.userAgent)) {
        res.body?.cancel().catch(() => {});
        window.location.assign(path);
        return;
      }
      const blob = await readBody(res.blob());
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: `${(name || "document").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120)}.pdf` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) onAuth();
      else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={`btn${primary ? " btn-primary" : ""}`} disabled={busy} onClick={go}>
        ⬇ {label}
      </button>
      <ErrorBox error={err} />
    </>
  );
}

export function SignerPage() {
  const { token = "" } = useParams();
  const { t, setLocale, explicit } = useI18n();
  const [session, setSession] = useState<SigningSession | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delegatedTo, setDelegatedTo] = useState<string | null>(null);
  const sx = useSignerText();
  const base = `/v1/signing/${encodeURIComponent(token)}`;

  const apply = useCallback(
    (s: SigningSession) => {
      // Marca blanca: tema, textos y nombre del producto de la marca del sobre.
      if (s.theme) setBrandTheme(s.theme);
      setSession(s);
      if (!explicit && s.recipient.locale) setLocale(s.recipient.locale, false);
    },
    [explicit, setLocale],
  );

  useEffect(() => {
    api<SigningSession>(base)
      .then(apply)
      .catch((e) => {
        if (e instanceof HttpError && [400, 401, 403, 404, 410].includes(e.status)) setInvalid(true);
        else setError(errorText(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEmbedBridge(token, session, invalid);
  // Pago antes de firmar: al cambiar, el PaymentGate vuelve a consultar el pago (p. ej. "Finalizar" respondió 402).
  const [paymentCheck, setPaymentCheck] = useState(0);
  // Recarga después de pagar, firmar con certificado o la entrega presencial. Con la sesión ya cargada, un error
  // de esta recarga se muestra arriba del contenido (antes solo se veía si todavía no había sesión).
  // Solo cuenta la respuesta del último pedido: una más vieja ("finalizing") que llega tarde no pisa a una nueva.
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    return api<SigningSession>(base)
      .then((s) => {
        if (mine !== seq.current) return;
        setError(null);
        apply(s);
      })
      .catch((e) => {
        if (mine === seq.current) setError(errorText(e));
      });
  }, [base, apply]);
  /**
   * Un error terminal al finalizar o rechazar (sesión vencida, sobre anulado, ya firmado…): se vuelve a pedir la
   * sesión y se aplica como en la carga, para mostrar la pantalla que corresponde (OTP, cierre) en lugar de solo el
   * texto del error. Un link que ya no existe pasa a "link inválido", como al cargar.
   */
  const resync = useCallback(() => {
    const mine = ++seq.current;
    return api<SigningSession>(base)
      .then((s) => {
        if (mine !== seq.current) return;
        setError(null);
        apply(s);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        if (e instanceof HttpError && [400, 401, 403, 404, 410].includes(e.status)) setInvalid(true);
        else setError(errorText(e));
      });
  }, [base, apply]);

  /**
   * Última sesión con la que se mostró el flujo de firma. Si la sesión del código vence a mitad (401 → se vuelve a pedir
   * el código), el flujo queda montado y oculto mientras se valida: al volver, sigue lo que el firmante ya completó.
   */
  const lastFlow = useRef<SigningSession | null>(null);

  // Después de la última firma el sobre queda en 'finalizing' mientras se sella el PDF (en segundo plano):
  // se consulta cada pocos segundos para mostrar el botón de descarga apenas esté listo.
  const sealing = session?.envelope.status === "finalizing";
  // Firma en persona: la pantalla final cierra la sesión del firmante (/in-person/end) y no ofrece descarga. Si se
  // siguiera consultando, la sesión volvía con otpRequired y la pantalla pasaba a "abierto fuera del dispositivo".
  const pollSealing = sealing && !session?.inPerson;
  useEffect(() => {
    if (!pollSealing) return;
    // Cada 3 s los primeros 3 minutos y después cada 30 s: si el sellado tarda (reintentos del worker), el botón
    // igual aparece sin recargar. Mientras tanto se puede bajar la copia en curso.
    // El siguiente pedido sale cuando terminó el anterior (con una API lenta no se acumulan).
    let tries = 0;
    let id = 0;
    let stopped = false;
    const tick = () => {
      void reload().finally(() => {
        if (!stopped) id = window.setTimeout(tick, ++tries < 60 ? 3000 : 30000);
      });
    };
    id = window.setTimeout(tick, 3000);
    return () => {
      stopped = true;
      window.clearTimeout(id);
    };
  }, [pollSealing, reload]);

  if (invalid)
    return (
      <SignerShell>
        <Final icon="⚠" title={t("sign.invalidTitle")} text={t("sign.invalidText")} />
      </SignerShell>
    );
  if (!session)
    return <SignerShell>{error ? <ErrorBox error={error} /> : <Spinner />}</SignerShell>;
  if (delegatedTo)
    return (
      <SignerShell org={session.envelope.organizationName}>
        <Final icon="↪" ok title={sx("delegate.doneTitle")} text={sx("delegate.doneText", { name: delegatedTo })} />
      </SignerShell>
    );
  // Sobre anulado, vencido o rechazado: el cierre se muestra antes del código. Si no, el firmante con OTP pedía y
  // escribía el código para recibir después un 410.
  const closedStatus = session.envelope.status;
  if (session.otpRequired && (closedStatus === "voided" || closedStatus === "expired" || closedStatus === "declined"))
    return (
      <SignerShell org={session.envelope.organizationName} branding={session.branding}>
        {closedStatus === "voided" ? (
          <Final icon="⊘" title={t("sign.voidedTitle")} text={t("sign.closedText")} />
        ) : closedStatus === "expired" ? (
          <Final icon="⌛" title={t("sign.expiredTitle")} text={t("sign.closedText")} />
        ) : session.recipient.status === "declined" ? (
          <Final icon="✕" title={t("sign.declinedTitle")} text={t("sign.declinedText")} />
        ) : (
          <Final icon="✕" title={t("sign.declinedByOtherTitle")} text={t("sign.closedText")} />
        )}
      </SignerShell>
    );
  if (session.otpRequired && session.inPerson)
    return (
      <SignerShell org={session.envelope.organizationName} branding={session.branding}>
        <InPersonBlocked session={session} />
      </SignerShell>
    );
  if (session.otpRequired) {
    const otp = (
      <SignerShell org={session.envelope.organizationName} branding={session.branding}>
        <OtpGate session={session} base={base} onDone={apply} onStale={resync} />
      </SignerShell>
    );
    return lastFlow.current ? renderFlow(lastFlow.current, otp) : otp;
  }

  const { envelope, recipient } = session;
  const download = session.signedAvailable ? (
    <>
      <SignerDownload path={`${base}/signed.pdf`} name={session.envelope.subject} primary label={t("sign.downloadSigned")} onAuth={reload} />
      {/* Sin correo validado (formulario web) no se le manda la copia: solo la descarga. */}
      {session.finalCopyByMessage !== false && <RequestCopyButton base={base} />}
    </>
  ) : session.copyAvailable ? (
    <>
      {sealing && <Spinner />}
      <SignerDownload path={`${base}/copy.pdf`} name={session.envelope.subject} label={t("sign.downloadCopy")} onAuth={reload} />
      <p className="small muted">{t("sign.copyNote")}</p>
    </>
  ) : null;

  let content: ReactNode;
  // Cualquier otra pantalla deja de conservar el flujo oculto (un código pedido después ya no lo vuelve a montar).
  lastFlow.current = null;
  // Un firmante con certificado pendiente ya figura como "signed" (etapa electrónica): si el sobre se anuló o
  // venció mientras esperaba su certificado, se muestra el cierre en lugar del paso del Firmador.
  const certPending = session.certificateSigning != null && session.certificateSigning.status !== "signed";
  if (certPending && envelope.status === "voided") {
    content = <Final icon="⊘" title={t("sign.voidedTitle")} text={t("sign.closedText")} />;
  } else if (certPending && envelope.status === "expired") {
    content = <Final icon="⌛" title={t("sign.expiredTitle")} text={t("sign.closedText")} />;
  } else if (session.inPerson?.active && recipient.status === "signed") {
    content = <InPersonDone session={session} base={base} />;
  } else if (recipient.status === "signed" || recipient.status === "completed") {
    content =
      recipient.role === "cc" ? (
        <CcView session={session} base={base} download={download} />
      ) : (
        <Final
          icon="✓"
          ok
          title={recipient.role === "approver" ? sx("approve.doneTitle") : t("sign.doneTitle")}
          text={
            session.signedAvailable
              ? t("sign.doneAvailable")
              : sealing
                ? t("sign.sealing")
                : session.finalCopyByMessage === false
                  ? t("sign.doneTextDownload")
                  : recipient.role === "approver"
                    ? sx("approve.doneText")
                    : t("sign.doneText")
          }
        >
          {download}
          {session.certificateSigning && <SignerCertificateStep step={session.certificateSigning} base={base} onChange={reload} />}
          <SignerPaymentAfterSign base={base} onPaid={reload} />
        </Final>
      );
  } else if (session.inPerson?.active && recipient.status === "declined") {
    // Rechazo en una sesión presencial: también se cierra la sesión del anfitrión y se ofrece volver al sobre.
    content = <InPersonDone session={session} base={base} declined />;
  } else if (recipient.status === "declined") {
    content = <Final icon="✕" title={t("sign.declinedTitle")} text={t("sign.declinedText")} />;
  } else if (envelope.status === "voided") {
    content = <Final icon="⊘" title={t("sign.voidedTitle")} text={t("sign.closedText")} />;
  } else if (envelope.status === "expired") {
    content = <Final icon="⌛" title={t("sign.expiredTitle")} text={t("sign.closedText")} />;
  } else if (envelope.status === "declined") {
    content = <Final icon="✕" title={t("sign.declinedByOtherTitle")} text={t("sign.closedText")} />;
  } else if (recipient.role === "cc") {
    content = <CcView session={session} base={base} download={download} />;
  } else if (!session.canSign) {
    content = <Final icon="⏳" title={t("sign.notYourTurnTitle")} text={t("sign.notYourTurnText")} />;
  } else if (session.inPerson?.active && !session.inPerson.identityConfirmed) {
    content = <InPersonHandover session={session} base={base} onDone={reload} onDeclined={apply} onStale={resync} />;
  } else if (session.identity?.required && session.identity.status !== "verified") {
    content = <IdentityGate session={session} base={base} onDone={apply} onStale={resync} />;
  } else if (!recipient.consented) {
    content = <Consent session={session} base={base} onDone={apply} onStale={resync} />;
  } else {
    lastFlow.current = session;
    return renderFlow(session, null);
  }

  return (
    <SignerShell org={envelope.organizationName} branding={session.branding}>
      {error && <ErrorBox error={error} />}
      {content}
    </SignerShell>
  );

  /**
   * Flujo de firma (detrás del pago previo). Con `gate` (el pedido del código), el flujo queda montado pero oculto, en la
   * misma posición del árbol que sin él: React no lo desmonta y no se pierden los campos, la firma ni los adjuntos.
   */
  function renderFlow(s: SigningSession, gate: ReactNode) {
    return (
      <>
        {gate}
        <HiddenFlow hidden={!!gate}>
          <PaymentGate
            base={base}
            check={paymentCheck}
            onStale={resync}
            wrap={(n) => (
              <SignerShell org={s.envelope.organizationName} branding={s.branding}>
                {error && <ErrorBox error={error} />}
                {n}
              </SignerShell>
            )}
          >
            <SigningFlow
              session={s}
              base={base}
              onDone={apply}
              onDelegated={setDelegatedTo}
              onStale={resync}
              onPaymentRequired={() => setPaymentCheck((n) => n + 1)}
            />
          </PaymentGate>
        </HiddenFlow>
      </>
    );
  }
}

/**
 * Contenedor del flujo de firma que se oculta mientras se vuelve a pedir el código. Mientras está visible recuerda el
 * desplazamiento y el elemento con foco; al volver a mostrarse los restaura (si no, el firmante quedaba arriba de todo
 * y sin foco, lejos del campo que estaba completando). Los listeners se registran con useLayoutEffect para que se quiten
 * en el mismo commit que oculta el flujo, antes del "scroll" que genera el cambio de alto de la página.
 */
function HiddenFlow({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  const saved = useRef<{ y: number; el: HTMLElement | null } | null>(null);
  useLayoutEffect(() => {
    if (hidden) return;
    const pending = saved.current;
    if (pending) {
      saved.current = null;
      window.scrollTo({ top: pending.y });
      if (pending.el && pending.el !== document.body && document.contains(pending.el)) pending.el.focus({ preventScroll: true });
    }
    const remember = () => {
      saved.current = { y: window.scrollY, el: document.activeElement as HTMLElement | null };
    };
    remember();
    window.addEventListener("scroll", remember, { passive: true });
    document.addEventListener("focusin", remember);
    return () => {
      window.removeEventListener("scroll", remember);
      document.removeEventListener("focusin", remember);
    };
  }, [hidden]);
  return (
    <div hidden={hidden} style={hidden ? undefined : { display: "contents" }}>
      {children}
    </div>
  );
}

type SessionBranding = SigningSession["branding"];

/** Estilo de la barra superior según el branding de la organización remitente. */
function brandBarStyle(b: SessionBranding) {
  if (!b?.primaryColor) return undefined;
  // Texto legible sobre el color de la marca (el que fijó la marca, o blanco/oscuro según contraste).
  return { background: b.primaryColor, color: brandTheme()?.theme.headerTextColor ?? contrastText(b.primaryColor) };
}

function BrandOrg({ org, branding }: { org?: string; branding?: SessionBranding }) {
  if (branding?.logoUrl)
    return (
      <span className="signer-brand">
        <img src={branding.logoUrl} alt={org ?? ""} className="signer-logo" />
      </span>
    );
  return <>{org ?? <Logo light />}</>;
}

function SignerShell({ children, org, branding }: { children: ReactNode; org?: string; branding?: SessionBranding }) {
  const { t } = useI18n();
  return (
    <div className="signer">
      <header className="signer-bar" style={brandBarStyle(branding)}>
        <div className="signer-org">
          <BrandOrg org={org} branding={branding} />
        </div>
        <LocaleSwitcher compact />
      </header>
      <main className="signer-main">{children}</main>
      <BrandFooter />
    </div>
  );
}

function Final({ icon, title, text, ok, children }: { icon: string; title: string; text: string; ok?: boolean; children?: ReactNode }) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div className="final card">
      <div className={`final-icon ${ok ? "ok" : ""}`} aria-hidden="true">
        {icon}
      </div>
      <h1 ref={heading} tabIndex={-1}>
        {title}
      </h1>
      {/* Anuncia los cambios de estado (p. ej. "sellando…" → "disponible") sin mover el foco. */}
      <p className="muted" role="status" aria-live="polite">
        {text}
      </p>
      {children && <div className="final-actions">{children}</div>}
    </div>
  );
}

function EnvelopeIntro({ session, downloads }: { session: SigningSession; downloads?: ReactNode }) {
  const { t, locale } = useI18n();
  const e = session.envelope;
  return (
    <div className="intro">
      <p className="muted small">
        <strong>{e.senderName}</strong> ({e.organizationName}) {t("sign.sentBy")}
      </p>
      <h1>{e.subject}</h1>
      {e.message && <p className="message-box">{e.message}</p>}
      {downloads && <div className="row-wrap">{downloads}</div>}
      {session.recipient.telegramLink && (
        <p>
          <a className="btn btn-sm btn-telegram" href={session.recipient.telegramLink} target="_blank" rel="noopener noreferrer">
            ✈ {t("sign.telegram")}
          </a>
        </p>
      )}
      {e.expiresAt && (
        <p className="muted small">
          {t("edit.expires")}: {formatDateTime(e.expiresAt, locale)}
        </p>
      )}
    </div>
  );
}

function Consent({
  session,
  base,
  onDone,
  onStale,
}: {
  session: SigningSession;
  base: string;
  onDone: (s: SigningSession) => void;
  /** Vuelve a pedir la sesión ante un error terminal (sesión vencida, sobre anulado o vencido…). */
  onStale: () => unknown;
}) {
  const { t } = useI18n();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api<SigningSession>(`${base}/consent`, { method: "POST" }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
      // Sesión vencida, sobre cerrado o link reemplazado: la página pasa a la pantalla que corresponde.
      if (isStaleError(e)) void onStale();
    }
  };
  return (
    <div className="card pad consent stack">
      <EnvelopeIntro session={session} />
      <h2>{t("sign.consentTitle")}</h2>
      <label className="check consent-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>{t("sign.consentText")}</span>
      </label>
      <ErrorBox error={error} />
      <button type="button" className="btn btn-primary btn-block" disabled={!checked || busy} onClick={accept}>
        {t("sign.consentAccept")}
      </button>
      {/* Se puede rechazar sin aceptar el uso de medios electrónicos (el servidor lo admite). */}
      <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={() => setDeclining(true)}>
        {t("sign.decline")}
      </button>
      {declining && <DeclineModal base={base} onClose={() => setDeclining(false)} onDone={onDone} onStale={onStale} />}
    </div>
  );
}

function CcView({ session, base, download }: { session: SigningSession; base: string; download: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="stack">
      <div className="card pad">
        <EnvelopeIntro session={session} />
        <h2>{t("sign.ccTitle")}</h2>
        <p className="muted">{t("sign.ccText")}</p>
        {download}
      </div>
      {session.documents.map((d) => (
        <DocumentView key={d.id} doc={d} url={`${base}/documents/${d.id}/file`} headingLevel={2} />
      ))}
    </div>
  );
}

// ───────────────────────────── Flujo de firma ─────────────────────────────

function isAuto(f: Field) {
  return AUTO_FIELD_TYPES.includes(f.type) || f.readOnly;
}

/** Campos en los que el firmante escribe o elige un valor. */
const VALUE_TYPES = ["text", "number", "dropdown", "company", "title"];

// Aproximación del ajuste del texto estampado (packages/pdf layoutFieldText): tamaño mínimo de 6 pt (o menos en una
// caja muy baja), interlineado 1.15 y 1 pt de margen a cada lado. Se mide con una fuente parecida a DejaVu Sans.
const STAMP_MIN_SIZE = 6;
let measureCtx: CanvasRenderingContext2D | null | undefined;
function stampFits(text: string, boxW: number, boxH: number): boolean {
  if (measureCtx === undefined) measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  const ctx = measureCtx;
  if (!ctx || boxW <= 2 || boxH <= 0) return true;
  const size = Math.min(STAMP_MIN_SIZE, boxH * 0.7, 11);
  ctx.font = `${size}px "DejaVu Sans", Verdana, Arial, sans-serif`;
  const maxW = boxW - 2;
  if (ctx.measureText(text).width <= maxW) return true;
  const maxLines = Math.max(1, Math.floor(boxH / (size * 1.15)));
  let lines = 1;
  let line = "";
  for (const word of text.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxW) {
      line = candidate;
      continue;
    }
    // Palabra más larga que la caja: se parte en tantas líneas como ocupe.
    const wordLines = Math.max(1, Math.ceil(ctx.measureText(word).width / maxW));
    lines += line ? wordLines : wordLines - 1;
    line = wordLines > 1 ? "" : word;
    if (lines > maxLines) return false;
  }
  return lines <= maxLines;
}

function SigningFlow({
  session,
  base,
  onDone,
  onDelegated,
  onStale,
  onPaymentRequired,
}: {
  session: SigningSession;
  base: string;
  onDone: (s: SigningSession) => void;
  onDelegated: (name: string) => void;
  /** Vuelve a pedir la sesión después de un error terminal (401, 404, 409, 410). */
  onStale: () => Promise<unknown>;
  /** "Finalizar" respondió 402: el pago previo a la firma está pendiente. */
  onPaymentRequired: () => void;
}) {
  const { t } = useI18n();
  const sx = useSignerText();
  const x = useExpText();
  const [delegating, setDelegating] = useState(false);
  const finishLabel = session.recipient.role === "approver" ? sx("approve.button") : t("sign.finish");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      session.fields
        .filter((f) => VALUE_TYPES.includes(f.type) || f.type === "checkbox" || f.type === "attachment")
        .map((f) => [f.id, f.value ?? (f.type === "checkbox" ? "false" : "")]),
    ),
  );
  const [uploading, setUploading] = useState<string | null>(null);
  const [signature, setSignature] = useState<Adopted | null>(null);
  const [initials, setInitials] = useState<Adopted | null>(null);
  const [pad, setPad] = useState<"signature" | "initials" | null>(null);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  /** Campo señalado por el último error de "Finalizar" (aria-invalid + aria-describedby al texto del error). */
  const [invalidId, setInvalidId] = useState<string | null>(null);
  /** Campos que el servidor rechazó en el último "Finalizar" (422): siguen marcados aunque la página los vea completos. */
  const [serverProblems, setServerProblems] = useState<ReadonlySet<string>>(() => new Set());
  /** Campo al que ir apenas llegue la sesión recargada después de un 422. */
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const logic = useFieldLogic(session, values);

  // Sesión recargada (p. ej. después de un 422 al finalizar): lo escrito se conserva; los adjuntos siguen al servidor
  // (el que la página creía subido puede no estar) y los campos nuevos toman su valor.
  useEffect(() => {
    setValues((v) => {
      let next = v;
      for (const f of session.fields) {
        const own = VALUE_TYPES.includes(f.type) || f.type === "checkbox" || f.type === "attachment";
        if (!own) continue;
        const server = f.value ?? (f.type === "checkbox" ? "false" : "");
        if (f.type === "attachment" ? v[f.id] !== server : !(f.id in v)) {
          if (next === v) next = { ...v };
          next[f.id] = server;
        }
      }
      return next;
    });
  }, [session.fields]);

  const docOrder = useMemo(() => new Map(session.documents.map((d) => [d.id, d.position])), [session.documents]);
  const ordered = useMemo(
    () =>
      [...session.fields].sort(
        (a, b) => (docOrder.get(a.documentId) ?? 0) - (docOrder.get(b.documentId) ?? 0) || a.page - b.page || a.y - b.y || a.x - b.x,
      ),
    [session.fields, docOrder],
  );

  const filled = useCallback(
    (f: Field): boolean => {
      if (f.type === "signature") return !!signature;
      if (f.type === "initials") return !!initials;
      if (VALUE_TYPES.includes(f.type) || f.type === "attachment") return (values[f.id] ?? "").trim().length > 0;
      if (f.type === "checkbox") return values[f.id] === "true";
      return true;
    },
    [signature, initials, values],
  );

  const interactive = ordered.filter((f) => !isAuto(f) && !f.formula && !logic.hidden.has(f.id));
  const required = interactive.filter((f) => f.required || f.type === "signature" || f.type === "initials");
  const done = required.filter(filled).length;
  const pending = required.filter((f) => !filled(f));
  // Números que la API rechazaría (no es número o fuera de rango): antes contaban como completos, el envío daba 422
  // y no se sabía cuál era.
  const badNumber = interactive.find((f) => {
    if (f.type !== "number" || f.readOnly) return false; // los de solo lectura no los valida la API
    const v = (values[f.id] ?? "").trim();
    if (!v) return false;
    const n = parseNumberLoose(v);
    return n === null || (f.min != null && n < f.min) || (f.max != null && n > f.max);
  });

  // Textos que no van a entrar en su espacio del PDF ni al tamaño mínimo legible (se estampan cortados con "…").
  const overflowing = useMemo(() => {
    const out = new Set<string>();
    for (const f of interactive) {
      if (!VALUE_TYPES.includes(f.type)) continue;
      const text = (values[f.id] ?? "").replace(/\s+/g, " ").trim();
      const page = session.documents.find((d) => d.id === f.documentId)?.pages[f.page];
      if (text && page && !stampFits(text, f.width * page.width, f.height * page.height)) out.add(f.id);
    }
    return out;
  }, [interactive, values, session.documents]);
  const firstOverflow = interactive.find((f) => overflowing.has(f.id));

  const goTo = (f: Field | undefined) => {
    if (!f) {
      document.getElementById("finish-btn")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const el = document.getElementById(`f-${f.id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(f.id);
    window.setTimeout(() => setFlash((x) => (x === f.id ? null : x)), 1600);
    if ((f.type === "signature" && !signature) || (f.type === "initials" && !initials)) {
      window.setTimeout(() => setPad(f.type as "signature" | "initials"), 450);
    } else if (VALUE_TYPES.includes(f.type) || f.type === "checkbox" || f.type === "attachment") {
      window.setTimeout(() => (el?.querySelector("input,select,button") as HTMLElement | null)?.focus({ preventScroll: true }), 450);
    }
  };

  useEffect(() => {
    if (!jumpTo) return;
    setJumpTo(null);
    const f = ordered.find((x) => x.id === jumpTo);
    if (!f) return;
    setInvalidId(f.id);
    goTo(f);
    // goTo se arma en cada render; basta con correr al llegar la sesión nueva.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTo, ordered]);

  const finish = async () => {
    // Con un adjunto todavía subiendo, se completaba sin él y la subida fallaba después (el firmante lo creía adjuntado).
    if (uploading) return;
    setServerProblems(new Set());
    if (pending.length) {
      const f = pending[0];
      setError(sx("missing.field", { label: f.label || t(`field.${f.type}`) }));
      setInvalidId(f.id);
      goTo(f);
      return;
    }
    if (badNumber) {
      const range = badNumber.min != null && badNumber.max != null ? sx("num.range", { min: badNumber.min, max: badNumber.max }) : "";
      setError(sx("num.invalid", { label: badNumber.label || "—", range }));
      setInvalidId(badNumber.id);
      goTo(badNumber);
      return;
    }
    setInvalidId(null);
    setBusy(true);
    setError(null);
    // También los propios que la lógica oculta: el servidor evalúa condiciones y fórmulas con los mismos valores que
    // la página (si no, con un campo oculto que aportaba a una fórmula el servidor exigía un campo que acá no se veía).
    // Los ocultos no se guardan (el servidor los deja vacíos).
    const sendable = ordered.filter((f) => !isAuto(f) && !f.formula);
    const body: CompleteSigningInput = {
      fields: sendable.map((f) => ({
        id: f.id,
        value:
          f.type === "signature"
            ? signature
              ? "signed"
              : ""
            : f.type === "initials"
              ? initials
                ? "signed"
                : ""
              : f.type === "checkbox"
                ? values[f.id] === "true"
                  ? "true"
                  : "false"
                : (values[f.id] ?? "").trim(),
      })),
    };
    const strip = (a: Adopted): SignatureImageInput => ({ kind: a.kind, imagePng: a.imagePng, text: a.text ?? null });
    if (signature) body.signature = strip(signature);
    if (initials) body.initials = strip(initials);
    try {
      const s = await api<SigningSession>(`${base}/complete`, { method: "POST", body });
      window.scrollTo({ top: 0 });
      onDone(s);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
      const problems = problemFields(e);
      if (problems.length || (e instanceof HttpError && e.status === 422 && (e.code === "fields_incomplete" || e.code === "fields_invalid"))) {
        // La página creía todo completo y el servidor no (un adjunto que no llegó, una condición distinta…): se recarga
        // la sesión conservando lo escrito y se va al primer campo que falta.
        setServerProblems(new Set(problems.map((p) => p.id)));
        void Promise.resolve(onStale()).then(() => {
          if (problems[0]) setJumpTo(problems[0].id);
        });
        return;
      }
      onTerminalError(e);
    }
  };

  /**
   * Errores terminales: la sesión venció (401), falta verificar la identidad (403 identity_required), el link ya no
   * existe (404), el sobre cambió de estado (409, 410). Antes solo se veía el texto; ahora se recarga la sesión y la
   * página pasa a la pantalla que corresponde (código, verificación, cierre).
   * Con 402 (pago previo pendiente) se vuelve a consultar el pago para mostrar el paso de pago; lo cargado se conserva.
   */
  const onTerminalError = (e: unknown) => {
    if (e instanceof HttpError && e.status === 402 && e.code === "payment_required") onPaymentRequired();
    else if (isStaleError(e)) void onStale();
  };

  const recipient = session.recipient;
  const initialsText = recipient.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase())
    .join("")
    .slice(0, 4);

  const autoValue = (f: Field) =>
    f.readOnly
      ? (f.value ?? "")
      : f.type === "name"
        ? recipient.name
        : f.type === "email"
          ? (recipient.email ?? "")
          : signingDateForDisplay(formatSigningDate(new Date(), recipient.locale));

  const uploadAttachment = async (f: Field, file: File) => {
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setError(t("sign.attachmentTooBig"));
      return;
    }
    setUploading(f.id);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await api<Field>(`${base}/fields/${f.id}/attachment`, { method: "POST", form });
      setValues((v) => ({ ...v, [f.id]: res.value ?? file.name }));
    } catch (e) {
      setError(errorText(e));
      onTerminalError(e);
    } finally {
      setUploading(null);
    }
  };

  const removeAttachment = async (f: Field) => {
    if (uploading) return;
    // Mientras se quita, "Finalizar" queda bloqueado como en la subida: si no, se completaba con el adjunto todavía
    // cargado (o el DELETE llegaba después de completar y fallaba).
    setUploading(f.id);
    setError(null);
    try {
      await api<Field>(`${base}/fields/${f.id}/attachment`, { method: "DELETE" });
      setValues((v) => ({ ...v, [f.id]: "" }));
    } catch (e) {
      setError(errorText(e));
      onTerminalError(e);
    } finally {
      setUploading(null);
    }
  };

  // Deja de marcarse apenas se completa (o se corrige el número), o si el error mostrado ya es otro.
  const invalidNow =
    error && invalidId && (pending.some((f) => f.id === invalidId) || badNumber?.id === invalidId || serverProblems.has(invalidId)) ? invalidId : null;
  const errProps = (f: Field) =>
    invalidNow === f.id ? { "aria-invalid": true as const, "aria-describedby": "sign-finish-error" } : {};

  const renderField = (f: Field, pageHeightPx: number) => {
    const hPx = f.height * pageHeightPx;
    const fontSize = Math.max(8, Math.min(hPx * 0.62, 28));
    const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
    const cls = `sfield sfield-${f.type} ${filled(f) ? "filled" : ""} ${flash === f.id ? "flash" : ""} ${f.required ? "req" : ""}`;
    if (f.formula) {
      return (
        <div key={f.id} id={`f-${f.id}`} className={`${cls} auto computed`} style={style} title={f.formula}>
          {/* El mismo texto que se estampa en el PDF sellado (formatComputed: punto decimal, sin separador de miles):
              con el formato local la vista previa mostraba "1.234,5" y el PDF "1234.5". */}
          <span style={{ fontSize }}>{logic.computed.get(f.id) ?? ""}</span>
        </div>
      );
    }
    if (f.type === "signature" || f.type === "initials") {
      const adopted = f.type === "signature" ? signature : initials;
      return (
        <button
          key={f.id}
          id={`f-${f.id}`}
          type="button"
          className={cls}
          style={style}
          onClick={() => setPad(f.type as "signature" | "initials")}
          aria-label={`${f.label ?? t(`field.${f.type}`)}: ${adopted ? x("a11y.signed") : x("a11y.notSigned")}`}
          {...errProps(f)}
        >
          {adopted ? (
            <img src={adopted.dataUrl} alt={t(`field.${f.type}`)} />
          ) : (
            <span style={{ fontSize: Math.max(9, Math.min(hPx * 0.38, 16)) }}>
              ✍ {f.type === "signature" ? t("sign.clickToSign") : t("field.initials")}
            </span>
          )}
        </button>
      );
    }
    if (f.readOnly) {
      return (
        <div key={f.id} className={`${cls} auto`} style={style} title={t("sign.readOnlyField")}>
          <span style={{ fontSize }}>{f.value}</span>
        </div>
      );
    }
    if (f.type === "dropdown") {
      return (
        <div key={f.id} id={`f-${f.id}`} className={cls} style={style}>
          <select
            value={values[f.id] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            aria-label={f.label ?? t("field.dropdown")}
            title={f.label ?? t("field.dropdown")}
            aria-required={f.required || undefined}
            {...errProps(f)}
            style={{ fontSize }}
          >
            <option value="">{f.label ?? t("sign.choose")}</option>
            {(f.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      );
    }
    if (f.type === "attachment") {
      const name = values[f.id];
      return (
        <div key={f.id} id={`f-${f.id}`} className={`${cls} sfield-attach`} style={style}>
          {name ? (
            <span className="attach-chip" style={{ fontSize: Math.max(9, Math.min(fontSize, 14)) }}>
              📎 <span className="attach-name">{name}</span>
              <button type="button" className="attach-x" aria-label={t("common.delete")} disabled={uploading !== null} onClick={() => removeAttachment(f)}>
                ×
              </button>
            </span>
          ) : (
            <label className="attach-pick" style={{ fontSize: Math.max(9, Math.min(fontSize, 14)) }}>
              {uploading === f.id ? t("sign.uploading") : `📎 ${f.label ?? t("sign.attachFile")}`}
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                aria-label={f.label ?? t("sign.attachFile")}
                aria-required={f.required || undefined}
                {...errProps(f)}
                disabled={uploading !== null}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadAttachment(f, file);
                }}
              />
            </label>
          )}
        </div>
      );
    }
    if (VALUE_TYPES.includes(f.type)) {
      const placeholder = f.label ?? t(`field.${f.type}`);
      return (
        <div key={f.id} id={`f-${f.id}`} className={cls} style={style}>
          <input
            value={values[f.id] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            placeholder={f.type === "number" && (f.min != null || f.max != null) ? `${placeholder} (${f.min ?? "…"}–${f.max ?? "…"})` : placeholder}
            aria-label={placeholder}
            title={placeholder}
            aria-required={f.required || undefined}
            {...errProps(f)}
            inputMode={f.type === "number" ? "decimal" : undefined}
            maxLength={2000}
            style={{ fontSize, ...(overflowing.has(f.id) ? { outline: "2px solid var(--warn, #d97706)", outlineOffset: -2 } : null) }}
          />
        </div>
      );
    }
    if (f.type === "checkbox") {
      return (
        <label key={f.id} id={`f-${f.id}`} className={cls} style={style} title={f.label ?? undefined}>
          <input
            type="checkbox"
            checked={values[f.id] === "true"}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.checked ? "true" : "false" }))}
            aria-label={f.label ?? t("field.checkbox")}
            aria-required={f.required || undefined}
            {...errProps(f)}
          />
        </label>
      );
    }
    return (
      <div key={f.id} className={`${cls} auto`} style={style} title={t("sign.autoField")}>
        <span style={{ fontSize }}>{autoValue(f)}</span>
      </div>
    );
  };

  return (
    <div className="signer">
      <header className="signer-bar sticky" style={brandBarStyle(session.branding)}>
        <div className="signer-org">
          <BrandOrg org={session.envelope.organizationName} branding={session.branding} />
        </div>
        {/* Sin campos obligatorios no hay progreso que mostrar (un progressbar con valuemax=0 es inválido). */}
        {required.length > 0 && (
          <div className="signer-progress" aria-live="polite">
            <div
              className="progress"
              role="progressbar"
              aria-label={x("a11y.progress")}
              aria-valuemin={0}
              aria-valuemax={required.length}
              aria-valuenow={done}
            >
              <div className="progress-bar" style={{ width: `${(done / required.length) * 100}%` }} />
            </div>
            <span className="small">{t("sign.progress", { done, total: required.length })}</span>
          </div>
        )}
        <div className="signer-actions">
          <LocaleSwitcher compact />
          <button type="button" className="btn btn-ghost btn-sm on-dark hide-xs" onClick={() => setDeclining(true)}>
            {t("sign.decline")}
          </button>
          {pending.length > 0 ? (
            <button type="button" className="btn btn-accent btn-sm" onClick={() => goTo(pending[0])}>
              {t("sign.nextField")} ↓
            </button>
          ) : (
            <button type="button" className="btn btn-accent btn-sm" disabled={busy || uploading !== null} onClick={finish}>
              {busy ? t("sign.finishing") : finishLabel}
            </button>
          )}
        </div>
      </header>

      <main className="signer-main">
        <EnvelopeIntro
          session={session}
          downloads={session.documents.map((d) => (
            <SignerDownload
              key={d.id}
              path={`${base}/documents/${d.id}/file?download=1`}
              name={d.name.replace(/\.pdf$/i, "")}
              label={session.documents.length > 1 ? `${sx("doc.download")}: ${d.name}` : sx("doc.download")}
              onAuth={() => api<SigningSession>(base).then(onDone, () => undefined)}
            />
          ))}
        />
        <AiSignerAssist base={base} />
        <ErrorBox error={error} />
        {session.documents.map((d) => {
          // En el orden de lectura (página, arriba→abajo, izq→der): el orden de tabulación sigue al del documento.
          const docFields = ordered.filter((f) => f.documentId === d.id);
          return (
            <DocumentView
              key={d.id}
              doc={d}
              url={`${base}/documents/${d.id}/file`}
              headingLevel={2}
              renderOverlay={(page, widthPx) => {
                const size = d.pages[page];
                const pageHeightPx = widthPx * (size.height / size.width);
                return docFields.filter((f) => f.page === page && !logic.hidden.has(f.id)).map((f) => renderField(f, pageHeightPx));
              }}
            />
          );
        })}

        <div className="finish-box card pad">
          {session.recipient.role === "approver" ? (
            <p className="small muted">{sx("approve.hint")}</p>
          ) : (
            <p className="small muted">{t("sign.progress", { done, total: required.length })}</p>
          )}
          {firstOverflow && (
            <p className="small" role="status">
              ⚠ {sx("stamp.overflow", { label: firstOverflow.label || t(`field.${firstOverflow.type}`) })}
            </p>
          )}
          {error && (
            <p id="sign-finish-error" className="small error-text">
              {error}
            </p>
          )}
          <button id="finish-btn" type="button" className="btn btn-primary btn-block" disabled={busy || uploading !== null} onClick={finish}>
            {busy ? t("sign.finishing") : finishLabel}
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setDeclining(true)}>
            {t("sign.decline")}
          </button>
          {/* Dentro del iframe o de la pestaña del integrador no se delega: el integrador no recibe evento y queda colgado
              (el servidor también lo rechaza). */}
          {session.canDelegate && !isEmbedded(tokenOfBase(base)) && !isTabReturn(tokenOfBase(base)) && (
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setDelegating(true)}>
              ↪ {sx("delegate.button")}
            </button>
          )}
        </div>
      </main>

      <BrandFooter />

      {pad && (
        <SignaturePad
          purpose={pad}
          defaultText={pad === "initials" ? initialsText : recipient.name}
          onClose={() => setPad(null)}
          onAdopt={(a) => {
            if (pad === "signature") setSignature(a);
            else setInitials(a);
            setPad(null);
            setError(null);
          }}
        />
      )}

      {delegating && <DelegateModal base={base} authMethod={session.recipient.authMethod} onClose={() => setDelegating(false)} onDone={(name) => onDelegated(name)} onStale={onStale} />}

      {declining && <DeclineModal base={base} onClose={() => setDeclining(false)} onDone={onDone} onStale={onStale} />}
    </div>
  );
}
