import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { PdfIngestBusyError } from "@calasign/pdf";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config";
import { queueHealth } from "./infra/queue";
import type { Db } from "./infra/db";
import type { BlobStore } from "./infra/storage";
import { AppError, rateLimitError } from "./lib/errors";
import { markBearerAuthRoutes, rateLimitIdentity, rateLimitIpKey, type RateLimitIdentity } from "./lib/ip";
import { requestPath } from "./lib/util";
import { LOG_REDACT_PATHS, safeRequestSerializer } from "./lib/redact";
import { readMailbox } from "./notifications/channels";
import { authRoutes } from "./modules/auth";
import { authenticate, bearerCredentialTenant } from "./modules/context";
import { envelopeRoutes } from "./modules/envelopes";
import { signingRoutes } from "./modules/signing";
import { signerFeatureRoutes } from "./modules/signer-features";
import { telegramRoutes } from "./modules/telegram";
import { sesFeedbackRoutes } from "./notifications/ses-feedback";
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
import { isInternalAgentRequest } from "./modules/mcp/agent-actor";
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
import { lowcodeRoutes } from "./modules/lowcode";
import { connectorRoutes } from "./modules/connectors";

import { dataRoutes } from "./modules/data";
import { certsignRoutes } from "./modules/certsign";
import { sendBrandedIndex, whiteLabelModule } from "./modules/white-label";
import { devApiRoutes } from "./modules/devapi";
import { INTEGRATIONS_PREFIX, integrationsStaticHeaders } from "./modules/integrations-static";

/** Ver el hook que la pone en buildApp. */
export const PERMISSIONS_POLICY = "camera=(self), microphone=(), geolocation=(), payment=(), usb=()";
// Páginas públicas del front que muestran el captcha de Turnstile (<Captcha>): el formulario público (/f/:slug,
// PublicForm) y el inicio de un flujo público (/wf/:slug, PublicWorkflowStartPage). Una página nueva con captcha tiene
// que sumarse acá, si no el navegador bloquea el script y el iframe de Cloudflare.
export const TURNSTILE_PAGE_PREFIXES = ["/f/", "/wf/"] as const;

/** Suma `origin` a script-src y frame-src de un CSP (frame-src se crea si no está, con 'self' como el default-src). */
export function withTurnstile(csp: string, origin: string): string {
  const parts = csp.split(";").map((d) => d.trim()).filter(Boolean);
  const add = (name: string, fallback: string) => {
    const k = parts.findIndex((d) => d.split(/\s+/)[0].toLowerCase() === name);
    if (k >= 0) parts[k] = `${parts[k]} ${origin}`;
    else parts.push(`${name} ${fallback} ${origin}`);
  };
  add("script-src", "'self'");
  add("frame-src", "'self'");
  return parts.join(";");
}

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
    // Saltos de proxy de confianza (Caddy en dev = 1; un ALB detrás de CloudFront = 2). Con `true` se tomaba la IP de más
    // a la izquierda de X-Forwarded-For, que la elige el cliente si el proxy la conserva (un ALB la conserva): saltaba
    // los límites por IP y dejaba una IP falsa en la auditoría y en la evidencia del sobre.
    trustProxy: (_addr: string, hop: number) => hop < config.trustProxyHops,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  // Cloudflare Turnstile en los formularios web públicos (opcional): su script y su iframe, solo si está configurado y
  // solo en el documento de /f/* (ver el onSend de abajo): el resto de la app no le permite cargar scripts de terceros.
  const turnstile = config.webForms.turnstileSiteKey && config.webForms.turnstileSecretKey ? "https://challenges.cloudflare.com" : null;
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
  // Permissions-Policy: la cámara solo para el propio origen (captura de identidad del firmante, IdentityGate). En la
  // página del firmante embebida en un iframe del integrador, "self" es nuestro origen (el del documento del iframe),
  // así que la cámara sigue disponible si el integrador la delega con allow="camera": esta política limita lo que
  // nosotros delegamos a iframes de terceros dentro de nuestras páginas, no lo que el padre nos delega a nosotros. El
  // resto de las capacidades no se usan en ninguna página.
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("permissions-policy", PERMISSIONS_POLICY);
  });
  if (turnstile) {
    // El CSP se arma por respuesta: solo los documentos de las páginas públicas que muestran el captcha suman
    // Turnstile (TURNSTILE_PAGE_PREFIXES). Se entra ahí siempre con una carga completa (link público o iframe), así que
    // el CSP del documento es el de esa ruta.
    app.addHook("onSend", async (req, reply, payload) => {
      if (req.method !== "GET" && req.method !== "HEAD") return payload;
      const path = requestPath(req);
      if (!TURNSTILE_PAGE_PREFIXES.some((p) => path.startsWith(p))) return payload;
      const csp = reply.getHeader("content-security-policy");
      if (typeof csp === "string" && csp) reply.header("content-security-policy", withTurnstile(csp, turnstile));
      return payload;
    });
  }
  await app.register(cookie);
  // Campos de texto acotados: sin tope, busboy admitía ~1000 campos de 1 MB por pedido (todos en memoria). Las rutas que
  // necesitan más (subida en un paso, "meta" de un acuerdo) pasan los suyos en req.parts()/req.file().
  await app.register(multipart, { limits: { files: 1, fileSize: config.maxUploadBytes, fields: 10, fieldSize: 64 * 1024, parts: 12, headerPairs: 50 } });
  // X-Request-Id en toda respuesta (también errores, 429 del límite, 404 y las que escriben directo sobre la conexión,
  // como el stream de eventos y /mcp): es el id de los logs, el que los SDK muestran como requestId. Antes de los
  // hooks del límite de pedidos para que el 429 también lo lleve.
  app.addHook("onRequest", async (req, reply) => {
    reply.raw.setHeader("x-request-id", req.id);
  });
  // Rutas con authenticate(): con límite propio cuentan por organización de la credencial (lib/ip.ts rateLimitIdentity).
  app.addHook("onRoute", (opts) => markBearerAuthRoutes(opts));
  // Clave del límite, una vez por pedido (la usan el tope por IP y organización y el límite global o de la ruta).
  const rateLimitIds = new WeakMap<FastifyRequest, Promise<RateLimitIdentity>>();
  const verifyCredential = (token: string) => bearerCredentialTenant(deps.db, token);
  const identityOf = (req: FastifyRequest) => {
    let p = rateLimitIds.get(req);
    if (!p) rateLimitIds.set(req, (p = rateLimitIdentity(req, verifyCredential)));
    return p;
  };
  // En el entorno local (pruebas de punta a punta seguidas) la IP local no tiene límite; en dev y prod sí.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    // Por IP y, en IPv6, por /64; con una credencial Bearer válida (verificada contra la base, con caché), por
    // credencial (hash); en las rutas con límite propio que autentican, por organización (lib/ip.ts rateLimitIdentity). El store
    // es el de memoria del proceso: el límite es por réplica. Las IPs sin límite del entorno local se comparan con la
    // clave de IP (loopback queda igual; ::ffff:127.0.0.1 pasa a 127.0.0.1), también con credencial.
    keyGenerator: async (req) => (await identityOf(req)).key,
    allowList: config.environment === "local" ? (req) => ["127.0.0.1", "::1"].includes(rateLimitIpKey(req.ip)) : [],
    // Código rate_limited y texto en español (los conectores y SDK tratan rate_limited igual que el bad_request de antes).
    errorResponseBuilder: rateLimitError,
  });
  // Tope grueso por (IP, organización) para el tráfico que cuenta por credencial: varias keys de una misma organización
  // desde una IP no multiplican sin fin el cupo; organizaciones distintas detrás de una misma IP (un cliente MCP
  // alojado, Zapier) no se lo reparten. Holgado (5 veces el global). No cuenta los pedidos internos del servidor MCP
  // (app.inject con el secreto en memoria del proceso): el pedido a /mcp ya contó.
  const ipCeiling = app.createRateLimit({
    max: 3000,
    timeWindow: "1 minute",
    keyGenerator: async (req) => `ipceil:${rateLimitIpKey(req.ip)}:${(await identityOf(req)).tenantId}`,
  });
  app.addHook("onRequest", async (req, reply) => {
    if (isInternalAgentRequest(req)) return;
    if (!(await identityOf(req)).tenantId) return;
    const r = await ipCeiling(req);
    if (r.isAllowed || !r.isExceeded) return;
    reply.header("retry-after", r.ttlInSeconds);
    throw rateLimitError(req, { statusCode: 429, ttl: r.ttl });
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
      // Errores del momento (503 template_busy, …): cuándo reintentar.
      const retryAfter = (err.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (err.status === 503 && typeof retryAfter === "number") reply.header("retry-after", String(retryAfter));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // Tope de PDFs procesándose a la vez (packages/pdf ingest-limit): reintentable.
    if (err instanceof PdfIngestBusyError) {
      reply.header("retry-after", String(err.retryAfterSeconds));
      return reply.code(503).send({ error: { code: err.code, message: err.message } });
    }
    // Errores de Postgres que son del pedido, no del servidor: un id que no es UUID (22P02) o una carrera contra
    // una restricción única (23505, p. ej. dos altas simultáneas con el mismo correo).
    const pgCode = (err as { code?: unknown }).code;
    if (pgCode === "22P02") return reply.code(400).send({ error: { code: "invalid_id", message: "Identificador inválido" } });
    if (pgCode === "23505") return reply.code(409).send({ error: { code: "conflict", message: "El recurso ya existe o cambió al mismo tiempo; reintentá" } });
    // Serialización (40001) o deadlock (40P01) contra otro pedido simultáneo: del momento, se reintenta.
    if (pgCode === "40001" || pgCode === "40P01") {
      reply.header("retry-after", "1");
      return reply.code(503).send({ error: { code: "concurrent_update", message: "Otro cambio simultáneo cruzó este pedido: reintentá en unos segundos" } });
    }
    // Texto con el carácter NUL (\u0000): Postgres lo rechaza en columnas de texto (22021) y en jsonb (22P05). Lo manda
    // el cliente (p. ej. el motivo de un rechazo o un asunto): es un pedido inválido, no un error interno.
    // La TSA externa falló (red, rechazo): no es un error interno de la plataforma.
    if ((err as Error)?.name === "TsaError") {
      return reply.code(502).send({ error: { code: "tsa_unavailable", message: "La autoridad de sellado de tiempo no respondió como se esperaba: reintentá en unos minutos" } });
    }
    // Fechas que JS acepta y Postgres no (año 0, años de más de 4 dígitos): 400, no 500.
    if (pgCode === "22007" || pgCode === "22008" || pgCode === "22009") return reply.code(400).send({ error: { code: "invalid_date", message: "Fecha fuera de rango o inválida" } });
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
    const path = requestPath(req);
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !path.startsWith("/v1/")) return;
    if (path.startsWith("/v1/integrations/")) return;
    const origin = req.headers.origin;
    if (!origin || req.headers.authorization) return;
    const allowed = new Set([new URL(config.appUrl).origin, `${req.protocol}://${req.headers.host}`]);
    if (!allowed.has(origin)) return reply.code(403).send({ error: { code: "bad_origin", message: "Origen no permitido" } });
  });

  // La API no se cachea en el navegador ni en proxies salvo que la ruta lo diga (logo de marca, PDFs de vista previa,
  // OpenAPI…): toda respuesta /v1/* sin cache-control propio sale "private, no-store" (datos de la sesión, links de
  // firma, errores). Las rutas que ponen su encabezado lo conservan.
  app.addHook("onSend", async (req, reply, payload) => {
    if (!reply.hasHeader("cache-control") && requestPath(req).startsWith("/v1/")) reply.header("cache-control", "private, no-store");
    return payload;
  });

  // Conectores MCP desde el navegador: CORS abierto (sin cookies) en los endpoints OAuth/MCP (ver mcp/cors.ts).
  registerConnectorCors(app);

  const services = { db: deps.db, blobs: deps.blobs };
  // Público (lo usa el deploy): sin datos del entorno.
  app.get("/healthz", async () => {
    await deps.db.query("SELECT 1");
    return { ok: true };
  });
  // Estado de la cola (latido de los workers, edad del pendiente más viejo listo para correr): solo desde la propia
  // máquina y sin pasar por el proxy (Caddy/ALB agregan X-Forwarded-For). Sin ids de worker ni datos de jobs.
  app.get("/internal/health", async (req, reply) => {
    const loopback = (a: string | undefined) => !!a && (a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127."));
    const proxied = req.headers["x-forwarded-for"] !== undefined || req.headers.forwarded !== undefined || req.headers["x-real-ip"] !== undefined;
    if (proxied || !loopback(req.socket.remoteAddress) || !loopback(req.ip)) return reply.code(404).send({ error: { code: "not_found", message: "No encontrado" } });
    return { ok: true, queue: await queueHealth(deps.db) };
  });
  await authRoutes(app, services);
  await envelopeRoutes(app, services);
  await signerFeatureRoutes(app, services);
  await identityRoutes(app, services);
  await signingRoutes(app, services);
  await telegramRoutes(app, services);
  await sesFeedbackRoutes(app, services);
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
  await lowcodeRoutes(app, services);
  await connectorRoutes(app, services);
  await dataRoutes(app, services);
  await certsignRoutes(app, services);
  await whiteLabelModule(app, services);
  await devApiRoutes(app, services);

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
