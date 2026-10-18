// Selector de organización para usuarios que pertenecen a más de una.
import { useNavigate } from "react-router-dom";
import type { MeResponse } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useAccess } from "../lib/access";
import { useAuth } from "../lib/auth";
import { useRoleLabel, useTeamsText } from "../lib/i18n-teams";

export function TenantSwitcher() {
  const { access } = useAccess();
  const { setMe } = useAuth();
  const tm = useTeamsText();
  const label = useRoleLabel();
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
        const select = e.currentTarget;
        try {
          const m = await api<MeResponse>("/v1/auth/switch-tenant", { method: "POST", body: { tenantId: e.target.value } });
          setMe(m);
          nav("/app");
        } catch (err) {
          // Sin manejar, el rechazo quedaba en la consola y el usuario no sabía por qué no cambió (p. ej. sesión SSO atada a una organización).
          select.title = errorText(err);
          select.setCustomValidity(errorText(err));
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
