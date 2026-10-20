// Operaciones de devapi para /v1/openapi.json (eventos, datos de formulario, adjuntos, clonado, lote y rotación del
// secreto de un webhook) y los parámetros de búsqueda avanzada de GET /v1/envelopes.
import { z } from "zod";
import { BATCH_ACTIONS, CloneEnvelopeInput, EnvelopeBatchInput, RotateWebhookSecretInput, WEBHOOK_EVENT_TYPES } from "@calasign/shared";
import { EnvelopeDetailSchema, WebhookSchema, named } from "../openapi-schemas";
import type { Op } from "../openapi-extra";

const iso = () => z.string().datetime();
const date = (name: string, description: string) => ({ name, description, schema: { type: "string", format: "date-time" } });

/** Parámetros extra de GET /v1/envelopes (los aplica devapi/search.ts). */
export const ENVELOPE_SEARCH_QUERY = [
  date("created_from", "Creados desde (ISO 8601, inclusive)."),
  date("created_to", "Creados antes de (ISO 8601, exclusivo)."),
  date("updated_from", "Modificados desde (inclusive). Para sincronizar: guardar la hora del último pedido y pedir los cambios desde ahí. Alias: `updated_since`."),
  date("updated_to", "Modificados antes de (exclusivo)."),
  date("sent_from", "Enviados desde (inclusive)."),
  date("sent_to", "Enviados antes de (exclusivo)."),
  date("completed_from", "Completados desde (inclusive)."),
  date("completed_to", "Completados antes de (exclusivo)."),
  {
    name: "metadata",
    description: "Filtro por metadata, `clave:valor` (repetible, hasta 10; todos tienen que coincidir). También `metadata[clave]=valor`. Compara contra valores string.",
    schema: { type: "string", example: "orderId:ORD-1001" },
  },
  { name: "recipient", description: "Correo (sin distinguir mayúsculas) o teléfono E.164 exacto de un destinatario." },
  { name: "template_id", description: "Sobres creados desde esta plantilla.", schema: { type: "string", format: "uuid" } },
  { name: "created_via", description: "Origen: `api` o `web`.", schema: { type: "string", enum: ["api", "web"] } },
];

const ApiEventSchema = named(
  "ApiEvent",
  z.object({
    id: z.string().describe("Único por evento (evt_…). Usarlo para descartar duplicados."),
    type: z.string().describe(`Tipo público (${WEBHOOK_EVENT_TYPES.join(", ")}) o, con scope=all, el tipo de evidencia.`),
    occurredAt: iso(),
    envelopeId: z.string().uuid(),
    recipientId: z.string().uuid().nullable(),
    envelope: z.object({ id: z.string().uuid(), subject: z.string(), status: z.string().describe("Estado ACTUAL del sobre."), metadata: z.record(z.string(), z.unknown()) }),
    data: z.record(z.string(), z.unknown()).describe("Con scope=webhook solo `reason` (rechazo/anulación); con scope=all, el dato completo de la evidencia."),
    cursor: z.string().describe("Valor opaco para `after` (o Last-Event-ID en el stream)."),
  }),
);

const EVENT_QUERY = [
  { name: "after", description: "Cursor: devuelve los eventos posteriores a este (`nextCursor` o `cursor` de un evento). Sin `after` se usa `since`." },
  date("since", "Sin `after`: eventos desde esta fecha (por defecto, las últimas 24 h)."),
  { name: "types", description: "Tipos separados por coma (por defecto, todos los de los webhooks).", schema: { type: "string", example: "envelope.completed,recipient.signed" } },
  { name: "envelope_id", description: "Solo los eventos de este sobre.", schema: { type: "string", format: "uuid" } },
  { name: "scope", description: "`webhook` (por defecto): los tipos públicos de los webhooks. `all`: todos los registros de evidencia (document.added, envelope.reminded, …).", schema: { type: "string", enum: ["webhook", "all"] } },
];

const FormDataSchema = named(
  "EnvelopeFormData",
  z.object({
    envelopeId: z.string().uuid(),
    status: z.string(),
    completedAt: iso().nullable(),
    recipients: z.array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        email: z.string().nullable(),
        role: z.string(),
        status: z.string(),
        signedAt: iso().nullable(),
        fields: z.array(
          z.object({
            id: z.string().uuid(),
            label: z.string().nullable(),
            type: z.string(),
            documentId: z.string().uuid(),
            page: z.number().int(),
            value: z.string().nullable().describe("null para firma e iniciales (ver `filled`)."),
            filled: z.boolean(),
            hidden: z.boolean().describe("Oculto por la lógica condicional (no se estampó)."),
            readOnly: z.boolean(),
            attachment: z
              .object({ name: z.string().nullable(), contentType: z.string(), sizeBytes: z.number().int(), sha256: z.string(), downloadPath: z.string() })
              .nullable(),
          }),
        ),
      }),
    ),
    values: z.record(z.string(), z.string()).describe("Etiqueta (o id si no tiene) → valor, de los campos visibles con valor."),
  }),
);

const BatchResponseSchema = named(
  "EnvelopeBatchResponse",
  z.object({
    action: z.enum(BATCH_ACTIONS),
    succeeded: z.number().int(),
    failed: z.number().int(),
    results: z.array(
      z.object({
        id: z.string().uuid(),
        ok: z.boolean(),
        status: z.number().int().describe("Status HTTP de la operación individual."),
        data: z.unknown().optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      }),
    ),
  }),
);

export const DEVAPI_OPS: Op[] = [
  {
    method: "get",
    path: "/v1/events",
    operationId: "listEvents",
    tag: "Eventos",
    summary: "Eventos de la organización (polling con cursor)",
    description:
      "Del más viejo al más nuevo. Para reconciliar: guardar `nextCursor` y pedir `?after=<cursor>` periódicamente; con `hasMore: true`, pedir de nuevo enseguida. " +
      "Cada evento recibe su posición cuando ya está confirmado, así que ningún evento queda detrás del cursor aunque una operación tarde. El cursor es opaco (`p<n>`); los formatos anteriores se siguen aceptando. Una API key sin envelopes:view_all ve solo los de sus sobres.",
    query: [...EVENT_QUERY, { name: "limit", description: "Registros de evidencia por página (1..500, por defecto 100).", schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } }],
    response: z.object({ items: z.array(ApiEventSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() }),
    errors: ["invalid_cursor"],
  },
  {
    method: "get",
    path: "/v1/events/stream",
    operationId: "streamEvents",
    tag: "Eventos",
    summary: "Eventos en vivo (Server-Sent Events)",
    description:
      "`text/event-stream`: cada mensaje lleva `id:` (cursor), `event:` (tipo) y `data:` (ApiEvent en JSON). Retoma desde `after` o el header `Last-Event-ID`; sin ninguno, desde `since` si se indica y si no, ahora. " +
      "La conexión se cierra a los `max_seconds` (por defecto 300) con `event: end`; EventSource reconecta solo. Máximo 5 streams abiertos por organización (429 too_many_streams). Cada minuto se revisa la credencial: si se revoca (key, token, sesión), la persona deja la organización, cambian sus permisos o el plan deja de incluir el acceso por API, el stream termina con `event: end` y `{\"reason\":\"unauthorized\"}`; al reconectar rige el acceso nuevo.",
    query: [...EVENT_QUERY.map((q) => (q.name === "since" ? date("since", "Sin `after` ni `Last-Event-ID`: empieza desde esta fecha en lugar de ahora.") : q)), { name: "max_seconds", description: "Duración máxima de la conexión (5..3600, por defecto 300).", schema: { type: "integer", minimum: 5, maximum: 3600, default: 300 } }],
    responseDescription: "Stream de eventos (text/event-stream).",
    errors: ["invalid_cursor"],
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/form-data",
    operationId: "getEnvelopeFormData",
    tag: "Sobres",
    summary: "Datos de formulario completados",
    description: "Valores de los campos por destinatario, más una vista plana etiqueta → valor. Las firmas e iniciales solo informan `filled`; los adjuntos traen su ruta de descarga.",
    response: FormDataSchema,
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/attachments/{fieldId}",
    operationId: "downloadEnvelopeAttachment",
    tag: "Sobres",
    summary: "Descargar el adjunto que subió un firmante",
    description: "El archivo tal como lo subió el firmante (PDF, PNG o JPG). 404 si el campo no tiene adjunto o la retención ya lo borró.",
    response: "pdf",
    responseDescription: "Archivo (application/pdf, image/png o image/jpeg).",
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/clone",
    operationId: "cloneEnvelope",
    tag: "Sobres",
    summary: "Clonar un sobre como borrador nuevo",
    description:
      "Copia documentos, destinatarios (configuración, no estado) y campos con su lógica, en cualquier estado del original. No copia lo que escribieron los firmantes (salvo `includeValues`), ni adjuntos, firmas ni el cobro. " +
      "Sin `metadata` en el pedido, la del original se copia con `clonedFrom` (sin las claves que lo atan a un proceso: workflow, formulario, envío masivo, CRM, conector, negociación; se conservan templateId, documentTemplateId y agreement); con `metadata` propia, esa reemplaza a la copiada (sin claves del sistema). Si el plan ya no incluye la marca blanca, el clon sale con la marca de la organización. El clon vence a los 30 días si no se indica `expiresAt`.",
    body: CloneEnvelopeInput,
    bodyOptional: true,
    status: 201,
    response: EnvelopeDetailSchema,
  },
  {
    method: "post",
    path: "/v1/envelopes/batch",
    operationId: "batchEnvelopes",
    tag: "Sobres",
    summary: "Operación en lote (get, void, remind, delete) sobre hasta 100 sobres",
    description:
      "Cada id se procesa como su pedido individual (mismos permisos, validaciones y auditoría) y el resultado de cada uno va en `results`, en el mismo orden; " +
      "un error en uno no corta el resto. Responde 200 aunque fallen elementos. Cada elemento cuenta para el límite de pedidos.",
    body: EnvelopeBatchInput,
    response: BatchResponseSchema,
  },
  {
    method: "post",
    path: "/v1/webhooks/{id}/rotate-secret",
    operationId: "rotateWebhookSecret",
    tag: "Webhooks",
    summary: "Rotar el secreto (con período de gracia)",
    description:
      "Devuelve el secreto nuevo una sola vez. Durante `graceHours` (por defecto 24, máximo 168) cada entrega lleva dos firmas: `CalaSign-Signature: t=…,v1=<nuevo>,v1=<anterior>`; el receptor acepta si alguna coincide. " +
      "`graceHours: 0` invalida el anterior de inmediato.",
    body: RotateWebhookSecretInput,
    bodyOptional: true,
    response: z.object({ webhook: WebhookSchema, secret: z.string().describe("whsec_…; se muestra una sola vez.") }),
  },
];

