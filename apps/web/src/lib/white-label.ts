// Marca blanca en la web: tema de la marca activa (inyectado por el servidor en index.html, o el de la sesión de firma),
// aplicado a toda la página (CSS, título, favicon) y a los textos (nombre del producto y textos propios por idioma).
import { useSyncExternalStore } from "react";
import { isProtectedTextKey, themeToCss, verifyPageTheme, type Locale, type PublicBrandTheme } from "@calasign/shared";

const PLATFORM = "CalaSign";

function readInjected(): PublicBrandTheme | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById("brand-data");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as PublicBrandTheme;
  } catch {
    return null;
  }
}

let current: PublicBrandTheme | null = readInjected();
let version = 0;
/** Página pública de verificación abierta: tema restringido (sin el CSS propio de la marca). */
let verifyPage = typeof window !== "undefined" && isVerifyPath(window.location?.pathname ?? "");

/** "/verify" y "/verify/" (el router muestra la misma página; el servidor también la trata como verificación). */
export function isVerifyPath(path: string): boolean {
  return path.replace(/\/+$/, "") === "/verify";
}
const listeners = new Set<() => void>();

function ensure<T extends HTMLElement>(id: string, tag: string, parent: HTMLElement = document.head): T {
  let el = document.getElementById(id) as T | null;
  if (!el) {
    el = document.createElement(tag) as T;
    el.id = id;
    parent.appendChild(el);
  }
  return el;
}

function apply(t: PublicBrandTheme | null) {
  if (typeof document === "undefined") return;
  const style = ensure<HTMLStyleElement>("brand-theme", "style");
  // En /verify solo barra, botones y fuente (verifyPageTheme): con el CSS propio una marca podía ocultar el veredicto.
  // El tema pudo llegar completo desde la página del firmante (navegación dentro de la web): se recalcula. Y al revés: el
  // que inyecta el servidor en /verify trae `css` restringido y el completo en `pageCss`, que se restaura al salir.
  style.textContent = t ? (verifyPage ? verifyCss(t) : (t.pageCss ?? t.css)) : "";
  const font = document.getElementById("brand-font") as HTMLLinkElement | null;
  if (t?.fontCssUrl) {
    const l = font ?? ensure<HTMLLinkElement>("brand-font", "link");
    l.rel = "stylesheet";
    if (l.href !== t.fontCssUrl) l.href = t.fontCssUrl;
  } else font?.remove();
  if (t && rebrands(t)) {
    document.title = productName(t);
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) {
      icon.removeAttribute("type");
      icon.href = t.faviconUrl ?? "data:,";
    }
  }
}

function verifyCss(t: PublicBrandTheme): string {
  const fontFace =
    t.theme.fontSource === "upload" && t.fontUrl && t.theme.fontFamily
      ? `@font-face{font-family:"${t.theme.fontFamily}";src:url("${t.fontUrl}");font-display:swap}`
      : null;
  return themeToCss(verifyPageTheme(t.theme), { fontFace });
}

/** La página de verificación avisa al montarse/desmontarse: cambia el CSS de la marca que se aplica. */
export function setVerifyPageMode(on: boolean) {
  if (verifyPage === on) return;
  verifyPage = on;
  apply(current);
}

/** Activa (o quita) la marca. La llaman la página del firmante, la verificación y el arranque. */
export function setBrandTheme(t: PublicBrandTheme | null | undefined) {
  const next = t ?? null;
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  version++;
  apply(current);
  listeners.forEach((l) => l());
}

export function brandTheme(): PublicBrandTheme | null {
  return current;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Marca activa (re-renderiza al cambiar). */
export function useBrandTheme(): PublicBrandTheme | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Cambia con cada marca nueva (para dependencias de useCallback). */
export function useBrandVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export function rebrands(t: PublicBrandTheme | null | undefined): boolean {
  return Boolean(t && (t.productName || t.whiteLabel));
}

/** Nombre del producto a mostrar con la marca activa. */
export function productName(t: PublicBrandTheme | null | undefined = current): string {
  if (!t) return PLATFORM;
  return t.productName || (t.whiteLabel ? t.name : PLATFORM);
}

/**
 * Texto con la marca: el texto propio de la marca para esa clave e idioma (si lo hay) o el original, con el nombre de
 * la plataforma reemplazado por el del producto. Lo usan todos los diccionarios de la web.
 */
export function brandText(locale: Locale, key: string, original: string): string {
  const t = current;
  if (!t) return original;
  // Los textos del veredicto de la verificación y del reporte técnico no se reemplazan nunca (isProtectedTextKey).
  const own = isProtectedTextKey(key) ? undefined : t.texts?.[locale]?.[key];
  const s = own ?? original;
  if (!rebrands(t)) return s;
  // Reemplazos con función: un "$&", "$'" o "$$" en el nombre o el link no se interpreta como patrón.
  const name = productName(t);
  return s.replace(/CalaSign/g, () => name).replace(/contacto@calasign\.com/gi, () => t.links.supportUrl ?? name);
}

apply(current);
