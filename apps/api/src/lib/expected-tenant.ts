// Varias pestañas con la misma cookie de sesión: cambiar de organización (o aceptar una invitación, o entrar con otra
// cuenta) en una mueve la sesión del servidor y las demás siguen mostrando la anterior; lo que guardaban iba a parar a
// la nueva. La web manda en cada pedido autenticado que modifica `x-calasign-tenant: <organización que cargó la página>`
// y `x-calasign-user: <usuario>`; si la sesión ya está en otra organización o es de otra cuenta, se rechaza con 409
// tenant_mismatch (la web recarga). Lo controla authenticate() (context.ts) en la rama de la cookie, con la sesión ya
// cargada: sin consulta extra, después del límite de pedidos, y solo en rutas que autentican (las públicas de firma,
// verificación o invitaciones no pasan por acá). Una API key o un token OAuth tienen una organización fija y los
// encabezados se ignoran.
import type { FastifyRequest } from "fastify";
import { AppError } from "./errors";
import { requestPath } from "./util";

export const EXPECTED_TENANT_HEADER = "x-calasign-tenant";
export const EXPECTED_USER_HEADER = "x-calasign-user";

/** Pedidos donde el encabezado no aplica: cerrar sesión siempre se puede, desde cualquier pestaña. */
const EXEMPT = new Set(["/v1/auth/logout"]);

function header(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
}

/** Sesión de navegador ya autenticada: 409 tenant_mismatch si la pestaña esperaba otra organización u otra cuenta. */
export function assertExpectedSession(req: FastifyRequest, session: { tenantId: string; userId: string }): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const tenant = header(req, EXPECTED_TENANT_HEADER);
  const user = header(req, EXPECTED_USER_HEADER);
  if (!tenant && !user) return;
  if (EXEMPT.has(requestPath(req))) return;
  if ((tenant && tenant !== session.tenantId) || (user && user !== session.userId)) {
    throw new AppError(409, "tenant_mismatch", "La sesión cambió de organización o de cuenta en otra pestaña: recargá la página para seguir");
  }
}
