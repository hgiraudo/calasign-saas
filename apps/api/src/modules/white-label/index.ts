// Marca blanca: punto de entrada (rutas, HTML de la web con la marca, favicon/manifest por dominio, logo del PDF).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import type { BlobStore } from "../../infra/storage";
import { sha256Hex } from "../../lib/util";
import type { Services } from "../context";
import { assetPath, brandForHost, productLabel, publicTheme, rebrands, resolveBrand, type ResolvedBrand } from "./brand";
import { brandFromKeyOrHost, whiteLabelRoutes } from "./routes";

export { applyEnvelopeBrand, recheckWhiteLabelDomains } from "./routes";
export { brandForEnvelope, publicTheme, productLabel, rebrands, brandize, resolveBrand } from "./brand";

/** Logo de la marca para el certificado (solo PNG/JPG: pdf-lib no dibuja SVG). */
export async function brandLogoForPdf(db: Db, blobs: BlobStore, b: ResolvedBrand): Promise<{ bytes: Uint8Array; type: "png" | "jpg" } | null> {
  const ref = b.assets.logo;
  if (!ref || (ref.contentType !== "image/png" && ref.contentType !== "image/jpeg")) return null;
  const f = await db.one<any>(`SELECT storage_key FROM files WHERE id = $1`, [ref.fileId]);
  if (!f) return null;
  return { bytes: await blobs.get(f.storage_key), type: ref.contentType === "image/png" ? "png" : "jpg" };
}

// ───────────────────────────── HTML de la web ─────────────────────────────

/** Marca de la página pedida: link de firma (/s/:token), formulario (/f/:slug), ?b= de la verificación o el Host. */
export async function brandForPage(db: Db, req: FastifyRequest): Promise<ResolvedBrand | null> {
  const [path, qs] = req.url.split("?");
  const sm = /^\/s\/([A-Za-z0-9_-]{20,100})$/.exec(path);
  if (sm) {
    const r = await db.one<{ tenant_id: string; brand_id: string | null }>(
      `SELECT e.tenant_id, e.brand_id FROM recipients r JOIN envelopes e ON e.id = r.envelope_id WHERE r.access_token_hash = $1`,
      [sha256Hex(sm[1])],
    );
    if (r) return resolveBrand(db, r.tenant_id, r.brand_id);
  }
  const fm = /^\/f\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  if (fm) {
    const w = await db.one<{ tenant_id: string }>(`SELECT tenant_id FROM web_forms WHERE slug = $1`, [fm[1]]);
    if (w) return resolveBrand(db, w.tenant_id, null);
  }
  const key = new URLSearchParams(qs ?? "").get("b") ?? undefined;
  const found = await brandFromKeyOrHost(db, path === "/verify" ? key : undefined, req.headers.host);
  return found ? resolveBrand(db, found.tenantId, found.brandId) : null;
}

let indexCache: string | null = null;
function indexHtml(): string | null {
  if (indexCache !== null) return indexCache;
  try {
    indexCache = readFileSync(resolve(config.webDist, "index.html"), "utf8");
  } catch {
    return null;
  }
  return indexCache;
}

const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** index.html con la marca: título, favicon, color, CSS del tema y los datos que lee la web al arrancar. */
export function injectBrand(html: string, b: ResolvedBrand): string {
  const theme = publicTheme(b);
  const title = escAttr(rebrands(b) ? productLabel(b) : b.name || productLabel(b));
  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${title}$2`);
  if (theme.theme.primaryColor) out = out.replace(/(<meta name="theme-color" content=")[^"]*(")/, `$1${theme.theme.primaryColor}$2`);
  if (theme.faviconUrl) {
    out = out
      .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${escAttr(theme.faviconUrl)}">`)
      .replace(/<link rel="apple-touch-icon"[^>]*>/, `<link rel="apple-touch-icon" href="${escAttr(theme.faviconUrl)}">`);
  } else if (rebrands(b)) {
    // Sin favicon propio no se muestra el de la plataforma.
    out = out.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="data:,">`).replace(/<link rel="apple-touch-icon"[^>]*>/, "");
  }
  // El manifest de la plataforma (nombre e íconos) solo en su dominio; en el de la marca se sirve uno propio.
  if (rebrands(b)) out = out.replace(/<link rel="manifest"[^>]*>/, `<link rel="manifest" href="/manifest.webmanifest?b=${encodeURIComponent(b.key)}">`);
  const head = [
    theme.fontCssUrl ? `<link rel="stylesheet" href="${escAttr(theme.fontCssUrl)}">` : "",
    theme.css ? `<style id="brand-theme">${theme.css.replace(/<\//g, "<\\/")}</style>` : "",
    // Bloque de datos (no ejecutable, la CSP no lo bloquea): la web lo lee antes del primer render, sin parpadeo.
    `<script type="application/json" id="brand-data">${JSON.stringify(theme).replace(/</g, "\\u003c")}</script>`,
  ].join("");
  return out.replace("</head>", `${head}</head>`);
}

/** Responde index.html con la marca si la página tiene una; false si hay que servir el de la plataforma. */
export async function sendBrandedIndex(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const html = indexHtml();
  if (!html) return false;
  const b = await brandForPage(db, req).catch(() => null);
  if (!b) return false;
  reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(injectBrand(html, b));
  return true;
}

// ───────────────────────────── Registro ─────────────────────────────

export async function whiteLabelModule(app: FastifyInstance, s: Services) {
  await whiteLabelRoutes(app, s);

  // En el dominio de una marca: favicon, ícono y manifest propios (no los de la plataforma).
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (req.method !== "GET" || !["/favicon.svg", "/favicon.ico", "/manifest.webmanifest", "/icons/apple-touch-icon.png"].includes(path)) return;
    const key = new URLSearchParams(req.url.split("?")[1] ?? "").get("b") ?? undefined;
    const found = await brandFromKeyOrHost(s.db, path === "/manifest.webmanifest" ? key : undefined, req.headers.host).catch(() => null);
    if (!found) return;
    const b = await resolveBrand(s.db, found.tenantId, found.brandId);
    if (path === "/manifest.webmanifest") {
      if (!rebrands(b)) return;
      const icon = assetPath(b, "favicon") ?? assetPath(b, "logo");
      return reply
        .header("cache-control", "no-cache")
        .type("application/manifest+json; charset=utf-8")
        .send({
          name: productLabel(b),
          short_name: productLabel(b).slice(0, 12),
          start_url: "/",
          display: "standalone",
          background_color: b.theme.backgroundColor ?? "#ffffff",
          theme_color: b.theme.primaryColor ?? "#0b1f3a",
          icons: icon ? [{ src: icon, sizes: "any", type: (b.assets.favicon ?? b.assets.logo)?.contentType }] : [],
        });
    }
    const p = assetPath(b, "favicon");
    if (p) return reply.redirect(p, 302);
    if (rebrands(b)) return reply.code(404).send();
  });
}
