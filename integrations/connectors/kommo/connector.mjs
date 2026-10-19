// Kommo: widget del Kommo Marketplace con el botón «Enviar a firmar con CalaSign» en la ficha y la lista de Leads, más
// la página que abre (send.html) y la guía para registrar la integración. La integración en sí (OAuth, mapeos,
// write-back, PDF y nota) es nativa: apps/api/src/modules/crm/kommo.ts (ver docs/CRM.md).
export const meta = {
  id: "kommo",
  name: "Kommo",
  description: "Kommo Marketplace: widget «Enviar a firmar con CalaSign» en los Leads, sobre el conector nativo (OAuth, estado en un campo del lead, PDF firmado y nota).",
};

// El widget se sube a Kommo como un zip con manifest.json en la raíz (más script.js, i18n/ e images/).
const WIDGET = ["manifest.json", "script.js", "i18n/es.json", "i18n/en.json", "i18n/pt.json"];
// Imágenes del widget: Kommo pide tamaños fijos (ver README); estas son de referencia y hay que reemplazarlas antes de
// publicar si Kommo las rechaza.
const IMAGES = [
  ["images/logo_min.png", "icon-80.png"],
  ["images/logo_small.png", "icon-128.png"],
  ["images/logo_medium.png", "icon-256.png"],
  ["images/logo.png", "icon-128.png"],
  ["images/logo_main.png", "icon-512.png"],
];

export async function build(ctx) {
  const widget = WIDGET.map((f) => ({ name: f, data: ctx.load(`widget/${f}`) }));
  for (const f of widget) if (f.name.endsWith(".json")) JSON.parse(f.data.toString("utf8"));
  const images = IMAGES.map(([name, asset]) => ({ name, data: ctx.asset(asset) }));
  const files = [
    { name: "README.md", data: ctx.load("README.md") },
    { name: "send.html", data: ctx.load("send.html") },
    { name: "send.js", data: ctx.load("send.js") },
    // Mismo estilo que la acción de Pipedrive.
    { name: "send.css", data: ctx.load("../pipedrive/send.css") },
  ];
  return {
    files,
    artifacts: [{ name: "calasign-kommo-widget.zip", entries: [...widget, ...images], description: "Kommo: widget «Enviar a firmar con CalaSign» (zip para subir a la integración)" }],
  };
}
