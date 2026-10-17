// Índice de ajustes: muestra solo las secciones que el rol puede usar.
import { Link } from "react-router-dom";
import type { Permission } from "@calasign/shared";
import { useAccess } from "../lib/access";
import { useI18n } from "../lib/i18n";
import { useIntText } from "../lib/integrations-i18n";
import { useTeamsText } from "../lib/i18n-teams";
import { useScaleText } from "../lib/i18n-scale";
import { usePlatformText } from "../lib/i18n-platform";
import { useIdnText } from "../lib/i18n-identity";

export function SettingsHomePage() {
  const { t } = useI18n();
  const tt = useIntText();
  const tm = useTeamsText();
  const ti = useIdnText();
  const sc = useScaleText();
  const pl = usePlatformText();
  const { can } = useAccess();
  const sections: { to: string; title: string; desc: string; perm?: Permission }[] = [
    { to: "/app/bulk", title: sc("nav.bulk"), desc: sc("bulk.intro"), perm: "envelopes:create" },
    { to: "/app/forms", title: sc("nav.forms"), desc: sc("forms.intro"), perm: "envelopes:create" },
    { to: "/app/settings/team", title: tm("nav.team"), desc: tm("settings.team") },
    { to: "/app/settings/branding", title: t("nav.branding"), desc: tm("settings.branding"), perm: "settings:manage" },
    { to: "/app/settings/api-keys", title: t("nav.apiKeys"), desc: tm("settings.apiKeys"), perm: "api_keys:manage" },
    { to: "/app/settings/integrations", title: tt("nav.integrations"), desc: tm("settings.integrations"), perm: "webhooks:manage" },
    { to: "/app/settings/audit", title: tm("nav.audit"), desc: tm("settings.audit"), perm: "audit:view" },
    { to: "/app/settings/security", title: tm("nav.security"), desc: tm("settings.security") },
    { to: "/app/settings/oauth-apps", title: pl("card.oauth"), desc: pl("card.oauth.desc") },
    { to: "/app/settings/notifications", title: pl("card.notifications"), desc: pl("card.notifications.desc"), perm: "settings:manage" },
    { to: "/app/settings/automation", title: pl("card.automation"), desc: pl("card.automation.desc"), perm: "api_keys:manage" },
    { to: "/app/settings/storage", title: pl("card.storage"), desc: pl("card.storage.desc"), perm: "settings:manage" },
    { to: "/app/settings/domain", title: pl("card.domain"), desc: pl("card.domain.desc"), perm: "settings:manage" },
    { to: "/app/settings/identity", title: ti("settings.identity"), desc: ti("settings.identityDesc"), perm: "settings:manage" },
    { to: "/app/settings/sso", title: ti("settings.sso"), desc: ti("settings.ssoDesc"), perm: "settings:manage" },
    { to: "/app/settings/scim", title: ti("settings.scim"), desc: ti("settings.scimDesc"), perm: "members:manage" },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{tm("settings.title")}</h1>
      </div>
      <div className="settings-grid">
        {sections
          .filter((s) => !s.perm || can(s.perm))
          .map((s) => (
            <Link key={s.to} to={s.to} className="card pad settings-card">
              <strong>{s.title}</strong>
              <span className="muted small">{s.desc}</span>
            </Link>
          ))}
      </div>
    </div>
  );
}
