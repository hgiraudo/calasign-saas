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

/**
 * Pasa lo visible del lienzo al trazo completo (`ink`) y lo devuelve: lo visible manda en su franja (incluye lo dibujado
 * y lo borrado desde la última vez) y lo que quedó debajo del alto actual se conserva.
 */
function syncInk(c: HTMLCanvasElement, ink: { current: HTMLCanvasElement | null }): HTMLCanvasElement {
  let full = ink.current;
  if (!full || full.width !== c.width) {
    full = document.createElement("canvas");
    full.width = c.width;
    full.height = c.height;
  } else if (full.height < c.height) {
    const grown = document.createElement("canvas");
    grown.width = full.width;
    grown.height = c.height;
    grown.getContext("2d")?.drawImage(full, 0, 0);
    full = grown;
  }
  const ctx = full.getContext("2d");
  ctx?.clearRect(0, 0, c.width, c.height);
  ctx?.drawImage(c, 0, 0);
  ink.current = full;
  return full;
}

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
  /**
   * El trazo completo, aunque el lienzo visible se achique: cuando aparece la barra del navegador el alto baja y la parte
   * de abajo de la firma deja de verse, pero no se pierde (vuelve cuando el alto crece y se envía entera).
   */
  const ink = useRef<HTMLCanvasElement | null>(null);
  /** Ancho en pantalla y densidad con que se dimensionó el lienzo: sólo un cambio de ancho los recalcula. */
  const layout = useRef<{ cssWidth: number; dpr: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [problem, setProblem] = useState<"tooShort" | "tooLarge" | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolución real del lienzo = tamaño en pantalla × densidad (si no, el trazo se ve borroso en un celular). Al girar
  // el celular cambia el ancho: se ajusta y se borra (redibujar estirado deformaría la firma). Si sólo cambia el alto (la
  // barra del navegador aparece o se esconde al mover la página, y el lienzo ocupa el alto visible), la densidad queda
  // como estaba —con el tope de píxeles dependía del alto y cambiaba también el ancho— y el trazo se conserva entero.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const fit = () => {
      const r = c.getBoundingClientRect();
      const cssWidth = Math.round(r.width);
      const sameWidth = layout.current?.cssWidth === cssWidth && c.width > 0;
      let dpr = window.devicePixelRatio || 1;
      if (sameWidth) dpr = layout.current!.dpr;
      else if (r.width * r.height * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (r.width * r.height));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (sameWidth) {
        if (c.height === h) return;
        const full = syncInk(c, ink);
        c.height = h;
        c.getContext("2d")?.drawImage(full, 0, 0);
        return;
      }
      const w = Math.max(1, Math.round(r.width * dpr));
      layout.current = { cssWidth, dpr };
      if (c.width === w && c.height === h) return;
      ink.current = null;
      c.width = w;
      c.height = h;
      setHasInk(false);
      setProblem(null);
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
    ink.current = null;
    setHasInk(false);
    setProblem(null);
    setError(null);
  };

  const send = async () => {
    const c = ref.current;
    if (!c || sending) return;
    // El trazo completo (también lo que la barra del navegador tapa ahora), recortado y achicado al tamaño de la firma
    // dibujada en la computadora (720 × 240), con el criterio de tinta de la API.
    const trimmed = trimCanvas(syncInk(c, ink));
    const out = trimmed ? fitCanvas(trimmed) : null;
    if (!out || inkPixels(out) < MIN_INK_PIXELS) return setProblem("tooShort");
    const { imagePng } = canvasPng(out);
    // Demasiado pesada (muchísimos trazos): pedir que dibuje más no sirve, hay que simplificarla.
    if (base64Bytes(imagePng) > SIGNATURE_PNG_MAX_BYTES) return setProblem("tooLarge");
    setProblem(null);
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
      {problem && (
        <p className="small warn-text" role="status">
          {gx(problem === "tooLarge" ? "handoff.tooLarge" : "handoff.tooShort")}
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
