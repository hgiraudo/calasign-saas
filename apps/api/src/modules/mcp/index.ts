// Servidor MCP (Model Context Protocol) para agentes de IA: Streamable HTTP en /mcp, sin estado.
// Autenticación: access token OAuth 2.0 (scopes de la app) o API key, en `Authorization: Bearer …`.
// Cada herramienta llama a la API v1 por dentro (app.inject) con esa misma credencial, así que RBAC, scopes,
// límites del plan, validaciones y evidencia son exactamente los mismos que por HTTP.
// Las herramientas con efecto hacia afuera (enviar, anular) exigen `confirm: true`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { inspectPdf } from "@calasign/pdf";
import { ENVELOPE_STATUSES, MCP_DEFAULT_SCOPES, OAUTH_SCOPES, RECIPIENT_ROLES, LOCALES } from "@calasign/shared";
import { config } from "../../config";
import { AppError, notFound } from "../../lib/errors";
import { randomToken, sha256Hex, uuidv7 } from "../../lib/util";
import type { Services } from "../context";
import { sendPdf } from "../envelopes";
import { assertUserTokenAllowed, isOAuthAccessToken, resolveAccessToken } from "../oauth-tokens";
import { envelopesSentThisMonth, tenantPlan } from "../billing/plans";
import { decodePdfBase64, fetchPdf, fileNameFromUrl, maxBase64Length } from "../pdf-source";
import { agentHeaders } from "./agent-actor";

interface Caller {
  authorization: string;
  tenantId: string;
  name: string;
  ip: string;
  /** Scopes del token OAuth; null con una API key (vale el rol de la key). */
  scopes: string[] | null;
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

const SERVER_INFO = { name: "calasign", title: "CalaSign", version: "1.1.0" };

/** Tope del PDF de create_envelope (va en base64 dentro del JSON-RPC o se descarga de una URL). */
const PDF_MAX_BYTES = Math.min(10 * 1024 * 1024, config.maxUploadBytes);
/** Largo máximo del base64 de ese PDF: con el prefijo data: y saltos de línea cada 76 caracteres (MIME). */
const PDF_MAX_BASE64 = maxBase64Length(PDF_MAX_BYTES);

/** Nombre de archivo seguro para el documento. */
function pdfFileName(raw: string | null | undefined): string {
  let n = (raw ?? "").normalize("NFKD").replace(/[^\w .()-]/g, "_").trim().slice(0, 150);
  if (!n) n = "documento";
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

/** Anotaciones de herramienta (MCP): ChatGPT y Claude las usan para decidir cuándo pedir confirmación. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const INSTRUCTIONS =
  "CalaSign: firma electrónica. Con estas herramientas podés listar y consultar sobres, crear un sobre a partir de una " +
  "plantilla o de un PDF (y, con send=true, enviarlo en la misma llamada), enviarlo, recordar a los firmantes y descargar el PDF firmado. Enviar, anular o recordar tiene " +
  "efecto real (llegan correos/WhatsApp a personas): antes de llamar a send_envelope, void_envelope o remind_recipients " +
  "con confirm=true (o a create_envelope / create_envelope_from_template con send=true y confirm=true), mostrale al usuario el resumen y pedile que lo apruebe explícitamente.";

export async function mcpRoutes(app: FastifyInstance, s: Services) {
  const resourceUrl = `${config.appUrl}/mcp`;

  function unauthorizedReply(reply: FastifyReply, message: string) {
    return reply
      .code(401)
      // RFC 9728 §5.1: la URL de metadatos del recurso /mcp; `scope`, lo que necesitan las herramientas (MCP 2025-11-25).
      .header(
        "www-authenticate",
        `Bearer resource_metadata="${config.appUrl}/.well-known/oauth-protected-resource/mcp", scope="${MCP_DEFAULT_SCOPES.join(" ")}"`,
      )
      .send({ error: { code: "unauthorized", message } });
  }

  async function resolveCaller(req: FastifyRequest): Promise<Caller | null> {
    const authz = req.headers.authorization;
    if (!authz?.startsWith("Bearer ")) return null;
    const token = authz.slice(7).trim();
    if (isOAuthAccessToken(token)) {
      const o = await resolveAccessToken(s.db, token);
      if (!o) return null;
      // Igual que la API (oauthAuthContext): un token de un miembro quitado o autorizado con contraseña cuando la
      // organización exige SSO ya no vale. Con 401 (y no un error en cada herramienta) el conector vuelve a autorizar.
      if (o.userId) {
        try {
          await assertUserTokenAllowed(s.db, { tenantId: o.tenantId, userId: o.userId, authMethod: o.authMethod, ssoTenantId: o.ssoTenantId, issuedAt: o.createdAt });
        } catch (e) {
          if (e instanceof AppError) return null;
          throw e;
        }
      }
      return { authorization: authz, tenantId: o.tenantId, name: o.clientName, ip: req.ip, scopes: o.scopes };
    }
    const k = await s.db.one<any>(`SELECT tenant_id, name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`, [sha256Hex(token)]);
    if (!k) return null;
    return { authorization: authz, tenantId: k.tenant_id, name: `MCP · ${k.name}`, ip: req.ip, scopes: null };
  }

  /** Llama a la API v1 con la credencial del agente. */
  async function api(
    c: Caller,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    raw?: { payload: Buffer; contentType: string },
  ): Promise<any> {
    const res = await app.inject({
      method,
      url,
      payload: raw ? raw.payload : body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: c.authorization,
        ...(raw ? { "content-type": raw.contentType } : body === undefined ? {} : { "content-type": "application/json" }),
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
        annotations: { title: "Listar sobres", ...READ_ONLY },
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
        annotations: { title: "Ver un sobre", ...READ_ONLY },
      },
      guard(async (a: { envelopeId: string }) => summarizeDetail(await api(c, "GET", `/v1/envelopes/${a.envelopeId}`))),
    );

    server.registerTool(
      "get_signing_status",
      {
        title: "Estado de firma",
        description: "En qué está un sobre: quién firmó, quién falta y los últimos eventos del registro de evidencia.",
        inputSchema: { envelopeId: z.string().uuid() },
        annotations: { title: "Estado de firma", ...READ_ONLY },
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
        annotations: { title: "Listar plantillas", ...READ_ONLY },
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
          "Crea un sobre a partir de una plantilla, asignando una persona a cada rol. Por defecto queda en BORRADOR; con " +
          "send=true y confirm=true (después de que el usuario lo apruebe) lo crea y lo envía en una sola llamada.",
        inputSchema: {
          templateId: z.string().uuid(),
          subject: z.string().min(1).max(300).optional(),
          message: z.string().max(5000).optional(),
          locale: z.enum(LOCALES).optional().describe("Idioma de los correos, la página de firma y el certificado (es, pt-BR, en); sin él, el de la plantilla u organización"),
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
          send: z.boolean().optional().describe("true: además lo envía (requiere confirm=true)"),
          confirm: z.boolean().optional().describe("Con send=true: true solo si el usuario aprobó el envío"),
        },
        // Crea un sobre nuevo en cada llamada (no idempotente); con send=true avisa a personas reales.
        annotations: { title: "Crear sobre desde plantilla", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      guard(async (a: any) => {
        if (a.send && a.confirm !== true) {
          return fail("Confirmación requerida: con send=true se envía y les llega a personas reales. Mostrale este resumen al usuario y, si lo aprueba, volvé a llamar con confirm: true.", {
            templateId: a.templateId,
            subject: a.subject ?? null,
            recipients: a.recipients.map((r: any) => `${r.name} <${r.email ?? r.phone ?? "—"}> (${r.role})`),
          });
        }
        const d = await api(c, "POST", "/v1/envelopes/from-template", {
          templateId: a.templateId,
          subject: a.subject,
          locale: a.locale,
          message: a.message,
          prefill: a.prefill,
          recipients: a.recipients.map((r: any) => ({
            role: r.role,
            name: r.name,
            email: r.email ?? null,
            phone: r.phone ?? null,
            channels: r.channels ?? (r.email ? ["email"] : ["whatsapp"]),
          })),
          send: Boolean(a.send),
        });
        if (a.send) return summarizeDetail(d);
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
        // Les llegan correos/WhatsApp a personas reales: openWorld. No borra nada.
        annotations: { title: "Enviar sobre", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
        // Irreversible y avisa a los firmantes. Anular dos veces da error, no repite el efecto.
        annotations: { title: "Anular sobre", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
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
        // Crea un link de descarga (registro interno), pero no cambia nada del sobre.
        annotations: { title: "Descargar PDF firmado", ...READ_ONLY },
      },
      guard(async (a: { envelopeId: string }) => {
        const d = await api(c, "GET", `/v1/envelopes/${a.envelopeId}`); // control de acceso de la API
        if (d.envelope.status !== "completed") return fail(`El sobre está en estado "${d.envelope.status}": el PDF firmado existe recién cuando se completa.`);
        const token = randomToken(32);
        const expiresAt = new Date(Date.now() + config.mcp.downloadLinkTtlSec * 1000);
        // Versión vigente leída en la misma sentencia que crea el link: si una renovación del sello de archivo se
        // confirmaba entre la lectura y el INSERT, el link apuntaba a la versión anterior (con el hash de la nueva).
        const link = await s.db.one<{ sha256: string }>(
          `INSERT INTO download_links (id, token_hash, tenant_id, envelope_id, file_id, created_by_label, expires_at)
           SELECT $1, $2, $3, e.id, e.signed_file_id, $5, $6 FROM envelopes e
            WHERE e.id = $4 AND e.tenant_id = $3 AND e.status = 'completed' AND e.signed_file_id IS NOT NULL
           RETURNING (SELECT sha256 FROM files WHERE id = download_links.file_id) AS sha256`,
          [uuidv7(), sha256Hex(token), c.tenantId, a.envelopeId, `agente IA (${c.name})`, expiresAt.toISOString()],
        );
        if (!link) return fail("El sobre no tiene PDF firmado.");
        return { url: `${config.appUrl}/v1/downloads/${token}`, expiresAt: expiresAt.toISOString(), sha256: link.sha256 };
      }),
    );

    server.registerTool(
      "create_envelope",
      {
        title: "Crear sobre desde un PDF",
        description:
          "Crea un sobre con un PDF (en base64 o desde una URL https pública), sus destinatarios y sus campos, en una sola " +
          "llamada. Por defecto queda en BORRADOR; con send=true y confirm=true (después de que el usuario lo apruebe) " +
          `también lo envía. PDF de hasta ${Math.round(PDF_MAX_BYTES / 1048576)} MB. ` +
          "Campos opcionales por texto ancla (p. ej. un texto \"Firma:\" del documento); a cada firmante sin campo de firma " +
          "se le agrega uno al pie de la última página.",
        inputSchema: {
          subject: z.string().trim().min(1).max(300),
          message: z.string().max(5000).optional().describe("Mensaje para los destinatarios"),
          locale: z.enum(LOCALES).optional().describe("Idioma de los correos, la página de firma y el certificado (es, pt-BR, en); sin él, el de la plantilla u organización"),
          recipients: z
            .array(
              z.object({
                name: z.string().trim().min(1).max(200),
                email: z.string().email().max(320).optional(),
                phone: z.string().regex(/^\+[1-9]\d{6,14}$/).optional().describe("E.164, ej. +5511999990000 (recibe por WhatsApp)"),
                role: z.enum(RECIPIENT_ROLES).optional().describe("signer (por defecto), approver o cc (recibe copia)"),
                routingOrder: z.number().int().min(1).max(100).optional().describe("Orden de firma (1 = primero); igual orden = en paralelo"),
              }),
            )
            .min(1)
            .max(20),
          document: z
            .object({
              base64: z.string().max(PDF_MAX_BASE64).optional().describe("Contenido del PDF en base64"),
              url: z.string().url().max(2000).optional().describe("URL https pública del PDF (sin redirecciones)"),
              name: z.string().trim().max(200).optional().describe("Nombre del archivo, ej. contrato.pdf"),
            })
            .describe("El PDF: base64 o url (uno de los dos)"),
          fields: z
            .array(
              z.object({
                recipientIndex: z.number().int().min(0).max(19).describe("Posición del firmante en recipients (0 = el primero)"),
                type: z.enum(["signature", "initials", "date_signed", "name", "email", "text", "company", "title"]).default("signature"),
                anchorText: z.string().min(1).max(100).describe("Texto del PDF donde va el campo (aparece en todas sus apariciones)"),
                offsetX: z.number().min(-500).max(500).optional().describe("Desplazamiento en puntos desde el texto"),
                offsetY: z.number().min(-500).max(500).optional(),
                width: z.number().positive().max(600).optional(),
                height: z.number().positive().max(300).optional(),
                required: z.boolean().optional(),
              }),
            )
            .max(100)
            .optional(),
          send: z.boolean().optional().describe("true: además lo envía (requiere confirm=true)"),
          confirm: z.boolean().optional().describe("Con send=true: true solo si el usuario aprobó el envío"),
        },
        annotations: { title: "Crear sobre desde un PDF", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      guard(async (a: any) => {
        for (const [i, r] of a.recipients.entries()) {
          if (!r.email && !r.phone) return fail(`El destinatario ${i + 1} (${r.name}) necesita email o phone`);
        }
        if (Boolean(a.document.base64) === Boolean(a.document.url)) return fail("Pasá el PDF en document.base64 o en document.url (uno de los dos)");
        // Permiso antes de descargar o analizar el PDF (las llamadas a la API que lo exigen vienen después): un token de
        // solo lectura hacía que el servidor bajara y parseara hasta 10 MB de cualquier URL.
        const acc = await api(c, "GET", "/v1/me/access");
        if (!acc.permissions?.includes("envelopes:create")) return fail("Esta conexión no tiene permiso para crear sobres (envelopes:create).");
        let pdf: Buffer;
        try {
          pdf = a.document.base64 ? decodePdfBase64(a.document.base64, PDF_MAX_BYTES) : await fetchPdf(a.document.url, PDF_MAX_BYTES);
        } catch (e) {
          return fail(`No se pudo obtener el PDF: ${(e as Error).message}`);
        }
        for (const f of a.fields ?? []) {
          const r = a.recipients[f.recipientIndex];
          if (!r || (r.role ?? "signer") !== "signer") return fail(`fields: recipientIndex ${f.recipientIndex} no es un firmante de recipients`);
        }
        const fileName = pdfFileName(a.document.name ?? (a.document.url ? fileNameFromUrl(a.document.url) : null));
        if (a.send && a.confirm !== true) {
          return fail("Confirmación requerida: con send=true se envía y les llega a personas reales. Mostrale este resumen al usuario y, si lo aprueba, volvé a llamar con confirm: true.", {
            subject: a.subject,
            document: fileName,
            recipients: a.recipients.map((r: any) => `${r.name} <${r.email ?? r.phone ?? "—"}> (${r.role ?? "signer"})`),
          });
        }
        let pageCount: number;
        try {
          pageCount = (await inspectPdf(pdf)).pageCount;
        } catch (e) {
          return fail(`El PDF no es válido: ${(e as Error).message}`);
        }
        const SIZE: Record<string, [number, number]> = { signature: [160, 45], initials: [60, 35], date_signed: [110, 20] };
        const fields: any[] = (a.fields ?? []).map((f: any) => ({
          recipient: f.recipientIndex,
          type: f.type ?? "signature",
          required: f.required ?? true,
          anchor: {
            text: f.anchorText,
            offsetX: f.offsetX ?? 0,
            offsetY: f.offsetY ?? 0,
            width: f.width ?? SIZE[f.type ?? "signature"]?.[0] ?? 150,
            height: f.height ?? SIZE[f.type ?? "signature"]?.[1] ?? 20,
          },
        }));
        // Firmantes sin campo de firma: uno al pie de la última página (dos columnas), así el sobre se puede enviar.
        const lastPage = Math.max(0, pageCount - 1);
        let slot = 0;
        a.recipients.forEach((r: any, i: number) => {
          if ((r.role ?? "signer") !== "signer" || fields.some((f) => f.recipient === i && f.type === "signature")) return;
          const row = Math.floor(slot / 2);
          fields.push({
            recipient: i,
            document: 0,
            type: "signature",
            required: true,
            page: lastPage,
            x: slot % 2 === 0 ? 0.08 : 0.55,
            y: Math.max(0.05, 0.86 - row * 0.09),
            width: 0.32,
            height: 0.07,
          });
          slot++;
        });
        // Una sola llamada a la API (atómica): si algo falla, no queda un borrador a medias.
        const d = await api(c, "POST", "/v1/envelopes", {
          subject: a.subject,
          locale: a.locale,
          message: a.message ?? null,
          documents: [{ name: fileName, base64: pdf.toString("base64") }],
          recipients: a.recipients.map((r: any) => ({
            name: r.name,
            email: r.email ?? null,
            phone: r.phone ?? null,
            role: r.role ?? "signer",
            routingOrder: r.routingOrder ?? 1,
            channels: r.email ? ["email"] : ["whatsapp"],
          })),
          fields,
          send: Boolean(a.send),
        });
        return {
          ...summarizeDetail(d),
          ...(slot ? { note: `Se agregó un campo de firma al pie de la última página para ${slot} firmante(s) sin campo.` } : {}),
          ...(a.send ? {} : { next: "Borrador creado. Mostrale el resumen al usuario y, si lo aprueba, llamá a send_envelope con confirm: true." }),
        };
      }),
    );

    server.registerTool(
      "remind_recipients",
      {
        title: "Recordar a los firmantes",
        description:
          "Vuelve a avisar a los firmantes a los que les toca firmar un sobre en curso. ACCIÓN CON EFECTO REAL (les llega " +
          "un correo/WhatsApp): requiere confirm=true y solo debe usarse después de que el usuario lo apruebe.",
        inputSchema: {
          envelopeId: z.string().uuid(),
          confirm: z.boolean().optional().describe("true solo si el usuario aprobó el recordatorio"),
        },
        annotations: { title: "Recordar a los firmantes", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      guard(async (a: { envelopeId: string; confirm?: boolean }) => {
        if (a.confirm !== true) {
          const d = await api(c, "GET", `/v1/envelopes/${a.envelopeId}`);
          return fail("Confirmación requerida: el recordatorio les llega a personas reales. Mostrale este resumen al usuario y, si lo aprueba, volvé a llamar con confirm: true.", {
            subject: d.envelope.subject,
            status: d.envelope.status,
            pending: d.recipients
              .filter((r: any) => r.role !== "cc" && (r.status === "sent" || r.status === "viewed"))
              .map((r: any) => `${r.name} <${r.email ?? r.phone ?? "—"}>`),
          });
        }
        const r = await api(c, "POST", `/v1/envelopes/${a.envelopeId}/remind`);
        return { notified: r.notified, ...(r.notified ? {} : { note: "No había nadie a quien avisar en este momento." }) };
      }),
    );

    server.registerTool(
      "get_account",
      {
        title: "Cuenta",
        description: "Organización, usuario y plan de la cuenta conectada, con el uso del mes (sobres enviados) y los permisos (scopes) del conector.",
        inputSchema: {},
        annotations: { title: "Cuenta", ...READ_ONLY },
      },
      guard(async () => {
        const me = await api(c, "GET", "/v1/me");
        const [{ plan }, sent] = await Promise.all([tenantPlan(s.db, c.tenantId), envelopesSentThisMonth(s.db, c.tenantId)]);
        return {
          organization: { id: me.tenant.id, name: me.tenant.name },
          user: me.user?.email ? { name: me.user.name, email: me.user.email } : null,
          connectedAs: c.name,
          scopes: c.scopes,
          plan: { id: plan.id, name: plan.name, envelopesPerMonth: plan.envelopesPerMonth },
          usage: { period: new Date().toISOString().slice(0, 7), envelopesSent: sent },
        };
      }),
    );

    return server;
  }

  // ───────── Transporte Streamable HTTP (sin sesión: cada POST es independiente) ─────────

  // bodyLimit: create_envelope puede traer el PDF en base64 (tope PDF_MAX_BYTES, ~4/3 en base64).
  app.post("/mcp", { bodyLimit: PDF_MAX_BASE64 + 1024 * 1024, config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (req, reply) => {
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

  // Recurso protegido: el servidor MCP. scopes_supported son los que usan las herramientas (los clientes MCP piden
  // esos si el 401 no trae `scope`); la API tiene más (ver los metadatos del servidor de autorización).
  const protectedResource = async () => ({
    resource: resourceUrl,
    authorization_servers: [config.appUrl],
    scopes_supported: MCP_DEFAULT_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "CalaSign MCP",
    resource_documentation: `${config.appUrl}/developers/ai/mcp`,
  });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const authorizationServer = async () => ({
    issuer: config.appUrl,
    authorization_endpoint: `${config.appUrl}/oauth/authorize`,
    token_endpoint: `${config.appUrl}/oauth/token`,
    registration_endpoint: `${config.appUrl}/oauth/register`,
    revocation_endpoint: `${config.appUrl}/oauth/revoke`,
    introspection_endpoint: `${config.appUrl}/oauth/introspect`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    // RFC 9207: toda respuesta de autorización (código o error) lleva `iss`. Con esto ChatGPT usa su redirect estable.
    authorization_response_iss_parameter_supported: true,
    // client_credentials solo para apps creadas por una organización (nunca para las del registro dinámico).
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: OAUTH_SCOPES,
    service_documentation: `${config.appUrl}/developers/ai/mcp`,
  });
  app.get("/.well-known/oauth-authorization-server", authorizationServer);
  // Algunos clientes prueban la variante con el path del recurso (RFC 8414 §3.1 con issuer + /mcp).
  app.get("/.well-known/oauth-authorization-server/mcp", authorizationServer);

  // ───────── Descarga con link temporal ─────────

  app.get<{ Params: { token: string } }>("/v1/downloads/:token", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(req.params.token)) throw notFound("Link");
    const l = await s.db.one<any>(
      `SELECT l.id, l.expires_at, f.storage_key, e.subject FROM download_links l JOIN files f ON f.id = l.file_id AND f.purged_at IS NULL JOIN envelopes e ON e.id = l.envelope_id
       WHERE l.token_hash = $1`,
      [sha256Hex(req.params.token)],
    );
    if (!l || new Date(l.expires_at) <= new Date()) throw notFound("Link");
    await s.db.query(`UPDATE download_links SET downloads = downloads + 1 WHERE id = $1`, [l.id]);
    return sendPdf(reply, await s.blobs.get(l.storage_key), l.subject);
  });
}
