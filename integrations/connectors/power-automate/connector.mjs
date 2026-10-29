// Conector personalizado de Power Automate / Logic Apps / Power Apps / Copilot Studio (OpenAPI 2.0 + apiProperties).
// Salida: connectors/power-automate/ (archivos sueltos) y el zip listo para `paconn create` / `pac connector create`
// o para importar en make.powerautomate.com → Conectores personalizados → Importar un archivo OpenAPI.
export const meta = {
  id: "power-automate",
  name: "Power Automate / Logic Apps",
  description: "Conector personalizado (OpenAPI 2.0): trigger por webhook, envío desde plantilla con campos dinámicos, estado, PDF firmado.",
};

const FILES = ["apiDefinition.swagger.json", "apiProperties.json", "apiProperties.oauth.json", "readme.md", "intro.md"];

export async function build(ctx) {
  const files = FILES.map((f) => ({ name: f, data: ctx.load(f) }));
  files.push({ name: "icon.png", data: ctx.asset("icon-256.png") });
  // JSON válido después de reemplazar las variables.
  for (const f of files) if (f.name.endsWith(".json")) JSON.parse(f.data.toString("utf8"));
  return {
    files,
    artifacts: [
      { name: "calasign-power-automate-connector.zip", entries: files, description: "Power Automate / Logic Apps: conector personalizado (zip)" },
    ],
  };
}
