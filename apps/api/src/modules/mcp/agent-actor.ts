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

/** Pedido interno del servidor MCP (app.inject con el secreto de este proceso): no se puede falsificar desde la red. */
export function isInternalAgentRequest(req: FastifyRequest): boolean {
  const got = req.headers[AGENT_SECRET_HEADER];
  if (typeof got !== "string") return false;
  // Largo en bytes (no en caracteres): con caracteres multibyte timingSafeEqual lanzaba y el pedido respondía 500.
  const gotBuf = Buffer.from(got);
  const secretBuf = Buffer.from(SECRET);
  return gotBuf.length === secretBuf.length && timingSafeEqual(gotBuf, secretBuf);
}

export function applyAgentActor(req: FastifyRequest, a: AuthContext) {
  if (!isInternalAgentRequest(req)) return;
  let name = "agente";
  try {
    name = decodeURIComponent(String(req.headers[AGENT_NAME_HEADER] ?? "agente")).slice(0, 80);
  } catch {
    /* nombre inválido: se usa el genérico */
  }
  a.actor = { ...a.actor, label: `agente IA (${name}) — ${a.actor.label ?? a.actor.type}` };
}
