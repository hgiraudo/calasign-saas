// CORS abierto (sin cookies) para lo que usan los clientes MCP desde un navegador (MCP Inspector, clientes web):
// metadatos OAuth, registro dinámico, token/revocación y el propio /mcp. Ninguno usa la cookie de sesión (son con
// Bearer o credenciales del cliente), así que `*` sin Allow-Credentials no expone nada de la sesión web.
import type { FastifyInstance } from "fastify";

export const CORS_PATHS = [
  "/mcp",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];
const PATHS = new Set(CORS_PATHS);

export function registerConnectorCors(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!PATHS.has(req.url.split("?")[0])) return;
    const h: Record<string, string> = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
      // helmet pone same-origin; estos recursos son para otros orígenes.
      "cross-origin-resource-policy": "cross-origin",
    };
    if (req.method === "OPTIONS") {
      h["access-control-allow-methods"] = "GET, POST, OPTIONS";
      h["access-control-allow-headers"] = "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID";
      h["access-control-max-age"] = "86400";
    }
    // /mcp responde por reply.raw (reply.hijack): los encabezados van también al objeto crudo.
    for (const [k, v] of Object.entries(h)) {
      reply.header(k, v);
      reply.raw.setHeader(k, v);
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
  });
  for (const p of CORS_PATHS) app.options(p, async (_req, reply) => reply.code(204).send());
}
