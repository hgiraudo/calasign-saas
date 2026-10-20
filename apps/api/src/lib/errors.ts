export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Recurso") => new AppError(404, "not_found", `${what} no encontrado`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
/**
 * 429 del límite de pedidos por IP (@fastify/rate-limit, global y por ruta): código rate_limited y mensaje en español
 * (el del plugin era bad_request con "Rate limit exceeded, retry in 1 minute"). Retry-After lo pone el plugin.
 */
export function rateLimitError(_req: unknown, ctx: { statusCode: number; ttl: number }) {
  const seconds = Math.max(1, Math.ceil(ctx.ttl / 1000));
  return new AppError(ctx.statusCode, "rate_limited", `Demasiados pedidos seguidos: esperá ${seconds} s y reintentá`, { retryAfterSeconds: seconds });
}

export const unauthorized = () => new AppError(401, "unauthorized", "Autenticación requerida");
export const forbidden = (message = "No autorizado") => new AppError(403, "forbidden", message);

/**
 * Control de edición concurrente: si el cliente manda X-Expected-Updated-At (el updatedAt que cargó) y el recurso
 * cambió desde entonces (otra pestaña u otra persona), 409 version_changed en vez de pisar esos cambios. Sin el
 * encabezado no se controla (compatibilidad con integraciones). `message` reemplaza al texto de borradores y plantillas
 * donde no aplica (anular o recordar un sobre ya enviado).
 */
export const STALE_DRAFT_MESSAGE = "Este borrador cambió en otra pestaña o lo editó otra persona: recargá para ver la versión actual";
export const STALE_GENERIC_MESSAGE = "El sobre cambió desde que lo viste (otra pestaña, otra persona o un firmante): revisalo y repetí la acción";
export function assertNotStale(headers: Record<string, unknown>, current: Date | string | null | undefined, message = STALE_DRAFT_MESSAGE) {
  const raw = headers["x-expected-updated-at"];
  const expected = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(expected) || current == null) return;
  const now = new Date(current).getTime();
  // Milisegundos: la API devuelve las fechas con esa precisión (y pg/PGlite devuelven Date truncado a ms). Cualquier
  // diferencia es un cambio: updated_at = now() es la hora de inicio de la transacción y otra que tomó el lock después
  // puede dejarlo más viejo que el que tiene el cliente.
  if (Math.floor(now) !== expected) {
    throw new AppError(409, "version_changed", message, {
      updatedAt: new Date(current).toISOString(),
    });
  }
}
