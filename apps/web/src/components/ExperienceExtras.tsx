// Piezas de la página del firmante para la firma en persona y el pedido de copias.
import { useEffect, useRef, useState } from "react";
import type { SigningSession } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useExpText } from "../lib/i18n-experience";
import { ErrorBox } from "./ui";

/** Lleva el foco a un encabezado cuando cambia la pantalla (lectores de pantalla y teclado). */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

/** El link se abrió fuera del dispositivo del anfitrión. */
export function InPersonBlocked({ session }: { session: SigningSession }) {
  const x = useExpText();
  const h = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div className="final card">
      <div className="final-icon" aria-hidden="true">
        🤝
      </div>
      <h1 ref={h} tabIndex={-1}>
        {x("inperson.blockedTitle")}
      </h1>
      <p className="muted">{x("inperson.blockedText", { host: session.inPerson?.hostName ?? "" })}</p>
    </div>
  );
}

/** Pantalla de entrega del dispositivo: el firmante confirma su identidad. */
export function InPersonHandover({ session, base, onDone }: { session: SigningSession; base: string; onDone: () => void }) {
  const x = useExpText();
  const h = useFocusOnMount<HTMLHeadingElement>();
  const [checked, setChecked] = useState(false);
  const [idNumber, setIdNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = session.recipient.name;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/in-person/confirm`, { method: "POST", body: { confirmed: true, idDocumentNumber: idNumber.trim() || null } });
      onDone();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="card pad stack inperson-handover">
      <div className="final-icon" aria-hidden="true">
        🤝
      </div>
      <h1 ref={h} tabIndex={-1}>
        {x("inperson.handoverTitle", { name })}
      </h1>
      <p className="muted">{x("inperson.handoverText", { host: session.inPerson?.hostName ?? "" })}</p>
      <p>
        <strong>{session.envelope.subject}</strong>
      </p>
      <label className="check consent-check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>{x("inperson.confirmCheck", { name })}</span>
      </label>
      <label className="field">
        <span>{x("inperson.idNumber")}</span>
        <input value={idNumber} maxLength={50} autoComplete="off" onChange={(e) => setIdNumber(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <button type="button" className="btn btn-primary btn-block" disabled={!checked || busy} onClick={confirm}>
        {x("inperson.continue")}
      </button>
    </div>
  );
}

/** Después de firmar en persona: se cierra la sesión del firmante y el dispositivo vuelve al anfitrión. */
export function InPersonDone({ session, base }: { session: SigningSession; base: string }) {
  const x = useExpText();
  const h = useFocusOnMount<HTMLHeadingElement>();
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    api(`${base}/in-person/end`, { method: "POST" })
      .catch(() => undefined)
      .finally(() => setEnded(true));
  }, [base]);
  return (
    <div className="final card">
      <div className="final-icon ok" aria-hidden="true">
        ✓
      </div>
      <h1 ref={h} tabIndex={-1}>
        {x("inperson.doneTitle", { name: session.recipient.name })}
      </h1>
      <p className="muted">{x("inperson.doneText", { host: session.inPerson?.hostName ?? "" })}</p>
      <div className="final-actions">
        {ended ? (
          <a className="btn btn-primary" href={`/app/envelopes/${session.envelope.id}`}>
            {x("inperson.backToEnvelope")}
          </a>
        ) : (
          <span className="muted small" role="status">
            {x("inperson.ending")}
          </span>
        )}
      </div>
    </div>
  );
}

/** El firmante pide que le vuelvan a mandar el documento final. */
export function RequestCopyButton({ base }: { base: string }) {
  const x = useExpText();
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    setState("busy");
    setError(null);
    try {
      await api(`${base}/request-copy`, { method: "POST" });
      setState("done");
    } catch (e) {
      setError(errorText(e));
      setState("idle");
    }
  };
  if (state === "done")
    return (
      <p className="small" role="status">
        ✓ {x("copy.requested")}
      </p>
    );
  return (
    <>
      <button type="button" className="btn btn-ghost" disabled={state === "busy"} onClick={request}>
        ✉ {x("copy.request")}
      </button>
      <ErrorBox error={error} />
    </>
  );
}
