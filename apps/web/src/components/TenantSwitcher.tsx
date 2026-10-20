// Selector de organización para usuarios que pertenecen a más de una.
import { useNavigate } from "react-router-dom";
import type { MeResponse } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { useAccess } from "../lib/access";
import { useAuth } from "../lib/auth";
import { useRoleLabel, useTeamsText } from "../lib/i18n-teams";
import { usePasswordText } from "../lib/i18n-password";
import { confirmDiscardUnsaved } from "../lib/i18n";

export function TenantSwitcher() {
  const { access } = useAccess();
  const { setMe } = useAuth();
  const tm = useTeamsText();
  const label = useRoleLabel();
  const pw = usePasswordText();
  const nav = useNavigate();
  if (!access) return null;
  const current = access.tenants.find((t) => t.current);
  return (
    <select
      className="tenant-switcher"
      aria-label={tm("org.switch")}
      title={tm("org.switch")}
      value={current?.id ?? ""}
      onClick={(e) => e.stopPropagation()}
      onChange={async (e) => {
        // Cambiar de organización lleva al inicio: con un editor con cambios sin guardar, se confirma antes.
        if (!confirmDiscardUnsaved()) return;
        const select = e.currentTarget;
        try {
          const m = await api<MeResponse>("/v1/auth/switch-tenant", { method: "POST", body: { tenantId: e.target.value } });
          setMe(m);
          nav("/app");
        } catch (err) {
          // Sin manejar, el rechazo quedaba en la consola y el usuario no sabía por qué no cambió (p. ej. sesión SSO atada a una organización).
          // Membresía creada por SSO/SCIM: el mensaje de la API viene solo en español y no dice qué hacer.
          const msg = err instanceof HttpError && err.code === "password_not_allowed" ? pw("notAllowed") : errorText(err);
          select.title = msg;
          select.setCustomValidity(msg);
          select.reportValidity();
          window.setTimeout(() => select.setCustomValidity(""), 4000);
        }
      }}
    >
      {access.tenants.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name} · {label(t.role, t.roleName)}
        </option>
      ))}
    </select>
  );
}
