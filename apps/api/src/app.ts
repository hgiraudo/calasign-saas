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
import { LOG_REDACT_PATHS, safeRequestSerializer } from "./lib/redact";
import { readMailbox } from "./notifications/channels";
import { authRoutes } from "./modules/auth";
import { authenticate } from "./modules/context";
import { envelopeRoutes } from "./modules/envelopes";
import { signingRoutes } from "./modules/signing";
import { signerFeatureRoutes } from "./modules/signer-features";
import { telegramRoutes } from "./modules/telegram";
import { webhookRoutes } from "./modules/webhooks";
import { embedRoutes } from "./modules/embed";
import { openApiRoutes } from "./modules/openapi";
import { productivityRoutes } from "./modules/productivity";
import { teamRoutes } from "./modules/teams";
import { auditRoutes, registerAuditHooks } from "./modules/audit";
import { retentionRoutes } from "./modules/retention";
import { experienceRoutes } from "./modules/experience";
import { scaleRoutes } from "./modules/scale";
import { oauthRoutes } from "./modules/oauth";
import { registerConnectorCors } from "./modules/mcp/cors";
import { notificationIntegrationRoutes } from "./modules/notify-integrations";
import { storageRoutes } from "./modules/storage-export";
import { customDomainRoutes } from "./modules/custom-domains";
import { identityRoutes } from "./modules/identity";
import { evidenceRoutes } from "./modules/evidence";
import { billingRoutes } from "./modules/billing";
import { mcpRoutes } from "./modules/mcp";
import { aiRoutes } from "./modules/ai";
import { agreementRoutes } from "./modules/agreements";
import { crmRoutes } from "./modules/crm";

import { dataRoutes } from "./modules/data";
import { certsignRoutes } from "./modules/certsign";
import { sendBrandedIndex, whiteLabelModule } from "./modules/white-label";
import { INTEGRATIONS_PREFIX, integrationsStaticHeaders } from "./modules/integrations-static";

export async function buildApp(deps: { db: Db; blobs: BlobStore; logger?: boolean | object }) {
  // Logs sin secretos: los tokens de firma, invitaciones, códigos y credenciales viajan en la URL o en headers.
  const safeLogger = { level: config.logLevel, serializers: { req: safeRequestSerializer }, redact: { paths: LOG_REDACT_PATHS, censor: "[redactado]" } };
  const logger =
    deps.logger === undefined
      ? safeLogger
      : typeof deps.logger === "object"
        ? { ...safeLogger, ...deps.logger, serializers: { ...safeLogger.serializers, ...((deps.logger as { serializers?: object }).serializers ?? {}) } }
        : deps.logger;
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Google Fonts: tipografía de la marca blanca (white-label/brand.ts).
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
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
  // En el entorno local (pruebas de punta a punta seguidas) la IP local no tiene límite; en dev y prod sí.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    allowList: config.environment === "local" ? ["127.0.0.1", "::1", "::ffff:127.0.0.1"] : [],
  });

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
    // Errores de Postgres que son del pedido, no del servidor: un id que no es UUID (22P02) o una carrera contra
    // una restricción única (23505, p. ej. dos altas simultáneas con el mismo correo).
    const pgCode = (err as { code?: unknown }).code;
    if (pgCode === "22P02") return reply.code(400).send({ error: { code: "invalid_id", message: "Identificador inválido" } });
    if (pgCode === "23505") return reply.code(409).send({ error: { code: "conflict", message: "El recurso ya existe o cambió al mismo tiempo; reintentá" } });
    // Texto con el carácter NUL (\u0000): Postgres lo rechaza en columnas de texto (22021) y en jsonb (22P05). Lo manda
    // el cliente (p. ej. el motivo de un rechazo o un asunto): es un pedido inválido, no un error interno.
    if (pgCode === "22021" || pgCode === "22P05") return reply.code(400).send({ error: { code: "invalid_text", message: "El texto contiene caracteres no admitidos" } });
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

  // Conectores MCP desde el navegador: CORS abierto (sin cookies) en los endpoints OAuth/MCP (ver mcp/cors.ts).
  registerConnectorCors(app);

  const services = { db: deps.db, blobs: deps.blobs };
  app.get("/healthz", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true, env: config.environment };
  });
  await authRoutes(app, services);
  await envelopeRoutes(app, services);
  await signerFeatureRoutes(app, services);
  await identityRoutes(app, services);
  await signingRoutes(app, services);
  await telegramRoutes(app, services);
  await webhookRoutes(app, services);
  await embedRoutes(app, services);
  await openApiRoutes(app);
  await productivityRoutes(app, services);
  registerAuditHooks(app, services);
  await teamRoutes(app, services);
  await auditRoutes(app, services);
  await retentionRoutes(app, services, app.log);
  await experienceRoutes(app, services);
  await scaleRoutes(app, services);
  await oauthRoutes(app, services);
  await notificationIntegrationRoutes(app, services);
  await storageRoutes(app, services);
  await customDomainRoutes(app, services);
  await evidenceRoutes(app, services);
  await billingRoutes(app, services);
  await mcpRoutes(app, services);
  await aiRoutes(app, services);
  await agreementRoutes(app, services);
  await crmRoutes(app, services);
  await dataRoutes(app, services);
  await certsignRoutes(app, services);
  await whiteLabelModule(app, services);

  if (config.devMailbox) {
    // Local: todo el buzón. Entornos compartidos (dev): solo los mensajes de la organización de la sesión.
    const auth = authenticate(services);
    app.get("/dev/mailbox", { preHandler: config.environment === "local" ? [] : [auth] }, async (req) => ({
      items: await readMailbox(req.auth?.tenantId ?? null),
    }));
  }

  // Web (SPA) servida desde el mismo origen.
  if (existsSync(resolve(config.webDist, "index.html"))) {
    // /integrations/*: descargas y complemento de Office (encabezados propios, ver integrations-static.ts).
    integrationsStaticHeaders(app);
    await app.register(fastifyStatic, {
      root: config.webDist,
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
      if (req.method === "GET" && !isAsset && !isIntegration && !path.startsWith("/v1/") && !path.startsWith("/dev/")) {
        reply.header("cache-control", "no-cache");
        // Marca blanca: link de firma, formulario, verificación o dominio de una marca → index.html con su tema.
        if (await sendBrandedIndex(deps.db, req, reply)) return reply;
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: { code: "not_found", message: "Ruta no encontrada" } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Ruta no encontrada" } }));
  }

  return app;
}
