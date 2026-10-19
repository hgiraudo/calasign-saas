// App de Zapier (Platform CLI). Salida: connectors/zapier/calasign-zapier-app.zip (proyecto listo para
// `npm install && zapier-platform push`) y los archivos sueltos para inspeccionarlos.
export const meta = {
  id: "zapier",
  name: "Zapier",
  description: "App de Zapier Platform CLI: triggers REST hook (completado, enviado, rechazado, firmado), enviar desde plantilla, enviar PDF, buscar, anular, recordar.",
};

const SOURCES = ["package.json", "index.js", "authentication.js", "hydrators.js", "README.md", "lib/api.js", "triggers/envelopeEvents.js", "triggers/templateList.js", "creates/index.js", "searches/findEnvelope.js"];

export async function build(ctx) {
  const files = SOURCES.map((f) => ({ name: f, data: ctx.load(f) }));
  files.push({ name: "lib/quicksend.js", data: ctx.shared("quicksend.cjs") });
  return {
    files,
    artifacts: [{ name: "calasign-zapier-app.zip", entries: files, description: "Zapier: app de Platform CLI (zip)" }],
  };
}
