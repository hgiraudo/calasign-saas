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
export const unauthorized = () => new AppError(401, "unauthorized", "Autenticación requerida");
export const forbidden = (message = "No autorizado") => new AppError(403, "forbidden", message);

/**
 * Control de edición concurrente: si el cliente manda X-Expected-Updated-At (el updatedAt que cargó) y el recurso
 * cambió desde entonces (otra pestaña u otra persona), 409 version_changed en vez de pisar esos cambios. Sin el
 * encabezado no se controla (compatibilidad con integraciones).
 */
export function assertNotStale(headers: Record<string, unknown>, current: Date | string | null | undefined) {
  const raw = headers["x-expected-updated-at"];
  const expected = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(expected) || current == null) return;
  const now = new Date(current).getTime();
  // Milisegundos: la API devuelve las fechas con esa precisión y la base guarda microsegundos.
  if (Math.floor(now) - expected >= 1) {
    throw new AppError(409, "version_changed", "Este borrador cambió en otra pestaña o lo editó otra persona: recargá para ver la versión actual", {
      updatedAt: new Date(current).toISOString(),
    });
  }
}
