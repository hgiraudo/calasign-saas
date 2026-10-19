// Constantes del portal de desarrolladores que dependen de otras piezas (integraciones de IA, artefactos descargables).
// Si cambia una URL o un comando, se ajusta acá y se actualiza todo el portal.
import { MCP_CONFIRM_TOOLS, MCP_TOOLS } from "@calasign/shared";

/** Origen de la API: el mismo de la web (dev.calasign.com, un dominio propio o localhost en desarrollo). */
export const BASE = typeof window !== "undefined" ? window.location.origin : "https://dev.calasign.com";

/** Entorno público de pruebas. */
export const DEV_BASE = "https://dev.calasign.com";

export const MCP_URL = `${BASE}/mcp`;

/** Artefactos descargables que sirve la web (los generan las integraciones de IA). */
export const ARTIFACTS = {
  /** Extensión de Claude Desktop (MCP Bundle). */
  mcpb: "/integrations/calasign.mcpb",
  /** Agent Skill para claude.ai y Claude Code. */
  skillZip: "/integrations/calasign-skill.zip",
  /** Extensión de Gemini CLI. */
  geminiExtensionZip: "/integrations/calasign-gemini-extension.zip",
  /** Manifiesto del complemento de Word. */
  officeManifest: "/integrations/office/manifest.xml",
  /** Manifiesto del complemento de Outlook (un manifiesto XML no puede cubrir Word y Outlook a la vez). */
  outlookManifest: "/integrations/office/manifest-outlook.xml",
  /** Marketplace de plugins de Claude Code. */
  claudeCodeMarketplace: `${BASE}/integrations/claude-code/marketplace.json`,
} as const;

/** Conectores low-code (integrations/connectors, ver docs/CONECTORES.md). La versión del paquete de n8n sigue a integrations/package.json. */
export const CONNECTOR_ARTIFACTS = {
  powerAutomate: "/integrations/connectors/power-automate/calasign-power-automate-connector.zip",
  zapier: "/integrations/connectors/zapier/calasign-zapier-app.zip",
  make: "/integrations/connectors/make/calasign-make-app.zip",
  makeJson: "/integrations/connectors/make/calasign-make-app.json",
  n8n: "/integrations/connectors/n8n/n8n-nodes-calasign-1.0.0.tgz",
  n8nSource: "/integrations/connectors/n8n/n8n-nodes-calasign-source.zip",
  dynamics: "/integrations/connectors/dynamics365/calasign-dynamics365.zip",
  pipedrive: "/integrations/connectors/pipedrive/calasign-pipedrive.zip",
} as const;

/** Comandos para instalar el plugin de Claude Code (se escriben dentro de Claude Code). */
export const CLAUDE_CODE_PLUGIN_INSTALL = `/plugin marketplace add ${ARTIFACTS.claudeCodeMarketplace}
/plugin install calasign@calasign`;

export type McpTool = (typeof MCP_TOOLS)[number];

export const ALL_MCP_TOOLS: McpTool[] = [...MCP_TOOLS];

/** Herramientas agregadas en la versión 1.1 del servidor MCP (se muestran como "nueva"). */
const NEW_MCP_TOOLS: readonly string[] = ["create_envelope", "remind_recipients", "get_account"];

export function mcpToolNeedsConfirm(tool: string): boolean {
  return (MCP_CONFIRM_TOOLS as readonly string[]).includes(tool);
}

export function mcpToolIsNew(tool: string): boolean {
  return NEW_MCP_TOOLS.includes(tool);
}

/**
 * Instalación de los SDKs. Ninguno está publicado todavía en PyPI ni en npm (verificado: ambos 404): se instalan desde una
 * copia del código fuente de CalaSign. Cuando se publiquen, cambiar por `pip install calasign` / `npm install @calasign/sdk`.
 */
export const SDK_INSTALL = {
  python: "pip install ./sdks/python",
  node: "corepack pnpm install && corepack pnpm --filter @calasign/sdk build",
};
