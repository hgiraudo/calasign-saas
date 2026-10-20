// Una página de PDF renderizada con pdf.js, con una capa superpuesta para campos.
// La capa usa coordenadas en % (0..1 * 100) desde arriba a la izquierda.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type Ref } from "react";
import type { PageSize } from "@calasign/shared";
import { TextLayer, type PDFDocumentProxy } from "../lib/pdf";

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
  const textRef = useRef<HTMLDivElement>(null);
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

  // Render perezoso: se dibuja cuando la página se acerca a la pantalla y se libera el canvas cuando queda lejos (más
  // de ~3 pantallas): un PDF largo en un móvil agotaba la memoria con todos los canvas vivos. Dos márgenes (histéresis)
  // para no dibujar y liberar en cada pequeño scroll. El contenedor conserva su tamaño (aspect-ratio) y los campos no
  // dependen del canvas: liberar no mueve el scroll.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const near = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "100% 0px" },
    );
    const far = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last && !last.isIntersecting) setVisible(false);
      },
      { rootMargin: "300% 0px" },
    );
    near.observe(el);
    far.observe(el);
    return () => {
      near.disconnect();
      far.disconnect();
    };
  }, []);

  // Otro documento (cambió la URL): hasta que se dibuje, se muestra el marcador y no la página del anterior.
  useEffect(() => {
    setRendered(false);
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    textRef.current?.replaceChildren();
  }, [pdf]);

  useEffect(() => {
    if (!visible) {
      // Lejos de la pantalla: libera la memoria del canvas (un canvas de 0×0 no reserva el bitmap) y la capa de texto.
      const c = canvasRef.current;
      if (c && (c.width || c.height)) {
        c.width = 0;
        c.height = 0;
      }
      textRef.current?.replaceChildren();
      setRendered(false);
      return;
    }
    if (!pdf || widthPx < 10) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let text: TextLayer | null = null;
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
        if (cancelled) return;
        setRendered(true);
        // Capa de texto de pdf.js (transparente, debajo de los campos): el texto se puede seleccionar y lo leen los
        // lectores de pantalla (el canvas es solo una imagen).
        const box = textRef.current;
        if (!box) return;
        const cssViewport = page.getViewport({ scale: widthPx / base.width });
        box.replaceChildren();
        box.style.setProperty("--scale-factor", String(cssViewport.scale));
        text = new TextLayer({ textContentSource: page.streamTextContent(), container: box, viewport: cssViewport });
        await text.render();
      } catch (e) {
        const name = (e as Error)?.name;
        if (name !== "RenderingCancelledException" && name !== "AbortException") console.warn("pdf render", e);
      }
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
      text?.cancel();
    };
  }, [pdf, pageIndex, widthPx, visible]);

  return (
    <div
      ref={wrapRef}
      className="pdf-page"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      role="group"
      aria-label={label}
      data-page={pageIndex}
    >
      <canvas ref={canvasRef} className="pdf-canvas" aria-hidden="true" />
      <div ref={textRef} className="pdf-text" />
      {!rendered && <div className="pdf-placeholder">…</div>}
      {/* Sin manejador propio (firmante, vistas) la capa deja pasar el puntero al texto; los campos lo siguen recibiendo. */}
      <div
        ref={overlayRef}
        className={`pdf-overlay ${onOverlayPointerDown ? "" : "passive"} ${overlayClassName ?? ""}`}
        onPointerDown={onOverlayPointerDown}
      >
        {widthPx > 0 && overlay?.({ widthPx })}
      </div>
    </div>
  );
}
