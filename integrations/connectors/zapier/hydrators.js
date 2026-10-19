"use strict";
const { url } = require("./lib/api");

module.exports = {
  /** Descarga el PDF firmado y lo guarda como archivo de Zapier. */
  signedPdf: async (z, bundle) => {
    const id = encodeURIComponent(bundle.inputData.envelopeId);
    const req = z.request({ url: url(`/v1/envelopes/${id}/signed.pdf`), raw: true });
    return z.stashFile(req, undefined, `calasign-${bundle.inputData.envelopeId}.pdf`, "application/pdf");
  },
};
