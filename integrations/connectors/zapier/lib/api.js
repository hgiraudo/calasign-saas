"use strict";
// Base URL y helpers comunes de la app de Zapier.
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

module.exports = { BASE_URL, url, requester, flattenEnvelope };
