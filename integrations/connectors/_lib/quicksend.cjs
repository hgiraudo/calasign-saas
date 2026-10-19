// Envío de un PDF a firmar en una sola acción de un conector (Zapier, n8n): orquesta los endpoints existentes
//   POST /v1/envelopes → POST /v1/envelopes/{id}/documents (multipart) → PUT /recipients → PUT /fields → POST /send
// Sin dependencias (corre en el runtime de Zapier, en n8n y en Node ≥18). Lo copia/empaqueta integrations/build.mjs.
// `request(method, path, { json, body, headers })` lo provee cada plataforma y devuelve el JSON de la respuesta.
"use strict";

/** Ancla por firmante: el PDF lleva el texto \firma1\, \firma2\… donde va cada firma (convención tipo DocuSign). */
function anchorText(i) {
  return `\\firma${i + 1}\\`;
}

/** Ubicación automática: firmas en la última página, en dos columnas desde abajo. Coordenadas normalizadas 0..1. */
function autoBox(i, total) {
  const rows = Math.ceil(total / 2);
  const row = Math.floor(i / 2);
  const col = i % 2;
  const height = 0.06;
  const gap = 0.025;
  const bottom = 0.93;
  const y = Math.max(0.02, bottom - (rows - row) * (height + gap));
  return { x: col === 0 ? 0.07 : 0.53, y: Number(y.toFixed(4)), width: 0.4, height };
}

/** Cuerpo multipart/form-data con un solo archivo (campo "file"), sin depender de FormData. */
function multipartFile(bytes, filename, contentType) {
  const boundary = `----CalaSign${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const safe = String(filename || "documento.pdf").replace(/["\r\n]/g, "_");
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safe}"\r\nContent-Type: ${contentType || "application/pdf"}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { body: Buffer.concat([head, Buffer.from(bytes), tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

function cleanSigner(s, i) {
  const name = String(s.name || "").trim();
  const email = s.email ? String(s.email).trim() : "";
  const phone = s.phone ? String(s.phone).trim() : "";
  if (!name) throw new Error(`Firmante ${i + 1}: falta el nombre`);
  if (!email && !phone) throw new Error(`Firmante ${i + 1}: falta email o teléfono`);
  const channels = email ? ["email"] : ["whatsapp"];
  if (email && phone && s.whatsapp) channels.push("whatsapp");
  return {
    role: s.role === "cc" || s.role === "approver" ? s.role : "signer",
    routingOrder: s.routingOrder ? Number(s.routingOrder) : s.sequential ? i + 1 : 1,
    name,
    email: email || null,
    phone: phone || null,
    channels,
  };
}

/**
 * Crea, arma y (por defecto) envía un sobre con un PDF.
 * input: { subject, message?, fileName, fileBytes (Buffer/Uint8Array), signers: [{ name, email?, phone?, role?, routingOrder? }],
 *          placement?: "auto" | "anchors", sequential?: boolean, send?: boolean (default true), expiresAt?, metadata? }
 */
async function quickSend(request, input) {
  if (!input || !input.fileBytes || !input.fileBytes.length) throw new Error("Falta el documento PDF");
  const signers = (input.signers || []).filter((s) => s && (s.name || s.email || s.phone)).map((s, i) => cleanSigner({ ...s, sequential: input.sequential }, i));
  if (!signers.some((s) => s.role === "signer")) throw new Error("Indicá al menos un firmante");
  const placement = input.placement === "anchors" ? "anchors" : "auto";

  const env = await request("POST", "/v1/envelopes", {
    json: {
      subject: String(input.subject || input.fileName || "Documento para firmar").slice(0, 300),
      ...(input.message ? { message: String(input.message) } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.metadata && Object.keys(input.metadata).length ? { metadata: input.metadata } : {}),
    },
  });
  const envId = env.envelope.id;
  const mp = multipartFile(input.fileBytes, input.fileName, "application/pdf");
  const doc = await request("POST", `/v1/envelopes/${envId}/documents`, { body: mp.body, headers: { "content-type": mp.contentType } });
  const withRecipients = await request("PUT", `/v1/envelopes/${envId}/recipients`, { json: { recipients: signers } });
  const recips = (withRecipients.recipients || []).filter((r) => r.role === "signer");
  const lastPage = Math.max(0, (doc.pageCount || 1) - 1);
  const fields = recips.map((r, i) =>
    placement === "anchors"
      ? { documentId: doc.id, recipientId: r.id, type: "signature", anchor: { text: anchorText(i), offsetX: 0, offsetY: 0, width: 150, height: 40 } }
      : { documentId: doc.id, recipientId: r.id, type: "signature", page: lastPage, ...autoBox(i, recips.length) },
  );
  await request("PUT", `/v1/envelopes/${envId}/fields`, { json: { fields } });
  if (input.send === false) return request("GET", `/v1/envelopes/${envId}`, {});
  await request("POST", `/v1/envelopes/${envId}/send`, {});
  return request("GET", `/v1/envelopes/${envId}`, {});
}

/**
 * Aplana un evento de webhook para herramientas que muestran campos planos (Zapier, Make): conserva el original y
 * agrega envelope_id, envelope_status, etc., y el firmante del evento.
 */
function flattenEvent(ev) {
  const env = (ev && ev.data && ev.data.envelope) || {};
  const recipients = env.recipients || [];
  const r = ev && ev.data && ev.data.recipientId ? recipients.find((x) => x.id === ev.data.recipientId) : null;
  return {
    id: ev.id,
    event: ev.type,
    created_at: ev.createdAt,
    envelope_id: env.id || null,
    envelope_subject: env.subject || null,
    envelope_status: env.status || null,
    envelope_sent_at: env.sentAt || null,
    envelope_completed_at: env.completedAt || null,
    signed_sha256: env.signedSha256 || null,
    metadata: env.metadata || {},
    recipient_id: r ? r.id : null,
    recipient_name: r ? r.name : null,
    recipient_email: r ? r.email : null,
    reason: (ev.data && ev.data.reason) || null,
    recipients,
  };
}

module.exports = { quickSend, flattenEvent, multipartFile, autoBox, anchorText };
