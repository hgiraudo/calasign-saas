"use strict";
const { url } = require("./lib/api");

// API key de CalaSign (Ajustes → API keys). Se manda como Authorization: Bearer <key>.
module.exports = {
  type: "custom",
  fields: [
    {
      key: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      helpText: "Create it in CalaSign: **Settings → API keys** (starts with `cs_live_` or `cs_test_`).",
    },
  ],
  test: { url: url("/v1/me") },
  connectionLabel: (z, bundle) => {
    const d = bundle.inputData || {};
    return [d.tenant && d.tenant.name, d.user && d.user.email].filter(Boolean).join(" · ") || "CalaSign";
  },
};
