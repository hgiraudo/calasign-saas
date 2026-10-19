// Dynamics 365 / Dataverse: script de columnas + web resource de botones + definiciones de flujos + guía.
// Usa el conector de Power Automate (../power-automate) para hablar con CalaSign.
export const meta = {
  id: "dynamics365",
  name: "Dynamics 365",
  description: "Dynamics 365 Sales / Customer Service (Dataverse): botón «Enviar a firmar», columnas de estado, flujos de envío y sincronización con el PDF firmado como nota.",
};

const FILES = ["README.md", "setup-dataverse.mjs", "webresources/calasign_commands.js", "flows/calasign-send-on-request.json", "flows/calasign-sync-status.json"];

export async function build(ctx) {
  const files = FILES.map((f) => ({ name: f, data: ctx.load(f) }));
  for (const f of files) if (f.name.endsWith(".json")) JSON.parse(f.data.toString("utf8"));
  return {
    files,
    artifacts: [{ name: "calasign-dynamics365.zip", entries: files, description: "Dynamics 365: columnas, botones y flujos (zip)" }],
  };
}
