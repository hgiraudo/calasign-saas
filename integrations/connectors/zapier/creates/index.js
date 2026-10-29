"use strict";
const { url, requester, flattenEnvelope, idempotencyKey, IDEMPOTENCY_FIELD } = require("../lib/api");
const { quickSend } = require("../lib/quicksend");

const ENVELOPE_SAMPLE = {
  id: "0190a000-0000-7000-8000-0000000000e1",
  envelope_id: "0190a000-0000-7000-8000-0000000000e1",
  subject: "Contrato de servicios",
  status: "sent",
  created_at: "2026-10-01T14:00:00.000Z",
  sent_at: "2026-10-01T14:00:00.000Z",
  completed_at: null,
  expires_at: "2026-10-31T14:00:00.000Z",
  signed_sha256: null,
  metadata: {},
  documents: [],
  recipients: [
    {
      id: "0190a000-0000-7000-8000-0000000000a1",
      name: "Ana Pérez",
      email: "ana@example.com",
      phone: null,
      role: "signer",
      status: "sent",
      signed_at: null,
    },
  ],
  app_url: "{{BASE_URL}}/app/envelopes/0190a000-0000-7000-8000-0000000000e1",
};

const ROLE_KEY = /^role_([0-9a-f-]{36})_(name|email|phone)$/;
const PREFILL_KEY = /^prefill_([0-9a-f-]{36})$/;

/** Campos dinámicos: un grupo nombre/email/teléfono por rol de la plantilla y uno por campo prellenable. */
async function templateFields(z, bundle) {
  if (!bundle.inputData.templateId) return [];
  const res = await z.request({ url: url(`/v1/templates/${encodeURIComponent(bundle.inputData.templateId)}/input-schema`) });
  const s = res.data;
  const fields = [];
  for (const r of s.roles) {
    fields.push({ key: `role_${r.id}_name`, label: `${r.name}: name`, required: true });
    fields.push({
      key: `role_${r.id}_email`,
      label: `${r.name}: email`,
      required: false,
      helpText: "Required unless you give a phone for WhatsApp.",
    });
    fields.push({ key: `role_${r.id}_phone`, label: `${r.name}: phone (WhatsApp)`, required: false, helpText: "E.164 format, e.g. +18095551234." });
  }
  for (const f of s.fields) {
    const label = f.label || `Field ${f.type}`;
    fields.push({
      key: `prefill_${f.id}`,
      label: `Prefill: ${label}`,
      required: false,
      ...(f.type === "number" ? { type: "number" } : {}),
      ...(f.type === "dropdown" && f.options ? { choices: f.options } : {}),
    });
  }
  return fields;
}

/** inputData plano → cuerpo de POST /v1/envelopes/from-template/{id}. */
function templateBody(input) {
  const roles = {};
  const prefill = {};
  for (const [k, v] of Object.entries(input)) {
    let m = ROLE_KEY.exec(k);
    if (m) {
      (roles[m[1]] ||= {})[m[2]] = v === "" || v == null ? null : String(v);
      continue;
    }
    m = PREFILL_KEY.exec(k);
    if (m && v !== "" && v != null) prefill[m[1]] = String(v);
  }
  const metadata = input.external_id ? { externalId: String(input.external_id) } : undefined;
  return {
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.message ? { message: input.message } : {}),
    roles,
    prefill,
    ...(metadata ? { metadata } : {}),
    send: input.send === undefined ? true : input.send !== false && input.send !== "false",
  };
}

const sendFromTemplate = {
  key: "send_from_template",
  noun: "Envelope",
  display: {
    label: "Send Envelope From Template",
    description: "Creates an envelope from a template, fills each role and the prefilled fields, and sends it.",
  },
  operation: {
    inputFields: [
      { key: "templateId", label: "Template", required: true, dynamic: "template_list.id.name", altersDynamicFields: true },
      { key: "subject", label: "Subject", required: false, helpText: "Defaults to the template subject." },
      { key: "message", label: "Message", required: false, type: "text" },
      {
        key: "external_id",
        label: "External ID",
        required: false,
        helpText: "Your own reference (comes back in every event as metadata.externalId).",
      },
      { key: "send", label: "Send now", type: "boolean", default: "true", required: false },
      IDEMPOTENCY_FIELD,
      templateFields,
    ],
    perform: async (z, bundle) => {
      const res = await z.request({
        url: url(`/v1/envelopes/from-template/${encodeURIComponent(bundle.inputData.templateId)}`),
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey(bundle, "send_from_template") },
        body: templateBody(bundle.inputData),
      });
      return flattenEnvelope(res.data);
    },
    sample: ENVELOPE_SAMPLE,
  },
};

const sendDocument = {
  key: "send_document",
  noun: "Envelope",
  display: {
    label: "Send Document for Signature",
    description: "Sends a PDF to one or more signers. Signature fields go on the last page, or on the anchor texts \\firma1\\, \\firma2\\…",
  },
  operation: {
    inputFields: [
      { key: "file", label: "PDF file", type: "file", required: true },
      { key: "file_name", label: "File name", required: false, default: "documento.pdf" },
      { key: "subject", label: "Subject", required: true },
      { key: "message", label: "Message", required: false, type: "text" },
      {
        key: "signers",
        label: "Signers",
        required: true,
        children: [
          { key: "name", label: "Name", required: true },
          { key: "email", label: "Email", required: false },
          { key: "phone", label: "Phone (WhatsApp, E.164)", required: false },
        ],
      },
      {
        key: "placement",
        label: "Signature placement",
        required: false,
        default: "auto",
        choices: { auto: "Last page (automatic)", anchors: "Anchor texts \\firma1\\, \\firma2\\… in the PDF" },
      },
      { key: "sequential", label: "Sign in order", type: "boolean", default: "false", required: false },
      { key: "external_id", label: "External ID", required: false },
      IDEMPOTENCY_FIELD,
    ],
    perform: async (z, bundle) => {
      const i = bundle.inputData;
      const fileRes = await z.request({ url: i.file, raw: true, skipThrowForStatus: true });
      if (fileRes.status >= 400) throw new z.errors.Error(`Could not download the file (HTTP ${fileRes.status})`, "file_download", fileRes.status);
      const bytes = await fileRes.buffer();
      const detail = await quickSend(requester(z), {
        subject: i.subject,
        message: i.message,
        fileName: i.file_name || "documento.pdf",
        fileBytes: bytes,
        signers: i.signers || [],
        placement: i.placement,
        sequential: i.sequential === true || i.sequential === "true",
        metadata: i.external_id ? { externalId: String(i.external_id) } : undefined,
        idempotencyKey: idempotencyKey(bundle, "send_document"),
      });
      return flattenEnvelope(detail);
    },
    sample: ENVELOPE_SAMPLE,
  },
};

const voidEnvelope = {
  key: "void_envelope",
  noun: "Envelope",
  display: { label: "Void Envelope", description: "Cancels a sent envelope so it can no longer be signed." },
  operation: {
    inputFields: [
      { key: "envelope_id", label: "Envelope ID", required: true },
      { key: "reason", label: "Reason", required: true },
    ],
    perform: async (z, bundle) => {
      const res = await z.request({
        url: url(`/v1/envelopes/${encodeURIComponent(bundle.inputData.envelope_id)}/void`),
        method: "POST",
        body: { reason: bundle.inputData.reason },
      });
      return flattenEnvelope(res.data);
    },
    sample: { ...ENVELOPE_SAMPLE, status: "voided" },
  },
};

const remind = {
  key: "remind_recipients",
  noun: "Reminder",
  display: { label: "Remind Recipients", description: "Sends a reminder to the recipients who still have to sign." },
  operation: {
    inputFields: [{ key: "envelope_id", label: "Envelope ID", required: true }],
    perform: async (z, bundle) => {
      const res = await z.request({ url: url(`/v1/envelopes/${encodeURIComponent(bundle.inputData.envelope_id)}/remind`), method: "POST", body: {} });
      return { envelope_id: bundle.inputData.envelope_id, ...(res.data || {}) };
    },
    sample: { envelope_id: ENVELOPE_SAMPLE.id, notified: 1 },
  },
};

module.exports = [sendFromTemplate, sendDocument, voidEnvelope, remind];
module.exports.templateBody = templateBody;
module.exports.templateFields = templateFields;
