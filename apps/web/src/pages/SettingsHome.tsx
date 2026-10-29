// Índice de ajustes: muestra solo las secciones que el rol puede usar.
import { Link } from "react-router-dom";
import type { Permission, PlanFeature } from "@calasign/shared";
import { useAccess } from "../lib/access";
import { useI18n } from "../lib/i18n";
import { useIntText } from "../lib/integrations-i18n";
import { useTeamsText } from "../lib/i18n-teams";
import { useScaleText } from "../lib/i18n-scale";
import { usePlatformText } from "../lib/i18n-platform";
import { useCrmText } from "../lib/i18n-crm";
import { useConnText } from "../lib/i18n-connectors";
import { useIdnText } from "../lib/i18n-identity";
import { useEvidenceText } from "../lib/i18n-evidence";
import { useBillingText } from "../lib/i18n-billing";
import { useAiText } from "../lib/i18n-ai";
import { useDataText } from "../lib/i18n-data";
import { useTitle } from "../lib/white-label";

export function SettingsHomePage() {
  const { t } = useI18n();
  const tt = useIntText();
  const tm = useTeamsText();
  useTitle(tm("settings.title"));
  const ti = useIdnText();
  const sc = useScaleText();
  const pl = usePlatformText();
  const crm = useCrmText();
  const cn = useConnText();
  const evt = useEvidenceText();
  const bl = useBillingText();
  const ai = useAiText();
  const dt = useDataText();
  const { can, access, hasFeature } = useAccess();
  // feature: función del plan que hace falta para usar la sección (sin ella, la tarjeta lo avisa; adentro se puede ver y
  // quitar lo configurado).
  const sections: { to: string; title: string; desc: string; perm?: Permission; feature?: PlanFeature }[] = [
    { to: "/app/bulk", title: sc("nav.bulk"), desc: sc("bulk.intro"), perm: "envelopes:create", feature: "bulk_send" },
    { to: "/app/xml", title: evt("nav.xml"), desc: evt("settings.xml"), perm: "settings:manage" },
    { to: "/app/settings/ai", title: ai("nav.ai"), desc: ai("settings.ai"), perm: "settings:manage" },
    { to: "/app/settings/certificates", title: evt("nav.certificates"), desc: evt("settings.certificates"), perm: "settings:manage" },
    { to: "/app/forms", title: sc("nav.forms"), desc: sc("forms.intro"), perm: "envelopes:create", feature: "web_forms" },
    { to: "/app/settings/team", title: tm("nav.team"), desc: tm("settings.team") },
    { to: "/app/settings/branding", title: t("nav.branding"), desc: tm("settings.branding"), perm: "settings:manage", feature: "branding" },
    { to: "/app/settings/api-keys", title: t("nav.apiKeys"), desc: tm("settings.apiKeys"), perm: "api_keys:manage", feature: "api" },
    {
      to: "/app/settings/integrations",
      title: tt("nav.integrations"),
      desc: tm("settings.integrations"),
      perm: "webhooks:manage",
      feature: "webhooks",
    },
    { to: "/app/settings/audit", title: tm("nav.audit"), desc: tm("settings.audit"), perm: "audit:view" },
    { to: "/app/settings/security", title: tm("nav.security"), desc: tm("settings.security") },
    { to: "/app/settings/oauth-apps", title: pl("card.oauth"), desc: pl("card.oauth.desc"), feature: "api" },
    { to: "/app/settings/notifications", title: pl("card.notifications"), desc: pl("card.notifications.desc"), perm: "settings:manage" },
    { to: "/app/settings/automation", title: pl("card.automation"), desc: pl("card.automation.desc"), perm: "api_keys:manage" },
    { to: "/app/settings/storage", title: pl("card.storage"), desc: pl("card.storage.desc"), perm: "settings:manage" },
    { to: "/app/settings/domain", title: pl("card.domain"), desc: pl("card.domain.desc"), perm: "settings:manage", feature: "custom_domain" },
    { to: "/app/settings/crm", title: crm("card.crm"), desc: crm("card.crm.desc"), perm: "settings:manage" },
    { to: "/app/settings/connectors", title: cn("card.title"), desc: cn("card.desc"), perm: "settings:manage" },
    { to: "/app/settings/identity", title: ti("settings.identity"), desc: ti("settings.identityDesc"), perm: "settings:manage" },
    // SSO solo lo configura el propietario (con SSO se puede entrar como cualquier miembro).
    ...(access && access.role !== "owner"
      ? []
      : [
          {
            to: "/app/settings/sso",
            title: ti("settings.sso"),
            desc: ti("settings.ssoDesc"),
            perm: "settings:manage" as Permission,
            feature: "sso" as PlanFeature,
          },
        ]),
    { to: "/app/settings/byok", title: dt("nav.byok"), desc: dt("settings.byok"), perm: "settings:manage" },
    { to: "/app/settings/scim", title: ti("settings.scim"), desc: ti("settings.scimDesc"), perm: "members:manage", feature: "scim" },
    { to: "/app/settings/billing", title: bl("nav.billing"), desc: bl("settings.billing"), perm: "billing:manage" },
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
              {s.feature && !hasFeature(s.feature) && (
                <span className="badge badge-expired" style={{ alignSelf: "flex-start" }}>
                  {t("common.notInPlanShort")}
                </span>
              )}
            </Link>
          ))}
      </div>
    </div>
  );
}
