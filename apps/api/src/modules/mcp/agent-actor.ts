// El servidor MCP llama a la API por dentro (app.inject) con la credencial del agente. Esos pedidos llevan un
// secreto que solo existe en memoria de este proceso: si coincide, el actor de la evidencia pasa a ser
// "agente IA (<cliente>)". Desde la red no se puede falsificar (el secreto no sale nunca del proceso).
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AuthContext } from "../context";

const SECRET = randomBytes(32).toString("base64url");
export const AGENT_SECRET_HEADER = "x-calasign-agent-secret";
export const AGENT_NAME_HEADER = "x-calasign-agent-name";

export function agentHeaders(name: string): Record<string, string> {
  return { [AGENT_SECRET_HEADER]: SECRET, [AGENT_NAME_HEADER]: encodeURIComponent(name.slice(0, 80)) };
}

export function applyAgentActor(req: FastifyRequest, a: AuthContext) {
  const got = req.headers[AGENT_SECRET_HEADER];
  if (typeof got !== "string") return;
  // Largo en bytes (no en caracteres): con caracteres multibyte timingSafeEqual lanzaba y el pedido respondía 500.
  const gotBuf = Buffer.from(got);
  const secretBuf = Buffer.from(SECRET);
  if (gotBuf.length !== secretBuf.length || !timingSafeEqual(gotBuf, secretBuf)) return;
  let name = "agente";
  try {
    name = decodeURIComponent(String(req.headers[AGENT_NAME_HEADER] ?? "agente")).slice(0, 80);
  } catch {
    /* nombre inválido: se usa el genérico */
  }
  a.actor = { ...a.actor, label: `agente IA (${name}) — ${a.actor.label ?? a.actor.type}` };
}
