// Cliente mínimo de la API v1 de CalaSign (mismo origen que el panel: sin CORS).
import { accessToken, currentTokens, refresh } from "./auth.js";

const ORIGIN = window.location.origin;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * @param {string} path p. ej. "/v1/envelopes"
 * @param {{method?: string, json?: unknown, form?: FormData, idempotencyKey?: string}} [o]
 */
export async function api(path, o = {}) {
  const run = async (token) => {
    const headers = { authorization: `Bearer ${token}` };
    if (o.json !== undefined) headers["content-type"] = "application/json";
    if (o.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
    return fetch(`${ORIGIN}${path}`, {
      method: o.method ?? (o.json !== undefined || o.form ? "POST" : "GET"),
      headers,
      body: o.form ?? (o.json !== undefined ? JSON.stringify(o.json) : undefined),
    });
  };
  // Sin token pero con la sesión guardada: la renovación falló por red o un 5xx (no se cerró la sesión).
  const noToken = () => (currentTokens()?.refresh_token ? new ApiError(0, "network", "No se pudo renovar la sesión") : new ApiError(401, "unauthorized", "Sesión vencida"));
  let token = await accessToken();
  if (!token) throw noToken();
  let res;
  try {
    res = await run(token);
    if (res.status === 401) {
      // Token revocado o vencido antes de tiempo: una renovación y un reintento.
      token = (await refresh(token))?.access_token;
      if (!token) throw noToken();
      res = await run(token);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "network", String(e?.message ?? e));
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? `HTTP ${res.status}`, body?.error?.details);
  return body;
}

export const appUrl = (envelopeId) => `${ORIGIN}/app/envelopes/${encodeURIComponent(envelopeId)}`;
