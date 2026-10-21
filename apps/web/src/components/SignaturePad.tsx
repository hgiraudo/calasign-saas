// Modal para adoptar una firma (o iniciales): dibujarla o escribirla con letra manuscrita.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SignatureImageInput } from "@calasign/shared";
import { useI18n } from "../lib/i18n";
import { Modal } from "./ui";
import { useExpText } from "../lib/i18n-experience";

const W = 720;
const H = 240;
const FONT = "'Dancing Script', cursive";
/**
 * Mismo criterio que la API al recibir la imagen (packages/pdf pngInkPixels + SIGNATURE_MIN_INK_PIXELS en signing.ts):
 * píxeles con alfa ≥ 32 y no casi blancos, al menos 24. Un toque suelto no llega y la API lo rechazaba al finalizar.
 */
const INK_MIN_ALPHA = 32;
const MIN_INK_PIXELS = 24;

interface Props {
  purpose: "signature" | "initials";
  defaultText: string;
  onAdopt: (sig: SignatureImageInput & { dataUrl: string }) => void;
  onClose: () => void;
}

export function SignaturePad({ purpose, defaultText, onAdopt, onClose }: Props) {
  const { t } = useI18n();
  const x = useExpText();
  const [tab, setTab] = useState<"draw" | "type">("type");
  const [text, setText] = useState(defaultText);
  const [hasInk, setHasInk] = useState(false);
  /** Hay trazo y alcanza para que la API lo acepte (se mide al soltar el puntero, no en cada movimiento). */
  const [enoughInk, setEnoughInk] = useState(false);
  const [typedInk, setTypedInk] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const typeRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) {
      setFontReady(true);
      return;
    }
    fonts
      .load(`64px ${FONT}`)
      .catch(() => undefined)
      .finally(() => alive && setFontReady(true));
    return () => {
      alive = false;
    };
  }, []);

  // Render del texto escrito.
  useEffect(() => {
    const c = typeRef.current;
    if (!c || tab !== "type") return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const value = text.trim();
    if (!value) {
      setTypedInk(false);
      return;
    }
    let size = purpose === "initials" ? 120 : 96;
    ctx.fillStyle = "#0B1F3A";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    do {
      ctx.font = `${size}px ${FONT}`;
      size -= 4;
    } while (ctx.measureText(value).width > W - 40 && size > 20);
    ctx.fillText(value, W / 2, H / 2 + 6);
    setTypedInk(inkPixels(c) >= MIN_INK_PIXELS);
  }, [text, tab, fontReady, purpose]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
    const ctx = e.currentTarget.getContext("2d");
    if (ctx && last.current) {
      ctx.fillStyle = "#0B1F3A";
      ctx.beginPath();
      ctx.arc(last.current.x, last.current.y, 2, 0, Math.PI * 2);
      ctx.fill();
      setHasInk(true);
    }
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    const pressure = e.pressure && e.pressure > 0 && e.pointerType === "pen" ? e.pressure : 0.5;
    ctx.strokeStyle = "#0B1F3A";
    ctx.lineWidth = 2.5 + pressure * 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    setHasInk(true);
  };
  const onUp = () => {
    drawing.current = false;
    last.current = null;
    const c = drawRef.current;
    if (c) setEnoughInk(inkPixels(c) >= MIN_INK_PIXELS);
  };

  // El lienzo de dibujo se desmonta al pasar a "Escribir": al volver está vacío. Sin esto, hasInk seguía en true y
  // "Adoptar" adoptaba una firma en blanco.
  useEffect(() => {
    if (tab === "draw") {
      setHasInk(false);
      setEnoughInk(false);
    }
  }, [tab]);

  const clear = useCallback(() => {
    const c = drawRef.current;
    c?.getContext("2d")?.clearRect(0, 0, W, H);
    setHasInk(false);
    setEnoughInk(false);
  }, []);

  // Escrita: hasta que cargue la fuente manuscrita el lienzo muestra la de reserva, y se adoptaba esa imagen.
  const canAdopt = tab === "draw" ? hasInk && enoughInk : text.trim().length > 0 && fontReady && typedInk;
  const tooShort = tab === "draw" ? hasInk && !enoughInk : text.trim().length > 0 && fontReady && !typedInk;

  const adopt = () => {
    const c = tab === "draw" ? drawRef.current : typeRef.current;
    if (!c || !canAdopt) return;
    const trimmed = trimCanvas(c);
    // Sin trazo suficiente no hay firma que adoptar (nunca una imagen en blanco ni un punto que la API rechaza).
    if (!trimmed || inkPixels(trimmed) < MIN_INK_PIXELS) return;
    const dataUrl = trimmed.toDataURL("image/png");
    onAdopt({
      kind: tab === "draw" ? "drawn" : "typed",
      imagePng: dataUrl.split(",")[1] ?? "",
      text: tab === "type" ? text.trim() : null,
      dataUrl,
    });
  };

  return (
    <Modal
      title={purpose === "initials" ? t("sign.adoptInitials") : t("sign.adoptTitle")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!canAdopt} onClick={adopt}>
            {t("sign.adopt")}
          </button>
        </>
      }
    >
      <div
        className="tabs"
        role="tablist"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const next = tab === "type" ? "draw" : "type";
            setTab(next);
            window.requestAnimationFrame(() => document.getElementById(`sigtab-${next}`)?.focus());
          }
        }}
      >
        <button
          type="button"
          role="tab"
          id="sigtab-type"
          aria-controls="sigpanel"
          aria-selected={tab === "type"}
          tabIndex={tab === "type" ? 0 : -1}
          className={tab === "type" ? "active" : ""}
          onClick={() => setTab("type")}
        >
          {t("sign.type")}
        </button>
        <button
          type="button"
          role="tab"
          id="sigtab-draw"
          aria-controls="sigpanel"
          aria-selected={tab === "draw"}
          tabIndex={tab === "draw" ? 0 : -1}
          className={tab === "draw" ? "active" : ""}
          onClick={() => setTab("draw")}
        >
          {t("sign.draw")}
        </button>
      </div>
      {tab === "type" ? (
        <div className="sigpad" role="tabpanel" id="sigpanel" aria-labelledby="sigtab-type">
          <p className="muted small">{x("a11y.typeHint")}</p>
          <label className="field">
            <span>{t("sign.typeHere")}</span>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={purpose === "initials" ? 6 : 80} autoFocus />
          </label>
          <canvas ref={typeRef} width={W} height={H} className="sig-canvas" role="img" aria-label={text.trim() || t("sign.typeHere")} />
          {tooShort && (
            <p className="small warn-text" role="status">
              {x("sig.tooShort")}
            </p>
          )}
        </div>
      ) : (
        <div className="sigpad" role="tabpanel" id="sigpanel" aria-labelledby="sigtab-draw">
          <canvas
            ref={drawRef}
            width={W}
            height={H}
            className="sig-canvas drawable"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            role="img"
            aria-label={t("sign.drawHere")}
          />
          <div className="sigpad-actions">
            {tooShort ? (
              <span className="warn-text" role="status">
                {x("sig.tooShort")}
              </span>
            ) : (
              <span className="muted">{t("sign.drawHere")}</span>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
              {t("sign.clear")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Píxeles con tinta, como pngInkPixels en la API: alfa ≥ 32 y no casi blancos. */
function inkPixels(c: HTMLCanvasElement): number {
  const ctx = c.getContext("2d");
  if (!ctx || !c.width || !c.height) return 0;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < INK_MIN_ALPHA) continue;
    if (d[i]! > 240 && d[i + 1]! > 240 && d[i + 2]! > 240) continue;
    ink++;
  }
  return ink;
}

/** Recorta el área transparente alrededor del trazo (con margen). null si el lienzo está vacío. */
function trimCanvas(src: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = src.getContext("2d");
  if (!ctx) return src;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 8;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d")?.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
