// Componentes de UI chicos y compartidos.
import { useEffect, useRef, type ReactNode } from "react";
import type { EnvelopeStatus, Locale, RecipientStatus } from "@calasign/shared";
import { LOCALES } from "@calasign/shared";
import { LOCALE_LABELS, useI18n } from "../lib/i18n";

export function StatusBadge({ status }: { status: EnvelopeStatus }) {
  const { t } = useI18n();
  return <span className={`badge badge-${status}`}>{t(`status.${status}`)}</span>;
}

export function RecipientStatusBadge({ status }: { status: RecipientStatus }) {
  const { t } = useI18n();
  return <span className={`badge rbadge-${status}`}>{t(`rstatus.${status}`)}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose suele ser una función nueva en cada render: se guarda en un ref para no re-enfocar el modal
  // (y robarle el foco al input) cada vez que el padre se vuelve a dibujar.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      {error}
    </div>
  );
}

export function LocaleSwitcher({ compact }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={`locale-switch ${compact ? "compact" : ""}`}>
      <span className="sr-only">{t("common.language")}</span>
      <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)} aria-label={t("common.language")}>
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Logo({ light }: { light?: boolean }) {
  return (
    <span className={`logo ${light ? "logo-light" : ""}`}>
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <rect width="32" height="32" rx="7" fill="#0B1F3A" />
        <path
          d="M8 20c3-7 6-9 8-6s-2 7 1 7 4-5 7-8"
          fill="none"
          stroke="#14B8A6"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        Cala<b>Sign</b>
      </span>
    </span>
  );
}

export function Spinner() {
  const { t } = useI18n();
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{t("common.loading")}</span>
    </div>
  );
}

/** Colores por destinatario (índice). */
export const RECIPIENT_COLORS = ["#0EA5A4", "#6366F1", "#F59E0B", "#EF4444", "#10B981", "#EC4899", "#3B82F6", "#8B5CF6"];
export function recipientColor(index: number): string {
  return RECIPIENT_COLORS[((index % RECIPIENT_COLORS.length) + RECIPIENT_COLORS.length) % RECIPIENT_COLORS.length];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
