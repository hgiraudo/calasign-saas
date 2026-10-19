// Zoho CRM: botón «Enviar a firmar con CalaSign» en Deals (función Deluge) para instalar en una organización o
// empaquetar como extensión de Zoho Marketplace. Usa el conector nativo de CalaSign (apps/api/src/modules/crm).
export const meta = {
  id: "zoho-crm",
  name: "Zoho CRM",
  description: "Zoho CRM / Bigin: botón «Enviar a firmar con CalaSign» en Deals (función Deluge + conexión con API key) sobre el conector nativo, que devuelve el estado y el PDF firmado al registro.",
};

const FILES = ["README.md", "deluge/enviar_a_firmar.deluge.txt"];

export async function build(ctx) {
  const files = FILES.map((f) => ({ name: f, data: ctx.load(f) }));
  return {
    files,
    artifacts: [{ name: "calasign-zoho-crm.zip", entries: files, description: "Zoho CRM: botón «Enviar a firmar» (Deluge) y guía de la extensión (zip)" }],
  };
}
