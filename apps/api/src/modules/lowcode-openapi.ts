// Operaciones de los conectores low-code (Power Automate, Zapier, Make, n8n, Dynamics 365) para el OpenAPI.
import { z } from "zod";
import { LowcodeTemplateSendInput, WEBHOOK_EVENT_TYPES } from "@calasign/shared";
import type { Op } from "./openapi-extra";
import { EnvelopeDetailSchema, WebhookEventSchema } from "./openapi-schemas";

const jsonSchema = z.record(z.string(), z.unknown()).describe("JSON Schema (draft-04)");

export const LOWCODE_OPS: Op[] = [
  {
    method: "get",
    path: "/v1/templates/{id}/input-schema",
    operationId: "getTemplateInputSchema",
    tag: "Plantillas",
    summary: "Formulario dinámico de una plantilla (conectores low-code)",
    description:
      "Roles y campos prellenables de la plantilla, más el JSON Schema de los objetos `roles` y `prefill` de POST /v1/envelopes/from-template/{templateId}. " +
      "Lo usan los campos dinámicos de Power Automate (x-ms-dynamic-schema), Zapier, Make y n8n.",
    response: z.object({
      templateId: z.string().uuid(),
      name: z.string(),
      roles: z.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string(), routingOrder: z.number().int() })),
      fields: z.array(
        z.object({
          id: z.string().uuid(),
          label: z.string().nullable(),
          type: z.string(),
          required: z.boolean(),
          options: z.array(z.string()).nullable(),
          roleId: z.string().uuid(),
          roleName: z.string().nullable(),
        }),
      ),
      rolesSchema: jsonSchema,
      prefillSchema: jsonSchema,
    }),
  },
  {
    method: "post",
    path: "/v1/envelopes/from-template/{templateId}",
    operationId: "sendFromTemplateForm",
    tag: "Plantillas",
    summary: "Enviar desde plantilla con roles como objeto (conectores low-code)",
    description:
      "Igual que POST /v1/envelopes/from-template, con `roles: { <id o nombre del rol>: { name, email, phone } }` y `prefill: { <id o etiqueta>: valor }` " +
      "(los vacíos se ignoran). Envía el sobre salvo `send: false`. Admite `Idempotency-Key`.",
    body: LowcodeTemplateSendInput,
    status: 201,
    response: EnvelopeDetailSchema,
    idempotent: true,
  },
  {
    method: "get",
    path: "/v1/webhooks/samples",
    operationId: "listWebhookSamples",
    tag: "Webhooks",
    summary: "Eventos de ejemplo para triggers REST hook",
    description:
      "Hasta `limit` (1–10, por defecto 3) eventos con la forma exacta de una entrega, armados con los últimos sobres de la organización en el estado del evento; " +
      "si no hay, uno sintético. Sirven de datos de prueba en Zapier (performList), Make y n8n.",
    query: [
      { name: "event", description: `Tipo de evento (por defecto envelope.completed): ${WEBHOOK_EVENT_TYPES.join(", ")}`, schema: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] } },
      { name: "limit", description: "1 a 10", schema: { type: "integer", minimum: 1, maximum: 10 } },
    ],
    response: z.object({ items: z.array(WebhookEventSchema) }),
  },
];
