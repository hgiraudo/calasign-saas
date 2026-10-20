"use strict";
const { url, flattenEnvelope, throwApiError } = require("../lib/api");
const hydrators = require("../hydrators");

module.exports = {
  key: "find_envelope",
  noun: "Envelope",
  display: { label: "Find Envelope", description: "Gets an envelope by ID with its status, recipients and the signed PDF when completed." },
  operation: {
    inputFields: [{ key: "envelope_id", label: "Envelope ID", required: true }],
    perform: async (z, bundle) => {
      const res = await z.request({ url: url(`/v1/envelopes/${encodeURIComponent(bundle.inputData.envelope_id)}`), skipThrowForStatus: true });
      // skipThrowForStatus solo por el 404 ("no encontrado" en una búsqueda): el resto (401, 429, 5xx…) pasa por el manejo
      // común, con "Reconnect your account" y ThrottledError.
      if (res.status === 404) return [];
      if (res.status >= 400) throwApiError(res, z);
      const row = flattenEnvelope(res.data);
      if (row.status === "completed") row.signed_pdf = z.dehydrateFile(hydrators.signedPdf, { envelopeId: row.id });
      return [row];
    },
    sample: {
      id: "0190a000-0000-7000-8000-0000000000e1",
      envelope_id: "0190a000-0000-7000-8000-0000000000e1",
      subject: "Contrato de servicios",
      status: "completed",
      completed_at: "2026-10-01T15:00:00.000Z",
      recipients: [],
    },
  },
};
