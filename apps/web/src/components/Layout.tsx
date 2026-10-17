// Estructura de la consola del remitente.
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { LocaleSwitcher, Logo } from "./ui";
import { useIntText } from "../lib/integrations-i18n";
import { useExpText } from "../lib/i18n-experience";
import { useInstallPrompt } from "../lib/pwa";

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
  const xt = useExpText();
  const install = useInstallPrompt();
  const [open, setOpen] = useState(false);

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
          <NavLink to="/app/reports">{xt("nav.reports")}</NavLink>
          <NavLink to="/app/settings/branding">{t("nav.branding")}</NavLink>
          <NavLink to="/app/settings/api-keys">{t("nav.apiKeys")}</NavLink>
          <NavLink to="/app/settings/integrations">{tt("nav.integrations")}</NavLink>
          <NavLink to="/developers">{tt("nav.developers")}</NavLink>
          {mailbox && <NavLink to="/app/dev-mailbox">{t("nav.mailbox")}</NavLink>}
          <span className="topnav-spacer" />
          <span className="topnav-user" title={me?.user.email}>
            {me?.tenant.name}
          </span>
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
