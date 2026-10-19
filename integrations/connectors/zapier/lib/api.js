"use strict";
// Base URL y helpers comunes de la app de Zapier.
const { createHash } = require("crypto");
const BASE_URL = process.env.CALASIGN_BASE_URL || "{{BASE_URL}}";

const url = (path) => `${BASE_URL}${path}`;

/** Adaptador para lib/quicksend.js: request(method, path, { json, body, headers }) → JSON. */
const requester = (z) => async (method, path, opts = {}) => {
  const res = await z.request({
    url: url(path),
    method,
    headers: opts.headers || {},
    ...(opts.json !== undefined ? { body: opts.json } : opts.body !== undefined ? { body: opts.body } : {}),
  });
  return res.data;
};

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
    recipients: ((detail && detail.recipients) || []).map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, role: r.role, status: r.status, signed_at: r.signedAt || null })),
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
  const hash = createHash("sha256").update(`${action}\n${JSON.stringify(i)}`).digest("hex").slice(0, 32);
  return `zap-${zap}-${action}-${hash}-${day}`;
}

const IDEMPOTENCY_FIELD = {
  key: "idempotency_key",
  label: "Idempotency key",
  required: false,
  helpText: "Optional. Retries with the same key never create a second envelope (e.g. map the ID of the source record). By default it is derived from the Zap, the action data and the day.",
};

module.exports = { BASE_URL, url, requester, flattenEnvelope, idempotencyKey, IDEMPOTENCY_FIELD };
