// Sección "Conectores": low-code / iPaaS, Dynamics 365 y el índice de los conectores nativos (CRM, HRIS, CLM, DMS, avisos, IA) (artefactos de integrations/connectors, servidos en /integrations/connectors/).
import { useDocsText } from "../../../lib/i18n-docs";
import { BASE, CONNECTOR_ARTIFACTS } from "../constants";
import { Card, CardGrid, Code, DocPage, H2, Md, SmartLink } from "../ui";

function DownloadButton({ href, label }: { href: string; label: string }) {
  return (
    <a className="btn btn-sm btn-accent" href={href} download>
      ↓ {label}
    </a>
  );
}

function ActionLink({ to, label }: { to: string; label: string }) {
  return (
    <SmartLink href={to}>
      <span className="btn btn-sm">{label} →</span>
    </SmartLink>
  );
}

const file = (p: string) => p.split("/").pop() ?? p;

export function ConnectorsPage() {
  const t = useDocsText();
  const A = CONNECTOR_ARTIFACTS;
  return (
    <DocPage title={t("conn.title")} lead={t("conn.lead")}>
      <H2 id="connectors">{t("conn.cards.h")}</H2>
      <CardGrid>
        <Card icon="⚡" title="Power Automate / Logic Apps" to="/developers/connectors#power-automate" action={<ActionLink to="/developers/connectors#power-automate" label={t("conn.card.a")} />}>
          {t("conn.card.pa.d")}
        </Card>
        <Card icon="✱" title="Zapier" to="/developers/connectors#zapier" action={<ActionLink to="/developers/connectors#zapier" label={t("conn.card.a")} />}>
          {t("conn.card.zap.d")}
        </Card>
        <Card icon="◐" title="Make" to="/developers/connectors#make" action={<ActionLink to="/developers/connectors#make" label={t("conn.card.a")} />}>
          {t("conn.card.make.d")}
        </Card>
        <Card icon="⧉" title="n8n" to="/developers/connectors#n8n" action={<ActionLink to="/developers/connectors#n8n" label={t("conn.card.a")} />}>
          {t("conn.card.n8n.d")}
        </Card>
        <Card icon="▦" title="Dynamics 365" to="/developers/connectors#dynamics365" action={<ActionLink to="/developers/connectors#dynamics365" label={t("conn.card.a")} />}>
          {t("conn.card.d365.d")}
        </Card>
        <Card icon="✉" title="Google Workspace" to="/developers/connectors#google-workspace" action={<ActionLink to="/developers/connectors#google-workspace" label={t("conn.card.a")} />}>
          {t("conn.card.gws.d")}
        </Card>
      </CardGrid>

      <H2 id="native">{t("conn.native.h")}</H2>
      <Md text={t("conn.native.p")} />
      <CardGrid>
        <Card icon="◎" title="CRM y ERP" to="/developers/guides/crm" action={<ActionLink to="/developers/guides/crm" label={t("conn.native.a")} />}>
          {t("conn.native.crm.d")}
        </Card>
        <Card icon="☺" title="HRIS" to="/developers/guides/hr-contracts#providers" action={<ActionLink to="/developers/guides/hr-contracts#providers" label={t("conn.native.a")} />}>
          {t("conn.native.hr.d")}
        </Card>
        <Card icon="§" title="CLM" to="/developers/guides/hr-contracts#flows" action={<ActionLink to="/developers/guides/hr-contracts#flows" label={t("conn.native.a")} />}>
          {t("conn.native.clm.d")}
        </Card>
        <Card icon="▤" title="DMS" to="/developers/guides/hr-contracts#dms" action={<ActionLink to="/developers/guides/hr-contracts#dms" label={t("conn.native.a")} />}>
          {t("conn.native.dms.d")}
        </Card>
        <Card icon="✉" title="Slack · Teams · WhatsApp" to="/app/settings/integrations" action={<ActionLink to="/app/settings/integrations" label={t("conn.native.config")} />}>
          {t("conn.native.notify.d")}
        </Card>
        <Card icon="✦" title="IA · Office" to="/developers/ai" action={<ActionLink to="/developers/ai" label={t("conn.native.a")} />}>
          {t("conn.native.ai.d")}
        </Card>
      </CardGrid>

      <H2 id="before">{t("conn.common.h")}</H2>
      <Md text={t("conn.common.p")} />

      <H2 id="power-automate">{t("conn.pa.h")}</H2>
      <p>
        <DownloadButton href={A.powerAutomate} label={file(A.powerAutomate)} />
      </p>
      <Md text={t("conn.pa.p")} />
      <Code
        lang="bash"
        title={t("conn.pa.cli")}
        code={`curl -LO ${BASE}${A.powerAutomate}\nunzip ${file(A.powerAutomate)} -d calasign-connector && cd calasign-connector\npac connector create --api-definition-file apiDefinition.swagger.json --api-properties-file apiProperties.json --icon-file icon.png`}
      />

      <H2 id="zapier">{t("conn.zap.h")}</H2>
      <p>
        <DownloadButton href={A.zapier} label={file(A.zapier)} />
      </p>
      <Md text={t("conn.zap.p")} />
      <Code lang="bash" code={`curl -LO ${BASE}${A.zapier}\nunzip ${file(A.zapier)} -d calasign-zapier && cd calasign-zapier\nnpm install\nnpx zapier-platform validate --without-style\nnpx zapier-platform login && npx zapier-platform register "CalaSign" && npx zapier-platform push`} />

      <H2 id="make">{t("conn.make.h")}</H2>
      <p>
        <DownloadButton href={A.make} label={file(A.make)} /> <DownloadButton href={A.makeJson} label={file(A.makeJson)} />
      </p>
      <Md text={t("conn.make.p")} />

      <H2 id="n8n">{t("conn.n8n.h")}</H2>
      <p>
        <DownloadButton href={A.n8n} label={file(A.n8n)} /> <DownloadButton href={A.n8nSource} label={file(A.n8nSource)} />
      </p>
      <Md text={t("conn.n8n.p")} />
      <Code lang="bash" code={`mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes\nnpm install ${BASE}${A.n8n}\n# reiniciar n8n / restart n8n`} />

      <H2 id="dynamics365">{t("conn.d365.h")}</H2>
      <p>
        <DownloadButton href={A.dynamics} label={file(A.dynamics)} /> <DownloadButton href={A.powerAutomate} label={file(A.powerAutomate)} />
      </p>
      <Md text={t("conn.d365.p")} />
      <Code
        lang="bash"
        title={t("conn.d365.cmd")}
        code={`DATAVERSE_URL=https://<org>.crm.dynamics.com \\\nDATAVERSE_TOKEN=$(az account get-access-token --resource https://<org>.crm.dynamics.com --query accessToken -o tsv) \\\nnode setup-dataverse.mjs --table opportunity`}
      />

      <H2 id="google-workspace">{t("conn.gws.h")}</H2>
      <p>
        <DownloadButton href={A.googleWorkspace} label={file(A.googleWorkspace)} />
      </p>
      <Md text={t("conn.gws.p")} />
      <Code
        lang="bash"
        title={t("conn.gws.cli")}
        code={`npm install -g @google/clasp && clasp login\nmkdir calasign-gws && cd calasign-gws\nclasp create --type standalone --title "CalaSign"\ncurl -LO ${BASE}${A.googleWorkspace}\nunzip -o ${file(A.googleWorkspace)}\nclasp push --force && clasp open`}
      />
      <Md text={t("conn.gws.publish")} />

      <H2 id="api">{t("conn.api.h")}</H2>
      <Md text={t("conn.api.p")} />
    </DocPage>
  );
}
