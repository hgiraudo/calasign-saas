// Web (SPA) servida desde el mismo origen: archivos estáticos y, para cualquier otra ruta de página, index.html.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import { INTEGRATIONS_PREFIX } from "./modules/integrations-static";

export interface SpaOptions {
  /** Carpeta con el build de la web (index.html, assets/…). */
  root: string;
  /** index.html con la marca de la página (marca blanca); false si corresponde el de la plataforma. */
  sendBrandedIndex?: (req: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
}

export async function registerSpa(app: FastifyInstance, opts: SpaOptions): Promise<void> {
  await app.register(fastifyStatic, {
    root: opts.root,
    wildcard: true,
    setHeaders(res, path) {
      if (path.endsWith(".mjs")) res.header("content-type", "text/javascript; charset=utf-8");
      // PWA: el service worker y el manifest se revalidan siempre (si no, una versión vieja queda pegada).
      if (path.endsWith("/sw.js") || path.endsWith(".webmanifest") || path.endsWith("/offline.html")) res.header("cache-control", "no-cache");
      if (path.endsWith(".webmanifest")) res.header("content-type", "application/manifest+json; charset=utf-8");
      if (path.includes("/assets/")) res.header("cache-control", "public, max-age=31536000, immutable");
    },
  });
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split("?")[0];
    const isAsset = /\.[a-z0-9]{2,5}$/i.test(path) || path.startsWith("/assets/") || path.startsWith("/pdfjs/");
    // /integrations/ no cae en la SPA: un archivo que falta es un 404 (no una página de la app con estado 200).
    const isIntegration = path === "/integrations" || path.startsWith(INTEGRATIONS_PREFIX);
    // HEAD como GET (monitores de disponibilidad, vistas previas de links): antes respondía 404 en cualquier página.
    const page = req.method === "GET" || req.method === "HEAD";
    if (page && !isAsset && !isIntegration && !path.startsWith("/v1/") && !path.startsWith("/dev/")) {
      // index.html nombra los archivos con hash del deploy actual: siempre se revalida. cacheControl: false para que
      // @fastify/static no reemplace este encabezado por su "public, max-age=0".
      reply.header("cache-control", "no-cache");
      // Marca blanca: link de firma, formulario, verificación o dominio de una marca → index.html con su tema.
      if (opts.sendBrandedIndex && (await opts.sendBrandedIndex(req, reply))) return reply;
      return reply.sendFile("index.html", { cacheControl: false });
    }
    return reply.code(404).send({ error: { code: "not_found", message: "Ruta no encontrada" } });
  });
}
