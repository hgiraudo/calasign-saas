// Página de firmas al final del PDF (opción "Agregar una página de firmas"): un bloque por firmante con su nombre y
// correo impresos, y la ubicación (normalizada 0–1, origen arriba a la izquierda, como la API) de su campo de firma y
// de fecha. Hasta 4 firmantes por página; si hay más, se agregan páginas.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PER_PAGE = 4;
const NAVY = rgb(0x0b / 255, 0x1f / 255, 0x3a / 255);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.8, 0.84, 0.88);

// Las fuentes estándar de PDF solo codifican WinAnsi (latín): lo demás se reemplaza para no fallar al dibujar.
const winAnsi = (s) => String(s ?? "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

/**
 * @param {Uint8Array} bytes PDF original
 * @param {{name: string, email: string}[]} signers en el orden en que se muestran
 * @param {{title: string, date: string}} labels
 * @returns {Promise<{bytes: Uint8Array, placements: {signer: number, page: number, signature: object, date: object}[]}>}
 */
export async function appendSignaturePage(bytes, signers, labels) {
  const doc = await PDFDocument.load(bytes); // un PDF cifrado lanza EncryptedPDFError
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const last = pages[pages.length - 1];
  let { width: W, height: H } = last.getSize();
  const rot = ((last.getRotation().angle % 360) + 360) % 360;
  if (rot === 90 || rot === 270) [W, H] = [H, W];
  // Página vertical aunque la última sea apaisada.
  if (W > H) [W, H] = [H, W];

  const placements = [];
  const firstNewPage = pages.length;
  for (let start = 0; start < signers.length; start += PER_PAGE) {
    const page = doc.addPage([W, H]);
    const pageIndex = doc.getPageCount() - 1;
    page.drawText(winAnsi(labels.title), { x: W * 0.08, y: H * (1 - 0.09), size: 18, font: bold, color: NAVY });
    page.drawLine({ start: { x: W * 0.08, y: H * (1 - 0.11) }, end: { x: W * 0.92, y: H * (1 - 0.11) }, thickness: 1, color: LINE });
    signers.slice(start, start + PER_PAGE).forEach((s, k) => {
      const top = 0.16 + k * 0.2; // borde superior del bloque
      const sig = { x: 0.08, y: top, width: 0.42, height: 0.08 };
      const date = { x: 0.58, y: top + 0.04, width: 0.3, height: 0.04 };
      // Línea de firma debajo del campo, y nombre/correo debajo de la línea.
      const lineY = H * (1 - (sig.y + sig.height));
      page.drawLine({ start: { x: W * sig.x, y: lineY }, end: { x: W * (sig.x + sig.width), y: lineY }, thickness: 0.8, color: NAVY });
      page.drawText(winAnsi(s.name), { x: W * sig.x, y: lineY - 14, size: 11, font: bold, color: NAVY, maxWidth: W * 0.45 });
      page.drawText(winAnsi(s.email), { x: W * sig.x, y: lineY - 27, size: 9, font, color: MUTED, maxWidth: W * 0.45 });
      const dateLineY = H * (1 - (date.y + date.height));
      page.drawLine({ start: { x: W * date.x, y: dateLineY }, end: { x: W * (date.x + date.width), y: dateLineY }, thickness: 0.8, color: LINE });
      page.drawText(winAnsi(labels.date), { x: W * date.x, y: dateLineY - 12, size: 9, font, color: MUTED });
      placements.push({ signer: start + k, page: pageIndex, signature: sig, date });
    });
  }
  return { bytes: await doc.save(), placements, firstNewPage };
}
