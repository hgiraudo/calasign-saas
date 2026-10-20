// Componentes de UI chicos y compartidos.
import { productName, rebrands, useBrandTheme } from "../lib/white-label";
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import type { EnvelopeStatus, Locale, RecipientStatus } from "@calasign/shared";
import { LOCALES } from "@calasign/shared";
import { formatNumber, LOCALE_LABELS, useI18n } from "../lib/i18n";
import { useExpText } from "../lib/i18n-experience";

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
  const titleId = useId();
  // Quién tenía el foco al abrir: se toma en el primer render, antes de que un input con autoFocus del modal lo robe.
  const opener = useRef<HTMLElement | null>(typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null));
  const x = useExpText();
  // onClose suele ser una función nueva en cada render: se guarda en un ref para no re-enfocar el modal
  // (y robarle el foco al input) cada vez que el padre se vuelve a dibujar.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    // Al cerrar, el foco vuelve a donde estaba (el botón que abrió el modal).
    const previous = opener.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
      if (e.key !== "Tab" || !ref.current) return;
      // Trampa de foco: Tab y Shift+Tab no salen del modal.
      const items = [...ref.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={x("a11y.close")}>
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
  // Marca blanca: el logo (o el nombre) de la marca activa en lugar del de la plataforma.
  const brand = useBrandTheme();
  if (brand && (rebrands(brand) || brand.logoUrl)) {
    const src = light ? brand.logoDarkUrl ?? brand.logoUrl : brand.logoUrl;
    return (
      <span className={`logo brand-logo ${light ? "logo-light" : ""}`}>
        {src ? <img src={src} alt={productName(brand)} style={{ maxHeight: 28, maxWidth: 160 }} /> : <span>{productName(brand)}</span>}
      </span>
    );
  }
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

/**
 * Entero acotado (por defecto 1–100, el orden de firma). El texto se guarda aparte del número: con `Number(valor) || 1`
 * en cada tecla, borrar dejaba un 1 que no se podía quitar y tipear "3" terminaba en 13. Al salir del campo se vuelve
 * a mostrar el valor vigente.
 */
export function OrderInput({
  value,
  onChange,
  min = 1,
  max = 100,
  ...rest
}: { value: number; onChange: (n: number) => void; min?: number; max?: number } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "min" | "max">) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="number"
      min={min}
      max={max}
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Math.trunc(Number(e.target.value));
        if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/** Colores por destinatario (índice). */
export const RECIPIENT_COLORS = ["#0EA5A4", "#6366F1", "#F59E0B", "#EF4444", "#10B981", "#EC4899", "#3B82F6", "#8B5CF6"];
export function recipientColor(index: number): string {
  return RECIPIENT_COLORS[((index % RECIPIENT_COLORS.length) + RECIPIENT_COLORS.length) % RECIPIENT_COLORS.length];
}

/** Tamaño legible con el separador decimal y de miles del idioma de la app. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${formatNumber(n)} B`;
  if (n < 1024 * 1024) return `${formatNumber(Math.round(n / 1024))} KB`;
  return `${formatNumber(n / 1024 / 1024, undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}
