// Sección "IA y agentes": servidor MCP y cómo conectarlo desde Claude, ChatGPT, Gemini y Office.
import { useDocsText, type DocsKey } from "../../../lib/i18n-docs";
import { ALL_MCP_TOOLS, ARTIFACTS, BASE, CLAUDE_CODE_PLUGIN_INSTALL, MCP_URL, mcpToolIsNew, mcpToolNeedsConfirm } from "../constants";
import { Badge, Callout, Card, CardGrid, Code, CodeTabs, DataTable, DocPage, H2, H3, Md, SmartLink, Step, Steps } from "../ui";

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

// ───────────────────────────── Visión general ─────────────────────────────

export function AiOverviewPage() {
  const t = useDocsText();
  return (
    <DocPage title={t("ai.title")} lead={t("ai.lead")}>
      <H2 id="integrations">{t("ai.cards.h")}</H2>
      <CardGrid>
        <Card icon="⌁" title={t("ai.card.mcp.t")} to="/developers/ai/mcp" action={<ActionLink to="/developers/ai/mcp" label={t("ai.card.mcp.a")} />}>
          {t("ai.card.mcp.d")}
        </Card>
        <Card icon="✳" title="Claude" to="/developers/ai/claude" action={<ActionLink to="/developers/ai/claude#connector" label={t("ai.card.claude.a")} />}>
          {t("ai.card.claude.d")}
        </Card>
        <Card icon="⬢" title={t("ai.card.desktop.t")} to="/developers/ai/claude#desktop" action={<DownloadButton href={ARTIFACTS.mcpb} label="calasign.mcpb" />}>
          {t("ai.card.desktop.d")}
        </Card>
        <Card icon="❯_" title="Claude Code" to="/developers/ai/claude#code" action={<ActionLink to="/developers/ai/claude#code" label={t("ai.card.code.a")} />}>
          {t("ai.card.code.d")}
        </Card>
        <Card icon="◆" title={t("ai.card.skill.t")} to="/developers/ai/claude#skill" action={<DownloadButton href={ARTIFACTS.skillZip} label="calasign-skill.zip" />}>
          {t("ai.card.skill.d")}
        </Card>
        <Card icon="◎" title="ChatGPT" to="/developers/ai/chatgpt" action={<ActionLink to="/developers/ai/chatgpt" label={t("ai.card.gpt.a")} />}>
          {t("ai.card.gpt.d")}
        </Card>
        <Card icon="✧" title="Gemini" to="/developers/ai/gemini" action={<DownloadButton href={ARTIFACTS.geminiExtensionZip} label={t("ai.card.gem.a")} />}>
          {t("ai.card.gem.d")}
        </Card>
        <Card icon="▤" title={t("ai.card.office.t")} to="/developers/ai/office" action={<DownloadButton href={ARTIFACTS.officeManifest} label="manifest.xml" />}>
          {t("ai.card.office.d")}
        </Card>
      </CardGrid>

      <H2 id="how">{t("ai.how.h")}</H2>
      <Md text={t("ai.how.p")} />
      <Callout kind="tip">{t("ai.how.tip")}</Callout>
    </DocPage>
  );
}

// ───────────────────────────── Servidor MCP ─────────────────────────────

export function McpPage() {
  const t = useDocsText();
  const sdk = `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("${MCP_URL}"), {
  requestInit: { headers: { Authorization: \`Bearer \${process.env.CALASIGN_API_KEY}\` } },
}));

const { tools } = await client.listTools();
const draft = await client.callTool({
  name: "create_envelope_from_template",
  arguments: { templateId, recipients: [{ role: "Cliente", name: "Ana Pérez", email: "ana@example.com" }] },
});
// ${t("mcp.sdk.c.approve")}
await client.callTool({ name: "send_envelope", arguments: { envelopeId, confirm: true } });`;

  return (
    <DocPage title={t("mcp.title")} lead={t("mcp.lead")}>
      <H2 id="connect">{t("mcp.connect.h")}</H2>
      <DataTable
        head={[t("mcp.col.prop"), t("mcp.col.value")]}
        rows={[
          ["URL", <code key="u">{MCP_URL}</code>],
          [t("mcp.transport"), t("mcp.transport.v")],
          [t("mcp.auth.row"), t("mcp.auth.row.v")],
          [t("mcp.plan"), t("mcp.plan.v")],
        ]}
      />
      <Md text={t("mcp.connect.p")} />

      <H2 id="auth">{t("mcp.auth.h")}</H2>
      <Md text={t("mcp.auth.p")} />
      <Code
        lang="http"
        title={t("mcp.auth.401")}
        code={`HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`}
      />

      <H2 id="tools">{t("mcp.tools.h")}</H2>
      <Md text={t("mcp.tools.p")} />
      <DataTable
        head={[t("mcp.col.tool"), t("mcp.col.does"), t("mcp.col.confirm")]}
        rows={ALL_MCP_TOOLS.map((tool) => [
          <span key="n">
            <code>{tool}</code> {mcpToolIsNew(tool) && <Badge tone="new">{t("ui.new")}</Badge>}
          </span>,
          <Md key="d" text={t(`mcp.tool.${tool}` as DocsKey)} />,
          mcpToolNeedsConfirm(tool) ? <Badge key="c" tone="warn">confirm: true</Badge> : "—",
        ])}
      />

      <H2 id="safety">{t("mcp.safety.h")}</H2>
      <Md text={t("mcp.safety.p")} />

      <H2 id="inspector">{t("mcp.inspector.h")}</H2>
      <Md text={t("mcp.inspector.p")} />
      <Code
        lang="bash"
        code={`# ${t("mcp.inspector.c.ui")}
npx @modelcontextprotocol/inspector --transport http --server-url ${MCP_URL} \\
  --header "Authorization: Bearer $CALASIGN_API_KEY"

# ${t("mcp.inspector.c.cli")}
npx @modelcontextprotocol/inspector --cli --transport http --server-url ${MCP_URL} \\
  --header "Authorization: Bearer $CALASIGN_API_KEY" --method tools/list`}
      />

      <H2 id="sdk">{t("mcp.sdk.h")}</H2>
      <Md text={t("mcp.sdk.p")} />
      <Code lang="ts" code={sdk} />
    </DocPage>
  );
}

// ───────────────────────────── Claude ─────────────────────────────

export function ClaudePage() {
  const t = useDocsText();
  const apiCurl = `curl https://api.anthropic.com/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: $ANTHROPIC_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "anthropic-beta: mcp-client-2025-11-20" \\
  -d '{
    "model": "claude-opus-5-5",
    "max_tokens": 1024,
    "messages": [{ "role": "user", "content": "${t("ai.c.prompt")}" }],
    "mcp_servers": [{
      "type": "url",
      "url": "${MCP_URL}",
      "name": "calasign",
      "authorization_token": "'"$CALASIGN_API_KEY"'"
    }],
    "tools": [{ "type": "mcp_toolset", "mcp_server_name": "calasign" }]
  }'`;
  const apiPy = `import os
import anthropic

client = anthropic.Anthropic()
response = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "${t("ai.c.prompt")}"}],
    mcp_servers=[{
        "type": "url",
        "url": "${MCP_URL}",
        "name": "calasign",
        "authorization_token": os.environ["CALASIGN_API_KEY"],
    }],
    tools=[{"type": "mcp_toolset", "mcp_server_name": "calasign"}],
    betas=["mcp-client-2025-11-20"],
)
print(response.content)`;

  return (
    <DocPage title={t("claude.title")} lead={t("claude.lead")}>
      <H2 id="connector">{t("claude.connector.h")}</H2>
      <Md text={t("claude.connector.p")} />
      <Steps>
        <Step title={t("claude.connector.s1")} />
        <Step title={t("claude.connector.s2")}>
          <Code lang="text" code={MCP_URL} />
        </Step>
        <Step title={t("claude.connector.s3")} />
        <Step title={t("claude.connector.s4")} />
      </Steps>
      <Md text={t("claude.connector.team")} />
      <Callout kind="info">{t("claude.connector.key")}</Callout>

      <H2 id="desktop">{t("claude.desktop.h")}</H2>
      <Md text={t("claude.desktop.p")} />
      <p>
        <DownloadButton href={ARTIFACTS.mcpb} label={`${t("ui.download")} calasign.mcpb`} />
      </p>
      <Steps>
        <Step title={t("claude.desktop.s1")} />
        <Step title={t("claude.desktop.s2")} />
        <Step title={t("claude.desktop.s3")} />
      </Steps>

      <H2 id="code">{t("claude.code.h")}</H2>
      <Md text={t("claude.code.p")} />
      <CodeTabs
        tabs={[
          { id: "oauth", label: "OAuth", lang: "bash", code: `claude mcp add --transport http calasign ${MCP_URL}\n# ${t("claude.code.c.login")}\n/mcp` },
          {
            id: "apikey",
            label: "API key",
            lang: "bash",
            code: `claude mcp add --transport http calasign ${MCP_URL} \\\n  --header "Authorization: Bearer $CALASIGN_API_KEY"`,
          },
        ]}
      />
      <H3 id="plugin">{t("claude.plugin.h")}</H3>
      <Md text={t("claude.plugin.p")} />
      <Code lang="bash" code={CLAUDE_CODE_PLUGIN_INSTALL} title="Claude Code" />

      <H2 id="skill">{t("claude.skill.h")}</H2>
      <Md text={t("claude.skill.p")} />
      <p>
        <DownloadButton href={ARTIFACTS.skillZip} label={`${t("ui.download")} calasign-skill.zip`} />
      </p>
      <Md text={t("claude.skill.install")} />
      <Code lang="bash" code={`mkdir -p ~/.claude/skills && unzip calasign-skill.zip -d ~/.claude/skills/`} title="Claude Code" />

      <H2 id="api">{t("claude.api.h")}</H2>
      <Md text={t("claude.api.p")} />
      <CodeTabs
        tabs={[
          { id: "curl", label: "curl", lang: "bash", code: apiCurl },
          { id: "python", label: "Python", lang: "python", code: apiPy },
        ]}
      />
    </DocPage>
  );
}

// ───────────────────────────── ChatGPT ─────────────────────────────

export function ChatGptPage() {
  const t = useDocsText();
  const curl = `curl https://api.openai.com/v1/responses \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $OPENAI_API_KEY" \\
  -d '{
    "model": "gpt-6-astra",
    "tools": [{
      "type": "mcp",
      "server_label": "calasign",
      "server_description": "CalaSign e-signature",
      "server_url": "${MCP_URL}",
      "authorization": "'"$CALASIGN_API_KEY"'",
      "require_approval": "never"
    }],
    "input": "${t("ai.c.prompt")}"
  }'`;
  const py = `import os
from openai import OpenAI

client = OpenAI()
resp = client.responses.create(
    model="gpt-6-astra",
    tools=[{
        "type": "mcp",
        "server_label": "calasign",
        "server_url": "${MCP_URL}",
        "authorization": os.environ["CALASIGN_API_KEY"],
        "require_approval": "never",
    }],
    input="${t("ai.c.prompt")}",
)
print(resp.output_text)`;
  return (
    <DocPage title={t("gpt.title")} lead={t("gpt.lead")}>
      <H2 id="connector">{t("gpt.connector.h")}</H2>
      <Md text={t("gpt.connector.p")} />
      <Steps>
        <Step title={t("gpt.connector.s1")} />
        <Step title={t("gpt.connector.s2")}>
          <Code lang="text" code={MCP_URL} />
        </Step>
        <Step title={t("gpt.connector.s3")} />
        <Step title={t("gpt.connector.s4")} />
      </Steps>
      <Callout kind="info">{t("gpt.connector.note")}</Callout>

      <H2 id="api">{t("gpt.api.h")}</H2>
      <Md text={t("gpt.api.p")} />
      <CodeTabs
        tabs={[
          { id: "curl", label: "curl", lang: "bash", code: curl },
          { id: "python", label: "Python", lang: "python", code: py },
        ]}
      />
    </DocPage>
  );
}

// ───────────────────────────── Gemini ─────────────────────────────

export function GeminiPage() {
  const t = useDocsText();
  const settings = `{
  "mcpServers": {
    "calasign": {
      "httpUrl": "${MCP_URL}",
      "headers": { "Authorization": "Bearer cs_test_…" }
    }
  }
}`;
  const genai = `import asyncio
import httpx2
from google import genai
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client  # mcp >= 2

client = genai.Client()

async def main():
    async with httpx2.AsyncClient(headers={"Authorization": "Bearer cs_test_…"}) as http:
        async with streamable_http_client("${MCP_URL}", http_client=http,
                                          terminate_on_close=False) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                r = await client.aio.models.generate_content(
                    model="gemini-flash-latest",
                    contents="${t("ai.c.prompt")}",
                    config=genai.types.GenerateContentConfig(tools=[session]),
                )
                print(r.text)

asyncio.run(main())`;
  return (
    <DocPage title={t("gem.title")} lead={t("gem.lead")}>
      <H2 id="cli">{t("gem.cli.h")}</H2>
      <Md text={t("gem.cli.p")} />
      <CodeTabs
        tabs={[
          { id: "oauth", label: "OAuth", lang: "bash", code: `gemini mcp add --transport http --scope user calasign ${MCP_URL}\n# ${t("gem.cli.c.login")}\n/mcp auth calasign` },
          {
            id: "apikey",
            label: "API key",
            lang: "bash",
            code: `gemini mcp add --transport http --scope user \\\n  --header "Authorization: Bearer $CALASIGN_API_KEY" calasign ${MCP_URL}`,
          },
          { id: "json", label: "settings.json", lang: "json", code: settings },
        ]}
      />
      <Callout kind="info">{t("gem.cli.note")}</Callout>

      <H2 id="extension">{t("gem.ext.h")}</H2>
      <Md text={t("gem.ext.p")} />
      <p>
        <DownloadButton href={ARTIFACTS.geminiExtensionZip} label={`${t("ui.download")} calasign-gemini-extension.zip`} />
      </p>
      <Code
        lang="bash"
        code={`unzip calasign-gemini-extension.zip -d calasign-gemini-extension
gemini extensions install ./calasign-gemini-extension`}
      />

      <H2 id="api">{t("gem.api.h")}</H2>
      <Md text={t("gem.api.p")} />
      <Code lang="python" code={genai} />
    </DocPage>
  );
}

// ───────────────────────────── Word y Outlook ─────────────────────────────

export function OfficePage() {
  const t = useDocsText();
  return (
    <DocPage title={t("office.title")} lead={t("office.lead")}>
      <p>
        <DownloadButton href={ARTIFACTS.officeManifest} label={`${t("ui.download")} manifest.xml (Word)`} />{" "}
        <DownloadButton href={ARTIFACTS.outlookManifest} label={`${t("ui.download")} manifest-outlook.xml (Outlook)`} />
      </p>
      <H2 id="what">{t("office.what.h")}</H2>
      <Md text={t("office.what.p")} />

      <H2 id="word">{t("office.word.h")}</H2>
      <Md text={t("office.word.p")} />

      <H2 id="outlook">{t("office.outlook.h")}</H2>
      <Md text={t("office.outlook.p")} />

      <H2 id="admin">{t("office.admin.h")}</H2>
      <Md text={t("office.admin.p")} />
      <Code lang="text" code={`${BASE}${ARTIFACTS.officeManifest}\n${BASE}${ARTIFACTS.outlookManifest}`} title={t("office.admin.url")} />
    </DocPage>
  );
}
