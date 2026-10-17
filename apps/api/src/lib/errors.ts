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
