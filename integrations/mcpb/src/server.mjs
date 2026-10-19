// Servidor MCP local (stdio) de la extensión de Claude Desktop (.mcpb).
// No implementa herramientas propias: es un proxy hacia el servidor MCP remoto de CalaSign (Streamable HTTP en
// <base>/mcp) con la API key que la persona carga al instalar la extensión. Así las herramientas, sus esquemas y
// anotaciones (readOnlyHint, destructiveHint…) son siempre las del servidor, sin tener que publicar otra versión.
//
// Variables (las arma Claude Desktop desde user_config del manifest):
//   CALASIGN_API_KEY   API key de la organización (cs_live_… / cs_test_…) o access token OAuth. Obligatoria.
//   CALASIGN_BASE_URL  Opcional; por defecto la del build (__DEFAULT_BASE_URL__).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const VERSION = "__VERSION__";
const DEFAULT_BASE_URL = "__DEFAULT_BASE_URL__";

// Claude Desktop deja el texto literal "${user_config.x}" si el campo opcional quedó vacío: se trata como ausente.
const clean = (v) => {
  const s = (v ?? "").trim();
  return !s || s.startsWith("${") ? "" : s;
};
const apiKey = clean(process.env.CALASIGN_API_KEY);
const baseUrl = (clean(process.env.CALASIGN_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, "");

// stdout es el canal del protocolo: los mensajes para humanos van a stderr (Claude Desktop los guarda en el log).
const log = (...a) => console.error("[calasign]", ...a);

const INSTRUCTIONS =
  "CalaSign: firma electrónica. Estas herramientas hablan con la cuenta de CalaSign de la persona. Enviar o anular un " +
  "sobre tiene efecto real (llegan correos/WhatsApp a personas): antes de send_envelope o void_envelope con confirm=true " +
  "mostrá el resumen y pedí aprobación explícita. Nunca inventes correos. Respondé en el idioma de la persona.";

let upstream = null; // Promise<Client>

function connectUpstream() {
  if (!apiKey) {
    throw new McpError(ErrorCode.InvalidRequest, "Falta la API key de CalaSign: configurala en Ajustes → Extensiones → CalaSign.");
  }
  if (!upstream) {
    upstream = (async () => {
      const client = new Client({ name: "calasign-desktop", version: VERSION });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": `calasign-mcpb/${VERSION}` } },
      });
      await client.connect(transport);
      return client;
    })();
    // Si falla (red, key inválida), el próximo pedido vuelve a intentar.
    upstream.catch(() => {
      upstream = null;
    });
  }
  return upstream;
}

/** Traduce los errores del servidor remoto a algo que la persona entienda. */
function explain(err) {
  const msg = String(err?.message ?? err);
  if (/\b401\b|unauthorized/i.test(msg)) return "CalaSign rechazó la API key (401). Revisala en Ajustes → Extensiones → CalaSign.";
  if (/\b402\b|plan_limit/i.test(msg)) return "El plan de la organización no incluye acceso por API/MCP (402).";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return `No se pudo conectar con ${baseUrl}: ${msg}`;
  return msg;
}

/**
 * Ejecuta contra el remoto; si la conexión quedó vieja (el servidor reinició), reconecta una vez.
 * Un timeout solo se reintenta en pedidos idempotentes: en tools/call el servidor puede haber ejecutado la
 * herramienta igual (create_envelope con un PDF grande, remind_recipients), y repetirla duplicaría el sobre o el aviso.
 */
async function withUpstream(fn, { retryTimeout = true } = {}) {
  try {
    return await fn(await connectUpstream());
  } catch (err) {
    if (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed && (err.code !== ErrorCode.RequestTimeout || !retryTimeout)) throw err;
    upstream = null;
    return fn(await connectUpstream());
  }
}

const server = new Server({ name: "calasign", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  try {
    // Se pasa el resultado tal cual: nombre, título, descripción, inputSchema y annotations del servidor.
    return await withUpstream((c) => c.listTools(req.params));
  } catch (err) {
    log("tools/list falló:", err?.message ?? err);
    throw err instanceof McpError ? err : new McpError(ErrorCode.InternalError, explain(err));
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await withUpstream((c) => c.callTool(req.params), { retryTimeout: false });
  } catch (err) {
    log(`tools/call ${req.params.name} falló:`, err?.message ?? err);
    // Error de la herramienta (no de protocolo): el modelo lo ve y se lo puede explicar a la persona.
    return { isError: true, content: [{ type: "text", text: explain(err) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`listo (${baseUrl}/mcp${apiKey ? "" : ", sin API key"})`);

const shutdown = async () => {
  try {
    const c = await upstream;
    await c?.close();
  } catch {
    /* nada */
  }
  process.exit(0);
};
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
