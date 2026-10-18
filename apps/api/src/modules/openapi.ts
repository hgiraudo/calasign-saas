// OpenAPI 3.1 de la API v1, generado a partir de los esquemas Zod del contrato (packages/shared).
// Las respuestas se describen con esquemas propios (las salidas son tipos TS, no Zod).
import type { FastifyInstance } from "fastify";
import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AnchorFieldInput,
  CompleteSigningInput,
  CreateApiKeyInput,
  CreateEnvelopeInput,
  CreateSigningUrlInput,
  CreateWebhookInput,
  DeclineInput,
  EmbedSettingsInput,
  FieldInput,
  LoginInput,
  PutRecipientsInput,
  SignupInput,
  UpdateEnvelopeInput,
  UpdateWebhookInput,
  VoidEnvelopeInput,
  CorrectEnvelopeInput,
  InPersonConfirmInput,
  WEBHOOK_EVENT_TYPES,
  ENVELOPE_STATUSES,
  RECIPIENT_STATUSES,
  FIELD_TYPES,
  SealOptionsInput,
  UpdateEvidenceSettingsInput,
  UploadCertificateInput,
  XmlSignInput,
  XmlVerifyInput,
} from "@calasign/shared";
import { config } from "../config";
import { OAUTH2_SECURITY_SCHEME, PLATFORM_OPS } from "./platform-openapi";
import { AGREEMENTS_OPS } from "./agreements/openapi";
import { CRM_OPS } from "./crm/openapi";
import { requiredScope } from "./oauth-tokens";
import { AI_OPS } from "./ai/openapi";

const js = (schema: ZodTypeAny) => {
  const { $schema: _drop, ...rest } = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  return rest;
};

// ───────── Esquemas de salida (espejo de los tipos de packages/shared/src/api.ts) ─────────

const iso = z.string().datetime();
const Document = z.object({
  id: z.string().uuid(),
  name: z.string(),
  position: z.number().int(),
  pageCount: z.number().int(),
  pages: z.array(z.object({ width: z.number(), height: z.number() })),
  sha256: z.string(),
  sizeBytes: z.number().int(),
});
const Recipient = z.object({
  id: z.string().uuid(),
  role: z.enum(["signer", "cc"]),
  routingOrder: z.number().int(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  locale: z.string().nullable(),
  channels: z.array(z.string()),
  embedded: z.boolean(),
  telegramLinked: z.boolean(),
  status: z.enum(RECIPIENT_STATUSES),
  sentAt: iso.nullable(),
  viewedAt: iso.nullable(),
  signedAt: iso.nullable(),
  declinedAt: iso.nullable(),
  declineReason: z.string().nullable(),
});
const Field = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  recipientId: z.string().uuid(),
  type: z.enum(FIELD_TYPES),
  page: z.number().int(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  required: z.boolean(),
  label: z.string().nullable(),
  value: z.string().nullable(),
});
const Envelope = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  message: z.string().nullable(),
  locale: z.string(),
  status: z.enum(ENVELOPE_STATUSES),
  createdVia: z.enum(["web", "api"]),
  createdAt: iso,
  updatedAt: iso,
  sentAt: iso.nullable(),
  completedAt: iso.nullable(),
  voidedAt: iso.nullable(),
  voidReason: z.string().nullable(),
  expiresAt: iso.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  signedSha256: z.string().nullable(),
});
const EnvelopeDetail = z.object({ envelope: Envelope, documents: z.array(Document), recipients: z.array(Recipient), fields: z.array(Field) });
const EnvelopeList = z.object({
  items: z.array(
    Envelope.pick({ id: true, subject: true, status: true, createdAt: true, sentAt: true, completedAt: true, expiresAt: true }).extend({
      recipients: z.array(z.object({ name: z.string(), status: z.string(), role: z.string() })),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const EnvelopeEvent = z.object({
  seq: z.number().int(),
  type: z.string(),
  actorType: z.enum(["user", "api_key", "recipient", "system"]),
  actorLabel: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  occurredAt: iso,
  hash: z.string(),
});
const Webhook = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  description: z.string().nullable(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  active: z.boolean(),
  secretPrefix: z.string(),
  createdAt: iso,
  updatedAt: iso,
});
const WebhookDelivery = z.object({
  id: z.string().uuid(),
  endpointId: z.string().uuid(),
  eventId: z.string().uuid(),
  eventType: z.string(),
  envelopeId: z.string().uuid().nullable(),
  status: z.enum(["pending", "succeeded", "failed"]),
  attempts: z.number().int(),
  lastStatusCode: z.number().int().nullable(),
  lastResponse: z.string().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: iso.nullable(),
  nextRetryAt: iso.nullable(),
  createdAt: iso,
  deliveredAt: iso.nullable(),
});
const ApiKey = z.object({ id: z.string().uuid(), name: z.string(), prefix: z.string(), createdAt: iso, lastUsedAt: iso.nullable(), revokedAt: iso.nullable() });
const Error = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const PutFieldsWithAnchors = z.object({ fields: z.array(z.union([FieldInput, AnchorFieldInput])) });

// ───────── Rutas ─────────

interface Op {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: ZodTypeAny;
  multipart?: boolean;
  response?: ZodTypeAny | "pdf" | "none";
  status?: number;
  auth?: "key" | "token" | "none" | "client";
  idempotent?: boolean;
  /** Cuerpo application/x-www-form-urlencoded (endpoints OAuth). */
  form?: ZodTypeAny;
}

/** Seguridad de una operación: API key, OAuth 2.0 (con el scope que exige la ruta) o sesión web. */
function securityFor(op: Op) {
  if (op.auth === "none" || op.auth === "token") return [];
  if (op.auth === "client") return [{ clientBasic: [] }];
  const scope = requiredScope(op.path.replace(/\{(\w+)\}/g, ":$1"), op.method.toUpperCase());
  const oauth = scope === "deny" ? [] : [{ oauth2: scope ? [scope] : [] }];
  return [{ apiKey: [] }, ...oauth, { session: [] }];
}

const OPS: Op[] = [
  { method: "post", path: "/v1/auth/signup", tag: "Identidad", summary: "Crear cuenta y organización", body: SignupInput, status: 201, auth: "none" },
  { method: "post", path: "/v1/auth/login", tag: "Identidad", summary: "Iniciar sesión (cookie)", body: LoginInput, auth: "none" },
  { method: "get", path: "/v1/me", tag: "Identidad", summary: "Usuario y organización actuales" },
  { method: "get", path: "/v1/api-keys", tag: "Identidad", summary: "Listar API keys", response: z.object({ items: z.array(ApiKey) }) },
  { method: "post", path: "/v1/api-keys", tag: "Identidad", summary: "Crear API key (el secreto se devuelve una sola vez)", body: CreateApiKeyInput, status: 201, response: z.object({ apiKey: ApiKey, secret: z.string() }) },
  { method: "delete", path: "/v1/api-keys/{id}", tag: "Identidad", summary: "Revocar API key", response: "none", status: 204 },

  { method: "get", path: "/v1/envelopes", tag: "Sobres", summary: "Listar sobres", description: "Filtros: status (coma), q (asunto o destinatario), cursor, limit.", response: EnvelopeList },
  { method: "post", path: "/v1/envelopes", tag: "Sobres", summary: "Crear sobre (borrador)", body: CreateEnvelopeInput, status: 201, response: EnvelopeDetail, idempotent: true },
  { method: "get", path: "/v1/envelopes/{id}", tag: "Sobres", summary: "Detalle del sobre", response: EnvelopeDetail },
  { method: "patch", path: "/v1/envelopes/{id}", tag: "Sobres", summary: "Modificar borrador", body: UpdateEnvelopeInput, response: EnvelopeDetail },
  { method: "delete", path: "/v1/envelopes/{id}", tag: "Sobres", summary: "Borrar borrador", response: "none", status: 204 },
  { method: "post", path: "/v1/envelopes/{id}/documents", tag: "Sobres", summary: "Agregar documento PDF (multipart, campo `file`)", multipart: true, status: 201, response: Document },
  { method: "delete", path: "/v1/envelopes/{id}/documents/{documentId}", tag: "Sobres", summary: "Quitar documento", response: "none", status: 204 },
  { method: "get", path: "/v1/envelopes/{id}/documents/{documentId}/file", tag: "Sobres", summary: "Descargar el PDF original", response: "pdf" },
  { method: "put", path: "/v1/envelopes/{id}/recipients", tag: "Sobres", summary: "Reemplazar destinatarios", description: "Ids opcionales (UUID generados por el cliente para referenciarlos desde los campos). `embedded: true` = firma embebida, sin invitaciones.", body: PutRecipientsInput, response: EnvelopeDetail },
  { method: "put", path: "/v1/envelopes/{id}/fields", tag: "Sobres", summary: "Reemplazar campos", description: "Cada campo va con coordenadas normalizadas (page, x, y, width, height; origen arriba a la izquierda) o con `anchor` para ubicarlo por un texto del PDF (se expande a una aparición por campo; offsets y tamaño en puntos).", body: PutFieldsWithAnchors, response: EnvelopeDetail },
  { method: "post", path: "/v1/envelopes/{id}/send", tag: "Sobres", summary: "Enviar", response: EnvelopeDetail, idempotent: true },
  { method: "post", path: "/v1/envelopes/{id}/void", tag: "Sobres", summary: "Anular un sobre en curso", body: VoidEnvelopeInput, response: EnvelopeDetail },
  { method: "post", path: "/v1/envelopes/{id}/remind", tag: "Sobres", summary: "Reenviar a los firmantes pendientes", response: z.object({ notified: z.number().int() }) },
  { method: "get", path: "/v1/envelopes/{id}/events", tag: "Sobres", summary: "Registro de eventos (cadena de hashes)", response: z.object({ items: z.array(EnvelopeEvent) }) },
  { method: "get", path: "/v1/envelopes/{id}/signed.pdf", tag: "Sobres", summary: "PDF final sellado (PAdES) con certificado de finalización", response: "pdf" },

  { method: "post", path: "/v1/envelopes/{id}/recipients/{recipientId}/signing-url", tag: "Firma embebida", summary: "URL de firma embebida (un solo uso, vence en 5 minutos)", body: CreateSigningUrlInput, status: 201, response: z.object({ url: z.string().url(), expiresAt: iso }) },
  { method: "get", path: "/v1/settings/embed", tag: "Firma embebida", summary: "Orígenes autorizados a enmarcar la firma", response: z.object({ frameAncestors: z.array(z.string()) }) },
  { method: "patch", path: "/v1/settings/embed", tag: "Firma embebida", summary: "Cambiar orígenes autorizados (CSP frame-ancestors)", body: EmbedSettingsInput, response: z.object({ frameAncestors: z.array(z.string()) }) },

  { method: "get", path: "/v1/webhooks", tag: "Webhooks", summary: "Listar webhooks", response: z.object({ items: z.array(Webhook), eventTypes: z.array(z.string()) }) },
  { method: "post", path: "/v1/webhooks", tag: "Webhooks", summary: "Crear webhook (el secreto se devuelve una sola vez)", body: CreateWebhookInput, status: 201, response: z.object({ webhook: Webhook, secret: z.string() }) },
  { method: "get", path: "/v1/webhooks/{id}", tag: "Webhooks", summary: "Detalle", response: Webhook },
  { method: "patch", path: "/v1/webhooks/{id}", tag: "Webhooks", summary: "Modificar", body: UpdateWebhookInput, response: Webhook },
  { method: "delete", path: "/v1/webhooks/{id}", tag: "Webhooks", summary: "Borrar", response: "none", status: 204 },
  { method: "get", path: "/v1/webhooks/{id}/deliveries", tag: "Webhooks", summary: "Entregas recientes", response: z.object({ items: z.array(WebhookDelivery) }) },
  { method: "post", path: "/v1/webhooks/{id}/test", tag: "Webhooks", summary: "Enviar un evento de prueba", status: 202, response: WebhookDelivery },
  { method: "post", path: "/v1/webhook-deliveries/{id}/retry", tag: "Webhooks", summary: "Reintentar una entrega", status: 202, response: WebhookDelivery },

  { method: "get", path: "/v1/signing/{token}", tag: "Firmante", summary: "Sesión de firma (token del link)", auth: "token" },
  { method: "post", path: "/v1/signing/{token}/consent", tag: "Firmante", summary: "Aceptar el uso de medios electrónicos", auth: "token" },
  { method: "post", path: "/v1/signing/{token}/complete", tag: "Firmante", summary: "Completar y firmar", body: CompleteSigningInput, auth: "token" },
  { method: "post", path: "/v1/signing/{token}/decline", tag: "Firmante", summary: "Rechazar", body: DeclineInput, auth: "token" },
  { method: "get", path: "/v1/signing/{token}/signed.pdf", tag: "Firmante", summary: "PDF final (si el sobre está completo)", response: "pdf", auth: "token" },
  // Experiencia (Fase 4)
  { method: "post", path: "/v1/envelopes/{id}/corrections", tag: "Sobres", summary: "Corregir un sobre en curso", description: "Mensaje, vencimiento, datos de contacto (link nuevo y el anterior revocado), altas y bajas de destinatarios y campos solo para quien no abrió el sobre. Quien ya firmó es inmutable. `addRecipients` y `addFields` usan el formato de PUT /recipients y PUT /fields.", body: CorrectEnvelopeInput, response: EnvelopeDetail },
  { method: "post", path: "/v1/envelopes/{id}/recipients/{recipientId}/in-person", tag: "Firma en persona", summary: "Abrir la firma en persona en el dispositivo del anfitrión", description: "Solo el usuario anfitrión (sesión web, no API key). Devuelve la ruta de la página del firmante y deja la sesión del firmante como cookie en ese navegador (1 h).", response: z.object({ url: z.string(), expiresAt: iso }) },
  { method: "post", path: "/v1/signing/{token}/in-person/confirm", tag: "Firma en persona", summary: "El firmante confirma su identidad en el dispositivo", body: InPersonConfirmInput, auth: "token" },
  { method: "post", path: "/v1/signing/{token}/in-person/end", tag: "Firma en persona", summary: "Cerrar la sesión en persona (el dispositivo vuelve al anfitrión)", auth: "token" },
  { method: "post", path: "/v1/envelopes/{id}/recipients/{recipientId}/resend-copy", tag: "Sobres", summary: "Reenviar el documento final a un participante", response: z.object({ queued: z.literal(true), recipientId: z.string().uuid() }) },
  { method: "post", path: "/v1/signing/{token}/request-copy", tag: "Firmante", summary: "Pedir de nuevo el documento final (máx. una vez cada 10 minutos)", auth: "token", response: z.object({ queued: z.literal(true), recipientId: z.string().uuid() }) },
  { method: "get", path: "/v1/reports/summary", tag: "Reportes", summary: "Resumen de actividad", description: "Query: from, to (ISO 8601; por defecto los últimos 6 meses). Totales, sobres por mes, remitentes y notificaciones por canal." },
  { method: "get", path: "/v1/reports/envelopes.csv", tag: "Reportes", summary: "Exportar sobres a CSV", description: "Query: from, to. UTF-8 con BOM; las celdas que empiezan con = + - @ se prefijan con ' (contra inyección de fórmulas)." },
  // Evidencia (Fase 5)
  { method: "get", path: "/v1/settings/evidence", tag: "Evidencia", summary: "Nivel PAdES de la organización y el que se aplica hoy" },
  { method: "patch", path: "/v1/settings/evidence", tag: "Evidencia", summary: "Elegir nivel PAdES (auto, B-B, B-T, B-LT, B-LTA)", body: UpdateEvidenceSettingsInput },
  { method: "get", path: "/v1/certificates", tag: "Evidencia", summary: "Listar certificados de la organización (sin material de clave)" },
  { method: "post", path: "/v1/certificates", tag: "Evidencia", summary: "Subir un .p12/.pfx (base64 + contraseña)", description: "La clave privada se guarda cifrada (cifrado de sobre con KMS o clave local) y nunca se devuelve. Solo RSA.", body: UploadCertificateInput, status: 201 },
  { method: "delete", path: "/v1/certificates/{id}", tag: "Evidencia", summary: "Eliminar certificado (borra el material de clave)", response: "none", status: 204 },
  { method: "post", path: "/v1/xml/sign", tag: "Firma XML", summary: "Firmar XML (DGII e-CF, DIAN, SUNAT CPE, XAdES-BES/EPES)", description: "Firma enveloped con el certificado de la organización. Perfiles: dgii-ecf (XMLDSig, C14N inclusiva), dian-fe (XAdES-EPES con política DIAN v2, dentro de ext:ExtensionContent), xades-bes, xades-epes (requiere policy). Devuelve el XML firmado y su verificación.", body: XmlSignInput },
  { method: "post", path: "/v1/xml/verify", tag: "Firma XML", summary: "Verificar una firma XML (digests, SignatureValue, SigningCertificate)", body: XmlVerifyInput },
  { method: "get", path: "/v1/envelopes/{id}/seal-options", tag: "Evidencia", summary: "Sello de empresa y nivel de firma del sobre" },
  { method: "put", path: "/v1/envelopes/{id}/seal-options", tag: "Evidencia", summary: "Elegir sello de empresa (certificado) y nivel de firma declarado", body: SealOptionsInput },
  { method: "post", path: "/v1/validate", tag: "Evidencia", summary: "Validar las firmas de un PDF (público)", description: "Multipart, campo file. Por firma: integridad, cobertura, sello de tiempo, cadena hasta raíces de confianza, revocación (DSS u online) y nivel PAdES.", multipart: true, auth: "none" },
  { method: "get", path: "/v1/signature-providers", tag: "Evidencia", summary: "Conectores de firma (plataforma, CSC v2, CA de Calasign)" },
  { method: "post", path: "/v1/signature-providers/{id}/test", tag: "Evidencia", summary: "Probar un conector CSC (lista credenciales y firma un hash de prueba)" },
];

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of [...OPS, ...(PLATFORM_OPS as Op[]), ...(AI_OPS as unknown as Op[]), ...(AGREEMENTS_OPS as Op[]), ...(CRM_OPS as Op[])]) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    if (op.idempotent) params.push({ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } } as never);
    const status = String(op.status ?? 200);
    const responses: Record<string, unknown> = {
      [status]:
        op.response === "none"
          ? { description: "Sin contenido" }
          : op.response === "pdf"
            ? { description: "PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } }
            : { description: "OK", content: { "application/json": { schema: op.response ? js(op.response) : { type: "object" } } } },
      "4XX": { description: "Error", content: { "application/json": { schema: js(Error) } } },
    };
    const entry: Record<string, unknown> = {
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      ...(params.length ? { parameters: params } : {}),
      responses,
      security: securityFor(op),
    };
    if (op.body) entry.requestBody = { required: true, content: { "application/json": { schema: js(op.body) } } };
    if (op.form) entry.requestBody = { required: true, content: { "application/x-www-form-urlencoded": { schema: js(op.form) } } };
    if (op.multipart)
      entry.requestBody = {
        required: true,
        content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } } },
      };
    (paths[op.path] ??= {})[op.method] = entry;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "CalaSign API",
      version: "1.0.0",
      description:
        "Firma electrónica en la nube. Autenticación con `Authorization: Bearer <API key o access token OAuth>`. Errores: `{ error: { code, message, details? } }`. " +
        "Webhooks firmados con `CalaSign-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, \"<t>.<body>\")>`. " +
        `Eventos: ${WEBHOOK_EVENT_TYPES.join(", ")}.`,
    },
    servers: [{ url: config.appUrl }],
    components: {
      securitySchemes: {
        apiKey: { type: "http", scheme: "bearer", description: "API key de la organización (cs_live_… / cs_test_…)" },
        session: { type: "apiKey", in: "cookie", name: "cs_session" },
        oauth2: OAUTH2_SECURITY_SCHEME,
        clientBasic: { type: "http", scheme: "basic", description: "client_id:client_secret de la app OAuth" },
      },
    },
    paths,
  };
}

export async function openApiRoutes(app: FastifyInstance) {
  let cached: unknown = null;
  app.get("/v1/openapi.json", async (_req, reply) => {
    cached ??= buildOpenApi();
    reply.header("cache-control", "public, max-age=300");
    return cached;
  });
}
