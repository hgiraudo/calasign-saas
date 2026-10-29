// Una página de PDF renderizada con pdf.js, con una capa superpuesta para campos.
// La capa usa coordenadas en % (0..1 * 100) desde arriba a la izquierda.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type Ref } from "react";
import type { PageSize } from "@calasign/shared";
import { pdfjs, type PdfJs, type PDFDocumentProxy } from "../lib/pdf";

/**
 * Solo se liberan canvas en documentos de más páginas que esto. La impresión del navegador saca una foto de la página
 * apenas termina `beforeprint` (síncrono) y pdf.js dibuja de forma asíncrona: una página liberada sale en blanco y no
 * hay forma confiable de redibujarla a tiempo. En documentos cortos (la gran mayoría) la memoria no es un problema, así
 * que no se libera nada y se imprimen completos; en los largos se prioriza no agotar la memoria del móvil.
 */
const RELEASE_MIN_PAGES = 20;

/**
 * Tope de píxeles de un canvas: con dpr 2.5 una página grande (A3, plano) pasaba los límites del navegador (Safari no
 * dibuja un canvas de más de ~16 MP y lo deja en blanco). Se baja la escala para que el área quede por debajo.
 */
const MAX_CANVAS_PIXELS = 16_000_000;
/**
 * Presupuesto de píxeles de todos los canvas vivos (todas las páginas de todos los documentos abiertos): varios
 * documentos cortos (que no liberan por distancia) en un móvil agotaban la memoria de canvas igual que uno largo.
 */
const CANVAS_BUDGET =
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches
    ? 60_000_000
    : 150_000_000;

interface CanvasSlot {
  /** Píxeles del canvas dibujado (0: liberado). */
  area: number;
  /** Cerca de la pantalla ahora (no se libera). */
  near: boolean;
  /** Última vez que estuvo cerca de la pantalla. */
  lastNear: number;
  /** Libera el canvas de esa página. */
  evict: () => void;
}
const slots = new Set<CanvasSlot>();
let printing = 0;

/** Registra el canvas dibujado y, si se pasa del presupuesto, libera los que hace más que no están cerca de la pantalla. */
function reserveCanvas(slot: CanvasSlot, area: number) {
  slot.area = area;
  slots.add(slot);
  if (printing) return;
  let total = 0;
  for (const s of slots) total += s.area;
  if (total <= CANVAS_BUDGET) return;
  const victims = [...slots].filter((s) => s !== slot && !s.near && s.area > 0).sort((a, b) => a.lastNear - b.lastNear);
  for (const v of victims) {
    if (total <= CANVAS_BUDGET) break;
    total -= v.area;
    v.area = 0;
    v.evict();
  }
}

/** Mientras se imprime no se libera nada por presupuesto (la impresión necesita todas las páginas dibujadas). */
function printingPages(delta: number) {
  printing = Math.max(0, printing + delta);
}

function releaseCanvas(slot: CanvasSlot) {
  slot.area = 0;
  slots.delete(slot);
}

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
  const slotRef = useRef<CanvasSlot | null>(null);
  if (!slotRef.current) slotRef.current = { area: 0, near: false, lastNear: 0, evict: () => undefined };
  const slot = slotRef.current;
  slot.evict = () => setVisible(false);
  useEffect(() => () => releaseCanvas(slot), [slot]);

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
      slot.near = true;
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
      const last = entries[entries.length - 1];
      if (!last) return;
      slot.near = last.isIntersecting;
      slot.lastNear = performance.now();
      if (last.isIntersecting) setVisible(true);
    }, "100% 0px");
    const far = observer((entries) => {
      const last = entries[entries.length - 1];
      if (canRelease && !printing && releasableRef.current && last && !last.isIntersecting) setVisible(false);
    }, "300% 0px");
    near.observe(el);
    far.observe(el);
    const onBeforePrint = () => {
      if (!printing) printingPages(1);
      printing = true;
      setVisible(true);
    };
    const onAfterPrint = () => {
      if (printing) printingPages(-1);
      printing = false;
      // Volver a observar entrega el estado actual: las páginas lejanas que se dibujaron para imprimir se liberan.
      far.unobserve(el);
      far.observe(el);
    };
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      if (printing) printingPages(-1);
      near.disconnect();
      far.disconnect();
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    };
  }, [slot]);

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
      releaseCanvas(slot);
      setRendered(false);
      return;
    }
    if (!pdf || widthPx < 10) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let text: InstanceType<PdfJs["TextLayer"]> | null = null;
    const timer = window.setTimeout(async () => {
      try {
        const page = await pdf.getPage(pageIndex + 1);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        let scale = (widthPx / base.width) * dpr;
        const area = base.width * base.height * scale * scale;
        if (area > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        drawnRef.current = true;
        reserveCanvas(slot, canvas.width * canvas.height);
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
        const { TextLayer } = await pdfjs();
        if (cancelled) return;
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
  }, [pdf, pageIndex, widthPx, visible, slot]);

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
