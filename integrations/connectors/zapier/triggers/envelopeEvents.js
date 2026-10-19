"use strict";
// Triggers REST hook: Zapier se suscribe con POST /v1/webhooks (url = bundle.targetUrl) y se desuscribe con DELETE.
// performList usa GET /v1/webhooks/samples (eventos reales recientes con la misma forma, o uno sintético).
const { url } = require("../lib/api");
const { flattenEvent } = require("../lib/quicksend");
const hydrators = require("../hydrators");

const ALL_EVENTS = [
  "envelope.sent",
  "envelope.completed",
  "envelope.declined",
  "envelope.voided",
  "envelope.expired",
  "recipient.viewed",
  "recipient.signed",
  "recipient.declined",
  "recipient.approved",
];

const SAMPLE = {
  id: "0190a000-0000-7000-8000-000000000001",
  event: "envelope.completed",
  created_at: "2026-10-01T15:00:00.000Z",
  envelope_id: "0190a000-0000-7000-8000-0000000000e1",
  envelope_subject: "Contrato de servicios",
  envelope_status: "completed",
  envelope_sent_at: "2026-10-01T14:00:00.000Z",
  envelope_completed_at: "2026-10-01T15:00:00.000Z",
  signed_sha256: "9f2c0b1d4e5a6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
  metadata: { recordId: "CRM-123" },
  recipient_id: null,
  recipient_name: null,
  recipient_email: null,
  reason: null,
  recipients: [{ id: "0190a000-0000-7000-8000-0000000000a1", name: "Ana Pérez", email: "ana@example.com", role: "signer", status: "signed", routingOrder: 1 }],
};

function withPdf(z, row) {
  // PDF firmado como archivo de Zapier (se descarga solo si un paso lo usa).
  if (row.envelope_status === "completed" && row.envelope_id && !String(row.envelope_id).startsWith("00000000")) {
    row.signed_pdf = z.dehydrateFile(hydrators.signedPdf, { envelopeId: row.envelope_id });
  }
  return row;
}

function hookTrigger({ key, noun, label, description, events, important }) {
  const chooseEvents = !events;
  return {
    key,
    noun,
    display: { label, description, ...(important ? { important: true } : {}) },
    operation: {
      type: "hook",
      inputFields: chooseEvents
        ? [{ key: "events", label: "Events", required: true, list: true, choices: ALL_EVENTS, helpText: "Events that trigger the Zap." }]
        : [],
      performSubscribe: async (z, bundle) => {
        const res = await z.request({
          url: url("/v1/webhooks"),
          method: "POST",
          body: { url: bundle.targetUrl, events: events || bundle.inputData.events, description: `Zapier: ${label}` },
        });
        return res.data; // { webhook: { id }, secret } → bundle.subscribeData
      },
      performUnsubscribe: async (z, bundle) => {
        const id = bundle.subscribeData && bundle.subscribeData.webhook && bundle.subscribeData.webhook.id;
        if (!id) return {};
        await z.request({ url: url(`/v1/webhooks/${encodeURIComponent(id)}`), method: "DELETE", skipThrowForStatus: true });
        return {};
      },
      perform: (z, bundle) => {
        const ev = bundle.cleanedRequest || {};
        if (!ev.type || ev.type === "webhook.test") return [];
        if (events && !events.includes(ev.type)) return [];
        return [withPdf(z, flattenEvent(ev))];
      },
      performList: async (z, bundle) => {
        const first = (events || bundle.inputData.events || ["envelope.completed"])[0];
        const res = await z.request({ url: url("/v1/webhooks/samples"), params: { event: first, limit: 3 } });
        return (res.data.items || []).map((ev) => withPdf(z, flattenEvent(ev)));
      },
      sample: { ...SAMPLE, event: (events || ["envelope.completed"])[0] },
      outputFields: [
        { key: "id", label: "Event ID" },
        { key: "event", label: "Event type" },
        { key: "envelope_id", label: "Envelope ID" },
        { key: "envelope_subject", label: "Subject" },
        { key: "envelope_status", label: "Status" },
        { key: "envelope_completed_at", label: "Completed at", type: "datetime" },
        { key: "recipient_name", label: "Recipient name" },
        { key: "recipient_email", label: "Recipient email" },
        { key: "reason", label: "Reason" },
        { key: "signed_pdf", label: "Signed PDF", type: "file" },
      ],
    },
  };
}

module.exports = [
  hookTrigger({ key: "envelope_completed", noun: "Envelope", label: "Envelope Completed", description: "Triggers when every recipient has signed and the signed PDF is ready.", events: ["envelope.completed"], important: true }),
  hookTrigger({ key: "envelope_sent", noun: "Envelope", label: "Envelope Sent", description: "Triggers when an envelope is sent for signature.", events: ["envelope.sent"] }),
  hookTrigger({ key: "envelope_declined", noun: "Envelope", label: "Envelope Declined", description: "Triggers when a recipient declines to sign an envelope.", events: ["envelope.declined"] }),
  hookTrigger({ key: "recipient_signed", noun: "Recipient", label: "Recipient Signed", description: "Triggers when a recipient signs an envelope.", events: ["recipient.signed"] }),
  hookTrigger({ key: "envelope_event", noun: "Event", label: "New Envelope Event", description: "Triggers on the envelope and recipient events you choose." }),
];
module.exports.ALL_EVENTS = ALL_EVENTS;
