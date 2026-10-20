// Una página de PDF renderizada con pdf.js, con una capa superpuesta para campos.
// La capa usa coordenadas en % (0..1 * 100) desde arriba a la izquierda.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type Ref } from "react";
import type { PageSize } from "@calasign/shared";
import { TextLayer, type PDFDocumentProxy } from "../lib/pdf";

/**
 * Solo se liberan canvas en documentos de más páginas que esto. La impresión del navegador saca una foto de la página
 * apenas termina `beforeprint` (síncrono) y pdf.js dibuja de forma asíncrona: una página liberada sale en blanco y no
 * hay forma confiable de redibujarla a tiempo. En documentos cortos (la gran mayoría) la memoria no es un problema, así
 * que no se libera nada y se imprimen completos; en los largos se prioriza no agotar la memoria del móvil.
 */
const RELEASE_MIN_PAGES = 20;

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
  /** Se dibujó con pdf.js desde la última liberación (para no pedir la página solo para liberarla). */
  const drawnRef = useRef(false);
  /** El documento es largo: hay presión de memoria y vale la pena liberar los canvas lejanos (ver RELEASE_MIN_PAGES). */
  const releasableRef = useRef(false);
  releasableRef.current = (pdf?.numPages ?? 0) > RELEASE_MIN_PAGES;

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
  // root: document (el viewport de este documento) y no el implícito: dentro de un iframe de otro origen (firma
  // embebida) el root implícito es el viewport de la ventana de arriba y el navegador ignora rootMargin, así que las
  // páginas se liberaban apenas salían de pantalla y se redibujaban al volver. Si el navegador no acepta un Document
  // como root, se usa el implícito y, enmarcado, no se libera nada.
  // Solo en documentos largos (RELEASE_MIN_PAGES): así los cortos se imprimen completos.
  // Mientras se imprime no se libera (el cambio de layout de la impresión dispara los observadores); al empezar a
  // imprimir se piden todas las páginas (llegan a tiempo para la vista previa de impresión de los navegadores que la
  // regeneran, no siempre para la primera foto) y al terminar se vuelve a evaluar cuáles están lejos.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    let printing = false;
    let canRelease = true;
    const observer = (cb: IntersectionObserverCallback, rootMargin: string) => {
      try {
        return new IntersectionObserver(cb, { root: document, rootMargin });
      } catch {
        // Sin soporte de Document como root: en un iframe el margen no aplicaría (ver arriba).
        if (window.top !== window) canRelease = false;
        return new IntersectionObserver(cb, { rootMargin });
      }
    };
    const near = observer((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    }, "100% 0px");
    const far = observer((entries) => {
      const last = entries[entries.length - 1];
      if (canRelease && !printing && releasableRef.current && last && !last.isIntersecting) setVisible(false);
    }, "300% 0px");
    near.observe(el);
    far.observe(el);
    const onBeforePrint = () => {
      printing = true;
      setVisible(true);
    };
    const onAfterPrint = () => {
      printing = false;
      // Volver a observar entrega el estado actual: las páginas lejanas que se dibujaron para imprimir se liberan.
      far.unobserve(el);
      far.observe(el);
    };
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      near.disconnect();
      far.disconnect();
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
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
      // Lejos de la pantalla: libera la memoria del canvas (un canvas de 0×0 no reserva el bitmap) y los recursos de la
      // página en pdf.js (page.cleanup). La capa de texto queda: es liviana y la usan Ctrl+F y los lectores de pantalla.
      const c = canvasRef.current;
      if (c && (c.width || c.height)) {
        c.width = 0;
        c.height = 0;
      }
      if (drawnRef.current) {
        drawnRef.current = false;
        pdf
          ?.getPage(pageIndex + 1)
          .then((page) => page.cleanup())
          .catch(() => undefined);
      }
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
        drawnRef.current = true;
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
