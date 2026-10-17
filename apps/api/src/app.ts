import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config";
import type { Db } from "./infra/db";
import type { BlobStore } from "./infra/storage";
import { AppError } from "./lib/errors";
import { readMailbox } from "./notifications/channels";
import { authRoutes } from "./modules/auth";
import { authenticate } from "./modules/context";
import { envelopeRoutes } from "./modules/envelopes";
import { signingRoutes } from "./modules/signing";
import { telegramRoutes } from "./modules/telegram";

export async function buildApp(deps: { db: Db; blobs: BlobStore; logger?: boolean | object }) {
  const app = Fastify({
    logger: deps.logger ?? { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:"],
        workerSrc: ["'self'", "blob:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fileSize: config.maxUploadBytes } });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "),
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ error: { code: fe.code ?? "bad_request", message: fe.message } });
    }
    req.log.error({ err }, "error no controlado");
    return reply.code(500).send({ error: { code: "internal_error", message: "Error interno" } });
  });

  // Solo peticiones de la misma web pueden usar la cookie para modificar (defensa CSRF adicional a SameSite=Lax).
  app.addHook("onRequest", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.url.startsWith("/v1/")) return;
    if (req.url.startsWith("/v1/integrations/")) return;
    const origin = req.headers.origin;
    if (!origin || req.headers.authorization) return;
    const allowed = new Set([new URL(config.appUrl).origin, `${req.protocol}://${req.headers.host}`]);
    if (!allowed.has(origin)) return reply.code(403).send({ error: { code: "bad_origin", message: "Origen no permitido" } });
  });

  const services = { db: deps.db, blobs: deps.blobs };
  app.get("/healthz", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true, env: config.environment };
  });
  await authRoutes(app, services);
  await envelopeRoutes(app, services);
  await signingRoutes(app, services);
  await telegramRoutes(app, services);

  if (config.devMailbox) {
    // Local: todo el buzón. Entornos compartidos (dev): solo los mensajes de la organización de la sesión.
    const auth = authenticate(services);
    app.get("/dev/mailbox", { preHandler: config.environment === "local" ? [] : [auth] }, async (req) => ({
      items: await readMailbox(req.auth?.tenantId ?? null),
    }));
  }

  // Web (SPA) servida desde el mismo origen.
  if (existsSync(resolve(config.webDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders(res, path) {
        if (path.endsWith(".mjs")) res.header("content-type", "text/javascript; charset=utf-8");
        if (path.includes("/assets/")) res.header("cache-control", "public, max-age=31536000, immutable");
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/v1/") && !req.url.startsWith("/dev/")) {
        reply.header("cache-control", "no-cache");
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: { code: "not_found", message: "Ruta no encontrada" } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Ruta no encontrada" } }));
  }

  return app;
}
