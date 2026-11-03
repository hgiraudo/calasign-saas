// Marco de las vistas previas de marca blanca (consola → Marca: la página del firmante y los correos). Antes eran
// iframes srcdoc, que heredan la CSP de la consola: sin 'unsafe-inline' en style-src (seguridad §5.2) su <style> y los
// style="…" de los correos no se aplicaban. Este documento trae su propia CSP, que sí los admite, y nada más: ningún
// script salvo el suyo (por hash, sin manejadores en atributos ni javascript:), ninguna conexión, ningún formulario.
// La consola lo abre con sandbox="allow-scripts" (sin allow-same-origin): origen opaco, no ve la sesión ni la página
// que lo contiene. Recibe el HTML por postMessage y reemplaza su documento.
import type { FastifyInstance } from "fastify";
import { cspHash } from "../../lib/csp";

export const BRAND_PREVIEW_PATH = "/brand-preview";

// Sólo mensajes del marco padre. DOMParser no ejecuta los <script> del HTML recibido, y los atributos on…= los frena la
// CSP de abajo.
const SCRIPT =
  'addEventListener("message",function(e){if(e.source!==parent||!e.data||typeof e.data.html!=="string")return;' +
  'var d=new DOMParser().parseFromString(e.data.html,"text/html");' +
  "document.replaceChild(document.adoptNode(d.documentElement),document.documentElement)})";

export const BRAND_PREVIEW_HTML = `<!doctype html><html><head><meta charset="utf-8"><script>${SCRIPT}</script></head><body></body></html>`;

export const BRAND_PREVIEW_CSP = [
  "default-src 'none'",
  `script-src ${cspHash(SCRIPT)}`,
  // El CSS de la marca y el de los correos (que van con style="…" porque así los leen los clientes de correo).
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Logo y favicon de la marca (archivo propio, data: de la vista previa) y las imágenes de los correos.
  "img-src 'self' data: blob: https:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function brandPreviewFrame(app: FastifyInstance) {
  app.get(BRAND_PREVIEW_PATH, async (_req, reply) =>
    reply
      .header("content-security-policy", BRAND_PREVIEW_CSP)
      .header("cache-control", "no-cache")
      .header("referrer-policy", "no-referrer")
      .type("text/html; charset=utf-8")
      .send(BRAND_PREVIEW_HTML),
  );
}
