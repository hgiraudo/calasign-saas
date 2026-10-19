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
  /** Manifiesto del complemento de Word y Outlook. */
  officeManifest: "/integrations/office/manifest.xml",
  /** Marketplace de plugins de Claude Code. */
  claudeCodeMarketplace: `${BASE}/integrations/claude-code/marketplace.json`,
} as const;

/** Comandos para instalar el plugin de Claude Code (se escriben dentro de Claude Code). */
export const CLAUDE_CODE_PLUGIN_INSTALL = `/plugin marketplace add ${ARTIFACTS.claudeCodeMarketplace}
/plugin install calasign@calasign`;

/**
 * Herramientas MCP que se están agregando en paralelo (todavía no figuran en MCP_TOOLS de @calasign/shared).
 * Cuando se publiquen, MCP_TOOLS las incluye y esta lista se puede vaciar: el portal muestra la unión sin duplicar.
 */
export const MCP_TOOLS_PENDING = ["create_envelope", "remind_recipients", "get_account"] as const;

/** Herramientas nuevas que exigen confirm: true (ajustar si la implementación final decide otra cosa). */
export const MCP_CONFIRM_TOOLS_PENDING: readonly string[] = ["remind_recipients"];

export type McpTool = (typeof MCP_TOOLS)[number] | (typeof MCP_TOOLS_PENDING)[number];

export const ALL_MCP_TOOLS: McpTool[] = [...new Set<McpTool>([...MCP_TOOLS, ...MCP_TOOLS_PENDING])];

export function mcpToolNeedsConfirm(tool: string): boolean {
  return (MCP_CONFIRM_TOOLS as readonly string[]).includes(tool) || MCP_CONFIRM_TOOLS_PENDING.includes(tool);
}

/** true si la herramienta todavía no está en el contrato compartido (se muestra como "nueva"). */
export function mcpToolIsNew(tool: string): boolean {
  return !(MCP_TOOLS as readonly string[]).includes(tool);
}

/**
 * Instalación de los SDKs. Ninguno está publicado todavía en PyPI ni en npm (verificado: ambos 404): se instalan desde una
 * copia del código fuente de CalaSign. Cuando se publiquen, cambiar por `pip install calasign` / `npm install @calasign/sdk`.
 */
export const SDK_INSTALL = {
  python: "pip install ./sdks/python",
  node: "corepack pnpm install && corepack pnpm --filter @calasign/sdk build",
};
