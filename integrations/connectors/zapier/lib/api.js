"use strict";
// Base URL y helpers comunes de la app de Zapier.
const { createHash } = require("crypto");
const BASE_URL = process.env.CALASIGN_BASE_URL || "{{BASE_URL}}";

const url = (path) => `${BASE_URL}${path}`;

/** Adaptador para lib/quicksend.js: request(method, path, { json, body, headers }) → JSON. */
const requester =
  (z) =>
  async (method, path, opts = {}) => {
    const res = await z.request({
      url: url(path),
      method,
      headers: opts.headers || {},
      ...(opts.json !== undefined ? { body: opts.json } : opts.body !== undefined ? { body: opts.body } : {}),
    });
    return res.data;
  };

/**
 * Lanza el error de Zapier que corresponde a una respuesta >= 400 de la API de CalaSign: 401 → "Reconnect your account",
 * 429 genérico e idempotency_in_progress → ThrottledError, el resto → Error con el código y mensaje de la API. Lo usa el
 * afterResponse común y las llamadas con skipThrowForStatus para los estados que no manejan ellas.
 */
function throwApiError(response, z) {
  if (response.status === 401) throw new z.errors.Error("CalaSign rejected the API key. Reconnect your account.", "unauthorized", 401);
  let message = `CalaSign error ${response.status}`;
  let code = String(response.status);
  try {
    const body = typeof response.json === "object" && response.json ? response.json : JSON.parse(response.content);
    if (body && body.error) {
      message = body.error.message || message;
      code = body.error.code || code;
    }
  } catch (_) {
    /* cuerpo no JSON */
  }
  if (response.status === 429) {
    // Solo el límite de tasa genérico (con Retry-After, código bad_request/rate_limited) es reintentable. Los 429 de
    // negocio (reminded_recently, etc.) traen su propio código y no Retry-After: reintentarlos no sirve.
    const getHeader = (n) =>
      response.headers && typeof response.headers.get === "function" ? response.headers.get(n) : response.headers && response.headers[n];
    const retryAfter = Number(getHeader("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) throw new z.errors.ThrottledError(message, Math.ceil(retryAfter));
    if (code === "429" || code === "bad_request" || code === "rate_limited") throw new z.errors.ThrottledError(message, 60);
  }
  // Otra ejecución con la misma Idempotency-Key sigue en curso: reintentar en unos segundos.
  if (response.status === 409 && code === "idempotency_in_progress") throw new z.errors.ThrottledError(message, 5);
  throw new z.errors.Error(message, code, response.status);
}

/** Sobre (detalle de la API) en campos planos para Zapier. */
function flattenEnvelope(detail) {
  const e = (detail && detail.envelope) || {};
  return {
    id: e.id,
    envelope_id: e.id,
    subject: e.subject,
    status: e.status,
    created_at: e.createdAt || null,
    sent_at: e.sentAt || null,
    completed_at: e.completedAt || null,
    expires_at: e.expiresAt || null,
    signed_sha256: e.signedSha256 || null,
    metadata: e.metadata || {},
    documents: (detail && detail.documents) || [],
    recipients: ((detail && detail.recipients) || []).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      role: r.role,
      status: r.status,
      signed_at: r.signedAt || null,
    })),
    app_url: e.id ? `${BASE_URL}/app/envelopes/${e.id}` : null,
  };
}

/**
 * Idempotency-Key de un envío. Zapier reintenta la acción (timeouts, «Autoreplay») con los mismos datos y no expone un
 * id de ejecución: la clave es el Zap + un hash de los datos de la acción + el día (UTC). Un reintento el mismo día no
 * crea otro sobre; el mismo envío con los mismos datos otro día sí. El campo «Idempotency key» la reemplaza (p. ej. con
 * el id del registro de origen).
 */
function idempotencyKey(bundle, action) {
  const i = (bundle && bundle.inputData) || {};
  if (i.idempotency_key) return `zap-${String(i.idempotency_key).slice(0, 150)}`;
  const zap = (bundle && bundle.meta && bundle.meta.zap && bundle.meta.zap.id) || "x";
  const day = new Date().toISOString().slice(0, 10);
  const hash = createHash("sha256")
    .update(`${action}\n${JSON.stringify(i)}`)
    .digest("hex")
    .slice(0, 32);
  return `zap-${zap}-${action}-${hash}-${day}`;
}

const IDEMPOTENCY_FIELD = {
  key: "idempotency_key",
  label: "Idempotency key",
  required: false,
  helpText:
    "Optional. Retries with the same key never create a second envelope (e.g. map the ID of the source record). By default it is derived from the Zap, the action data and the day.",
};

module.exports = { BASE_URL, url, requester, flattenEnvelope, idempotencyKey, IDEMPOTENCY_FIELD, throwApiError };
