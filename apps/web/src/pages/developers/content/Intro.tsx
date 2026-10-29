import { useDocsText } from "../../../lib/i18n-docs";
import { BASE, MCP_URL } from "../constants";
import { Callout, Card, CardGrid, CodeTabs, DataTable, DocPage, H2, Md } from "../ui";
import { apiTabs } from "../samples";

export function IntroPage() {
  const t = useDocsText();
  return (
    <DocPage title={t("intro.title")} lead={t("intro.lead")}>
      <H2 id="what-you-can-build">{t("intro.build.h")}</H2>
      <CardGrid>
        <Card icon="✍" title={t("intro.build.send.t")} to="/developers/quickstart">
          {t("intro.build.send.d")}
        </Card>
        <Card icon="▣" title={t("intro.build.embed.t")} to="/developers/guides/embedded-signing">
          {t("intro.build.embed.d")}
        </Card>
        <Card icon="⇄" title={t("intro.build.webhooks.t")} to="/developers/webhooks">
          {t("intro.build.webhooks.d")}
        </Card>
        <Card icon="❏" title={t("intro.build.templates.t")} to="/developers/guides/templates">
          {t("intro.build.templates.d")}
        </Card>
        <Card icon="✦" title={t("intro.build.ai.t")} to="/developers/ai">
          {t("intro.build.ai.d")}
        </Card>
        <Card icon="⟨⟩" title={t("intro.build.xml.t")} to="/developers/api/firma-xml">
          {t("intro.build.xml.d")}
        </Card>
      </CardGrid>

      <H2 id="base-url">{t("intro.base.h")}</H2>
      <Md text={t("intro.base.p")} />
      <DataTable
        head={[t("intro.base.col.what"), t("intro.base.col.url")]}
        rows={[
          [t("intro.base.api"), <code key="a">{BASE}/v1</code>],
          [
            t("intro.base.spec"),
            <a key="b" href="/v1/openapi.json">
              {BASE}/v1/openapi.json
            </a>,
          ],
          [t("intro.base.mcp"), <code key="c">{MCP_URL}</code>],
          [t("intro.base.oauth"), <code key="d">{BASE}/oauth/authorize · /oauth/token</code>],
        ]}
      />
      <Md text={t("intro.base.conventions")} />
      <CodeTabs tabs={apiTabs({ method: "GET", path: "/v1/me" })} />

      <H2 id="environments">{t("intro.env.h")}</H2>
      <Md text={t("intro.env.p")} />
      <Callout kind="tip" title={t("intro.env.mailbox.t")}>
        {t("intro.env.mailbox.p")}
      </Callout>

      <H2 id="versioning">{t("intro.version.h")}</H2>
      <Md text={t("intro.version.p")} />

      <H2 id="next">{t("intro.next.h")}</H2>
      <Md text={t("intro.next.p")} />
    </DocPage>
  );
}
