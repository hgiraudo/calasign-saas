// Verificación de identidad del firmante (KYC), después del código (OTP) y antes de ver los documentos.
// Flujo integrado: fotos con la cámara (getUserMedia) o subidas desde el dispositivo. Flujo "redirect": página del proveedor.
import { useCallback, useEffect, useRef, useState } from "react";
import type { IdentityStartResponse, IdvCaptureKind, SigningIdentity, SigningSession } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useIdnText, type IdnKey } from "../lib/i18n-identity";
import { ErrorBox, Spinner } from "./ui";
import { isEmbedded, tokenOfBase } from "../lib/embed";

const PROVIDER_NAMES: Record<string, string> = { mock: "CalaSign", truora: "Truora", veriff: "Veriff" };
const REASONS = ["name_mismatch", "document_number_mismatch", "document_unreadable", "face_mismatch", "liveness_failed", "document_front_back_identical"];

export function IdentityGate({ session, base, onDone }: { session: SigningSession; base: string; onDone: (s: SigningSession) => void }) {
  const tx = useIdnText();
  const [idn, setIdn] = useState<SigningIdentity>(session.identity!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const org = session.envelope.organizationName;
  const provider = PROVIDER_NAMES[idn.provider] ?? idn.provider;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => heading.current?.focus(), []);

  const refreshSession = useCallback(async () => onDone(await api<SigningSession>(base)), [base, onDone]);

  const handle = useCallback(
    async (next: SigningIdentity | null) => {
      if (!next) return;
      setIdn(next);
      if (next.status === "verified") await refreshSession();
    },
    [refreshSession],
  );

  const call = async (path: string, method: "GET" | "POST" = "POST") => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<IdentityStartResponse>(`${base}/identity${path}`, { method });
      await handle(r.identity);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Flujos con página del proveedor: se consulta el resultado mientras está en curso.
  const polling = idn.mode === "redirect" && idn.status === "in_progress";
  useEffect(() => {
    if (!polling) return;
    const h = window.setInterval(() => {
      api<IdentityStartResponse>(`${base}/identity`)
        .then((r) => handle(r.identity))
        .catch(() => {});
    }, 4000);
    return () => window.clearInterval(h);
  }, [polling, base, handle]);

  const reasonText = idn.failureReason
    ? REASONS.includes(idn.failureReason)
      ? tx(`idv.reason.${idn.failureReason}` as IdnKey)
      : tx("idv.reason.generic")
    : null;

  const decline = async () => {
    setBusy(true);
    try {
      onDone(await api<SigningSession>(`${base}/decline`, { method: "POST", body: { reason: reason.trim() || tx("idv.failedTitle") } }));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const active = idn.verificationId !== null && (idn.status === "in_progress" || idn.capturedKinds.length > 0);
  const exhausted = idn.status === "failed" && idn.attemptsLeft === 0;

  return (
    <div className="card pad stack idv">
      <div className="intro">
        <p className="muted small">
          <strong>{session.envelope.senderName}</strong> ({org})
        </p>
        <h1>{session.envelope.subject}</h1>
      </div>
      <h2 ref={heading} tabIndex={-1}>
        🪪 {exhausted ? tx("idv.failedTitle") : tx("idv.title")}
      </h2>
      {reasonText && (
        <div className="idv-reason" role="alert">
          {reasonText}
        </div>
      )}
      <ErrorBox error={error} />

      {exhausted ? (
        <>
          <p className="muted">{tx("idv.failedFinal", { org })}</p>
          {declining ? (
            <div className="stack">
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={tx("idv.decline")} />
              <button type="button" className="btn btn-danger" disabled={busy} onClick={decline}>
                {tx("idv.decline")}
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setDeclining(true)}>
              {tx("idv.decline")}
            </button>
          )}
        </>
      ) : !active ? (
        <>
          <p>{tx("idv.intro", { org })}</p>
          <p className="idv-level">{tx(`idv.level.${idn.level}` as IdnKey)}</p>
          {idn.failureReason && idn.attemptsLeft > 0 && <p className="muted small">{tx("idv.attemptsLeft", { n: idn.attemptsLeft })}</p>}
          <p className="muted small">{tx("idv.privacy", { org })}</p>
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => call("/start")}>
            {idn.failureReason ? tx("idv.retry") : tx("idv.start")}
          </button>
        </>
      ) : idn.mode === "redirect" ? (
        <>
          <h3>{tx("idv.redirectTitle", { provider })}</h3>
          <p className="muted">{tx("idv.redirectText", { provider })}</p>
          {idn.redirectUrl && (
            // Embebido, el proveedor se abre en otra pestaña (muchos no cargan en un iframe y la vuelta perdía el modo
            // embebido); esta página sigue consultando el resultado.
            <a className="btn btn-primary btn-block" href={idn.redirectUrl} rel="noopener" target={isEmbedded(tokenOfBase(base)) ? "_blank" : undefined}>
              {tx("idv.redirectGo", { provider })}
            </a>
          )}
          <p className="muted small" aria-live="polite">
            <Spinner /> {tx("idv.waiting")}
          </p>
        </>
      ) : (
        <BuiltinCapture idn={idn} base={base} busy={busy} onIdentity={handle} onError={setError} onSubmit={() => call("/submit")} />
      )}
    </div>
  );
}

function BuiltinCapture({
  idn,
  base,
  busy,
  onIdentity,
  onError,
  onSubmit,
}: {
  idn: SigningIdentity;
  base: string;
  busy: boolean;
  onIdentity: (i: SigningIdentity) => Promise<void>;
  onError: (e: string | null) => void;
  onSubmit: () => void;
}) {
  const tx = useIdnText();
  const [previews, setPreviews] = useState<Partial<Record<IdvCaptureKind, string>>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  // Al salir de la captura se liberan las vistas previas (no quedan las fotos del documento en memoria).
  useEffect(() => () => Object.values(previewsRef.current).forEach((u) => u && URL.revokeObjectURL(u)), []);
  const [uploading, setUploading] = useState<IdvCaptureKind | null>(null);
  const next = idn.requiredCaptures.find((k) => !idn.capturedKinds.includes(k)) ?? null;
  const [current, setCurrent] = useState<IdvCaptureKind | null>(next);
  useEffect(() => setCurrent(next), [next]);

  const upload = async (kind: IdvCaptureKind, blob: Blob) => {
    setUploading(kind);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("file", blob, `${kind}.jpg`);
      const r = await api<IdentityStartResponse>(`${base}/identity/captures/${kind}`, { method: "POST", form: fd });
      setPreviews((p) => {
        // Las fotos del documento son datos sensibles: se libera la vista previa anterior de ese paso.
        if (p[kind]) URL.revokeObjectURL(p[kind]!);
        return { ...p, [kind]: URL.createObjectURL(blob) };
      });
      await onIdentity(r.identity);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setUploading(null);
    }
  };

  const all = idn.requiredCaptures.every((k) => idn.capturedKinds.includes(k));
  return (
    <div className="stack">
      <ol className="idv-steps">
        {idn.requiredCaptures.map((k) => {
          const done = idn.capturedKinds.includes(k);
          return (
            <li key={k} className={`${done ? "done" : ""} ${current === k ? "current" : ""}`}>
              <button type="button" className="idv-step" onClick={() => setCurrent(k)} aria-current={current === k ? "step" : undefined}>
                <span className="idv-step-mark" aria-hidden="true">
                  {done ? "✓" : "•"}
                </span>
                <span>{tx(`idv.step.${k}` as IdnKey)}</span>
                {done && <span className="sr-only"> {tx("idv.stepDone")}</span>}
                {done && previews[k] && <img src={previews[k]} alt="" className="idv-thumb" />}
              </button>
            </li>
          );
        })}
      </ol>
      {current && (
        <CaptureCard key={current} kind={current} busy={uploading === current} onCapture={(b) => upload(current, b)} />
      )}
      {all && (
        <button type="button" className="btn btn-primary btn-block" disabled={busy || uploading !== null} onClick={onSubmit}>
          {busy ? tx("idv.checking") : tx("idv.submit")}
        </button>
      )}
    </div>
  );
}

function CaptureCard({ kind, busy, onCapture }: { kind: IdvCaptureKind; busy: boolean; onCapture: (b: Blob) => void }) {
  const tx = useIdnText();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [camera, setCamera] = useState<"off" | "starting" | "on" | "error">("off");
  const face = kind === "selfie" || kind === "selfie_liveness";

  const mounted = useRef(true);
  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => {
    // En StrictMode (desarrollo) el efecto se monta, se limpia y se vuelve a montar: sin volver a marcarlo, quedaba
    // en false y start() apagaba la cámara apenas el navegador daba permiso.
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);

  const start = async () => {
    setCamera("starting");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: face ? "user" : { ideal: "environment" }, width: { ideal: 1600 }, height: { ideal: 1200 } },
        audio: false,
      });
      // Si el componente se desmontó mientras se pedía permiso, la cámara quedaría encendida.
      if (!mounted.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => {});
      }
      setCamera("on");
    } catch {
      setCamera("error");
    }
  };

  const shoot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob(
      (b) => {
        if (!b) return;
        stop();
        setCamera("off");
        onCapture(b);
      },
      "image/jpeg",
      0.9,
    );
  };

  return (
    <div className="idv-capture card pad stack">
      <h3>{tx(`idv.step.${kind}` as IdnKey)}</h3>
      <p className="muted small">{tx(`idv.hint.${kind}` as IdnKey)}</p>
      <div className={`idv-video ${camera === "on" ? "on" : ""} ${face ? "face" : "doc"}`}>
        <video ref={video} playsInline muted aria-label={tx(`idv.step.${kind}` as IdnKey)} />
      </div>
      {camera === "error" && (
        <p className="muted small" role="alert">
          {tx("idv.cameraError")}
        </p>
      )}
      <div className="idv-actions">
        {camera === "on" ? (
          <button type="button" className="btn btn-primary" onClick={shoot} disabled={busy}>
            📸 {tx("idv.capture")}
          </button>
        ) : (
          typeof navigator !== "undefined" &&
          typeof navigator.mediaDevices?.getUserMedia === "function" &&
          camera !== "error" && (
            <button type="button" className="btn btn-primary" onClick={start} disabled={busy || camera === "starting"}>
              📷 {tx("idv.useCamera")}
            </button>
          )
        )}
        <label className="btn btn-ghost idv-upload">
          {tx("idv.upload")}
          <input
            type="file"
            accept="image/jpeg,image/png"
            capture={face ? "user" : "environment"}
            className="visually-hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                stop();
                setCamera("off");
                onCapture(f);
              }
              e.target.value = "";
            }}
          />
        </label>
        {busy && <Spinner />}
      </div>
    </div>
  );
}
