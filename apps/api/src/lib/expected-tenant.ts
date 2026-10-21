// Varias pestañas con la misma cookie de sesión: cambiar de organización (o aceptar una invitación) en una mueve la
// sesión del servidor y las demás siguen mostrando la organización anterior; lo que guardaban iba a parar a la nueva.
// La web manda en cada pedido que modifica `x-calasign-tenant: <organización que cargó la página>`; si la sesión ya
// está en otra, se rechaza con 409 tenant_mismatch (la web recarga). Solo sesiones de navegador (cookie): una API key
// o un token OAuth tienen una organización fija y el encabezado se ignora.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../infra/db";
import { sessionCookieToken } from "../modules/context";
import { AppError } from "./errors";
import { bearerToken, requestPath, sha256Hex } from "./util";

export const EXPECTED_TENANT_HEADER = "x-calasign-tenant";

/** Pedidos donde el encabezado no aplica: cerrar sesión siempre se puede, desde cualquier pestaña. */
const EXEMPT = new Set(["/v1/auth/logout"]);

export async function assertExpectedTenant(db: Db, req: FastifyRequest): Promise<void> {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const raw = req.headers[EXPECTED_TENANT_HEADER];
  const expected = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!expected) return;
  const path = requestPath(req);
  if (!path.startsWith("/v1/") || EXEMPT.has(path)) return;
  if (bearerToken(req.headers.authorization)) return; // API key / OAuth: la credencial define la organización (como en authenticate)
  const token = sessionCookieToken(req);
  if (!token) return;
  const row = await db.one<{ tenant_id: string }>(`SELECT tenant_id FROM sessions WHERE token_hash = $1 AND expires_at > now()`, [sha256Hex(token)]);
  if (!row) return; // sin sesión válida: la ruta responde 401
  if (row.tenant_id !== expected) {
    throw new AppError(409, "tenant_mismatch", "La sesión cambió de organización en otra pestaña: recargá la página para seguir");
  }
}

export function registerExpectedTenantCheck(app: FastifyInstance, db: Db) {
  app.addHook("onRequest", async (req) => assertExpectedTenant(db, req));
}
