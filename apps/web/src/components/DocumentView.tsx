// Todas las páginas de un documento, con capa superpuesta por página.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode, type DragEvent } from "react";
import type { Document } from "@calasign/shared";
import { acquirePdf, releasePdf, type PDFDocumentProxy } from "../lib/pdf";
import { errorText, HttpError } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { PdfPage } from "./PdfPage";

interface Props {
  doc: Document;
  url: string;
  renderOverlay?: (page: number, widthPx: number) => ReactNode;
  onPagePointerDown?: (page: number, e: RPointerEvent<HTMLDivElement>) => void;
  onPageDrop?: (page: number, e: DragEvent<HTMLDivElement>) => void;
  overlayClassName?: string;
  showTitle?: boolean;
  /** Nivel del título del documento: 2 en la página del firmante (debajo del h1 del asunto), 3 en el editor. */
  headingLevel?: 2 | 3;
  /** Estado de la carga del PDF (la página del firmante no deja finalizar sobre un documento que no se ve). */
  onStatus?: (status: "loading" | "ready" | "error") => void;
}

export function DocumentView({
  doc,
  url,
  renderOverlay,
  onPagePointerDown,
  onPageDrop,
  overlayClassName,
  showTitle = true,
  headingLevel = 3,
  onStatus,
}: Props) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const { t } = useI18n();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Cada "Reintentar" vuelve a pedir el PDF (un fallo no queda en el caché de lib/pdf). */
  const [attempt, setAttempt] = useState(0);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  useEffect(() => {
    let alive = true;
    setPdf(null);
    // El error de la URL anterior no queda a la vista mientras carga (o después de cargar bien) la nueva.
    setError(null);
    statusRef.current?.("loading");
    acquirePdf(url)
      .then((p) => {
        if (!alive) return;
        setPdf(p);
        statusRef.current?.("ready");
      })
      .catch((e) => {
        if (!alive) return;
        // Un error de la API (descarga, red, tiempo agotado) tiene su texto; uno de pdf.js (PDF dañado, navegador sin
        // soporte) viene en inglés: se muestra uno propio.
        setError(e instanceof HttpError ? errorText(e) : t("doc.loadFailed"));
        statusRef.current?.("error");
      });
    return () => {
      alive = false;
      releasePdf(url);
    };
    // t no es dependencia: cambiar de idioma no vuelve a bajar el PDF.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, attempt]);

  return (
    <section className="doc-view" data-document={doc.id}>
      {showTitle && (
        <Heading className="doc-title">
          {doc.name}{" "}
          <span className="muted small">
            · {doc.pageCount} {t("edit.pages")}
          </span>
        </Heading>
      )}
      {error && (
        <div className="alert alert-error row-wrap" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {doc.pages.map((size, i) => (
        <div
          key={i}
          className="page-wrap"
          onDragOver={onPageDrop ? (e) => e.preventDefault() : undefined}
          onDrop={onPageDrop ? (e) => onPageDrop(i, e) : undefined}
        >
          <PdfPage
            pdf={pdf}
            pageIndex={i}
            size={size}
            label={`${doc.name} — ${i + 1}`}
            overlayClassName={overlayClassName}
            onOverlayPointerDown={onPagePointerDown ? (e) => onPagePointerDown(i, e) : undefined}
            // Los campos solo sobre un documento que se ve: sin PDF (cargando o con error) no se puede completar ni
            // firmar a ciegas.
            overlay={renderOverlay && pdf ? ({ widthPx }) => renderOverlay(i, widthPx) : undefined}
          />
          <div className="page-num muted small">
            {i + 1} / {doc.pageCount}
          </div>
        </div>
      ))}
    </section>
  );
}
