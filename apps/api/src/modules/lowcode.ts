// Endpoints para conectores low-code / iPaaS (Power Automate, Logic Apps, Zapier, Make, n8n, Dynamics 365 vía Power
// Automate). Ver docs/CONECTORES.md. No hay lógica nueva de sobres: se reutiliza la creación desde plantilla.
//   GET  /v1/templates/:id/input-schema         formulario dinámico de una plantilla (roles + campos prellenables)
//   POST /v1/envelopes/from-template/:templateId  enviar desde plantilla con roles y prellenado como objetos
//   GET  /v1/webhooks/samples                    eventos de ejemplo (datos de prueba de los triggers REST hook)
// La suscripción REST hook usa POST /v1/webhooks (201 + header Location) y DELETE a esa Location.
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  EnvelopeFromTemplateInput,
  LowcodeTemplateSendInput,
  WEBHOOK_EVENT_TYPES,
  type LowcodeTemplateInputSchema,
  type TemplateDetail,
  type WebhookEventPayload,
} from "@calasign/shared";
import { badRequest } from "../lib/errors";
import { assertTemplateAccess, envelopeVisibilitySql } from "./access";
import { authenticate, type AuthContext, type Services } from "./context";
import { idempotent } from "./envelopes";
import { loadDetail } from "./mappers";
import { insertEnvelopeFromTemplate, loadTemplateDetail, loadTemplateForUse, planFromTemplate } from "./templates";
import { envelopeSnapshot } from "./webhooks";

/** Tipos de campo que el remitente puede prellenar (ver VALUE_FIELD_TYPES en fieldvalues.ts). */
const PREFILL_TYPES = new Set(["text", "number", "dropdown", "company", "title"]);

const CHANNEL_HELP = "email, whatsapp o telegram";

/** Formulario dinámico de una plantilla. Puro (sin base): lo prueban los tests unitarios. */
export function templateInputSchema(tpl: TemplateDetail): LowcodeTemplateInputSchema {
  const roleName = new Map(tpl.roles.map((r) => [r.id, r.name]));
  const roles = tpl.roles.map((r) => ({ id: r.id, name: r.name, role: r.role, routingOrder: r.routingOrder }));
  const fields = tpl.fields
    .filter((f) => PREFILL_TYPES.has(f.type) && !f.readOnly)
    .map((f) => ({ id: f.id, label: f.label, type: f.type, required: f.required, options: f.options, roleId: f.roleId, roleName: roleName.get(f.roleId) ?? null }));

  // JSON Schema draft-04 con x-ms-summary (Power Automate muestra ese título) y title (los demás).
  const prop = (title: string, description: string, extra: Record<string, unknown> = {}) => ({ type: "string", title, "x-ms-summary": title, description, ...extra });
  const rolesSchema = {
    type: "object",
    required: tpl.roles.map((r) => r.id),
    properties: Object.fromEntries(
      tpl.roles.map((r) => [
        r.id,
        {
          type: "object",
          title: r.name,
          "x-ms-summary": r.name,
          description: `Destinatario del rol «${r.name}» (${r.role}, orden ${r.routingOrder})`,
          required: ["name"],
          properties: {
            name: prop(`${r.name}: nombre`, "Nombre completo"),
            email: prop(`${r.name}: email`, "Correo electrónico (obligatorio con el canal email)", { format: "email" }),
            phone: prop(`${r.name}: teléfono`, "Móvil en formato E.164, p. ej. +18095551234 (para WhatsApp)", { "x-ms-visibility": "advanced" }),
            channels: {
              type: "array",
              title: `${r.name}: canales`,
              "x-ms-summary": `${r.name}: canales`,
              description: `Canales de invitación (${CHANNEL_HELP}); por defecto email`,
              "x-ms-visibility": "advanced",
              items: { type: "string", enum: ["email", "whatsapp", "telegram"] },
            },
          },
        },
      ]),
    ),
  };
  const prefillSchema = {
    type: "object",
    properties: Object.fromEntries(
      fields.map((f) => {
        const title = f.label || `Campo ${f.type}`;
        const description = `Prellenado de «${title}»${f.roleName ? ` (lo ve ${f.roleName})` : ""}`;
        if (f.type === "number") return [f.id, { type: "number", title, "x-ms-summary": title, description }];
        if (f.type === "dropdown" && f.options?.length) return [f.id, { type: "string", title, "x-ms-summary": title, description, enum: f.options }];
        return [f.id, { type: "string", title, "x-ms-summary": title, description }];
      }),
    ),
  };
  return { templateId: tpl.template.id, name: tpl.template.name, roles, fields, rolesSchema, prefillSchema };
}

/**
 * Convierte el envío "por formulario" al de /v1/envelopes/from-template. Los roles se buscan por id o por nombre (sin
 * distinguir mayúsculas); el prellenado vacío se descarta y los números se pasan a texto.
 */
export function toFromTemplateInput(templateId: string, raw: unknown, tpl: Pick<TemplateDetail, "roles">): import("@calasign/shared").EnvelopeFromTemplateInput {
  const input = LowcodeTemplateSendInput.parse(raw);
  const recipients: import("@calasign/shared").EnvelopeFromTemplateInput["recipients"] = [];
  const used = new Set<string>();
  for (const [key, r] of Object.entries(input.roles)) {
    const role = tpl.roles.find((x) => x.id === key) ?? tpl.roles.find((x) => x.name.toLowerCase() === key.trim().toLowerCase());
    if (!role) throw badRequest("unknown_role", `Rol desconocido: ${key}`);
    if (used.has(role.id)) throw badRequest("duplicate_role", `El rol ${role.name} tiene más de un destinatario`);
    used.add(role.id);
    const email = r.email || null;
    const phone = r.phone || null;
    recipients.push({ roleId: role.id, name: r.name, email, phone, locale: r.locale ?? null, channels: r.channels ?? (email ? ["email"] : phone ? ["whatsapp"] : ["email"]) });
  }
  if (!recipients.length) throw badRequest("roles_missing", "Indicá al menos un destinatario en roles");
  const prefill: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.prefill ?? {})) {
    if (v === null || v === "") continue;
    prefill[k] = typeof v === "string" ? v : String(v);
  }
  return {
    templateId,
    subject: input.subject,
    message: input.message,
    locale: input.locale,
    expiresAt: input.expiresAt,
    metadata: input.metadata,
    recipients,
    prefill,
    send: input.send ?? true,
  };
}

/** Evento sintético con la misma forma que una entrega real (cuando la organización todavía no tiene sobres). */
export function syntheticEvent(type: string, tenantId: string): WebhookEventPayload {
  const now = new Date().toISOString();
  const status = type === "envelope.completed" ? "completed" : type === "envelope.declined" ? "declined" : type === "envelope.voided" ? "voided" : type === "envelope.expired" ? "expired" : "sent";
  return {
    id: "00000000-0000-7000-8000-000000000001",
    type: type as WebhookEventPayload["type"],
    createdAt: now,
    tenantId,
    data: {
      envelope: {
        id: "00000000-0000-7000-8000-0000000000e1",
        subject: "Contrato de ejemplo",
        status,
        metadata: { externalId: "CRM-123" },
        sentAt: now,
        completedAt: status === "completed" ? now : null,
        signedSha256: status === "completed" ? "0".repeat(64) : null,
        recipients: [
          { id: "00000000-0000-7000-8000-0000000000a1", name: "Ana Pérez", email: "ana@example.com", role: "signer", status: status === "completed" ? "signed" : "sent", routingOrder: 1 },
        ],
      },
      recipientId: type.startsWith("recipient.") ? "00000000-0000-7000-8000-0000000000a1" : null,
      reason: type.endsWith("declined") || type === "envelope.voided" ? "Motivo de ejemplo" : null,
    },
  } as WebhookEventPayload;
}

const SAMPLE_STATUS: Record<string, string[]> = {
  "envelope.sent": ["sent", "completed"],
  "envelope.completed": ["completed"],
  "envelope.declined": ["declined"],
  "envelope.voided": ["voided"],
  "envelope.expired": ["expired"],
  "recipient.viewed": ["sent", "completed"],
  "recipient.signed": ["sent", "completed"],
  "recipient.declined": ["declined"],
  "recipient.approved": ["sent", "completed"],
};

export async function lowcodeRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  app.get<{ Params: { id: string } }>("/v1/templates/:id/input-schema", { preHandler: auth }, async (req) => {
    const a = A(req);
    await assertTemplateAccess(s.db, a, req.params.id, "view");
    return templateInputSchema(await loadTemplateDetail(s.db, a.tenantId, req.params.id));
  });

  // Con Idempotency-Key como /v1/envelopes/from-template: Power Automate, Logic Apps, Zapier y Make reintentan solos
  // ante un timeout o un 5xx, y sin esto cada reintento creaba (y enviaba) otro sobre.
  app.post<{ Params: { templateId: string } }>("/v1/envelopes/from-template/:templateId", { preHandler: auth }, async (req, reply) =>
    idempotent(s, req, reply, async () => {
      const a = A(req);
      await assertTemplateAccess(s.db, a, req.params.templateId, "view");
      const loaded = await loadTemplateForUse(s.db, a.tenantId, req.params.templateId);
      // Mismas validaciones que /v1/envelopes/from-template (destinatarios, canales, prellenado).
      const input = EnvelopeFromTemplateInput.parse(toFromTemplateInput(loaded.tpl.template.id, req.body ?? {}, loaded.tpl));
      const plan = planFromTemplate(loaded, input);
      const envId = await s.db.tx((t) => insertEnvelopeFromTemplate(t, { tenantId: a.tenantId, userId: a.userId, apiKeyId: a.apiKeyId, actor: a.actor }, loaded, input, plan));
      return { status: 201, body: await loadDetail(s.db, a.tenantId, envId) };
    }),
  );

  app.get<{ Querystring: { event?: string; limit?: string } }>("/v1/webhooks/samples", { preHandler: auth }, async (req) => {
    const a = A(req);
    const type = req.query.event ?? "envelope.completed";
    if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(type)) throw badRequest("invalid_event", `Evento desconocido: ${type}`);
    const limit = Math.min(10, Math.max(1, Math.trunc(Number(req.query.limit ?? 3)) || 3));
    const params: unknown[] = [a.tenantId, SAMPLE_STATUS[type]];
    const where = `e.tenant_id = $1 AND e.status = ANY($2)${envelopeVisibilitySql(a, params)}`;
    params.push(limit);
    const rows = await s.db.query<any>(`SELECT e.id, e.updated_at FROM envelopes e WHERE ${where} ORDER BY e.updated_at DESC, e.id DESC LIMIT $${params.length}`, params);
    const items: WebhookEventPayload[] = [];
    for (const r of rows) {
      const envelope = await envelopeSnapshot(s.db, r.id);
      if (!envelope) continue;
      const recipient = type.startsWith("recipient.") ? envelope.recipients.find((x) => x.status !== "pending") ?? envelope.recipients[0] : null;
      items.push({
        // Id estable por sobre y evento: los conectores deduplican por id.
        id: `sample-${type}-${r.id}`,
        type: type as WebhookEventPayload["type"],
        createdAt: new Date(r.updated_at).toISOString(),
        tenantId: a.tenantId,
        data: { envelope, recipientId: recipient?.id ?? null, reason: null },
      } as WebhookEventPayload);
    }
    if (!items.length) items.push(syntheticEvent(type, a.tenantId));
    return { items };
  });
}
