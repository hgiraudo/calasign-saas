// Estructura de la consola del remitente.
import { Suspense, useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { confirmDiscardUnsaved, useI18n } from "../lib/i18n";
import { LocaleSwitcher, Logo, Spinner } from "./ui";
import { useIntText } from "../lib/integrations-i18n";
import { useAccess } from "../lib/access";
import { useTeamsText } from "../lib/i18n-teams";
import { TenantSwitcher } from "./TenantSwitcher";
import { useExpText } from "../lib/i18n-experience";
import { useInstallPrompt } from "../lib/pwa";
import { useAgrText } from "../lib/i18n-agreements";

export function useDevMailboxAvailable(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/dev/mailbox", { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => alive && setOk(r.ok && (r.headers.get("content-type") ?? "").includes("json")))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

/**
 * Al cambiar de página (navegación del lado del cliente) el foco quedaba en el link tocado, fuera del contenido nuevo:
 * se lleva al h1 de la página (o al main si no tiene), para lectores de pantalla y teclado. Las páginas lazy y las que
 * cargan datos dibujan el h1 un poco después: se espera hasta ~2 s. No se mueve si el foco ya está dentro del contenido.
 */
function useFocusMainOnNavigate(pathname: string) {
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let tries = 0;
    let timer = 0;
    const tick = () => {
      const main = mainRef.current;
      if (!main) return;
      if (main.contains(document.activeElement) && document.activeElement !== main) return;
      const h1 = main.querySelector<HTMLElement>("h1");
      if (h1) {
        if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
        h1.focus({ preventScroll: true });
      } else if (++tries < 20) {
        timer = window.setTimeout(tick, 100);
      } else {
        main.focus({ preventScroll: true });
      }
    };
    timer = window.setTimeout(tick, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);
  return mainRef;
}

export function Layout() {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  const mailbox = useDevMailboxAvailable();
  const tt = useIntText();
  const tm = useTeamsText();
  const { access, can } = useAccess();
  const loc = useLocation();
  const xt = useExpText();
  const install = useInstallPrompt();
  const ag = useAgrText();
  const [open, setOpen] = useState(false);
  const mainRef = useFocusMainOnNavigate(loc.pathname);

  // Organización que exige 2FA y el usuario no lo tiene: solo puede ir a Seguridad.
  if (access?.twoFactor.setupRequired && loc.pathname !== "/app/settings/security") {
    return <Navigate to="/app/settings/security" replace />;
  }

  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">
        {t("nav.skipToContent")}
      </a>
      <header className="topbar">
        <NavLink to="/app" className="brand" onClick={() => setOpen(false)}>
          <Logo light />
        </NavLink>
        <button type="button" className="menu-toggle" aria-expanded={open} aria-label={t("nav.menu")} onClick={() => setOpen((o) => !o)}>
          ☰
        </button>
        <nav className={`topnav ${open ? "open" : ""}`} onClick={() => setOpen(false)}>
          <NavLink to="/app" end>
            {t("nav.envelopes")}
          </NavLink>
          <NavLink to="/app/templates">{t("nav.templates")}</NavLink>
          {/* El repositorio y los acuerdos piden envelopes:create (también para leer). */}
          {can("envelopes:create") && <NavLink to="/app/agreements">{ag("nav.agreements")}</NavLink>}
          {/* Los reportes son de toda la organización: la API pide envelopes:view_all. */}
          {can("envelopes:view_all") && <NavLink to="/app/reports">{xt("nav.reports")}</NavLink>}
          {/* Equipo, marca, API keys, integraciones, auditoría y seguridad viven bajo Ajustes (índice según permisos). */}
          <NavLink to="/app/settings">{tm("nav.settings")}</NavLink>
          <NavLink to="/developers">{tt("nav.developers")}</NavLink>
          {mailbox && <NavLink to="/app/dev-mailbox">{t("nav.mailbox")}</NavLink>}
          <span className="topnav-spacer" />
          {access && access.tenants.length > 1 ? (
            <TenantSwitcher />
          ) : (
            <span className="topnav-user" title={me?.user.email}>
              {me?.tenant.name}
            </span>
          )}
          {install && (
            <button
              type="button"
              className="btn btn-ghost btn-sm on-dark install-btn"
              onClick={() => void install()}
              aria-label={xt("nav.install")}
              title={xt("nav.install")}
            >
              ⤓<span className="install-text"> {xt("nav.install")}</span>
            </button>
          )}
          <LocaleSwitcher compact />
          <button
            type="button"
            className="btn btn-ghost btn-sm on-dark"
            onClick={async () => {
              if (!confirmDiscardUnsaved()) return;
              // logout() recarga la página en /login (limpia la memoria de la sesión).
              await logout();
            }}
          >
            {t("nav.logout")}
          </button>
        </nav>
      </header>
      {/* La clave por organización vuelve a montar la página al cambiar de organización: sin esto, una vista ya
          abierta (p. ej. el listado de sobres) seguiría mostrando los datos de la organización anterior. */}
      <main className="content" id="main-content" tabIndex={-1} ref={mainRef} key={me?.tenant.id ?? "none"}>
        {/* Las páginas se cargan aparte (App.tsx): mientras llega una, la barra queda y solo el contenido espera. */}
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
