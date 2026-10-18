// Cliente HTTP mínimo para la API v1 (mismo origen, cookie de sesión).
import type { ApiError } from "@calasign/shared";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const UNAUTHORIZED_EVENT = "calasign:unauthorized";

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      credentials: "include",
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new HttpError(0, "network_error", "No se pudo conectar con el servidor.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const err = (data as ApiError | undefined)?.error;
    // Un 401 en medio de un flujo puede ser la sesión del remitente que venció o se cerró (p. ej. al activar SSO
    // obligatorio): AuthProvider revisa /v1/me y, si la sesión ya no existe, manda al login. Un 401 de firmante
    // (OTP) no cierra nada porque /v1/me sigue respondiendo.
    if (res.status === 401 && path !== "/v1/me" && typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new HttpError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

/** Texto legible de un error, incluyendo detalles de validación si vienen. */
export function errorText(e: unknown): string {
  if (e instanceof HttpError) {
    const d = e.details;
    if (Array.isArray(d) && d.length) {
      const parts = d
        .map((x) => {
          if (x && typeof x === "object") {
            const o = x as { message?: string; path?: unknown[] };
            const p = Array.isArray(o.path) && o.path.length ? `${o.path.join(".")}: ` : "";
            return o.message ? p + o.message : JSON.stringify(x);
          }
          return String(x);
        })
        .slice(0, 5);
      return `${e.message} — ${parts.join("; ")}`;
    }
    if (d && typeof d === "object" && !Array.isArray(d)) {
      return `${e.message} — ${JSON.stringify(d)}`;
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function uuid(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback (contextos no seguros, p. ej. http://IP): UUID v4 con getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function fetchArrayBuffer(path: string): Promise<ArrayBuffer> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) throw new HttpError(res.status, `http_${res.status}`, "No se pudo descargar el documento.");
  return res.arrayBuffer();
}
