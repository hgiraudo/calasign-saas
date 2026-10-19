// Una página de PDF renderizada con pdf.js, con una capa superpuesta para campos.
// La capa usa coordenadas en % (0..1 * 100) desde arriba a la izquierda.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type Ref } from "react";
import type { PageSize } from "@calasign/shared";
import type { PDFDocumentProxy } from "../lib/pdf";

interface Props {
  pdf: PDFDocumentProxy | null;
  pageIndex: number;
  size: PageSize;
  /** Render de la capa superpuesta; recibe el ancho en px de la página. */
  overlay?: (info: { widthPx: number }) => ReactNode;
  onOverlayPointerDown?: (e: RPointerEvent<HTMLDivElement>) => void;
  overlayRef?: Ref<HTMLDivElement>;
  overlayClassName?: string;
  label?: string;
}

export function PdfPage({ pdf, pageIndex, size, overlay, onOverlayPointerDown, overlayRef, overlayClassName, label }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [widthPx, setWidthPx] = useState(0);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);

  // Ancho real del contenedor.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      setWidthPx((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Render perezoso: solo cuando la página está cerca de la pantalla.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Otro documento (cambió la URL): hasta que se dibuje, se muestra el marcador y no la página del anterior.
  useEffect(() => {
    setRendered(false);
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, [pdf]);

  useEffect(() => {
    if (!pdf || !visible || widthPx < 10) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    const timer = window.setTimeout(async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const viewport = page.getViewport({ scale: (widthPx / base.width) * dpr });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvasContext: ctx, viewport });
        await task.promise;
        if (!cancelled) setRendered(true);
      } catch (e) {
        if ((e as Error)?.name !== "RenderingCancelledException") console.warn("pdf render", e);
      }
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
  }, [pdf, pageIndex, widthPx, visible]);

  return (
    <div
      ref={wrapRef}
      className="pdf-page"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      aria-label={label}
      data-page={pageIndex}
    >
      <canvas ref={canvasRef} className="pdf-canvas" aria-hidden="true" />
      {!rendered && <div className="pdf-placeholder">…</div>}
      <div ref={overlayRef} className={`pdf-overlay ${overlayClassName ?? ""}`} onPointerDown={onOverlayPointerDown}>
        {widthPx > 0 && overlay?.({ widthPx })}
      </div>
    </div>
  );
}
