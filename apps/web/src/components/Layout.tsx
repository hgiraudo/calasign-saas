// Estructura de la consola del remitente.
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { LocaleSwitcher, Logo } from "./ui";

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
          <NavLink to="/app/settings/branding">{t("nav.branding")}</NavLink>
          <NavLink to="/app/settings/api-keys">{t("nav.apiKeys")}</NavLink>
          {mailbox && <NavLink to="/app/dev-mailbox">{t("nav.mailbox")}</NavLink>}
          <span className="topnav-spacer" />
          <span className="topnav-user" title={me?.user.email}>
            {me?.tenant.name}
          </span>
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
