// Página del celular (/h/:token): el firmante dibuja su firma con el dedo y la envía a la pantalla donde está firmando
// (pase de firma, apps/api/src/modules/signature-handoff.ts). No muestra datos del sobre ni del firmante y no firma
// nada: la firma se adopta y se completa en la otra pantalla.
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { PublicSignatureHandoff } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useSignatureText } from "../lib/i18n-signature";
import { useTitle } from "../lib/white-label";
import { LocaleSwitcher, Spinner } from "../components/ui";
import { base64Bytes, canvasPng, fitCanvas, inkPixels, MIN_INK_PIXELS, SIGNATURE_PNG_MAX_BYTES, trimCanvas } from "../lib/signature-image";

type State =
  | { kind: "loading" }
  | { kind: "ready"; info: PublicSignatureHandoff }
  | { kind: "gone"; code: "invalid" | "expired" | "used"; err: HttpError }
  | { kind: "error"; message: string }
  | { kind: "done" };

/** Tope del lienzo en píxeles reales (ancho × alto × densidad): un celular con DPR 3 y pantalla grande no se pasa. */
const MAX_CANVAS_PIXELS = 6_000_000;

export function SignatureHandoffPage() {
  const { token = "" } = useParams();
  const gx = useSignatureText();
  const { setLocale, explicit } = useI18n();
  const [state, setState] = useState<State>({ kind: "loading" });
  const path = `/v1/public/signature-handoffs/${encodeURIComponent(token)}`;
  useTitle(gx("handoff.title"));

  // El idioma del firmante se toma una vez, al abrir (después lo cambia el selector): por ref, no como dependencia.
  const locale = useRef({ explicit, setLocale });
  locale.current = { explicit, setLocale };

  const fail = useCallback((e: unknown) => {
    if (e instanceof HttpError && e.status === 404) return setState({ kind: "gone", code: "invalid", err: e });
    if (e instanceof HttpError && e.code === "handoff_used") return setState({ kind: "gone", code: "used", err: e });
    if (e instanceof HttpError && e.code === "handoff_expired") return setState({ kind: "gone", code: "expired", err: e });
    setState({ kind: "error", message: errorText(e) });
  }, []);

  useEffect(() => {
    let alive = true;
    api<PublicSignatureHandoff>(path).then(
      (info) => {
        if (!alive) return;
        if (!locale.current.explicit) locale.current.setLocale(info.locale, false);
        setState({ kind: "ready", info });
      },
      (e) => alive && fail(e),
    );
    return () => {
      alive = false;
    };
  }, [path, fail]);

  return (
    <main className="handoff-page">
      <div className="row-wrap" style={{ justifyContent: "flex-end" }}>
        <LocaleSwitcher compact />
      </div>
      {state.kind === "loading" ? (
        <Spinner />
      ) : state.kind === "ready" ? (
        <HandoffCanvas info={state.info} path={path} onDone={() => setState({ kind: "done" })} onFail={fail} />
      ) : state.kind === "done" ? (
        <>
          <h1>{gx("handoff.doneTitle")}</h1>
          <p role="status">{gx("handoff.doneText")}</p>
        </>
      ) : state.kind === "gone" ? (
        <>
          <h1>{gx(state.code === "invalid" ? "handoff.invalidTitle" : state.code === "used" ? "handoff.usedTitle" : "handoff.expiredTitle")}</h1>
          <p role="status">{state.code === "invalid" ? gx("handoff.invalidText") : errorText(state.err)}</p>
        </>
      ) : (
        <p className="error-text" role="alert">
          {state.message}
        </p>
      )}
    </main>
  );
}

function HandoffCanvas({
  info,
  path,
  onDone,
  onFail,
}: {
  info: PublicSignatureHandoff;
  path: string;
  onDone: () => void;
  onFail: (e: unknown) => void;
}) {
  const gx = useSignatureText();
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [tooShort, setTooShort] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolución real del lienzo = tamaño en pantalla × densidad (si no, el trazo se ve borroso en un celular). Al girar
  // el celular cambia el tamaño: se ajusta y se borra (redibujar estirado deformaría la firma).
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const fit = () => {
      const r = c.getBoundingClientRect();
      let dpr = window.devicePixelRatio || 1;
      if (r.width * r.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (r.width * r.height));
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (c.width === w && c.height === h) return;
      // Sólo cambió el alto (la barra del navegador del celular aparece o se esconde al mover la página, y el lienzo
      // ocupa el alto visible): el trazo se conserva en su lugar, sin estirarlo. Girar el celular cambia el ancho: se borra.
      let keep: HTMLCanvasElement | null = null;
      if (c.width === w && c.height > 0) {
        keep = document.createElement("canvas");
        keep.width = c.width;
        keep.height = c.height;
        keep.getContext("2d")?.drawImage(c, 0, 0);
      }
      c.width = w;
      c.height = h;
      if (keep) {
        c.getContext("2d")?.drawImage(keep, 0, 0);
        return;
      }
      setHasInk(false);
      setTooShort(false);
    };
    fit();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    ro?.observe(c);
    window.addEventListener("orientationchange", fit);
    return () => {
      ro?.disconnect();
      window.removeEventListener("orientationchange", fit);
    };
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height };
  };
  /** Grosor proporcional al lienzo: en un celular el dedo hace trazos más anchos que el mouse. */
  const width = (c: HTMLCanvasElement) => Math.max(3, Math.min(c.width, c.height * 3) / 140);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
    const ctx = e.currentTarget.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#0B1F3A";
      ctx.beginPath();
      ctx.arc(last.current.x, last.current.y, width(e.currentTarget) / 2, 0, Math.PI * 2);
      ctx.fill();
      setHasInk(true);
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    ctx.strokeStyle = "#0B1F3A";
    ctx.lineWidth = width(e.currentTarget);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  };
  const onUp = () => {
    drawing.current = false;
    last.current = null;
  };

  const clear = () => {
    const c = ref.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    setTooShort(false);
    setError(null);
  };

  const send = async () => {
    const c = ref.current;
    if (!c || sending) return;
    // Recortada y achicada al tamaño de la firma dibujada en la computadora (720 × 240), con el criterio de tinta de la API.
    const trimmed = trimCanvas(c);
    const out = trimmed ? fitCanvas(trimmed) : null;
    if (!out || inkPixels(out) < MIN_INK_PIXELS) return setTooShort(true);
    const { imagePng } = canvasPng(out);
    if (base64Bytes(imagePng) > SIGNATURE_PNG_MAX_BYTES) return setTooShort(true);
    setTooShort(false);
    setSending(true);
    setError(null);
    try {
      await api(path, { method: "POST", body: { imagePng }, timeoutMs: 30_000 });
      onDone();
    } catch (e) {
      setSending(false);
      // Vencido o ya usado: la página lo dice entera. Otro error (red, imagen rechazada): se puede reintentar.
      if (e instanceof HttpError && (e.status === 404 || e.code === "handoff_used" || e.code === "handoff_expired")) return onFail(e);
      setError(errorText(e));
    }
  };

  return (
    <>
      <h1>{gx(info.purpose === "initials" ? "handoff.titleInitials" : "handoff.title")}</h1>
      <p className="muted small">{gx("handoff.hint")}</p>
      <canvas
        ref={ref}
        className="handoff-canvas"
        role="img"
        aria-label={gx("handoff.canvas")}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      {tooShort && (
        <p className="small warn-text" role="status">
          {gx("handoff.tooShort")}
        </p>
      )}
      {error && (
        <p className="small error-text" role="alert">
          {error}
        </p>
      )}
      <div className="handoff-actions">
        <button type="button" className="btn btn-ghost" onClick={clear} disabled={sending}>
          {gx("handoff.clear")}
        </button>
        <button type="button" className="btn btn-primary" onClick={send} disabled={!hasInk || sending}>
          {sending ? gx("handoff.sending") : gx("handoff.send")}
        </button>
      </div>
    </>
  );
}
