// Sección de /developers sobre el servidor MCP para agentes de IA.
import { MCP_CONFIRM_TOOLS, MCP_TOOLS } from "@calasign/shared";
import { useBillingText } from "../lib/i18n-billing";

const origin = typeof window !== "undefined" ? window.location.origin : "https://dev.calasign.com";

const CLAUDE_CODE = `claude mcp add --transport http calasign ${origin}/mcp \\
  --header "Authorization: Bearer $CALASIGN_API_KEY"`;

const CLAUDE_DESKTOP = `{
  "mcpServers": {
    "calasign": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${origin}/mcp",
               "--header", "Authorization: Bearer \${CALASIGN_API_KEY}"],
      "env": { "CALASIGN_API_KEY": "cs_live_…" }
    }
  }
}`;

const SDK = `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "mi-agente", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("${origin}/mcp"), {
  requestInit: { headers: { Authorization: \`Bearer \${accessToken}\` } },
}));
const env = await client.callTool({ name: "create_envelope_from_template", arguments: {
  templateId, recipients: [{ role: "Cliente", name: "Ana Pérez", email: "ana@example.com" }],
}});
// …mostrarle el resumen al usuario y, si aprueba:
await client.callTool({ name: "send_envelope", arguments: { envelopeId, confirm: true } });`;

function Code({ children }: { children: string }) {
  return (
    <pre className="card pad" style={{ overflowX: "auto", fontSize: 13, lineHeight: 1.45, margin: 0 }}>
      <code>{children}</code>
    </pre>
  );
}

export function McpDocs() {
  const b = useBillingText();
  return (
    <section className="stack" style={{ marginTop: 28 }} id="mcp">
      <h2>{b("mcp.title")}</h2>
      <p>{b("mcp.intro")}</p>
      <p className="small">
        <code>POST {origin}/mcp</code> · Streamable HTTP · {b("mcp.auth")}
      </p>
      <p className="small">
        {b("mcp.tools")}:{" "}
        {MCP_TOOLS.map((tool) => (
          <code key={tool} style={{ marginRight: 8 }}>
            {tool}
            {MCP_CONFIRM_TOOLS.includes(tool) ? " ⚠" : ""}
          </code>
        ))}
      </p>
      <p className="small muted">⚠ {b("mcp.confirm")}</p>
      <h3 className="h3">{b("mcp.claudeCode")}</h3>
      <Code>{CLAUDE_CODE}</Code>
      <h3 className="h3">{b("mcp.claudeDesktop")}</h3>
      <Code>{CLAUDE_DESKTOP}</Code>
      <h3 className="h3">SDK (TypeScript)</h3>
      <Code>{SDK}</Code>
    </section>
  );
}
