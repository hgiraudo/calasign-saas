// Servidor MCP (Model Context Protocol) para agentes de IA: Streamable HTTP en /mcp, sin estado.
// Autenticación: access token OAuth 2.0 (scopes de la app) o API key, en `Authorization: Bearer …`.
// Cada herramienta llama a la API v1 por dentro (app.inject) con esa misma credencial, así que RBAC, scopes,
// límites del plan, validaciones y evidencia son exactamente los mismos que por HTTP.
// Las herramientas con efecto hacia afuera (enviar, anular) exigen `confirm: true`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ENVELOPE_STATUSES, OAUTH_SCOPES } from "@calasign/shared";
import { config } from "../../config";
import { notFound } from "../../lib/errors";
import { randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import type { Services } from "../context";
import { sendPdf } from "../envelopes";
import { isOAuthAccessToken, resolveAccessToken } from "../oauth-tokens";
import { tenantPlan } from "../billing/plans";
import { agentHeaders } from "./agent-actor";

interface Caller {
  authorization: string;
  tenantId: string;
  name: string;
  ip: string;
}

class ToolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

const SERVER_INFO = { name: "calasign", version: "1.0.0" };

const INSTRUCTIONS =
  "CalaSign: firma electrónica. Con estas herramientas podés listar y consultar sobres, crear un sobre a partir de una " +
  "plantilla, enviarlo y descargar el PDF firmado. Enviar o anular un sobre tiene efecto real (llegan correos/WhatsApp a " +
  "personas): antes de llamar a send_envelope o void_envelope con confirm=true, mostrale al usuario el resumen y pedile " +
  "que lo apruebe explícitamente.";

export async function mcpRoutes(app: FastifyInstance, s: Services) {
  const resourceUrl = `${config.appUrl}/mcp`;

  function unauthorizedReply(reply: FastifyReply, message: string) {
    reply
      .code(401)
      .header("www-authenticate", `Bearer resource_metadata="${config.appUrl}/.well-known/oauth-protected-resource"`)
      .send({ error: { code: "unauthorized", message } });
  }

  async function resolveCaller(req: FastifyRequest): Promise<Caller | null> {
    const authz = req.headers.authorization;
    if (!authz?.startsWith("Bearer ")) return null;
    const token = authz.slice(7).trim();
    if (isOAuthAccessToken(token)) {
      const o = await resolveAccessToken(s.db, token);
      if (!o) return null;
      return { authorization: authz, tenantId: o.tenantId, name: o.clientName, ip: req.ip };
    }
    const k = await s.db.one<any>(`SELECT tenant_id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [sha256Hex(token)]);
    if (!k) return null;
    return { authorization: authz, tenantId: k.tenant_id, name: `MCP · ${k.name}`, ip: req.ip };
  }

  /** Llama a la API v1 con la credencial del agente. */
  async function api(c: Caller, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<any> {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: c.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": `MCP (${c.name})`,
        ...agentHeaders(c.name),
      },
      remoteAddress: c.ip,
    });
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = null;
    }
    if (res.statusCode >= 400) throw new ToolError(json?.error?.message ?? `HTTP ${res.statusCode}`, res.statusCode, json?.error?.code ?? null);
    return json;
  }

  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (message: string, extra?: unknown) => ({
    isError: true,
    content: [{ type: "text" as const, text: extra ? `${message}\n${JSON.stringify(extra, null, 2)}` : message }],
  });
  /** Envuelve una herramienta: los errores de la API vuelven como resultado con isError (no como error de protocolo). */
  const guard =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        const r = await fn(args);
        return (r as any)?.isError ? (r as any) : ok(r);
      } catch (err) {
        if (err instanceof ToolError) {
          const hint =
            err.status === 402
              ? " (límite del plan: hay que mejorar el plan en Ajustes → Plan y facturación)"
              : err.code === "insufficient_scope"
                ? " (el token no tiene el scope necesario)"
                : "";
          return fail(`Error ${err.status}${err.code ? ` ${err.code}` : ""}: ${err.message}${hint}`);
        }
        throw err;
      }
    };

  const summarizeDetail = (d: any) => ({
    id: d.envelope.id,
    subject: d.envelope.subject,
    status: d.envelope.status,
    createdAt: d.envelope.createdAt,
    sentAt: d.envelope.sentAt,
    completedAt: d.envelope.completedAt,
    expiresAt: d.envelope.expiresAt,
    documents: d.documents.map((x: any) => ({ id: x.id, name: x.name, pages: x.pageCount })),
    recipients: d.recipients.map((r: any) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      role: r.role,
      routingOrder: r.routingOrder,
      status: r.status,
      signedAt: r.signedAt,
    })),
    fields: d.fields.length,
  });

  function buildServer(c: Caller): McpServer {
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

    server.registerTool(
      "list_envelopes",
      {
        title: "Listar sobres",
        description: "Lista los sobres de la organización (los más recientes primero). Filtros opcionales por estado y texto.",
        inputSchema: {
          status: z.enum(ENVELOPE_STATUSES).optional().describe("Estado: draft, sent, completed, declined, voided, expired…"),
          query: z.string().max(200).optional().describe("Texto a buscar en asunto o destinatarios"),
          limit: z.number().int().min(1).max(50).optional(),
          cursor: z.string().max(500).optional().describe("nextCursor de una página anterior"),
        },
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { status?: string; query?: string; limit?: number; cursor?: string }) => {
        const q = new URLSearchParams();
        if (a.status) q.set("status", a.status);
        if (a.query) q.set("q", a.query);
        q.set("limit", String(a.limit ?? 20));
        if (a.cursor) q.set("cursor", a.cursor);
        const r = await api(c, "GET", `/v1/envelopes?${q}`);
        return {
          items: r.items.map((e: any) => ({
            id: e.id,
            subject: e.subject,
            status: e.status,
            createdAt: e.createdAt,
            completedAt: e.completedAt,
            recipients: e.recipients.map((x: any) => `${x.name} (${x.role}: ${x.status})`),
          })),
          nextCursor: r.nextCursor,
        };
      }),
    );

    server.registerTool(
      "get_envelope",
      {
        title: "Ver un sobre",
        description: "Detalle de un sobre: documentos, destinatarios y su estado.",
        inputSchema: { envelopeId: z.string().uuid() },
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { envelopeId: string }) => summarizeDetail(await api(c, "GET", `/v1/envelopes/${a.envelopeId}`))),
    );

    server.registerTool(
      "get_signing_status",
      {
        title: "Estado de firma",
        description: "En qué está un sobre: quién firmó, quién falta y los últimos eventos del registro de evidencia.",
        inputSchema: { envelopeId: z.string().uuid() },
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { envelopeId: string }) => {
        const [d, ev] = await Promise.all([api(c, "GET", `/v1/envelopes/${a.envelopeId}`), api(c, "GET", `/v1/envelopes/${a.envelopeId}/events`)]);
        const signers = d.recipients.filter((r: any) => r.role !== "cc");
        return {
          id: d.envelope.id,
          subject: d.envelope.subject,
          status: d.envelope.status,
          completedAt: d.envelope.completedAt,
          signed: signers.filter((r: any) => r.status === "signed" || r.status === "completed").map((r: any) => ({ name: r.name, at: r.signedAt })),
          pending: signers.filter((r: any) => !["signed", "completed", "declined", "delegated", "reassigned"].includes(r.status)).map((r: any) => ({ name: r.name, status: r.status })),
          declined: signers.filter((r: any) => r.status === "declined").map((r: any) => ({ name: r.name, reason: r.declineReason })),
          signedPdfAvailable: d.envelope.status === "completed",
          lastEvents: ev.items.slice(-15).map((x: any) => ({ at: x.occurredAt, type: x.type, actor: x.actorLabel })),
        };
      }),
    );

    server.registerTool(
      "list_templates",
      {
        title: "Listar plantillas",
        description: "Plantillas disponibles, con sus roles (para create_envelope_from_template).",
        inputSchema: { query: z.string().max(200).optional() },
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { query?: string }) => {
        const r = await api(c, "GET", `/v1/templates${a.query ? `?q=${encodeURIComponent(a.query)}` : ""}`);
        return {
          items: r.items.map((t: any) => ({ id: t.id, name: t.name, description: t.description, documents: t.documentCount, roles: t.roles })),
        };
      }),
    );

    server.registerTool(
      "create_envelope_from_template",
      {
        title: "Crear sobre desde plantilla",
        description:
          "Crea un sobre en BORRADOR a partir de una plantilla, asignando una persona a cada rol. No envía nada: " +
          "para enviarlo usá send_envelope (con confirmación del usuario).",
        inputSchema: {
          templateId: z.string().uuid(),
          subject: z.string().min(1).max(300).optional(),
          message: z.string().max(5000).optional(),
          recipients: z
            .array(
              z.object({
                role: z.string().max(100).describe("Nombre del rol de la plantilla"),
                name: z.string().min(1).max(200),
                email: z.string().email().optional(),
                phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional().describe("E.164, ej. +5511999990000"),
                channels: z.array(z.enum(["email", "whatsapp", "telegram"])).optional(),
              }),
            )
            .min(1)
            .max(50),
          prefill: z.record(z.string(), z.string().max(2000)).optional().describe("Valores de campos por etiqueta o id"),
        },
      },
      guard(async (a: any) => {
        const d = await api(c, "POST", "/v1/envelopes/from-template", {
          templateId: a.templateId,
          subject: a.subject,
          message: a.message,
          prefill: a.prefill,
          recipients: a.recipients.map((r: any) => ({
            role: r.role,
            name: r.name,
            email: r.email ?? null,
            phone: r.phone ?? null,
            channels: r.channels ?? (r.email ? ["email"] : ["whatsapp"]),
          })),
          send: false,
        });
        return { ...summarizeDetail(d), next: "Borrador creado. Mostrale el resumen al usuario y, si lo aprueba, llamá a send_envelope con confirm: true." };
      }),
    );

    server.registerTool(
      "send_envelope",
      {
        title: "Enviar sobre",
        description:
          "Envía un sobre en borrador: les llegan las invitaciones a los firmantes. ACCIÓN CON EFECTO REAL: requiere " +
          "confirm=true y solo debe usarse después de que el usuario lo apruebe explícitamente.",
        inputSchema: {
          envelopeId: z.string().uuid(),
          confirm: z.boolean().optional().describe("true solo si el usuario aprobó el envío"),
        },
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      guard(async (a: { envelopeId: string; confirm?: boolean }) => {
        if (a.confirm !== true) {
          const d = await api(c, "GET", `/v1/envelopes/${a.envelopeId}`);
          return fail("Confirmación requerida: enviar notifica a personas reales. Mostrale este resumen al usuario y, si lo aprueba, volvé a llamar con confirm: true.", {
            subject: d.envelope.subject,
            status: d.envelope.status,
            recipients: d.recipients.map((r: any) => `${r.name} <${r.email ?? r.phone ?? "—"}> (${r.role})`),
          });
        }
        const d = await api(c, "POST", `/v1/envelopes/${a.envelopeId}/send`);
        return summarizeDetail(d);
      }),
    );

    server.registerTool(
      "void_envelope",
      {
        title: "Anular sobre",
        description: "Anula un sobre en curso (los firmantes reciben el aviso). ACCIÓN CON EFECTO REAL: requiere confirm=true.",
        inputSchema: {
          envelopeId: z.string().uuid(),
          reason: z.string().min(1).max(1000),
          confirm: z.boolean().optional().describe("true solo si el usuario aprobó la anulación"),
        },
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      guard(async (a: { envelopeId: string; reason: string; confirm?: boolean }) => {
        if (a.confirm !== true) {
          const d = await api(c, "GET", `/v1/envelopes/${a.envelopeId}`);
          return fail("Confirmación requerida: anular avisa a los firmantes y no se puede deshacer. Pedile al usuario que lo apruebe y volvé a llamar con confirm: true.", {
            subject: d.envelope.subject,
            status: d.envelope.status,
            reason: a.reason,
          });
        }
        return summarizeDetail(await api(c, "POST", `/v1/envelopes/${a.envelopeId}/void`, { reason: a.reason }));
      }),
    );

    server.registerTool(
      "download_signed_pdf",
      {
        title: "Descargar PDF firmado",
        description: `Devuelve una URL temporal (${Math.round(config.mcp.downloadLinkTtlSec / 60)} min) para descargar el PDF sellado con su certificado de finalización. Solo para sobres completados.`,
        inputSchema: { envelopeId: z.string().uuid() },
        annotations: { readOnlyHint: true },
      },
      guard(async (a: { envelopeId: string }) => {
        const d = await api(c, "GET", `/v1/envelopes/${a.envelopeId}`); // control de acceso de la API
        if (d.envelope.status !== "completed") return fail(`El sobre está en estado "${d.envelope.status}": el PDF firmado existe recién cuando se completa.`);
        const e = await s.db.one<any>(`SELECT signed_file_id FROM envelopes WHERE id = $1 AND tenant_id = $2`, [a.envelopeId, c.tenantId]);
        if (!e?.signed_file_id) return fail("El sobre no tiene PDF firmado.");
        const token = randomToken(32);
        const expiresAt = new Date(Date.now() + config.mcp.downloadLinkTtlSec * 1000);
        await s.db.query(
          `INSERT INTO download_links (id, token_hash, tenant_id, envelope_id, file_id, created_by_label, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv7(), sha256Hex(token), c.tenantId, a.envelopeId, e.signed_file_id, `agente IA (${c.name})`, expiresAt.toISOString()],
        );
        return { url: `${config.appUrl}/v1/downloads/${token}`, expiresAt: expiresAt.toISOString(), sha256: d.envelope.signedSha256 };
      }),
    );

    return server;
  }

  // ───────── Transporte Streamable HTTP (sin sesión: cada POST es independiente) ─────────

  app.post("/mcp", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (req, reply) => {
    const caller = await resolveCaller(req);
    if (!caller) return unauthorizedReply(reply, "Hace falta un access token OAuth o una API key válidos");
    const { plan } = await tenantPlan(s.db, caller.tenantId);
    if (!plan.features.includes("api")) {
      return reply.code(402).send({ error: { code: "plan_limit", message: `El acceso por API y MCP no está incluido en el plan ${plan.name}` } });
    }
    const server = buildServer(caller);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, "error en el servidor MCP");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno" }, id: null }));
      }
    }
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido: este servidor MCP no usa sesiones" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // ───────── Descubrimiento OAuth (RFC 9728 / RFC 8414) para clientes MCP ─────────

  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: resourceUrl,
    authorization_servers: [config.appUrl],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "CalaSign MCP",
    resource_documentation: `${config.appUrl}/developers#mcp`,
  }));
  app.get("/.well-known/oauth-protected-resource/mcp", async () => ({
    resource: resourceUrl,
    authorization_servers: [config.appUrl],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
  }));
  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: config.appUrl,
    authorization_endpoint: `${config.appUrl}/oauth/authorize`,
    token_endpoint: `${config.appUrl}/oauth/token`,
    revocation_endpoint: `${config.appUrl}/oauth/revoke`,
    introspection_endpoint: `${config.appUrl}/oauth/introspect`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    scopes_supported: OAUTH_SCOPES,
  }));

  // ───────── Descarga con link temporal ─────────

  app.get<{ Params: { token: string } }>("/v1/downloads/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(req.params.token)) throw notFound("Link");
    const l = await s.db.one<any>(
      `SELECT l.id, l.expires_at, f.storage_key, e.subject FROM download_links l JOIN files f ON f.id = l.file_id JOIN envelopes e ON e.id = l.envelope_id
       WHERE l.token_hash = $1`,
      [sha256Hex(req.params.token)],
    );
    if (!l || new Date(l.expires_at) <= new Date()) throw notFound("Link");
    await s.db.query(`UPDATE download_links SET downloads = downloads + 1 WHERE id = $1`, [l.id]);
    return sendPdf(reply, await s.blobs.get(l.storage_key), l.subject);
  });
}
