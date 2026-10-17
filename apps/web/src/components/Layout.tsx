// Estructura de la consola del remitente.
import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { LocaleSwitcher, Logo } from "./ui";
import { useIntText } from "../lib/integrations-i18n";
import { useAccess } from "../lib/access";
import { useTeamsText } from "../lib/i18n-teams";
import { TenantSwitcher } from "./TenantSwitcher";

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

export function Layout() {
  const { me, logout } = useAuth();
  const { t } = useI18n();
  const nav = useNavigate();
  const mailbox = useDevMailboxAvailable();
  const tt = useIntText();
  const tm = useTeamsText();
  const { access } = useAccess();
  const loc = useLocation();
  const [open, setOpen] = useState(false);

  // Organización que exige 2FA y el usuario no lo tiene: solo puede ir a Seguridad.
  if (access?.twoFactor.setupRequired && loc.pathname !== "/app/settings/security") {
    return <Navigate to="/app/settings/security" replace />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/app" className="brand" onClick={() => setOpen(false)}>
          <Logo light />
        </NavLink>
        <button type="button" className="menu-toggle" aria-expanded={open} aria-label="Menú" onClick={() => setOpen((o) => !o)}>
          ☰
        </button>
        <nav className={`topnav ${open ? "open" : ""}`} onClick={() => setOpen(false)}>
          <NavLink to="/app" end>
            {t("nav.envelopes")}
          </NavLink>
          <NavLink to="/app/templates">{t("nav.templates")}</NavLink>
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
          <LocaleSwitcher compact />
          <button
            type="button"
            className="btn btn-ghost btn-sm on-dark"
            onClick={async () => {
              await logout();
              nav("/login");
            }}
          >
            {t("nav.logout")}
          </button>
        </nav>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
