// Modal para adoptar una firma (o iniciales): dibujarla o escribirla con letra manuscrita.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SignatureImageInput } from "@calasign/shared";
import { useI18n } from "../lib/i18n";
import { Modal } from "./ui";

const W = 720;
const H = 240;
const FONT = "'Dancing Script', cursive";

interface Props {
  purpose: "signature" | "initials";
  defaultText: string;
  onAdopt: (sig: SignatureImageInput & { dataUrl: string }) => void;
  onClose: () => void;
}

export function SignaturePad({ purpose, defaultText, onAdopt, onClose }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"draw" | "type">("type");
  const [text, setText] = useState(defaultText);
  const [hasInk, setHasInk] = useState(false);
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
    if (!value) return;
    let size = purpose === "initials" ? 120 : 96;
    ctx.fillStyle = "#0B1F3A";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    do {
      ctx.font = `${size}px ${FONT}`;
      size -= 4;
    } while (ctx.measureText(value).width > W - 40 && size > 20);
    ctx.fillText(value, W / 2, H / 2 + 6);
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
  };

  const clear = useCallback(() => {
    const c = drawRef.current;
    c?.getContext("2d")?.clearRect(0, 0, W, H);
    setHasInk(false);
  }, []);

  const canAdopt = tab === "draw" ? hasInk : text.trim().length > 0;

  const adopt = () => {
    const c = tab === "draw" ? drawRef.current : typeRef.current;
    if (!c || !canAdopt) return;
    const dataUrl = trimCanvas(c).toDataURL("image/png");
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
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "type"} className={tab === "type" ? "active" : ""} onClick={() => setTab("type")}>
          {t("sign.type")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "draw"} className={tab === "draw" ? "active" : ""} onClick={() => setTab("draw")}>
          {t("sign.draw")}
        </button>
      </div>
      {tab === "type" ? (
        <div className="sigpad">
          <label className="field">
            <span>{t("sign.typeHere")}</span>
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={purpose === "initials" ? 6 : 80} autoFocus />
          </label>
          <canvas ref={typeRef} width={W} height={H} className="sig-canvas" aria-label={t("sign.typeHere")} />
        </div>
      ) : (
        <div className="sigpad">
          <canvas
            ref={drawRef}
            width={W}
            height={H}
            className="sig-canvas drawable"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            aria-label={t("sign.drawHere")}
          />
          <div className="sigpad-actions">
            <span className="muted">{t("sign.drawHere")}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
              {t("sign.clear")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Recorta el área transparente alrededor del trazo (con margen). */
function trimCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
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
  if (maxX < 0) return src;
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
