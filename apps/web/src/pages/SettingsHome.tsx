// Índice de ajustes: muestra solo las secciones que el rol puede usar.
import { Link } from "react-router-dom";
import type { Permission } from "@calasign/shared";
import { useAccess } from "../lib/access";
import { useI18n } from "../lib/i18n";
import { useIntText } from "../lib/integrations-i18n";
import { useTeamsText } from "../lib/i18n-teams";
import { useScaleText } from "../lib/i18n-scale";
import { useEvidenceText } from "../lib/i18n-evidence";

export function SettingsHomePage() {
  const { t } = useI18n();
  const tt = useIntText();
  const tm = useTeamsText();
  const sc = useScaleText();
  const evt = useEvidenceText();
  const { can } = useAccess();
  const sections: { to: string; title: string; desc: string; perm?: Permission }[] = [
    { to: "/app/bulk", title: sc("nav.bulk"), desc: sc("bulk.intro"), perm: "envelopes:create" },
    { to: "/app/xml", title: evt("nav.xml"), desc: evt("settings.xml"), perm: "envelopes:create" },
    { to: "/app/settings/certificates", title: evt("nav.certificates"), desc: evt("settings.certificates"), perm: "settings:manage" },
    { to: "/app/forms", title: sc("nav.forms"), desc: sc("forms.intro"), perm: "envelopes:create" },
    { to: "/app/settings/team", title: tm("nav.team"), desc: tm("settings.team") },
    { to: "/app/settings/branding", title: t("nav.branding"), desc: tm("settings.branding"), perm: "settings:manage" },
    { to: "/app/settings/api-keys", title: t("nav.apiKeys"), desc: tm("settings.apiKeys"), perm: "api_keys:manage" },
    { to: "/app/settings/integrations", title: tt("nav.integrations"), desc: tm("settings.integrations"), perm: "webhooks:manage" },
    { to: "/app/settings/audit", title: tm("nav.audit"), desc: tm("settings.audit"), perm: "audit:view" },
    { to: "/app/settings/security", title: tm("nav.security"), desc: tm("settings.security") },
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
