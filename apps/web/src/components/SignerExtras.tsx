// Componentes del bloque "firmante y evidencia": código OTP, delegación (firmante) y reasignación (remitente).
import { useEffect, useRef, useState } from "react";
import type { EnvelopeDetail, OtpSendResponse, Recipient, SigningSession } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useSignerText } from "../lib/i18n-signer";
import { ErrorBox, Modal } from "./ui";
import { useFocusOnMount } from "./ExperienceExtras";

/**
 * Error del firmante que indica que la sesión quedó desactualizada: venció (401), falta verificar la identidad
 * (403 identity_required), el link ya no existe (404) o el sobre cambió de estado (409, 410). Se vuelve a pedir la
 * sesión para mostrar la pantalla que corresponde (código, verificación, cierre) en lugar de solo el texto del error.
 */
export function isStaleError(e: unknown): boolean {
  if (!(e instanceof HttpError)) return false;
  return [401, 404, 409, 410].includes(e.status) || (e.status === 403 && e.code === "identity_required");
}

/** Códigos de 429 con los que el último código enviado puede seguir vigente: se muestra el campo para escribirlo. */
const OTP_LIMIT_CODES = ["otp_cooldown", "otp_too_many", "otp_daily_limit", "otp_destination_limit", "otp_tenant_limit"];

/** Pide y valida el código antes de mostrar los documentos. */
export function OtpGate({
  session,
  base,
  onDone,
  onStale,
}: {
  session: SigningSession;
  base: string;
  onDone: (s: SigningSession) => void;
  /** Vuelve a pedir la sesión ante un error terminal (sobre cerrado, link inexistente, código ya no exigido). */
  onStale?: () => unknown;
}) {
  const sx = useSignerText();
  const [sent, setSent] = useState<OtpSendResponse | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  // Al aparecer (también cuando reemplaza al flujo de firma que quedó oculto) el foco va al encabezado: si no, quedaba
  // en un elemento oculto del flujo y el lector de pantalla no anunciaba el pedido del código.
  const heading = useFocusOnMount<HTMLHeadingElement>();

  useEffect(() => {
    if (wait <= 0) return;
    const h = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(h);
  }, [wait]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<OtpSendResponse>(`${base}/otp/send`, { method: "POST" });
      setSent(r);
      setWait(r.resendInSeconds);
    } catch (e) {
      const d = e instanceof HttpError ? (e.details as { resendInSeconds?: number } | undefined) : undefined;
      if (d?.resendInSeconds) setWait(d.resendInSeconds);
      // Ya se mandó un código hace poco (p. ej. el celular recargó la página al volver de los mensajes): se muestra el
      // campo para escribirlo. Si no, quedaba solo el botón deshabilitado y había que pedir otro (que anula el anterior).
      if (e instanceof HttpError && OTP_LIMIT_CODES.includes(e.code ?? "") && !sent) {
        setSent({ sent: true, destination: session.otpDestination ?? "", resendInSeconds: d?.resendInSeconds ?? 0, expiresAt: "" } as OtpSendResponse);
      }
      setError(errorText(e));
      // otp_no_destination / otp_destination_suppressed son datos del destinatario (el remitente debe corregirlos), no
      // un cambio de la sesión: resincronizar solo borraba el error. Sí se resincroniza si la sesión venció, el link ya
      // no existe, el sobre se cerró o el código dejó de exigirse.
      if (e instanceof HttpError && ([401, 404, 410].includes(e.status) || e.code === "otp_not_required")) void onStale?.();
    } finally {
      setBusy(false);
    }
  };

  // Enter repetido (o el autocompletado del código + Enter) mientras se verifica mandaba otro intento con el mismo
  // código: gastaba intentos y, si el primero ya había pasado, mostraba "código incorrecto".
  const verifying = useRef(false);
  const verify = async () => {
    if (verifying.current) return;
    verifying.current = true;
    setBusy(true);
    setError(null);
    try {
      onDone(await api<SigningSession>(`${base}/otp/verify`, { method: "POST", body: { code } }));
    } catch (e) {
      verifying.current = false;
      setError(errorText(e));
      setBusy(false);
      if (isStaleError(e)) void onStale?.();
    }
  };

  const dest = sent?.destination ?? session.otpDestination ?? "";
  return (
    <div className="card pad stack consent">
      <div className="intro">
        <p className="muted small">
          <strong>{session.envelope.senderName}</strong> ({session.envelope.organizationName})
        </p>
        <h1>{session.envelope.subject}</h1>
      </div>
      <h2 ref={heading} tabIndex={-1}>
        🔒 {sx("otp.title")}
      </h2>
      <p className="muted" role="status" aria-live="polite">
        {sent ? sx("otp.sentTo", { dest }) : sx("otp.text", { dest })}
      </p>
      <ErrorBox error={error} />
      {sent ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === 6) verify();
          }}
        >
          <label className="field">
            <span>{sx("otp.code")}</span>
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              style={{ fontSize: 24, letterSpacing: "0.4em", textAlign: "center" }}
            />
          </label>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
            {busy ? sx("otp.verifying") : sx("otp.verify")}
          </button>
          <button type="button" className="btn btn-ghost btn-block" disabled={busy || wait > 0} onClick={send}>
            {wait > 0 ? sx("otp.resendIn", { s: wait }) : sx("otp.resend")}
          </button>
        </form>
      ) : (
        <button type="button" className="btn btn-primary btn-block" disabled={busy || wait > 0} onClick={send}>
          {wait > 0 ? sx("otp.resendIn", { s: wait }) : sx("otp.send")}
        </button>
      )}
    </div>
  );
}

/** Teléfono como lo exige la API (E.164, regex de Contact en @calasign/shared): "+" código de país y 7 a 15 dígitos. */
export const PHONE_RE = /^\+[1-9]\d{6,14}$/;

/** Deja solo dígitos y un "+" inicial (quita espacios, guiones, puntos y paréntesis que se pegan con el número). */
export const normalizePhone = (v: string) => {
  const digits = v.replace(/\D/g, "");
  return v.trim().startsWith("+") ? `+${digits}` : digits;
};

/** El firmante delega en otra persona. */
export function DelegateModal({
  base,
  onClose,
  onDone,
  onStale,
}: {
  base: string;
  onClose: () => void;
  onDone: (name: string) => void;
  /** Vuelve a pedir la sesión ante un error terminal (sesión vencida, sobre cerrado…). */
  onStale?: () => unknown;
}) {
  const sx = useSignerText();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  // El firmante debe firmar con un certificado que corresponda a su documento: la API pide el documento de la persona
  // nueva (409 delegation_requires_id_match) y recién ahí se muestra el campo.
  const [needsIdDoc, setNeedsIdDoc] = useState(false);
  const [idDoc, setIdDoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = name.trim() && email.trim() && reason.trim() && (!needsIdDoc || idDoc.trim());

  const submit = async () => {
    // Sin "+código de país" la API respondía un error genérico de validación.
    if (phone && !PHONE_RE.test(phone)) {
      setError(sx("delegate.phoneInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ delegated: boolean; to: string }>(`${base}/delegate`, {
        method: "POST",
        body: { name: name.trim(), email: email.trim(), phone: phone.trim() || null, reason: reason.trim(), idDocumentNumber: idDoc.trim() || null },
      });
      onDone(r.to);
    } catch (e) {
      setBusy(false);
      if (e instanceof HttpError && e.status === 409 && e.code === "delegation_requires_id_match") {
        setNeedsIdDoc(true);
        setError(sx("delegate.idDocRequired"));
        return;
      }
      setError(errorText(e));
      // Solo cierran el formulario los errores de sesión (vencida, link inexistente, sobre cerrado) y el 409
      // not_replaceable (el firmante ya no puede delegar). Los demás 409 (otp_destination_required, invalid_channels,
      // too_many_replacements, same_person) son datos a corregir: el modal sigue abierto con el error.
      if (e instanceof HttpError && ([401, 404, 410].includes(e.status) || (e.status === 409 && e.code === "not_replaceable"))) {
        // La pantalla que corresponde (código, cierre) reemplaza al formulario: el modal se cierra.
        onClose();
        void onStale?.();
      }
    }
  };

  return (
    <Modal
      title={sx("delegate.title")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !valid} onClick={submit}>
            {sx("delegate.confirm")}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">{sx("delegate.text")}</p>
        <ErrorBox error={error} />
        <label className="field">
          <span>{sx("delegate.name")}</span>
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>{sx("delegate.email")}</span>
          <input type="email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{sx("delegate.phone")}</span>
          <input type="tel" value={phone} placeholder="+5730012345678" onChange={(e) => setPhone(normalizePhone(e.target.value))} />
        </label>
        <label className="field">
          <span>{sx("delegate.reason")}</span>
          <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {needsIdDoc && (
          <label className="field">
            <span>{sx("delegate.idDoc")}</span>
            <input value={idDoc} maxLength={50} onChange={(e) => setIdDoc(e.target.value)} autoFocus />
          </label>
        )}
      </div>
    </Modal>
  );
}

/** El remitente reasigna un destinatario pendiente. */
export function ReassignModal({
  envelopeId,
  recipient,
  onClose,
  onDone,
}: {
  envelopeId: string;
  recipient: Recipient;
  onClose: () => void;
  onDone: (d: EnvelopeDetail) => void;
}) {
  const sx = useSignerText();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (phone && !PHONE_RE.test(phone)) {
      setError(sx("delegate.phoneInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const channels = [...(email.trim() ? ["email"] : []), ...(phone.trim() ? ["whatsapp"] : [])];
      onDone(
        await api<EnvelopeDetail>(`/v1/envelopes/${envelopeId}/recipients/${recipient.id}/reassign`, {
          method: "POST",
          body: { name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, channels, reason: reason.trim() || null },
        }),
      );
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={sx("reassign.title")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || !(email.trim() || phone.trim())} onClick={submit}>
            {sx("reassign.confirm")}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">{sx("reassign.text", { name: recipient.name })}</p>
        <ErrorBox error={error} />
        <label className="field">
          <span>{sx("delegate.name")}</span>
          <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>{sx("delegate.email")}</span>
          <input type="email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>{sx("delegate.phone")}</span>
          <input type="tel" value={phone} placeholder="+5730012345678" onChange={(e) => setPhone(normalizePhone(e.target.value))} />
        </label>
        <label className="field">
          <span>{sx("reassign.reason")}</span>
          <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
