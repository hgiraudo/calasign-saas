// Todas las páginas de un documento, con capa superpuesta por página.
import { useEffect, useState, type PointerEvent as RPointerEvent, type ReactNode, type DragEvent } from "react";
import type { Document } from "@calasign/shared";
import { loadPdf, type PDFDocumentProxy } from "../lib/pdf";
import { errorText } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { PdfPage } from "./PdfPage";
import { ErrorBox } from "./ui";

interface Props {
  doc: Document;
  url: string;
  renderOverlay?: (page: number, widthPx: number) => ReactNode;
  onPagePointerDown?: (page: number, e: RPointerEvent<HTMLDivElement>) => void;
  onPageDrop?: (page: number, e: DragEvent<HTMLDivElement>) => void;
  overlayClassName?: string;
  showTitle?: boolean;
}

export function DocumentView({ doc, url, renderOverlay, onPagePointerDown, onPageDrop, overlayClassName, showTitle = true }: Props) {
  const { t } = useI18n();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPdf(null);
    loadPdf(url)
      .then((p) => alive && setPdf(p))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [url]);

  return (
    <section className="doc-view" data-document={doc.id}>
      {showTitle && (
        <h3 className="doc-title">
          {doc.name} <span className="muted small">· {doc.pageCount} {t("edit.pages")}</span>
        </h3>
      )}
      <ErrorBox error={error} />
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
            overlay={renderOverlay ? ({ widthPx }) => renderOverlay(i, widthPx) : undefined}
          />
          <div className="page-num muted small">
            {i + 1} / {doc.pageCount}
          </div>
        </div>
      ))}
    </section>
  );
}
