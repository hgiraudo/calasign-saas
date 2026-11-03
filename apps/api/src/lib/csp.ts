// Estilos en el HTML que arma la API sin 'unsafe-inline' en la CSP (seguridad §5.2): cada `<style>` va con el hash de
// su contenido en el style-src de esa respuesta. Los atributos style="…" no se pueden habilitar así (harían falta
// 'unsafe-hashes'): el HTML que arma la API no los usa.
import crypto from "node:crypto";
import type { FastifyReply } from "fastify";

/** Fuente CSP (`'sha256-…'`) que habilita un `<style>` con exactamente este contenido. */
export function cspHash(text: string): string {
  return `'sha256-${crypto.createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** Suma `source` a la directiva `name` de un CSP; si no está, la crea con `fallback` (lo que regía por default-src). */
export function addCspSource(csp: string, name: string, source: string, fallback = "'self'"): string {
  const parts = csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const k = parts.findIndex((d) => d.split(/\s+/)[0].toLowerCase() === name);
  if (k >= 0) parts[k] = `${parts[k]} ${source}`;
  else parts.push(`${name} ${fallback} ${source}`);
  return parts.join(";");
}

/**
 * `<style>` con `css` habilitado en el CSP de esta respuesta (el que puso helmet o la ruta). El contenido no puede
 * cerrar el elemento: `</` se escapa antes de calcular el hash.
 */
export function inlineStyle(reply: FastifyReply, css: string, id?: string): string {
  const text = css.replace(/<\//g, "<\\/");
  const csp = reply.getHeader("content-security-policy");
  if (typeof csp === "string" && csp) reply.header("content-security-policy", addCspSource(csp, "style-src", cspHash(text)));
  return `<style${id ? ` id="${id}"` : ""}>${text}</style>`;
}
