// Modal para adoptar una firma (o iniciales): escribirla con letra manuscrita, dibujarla (acá o en el celular, con un
// pase de firma) o importarla de una imagen PNG o JPG.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SignatureImageInput } from "@calasign/shared";
import { useI18n } from "../lib/i18n";
import { Modal } from "./ui";
import { useExpText } from "../lib/i18n-experience";
import { useSignatureText, type SignatureTextKey } from "../lib/i18n-signature";
import {
  canvasPng,
  IMPORT_MAX_MB,
  IMPORT_MIN_H,
  IMPORT_MIN_W,
  inkPixels,
  MIN_INK_PIXELS,
  SIG_H as H,
  SIG_W as W,
  signatureFromFile,
  trimCanvas,
  type ImportError,
} from "../lib/signature-image";
import { PhoneHandoff } from "./PhoneHandoff";

const FONT = "'Dancing Script', cursive";
const TABS = ["type", "draw", "upload"] as const;
type Tab = (typeof TABS)[number];

/** Firma lista para adoptar sin lienzo: la que llegó del celular o la importada. */
interface Ready {
  imagePng: string;
  dataUrl: string;
  handoffId?: string;
}

interface Props {
  purpose: "signature" | "initials";
  defaultText: string;
  /** /v1/signing/<token> del firmante: habilita «Dibujar en el celular». */
  base?: string;
  onAdopt: (sig: SignatureImageInput & { dataUrl: string }) => void;
  onClose: () => void;
}

export function SignaturePad({ purpose, defaultText, base, onAdopt, onClose }: Props) {
  const { t } = useI18n();
  const x = useExpText();
  const gx = useSignatureText();
  const [tab, setTab] = useState<Tab>("type");
  const [text, setText] = useState(defaultText);
  const [hasInk, setHasInk] = useState(false);
  /** Hay trazo y alcanza para que la API lo acepte (se mide al soltar el puntero, no en cada movimiento). */
  const [enoughInk, setEnoughInk] = useState(false);
  const [typedInk, setTypedInk] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [remote, setRemote] = useState<Ready | null>(null);
  const [imported, setImported] = useState<Ready | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const drawRef = useRef<HTMLCanvasElement>(null);
  const typeRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  /** Archivo que se está leyendo: si se elige otro antes de terminar, el resultado del anterior se descarta. */
  const importGen = useRef(0);

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

  const resetInk = useCallback(() => {
    setHasInk(false);
    setEnoughInk(false);
  }, []);

  // El lienzo de dibujo se desmonta al pasar a otra pestaña (o al abrir el celular): al volver está vacío. Sin esto,
  // hasInk seguía en true y "Adoptar" adoptaba una firma en blanco. El panel del celular se cierra (deja de esperar).
  useEffect(() => {
    if (tab === "draw") resetInk();
    else setPhoneOpen(false);
  }, [tab, resetInk]);

  const clear = useCallback(() => {
    const c = drawRef.current;
    c?.getContext("2d")?.clearRect(0, 0, W, H);
    resetInk();
  }, [resetInk]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const my = ++importGen.current;
    setImporting(true);
    setImportError(null);
    setImported(null);
    const res = await signatureFromFile(file);
    if (my !== importGen.current) return;
    setImporting(false);
    if (!res.ok) return setImportError(importErrorText(gx, res.error));
    setImported(canvasPng(res.canvas));
  };

  // Escrita: hasta que cargue la fuente manuscrita el lienzo muestra la de reserva, y se adoptaba esa imagen.
  const canAdopt =
    tab === "draw"
      ? Boolean(remote) || (!phoneOpen && hasInk && enoughInk)
      : tab === "upload"
        ? Boolean(imported)
        : text.trim().length > 0 && fontReady && typedInk;
  const tooShort = tab === "draw" ? !remote && hasInk && !enoughInk : tab === "type" && text.trim().length > 0 && fontReady && !typedInk;

  const adopt = () => {
    if (!canAdopt) return;
    // La del celular va tal cual llegó (la API verifica que sea la misma imagen del pase); la importada ya viene recortada.
    if (tab === "draw" && remote)
      return onAdopt({ kind: "drawn", imagePng: remote.imagePng, text: null, handoffId: remote.handoffId, dataUrl: remote.dataUrl });
    if (tab === "upload" && imported) return onAdopt({ kind: "uploaded", imagePng: imported.imagePng, text: null, dataUrl: imported.dataUrl });
    const c = tab === "draw" ? drawRef.current : typeRef.current;
    if (!c) return;
    const trimmed = trimCanvas(c);
    // Sin trazo suficiente no hay firma que adoptar (nunca una imagen en blanco ni un punto que la API rechaza).
    if (!trimmed || inkPixels(trimmed) < MIN_INK_PIXELS) return;
    const png = canvasPng(trimmed);
    onAdopt({ kind: tab === "draw" ? "drawn" : "typed", ...png, text: tab === "type" ? text.trim() : null });
  };

  const tabLabel = (k: Tab) => (k === "type" ? t("sign.type") : k === "draw" ? t("sign.draw") : gx("import.tab"));

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
            const next = TABS[(TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
            setTab(next);
            window.requestAnimationFrame(() => document.getElementById(`sigtab-${next}`)?.focus());
          }
        }}
      >
        {TABS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`sigtab-${k}`}
            aria-controls="sigpanel"
            aria-selected={tab === k}
            tabIndex={tab === k ? 0 : -1}
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
          >
            {tabLabel(k)}
          </button>
        ))}
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
      ) : tab === "draw" ? (
        <div className="sigpad" role="tabpanel" id="sigpanel" aria-labelledby="sigtab-draw">
          {remote ? (
            <>
              <img className="sig-canvas sig-preview" src={remote.dataUrl} alt={gx("phone.received")} />
              <div className="sigpad-actions">
                <span className="muted">{gx("phone.received")}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setRemote(null);
                    resetInk();
                  }}
                >
                  {gx("phone.discard")}
                </button>
              </div>
            </>
          ) : phoneOpen && base ? (
            <PhoneHandoff
              base={base}
              purpose={purpose}
              onReceived={(r) => {
                setRemote({ imagePng: r.imagePng, dataUrl: `data:image/png;base64,${r.imagePng}`, handoffId: r.handoffId });
                setPhoneOpen(false);
              }}
              onBack={() => {
                setPhoneOpen(false);
                resetInk();
              }}
            />
          ) : (
            <>
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
                <span className="sigpad-buttons">
                  {base && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPhoneOpen(true)}>
                      <span aria-hidden="true">📱</span> {gx("phone.open")}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={clear}>
                    {t("sign.clear")}
                  </button>
                </span>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="sigpad" role="tabpanel" id="sigpanel" aria-labelledby="sigtab-upload">
          <p className="muted small">{gx("import.hint", { mb: IMPORT_MAX_MB })}</p>
          {imported ? (
            <>
              <img className="sig-canvas sig-preview" src={imported.dataUrl} alt={gx("import.preview")} />
              <div className="sigpad-actions">
                <span className="muted">{gx("import.preview")}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    importGen.current++;
                    setImported(null);
                  }}
                >
                  {gx("import.change")}
                </button>
              </div>
            </>
          ) : (
            <label
              className={`dropzone ${dragOver ? "over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void importFile(e.dataTransfer.files[0]);
              }}
            >
              <input
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                className="sr-only"
                aria-label={gx("import.file")}
                onChange={(e) => {
                  void importFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <span className="btn btn-sm">{gx("import.choose")}</span> <span className="muted small">{gx("import.drop")}</span>
            </label>
          )}
          {importing && (
            <p className="small muted" role="status">
              {gx("import.reading")}
            </p>
          )}
          {importError && (
            <p className="small error-text" role="alert">
              {importError}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function importErrorText(gx: (k: SignatureTextKey, v?: Record<string, string | number>) => string, e: ImportError): string {
  switch (e.code) {
    case "format":
      return gx("import.err.format");
    case "tooLarge":
      return gx("import.err.tooLarge", { mb: IMPORT_MAX_MB });
    case "dimensions":
      return gx("import.err.dimensions", { w: e.w, h: e.h });
    case "tooSmall":
      return gx("import.err.tooSmall", { w: IMPORT_MIN_W, h: IMPORT_MIN_H });
    case "unreadable":
      return gx("import.err.unreadable");
    case "blank":
      return gx("import.err.blank");
  }
}
