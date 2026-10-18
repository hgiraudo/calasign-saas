// Experiencia del firmante: /s/:token. Sin cuenta, mobile-first.
import { formatComputedLocal, useFieldLogic } from "../lib/logic";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import type { CompleteSigningInput, Field, SignatureImageInput, SigningSession } from "@calasign/shared";
import { AUTO_FIELD_TYPES, ATTACHMENT_MAX_BYTES } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { formatDate, formatDateTime, useI18n } from "../lib/i18n";
import { DocumentView } from "../components/DocumentView";
import { SignaturePad } from "../components/SignaturePad";
import { ErrorBox, LocaleSwitcher, Logo, Modal, Spinner } from "../components/ui";
import { useEmbedBridge } from "../lib/embed";
import { DelegateModal, OtpGate } from "../components/SignerExtras";
import { useSignerText } from "../lib/i18n-signer";
import { InPersonBlocked, InPersonDone, InPersonHandover, RequestCopyButton, useFocusOnMount } from "../components/ExperienceExtras";
import { useExpText } from "../lib/i18n-experience";
import { IdentityGate } from "../components/IdentityGate";
import { PaymentGate, SignerPaymentAfterSign } from "../components/BillingExtras";

type Adopted = SignatureImageInput & { dataUrl: string };

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
  const reload = useCallback(() => {
    api<SigningSession>(base)
      .then(apply)
      .catch((e) => setError(errorText(e)));
  }, [base, apply]);

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
  if (session.otpRequired && session.inPerson)
    return (
      <SignerShell org={session.envelope.organizationName} branding={session.branding}>
        <InPersonBlocked session={session} />
      </SignerShell>
    );
  if (session.otpRequired)
    return (
      <SignerShell org={session.envelope.organizationName}>
        <OtpGate session={session} base={base} onDone={apply} />
      </SignerShell>
    );

  const { envelope, recipient } = session;
  const download = session.signedAvailable ? (
    <>
      <a className="btn btn-primary" href={`${base}/signed.pdf`}>
        ⬇ {t("sign.downloadSigned")}
      </a>
      <RequestCopyButton base={base} />
    </>
  ) : null;

  let content: ReactNode;
  if (session.inPerson?.active && recipient.status === "signed") {
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
          text={session.signedAvailable ? t("sign.doneAvailable") : recipient.role === "approver" ? sx("approve.doneText") : t("sign.doneText")}
        >
          {download}
          <SignerPaymentAfterSign base={base} onPaid={reload} />
        </Final>
      );
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
    content = <InPersonHandover session={session} base={base} onDone={reload} />;
  } else if (session.identity?.required && session.identity.status !== "verified") {
    content = <IdentityGate session={session} base={base} onDone={apply} />;
  } else if (!recipient.consented) {
    content = <Consent session={session} base={base} onDone={apply} />;
  } else {
    return (
      <PaymentGate
        base={base}
        wrap={(n) => (
          <SignerShell org={envelope.organizationName} branding={session.branding}>
            {n}
          </SignerShell>
        )}
      >
        <SigningFlow session={session} base={base} onDone={apply} onDelegated={setDelegatedTo} />
      </PaymentGate>
    );
  }

  return (
    <SignerShell org={envelope.organizationName} branding={session.branding}>
      {content}
    </SignerShell>
  );
}

type SessionBranding = SigningSession["branding"];

/** Estilo de la barra superior según el branding de la organización remitente. */
function brandBarStyle(b: SessionBranding) {
  return b?.primaryColor ? { background: b.primaryColor } : undefined;
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
      <footer className="signer-foot muted small">
        <Logo /> · {t("sign.poweredBy")}
      </footer>
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
      <p className="muted">{text}</p>
      {children && <div className="final-actions">{children}</div>}
    </div>
  );
}

function EnvelopeIntro({ session }: { session: SigningSession }) {
  const { t, locale } = useI18n();
  const e = session.envelope;
  return (
    <div className="intro">
      <p className="muted small">
        <strong>{e.senderName}</strong> ({e.organizationName}) {t("sign.sentBy")}
      </p>
      <h1>{e.subject}</h1>
      {e.message && <p className="message-box">{e.message}</p>}
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

function Consent({ session, base, onDone }: { session: SigningSession; base: string; onDone: (s: SigningSession) => void }) {
  const { t } = useI18n();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api<SigningSession>(`${base}/consent`, { method: "POST" }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
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
        <DocumentView key={d.id} doc={d} url={`${base}/documents/${d.id}/file`} />
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

function SigningFlow({
  session,
  base,
  onDone,
  onDelegated,
}: {
  session: SigningSession;
  base: string;
  onDone: (s: SigningSession) => void;
  onDelegated: (name: string) => void;
}) {
  const { t, locale } = useI18n();
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
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const logic = useFieldLogic(session, values);

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
    } else if (VALUE_TYPES.includes(f.type)) {
      window.setTimeout(() => (el?.querySelector("input,select") as HTMLInputElement | null)?.focus({ preventScroll: true }), 450);
    }
  };

  const finish = async () => {
    if (pending.length) {
      setError(t("sign.missing"));
      goTo(pending[0]);
      return;
    }
    setBusy(true);
    setError(null);
    const body: CompleteSigningInput = {
      fields: interactive.map((f) => ({
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
    }
  };

  const decline = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api<SigningSession>(`${base}/decline`, { method: "POST", body: { reason } });
      setDeclining(false);
      onDone(s);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
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
          : formatDate(new Date().toISOString(), locale);

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
    } finally {
      setUploading(null);
    }
  };

  const removeAttachment = async (f: Field) => {
    setError(null);
    try {
      await api<Field>(`${base}/fields/${f.id}/attachment`, { method: "DELETE" });
      setValues((v) => ({ ...v, [f.id]: "" }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const renderField = (f: Field, pageHeightPx: number) => {
    const hPx = f.height * pageHeightPx;
    const fontSize = Math.max(8, Math.min(hPx * 0.62, 28));
    const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.width * 100}%`, height: `${f.height * 100}%` };
    const cls = `sfield sfield-${f.type} ${filled(f) ? "filled" : ""} ${flash === f.id ? "flash" : ""} ${f.required ? "req" : ""}`;
    if (f.formula) {
      return (
        <div key={f.id} id={`f-${f.id}`} className={`${cls} auto computed`} style={style} title={f.formula}>
          <span style={{ fontSize }}>{formatComputedLocal(logic.computed.get(f.id), locale)}</span>
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
            aria-required={f.required || undefined}
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
              <button type="button" className="attach-x" aria-label={t("common.delete")} onClick={() => removeAttachment(f)}>
                ×
              </button>
            </span>
          ) : (
            <label className="attach-pick" style={{ fontSize: Math.max(9, Math.min(fontSize, 14)) }}>
              {uploading === f.id ? t("sign.uploading") : `📎 ${f.label ?? t("sign.attachFile")}`}
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
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
            aria-required={f.required || undefined}
            inputMode={f.type === "number" ? "decimal" : undefined}
            maxLength={2000}
            style={{ fontSize }}
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
        <div className="signer-progress" aria-live="polite">
          <div
            className="progress"
            role="progressbar"
            aria-label={x("a11y.progress")}
            aria-valuemin={0}
            aria-valuemax={required.length}
            aria-valuenow={done}
          >
            <div className="progress-bar" style={{ width: `${required.length ? (done / required.length) * 100 : 100}%` }} />
          </div>
          <span className="small">{t("sign.progress", { done, total: required.length })}</span>
        </div>
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
            <button type="button" className="btn btn-accent btn-sm" disabled={busy} onClick={finish}>
              {busy ? t("sign.finishing") : finishLabel}
            </button>
          )}
        </div>
      </header>

      <main className="signer-main">
        <EnvelopeIntro session={session} />
        <ErrorBox error={error} />
        {session.documents.map((d) => {
          const docFields = session.fields.filter((f) => f.documentId === d.id);
          return (
            <DocumentView
              key={d.id}
              doc={d}
              url={`${base}/documents/${d.id}/file`}
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
          {error && <p className="small error-text">{error}</p>}
          <button id="finish-btn" type="button" className="btn btn-primary btn-block" disabled={busy} onClick={finish}>
            {busy ? t("sign.finishing") : finishLabel}
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => setDeclining(true)}>
            {t("sign.decline")}
          </button>
          {session.canDelegate && (
            <button type="button" className="btn btn-ghost btn-block" onClick={() => setDelegating(true)}>
              ↪ {sx("delegate.button")}
            </button>
          )}
        </div>
      </main>

      <footer className="signer-foot muted small">
        <Logo /> · {t("sign.poweredBy")}
      </footer>

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

      {delegating && <DelegateModal base={base} onClose={() => setDelegating(false)} onDone={(name) => onDelegated(name)} />}

      {declining && (
        <Modal
          title={t("sign.declineTitle")}
          onClose={() => setDeclining(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setDeclining(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()} onClick={decline}>
                {t("sign.declineConfirm")}
              </button>
            </>
          }
        >
          <label className="field">
            <span>{t("sign.declineReason")}</span>
            <textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
        </Modal>
      )}
    </div>
  );
}
