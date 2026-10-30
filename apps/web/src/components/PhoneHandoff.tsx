// «Dibujar en el celular» dentro del diálogo de la firma: pide un pase (link /h/<token> de un solo uso, 10 minutos),
// lo muestra para copiarlo o lo manda por SMS, WhatsApp o Telegram, y consulta el pase hasta que llega la firma del
// celular. La firma la adopta el firmante acá (onReceived): el celular nunca completa la firma.
import { useCallback, useEffect, useRef, useState } from "react";
import { SIGNATURE_HANDOFF_TTL_MINUTES, type HandoffChannel, type SignatureHandoff, type SignatureHandoffStatus } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useSignatureText } from "../lib/i18n-signature";

/** Cada cuánto consulta la computadora si llegó la firma (el pase dura 10 minutos: ~300 consultas como mucho). */
const POLL_MS = 2000;
const E164 = /^\+[1-9]\d{6,14}$/;

interface Props {
  /** /v1/signing/<token> del firmante. */
  base: string;
  purpose: "signature" | "initials";
  onReceived: (r: { handoffId: string; imagePng: string }) => void;
  onBack: () => void;
}

export function PhoneHandoff({ base, purpose, onReceived, onBack }: Props) {
  const gx = useSignatureText();
  const [handoff, setHandoff] = useState<SignatureHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  const [channel, setChannel] = useState<HandoffChannel | "">("");
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  /** Generación del pase vigente: una respuesta de un pase anterior (o de un panel cerrado) no pisa al actual. */
  const gen = useRef(0);
  const received = useRef(onReceived);
  received.current = onReceived;

  const create = useCallback(async () => {
    const my = ++gen.current;
    setHandoff(null);
    setError(null);
    setExpired(false);
    setCopied(null);
    setSendError(null);
    try {
      const h = await api<SignatureHandoff>(`${base}/signature-handoffs`, { method: "POST", body: { purpose } });
      if (my !== gen.current) return;
      setHandoff(h);
      setChannel((c) => (c && h.channels.includes(c) ? c : (h.channels[0] ?? "")));
    } catch (e) {
      if (my === gen.current) setError(errorText(e));
    }
  }, [base, purpose]);

  useEffect(() => {
    void create();
    // Al cerrar el panel, ninguna respuesta pendiente (crear, consultar, mandar) toca el estado.
    const g = gen;
    return () => {
      g.current++;
    };
  }, [create]);

  // Espera la firma del celular: consulta el pase cada 2 s hasta que llega o vence.
  useEffect(() => {
    if (!handoff || expired) return;
    const my = gen.current;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const st = await api<SignatureHandoffStatus>(`${base}/signature-handoffs/${handoff.id}`);
        if (my !== gen.current) return;
        if (st.status === "submitted" && st.imagePng) return received.current({ handoffId: st.id, imagePng: st.imagePng });
        if (st.status === "expired") return setExpired(true);
      } catch (e) {
        if (my !== gen.current) return;
        // Sesión del firmante vencida o sobre cerrado: se dice y se deja de consultar. Una caída de la red, se reintenta.
        if (e instanceof HttpError && [401, 403, 404, 409, 410].includes(e.status)) return setError(errorText(e));
      }
      timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [base, handoff, expired]);

  const copy = async () => {
    if (!handoff) return;
    try {
      await navigator.clipboard.writeText(handoff.url);
      setCopied("ok");
    } catch {
      // Sin permiso de portapapeles (http, iframe): queda seleccionado para copiarlo a mano.
      linkRef.current?.select();
      setCopied("failed");
    }
  };

  const phoneNeeded = channel === "sms" || channel === "whatsapp";
  const phoneOk = !phoneNeeded || E164.test(phone.replace(/[\s().-]/g, ""));

  const send = async () => {
    if (!handoff || !channel || !phoneOk) return;
    const my = gen.current;
    setSending(true);
    setSendError(null);
    try {
      const h = await api<SignatureHandoff>(`${base}/signature-handoffs/${handoff.id}/send`, {
        method: "POST",
        body: { channel, phone: phoneNeeded ? phone.replace(/[\s().-]/g, "") : null },
      });
      if (my === gen.current) setHandoff(h);
    } catch (e) {
      if (my === gen.current) setSendError(errorText(e));
    } finally {
      if (my === gen.current) setSending(false);
    }
  };

  return (
    <section className="phone-handoff" aria-labelledby="phone-handoff-title">
      <h3 id="phone-handoff-title">{gx("phone.title")}</h3>
      <p className="muted small">{gx("phone.text")}</p>
      {error ? (
        <p className="error-text small" role="alert">
          {error}
        </p>
      ) : !handoff ? (
        <p className="muted small" role="status">
          {gx("phone.creating")}
        </p>
      ) : expired ? (
        <p className="warn-text small" role="status">
          {gx("phone.expired")}
        </p>
      ) : (
        <>
          <div className="phone-handoff-link">
            <label className="field">
              <span>{gx("phone.link")}</span>
              <input ref={linkRef} value={handoff.url} readOnly onFocus={(e) => e.currentTarget.select()} />
            </label>
            <button type="button" className="btn btn-sm" onClick={copy}>
              {gx("phone.copy")}
            </button>
          </div>
          {copied && (
            <p className="small muted" role="status">
              {copied === "ok" ? gx("phone.copied") : gx("phone.copyFailed")}
            </p>
          )}
          {!handoff.channels.includes("telegram") && (
            <p className="small">
              <a href={`https://t.me/share/url?url=${encodeURIComponent(handoff.url)}`} target="_blank" rel="noopener noreferrer">
                {gx("phone.shareTelegram")}
              </a>
            </p>
          )}
          {handoff.channels.length > 0 && (
            <fieldset className="phone-handoff-send">
              <legend>{gx("phone.sendTitle")}</legend>
              <label className="field">
                <span>{gx("phone.channel")}</span>
                <select value={channel} onChange={(e) => setChannel(e.target.value as HandoffChannel)}>
                  {handoff.channels.map((c) => (
                    <option key={c} value={c}>
                      {gx(`phone.channel.${c}`)}
                    </option>
                  ))}
                </select>
              </label>
              {phoneNeeded && (
                <label className="field">
                  <span>{gx("phone.number")}</span>
                  <input
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+5491122334455"
                    aria-invalid={phone.length > 0 && !phoneOk}
                  />
                </label>
              )}
              {phone.length > 0 && !phoneOk && <p className="small warn-text">{gx("phone.numberInvalid")}</p>}
              <button type="button" className="btn btn-sm" disabled={sending || !channel || !phoneOk || (phoneNeeded && !phone)} onClick={send}>
                {sending ? gx("phone.sending") : gx("phone.send")}
              </button>
              {sendError && (
                <p className="error-text small" role="alert">
                  {sendError}
                </p>
              )}
              {handoff.sent && !sendError && (
                <p className="small muted" role="status">
                  {gx("phone.sent", { dest: handoff.sent.destination })}
                </p>
              )}
            </fieldset>
          )}
          <p className="small muted" role="status" aria-live="polite">
            {gx("phone.waiting", { min: SIGNATURE_HANDOFF_TTL_MINUTES })}
          </p>
        </>
      )}
      <div className="sigpad-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          {gx("phone.back")}
        </button>
        {(expired || error) && (
          <button type="button" className="btn btn-sm" onClick={() => void create()}>
            {gx("phone.retry")}
          </button>
        )}
      </div>
    </section>
  );
}
