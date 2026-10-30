// OpenAPI 3.1 de la API v1, generado a partir de los esquemas Zod del contrato (packages/shared).
// Las respuestas se describen con esquemas propios (openapi-schemas.ts: las salidas son tipos TS, no Zod).
// Errores, tags, parámetros y operationId: openapi-extra.ts.
import type { FastifyInstance } from "fastify";
import { z, ZodEffects, type AnyZodObject, type ZodTypeAny } from "zod";
import {
  AnchorFieldInput,
  CompleteSigningInput,
  CreateSignatureHandoffInput,
  SendSignatureHandoffInput,
  SubmitSignatureHandoffInput,
  HANDOFF_CHANNELS,
  CorrectEnvelopeInput,
  CreateApiKeyInput,
  CreateBulkSendInput,
  CreateEnvelopeInput,
  CreateGroupInput,
  CreateRoleInput,
  CreateSigningUrlInput,
  CreateTemplateInput,
  CreateWebhookInput,
  DeclineInput,
  DelegateInput,
  EmbedSettingsInput,
  ENVELOPE_STATUSES,
  EnvelopeFromTemplateInput,
  EnvelopePaymentInput,
  InlineDocumentInput,
  InlineRecipientInput,
  ONE_SHOT_MAX_DOCUMENTS,
  FieldInput,
  IdentitySettingsInput,
  IDV_LEVELS,
  IDV_PROVIDERS,
  InPersonConfirmInput,
  InviteMemberInput,
  LoginInput,
  LOCALES,
  OtpVerifyInput,
  PutRecipientsInput,
  PutSharesInput,
  PutTemplateFieldsInput,
  PutTemplateRolesInput,
  PutTemplateSharesInput,
  ReassignInput,
  RecipientInput,
  RoleAssignment,
  SealOptionsInput,
  SignupInput,
  SubmitWebFormInput,
  TemplateFromEnvelopeInput,
  UpdateBrandingInput,
  UpdateEnvelopeInput,
  UpdateEvidenceSettingsInput,
  UpdateOrganizationSettingsInput,
  UpdateGroupInput,
  UpdateRoleInput,
  UpdateSecuritySettingsInput,
  UpdateTemplateInput,
  UpdateWebFormInput,
  UpdateWebhookInput,
  UploadCertificateInput,
  VoidEnvelopeInput,
  WEBHOOK_EVENT_TYPES,
  WebFormInput,
  XmlSignInput,
  XmlVerifyInput,
} from "@calasign/shared";
import { config } from "../config";
import { OAUTH2_SECURITY_SCHEME, PLATFORM_OPS } from "./platform-openapi";
import { AGREEMENTS_OPS } from "./agreements/openapi";
import { CRM_OPS } from "./crm/openapi";
import { LOWCODE_OPS } from "./lowcode-openapi";
import { CONNECTOR_OPS } from "./connectors/openapi";
import { requiredScope } from "./oauth-tokens";
import { AI_OPS } from "./ai/openapi";
import { DATA_OPS } from "./data/openapi";
import { CERTSIGN_OPS } from "./certsign-openapi";
import { WHITE_LABEL_OPS } from "./white-label/openapi";
import { DEVAPI_OPS, ENVELOPE_SEARCH_QUERY } from "./devapi/openapi";
import {
  AccessSchema,
  ApiKeySchema,
  AuditLogEntrySchema,
  BrandingSchema,
  BulkSendItemSchema,
  BulkSendSchema,
  BulkValidationResultSchema,
  CustomRoleSchema,
  UploadedDocumentSchema,
  EnvelopeDetailSchema,
  EnvelopeEventSchema,
  EnvelopeListSchema,
  EnvelopePaymentSchema,
  GroupSchema,
  IdentitySettingsSchema,
  InvitationSchema,
  MeSchema,
  MemberSchema,
  named,
  PaymentProviderSchema,
  RecipientIdentityDetailSchema,
  ReportsSummarySchema,
  SealOptionsSchema,
  SharesSchema,
  SigningUrlSchema,
  TemplateDetailSchema,
  TemplateSummarySchema,
  VerifyResponseSchema,
  WebFormSchema,
  WebhookDeliverySchema,
  WebhookSchema,
} from "./openapi-schemas";
import {
  EXTRA_DESCRIPTION,
  EXTRA_QUERY,
  PATH_PARAMETERS,
  TAGS,
  autoOperationId,
  componentSchemas,
  errorComponents,
  errorResponses,
  js,
  pathParams,
  queryParams,
  webhooksObject,
  type Op,
} from "./openapi-extra";

const iso = z.string().datetime();

// ───────── Entradas que el handler acepta y el Zod del contrato no declara ─────────

/** POST /v1/api-keys también lee role/roleId del cuerpo (la política de acceso los valida). */
const CreateApiKeyBody = CreateApiKeyInput.extend({
  role: z.enum(["admin", "member", "custom"]).optional().describe("Rol de la key (por defecto admin). No puede ser owner."),
  roleId: z.string().uuid().optional().describe("Rol personalizado (obligatorio con role=custom)."),
});
/**
 * POST /v1/envelopes: los campos se validan después de resolver `recipient`/`document` (posición, ref o email), con
 * FieldInput / AnchorFieldInput; acá se documentan así.
 */
const unwrapObject = (t: ZodTypeAny): AnyZodObject => (t instanceof ZodEffects ? unwrapObject(t.innerType()) : (t as AnyZodObject));
const FieldObject = unwrapObject(FieldInput);
const InlineFieldDoc = (base: AnyZodObject) =>
  base.omit({ recipientId: true, documentId: true }).extend({
    recipient: z
      .union([z.number().int().min(0), z.string()])
      .optional()
      .describe("Destinatario: posición en `recipients` (0 = el primero), su `ref` o su email. Opcional con un solo firmante."),
    document: z
      .union([z.number().int().min(0), z.string()])
      .optional()
      .describe("Documento: posición en `documents` o su `ref`. Opcional con un solo documento (con `anchor`, sin él se busca en todos)."),
    recipientId: z.string().uuid().optional().describe("Alternativa a `recipient`: el `id` propio que se le dio al destinatario."),
  });
const CreateEnvelopeRequestBody = CreateEnvelopeInput.extend({
  documents: z
    .array(InlineDocumentInput)
    .max(ONE_SHOT_MAX_DOCUMENTS)
    .optional()
    .describe("PDF del sobre, en orden. Cada uno con base64, url o file (parte del multipart)."),
  recipients: z.array(InlineRecipientInput).max(50).optional().describe("Destinatarios (formato de PUT /recipients) con `ref` opcional."),
  fields: z
    .array(z.union([InlineFieldDoc(FieldObject), InlineFieldDoc(AnchorFieldInput)]))
    .max(500)
    .optional()
    .describe("Campos con coordenadas o con `anchor` (como PUT /fields)."),
  send: z.boolean().optional().describe('true: lo envía en la misma llamada (equivale a status "sent").'),
  status: z.enum(["draft", "sent"]).optional().describe("Estado en que queda: draft (por defecto) o sent."),
  embeddedSigning: CreateSigningUrlInput.optional().describe("Opciones (returnUrl, frameAncestors) de las URLs de firma embebida de la respuesta."),
});
const CreateEnvelopeResponseSchema = named(
  "CreateEnvelopeResponse",
  EnvelopeDetailSchema.extend({
    documents: z
      .array(UploadedDocumentSchema)
      .describe(
        "Los documentos creados, con `hadSignatures` (firmas previas del archivo que se perdieron al sanearlo) y `formAppearanceMismatch` (aviso: alguna apariencia de formulario no se pudo regenerar y se fijó la guardada).",
      ),
    signingUrls: z
      .array(SigningUrlSchema.extend({ recipientId: z.string().uuid() }))
      .optional()
      .describe(
        "Con send y destinatarios embedded: la URL de firma embebida (un solo uso, 5 minutos) de cada uno al que ya le toca. Al repetir el pedido con la misma Idempotency-Key se emiten URLs nuevas (no se guardan).",
      ),
    signingUrlsHint: z
      .string()
      .optional()
      .describe(
        "Solo al repetir con la misma Idempotency-Key, si alguna URL ya no se pudo emitir: cómo pedirla (POST /v1/envelopes/{id}/recipients/{recipientId}/signing-url).",
      ),
  }),
);

const PaymentStateSchema = named(
  "EnvelopePaymentState",
  z.object({
    payment: EnvelopePaymentSchema.nullable(),
    providers: z.array(PaymentProviderSchema),
    envelopeUpdatedAt: iso.describe("updatedAt del sobre tras leer o guardar (para X-Expected-Updated-At del siguiente guardado)."),
  }),
);

const PutFieldsWithAnchors = z.object({ fields: z.array(z.union([FieldInput, AnchorFieldInput])).max(500) });
/** addRecipients y addFields se validan con RecipientInput y FieldInput (en el contrato son unknown[]). */
const CorrectEnvelopeBody = CorrectEnvelopeInput.extend({
  addRecipients: z
    .array(RecipientInput)
    .max(20)
    .optional()
    .describe("Destinatarios nuevos (formato de PUT /recipients). Solo en grupos de ruteo que no empezaron."),
  addFields: z
    .array(FieldInput)
    .max(500)
    .optional()
    .describe("Campos nuevos (formato de PUT /fields, sin anclas) para destinatarios que todavía no abrieron el sobre."),
});

// ───────── Parámetros de query ─────────

const Q = {
  limit: (def: number, max: number) => ({
    name: "limit",
    description: `Cantidad máxima de resultados (1..${max}, por defecto ${def}).`,
    schema: { type: "integer", minimum: 1, maximum: max, default: def },
  }),
  cursor: { name: "cursor", description: "Valor de `nextCursor` de la página anterior (opaco)." },
  from: {
    name: "from",
    description: "Desde (ISO 8601). Por defecto, el día 1 del mes que está 5 meses antes de `to` (6 meses calendario).",
    schema: { type: "string", format: "date-time" },
  },
  to: { name: "to", description: "Hasta (ISO 8601). Por defecto, ahora. Rango máximo: 3 años.", schema: { type: "string", format: "date-time" } },
  tz: {
    name: "tz",
    description:
      "Zona horaria IANA (p. ej. America/Argentina/Buenos_Aires). Sin distinguir mayúsculas. Una desconocida (o mal escrita) no es un error: se usa UTC; en los CSV el header `X-Time-Zone` informa la zona usada.",
  },
  sep: {
    name: "sep",
    description: "Separador del CSV: `,` (por defecto) o `;` (Excel en español o portugués). También `comma` / `semicolon`.",
    schema: { type: "string", enum: [",", ";", "comma", "semicolon"] },
  },
};
const AUDIT_QUERY = [
  { name: "action", description: "Acción exacta (p. ej. api_key.created) o prefijo terminado en * (p. ej. member.*)." },
  { name: "actor", description: "Texto en la etiqueta del actor (nombre, correo o nombre de la key) o id exacto del actor." },
  { name: "targetType", description: "Tipo de objeto afectado (p. ej. api_key, webhook, user, template, settings)." },
  { name: "from", description: "Desde (ISO 8601).", schema: { type: "string", format: "date-time" } },
  { name: "to", description: "Hasta (ISO 8601).", schema: { type: "string", format: "date-time" } },
];

const IDEMPOTENT_NOTE = " Admite `Idempotency-Key`.";

// ───────── Rutas ─────────

const OPS: Op[] = [
  // Identidad
  {
    method: "post",
    path: "/v1/auth/signup",
    operationId: "signup",
    tag: "Identidad",
    summary: "Crear cuenta y organización",
    description:
      "Crea el usuario (propietario) y la organización y deja la sesión en la cookie de sesión (__Host-cs_session). 10 pedidos por minuto por IP.",
    body: SignupInput,
    status: 201,
    response: MeSchema,
    auth: "none",
    errors: ["email_taken"],
  },
  {
    method: "post",
    path: "/v1/auth/login",
    operationId: "login",
    tag: "Identidad",
    summary: "Iniciar sesión (cookie)",
    description:
      "Para la web: deja la sesión en la cookie de sesión (__Host-cs_session). Si el usuario tiene verificación en dos pasos devuelve `{ twoFactorRequired: true, challengeToken }` sin sesión (se completa con POST /v1/auth/2fa/verify). Para integraciones, usar API keys u OAuth.",
    body: LoginInput,
    response: z.union([MeSchema, z.object({ twoFactorRequired: z.literal(true), challengeToken: z.string() })]),
    auth: "none",
    errors: ["unauthorized", "sso_required", "too_many_attempts"],
  },
  {
    method: "get",
    path: "/v1/me",
    operationId: "getMe",
    tag: "Identidad",
    summary: "Usuario y organización actuales",
    description:
      "Con una API key, `user` describe la key (id de la key, email vacío). Sirve para probar una credencial: no exige el plan con acceso por API.",
    response: MeSchema,
  },
  {
    method: "get",
    path: "/v1/api-keys",
    operationId: "listApiKeys",
    tag: "Identidad",
    summary: "Listar API keys",
    response: z.object({ items: z.array(ApiKeySchema) }),
  },
  {
    method: "post",
    path: "/v1/api-keys",
    operationId: "createApiKey",
    tag: "Identidad",
    summary: "Crear API key (el secreto se devuelve una sola vez)",
    description:
      "El secreto empieza con `cs_live_` en producción y con `cs_test_` en los demás entornos. Quien la crea tiene que tener todos los permisos del rol que le da (salvo propietarios).",
    body: CreateApiKeyBody,
    status: 201,
    response: z.object({ apiKey: ApiKeySchema, secret: z.string().describe("cs_live_… / cs_test_…; se muestra una sola vez.") }),
    errors: ["invalid_role"],
  },
  {
    method: "delete",
    path: "/v1/api-keys/{id}",
    operationId: "revokeApiKey",
    tag: "Identidad",
    summary: "Revocar API key",
    response: "none",
    status: 204,
  },

  // Sobres
  {
    method: "get",
    path: "/v1/envelopes",
    operationId: "listEnvelopes",
    tag: "Sobres",
    summary: "Listar sobres",
    description: "Del más nuevo al más viejo, paginado por cursor. Una API key sin envelopes:view_all ve solo los sobres que creó ella.",
    query: [
      {
        name: "status",
        description: `Estados separados por coma (${ENVELOPE_STATUSES.join(", ")}).`,
        schema: { type: "string", example: "sent,completed" },
      },
      { name: "q", description: "Texto en el asunto o en el nombre o correo de un destinatario." },
      ...ENVELOPE_SEARCH_QUERY,
      Q.cursor,
      Q.limit(25, 100),
    ],
    response: EnvelopeListSchema,
    errors: ["invalid_cursor"],
  },
  {
    method: "post",
    path: "/v1/envelopes",
    operationId: "createEnvelope",
    tag: "Sobres",
    summary: "Crear sobre (completo y enviado en una sola llamada, o borrador)",
    description:
      "Crea el sobre y, en la MISMA llamada, sus documentos (`documents`: PDF en `base64`, por `url` https pública o como " +
      "parte `file` de un multipart), destinatarios (`recipients`, formato de PUT /recipients más un `ref` opcional) y " +
      "campos (`fields`, con coordenadas o `anchor`; el destinatario y el documento se citan con `recipient` / `document`: " +
      "posición en la lista, `ref` o, para el destinatario, su email; se pueden omitir si hay un solo firmante / documento). " +
      'Con `send: true` (o `status: "sent"`) también lo envía y la respuesta trae `signingUrls` para los firmantes ' +
      "`embedded` a los que ya les toca. Es atómico: si algo falla (PDF inválido, ancla que no aparece, sobre incompleto " +
      "para enviar) no se crea nada. Sin esos agregados, crea un borrador vacío para completarlo paso a paso. " +
      "En multipart/form-data, el JSON va en la parte `payload` y cada PDF en su propia parte (sin `documents`, cada " +
      "archivo es un documento, en orden). Hasta 10 documentos; cada PDF hasta el máximo de subida. Sin expiresAt, vence " +
      "a los 30 días (con expiresAt: null, no vence). Si envía, cuenta para el cupo mensual del plan. " +
      "Errores propios: 400 not_pdf (un documento que no es PDF o un base64 inválido, por cualquier vía), " +
      "document_fetch_failed (no se pudo descargar `url`), too_many_documents (más de 10), duplicate_ref, " +
      "too_many_fields (las anclas generan más de 500 campos); en multipart, payload_required (falta la parte `payload`), " +
      "invalid_json (`payload` no es JSON), unknown_part (un campo de texto que no es `payload`), duplicate_part (dos partes " +
      "con el mismo nombre), file_part_missing / unused_file_part / duplicate_document (partes que no cuadran con " +
      "`documents[].file`); 413 file_too_large (un PDF supera el máximo de subida o todos juntos superan el doble de ese máximo) y " +
      "payload_too_large (el JSON del sobre, sin el base64 de los documentos, supera 2 MB)." +
      IDEMPOTENT_NOTE,
    body: CreateEnvelopeRequestBody,
    multipartPayload: "PDF del sobre (una parte por documento; el nombre de la parte es el que cita `documents[].file`).",
    status: 201,
    response: CreateEnvelopeResponseSchema,
    idempotent: true,
    errors: [
      "not_pdf",
      "invalid_field",
      "anchor_not_found",
      "too_many_fields",
      "pdf_too_heavy",
      "pdf_reader_busy",
      "document_fetch_failed",
      "file_part_missing",
      "unused_file_part",
      "payload_required",
      "invalid_json",
      "unknown_part",
      "duplicate_part",
      "duplicate_document",
      "too_many_documents",
      "payload_too_large",
      "duplicate_ref",
      "duplicate_ids",
      "id_in_use",
      "file_too_large",
      "envelope_incomplete",
      "logic_order",
      "invalid_brand",
      "plan_limit_white_label",
      "plan_limit_envelopes",
      "frame_ancestor_not_allowed",
    ],
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}",
    operationId: "getEnvelope",
    tag: "Sobres",
    summary: "Detalle del sobre",
    response: EnvelopeDetailSchema,
  },
  {
    method: "patch",
    path: "/v1/envelopes/{id}",
    operationId: "updateEnvelope",
    tag: "Sobres",
    summary: "Modificar borrador",
    description:
      "Solo los campos presentes. `metadata` reemplaza la anterior, salvo las claves que pone el sistema (workflowRunId, webFormId, bulkSendId, crm, connector, agreement, templateId, clonedFrom…), que se conservan y que el cliente no puede fijar (se ignoran también al crear o clonar). `brandId` con una sub-marca distinta de la actual exige la marca blanca en el plan.",
    body: UpdateEnvelopeInput,
    response: EnvelopeDetailSchema,
    expectedUpdatedAt: true,
    errors: ["not_draft", "invalid_brand", "plan_limit_white_label", "version_changed"],
  },
  {
    method: "delete",
    path: "/v1/envelopes/{id}",
    operationId: "deleteEnvelope",
    tag: "Sobres",
    summary: "Borrar borrador",
    response: "none",
    status: 204,
    errors: ["not_draft"],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/documents",
    operationId: "addEnvelopeDocument",
    tag: "Sobres",
    summary: "Agregar documento PDF",
    description:
      "multipart/form-data con el campo `file`. El PDF se normaliza al subirlo (lo que se ve es lo que se firma); el hash del archivo subido queda en la evidencia. El PDF se sanea: formularios aplanados tal como se ven, contenido activo (JavaScript, acciones, multimedia) y adjuntos eliminados; las capas ocultas se rechazan (pdf_hidden_layers) y las firmas digitales previas se pierden (`hadSignatures` en la respuesta); si alguna apariencia de formulario no se pudo regenerar se fija la guardada y se avisa con `formAppearanceMismatch`. Topes por sobre: 30 documentos y 1000 páginas en total (400 too_many_documents / too_many_pages) y 100 MB en total (413 file_too_large).",
    multipart: true,
    fileDescription: "PDF (sin contraseña). El nombre del archivo es el nombre del documento.",
    status: 201,
    response: UploadedDocumentSchema,
    errors: ["not_draft", "not_pdf", "too_many_documents"],
  },
  {
    method: "delete",
    path: "/v1/envelopes/{id}/documents/{documentId}",
    operationId: "deleteEnvelopeDocument",
    tag: "Sobres",
    summary: "Quitar documento",
    response: "none",
    status: 204,
    errors: ["not_draft"],
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/documents/{documentId}/file",
    operationId: "downloadEnvelopeDocument",
    tag: "Sobres",
    summary: "Descargar el PDF original",
    description: "Si el original ya se borró por la política de retención, 410 purged (de un sobre completado sigue disponible el PDF firmado).",
    response: "pdf",
    errors: ["purged"],
  },
  {
    method: "put",
    path: "/v1/envelopes/{id}/recipients",
    operationId: "putEnvelopeRecipients",
    tag: "Sobres",
    summary: "Reemplazar destinatarios",
    description:
      "Reemplaza la lista completa. Ids opcionales (UUID generados por el cliente para referenciarlos desde los campos; un id ya presente actualiza ese destinatario). `embedded: true` = firma embebida, sin invitaciones: un destinatario embebido no puede usar código OTP (400 validation_error; lo autentica tu aplicación) ni delegar. Los campos de quien pasa a cc o approver se borran. Reordenar no puede dejar una condición citando a alguien que firma después (422 logic_order).",
    body: PutRecipientsInput,
    response: EnvelopeDetailSchema,
    expectedUpdatedAt: true,
    errors: ["not_draft", "duplicate_ids", "id_in_use", "identity_provider_unavailable", "plan_limit_kyc", "logic_order", "version_changed"],
  },
  {
    method: "put",
    path: "/v1/envelopes/{id}/fields",
    operationId: "putEnvelopeFields",
    tag: "Sobres",
    summary: "Reemplazar campos",
    description:
      "Reemplaza la lista completa. Cada campo va con coordenadas normalizadas (page desde 0, x, y, width, height en 0..1; origen arriba a la izquierda) o con `anchor` para ubicarlo por un texto del PDF (se expande a un campo por aparición; offsets y tamaño en puntos). Solo destinatarios signer llevan campos. Una condición (`conditions`) solo puede citar un campo de solo lectura, del mismo destinatario o de alguien que firma antes (si no, 422 logic_order: se decidiría con un valor que todavía no existe).",
    body: PutFieldsWithAnchors,
    response: EnvelopeDetailSchema,
    expectedUpdatedAt: true,
    errors: [
      "not_draft",
      "invalid_field",
      "anchor_not_found",
      "too_many_fields",
      "pdf_too_heavy",
      "pdf_reader_busy",
      "logic_order",
      "version_changed",
    ],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/send",
    operationId: "sendEnvelope",
    tag: "Sobres",
    summary: "Enviar",
    description:
      "Valida el borrador (documentos, firmantes con campo de firma, vencimiento, fórmulas, cobro) y envía las invitaciones al primer grupo de ruteo. Cuenta para el cupo mensual del plan." +
      IDEMPOTENT_NOTE,
    response: EnvelopeDetailSchema,
    idempotent: true,
    expectedUpdatedAt: true,
    errors: ["not_draft", "envelope_incomplete", "plan_limit_envelopes", "version_changed"],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/void",
    operationId: "voidEnvelope",
    tag: "Sobres",
    summary: "Anular un sobre en curso",
    description:
      "Con X-Expected-Updated-At (opcional), 409 version_changed si el sobre cambió desde que se leyó (p. ej. alguien firmó) en vez de anular algo distinto de lo revisado.",
    body: VoidEnvelopeInput,
    response: EnvelopeDetailSchema,
    expectedUpdatedAt: true,
    errors: ["not_voidable", "version_changed"],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/remind",
    operationId: "remindEnvelope",
    tag: "Sobres",
    summary: "Reenviar a los firmantes pendientes",
    description:
      "Avisa al grupo de ruteo actual (sin los embebidos ni los de firma en persona). Con el sobre en awaiting_certificates, avisa al firmante con certificado al que le toca. Como mucho un recordatorio manual cada 10 minutos por sobre (si no, 429 reminded_recently) y 5 en 24 horas (configurable por la plataforma; si no, 429 reminder_daily_limit); ninguno de los dos trae Retry-After. Con X-Expected-Updated-At (opcional), 409 version_changed si el sobre cambió desde que se leyó.",
    response: z.object({ notified: z.number().int() }),
    expectedUpdatedAt: true,
    errors: ["not_in_progress", "reminded_recently", "reminder_daily_limit", "version_changed"],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/retry-finalize",
    operationId: "retryEnvelopeFinalize",
    tag: "Sobres",
    summary: "Reintentar la finalización",
    description: "Para un sobre que quedó en finalizing porque el sellado agotó sus reintentos. Encola el sellado otra vez.",
    status: 202,
    response: z.object({ queued: z.literal(true) }),
    errors: ["not_finalizing", "finalize_in_progress"],
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/events",
    operationId: "listEnvelopeEvents",
    tag: "Sobres",
    summary: "Registro de eventos (cadena de hashes)",
    response: z.object({ items: z.array(EnvelopeEventSchema) }),
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/signed.pdf",
    operationId: "downloadSignedPdf",
    tag: "Sobres",
    summary: "PDF final sellado (PAdES) con certificado de finalización",
    description: "404 hasta que el sobre está completed.",
    response: "pdf",
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/corrections",
    operationId: "correctEnvelope",
    tag: "Sobres",
    summary: "Corregir un sobre en curso",
    description:
      "Mensaje, vencimiento, datos de contacto (link nuevo y el anterior revocado), altas y bajas de destinatarios y campos solo para quien no abrió el sobre. Quien ya firmó es inmutable. El sobre corregido sigue limitado a 50 destinatarios y 500 campos (si no, 422 envelope_incomplete).",
    body: CorrectEnvelopeBody,
    response: EnvelopeDetailSchema,
    errors: ["invalid_contact", "recipient_immutable", "envelope_incomplete"],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/recipients/{recipientId}/reassign",
    operationId: "reassignRecipient",
    tag: "Sobres",
    summary: "Reasignar un firmante o aprobador pendiente",
    description:
      "El nuevo destinatario hereda rol, orden, campos, cobro, verificación de identidad y firma con certificado; el anterior queda `reassigned` (replacedBy) con su link revocado. Si el anterior ya estaba invitado, el nuevo recibe la invitación enseguida. Como mucho 20 delegaciones o reasignaciones por sobre (409 too_many_replacements).",
    body: ReassignInput,
    response: EnvelopeDetailSchema,
    errors: ["not_in_progress", "not_replaceable", "too_many_replacements"],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/recipients/{recipientId}/resend-copy",
    operationId: "resendEnvelopeCopy",
    tag: "Sobres",
    summary: "Reenviar el documento final a un participante",
    response: z.object({ queued: z.literal(true), recipientId: z.string().uuid() }),
    errors: ["not_completed"],
  },

  // Plantillas
  {
    method: "get",
    path: "/v1/templates",
    operationId: "listTemplates",
    tag: "Plantillas",
    summary: "Listar plantillas",
    description:
      "Las plantillas que la credencial puede ver (visibilidad de organización, propias o compartidas con sus grupos), de la modificada más recientemente a la más vieja, paginadas por cursor (`nextCursor`). Sin cursor, la primera página.",
    query: [{ name: "q", description: "Texto en el nombre o la descripción." }, Q.cursor, Q.limit(200, 200)],
    response: z.object({ items: z.array(TemplateSummarySchema), nextCursor: z.string().nullable() }),
    errors: ["invalid_cursor"],
  },
  {
    method: "post",
    path: "/v1/templates",
    operationId: "createTemplate",
    tag: "Plantillas",
    summary: "Crear plantilla",
    body: CreateTemplateInput,
    status: 201,
    response: TemplateDetailSchema,
  },
  {
    method: "get",
    path: "/v1/templates/{id}",
    operationId: "getTemplate",
    tag: "Plantillas",
    summary: "Detalle de la plantilla (documentos, roles y campos)",
    response: TemplateDetailSchema,
  },
  {
    method: "patch",
    path: "/v1/templates/{id}",
    operationId: "updateTemplate",
    tag: "Plantillas",
    summary: "Modificar plantilla",
    body: UpdateTemplateInput,
    response: TemplateDetailSchema,
    expectedUpdatedAt: true,
    errors: ["version_changed"],
  },
  {
    method: "delete",
    path: "/v1/templates/{id}",
    operationId: "deleteTemplate",
    tag: "Plantillas",
    summary: "Borrar plantilla",
    description:
      "Los sobres ya creados desde la plantilla no cambian. Sus formularios web se borran con ella: con alguno que todavía recibe envíos (activo, sin vencer ni agotar), 409 template_has_forms con sus nombres en `details.names` (desactivarlos o borrarlos antes).",
    response: "none",
    status: 204,
    errors: ["template_has_forms"],
  },
  {
    method: "post",
    path: "/v1/templates/{id}/documents",
    operationId: "addTemplateDocument",
    tag: "Plantillas",
    summary: "Agregar documento PDF",
    description:
      "multipart/form-data con el campo `file`. El PDF se normaliza al subirlo. El PDF se sanea: formularios aplanados tal como se ven, contenido activo (JavaScript, acciones, multimedia) y adjuntos eliminados; las capas ocultas se rechazan (pdf_hidden_layers) y las firmas digitales previas se pierden (`hadSignatures` en la respuesta); si alguna apariencia de formulario no se pudo regenerar se fija la guardada y se avisa con `formAppearanceMismatch`. Topes por plantilla: 30 documentos y 1000 páginas en total (400 too_many_documents / too_many_pages) y 100 MB en total (413 file_too_large).",
    multipart: true,
    fileDescription: "PDF (sin contraseña). El nombre del archivo es el nombre del documento.",
    status: 201,
    response: UploadedDocumentSchema,
    errors: ["not_pdf", "too_many_documents"],
  },
  {
    method: "delete",
    path: "/v1/templates/{id}/documents/{documentId}",
    operationId: "deleteTemplateDocument",
    tag: "Plantillas",
    summary: "Quitar documento",
    response: "none",
    status: 204,
  },
  {
    method: "get",
    path: "/v1/templates/{id}/documents/{documentId}/file",
    operationId: "downloadTemplateDocument",
    tag: "Plantillas",
    summary: "Descargar el PDF del documento",
    response: "pdf",
  },
  {
    method: "put",
    path: "/v1/templates/{id}/roles",
    operationId: "putTemplateRoles",
    tag: "Plantillas",
    summary: "Reemplazar roles",
    description:
      "Reemplaza la lista completa (un id existente actualiza ese rol). Los nombres son únicos sin distinguir mayúsculas. Un rol cc o approver pierde sus campos.",
    body: PutTemplateRolesInput,
    response: TemplateDetailSchema,
    expectedUpdatedAt: true,
    errors: [
      "duplicate_ids",
      "duplicate_roles",
      "template_id_in_use",
      "certificate_not_applicable",
      "logic_order",
      "template_has_forms_edit",
      "version_changed",
    ],
  },
  {
    method: "put",
    path: "/v1/templates/{id}/fields",
    operationId: "putTemplateFields",
    tag: "Plantillas",
    summary: "Reemplazar campos",
    description:
      "Reemplaza la lista completa. Coordenadas normalizadas como en los sobres (sin anclas); cada campo va con el roleId de un rol signer. Las condiciones siguen la misma regla de orden que en los sobres (422 logic_order).",
    body: PutTemplateFieldsInput,
    response: TemplateDetailSchema,
    expectedUpdatedAt: true,
    errors: ["invalid_field", "logic_order", "template_has_forms_edit", "version_changed"],
  },
  {
    method: "post",
    path: "/v1/templates/from-envelope/{envelopeId}",
    operationId: "createTemplateFromEnvelope",
    tag: "Plantillas",
    summary: "Crear plantilla desde un sobre",
    description:
      "Copia asunto, mensaje, documentos, campos y lógica. Cada destinatario pasa a un rol (Firmante 1, Copia 1, Aprobador 1…); de los campos se conservan solo los valores de solo lectura que fijó el remitente. Si los originales del sobre se borraron por la política de retención, 410 purged.",
    body: TemplateFromEnvelopeInput,
    status: 201,
    response: TemplateDetailSchema,
    errors: ["purged"],
  },
  {
    method: "post",
    path: "/v1/envelopes/from-template",
    operationId: "createEnvelopeFromTemplate",
    tag: "Plantillas",
    summary: "Crear sobre desde una plantilla (y enviarlo en la misma llamada)",
    description:
      "Un destinatario por rol (por `roleId` o por nombre en `role`). `prefill` completa campos por id o por etiqueta (sin distinguir mayúsculas). Con `send: true` se envía en el mismo pedido (y aplica el cupo mensual); si no, queda en borrador. Sin expiresAt, vence a los 30 días; con expiresAt: null, no vence." +
      IDEMPOTENT_NOTE,
    body: EnvelopeFromTemplateInput,
    status: 201,
    response: EnvelopeDetailSchema,
    idempotent: true,
    errors: [
      "template_empty",
      "unknown_role",
      "duplicate_role",
      "unknown_prefill",
      "readonly_field",
      "invalid_prefill",
      "roles_missing",
      "envelope_incomplete",
      "plan_limit_envelopes",
    ],
  },

  // Firma embebida
  {
    method: "post",
    path: "/v1/envelopes/{id}/recipients/{recipientId}/signing-url",
    operationId: "createSigningUrl",
    tag: "Firma embebida",
    summary: "URL de firma embebida (un solo uso, vence en 5 minutos)",
    description:
      "Con el sobre enviado (sent, awaiting_certificates o completed); al enviarlo, todos los destinatarios quedan activos, pero cada uno firma cuando le toca según routingOrder. Pedir una URL nueva cada vez que se muestra la ceremonia. Al terminar redirige a returnUrl con ?event=signing_complete|declined. Dentro de un iframe también avisa por postMessage (`viewed`, `signing_complete`, `declined`, `error` y `closed` con `status` si el sobre terminó sin que este firmante actuara). Un destinatario embebido no usa código OTP (lo autentica tu aplicación) ni puede delegar. Un destinatario no embebido solo obtiene URL si la página le sigue exigiendo autenticarse (código OTP, firma presencial o verificación de identidad pendiente); si solo tiene el link por correo responde 409 not_embedded. Para un firmante con código OTP la URL sale con `tabOnly: true`: sirve para una pestaña o una redirección (vuelve a returnUrl), no para un iframe; pedirla con frameAncestors responde 409 otp_not_embeddable.",
    body: CreateSigningUrlInput,
    bodyOptional: true,
    status: 201,
    response: SigningUrlSchema,
    errors: ["frame_ancestor_not_allowed", "not_available", "not_embedded", "otp_not_embeddable"],
  },
  {
    method: "get",
    path: "/v1/settings/embed",
    operationId: "getEmbedSettings",
    tag: "Firma embebida",
    summary: "Orígenes autorizados a enmarcar la firma",
    response: z.object({ frameAncestors: z.array(z.string()) }),
  },
  {
    method: "patch",
    path: "/v1/settings/embed",
    operationId: "updateEmbedSettings",
    tag: "Firma embebida",
    summary: "Cambiar orígenes autorizados (CSP frame-ancestors)",
    body: EmbedSettingsInput,
    response: z.object({
      frameAncestors: z.array(z.string()),
      discarded: z
        .array(z.string())
        .optional()
        .describe("Comodines demasiado amplios ya guardados que volvieron en la lista: se descartaron (uno nuevo da 400)."),
    }),
    errors: ["invalid_origin"],
  },

  // Webhooks
  {
    method: "get",
    path: "/v1/webhooks",
    operationId: "listWebhooks",
    tag: "Webhooks",
    summary: "Listar webhooks",
    response: z.object({ items: z.array(WebhookSchema), eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)) }),
  },
  {
    method: "post",
    path: "/v1/webhooks",
    operationId: "createWebhook",
    tag: "Webhooks",
    summary: "Crear webhook (el secreto se devuelve una sola vez)",
    description:
      "URL https (sin credenciales ni destinos locales). Máximo 20 por organización (cuentan los activos y los desactivados en los últimos 30 días). Sin `events`, recibe todos. Responde con el header `Location` (URL del webhook): DELETE a esa URL lo borra, como hacen los triggers REST hook de Power Automate y Logic Apps. Un webhook recibe los datos de todos los sobres de la organización: crearlo o modificarlo pide `webhooks:manage` y además `envelopes:view_all` (p. ej. el rol admin). Creado con una API key o con el token OAuth de un usuario (REST hooks de Zapier, Make, Power Automate), queda atado a esa credencial: si se revoca la key o la app, el usuario la desconecta (o se revocan sus tokens) o deja la organización, el webhook pasa a `active: false` (al listar los webhooks o en el próximo evento, antes de cualquier entrega; queda en la auditoría como webhook.deactivated). Reactivar uno desactivado por eso (PATCH `active: true`) lo pasa a la credencial de quien lo reactiva; desde una sesión web queda como webhook de la organización, sin credencial de origen. Pausar y reanudar uno que funciona no cambia su origen. Lo mismo si la credencial sigue vigente pero pierde `webhooks:manage` o `envelopes:view_all` (cambio de rol de la key o del usuario, o scopes de la app): `deactivatedReason: permission_lost`. Además se desactiva solo si el receptor responde 410 Gone (`gone`, sin reintentos) o con 50 entregas fallidas definitivas seguidas o 7 días fallando sin ninguna exitosa y con al menos 5 fallas seguidas (`failing`); cada desactivación automática queda en la auditoría y se avisa por correo a quienes tienen `webhooks:manage`. Cada evento lleva un `id` estable: re-procesarlo no genera una entrega nueva para el mismo endpoint.",
    body: CreateWebhookInput,
    status: 201,
    response: z.object({ webhook: WebhookSchema, secret: z.string().describe("whsec_…: verifica la firma HMAC. Se muestra una sola vez.") }),
    errors: ["invalid_url", "too_many_webhooks", "plan_limit_webhooks"],
  },
  { method: "get", path: "/v1/webhooks/{id}", operationId: "getWebhook", tag: "Webhooks", summary: "Detalle", response: WebhookSchema },
  {
    method: "patch",
    path: "/v1/webhooks/{id}",
    operationId: "updateWebhook",
    tag: "Webhooks",
    summary: "Modificar",
    description:
      "Como al crearlo, pide `webhooks:manage` y además `envelopes:view_all`. Con `active: true` sobre un webhook desactivado porque se revocó la credencial que lo creó o porque perdió los permisos, pasa a la credencial de quien lo reactiva (ver crear). Reactivar uno inactivo reinicia el conteo de fallas y vuelve a ocupar un lugar del tope de 20 (400 too_many_webhooks si no hay lugar). Activarlo (`active: true`) o cambiar `url` o `events` sin pausarlo exige webhooks en el plan (402); pausarlo o cambiar solo la descripción, no.",
    body: UpdateWebhookInput,
    response: WebhookSchema,
    errors: ["invalid_url", "too_many_webhooks", "plan_limit_webhooks"],
  },
  { method: "delete", path: "/v1/webhooks/{id}", operationId: "deleteWebhook", tag: "Webhooks", summary: "Borrar", response: "none", status: 204 },
  {
    method: "get",
    path: "/v1/webhooks/{id}/deliveries",
    operationId: "listWebhookDeliveries",
    tag: "Webhooks",
    summary: "Entregas recientes",
    query: [Q.limit(50, 200)],
    response: z.object({ items: z.array(WebhookDeliverySchema) }),
  },
  {
    method: "post",
    path: "/v1/webhooks/{id}/test",
    operationId: "testWebhook",
    tag: "Webhooks",
    summary: "Enviar un evento de prueba",
    description:
      "Encola un evento webhook.test (un solo intento, también con el endpoint inactivo). Exige webhooks en el plan (402). Hasta 10 pruebas por minuto (429 rate_limited).",
    status: 202,
    response: WebhookDeliverySchema,
    errors: ["plan_limit_webhooks"],
  },
  {
    method: "post",
    path: "/v1/webhook-deliveries/{id}/retry",
    operationId: "retryWebhookDelivery",
    tag: "Webhooks",
    summary: "Reintentar una entrega",
    description:
      "Un intento manual inmediato. Con el endpoint inactivo (pausado o desactivado), 409 endpoint_inactive: primero hay que reactivarlo. Con la entrega pendiente de su reintento automático, lo adelanta (no la manda dos veces); si ya hay un intento en curso o un reintento manual pedido, 409 delivery_pending. Pide `webhooks:manage` y además `envelopes:view_all`, y webhooks en el plan (402).",
    status: 202,
    response: WebhookDeliverySchema,
    errors: ["delivery_pending", "endpoint_inactive", "plan_limit_webhooks"],
  },

  // Envío masivo
  {
    method: "get",
    path: "/v1/templates/{id}/bulk-csv",
    operationId: "getBulkCsvTemplate",
    tag: "Envío masivo",
    summary: "CSV de ejemplo para una plantilla",
    description:
      "Encabezados `subject`, `<Rol>.name`, `<Rol>.email`, `<Rol>.phone`, `<Rol>.channels` por rol y `field.<Etiqueta>` por campo prellenable, con una fila de ejemplo. UTF-8 con BOM.",
    response: "csv",
  },
  {
    method: "post",
    path: "/v1/bulk-sends/validate",
    operationId: "validateBulkSend",
    tag: "Envío masivo",
    summary: "Validar filas sin crear nada",
    description:
      "Mismo cuerpo que POST /v1/bulk-sends. Cada fila se valida como un POST /v1/envelopes/from-template (roles, contactos, prefill). CSV con coma, punto y coma o tabulador (el que más aparece en el encabezado); alias de columna en español y portugués (nombre, correo, telefono, canales…). Columnas repetidas o una comilla sin cerrar → 422 invalid_csv. Cuerpo de hasta 12 MB y 5000 filas. Avisa (sin rechazar) filas repetidas (`duplicates`) y si las filas válidas superan el cupo del mes (`quotaRemaining`).",
    body: CreateBulkSendInput,
    response: BulkValidationResultSchema,
    errors: ["template_empty", "invalid_csv", "no_rows", "too_many_rows", "plan_limit_bulk_send"],
  },
  {
    method: "post",
    path: "/v1/bulk-sends",
    operationId: "createBulkSend",
    tag: "Envío masivo",
    summary: "Lanzar un envío masivo",
    description:
      "Valida todas las filas antes de crear nada; con `skipInvalid: true` las inválidas quedan como failed y se envían las demás. Los sobres se crean y envían en segundo plano (un sobre por fila, de a 20), a nombre de quien lo lanza; cada uno lleva `bulkSendId` y `bulkRow` en metadata. Si las filas válidas superan los sobres que quedan en el cupo del mes, 402 plan_limit (no se crea nada); si el cupo se agota durante el envío, las filas que faltan quedan failed. Seguir el progreso con GET /v1/bulk-sends/{id}." +
      IDEMPOTENT_NOTE,
    body: CreateBulkSendInput,
    status: 201,
    response: BulkSendSchema,
    idempotent: true,
    errors: ["template_empty", "invalid_csv", "no_rows", "too_many_rows", "rows_invalid", "plan_limit_bulk_send", "plan_limit_envelopes"],
  },
  {
    method: "get",
    path: "/v1/bulk-sends",
    operationId: "listBulkSends",
    tag: "Envío masivo",
    summary: "Listar envíos masivos",
    description: "Los 100 más recientes. Sin envelopes:view_all, solo los que lanzó la credencial.",
    response: z.object({ items: z.array(BulkSendSchema) }),
  },
  {
    method: "get",
    path: "/v1/bulk-sends/{id}",
    operationId: "getBulkSend",
    tag: "Envío masivo",
    summary: "Estado y contadores",
    response: BulkSendSchema,
  },
  {
    method: "get",
    path: "/v1/bulk-sends/{id}/items",
    operationId: "listBulkSendItems",
    tag: "Envío masivo",
    summary: "Filas del envío",
    query: [
      { name: "status", description: "Estados separados por coma (pending, processing, sent, failed, cancelled)." },
      { name: "offset", description: "Filas a saltear (por defecto 0).", schema: { type: "integer", minimum: 0, default: 0 } },
      Q.limit(100, 500),
    ],
    response: z.object({ items: z.array(BulkSendItemSchema), total: z.number().int().describe("Total de filas que cumplen el filtro.") }),
  },
  {
    method: "get",
    path: "/v1/bulk-sends/{id}/results.csv",
    operationId: "downloadBulkSendResults",
    tag: "Envío masivo",
    summary: "Resultados en CSV",
    description: "Columnas row, status, envelopeId, recipients, error. UTF-8 con BOM.",
    response: "csv",
  },
  {
    method: "post",
    path: "/v1/bulk-sends/{id}/cancel",
    operationId: "cancelBulkSend",
    tag: "Envío masivo",
    summary: "Cancelar",
    description:
      "Las filas pendientes pasan a cancelled; los sobres ya enviados no se tocan. Lo hace quien lo lanzó o quien tiene envelopes:manage_all.",
    response: BulkSendSchema,
    errors: ["not_cancellable"],
  },
  {
    method: "post",
    path: "/v1/bulk-sends/{id}/retry-failed",
    operationId: "retryFailedBulkSendRows",
    tag: "Envío masivo",
    summary: "Reintentar las filas fallidas",
    description:
      "Vuelve a encolar las filas failed cuyos datos son válidos (las que fallaron por el cupo, la plantilla o un error interno); las de datos inválidos siguen failed y se corrigen en un envío nuevo. Mismos permisos que crear (envelopes:create y el plan con envío masivo); lo hace quien lo lanzó o quien tiene envelopes:manage_all. Si no entran en el cupo del mes, 402 plan_limit. Un envío cancelado no se reintenta (409 not_retryable).",
    response: BulkSendSchema,
    errors: ["nothing_to_retry", "plan_limit_bulk_send", "plan_limit_envelopes"],
  },

  // Formularios web
  {
    method: "get",
    path: "/v1/web-forms",
    operationId: "listWebForms",
    tag: "Formularios web",
    summary: "Listar formularios",
    description: "Solo los de plantillas que la credencial puede ver.",
    response: z.object({ items: z.array(WebFormSchema) }),
  },
  {
    method: "post",
    path: "/v1/web-forms",
    operationId: "createWebForm",
    tag: "Formularios web",
    summary: "Crear formulario",
    description:
      "Quien completa el formulario toma el rol `signerRoleId`: tiene que ser un rol signer del primer turno de la plantilla y sin destinatario fijo (si no, 400 invalid_role); los demás roles van en `fixedRecipients`. Un formulario `embeddable` no puede pedir código por correo (`requireOtp`): 400 invalid_form. Los sobres se crean a nombre de quien crea el formulario y cada envío del público crea y envía un sobre que cuenta para el cupo del plan. Topes: 60 sobres por hora por formulario y 100 por hora / 500 por día sumando todos los formularios de la organización (configurables por la plataforma; después, 429 form_rate_limited); el mismo correo desde la misma IP (en IPv6, el mismo /64) en el mismo formulario dentro de 10 minutos no crea otro sobre, salvo que el anterior se haya anulado o rechazado (429 form_recent_submission). Con `lockPrefill: true`, los campos de quien completa el formulario cubiertos por `prefill` quedan de solo lectura (por defecto son valores sugeridos que puede corregir).",
    body: WebFormInput,
    status: 201,
    response: WebFormSchema,
    errors: ["invalid_role", "invalid_form", "template_empty", "plan_limit_web_forms"],
  },
  { method: "get", path: "/v1/web-forms/{id}", operationId: "getWebForm", tag: "Formularios web", summary: "Detalle", response: WebFormSchema },
  {
    method: "patch",
    path: "/v1/web-forms/{id}",
    operationId: "updateWebForm",
    tag: "Formularios web",
    summary: "Modificar",
    description:
      "Lo hace quien lo creó o quien tiene envelopes:manage_all. La plantilla no se puede cambiar. Mismas reglas que al crear: el rol de quien completa tiene que ser signer, del primer turno y sin destinatario fijo (400 invalid_role); `embeddable` con `requireOtp` → 400 invalid_form. Exige formularios web en el plan (402), salvo para desactivarlo (`active: false`), así se puede apagar tras bajar de plan.",
    body: UpdateWebFormInput,
    response: WebFormSchema,
    errors: ["invalid_role", "invalid_form", "plan_limit_web_forms"],
  },
  {
    method: "delete",
    path: "/v1/web-forms/{id}",
    operationId: "deleteWebForm",
    tag: "Formularios web",
    summary: "Borrar",
    response: "none",
    status: 204,
  },
  {
    method: "get",
    path: "/v1/web-forms/{id}/envelopes",
    operationId: "listWebFormEnvelopes",
    tag: "Formularios web",
    summary: "Sobres creados desde el formulario",
    description: "Los 200 más recientes que la credencial puede ver.",
    response: z.object({
      items: z.array(
        z.object({
          id: z.string().uuid(),
          subject: z.string(),
          status: z.enum(ENVELOPE_STATUSES),
          createdAt: iso,
          completedAt: iso.nullable(),
          recipients: z.array(z.object({ name: z.string(), email: z.string().nullable(), status: z.string(), role: z.string() })),
        }),
      ),
    }),
  },

  {
    method: "get",
    path: "/v1/public/forms/{slug}",
    operationId: "getPublicWebForm",
    tag: "Formularios web",
    summary: "Formulario público (lo que ve quien entra al link)",
    description:
      "Sin autenticación (60 pedidos por minuto por IP). `available: false` con `unavailableReason` (inactive, expired, exhausted) si ya no recibe envíos. `formToken` va en el envío; `captchaSiteKey` (Cloudflare Turnstile), si viene, obliga a mandar `captchaToken`.",
    response: z.object({
      slug: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      organizationName: z.string(),
      branding: z.object({ primaryColor: z.string().nullable(), logoUrl: z.string().nullable() }).nullable(),
      available: z.boolean(),
      unavailableReason: z.enum(["inactive", "expired", "exhausted"]).nullable(),
      requireOtp: z.boolean(),
      collectPhone: z.boolean(),
      locale: z.enum(LOCALES),
      formToken: z.string().describe("Token anti-bots: se devuelve en el envío. Vale 2 horas y un solo envío; no se puede enviar antes de 2,5 s."),
      captchaSiteKey: z
        .string()
        .nullable()
        .describe(
          "Clave pública de Cloudflare Turnstile si la plataforma exige el desafío: el envío tiene que traer `captchaToken` (si no, 400 captcha_failed). null: sin desafío.",
        ),
    }),
    auth: "none",
  },
  {
    method: "post",
    path: "/v1/public/forms/{slug}/submit",
    operationId: "submitPublicWebForm",
    tag: "Formularios web",
    summary: "Completar el formulario público (crea y envía el sobre)",
    description:
      "Sin autenticación (10 pedidos por minuto por IP). Crea el sobre desde la plantilla, con quien completa como firmante, y devuelve la ruta de su página de firma. " +
      "Errores: 400 invalid_form_token (token vencido, ajeno o ya usado: pedir otro con GET y reenviar), phone_required, captcha_failed; 422 too_fast (antes de 2,5 s) o rejected (trampa anti-bots); " +
      "410 form_inactive / form_expired / form_exhausted / form_unavailable (ya no recibe envíos); 409 form_misconfigured (la plantilla cambió y el formulario ya no la completa); " +
      "429 form_recent_submission (el mismo correo desde la misma IP hace poco) o form_rate_limited (topes por formulario y por organización; sin Retry-After).",
    body: SubmitWebFormInput,
    status: 201,
    response: z.object({
      envelopeId: z.string().uuid(),
      signingPath: z.string().describe("Ruta relativa a la página de firma (con ?embed=1 si corresponde)."),
    }),
    auth: "none",
    errors: [
      "invalid_form_token",
      "phone_required",
      "captcha_failed",
      "too_fast",
      "form_inactive",
      "form_unavailable",
      "form_misconfigured",
      "form_recent_submission",
      "form_rate_limited",
    ],
  },

  // Cobros
  {
    method: "get",
    path: "/v1/payments/providers",
    operationId: "listPaymentProviders",
    tag: "Cobros",
    summary: "Proveedores de cobro y si están configurados",
    response: z.object({ items: z.array(PaymentProviderSchema) }),
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/payment",
    operationId: "getEnvelopePayment",
    tag: "Cobros",
    summary: "Cobro del sobre",
    response: PaymentStateSchema,
  },
  {
    method: "put",
    path: "/v1/envelopes/{id}/payment",
    operationId: "putEnvelopePayment",
    tag: "Cobros",
    summary: "Configurar el cobro (borrador)",
    description:
      "Uno por sobre (reemplaza el anterior). Paga un firmante: before_sign bloquea su firma hasta pagar; after_sign cobra después de firmar y el sobre se completa recién con el pago. Cambia el `updatedAt` del sobre (devuelto en `envelopeUpdatedAt`).",
    body: EnvelopePaymentInput,
    response: PaymentStateSchema,
    expectedUpdatedAt: true,
    errors: ["provider_not_configured", "payment_webhook_not_configured", "invalid_payer", "not_draft", "plan_limit_payments", "version_changed"],
  },
  {
    method: "delete",
    path: "/v1/envelopes/{id}/payment",
    operationId: "deleteEnvelopePayment",
    tag: "Cobros",
    summary: "Quitar el cobro (borrador)",
    description: "Responde el estado sin cobro y el `envelopeUpdatedAt` nuevo (si había cobro, cambia el `updatedAt` del sobre).",
    response: PaymentStateSchema,
    expectedUpdatedAt: true,
    errors: ["not_draft", "plan_limit_payments", "version_changed"],
  },

  // Firmante
  {
    method: "get",
    path: "/v1/signing/{token}",
    operationId: "getSigningSession",
    tag: "Firmante",
    summary: "Sesión de firma (token del link)",
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/consent",
    operationId: "consentSigning",
    tag: "Firmante",
    summary: "Aceptar el uso de medios electrónicos",
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/complete",
    operationId: "completeSigning",
    tag: "Firmante",
    summary: "Completar y firmar",
    description:
      "`signature.kind`: drawn (dibujada, también en el celular con `handoffId`), typed (escrita) o uploaded (importada de una imagen). La imagen es un PNG de hasta 700 KB con trazo visible (400 invalid_image, blank_signature). Con `handoffId`, la imagen tiene que ser la que llegó del celular por ese pase (400 invalid_handoff).",
    body: CompleteSigningInput,
    auth: "token",
    errors: ["payment_required", "identity_required", "invalid_handoff"],
  },
  {
    method: "post",
    path: "/v1/signing/{token}/decline",
    operationId: "declineSigning",
    tag: "Firmante",
    summary: "Rechazar",
    body: DeclineInput,
    auth: "token",
  },
  {
    method: "get",
    path: "/v1/signing/{token}/signed.pdf",
    operationId: "downloadSigningSignedPdf",
    tag: "Firmante",
    summary: "PDF final (si el sobre está completo)",
    response: "pdf",
    auth: "token",
  },
  {
    method: "get",
    path: "/v1/signing/{token}/copy.pdf",
    operationId: "downloadSigningCopyPdf",
    tag: "Firmante",
    summary: "Copia en curso con lo firmado hasta ahora",
    description:
      "Para quien ya firmó (o recibe copia) mientras el sobre sigue en curso: los documentos con los campos completados hasta ahora, marcados como copia en curso, sin certificado ni sello. Cuando el sobre se completa, usar signed.pdf.",
    response: "pdf",
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/request-copy",
    operationId: "requestSigningCopy",
    tag: "Firmante",
    summary: "Pedir de nuevo el documento final (máx. una vez cada 10 minutos)",
    auth: "token",
    response: z.object({ queued: z.literal(true), recipientId: z.string().uuid() }),
  },
  {
    method: "get",
    path: "/v1/signing/{token}/documents/{documentId}/file",
    operationId: "downloadSigningDocument",
    tag: "Firmante",
    summary: "PDF de un documento del sobre (para el visor)",
    description:
      "Exige haber validado el código OTP si el firmante lo tiene (401 otp_required) y la verificación de identidad pendiente (403 identity_required). Si el sobre se anuló o venció, 410 envelope_closed.",
    response: "pdf",
    auth: "token",
    errors: ["identity_required", "envelope_closed"],
  },
  {
    method: "post",
    path: "/v1/signing/{token}/otp/send",
    operationId: "sendSigningOtp",
    tag: "Firmante",
    summary: "Enviar el código de verificación (OTP) al firmante",
    description:
      "Por correo, SMS o WhatsApp según el método del destinatario. Errores: 409 otp_not_required, otp_no_destination, otp_destination_suppressed; 410 envelope_closed; 429 otp_cooldown (details.resendInSeconds), otp_too_many, otp_daily_limit, otp_destination_limit, otp_tenant_limit; 502 otp_delivery_failed (reintentable en unos segundos).",
    response: z.object({
      sent: z.literal(true),
      destination: z.string().describe("Destino enmascarado."),
      resendInSeconds: z.number().int(),
      expiresAt: iso,
    }),
    auth: "token",
    errors: ["envelope_closed"],
  },
  {
    method: "post",
    path: "/v1/signing/{token}/otp/verify",
    operationId: "verifySigningOtp",
    tag: "Firmante",
    summary: "Validar el código de verificación",
    description:
      "Errores: 400 invalid_code (details con los intentos que quedan), otp_expired (vencido, inexistente o ya usado: pedir otro); 429 otp_locked (demasiados intentos).",
    body: OtpVerifyInput,
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/fields/{fieldId}/attachment",
    operationId: "uploadSigningAttachment",
    tag: "Firmante",
    summary: "Subir el archivo de un campo adjunto",
    description:
      "PDF, JPG o PNG de hasta 10 MB (400 invalid_attachment si no). Solo el firmante al que le toca y que ya aceptó el uso de medios electrónicos (409 not_signable, not_your_turn, consent_required); 410 envelope_closed. Devuelve el campo.",
    multipart: true,
    fileDescription: "PDF, JPG o PNG (máx. 10 MB).",
    auth: "token",
    errors: ["envelope_closed"],
  },
  {
    method: "delete",
    path: "/v1/signing/{token}/fields/{fieldId}/attachment",
    operationId: "deleteSigningAttachment",
    tag: "Firmante",
    summary: "Quitar el archivo de un campo adjunto",
    description: "Mismas condiciones que al subirlo. Devuelve el campo.",
    auth: "token",
    errors: ["envelope_closed"],
  },
  {
    method: "post",
    path: "/v1/signing/{token}/delegate",
    operationId: "delegateSigning",
    tag: "Firmante",
    summary: "Delegar en otra persona",
    description:
      "El nuevo destinatario hereda rol, campos y requisitos, y recibe la invitación; el link actual queda revocado. 403 forbidden si el remitente no permite delegar, si el firmante es embebido o si no validó su correo; 409 same_person (el mismo correo), not_replaceable, too_many_replacements o delegation_requires_id_match (el firmante debe firmar con un certificado que corresponda a su documento: hay que indicar idDocumentNumber de la persona nueva, y opcionalmente idDocumentType, que no se hereda del original; el control se mantiene); 410 envelope_closed. 10 pedidos por minuto.",
    body: DelegateInput,
    response: z.object({ delegated: z.literal(true), to: z.string().describe("Nombre de la persona en la que se delegó.") }),
    auth: "token",
    errors: ["same_person", "not_replaceable", "too_many_replacements", "delegation_requires_id_match", "envelope_closed"],
  },
  {
    method: "get",
    path: "/v1/signing/{token}/identity",
    operationId: "getSigningIdentity",
    tag: "Firmante",
    summary: "Estado de la verificación de identidad del firmante",
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/identity/start",
    operationId: "startSigningIdentity",
    tag: "Firmante",
    summary: "Iniciar la verificación de identidad",
    description: "Abre la sesión con el proveedor configurado (o la captura propia). 409 not_signable si ya no puede firmar; 410 envelope_closed.",
    auth: "token",
    errors: ["envelope_closed"],
  },
  {
    method: "post",
    path: "/v1/signing/{token}/identity/captures/{kind}",
    operationId: "uploadSigningIdentityCapture",
    tag: "Firmante",
    summary: "Subir una foto de la verificación propia (documento o selfie)",
    description:
      "JPG o PNG de hasta 8 MB (400 invalid_image). 400 invalid_capture si `kind` no corresponde al nivel pedido; 409 no_active_capture sin verificación iniciada.",
    multipart: true,
    fileDescription: "Foto JPG o PNG (máx. 8 MB).",
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/identity/submit",
    operationId: "submitSigningIdentity",
    tag: "Firmante",
    summary: "Enviar la verificación de identidad",
    description: "409 no_active_verification sin verificación en curso; 422 captures_incomplete (details.missing) si faltan fotos.",
    auth: "token",
  },
  {
    method: "get",
    path: "/v1/signing/{token}/payment",
    operationId: "getSigningPayment",
    tag: "Firmante",
    summary: "Cobro que tiene que pagar el firmante",
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/payment/checkout",
    operationId: "startSigningPaymentCheckout",
    tag: "Firmante",
    summary: "Iniciar (o retomar) el pago",
    description:
      "Devuelve la URL del checkout del proveedor. 409 already_paid, payment_not_available (after_sign antes de firmar o sobre cerrado) o payment_processing; 502 payment_provider_error. 20 pedidos por minuto.",
    response: z.object({ url: z.string() }),
    auth: "token",
  },
  {
    method: "get",
    path: "/v1/signing/{token}/embed",
    operationId: "getSigningEmbedInfo",
    tag: "Firmante",
    summary: "Si la página de firma se muestra en modo embebido (y para qué orígenes)",
    auth: "token",
  },

  // Firma dibujada en el celular (pase de firma)
  {
    method: "post",
    path: "/v1/signing/{token}/signature-handoffs",
    operationId: "createSignatureHandoff",
    tag: "Firmante",
    summary: "Pedir un link para dibujar la firma en el celular",
    description:
      "Crea un pase de un solo uso que vence a los 10 minutos, atado a este destinatario y sobre, y devuelve la URL corta (/h/<token>) para abrir en el celular; un pase nuevo deja sin efecto los anteriores sin usar. Mismas guardas que completar la firma (código OTP, identidad, consentimiento, turno; 409 consent_required, not_your_turn, not_signable; 410 envelope_closed). Con `channel` además manda el link (ver …/send). La firma se adopta después desde esta sesión: POST …/complete con `signature.handoffId`. 429 handoff_too_many (20 por hora).",
    body: CreateSignatureHandoffInput,
    response: z.object({
      id: z.string().uuid(),
      url: z.string().describe("URL para abrir en el celular: lleva el secreto del pase."),
      purpose: z.enum(["signature", "initials"]),
      expiresAt: iso,
      channels: z.array(z.enum(HANDOFF_CHANNELS)).describe("Canales por los que se puede mandar el link (Telegram, solo con el chat vinculado)."),
      sent: z.object({ channel: z.enum(HANDOFF_CHANNELS), destination: z.string(), resendInSeconds: z.number().int() }).nullable(),
    }),
    auth: "token",
    errors: [
      "envelope_closed",
      "handoff_too_many",
      "handoff_channel_unavailable",
      "handoff_cooldown",
      "handoff_send_limit",
      "handoff_destination_limit",
      "handoff_delivery_failed",
    ],
  },
  {
    method: "post",
    path: "/v1/signing/{token}/signature-handoffs/{id}/send",
    operationId: "sendSignatureHandoff",
    tag: "Firmante",
    summary: "Mandar el link del pase por SMS, WhatsApp o Telegram",
    description:
      "SMS y WhatsApp al teléfono indicado; Telegram, al chat que el firmante ya vinculó (409 handoff_channel_unavailable si no lo vinculó o el canal no está configurado: copiar el link). Espera de 30 s entre envíos y topes por destinatario (5 por hora, 10 por día) y por destino (los del código OTP): 429 handoff_cooldown (details.resendInSeconds), handoff_send_limit, handoff_destination_limit; 502 handoff_delivery_failed; 410 handoff_expired si el pase venció o ya se usó.",
    body: SendSignatureHandoffInput,
    auth: "token",
    errors: [
      "handoff_channel_unavailable",
      "handoff_cooldown",
      "handoff_send_limit",
      "handoff_destination_limit",
      "handoff_delivery_failed",
      "handoff_expired",
    ],
  },
  {
    method: "get",
    path: "/v1/signing/{token}/signature-handoffs/{id}",
    operationId: "getSignatureHandoff",
    tag: "Firmante",
    summary: "Estado del pase (la computadora espera la firma del celular)",
    description:
      "status pending, submitted (con `imagePng`, el PNG en base64 que llegó del celular) o expired. Un pase de otro destinatario o sobre da 404.",
    response: z.object({
      id: z.string().uuid(),
      status: z.enum(["pending", "submitted", "expired"]),
      expiresAt: iso,
      imagePng: z.string().nullable(),
    }),
    auth: "token",
  },
  {
    method: "get",
    path: "/v1/public/signature-handoffs/{token}",
    operationId: "getPublicSignatureHandoff",
    tag: "Firmante",
    summary: "Página del celular: datos del pase",
    description:
      "Sin datos del sobre ni del firmante: para qué es (firma o iniciales), vencimiento e idioma. 404 si el link no existe; 409 handoff_used; 410 handoff_expired.",
    response: z.object({ purpose: z.enum(["signature", "initials"]), expiresAt: iso, locale: z.enum(LOCALES) }),
    auth: "none",
    errors: ["handoff_used", "handoff_expired"],
  },
  {
    method: "post",
    path: "/v1/public/signature-handoffs/{token}",
    operationId: "submitPublicSignatureHandoff",
    tag: "Firmante",
    summary: "Página del celular: enviar la firma dibujada",
    description:
      "PNG en base64 con el mismo criterio que una firma dibujada (hasta 700 KB, 400 invalid_image; sin trazo, 400 blank_signature). Una sola vez por pase (409 handoff_used); la evidencia del sobre registra la IP y el navegador del celular. 20 pedidos por minuto por IP.",
    body: SubmitSignatureHandoffInput,
    response: z.object({ submitted: z.literal(true) }),
    auth: "none",
    errors: ["handoff_used", "handoff_expired"],
  },

  // Firma en persona
  {
    method: "post",
    path: "/v1/envelopes/{id}/recipients/{recipientId}/in-person",
    operationId: "openInPersonSigning",
    tag: "Firma en persona",
    summary: "Abrir la firma en persona en el dispositivo del anfitrión",
    errors: ["not_in_progress"],
    description:
      "La abre un usuario de la organización (sesión web; una API key recibe 403). Devuelve la ruta de la página del firmante y deja la sesión del firmante como cookie en ese navegador (1 h).",
    response: z.object({ url: z.string(), expiresAt: iso }),
  },
  {
    method: "post",
    path: "/v1/signing/{token}/in-person/confirm",
    operationId: "confirmInPersonSigning",
    tag: "Firma en persona",
    summary: "El firmante confirma su identidad en el dispositivo",
    body: InPersonConfirmInput,
    auth: "token",
  },
  {
    method: "post",
    path: "/v1/signing/{token}/in-person/end",
    operationId: "endInPersonSigning",
    tag: "Firma en persona",
    summary: "Cerrar la sesión en persona (el dispositivo vuelve al anfitrión)",
    auth: "token",
  },

  // Reportes
  {
    method: "get",
    path: "/v1/reports/summary",
    operationId: "getReportsSummary",
    tag: "Reportes",
    summary: "Resumen de actividad",
    description:
      "Totales, sobres por mes, remitentes y notificaciones por canal. Los meses de `byMonth` son meses calendario en `tz` (UTC por defecto). Exige envelopes:view_all.",
    query: [Q.from, Q.to, { ...Q.tz, description: `Zona de los meses de byMonth. ${Q.tz.description}` }],
    response: ReportsSummarySchema,
    errors: ["invalid_range"],
  },
  {
    method: "get",
    path: "/v1/reports/envelopes.csv",
    operationId: "exportEnvelopesCsv",
    tag: "Reportes",
    summary: "Exportar sobres a CSV",
    description:
      "UTF-8 con BOM; las celdas que empiezan con = + - @ se prefijan con ' (contra inyección de fórmulas). Hasta 50.000 sobres (los más recientes del rango): si hay más, header `X-Truncated: true` y una fila final TRUNCADO. Las fechas van en ISO UTC; con `tz` se agregan columnas *_local en esa zona y el header `X-Time-Zone` dice cuál se usó (UTC si `tz` no se reconoce). La exportación queda en la auditoría (reports.exported). Exige envelopes:view_all.",
    query: [
      Q.from,
      Q.to,
      Q.sep,
      { ...Q.tz, description: `Agrega las columnas creado_local, enviado_local, completado_local y vence_local. ${Q.tz.description}` },
    ],
    response: "csv",
    errors: ["invalid_range", "invalid_query"],
  },

  // Organización
  {
    method: "get",
    path: "/v1/settings/organization",
    operationId: "getOrganizationSettings",
    tag: "Organización",
    summary: "Ajustes generales de la organización: el huso horario de las horas del certificado y de la fecha de firma",
  },
  {
    method: "patch",
    path: "/v1/settings/organization",
    operationId: "updateOrganizationSettings",
    tag: "Organización",
    summary: "Cambiar el huso horario (IANA, p. ej. America/Argentina/Buenos_Aires); se aplica a los sobres que se completen después",
    body: UpdateOrganizationSettingsInput,
  },

  // Evidencia
  {
    method: "get",
    path: "/v1/public/trust-certificates",
    operationId: "listTrustCertificates",
    tag: "Evidencia",
    summary:
      "Certificados de las autoridades de CalaSign (raíz e intermedias del sello), para confiar en sus firmas en Adobe Acrobat u otro validador",
    auth: "none",
  },
  {
    method: "get",
    path: "/v1/public/trust-certificates/{file}",
    operationId: "downloadTrustCertificate",
    tag: "Evidencia",
    summary: "Descargar un certificado de autoridad: `{sha256}.cer` (DER, el que importa Acrobat) o `{sha256}.pem`",
    auth: "none",
    response: "none",
    errors: ["not_found"],
  },
  {
    method: "get",
    path: "/v1/settings/evidence",
    operationId: "getEvidenceSettings",
    tag: "Evidencia",
    summary: "Nivel PAdES de la organización y el que se aplica hoy",
  },
  {
    method: "patch",
    path: "/v1/settings/evidence",
    operationId: "updateEvidenceSettings",
    tag: "Evidencia",
    summary: "Elegir nivel PAdES (auto, B-B, B-T, B-LT, B-LTA)",
    body: UpdateEvidenceSettingsInput,
  },
  {
    method: "get",
    path: "/v1/certificates",
    operationId: "listCertificates",
    tag: "Evidencia",
    summary: "Listar certificados de la organización (sin material de clave)",
  },
  {
    method: "post",
    path: "/v1/certificates",
    operationId: "uploadCertificate",
    tag: "Evidencia",
    summary: "Subir un .p12/.pfx (base64 + contraseña)",
    description: "La clave privada se guarda cifrada (cifrado de sobre con KMS o clave local) y nunca se devuelve. Solo RSA.",
    body: UploadCertificateInput,
    status: 201,
  },
  {
    method: "delete",
    path: "/v1/certificates/{id}",
    operationId: "deleteCertificate",
    tag: "Evidencia",
    summary: "Eliminar certificado (borra el material de clave)",
    description: "Si es el sello de empresa de sobres que se están finalizando, 409 certificate_in_use (esperar a que terminen).",
    response: "none",
    status: 204,
    errors: ["certificate_in_use"],
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/seal-options",
    operationId: "getSealOptions",
    tag: "Evidencia",
    summary: "Sello de empresa y nivel de firma del sobre",
    response: SealOptionsSchema,
  },
  {
    method: "put",
    path: "/v1/envelopes/{id}/seal-options",
    operationId: "putSealOptions",
    tag: "Evidencia",
    summary: "Elegir sello de empresa (certificado) y nivel de firma declarado",
    description: "Cambia el `updatedAt` del sobre (devuelto en `envelopeUpdatedAt`).",
    body: SealOptionsInput,
    response: SealOptionsSchema,
    expectedUpdatedAt: true,
    errors: ["not_editable", "version_changed"],
  },
  {
    method: "post",
    path: "/v1/validate",
    operationId: "validatePdfSignatures",
    tag: "Evidencia",
    summary: "Validar las firmas de un PDF (público)",
    description:
      'Por firma: integridad, cobertura, sello de tiempo, cadena hasta raíces de confianza, revocación (DSS u online) y nivel PAdES. Sirve para cualquier PDF firmado. `chain.revocationUnknown` (y `summary.revocationUnknown`) indica que de algún certificado que no es la raíz no se pudo saber si estaba revocado (sin OCSP/CRL en el PDF ni consulta online, o un OCSP que respondió "unknown"). `weakAlgorithm` (con `weakAlgorithmReasons`) marca una firma o sello con algoritmos débiles (resumen SHA-1/MD5 en la firma, el sello de tiempo o un certificado que no es la raíz, o clave RSA de menos de 2048 bits): puede verificar, pero no cuenta para `summary.allValid` ni `summary.allTrusted`; `summary.anyWeakAlgorithm` indica si alguna lo tiene. `warnings` (solo si hay) lista lo que no se pudo comprobar sin invalidar la firma (p. ej. un signingCertificateV2 con un resumen no soportado, como SHA-224 o SHA-3).',
    multipart: true,
    fileDescription: "PDF firmado.",
    auth: "none",
    errors: ["not_pdf", "unreadable_pdf"],
  },
  {
    method: "post",
    path: "/v1/verify",
    operationId: "verifyPdf",
    tag: "Evidencia",
    summary: "Verificar si un PDF es un documento final de CalaSign (público)",
    description:
      "Compara el SHA-256 del archivo completo con los PDF finales sellados (incluidas versiones anteriores a una renovación de archivo). Cualquier cambio en el archivo da match: false. Solo devuelve lo que ya figura en el certificado de finalización. 20 pedidos por minuto por IP.",
    multipart: true,
    fileDescription: "PDF a verificar (hasta 40 MB o el máximo de subida, el mayor).",
    response: VerifyResponseSchema,
    auth: "none",
  },
  {
    method: "get",
    path: "/v1/signature-providers",
    operationId: "listSignatureProviders",
    tag: "Evidencia",
    summary: "Conectores de firma (plataforma, CSC v2, CA de Calasign)",
  },
  {
    method: "post",
    path: "/v1/signature-providers/{id}/test",
    operationId: "testSignatureProvider",
    tag: "Evidencia",
    summary:
      "Probar un conector CSC (firma un hash de prueba; devuelve si funcionó y el titular, sin credenciales; hasta 5 por hora por organización, una a la vez)",
    errors: ["provider_test_limit", "provider_test_in_progress"],
  },

  // Firma XML
  {
    method: "post",
    path: "/v1/xml/sign",
    operationId: "signXml",
    tag: "Firma XML",
    summary: "Firmar XML (DGII e-CF, DIAN, SUNAT CPE, XAdES-BES/EPES)",
    description:
      "Firma enveloped con el certificado de la organización. Perfiles: dgii-ecf (XMLDSig, C14N inclusiva), dian-fe (XAdES-EPES con política DIAN v2, dentro de ext:ExtensionContent), xades-bes, xades-epes (requiere policy). Devuelve el XML firmado y su verificación. Firmar en nombre de la empresa pide el permiso `settings:manage` (OAuth: scope `settings:write`).",
    body: XmlSignInput,
    errors: ["xml_sign_failed"],
  },
  {
    method: "post",
    path: "/v1/xml/verify",
    operationId: "verifyXml",
    tag: "Firma XML",
    summary: "Verificar una firma XML (digests, SignatureValue, SigningCertificate)",
    body: XmlVerifyInput,
  },

  // Marca
  {
    method: "get",
    path: "/v1/settings/branding",
    operationId: "getBranding",
    tag: "Marca",
    summary: "Marca de la organización",
    response: BrandingSchema,
  },
  {
    method: "patch",
    path: "/v1/settings/branding",
    operationId: "updateBranding",
    tag: "Marca",
    summary: "Cambiar color y pie de correo",
    description: "Se aplica en la página del firmante, los correos y el certificado de finalización. null quita el valor.",
    body: UpdateBrandingInput,
    response: BrandingSchema,
    errors: ["plan_limit_branding"],
  },
  {
    method: "post",
    path: "/v1/settings/branding/logo",
    operationId: "uploadBrandingLogo",
    tag: "Marca",
    summary: "Subir el logo",
    description:
      "multipart/form-data, campo `file`: PNG, JPG o SVG de hasta 200 KB (el tipo se detecta por el contenido). Un SVG con scripts o referencias externas se rechaza. El certificado de finalización usa el logo solo si es PNG o JPG.",
    multipart: true,
    fileDescription: "PNG, JPG o SVG (máx. 200 KB).",
    response: BrandingSchema,
    errors: ["invalid_logo", "plan_limit_branding"],
  },
  {
    method: "delete",
    path: "/v1/settings/branding/logo",
    operationId: "deleteBrandingLogo",
    tag: "Marca",
    summary: "Quitar el logo",
    response: BrandingSchema,
  },

  // Verificación de identidad
  {
    method: "get",
    path: "/v1/settings/identity",
    operationId: "getIdentitySettings",
    tag: "Verificación de identidad",
    summary: "Configuración de verificación de identidad",
    response: IdentitySettingsSchema,
  },
  {
    method: "patch",
    path: "/v1/settings/identity",
    operationId: "updateIdentitySettings",
    tag: "Verificación de identidad",
    summary: "Cambiar proveedor y nivel por defecto, umbral de nombre e intentos",
    description:
      "`mock` configura el proveedor de prueba, que en producción no se ofrece (providers[].configured = false). Para exigir la verificación a un firmante, usar `idVerification` en PUT /v1/envelopes/{id}/recipients.",
    body: IdentitySettingsInput,
    response: IdentitySettingsSchema,
    errors: ["identity_provider_unavailable"],
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/recipients/{recipientId}/identity",
    operationId: "getRecipientIdentity",
    tag: "Verificación de identidad",
    summary: "Estado e intentos de verificación de un destinatario",
    description: "Sin imágenes ni el número de documento completo.",
    response: RecipientIdentityDetailSchema,
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/recipients/{recipientId}/identity/reset",
    operationId: "resetRecipientIdentity",
    tag: "Verificación de identidad",
    summary: "Reiniciar la verificación de identidad de un destinatario",
    description:
      "Anula sus verificaciones anteriores (aprobada, fallidas o en curso) y le devuelve todos los intentos: tiene que verificarse de nuevo antes de ver los documentos. Solo en un sobre en curso y para un destinatario que todavía no firmó. Con `provider` y/o `level` cambia además el proveedor o el nivel (mismas reglas que al armar el sobre). Si el proveedor no puede hacer el nivel actual y no se cambia, 409 identity_level_not_supported. Queda en la evidencia (recipient.identity_reset).",
    body: z.object({ provider: z.enum(IDV_PROVIDERS).optional(), level: z.enum(IDV_LEVELS).optional() }),
    response: RecipientIdentityDetailSchema,
    errors: ["not_in_progress", "identity_not_required", "recipient_immutable", "identity_level_not_supported", "identity_provider_unavailable"],
  },

  // Auditoría
  {
    method: "get",
    path: "/v1/audit-log",
    operationId: "listAuditLog",
    tag: "Auditoría",
    summary: "Registro de auditoría de la cuenta",
    description:
      "Acciones administrativas (API keys, webhooks, miembros, roles, ajustes, ingresos…), de la más nueva a la más vieja. Exige audit:view.",
    query: [...AUDIT_QUERY, Q.cursor, Q.limit(50, 200)],
    response: z.object({ items: z.array(AuditLogEntrySchema), nextCursor: z.string().nullable() }),
    errors: ["invalid_query", "invalid_cursor"],
  },
  {
    method: "get",
    path: "/v1/audit-log.csv",
    operationId: "exportAuditLogCsv",
    tag: "Auditoría",
    summary: "Exportar la auditoría a CSV",
    description:
      "Mismos filtros que el listado, de la más nueva a la más vieja (occurred_at y id), hasta 50.000 filas (si hay más, headers `X-Truncated: true` y `X-Next-Before-Id`, y una fila final TRUNCADO: el resto se pide con los mismos filtros y `beforeId`). occurred_at en ISO UTC; con `tz` se agrega occurred_at_local y el header `X-Time-Zone` dice la zona usada (UTC si `tz` no se reconoce). La exportación misma queda registrada (audit.exported).",
    query: [
      ...AUDIT_QUERY,
      Q.sep,
      { ...Q.tz, description: `Agrega la columna occurred_at_local. ${Q.tz.description}` },
      {
        name: "beforeId",
        description:
          "Continuar un export truncado: solo las filas anteriores a la fila con este id (el de `X-Next-Before-Id`), sin saltear ni repetir.",
        schema: { type: "string" },
      },
    ],
    response: "csv",
    errors: ["invalid_query"],
  },

  // Equipo
  {
    method: "get",
    path: "/v1/me/access",
    operationId: "getMyAccess",
    tag: "Equipo",
    summary: "Rol, permisos y grupos de la credencial",
    response: AccessSchema,
  },
  {
    method: "get",
    path: "/v1/members",
    operationId: "listMembers",
    tag: "Equipo",
    summary: "Miembros de la organización",
    response: z.object({ items: z.array(MemberSchema) }),
  },
  {
    method: "patch",
    path: "/v1/members/{userId}",
    operationId: "updateMemberRole",
    tag: "Equipo",
    summary: "Cambiar el rol de un miembro",
    description: "No se otorgan permisos que quien lo hace no tiene; solo un propietario cambia a otro propietario.",
    body: RoleAssignment,
    response: z.object({ ok: z.literal(true) }),
    errors: ["invalid_role", "last_owner", "member_changed"],
  },
  {
    method: "delete",
    path: "/v1/members/{userId}",
    operationId: "removeMember",
    tag: "Equipo",
    summary: "Quitar un miembro",
    description: "Lo saca de sus grupos y cierra sus sesiones en la organización.",
    response: "none",
    status: 204,
    errors: ["last_owner", "member_changed"],
  },
  {
    method: "get",
    path: "/v1/invitations",
    operationId: "listInvitations",
    tag: "Equipo",
    summary: "Invitaciones (las 200 más recientes)",
    response: z.object({ items: z.array(InvitationSchema) }),
  },
  {
    method: "post",
    path: "/v1/invitations",
    operationId: "createInvitation",
    tag: "Equipo",
    summary: "Invitar a una persona",
    description: "Envía el correo y devuelve el link de aceptación (vence a los 7 días). Una invitación pendiente al mismo correo se reemplaza.",
    body: InviteMemberInput,
    status: 201,
    response: z.object({ invitation: InvitationSchema, acceptUrl: z.string().describe("Link de aceptación; se devuelve solo al crearla.") }),
    errors: ["invalid_role", "already_member", "plan_limit_users"],
  },
  {
    method: "delete",
    path: "/v1/invitations/{id}",
    operationId: "revokeInvitation",
    tag: "Equipo",
    summary: "Revocar una invitación pendiente",
    response: "none",
    status: 204,
  },
  {
    method: "get",
    path: "/v1/roles",
    operationId: "listRoles",
    tag: "Equipo",
    summary: "Roles personalizados y permisos de los integrados",
    response: z.object({
      items: z.array(CustomRoleSchema),
      builtin: z.array(z.object({ role: z.enum(["owner", "admin", "member"]), name: z.string(), permissions: z.array(z.string()) })),
    }),
  },
  {
    method: "post",
    path: "/v1/roles",
    operationId: "createRole",
    tag: "Equipo",
    summary: "Crear rol personalizado",
    body: CreateRoleInput,
    status: 201,
    response: CustomRoleSchema,
    errors: ["role_conflict"],
  },
  {
    method: "patch",
    path: "/v1/roles/{id}",
    operationId: "updateRole",
    tag: "Equipo",
    summary: "Modificar rol personalizado",
    body: UpdateRoleInput,
    response: CustomRoleSchema,
    errors: ["role_conflict"],
  },
  {
    method: "delete",
    path: "/v1/roles/{id}",
    operationId: "deleteRole",
    tag: "Equipo",
    summary: "Borrar rol personalizado (sin asignar)",
    response: "none",
    status: 204,
    errors: ["role_conflict"],
  },
  {
    method: "get",
    path: "/v1/groups",
    operationId: "listGroups",
    tag: "Equipo",
    summary: "Grupos",
    response: z.object({ items: z.array(GroupSchema) }),
  },
  { method: "get", path: "/v1/groups/{id}", operationId: "getGroup", tag: "Equipo", summary: "Detalle del grupo", response: GroupSchema },
  {
    method: "post",
    path: "/v1/groups",
    operationId: "createGroup",
    tag: "Equipo",
    summary: "Crear grupo",
    body: CreateGroupInput,
    status: 201,
    response: GroupSchema,
    errors: ["invalid_member", "role_conflict"],
  },
  {
    method: "patch",
    path: "/v1/groups/{id}",
    operationId: "updateGroup",
    tag: "Equipo",
    summary: "Modificar grupo",
    description:
      "`memberIds` reemplaza la lista. Sumar personas les da acceso a lo compartido con el grupo: lo hace un propietario, un miembro del grupo o quien tiene envelopes:view_all y templates:manage.",
    body: UpdateGroupInput,
    response: GroupSchema,
    errors: ["invalid_member", "role_conflict"],
  },
  { method: "delete", path: "/v1/groups/{id}", operationId: "deleteGroup", tag: "Equipo", summary: "Borrar grupo", response: "none", status: 204 },
  {
    method: "get",
    path: "/v1/envelopes/{id}/shares",
    operationId: "getEnvelopeShares",
    tag: "Equipo",
    summary: "Grupos con los que se comparte el sobre",
    response: SharesSchema,
  },
  {
    method: "put",
    path: "/v1/envelopes/{id}/shares",
    operationId: "putEnvelopeShares",
    tag: "Equipo",
    summary: "Compartir el sobre con grupos",
    description: "Reemplaza la lista. Los miembros de esos grupos pueden ver el sobre.",
    body: PutSharesInput,
    response: SharesSchema,
    errors: ["invalid_group"],
  },
  {
    method: "get",
    path: "/v1/templates/{id}/shares",
    operationId: "getTemplateShares",
    tag: "Equipo",
    summary: "Visibilidad y grupos de la plantilla",
    response: SharesSchema.extend({ visibility: z.enum(["organization", "restricted"]) }),
  },
  {
    method: "put",
    path: "/v1/templates/{id}/shares",
    operationId: "putTemplateShares",
    tag: "Equipo",
    summary: "Visibilidad de la plantilla y grupos",
    description:
      "restricted: la ven su creador, quien tiene templates:manage y los grupos de la lista. Cambiar la visibilidad cambia el `updatedAt` de la plantilla (devuelto en `templateUpdatedAt`).",
    body: PutTemplateSharesInput,
    response: SharesSchema.extend({ visibility: z.enum(["organization", "restricted"]), templateUpdatedAt: z.string().datetime() }),
    expectedUpdatedAt: true,
    errors: ["invalid_group", "version_changed"],
  },
  {
    method: "get",
    path: "/v1/api-keys/roles",
    operationId: "listApiKeyRoles",
    tag: "Equipo",
    summary: "Rol de cada API key",
    response: z.object({
      items: z.array(
        z.object({ id: z.string().uuid(), role: z.enum(["admin", "member", "custom"]), roleId: z.string().uuid().nullable(), roleName: z.string() }),
      ),
    }),
  },
  {
    method: "patch",
    path: "/v1/api-keys/{id}/role",
    operationId: "updateApiKeyRole",
    tag: "Equipo",
    summary: "Cambiar el rol de una API key",
    body: RoleAssignment,
    response: z.object({
      id: z.string().uuid(),
      role: z.enum(["admin", "member", "custom"]),
      roleId: z.string().uuid().nullable(),
      roleName: z.string(),
    }),
    errors: ["invalid_role"],
  },
  {
    method: "get",
    path: "/v1/settings/security",
    operationId: "getSecuritySettings",
    tag: "Equipo",
    summary: "Retención y 2FA obligatorio",
    response: z.object({ retentionDays: z.number().int().nullable(), require2fa: z.boolean() }),
  },
  {
    method: "patch",
    path: "/v1/settings/security",
    operationId: "updateSecuritySettings",
    tag: "Equipo",
    summary: "Cambiar retención y 2FA obligatorio",
    description:
      "retentionDays: días después de terminado un sobre (completado, anulado, rechazado o vencido) en que se borran los originales, las imágenes de firma, los adjuntos y las fotos de documentos de identidad (null = nunca). Se conservan el PDF firmado y la evidencia; pedir un original purgado responde 410 purged.",
    body: UpdateSecuritySettingsInput,
    response: z.object({ retentionDays: z.number().int().nullable(), require2fa: z.boolean() }),
    errors: ["enable_2fa_first"],
  },
];

// ───────── Ejemplos de respuesta ─────────

const EXAMPLE_IDS = {
  env: "0192f1c4-7a2b-7c3d-9e10-4b5a6c7d8e9f",
  doc: "0192f1c4-8b3c-7d4e-8f21-5c6b7d8e9fa0",
  rec: "0192f1c4-9c4d-7e5f-9032-6d7c8e9fa0b1",
  fld: "0192f1c4-ad5e-7f60-a143-7e8d9fa0b1c2",
  tenant: "0192e0a1-1111-7222-8333-944455566677",
};

const EXAMPLES: Record<string, unknown> = {
  EnvelopeDetail: {
    envelope: {
      id: EXAMPLE_IDS.env,
      subject: "Contrato de servicios 2026",
      message: "Hola Ana, te envío el contrato para firmar.",
      locale: "es",
      status: "sent",
      createdVia: "api",
      createdAt: "2026-10-01T14:03:11.204Z",
      updatedAt: "2026-10-01T14:05:42.918Z",
      sentAt: "2026-10-01T14:05:42.918Z",
      completedAt: null,
      voidedAt: null,
      voidReason: null,
      expiresAt: "2026-10-31T14:03:11.204Z",
      metadata: { orderId: "PED-1042" },
      signedSha256: null,
      reminderEveryDays: 3,
      expiryWarningDays: null,
      allowDelegation: true,
    },
    documents: [
      {
        id: EXAMPLE_IDS.doc,
        name: "contrato.pdf",
        position: 1,
        pageCount: 2,
        pages: [
          { width: 595.28, height: 841.89 },
          { width: 595.28, height: 841.89 },
        ],
        sha256: "9f2c4e0b7d1a3f5e8c6b2a4d0e9f7c1b3a5d7e9f0c2b4a6d8e0f1a3c5b7d9e1f",
        sizeBytes: 48211,
      },
    ],
    recipients: [
      {
        id: EXAMPLE_IDS.rec,
        role: "signer",
        routingOrder: 1,
        name: "Ana Pérez",
        email: "ana@example.com",
        phone: null,
        locale: null,
        channels: ["email"],
        telegramLinked: false,
        embedded: false,
        idDocumentType: null,
        idDocumentNumber: null,
        status: "sent",
        sentAt: "2026-10-01T14:05:42.918Z",
        viewedAt: null,
        signedAt: null,
        declinedAt: null,
        declineReason: null,
        authMethod: "link",
        replacedBy: null,
        inPersonHost: null,
        identity: null,
        signatureType: "electronic",
        certificateRequirements: null,
        certificateSignature: null,
      },
    ],
    fields: [
      {
        id: EXAMPLE_IDS.fld,
        documentId: EXAMPLE_IDS.doc,
        recipientId: EXAMPLE_IDS.rec,
        type: "signature",
        page: 1,
        x: 0.12,
        y: 0.78,
        width: 0.3,
        height: 0.06,
        required: true,
        label: null,
        value: null,
        readOnly: false,
        options: null,
        min: null,
        max: null,
        conditions: null,
        formula: null,
      },
    ],
  },
  Webhook: {
    id: "0192f1d0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
    url: "https://api.example.com/calasign/webhooks",
    description: "Producción",
    events: ["envelope.completed", "recipient.signed"],
    active: true,
    secretPrefix: "whsec_9Xk2Lp",
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
  },
  SigningUrl: { url: "https://app.calasign.com/embed/k3J9xQ2mV7pL1sT8wZ4nR6yB0cF5hD2a", expiresAt: "2026-10-01T14:10:42.918Z" },
  TokenResponse: { access_token: "csat_2Yx9…", token_type: "Bearer", expires_in: 3600, scope: "envelopes:read envelopes:write" },
  WebhookEvent: {
    id: "0192f1e5-3c4d-7e5f-8a6b-7c8d9e0f1a2b",
    type: "envelope.completed",
    createdAt: "2026-10-02T09:15:03.512Z",
    tenantId: EXAMPLE_IDS.tenant,
    data: {
      envelope: {
        id: EXAMPLE_IDS.env,
        subject: "Contrato de servicios 2026",
        status: "completed",
        metadata: { orderId: "PED-1042" },
        sentAt: "2026-10-01T14:05:42.918Z",
        completedAt: "2026-10-02T09:15:02.877Z",
        signedSha256: "4b1d9e7c2a0f8e6d4c2b0a9f7e5d3c1b9a8f6e4d2c0b9a7f5e3d1c9b7a5f3e1d",
        recipients: [{ id: EXAMPLE_IDS.rec, name: "Ana Pérez", email: "ana@example.com", role: "signer", status: "signed", routingOrder: 1 }],
      },
      recipientId: null,
      reason: null,
    },
  },
};

// ───────── Armado ─────────

/** Seguridad de una operación: API key, OAuth 2.0 (con el scope que exige la ruta) o sesión web. */
function securityFor(op: Op) {
  if (op.auth === "none" || op.auth === "token") return [];
  if (op.auth === "client") return [{ clientBasic: [] }, {}];
  const scope = requiredScope(op.path.replace(/\{(\w+)\}/g, ":$1"), op.method.toUpperCase());
  const oauth = scope === "deny" ? [] : [{ oauth2: scope ? [scope] : [] }];
  return [{ apiKey: [] }, ...oauth, { session: [] }];
}

function successResponse(op: Op) {
  const description = op.responseDescription ?? (op.status === 201 ? "Creado" : op.status === 202 ? "Aceptado" : "OK");
  const headers = op.idempotent ? { headers: { "Idempotent-Replay": { $ref: "#/components/headers/IdempotentReplay" } } } : {};
  if (op.response === "none") return { description: op.responseDescription ?? "Sin contenido" };
  if (op.response === "pdf") return { description: "PDF", content: { "application/pdf": { schema: { type: "string", format: "binary" } } } };
  if (op.response === "csv") {
    // Con `tz`, la zona usada en las columnas *_local (una desconocida cae a UTC).
    const tzHeader = op.query?.some((q) => q.name === "tz") ? { headers: { "X-Time-Zone": { $ref: "#/components/headers/TimeZone" } } } : {};
    return { description: "CSV (UTF-8 con BOM)", ...tzHeader, content: { "text/csv": { schema: { type: "string" } } } };
  }
  if (op.response === "html") return { description: "Página HTML", content: { "text/html": { schema: { type: "string" } } } };
  // Sin esquema declarado: objeto JSON (la operación todavía no tiene su esquema de respuesta documentado).
  return { description, ...headers, content: { "application/json": { schema: op.response ? js(op.response) : { type: "object" } } } };
}

/** JSON en application/json o, con archivos, en la parte `payload` de un multipart/form-data. */
function jsonOrMultipartBody(op: Op) {
  return {
    required: true,
    content: {
      "application/json": { schema: js(op.body!) },
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: {
            payload: { type: "string", description: "El mismo JSON que en application/json (los documentos citan sus archivos con `file`)." },
          },
          additionalProperties: { type: "string", format: "binary", description: op.multipartPayload },
          required: ["payload"],
        },
        encoding: { payload: { contentType: "application/json" } },
      },
    },
  };
}

function multipartBody(op: Op) {
  return {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          properties: { file: { type: "string", format: "binary", ...(op.fileDescription ? { description: op.fileDescription } : {}) } },
          required: ["file"],
        },
      },
    },
  };
}

export function buildOpenApi() {
  const all = [
    ...OPS,
    ...(PLATFORM_OPS as Op[]),
    ...(AI_OPS as unknown as Op[]),
    ...(AGREEMENTS_OPS as Op[]),
    ...(CRM_OPS as Op[]),
    ...LOWCODE_OPS,
    ...(CONNECTOR_OPS as Op[]),
    ...(DATA_OPS as unknown as Op[]),
    ...(CERTSIGN_OPS as unknown as Op[]),
    ...WHITE_LABEL_OPS,
    ...DEVAPI_OPS,
  ];
  const paths: Record<string, Record<string, unknown>> = {};
  const seenIds = new Set<string>();
  const usedTags = new Set<string>();
  for (const op0 of all) {
    const key = `${op0.method} ${op0.path}`;
    const extraDesc = EXTRA_DESCRIPTION[key];
    const op: Op = {
      ...op0,
      query: op0.query ?? EXTRA_QUERY[key],
      description: extraDesc === undefined ? op0.description : (extraDesc ?? undefined),
    };
    const operationId = op.operationId ?? autoOperationId(op.method, op.path);
    if (seenIds.has(operationId)) throw new Error(`OpenAPI: operationId repetido ${operationId}`);
    seenIds.add(operationId);
    usedTags.add(op.tag);

    const scope =
      op.auth === "none" || op.auth === "token" || op.auth === "client"
        ? null
        : requiredScope(op.path.replace(/\{(\w+)\}/g, ":$1"), op.method.toUpperCase());
    const params: unknown[] = [...pathParams(op.path), ...queryParams(op.query)];
    if (op.idempotent) params.push({ $ref: "#/components/parameters/IdempotencyKey" });
    if (op.expectedUpdatedAt) params.push({ $ref: "#/components/parameters/ExpectedUpdatedAt" });

    const entry: Record<string, unknown> = {
      operationId,
      tags: [op.tag],
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      ...(params.length ? { parameters: params } : {}),
      responses: { [String(op.status ?? 200)]: successResponse(op), ...errorResponses(op, scope === "deny") },
      security: securityFor(op),
    };
    if (op.body) entry.requestBody = { required: !op.bodyOptional, content: { "application/json": { schema: js(op.body) } } };
    if (op.form) entry.requestBody = { required: true, content: { "application/x-www-form-urlencoded": { schema: js(op.form) } } };
    if (op.multipart) entry.requestBody = multipartBody(op);
    if (op.multipartPayload && op.body) entry.requestBody = jsonOrMultipartBody(op);
    (paths[op.path] ??= {})[op.method] = entry;
  }

  const missing = [...usedTags].filter((t) => !TAGS.some(([n]) => n === t));
  if (missing.length) throw new Error(`OpenAPI: tags sin descripción: ${missing.join(", ")}`);
  const errors = errorComponents();

  return {
    openapi: "3.1.0",
    info: {
      title: "CalaSign API",
      version: "1.0.0",
      description:
        "Firma electrónica en la nube. Autenticación con `Authorization: Bearer <API key o access token OAuth>`. " +
        "Errores: `{ error: { code, message, details? } }` (ver components.schemas.Error); los de /oauth/* siguen RFC 6749. " +
        "Además de los de cada operación, cualquier ruta puede responder (components.responses): 400 invalid_text (texto con el carácter NUL), " +
        "403 bad_origin (pedido con la cookie de sesión desde otro origen), 421 wrong_cell (la organización está en otra región: repetir en details.baseUrl; header Location), " +
        "500 internal_error y 503 storage_unavailable (reintentable) o byok_key_unavailable (no reintentable: requiere que un administrador restablezca la clave BYOK). " +
        "Reintentables con espera creciente: 429 rate_limited (según Retry-After), 502 tsa_unavailable y ai_unavailable, 503 storage_unavailable, pdf_reader_busy, pdf_busy (con Retry-After) y ai_rate_limited, 504 ai_timeout; los 429 con código propio (reminded_recently, form_rate_limited…) no traen Retry-After y no se reintentan en un loop. " +
        "Nombres: cuerpos y respuestas JSON en camelCase. Los parámetros de query también, salvo los filtros de búsqueda de GET /v1/envelopes (created_from, sent_to, template_id, created_via…) y de GET /v1/events (envelope_id, max_seconds), en snake_case, y los de /oauth/* (RFC 6749). " +
        "Límite general: 600 pedidos por minuto por credencial (API key o token OAuth del header Authorization: Bearer) y, sin credencial, por IP (algunas rutas tienen uno menor, que con credencial cuenta por organización: todas las API keys y tokens de la organización comparten ese cupo); cada servidor de la API lleva su propia cuenta; cada respuesta trae X-RateLimit-Limit, X-RateLimit-Remaining y X-RateLimit-Reset, y un 429 trae Retry-After. " +
        'Webhooks firmados con `CalaSign-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` (ver la sección webhooks). ' +
        `Eventos: ${WEBHOOK_EVENT_TYPES.join(", ")}.`,
    },
    servers: [{ url: config.appUrl }],
    tags: TAGS.filter(([n]) => usedTags.has(n) || n === "Webhooks").map(([name, description]) => ({ name, description })),
    paths,
    webhooks: webhooksObject(),
    components: {
      schemas: componentSchemas(EXAMPLES),
      responses: errors.responses,
      parameters: {
        ...PATH_PARAMETERS,
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description:
            "Clave única del pedido (máx. 200 caracteres), por credencial (API key, app OAuth o usuario). Repetir el mismo pedido con la misma clave devuelve la respuesta guardada, con el mismo status y el header `Idempotent-Replay: true`. " +
            "La misma clave con otro método, URL o cuerpo → 409 idempotency_mismatch; mientras el primero sigue en curso → 409 idempotency_in_progress. Si el pedido falla, la clave se libera y se puede reintentar con ella.",
          schema: { type: "string", maxLength: 200 },
        },
        ExpectedUpdatedAt: {
          name: "X-Expected-Updated-At",
          in: "header",
          required: false,
          description:
            "Control de edición concurrente (opcional): el `updatedAt` del borrador, la plantilla o el sobre (al anular o recordar uno en curso) tal como se leyó (ISO 8601, con milisegundos). Si cambió desde entonces (otra pestaña u otra persona lo editó), 409 version_changed con el `updatedAt` actual en details, en vez de pisar esos cambios. Sin el encabezado (o con una fecha que no se puede leer) no se controla.",
          schema: { type: "string", format: "date-time" },
        },
      },
      headers: errors.headers,
      examples: errors.examples,
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "API key de la organización: `cs_live_…` en producción, `cs_test_…` en los demás entornos. Se crea con POST /v1/api-keys (requiere un plan con acceso por API).",
        },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-cs_session",
          description:
            "Sesión de la web (POST /v1/auth/login). Con HTTPS la cookie es __Host-cs_session; en local sin HTTPS, cs_session. No usar en integraciones.",
        },
        oauth2: OAUTH2_SECURITY_SCHEME,
        clientBasic: {
          type: "http",
          scheme: "basic",
          description: "client_id:client_secret de la app OAuth (o client_id/client_secret en el cuerpo).",
        },
      },
    },
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
