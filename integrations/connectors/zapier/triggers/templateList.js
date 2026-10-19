"use strict";
// Trigger oculto para el desplegable de plantillas (dynamic: "template_list.id.name").
const { url } = require("../lib/api");

module.exports = {
  key: "template_list",
  noun: "Template",
  display: { label: "New Template", description: "Lists the templates of your organization.", hidden: true },
  operation: {
    perform: async (z) => {
      const res = await z.request({ url: url("/v1/templates") });
      return (res.data.items || []).map((t) => ({ id: t.id, name: t.name, description: t.description, roles: (t.roles || []).map((r) => r.name).join(", ") }));
    },
    sample: { id: "0190a000-0000-7000-8000-0000000000aa", name: "Contrato de servicios", description: null, roles: "Cliente, Gerente" },
  },
};
