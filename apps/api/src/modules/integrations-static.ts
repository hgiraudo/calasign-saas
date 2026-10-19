// Archivos de /integrations/ (los genera integrations/build.mjs dentro de la web compilada).
// - Se revalidan siempre: no llevan hash en el nombre y una versión nueva tiene que llegar enseguida.
// - El complemento de Office (/integrations/office/*) corre dentro de Word/Outlook: en la web, en un iframe de los
//   dominios de Microsoft, y carga office.js desde su CDN. Solo para esas páginas se cambia el CSP de helmet
//   (frame-ancestors con los dominios de Office, scripts de Microsoft), se quita X-Frame-Options y se usa
//   COOP unsafe-none (con same-origin, el diálogo de inicio de sesión de Office en la web falla con el error 12006).
import type { FastifyInstance } from "fastify";

export const INTEGRATIONS_PREFIX = "/integrations/";
const OFFICE_PREFIX = "/integrations/office/";

// Dominios desde los que Office (web, escritorio y Outlook) muestra los complementos. Microsoft no publica una lista
// oficial: es la combinación de los hosts de Office en la web, Outlook y Microsoft 365.
const OFFICE_FRAME_ANCESTORS = [
  "https://*.officeapps.live.com",
  "https://*.office.com",
  "https://*.office365.com",
  "https://*.office.net",
  "https://*.microsoft365.com",
  "https://*.cloud.microsoft",
  "https://*.microsoft.com",
  "https://*.sharepoint.com",
  "https://*.live.com",
  "https://*.outlook.com",
];

// office.js carga sus módulos desde su CDN, MicrosoftAjax desde ajax.aspnetcdn.com y MSAL (NAA) desde alcdn.msauth.net.
const OFFICE_SCRIPTS = ["https://appsforoffice.microsoft.com", "https://ajax.aspnetcdn.com", "https://alcdn.msauth.net"];

export const OFFICE_CSP = [
  "default-src 'self'",
  `script-src 'self' ${OFFICE_SCRIPTS.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // La API de CalaSign es del mismo origen; office.js reporta telemetría a dominios de Microsoft.
  "connect-src 'self' https://appsforoffice.microsoft.com https://*.office.com https://*.office.net https://*.microsoft.com",
  "frame-src 'self' https://appsforoffice.microsoft.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors 'self' ${OFFICE_FRAME_ANCESTORS.join(" ")}`,
].join("; ");

/** Tipos de los archivos de /integrations/ que @fastify/send no conoce o sirve como descarga sin necesidad. */
const TEXT_TYPES: Record<string, string> = {
  ".md": "text/plain; charset=utf-8",
  ".py": "text/plain; charset=utf-8",
};

export function integrationsStaticHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (req, reply, payload) => {
    const path = req.url.split("?")[0];
    // El diálogo de inicio de sesión del complemento (Office en la web) navega a la pantalla de consentimiento
    // (y al login si no hay sesión): con COOP same-origin Office pierde la referencia al diálogo (error 12006).
    if (path === "/oauth/authorize" || path === "/login") {
      reply.header("cross-origin-opener-policy", "unsafe-none");
      return payload;
    }
    if (!path.startsWith(INTEGRATIONS_PREFIX) && path !== "/integrations") return payload;
    if (reply.statusCode >= 400) return payload;
    reply.header("cache-control", "no-cache");
    const ext = /\.[a-z0-9]+$/i.exec(path)?.[0]?.toLowerCase();
    if (ext && TEXT_TYPES[ext]) reply.header("content-type", TEXT_TYPES[ext]);
    if (ext === ".mcpb") reply.header("content-type", "application/zip");
    if (path.startsWith(OFFICE_PREFIX)) {
      reply.header("content-security-policy", OFFICE_CSP);
      reply.removeHeader("x-frame-options");
      reply.header("cross-origin-opener-policy", "unsafe-none");
    }
    return payload;
  });
}
