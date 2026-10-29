// Add-on de Google Workspace (Apps Script + Card Service) para Gmail, Google Docs y Google Drive.
// El zip es el proyecto listo para `clasp push` (appsscript.json + src/*.js, con {{BASE_URL}} ya reemplazado).
export const meta = {
  id: "google-workspace",
  name: "Google Workspace (Gmail, Docs, Drive)",
  description:
    "Add-on de Apps Script: enviar a firmar el PDF adjunto de un correo de Gmail, el documento abierto de Google Docs o un PDF/Doc de Drive, ver el estado de los sobres recientes y guardar el firmado junto al original.",
};

const SOURCES = ["appsscript.json", ".claspignore", "README.md"];

export async function build(ctx) {
  const src = ctx
    .walk("src")
    .filter((f) => f.endsWith(".js"))
    .map((f) => `src/${f}`);
  const entries = [...SOURCES, ...src].map((name) => ({ name, data: ctx.load(name) }));
  const manifest = JSON.parse(entries[0].data.toString("utf8"));
  if (!manifest.addOns?.common || !Array.isArray(manifest.oauthScopes)) throw new Error("google-workspace: appsscript.json incompleto");
  return {
    files: [
      { name: "appsscript.json", data: entries[0].data },
      { name: "README.md", data: ctx.load("README.md") },
      // Logo de las tarjetas (addOns.common.logoUrl y el encabezado de cada tarjeta).
      { name: "icon-128.png", data: ctx.asset("icon-128.png") },
    ],
    artifacts: [
      { name: "calasign-google-workspace-addon.zip", entries, description: "Add-on de Google Workspace: proyecto de Apps Script para clasp (zip)" },
    ],
  };
}
