// Pipedrive: acción de app (App Extensions → Link action) «Enviar a firmar con CalaSign» en Deals y Persons, más la
// guía para registrar la app en el Developer Hub. La integración en sí (OAuth, mapeos, write-back, PDF y nota) es
// nativa: apps/api/src/modules/crm/ (ver docs/CRM.md).
export const meta = {
  id: "pipedrive",
  name: "Pipedrive",
  description: "Pipedrive Marketplace: acción «Enviar a firmar con CalaSign» en Deals y Persons, sobre el conector nativo (OAuth, estado en un campo del deal, PDF firmado y nota).",
};

const FILES = ["README.md", "app-extensions.json", "send.html", "send.js", "send.css"];

export async function build(ctx) {
  const files = FILES.map((f) => ({ name: f, data: ctx.load(f) }));
  for (const f of files) if (f.name.endsWith(".json")) JSON.parse(f.data.toString("utf8"));
  return {
    files,
    artifacts: [{ name: "calasign-pipedrive.zip", entries: files, description: "Pipedrive: acción de app y guía del Marketplace (zip)" }],
  };
}
