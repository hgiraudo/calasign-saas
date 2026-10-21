// Esquemas de salida del OpenAPI (espejo de los tipos TS de packages/shared y de los mappers de la API).
// Los que se registran con named() van a components.schemas y se referencian con $ref.
import { z, type ZodTypeAny, type ZodTypeDef } from "zod";
import {
  AUTH_METHODS,
  AnchorFieldInput,
  BULK_ITEM_STATUSES,
  BULK_SEND_STATUSES,
  BulkRowInput,
  CHANNELS,
  ENVELOPE_STATUSES,
  FIELD_TYPES,
  FieldCondition,
  FieldInput,
  IDV_LEVELS,
  IDV_PROVIDERS,
  IDV_STATUSES,
  LOCALES,
  MOCK_DECISIONS,
  PAYMENT_CURRENCIES,
  PAYMENT_METHOD_CODES,
  PAYMENT_PROVIDERS,
  PAYMENT_TIMINGS,
  PERMISSIONS,
  PLAN_FEATURES,
  PLAN_IDS,
  RECIPIENT_ROLES,
  RECIPIENT_STATUSES,
  RecipientInput,
  SIGNATURE_LEVELS,
  SIGNATURE_TYPES,
  ContractMetadataSchema,
  TemplateFieldInput,
  TemplateRecipientInput,
  WEBHOOK_EVENT_TYPES,
} from "@calasign/shared";

/** def de Zod → nombre en components.schemas. */
export const NAMED = new Map<ZodTypeDef, string>();
/** nombre → esquema, en el orden en que se registran. */
export const REGISTRY = new Map<string, ZodTypeAny>();

export function named<T extends ZodTypeAny>(name: string, schema: T): T {
  if (REGISTRY.has(name)) throw new Error(`esquema OpenAPI duplicado: ${name}`);
  NAMED.set(schema._def, name);
  REGISTRY.set(name, schema);
  return schema;
}

const iso = () => z.string().datetime();
const uuid = () => z.string().uuid();
const MEMBER_ROLES = ["owner", "admin", "member", "custom"] as const;

// ───────────────────────────── Errores ─────────────────────────────

export const ErrorSchema = named(
  "Error",
  z
    .object({
      error: z.object({
        code: z.string().describe("Código estable, en snake_case (p. ej. validation_error, not_found, plan_limit)."),
        message: z.string().describe("Mensaje legible, en español. No conviene parsearlo: usar `code`."),
        details: z.unknown().optional().describe("Datos adicionales según el código (p. ej. la lista de problemas de validación)."),
      }),
    })
    .describe("Error de la API. Todas las respuestas 4xx/5xx de /v1 usan este formato."),
);

// ───────────────────────────── Entradas reutilizadas ─────────────────────────────

named("RecipientInput", RecipientInput);
named("FieldInput", FieldInput);
named("AnchorFieldInput", AnchorFieldInput);
named("FieldCondition", FieldCondition);
named("TemplateRecipientInput", TemplateRecipientInput);
named("TemplateFieldInput", TemplateFieldInput);
named("BulkRowInput", BulkRowInput);

// ───────────────────────────── Sobres ─────────────────────────────

export const DocumentSchema = named(
  "Document",
  z.object({
    id: uuid(),
    name: z.string(),
    position: z.number().int().describe("Orden dentro del sobre (desde 1)."),
    pageCount: z.number().int(),
    pages: z.array(z.object({ width: z.number(), height: z.number() })).describe("Tamaño de cada página en puntos PDF (caja visible)."),
    sha256: z.string().describe("SHA-256 del PDF guardado (normalizado al subirlo)."),
    sizeBytes: z.number().int(),
  }),
);

/** Documento recién subido: lo de siempre más el aviso de firmas previas perdidas al sanear el PDF. */
export const UploadedDocumentSchema = named(
  "UploadedDocument",
  DocumentSchema.extend({
    hadSignatures: z
      .boolean()
      .describe(
        "El archivo subido traía firmas digitales. Al subirlo, el PDF se sanea (formularios aplanados, contenido activo y adjuntos eliminados) y esas firmas se pierden: ni la copia guardada ni el PDF final las conservan. Conviene avisarle a quien lo subió.",
      ),
    formAppearanceMismatch: z
      .boolean()
      .describe(
        "Aviso no bloqueante: el formulario del PDF pedía regenerar las apariencias de los campos (NeedAppearances) y alguna no se pudo regenerar (caracteres que la fuente estándar no admite, texto enriquecido). Se fijó la apariencia guardada en el archivo, que otro lector podría mostrar distinta: conviene revisar cómo quedó el documento antes de enviarlo.",
      ),
  }),
);

export const CertificateRequirementsSchema = named(
  "CertificateRequirements",
  z.object({
    matchIdDocument: z.boolean().describe("El certificado tiene que corresponder al documento declarado del firmante (false por defecto; solo rige si el destinatario tiene idDocumentNumber)."),
    allowedIssuers: z.array(z.string()).describe("Partes del DN del emisor permitidas. Vacío = cualquiera."),
    requireQualified: z.boolean().describe("Exige una CA del almacén de confianza de la plataforma."),
  }),
);

export const RecipientIdentitySchema = named(
  "RecipientIdentity",
  z.object({
    provider: z.enum(IDV_PROVIDERS),
    level: z.enum(IDV_LEVELS),
    status: z.enum(IDV_STATUSES),
    verifiedAt: iso().nullable(),
    failureReason: z.string().nullable(),
  }),
);

export const RecipientSchema = named(
  "Recipient",
  z.object({
    id: uuid(),
    role: z.enum(RECIPIENT_ROLES).describe("signer firma; approver aprueba sin firmar; cc recibe copia del documento final."),
    routingOrder: z.number().int().describe("Grupo de ruteo: se invita a cada grupo cuando termina el anterior."),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable().describe("E.164"),
    locale: z.enum(LOCALES).nullable(),
    channels: z.array(z.enum(CHANNELS)),
    telegramLinked: z.boolean().describe("true si ya vinculó su chat de Telegram."),
    embedded: z.boolean().describe("Firma embebida: no recibe invitaciones."),
    idDocumentType: z.string().nullable(),
    idDocumentNumber: z.string().nullable(),
    status: z.enum(RECIPIENT_STATUSES),
    sentAt: iso().nullable(),
    viewedAt: iso().nullable(),
    signedAt: iso().nullable(),
    declinedAt: iso().nullable(),
    declineReason: z.string().nullable(),
    authMethod: z.enum(AUTH_METHODS),
    replacedBy: uuid().nullable().describe("Si delegó o fue reasignado: id del destinatario que lo reemplaza."),
    inPersonHost: z.object({ id: uuid(), name: z.string() }).nullable().describe("Firma en persona: usuario anfitrión."),
    identity: RecipientIdentitySchema.nullable().describe("Verificación de identidad exigida y su estado (null si no se exige)."),
    signatureType: z.enum(SIGNATURE_TYPES),
    certificateRequirements: CertificateRequirementsSchema.nullable().describe("Solo con signatureType certificate."),
    certificateSignature: z
      .object({
        status: z.enum(["pending", "signed"]),
        position: z.number().int(),
        signedAt: iso().nullable(),
        commonName: z.string().nullable(),
        issuer: z.string().nullable(),
      })
      .nullable()
      .describe("Estado de su firma con certificado (cuando el sobre llegó a esa etapa)."),
  }),
);

export const FieldSchema = named(
  "Field",
  z.object({
    id: uuid(),
    documentId: uuid(),
    recipientId: uuid(),
    type: z.enum(FIELD_TYPES),
    page: z.number().int().describe("Página, desde 0."),
    x: z.number().describe("Coordenadas normalizadas 0..1, origen arriba a la izquierda."),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    required: z.boolean(),
    label: z.string().nullable(),
    value: z.string().nullable().describe("Valor prellenado por el remitente o completado por el firmante."),
    readOnly: z.boolean(),
    options: z.array(z.string()).nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    conditions: z.array(FieldCondition).nullable(),
    formula: z.string().nullable(),
  }),
);

export const EnvelopeSchema = named(
  "Envelope",
  z.object({
    id: uuid(),
    subject: z.string(),
    message: z.string().nullable(),
    locale: z.enum(LOCALES),
    status: z.enum(ENVELOPE_STATUSES),
    createdVia: z.enum(["web", "api"]),
    createdAt: iso(),
    updatedAt: iso(),
    sentAt: iso().nullable(),
    completedAt: iso().nullable(),
    voidedAt: iso().nullable(),
    voidReason: z.string().nullable(),
    expiresAt: iso().nullable(),
    metadata: z.record(z.string(), z.unknown()).describe("Datos libres del integrador (los sobres creados desde plantilla agregan templateId)."),
    signedSha256: z.string().nullable().describe("SHA-256 del PDF final sellado (cuando está completo)."),
    reminderEveryDays: z.number().int().nullable(),
    expiryWarningDays: z.number().int().nullable(),
    allowDelegation: z.boolean(),
    brandId: z.string().uuid().nullable().optional().describe("Sub-marca (marca blanca); null: la de la organización."),
  }),
);

export const EnvelopeDetailSchema = named(
  "EnvelopeDetail",
  z.object({
    envelope: EnvelopeSchema,
    documents: z.array(DocumentSchema),
    recipients: z.array(RecipientSchema),
    fields: z.array(FieldSchema),
    canManage: z.boolean().optional().describe("Solo en GET /v1/envelopes/{id}: si quien consulta puede modificar el sobre (anular, corregir, reasignar, compartir)"),
  }),
);

export const EnvelopeSummarySchema = named(
  "EnvelopeSummary",
  z.object({
    id: uuid(),
    subject: z.string(),
    status: z.enum(ENVELOPE_STATUSES),
    createdAt: iso(),
    sentAt: iso().nullable(),
    completedAt: iso().nullable(),
    expiresAt: iso().nullable(),
    updatedAt: iso().describe("Última modificación del sobre (cambios de estado incluidos)."),
    metadata: z.record(z.string(), z.unknown()),
    recipients: z.array(z.object({ name: z.string(), status: z.enum(RECIPIENT_STATUSES), role: z.enum(RECIPIENT_ROLES) })),
  }),
);

export const EnvelopeListSchema = z.object({
  items: z.array(EnvelopeSummarySchema),
  nextCursor: z.string().nullable().describe("Pasarlo como `cursor` para la página siguiente; null si no hay más."),
});

export const EnvelopeEventSchema = named(
  "EnvelopeEvent",
  z.object({
    seq: z.number().int(),
    type: z.string().describe("p. ej. envelope.created, document.added, envelope.sent, recipient.viewed, recipient.signed, envelope.completed"),
    actorType: z.enum(["user", "api_key", "recipient", "system"]),
    actorLabel: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
    occurredAt: iso(),
    hash: z.string().describe("Hash encadenado con el evento anterior (cadena de evidencia)."),
  }),
);

export const SigningUrlSchema = named(
  "SigningUrl",
  z.object({
    url: z.string().url().describe("URL de un solo uso para el iframe o la redirección."),
    expiresAt: iso(),
    tabOnly: z.boolean().optional().describe("true: el firmante tiene código OTP; la URL se abre en una pestaña o redirección (no dentro de un iframe)."),
  }),
);

// ───────────────────────────── Webhooks ─────────────────────────────

export const WebhookSchema = named(
  "Webhook",
  z.object({
    id: uuid(),
    url: z.string().url(),
    description: z.string().nullable(),
    events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).describe("Vacío = todos los eventos."),
    active: z.boolean(),
    secretPrefix: z.string().describe("Primeros caracteres del secreto (whsec_…), para identificarlo."),
    previousSecretExpiresAt: iso().nullable().optional().describe("Después de rotar el secreto: hasta cuándo las entregas van firmadas también con el anterior."),
    deactivatedReason: z
      .enum(["credential_revoked", "permission_lost", "gone", "failing"])
      .nullable()
      .optional()
      .describe(
        "Solo lectura. `credential_revoked`: inactivo porque se revocó la API key o la app OAuth que lo creó (o el usuario dejó la organización). `permission_lost`: esa credencial sigue vigente pero ya no tiene `webhooks:manage` y `envelopes:view_all` (cambio de rol o de scopes). En los dos casos, reactivarlo con `active: true` lo ata a la credencial actual. `gone`: el receptor respondió 410 Gone. `failing`: N entregas fallidas definitivas seguidas (50 por defecto) o 7 días fallando sin ninguna exitosa (con al menos 5 fallas definitivas seguidas). `null`: activo o pausado a mano. Las desactivaciones automáticas quedan en la auditoría (webhook.deactivated) y se avisan por correo a quienes tienen `webhooks:manage`.",
      ),
    createdAt: iso(),
    updatedAt: iso(),
  }),
);

export const WebhookDeliverySchema = named(
  "WebhookDelivery",
  z.object({
    id: uuid(),
    endpointId: uuid(),
    eventId: uuid(),
    eventType: z.string(),
    envelopeId: uuid().nullable(),
    status: z.enum(["pending", "succeeded", "failed"]),
    attempts: z.number().int(),
    lastStatusCode: z.number().int().nullable(),
    lastResponse: z.string().nullable().describe("Primeros 1000 caracteres de la respuesta del endpoint."),
    lastError: z.string().nullable(),
    lastAttemptAt: iso().nullable(),
    nextRetryAt: iso().nullable(),
    createdAt: iso(),
    deliveredAt: iso().nullable(),
  }),
);

export const WebhookEventSchema = named(
  "WebhookEvent",
  z
    .object({
      id: uuid().describe(
        "Id del evento (igual al header CalaSign-Event-Id y al `id` del mismo evento en GET /v1/events). Usarlo para deduplicar: los reintentos y la API de eventos repiten el mismo id.",
      ),
      type: z.enum([...WEBHOOK_EVENT_TYPES, "webhook.test"]),
      createdAt: iso().describe("Cuándo ocurrió el evento (= occurredAt en GET /v1/events), no cuándo se armó la entrega."),
      tenantId: uuid(),
      data: z.object({
        envelope: z
          .object({
            id: uuid(),
            subject: z.string(),
            status: z.enum(ENVELOPE_STATUSES),
            metadata: z.record(z.string(), z.unknown()),
            sentAt: iso().nullable(),
            completedAt: iso().nullable(),
            signedSha256: z.string().nullable(),
            recipients: z.array(
              z.object({
                id: uuid(),
                name: z.string(),
                email: z.string().nullable(),
                role: z.enum(RECIPIENT_ROLES),
                status: z.enum(RECIPIENT_STATUSES),
                routingOrder: z.number().int(),
              }),
            ),
          })
          .nullable()
          .describe("Estado del sobre cuando se armó la entrega (segundos después del evento: puede reflejar cambios posteriores). null en webhook.test."),
        recipientId: uuid().nullable().optional().describe("Destinatario que originó el evento (recipient.*). No viene en webhook.test."),
        reason: z.string().nullable().optional().describe("Motivo (rechazo o anulación), si lo hay. No viene en webhook.test."),
      }),
    })
    .describe("Cuerpo de cada entrega de webhook (POST JSON)."),
);

// ───────────────────────────── Identidad y API keys ─────────────────────────────

export const ApiKeySchema = named(
  "ApiKey",
  z.object({ id: uuid(), name: z.string(), prefix: z.string(), createdAt: iso(), lastUsedAt: iso().nullable(), revokedAt: iso().nullable() }),
);

export const MeSchema = named(
  "Me",
  z.object({
    user: z
      .object({ id: uuid(), email: z.string(), name: z.string(), locale: z.enum(LOCALES) })
      .describe("Con una API key: id = id de la key, email vacío y name = \"API key: <nombre>\"."),
    tenant: z.object({ id: uuid(), slug: z.string(), name: z.string(), plan: z.string(), defaultLocale: z.enum(LOCALES) }),
  }),
);

// ───────────────────────────── Plantillas ─────────────────────────────

export const TemplateSchema = named(
  "Template",
  z.object({
    id: uuid(),
    name: z.string(),
    description: z.string().nullable(),
    subject: z.string().nullable(),
    message: z.string().nullable(),
    locale: z.enum(LOCALES),
    createdAt: iso(),
    updatedAt: iso(),
  }),
);

export const TemplateSummarySchema = named(
  "TemplateSummary",
  TemplateSchema.extend({
    documentCount: z.number().int(),
    roles: z.array(z.object({ name: z.string(), role: z.enum(RECIPIENT_ROLES) })),
    canManage: z.boolean().optional().describe("Si quien consulta puede editar, borrar o compartir la plantilla (templates:manage o quien la creó)"),
  }),
);

export const TemplateRoleSchema = named(
  "TemplateRole",
  z.object({
    id: uuid(),
    name: z.string().describe("Nombre del rol (p. ej. Cliente): se usa en `recipients[].role` al crear un sobre y en las columnas del CSV masivo."),
    role: z.enum(RECIPIENT_ROLES),
    routingOrder: z.number().int(),
    signatureType: z.enum(SIGNATURE_TYPES),
    certificateRequirements: CertificateRequirementsSchema.nullable(),
  }),
);

export const TemplateFieldSchema = named(
  "TemplateField",
  FieldSchema.omit({ recipientId: true }).extend({ roleId: uuid() }),
);

export const TemplateDetailSchema = named(
  "TemplateDetail",
  z.object({
    template: TemplateSchema,
    documents: z.array(DocumentSchema),
    roles: z.array(TemplateRoleSchema),
    fields: z.array(TemplateFieldSchema),
    canManage: z.boolean().optional().describe("Solo en GET /v1/templates/{id}: si quien consulta puede modificar la plantilla (editar, borrar, compartir)"),
  }),
);

// ───────────────────────────── Envío masivo ─────────────────────────────

export const BulkValidationResultSchema = named(
  "BulkValidationResult",
  z.object({
    total: z.number().int(),
    valid: z.number().int(),
    invalid: z.number().int(),
    errors: z.array(z.object({ row: z.number().int().describe("Número de fila de datos (desde 1, sin contar el encabezado)."), errors: z.array(z.string()) })),
    columns: z.array(z.string()).describe("Encabezados del CSV (vacío si las filas vinieron en JSON)."),
    duplicates: z
      .array(z.object({ row: z.number().int(), sameAs: z.number().int() }))
      .optional()
      .describe("Solo en /validate: filas válidas iguales a una anterior (mismos destinatarios y prellenado)."),
    quotaRemaining: z.number().int().nullable().optional().describe("Solo en /validate: sobres que quedan en el cupo del mes (null: sin tope)."),
    warnings: z.array(z.string()).optional().describe("Solo en /validate: avisos que no impiden enviar (en español)."),
  }),
);

export const BulkSendSchema = named(
  "BulkSend",
  z.object({
    id: uuid(),
    name: z.string().nullable(),
    templateId: uuid().nullable().describe("null si la plantilla se borró después."),
    templateName: z.string(),
    status: z.enum(BULK_SEND_STATUSES),
    total: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    retryable: z.number().int().describe("Fallidas que POST /v1/bulk-sends/{id}/retry-failed volvería a encolar (las que fallaron por sus datos no; 0 si el envío se canceló)."),
    cancelled: z.number().int(),
    pending: z.number().int().describe("Pendientes + en proceso."),
    createdAt: iso(),
    completedAt: iso().nullable(),
    cancelledAt: iso().nullable(),
  }),
);

export const BulkSendItemSchema = named(
  "BulkSendItem",
  z.object({
    id: uuid(),
    row: z.number().int(),
    status: z.enum(BULK_ITEM_STATUSES),
    envelopeId: uuid().nullable(),
    recipients: z.array(z.string()).describe("Nombres de los destinatarios de la fila."),
    error: z
      .string()
      .nullable()
      .describe(
        "Motivo de la falla (texto, no un código de error HTTP): validación de la fila, cupo del plan, o la plantilla dejó de estar disponible durante el envío (\"La plantilla fue eliminada\" u otro problema al cargarla). Las que no son de datos se reintentan con POST /v1/bulk-sends/{id}/retry-failed.",
      ),
    processedAt: iso().nullable(),
  }),
);

// ───────────────────────────── Formularios web ─────────────────────────────

export const WebFormSchema = named(
  "WebForm",
  z.object({
    id: uuid(),
    slug: z.string(),
    url: z.string().describe("Link público del formulario (/f/<slug>, con el dominio propio si hay)."),
    name: z.string(),
    description: z.string().nullable(),
    templateId: uuid(),
    templateName: z.string(),
    signerRoleId: uuid(),
    fixedRecipients: z.array(
      z.object({
        roleId: uuid(),
        name: z.string(),
        email: z.string().nullable(),
        phone: z.string().nullable(),
        channels: z.array(z.enum(CHANNELS)),
        locale: z.enum(LOCALES).nullable(),
      }),
    ),
    prefill: z.record(z.string(), z.string()),
    lockPrefill: z.boolean().describe("Los valores prellenados de los campos de quien completa el formulario son de solo lectura (por defecto false: valores sugeridos que se pueden corregir)."),
    active: z.boolean(),
    maxUses: z.number().int().nullable(),
    uses: z.number().int(),
    expiresAt: iso().nullable(),
    requireOtp: z.boolean(),
    embeddable: z.boolean(),
    collectPhone: z.boolean(),
    ownerInactiveReason: z.string().nullable().describe("Por qué no crea sobres aunque esté activo (en español); null si está habilitado."),
    ownerInactiveCode: z
      .enum(["not_member", "missing_permission", "template_access", "key_revoked", "plan_feature", "plan_api", "misconfigured"])
      .nullable()
      .describe(
        "not_member · missing_permission · template_access · key_revoked (quien lo configuró perdió el acceso); plan_feature (el plan no incluye formularios web); plan_api (lo configuró una API key y el plan ya no incluye la API); misconfigured (la plantilla cambió y el formulario ya no cierra con ella: rol que pasó a aprobador o copia, campos o roles del prellenado).",
      ),
    createdAt: iso(),
    updatedAt: iso(),
  }),
);

// ───────────────────────────── Cobros ─────────────────────────────

export const EnvelopePaymentSchema = named(
  "EnvelopePayment",
  z.object({
    id: uuid(),
    amount: z.number(),
    currency: z.enum(PAYMENT_CURRENCIES),
    description: z.string(),
    payerRecipientId: uuid(),
    timing: z.enum(PAYMENT_TIMINGS),
    provider: z.enum(PAYMENT_PROVIDERS),
    status: z.enum(["pending", "checkout_created", "paid", "failed", "refunded"]),
    paidAt: iso().nullable(),
    providerPaymentId: z.string().nullable(),
    refundRequiredAt: iso().nullable().describe("El pago llegó con el sobre ya cerrado y se tiene que devolver."),
    refundedAt: iso().nullable().describe("Reembolsado: por CalaSign (sobre cerrado) o en el proveedor (estado refunded)."),
    refundError: z.string().nullable(),
    disputedAt: iso().nullable().optional().describe("Contracargo o disputa abierta en el proveedor; no cambia el estado del cobro ni del sobre."),
  }),
);

export const PaymentProviderSchema = named(
  "PaymentProvider",
  z.object({
    id: z.enum(PAYMENT_PROVIDERS),
    configured: z.boolean(),
    methods: z.array(z.string()).describe("Medios de pago (texto en español)."),
    methodCodes: z.array(z.enum(PAYMENT_METHOD_CODES)),
  }),
);

// ───────────────────────────── Marca ─────────────────────────────

export const BrandingSchema = named(
  "Branding",
  z.object({
    primaryColor: z.string().nullable().describe("#rrggbb"),
    emailFooter: z.string().nullable(),
    logoUrl: z.string().nullable().describe("Ruta relativa al servidor (/v1/branding/logo/<slug>?v=…), pública."),
    logoContentType: z.enum(["image/png", "image/svg+xml", "image/jpeg"]).nullable(),
  }),
);

// ───────────────────────────── Verificación de identidad ─────────────────────────────

export const IdentitySettingsSchema = named(
  "IdentitySettings",
  z.object({
    defaultProvider: z.enum(IDV_PROVIDERS),
    defaultLevel: z.enum(IDV_LEVELS),
    nameMatchThreshold: z.number(),
    maxAttempts: z.number().int(),
    mock: z.object({ decision: z.enum(MOCK_DECISIONS), extractedName: z.string().nullable(), extractedDocumentNumber: z.string().nullable() }),
    providers: z.array(z.object({ id: z.enum(IDV_PROVIDERS), name: z.string(), configured: z.boolean(), mode: z.enum(["builtin", "redirect"]) })),
  }),
);

export const RecipientIdentityDetailSchema = z.object({
  identity: RecipientIdentitySchema.nullable(),
  unavailableReason: z
    .string()
    .nullable()
    .describe("Por qué el proveedor no puede hacer el nivel pedido en este entorno (null si puede). Se resuelve reiniciando con otro nivel o proveedor."),
  attempts: z.array(
    z.object({
      id: uuid(),
      attempt: z.number().int(),
      provider: z.enum(IDV_PROVIDERS),
      level: z.enum(IDV_LEVELS),
      status: z.enum(["created", "pending", "verified", "failed"]),
      reference: z.string().nullable().describe("Id del proceso en el proveedor."),
      failureReason: z.string().nullable(),
      createdAt: iso(),
      completedAt: iso().nullable(),
      result: z
        .object({
          status: z.enum(["approved", "declined", "review", "pending"]),
          documentType: z.string().nullable(),
          documentCountry: z.string().nullable(),
          documentNumber: z.string().nullable().describe("Enmascarado (últimos 4 dígitos)."),
          fullName: z.string().nullable(),
          faceMatchScore: z.number().nullable(),
          liveness: z.boolean().nullable(),
          riskFlags: z.array(z.string()),
        })
        .nullable()
        .describe("Resumen sin imágenes ni datos completos del documento."),
      nameMatch: z
        .object({ score: z.number(), matched: z.boolean(), threshold: z.number(), documentNumberMatched: z.boolean().nullable() })
        .nullable(),
    }),
  ),
});

// ───────────────────────────── Equipo ─────────────────────────────

const RoleRef = { role: z.enum(MEMBER_ROLES), roleId: uuid().nullable(), roleName: z.string() };

export const MemberSchema = named(
  "Member",
  z.object({
    userId: uuid(),
    name: z.string(),
    email: z.string(),
    ...RoleRef,
    groups: z.array(z.object({ id: uuid(), name: z.string() })),
    twoFactorEnabled: z.boolean(),
    joinedAt: iso(),
  }),
);

export const InvitationSchema = named(
  "Invitation",
  z.object({
    id: uuid(),
    email: z.string(),
    ...RoleRef,
    invitedBy: z.string().nullable(),
    createdAt: iso(),
    expiresAt: iso(),
    status: z.enum(["pending", "accepted", "revoked", "expired"]),
  }),
);

export const CustomRoleSchema = named(
  "CustomRole",
  z.object({
    id: uuid(),
    name: z.string(),
    description: z.string().nullable(),
    permissions: z.array(z.enum(PERMISSIONS)),
    memberCount: z.number().int().describe("Miembros y API keys activas con este rol (0 en las respuestas de alta y edición)."),
    createdAt: iso(),
  }),
);

export const GroupSchema = named(
  "Group",
  z.object({
    id: uuid(),
    name: z.string(),
    description: z.string().nullable(),
    members: z.array(z.object({ userId: uuid(), name: z.string(), email: z.string() })),
    createdAt: iso(),
  }),
);

export const AccessSchema = named(
  "Access",
  z.object({
    role: z.enum(MEMBER_ROLES),
    roleName: z.string(),
    permissions: z.array(z.enum(PERMISSIONS)).describe("Con un token OAuth, recortados a lo que permiten sus scopes."),
    groups: z.array(z.object({ id: uuid(), name: z.string() })),
    tenants: z
      .array(z.object({ id: uuid(), name: z.string(), slug: z.string(), role: z.enum(MEMBER_ROLES), roleName: z.string(), current: z.boolean() }))
      .describe("Organizaciones del usuario (vacío con una API key)."),
    twoFactor: z.object({ enabled: z.boolean(), requiredByTenant: z.boolean(), setupRequired: z.boolean() }),
    planFeatures: z.array(z.enum(PLAN_FEATURES)).describe("Funciones del plan actual de la organización (lo que no figura responde 402 plan_limit)."),
    planName: z.string().describe("Nombre del plan actual."),
  }),
);

export const SharesSchema = z.object({ groups: z.array(z.object({ id: uuid(), name: z.string() })) });

// ───────────────────────────── Sello y nivel de firma ─────────────────────────────

export const SealOptionsSchema = named(
  "SealOptions",
  z.object({
    companySealCertificateId: uuid().nullable(),
    companySeal: z.object({ name: z.string(), commonName: z.string().nullable() }).nullable(),
    signatureLevel: z.enum(SIGNATURE_LEVELS),
    envelopeUpdatedAt: iso().describe("updatedAt del sobre tras leer o guardar (para X-Expected-Updated-At del siguiente guardado)."),
  }),
);

// ───────────────────────────── IA: datos del contrato ─────────────────────────────

export const EnvelopeAiMetadataSchema = named(
  "EnvelopeAiMetadata",
  z.object({
    metadata: ContractMetadataSchema.nullable(),
    confidence: z.record(z.number().min(0).max(1)).describe("Confianza 0..1 por campo (solo para lo extraído por IA)."),
    source: z.enum(["ai", "manual"]).nullable(),
    updatedAt: iso().nullable(),
    renewalAlertAt: z.string().nullable().describe("Fecha (YYYY-MM-DD) en que se avisará la renovación o el vencimiento."),
    renewalAlertSentAt: iso().nullable(),
    signerAssist: z.boolean(),
    usage: z
      .object({ provider: z.enum(["anthropic", "mock"]), model: z.string(), inputTokens: z.number().int(), outputTokens: z.number().int() })
      .nullable(),
    envelopeUpdatedAt: iso().nullable().describe("updatedAt del sobre (para X-Expected-Updated-At del siguiente guardado)."),
  }),
);

// ───────────────────────────── Auditoría ─────────────────────────────

export const AuditLogEntrySchema = named(
  "AuditLogEntry",
  z.object({
    id: z.number().int(),
    occurredAt: iso(),
    actorType: z.enum(["user", "api_key", "system", "anonymous"]),
    actorId: z.string().nullable(),
    actorLabel: z.string().nullable(),
    action: z.string().describe("p. ej. api_key.created, webhook.updated, member.invited, settings.changed, auth.login"),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  }),
);

// ───────────────────────────── Verificación pública ─────────────────────────────

export const VerifyResponseSchema = named(
  "VerifyResponse",
  z.object({
    match: z.boolean().describe("true si el archivo es, byte a byte, un PDF final sellado por CalaSign (versión vigente o anterior a una renovación de archivo)."),
    sha256: z.string(),
    envelope: z.object({ id: uuid(), subject: z.string(), organizationName: z.string(), completedAt: iso().nullable() }).optional(),
    participants: z.array(z.object({ name: z.string(), role: z.enum(RECIPIENT_ROLES), signedAt: iso().nullable() })).optional(),
    seal: z.object({ format: z.string().nullable(), provider: z.string().nullable(), timestamped: z.boolean() }).optional(),
    chain: z.object({ ok: z.boolean(), events: z.number().int(), head: z.string() }).optional().describe("Integridad de la cadena de eventos del sobre."),
    version: z
      .object({ number: z.number().int(), latest: z.number().int(), isLatest: z.boolean(), reason: z.enum(["completed", "archive_renewal"]), createdAt: iso().nullable() })
      .optional(),
  }),
);

// ───────────────────────────── Reportes ─────────────────────────────

export const ReportsSummarySchema = z.object({
  from: iso(),
  to: iso(),
  timeZone: z.string().describe("Zona horaria (IANA) de los meses de byMonth: la pedida con `tz` (nombre canónico) o UTC si falta o no se reconoce."),
  totals: z.object({
    created: z.number().int(),
    sent: z.number().int(),
    completed: z.number().int(),
    declined: z.number().int(),
    voided: z.number().int(),
    expired: z.number().int(),
    inProgress: z.number().int().describe("En curso ahora (sent + finalizing), sin importar el rango."),
    completionRate: z.number().nullable().describe("Completados / enviados en el rango (0..1)."),
    avgHoursToComplete: z.number().nullable(),
  }),
  byMonth: z.array(
    z.object({
      month: z.string().describe("YYYY-MM, mes calendario en `timeZone`"),
      created: z.number().int(),
      draft: z.number().int(),
      inProgress: z.number().int(),
      completed: z.number().int(),
      declined: z.number().int(),
      voided: z.number().int(),
      expired: z.number().int(),
    }),
  ),
  topSenders: z.array(z.object({ userId: uuid().nullable(), name: z.string(), email: z.string().nullable(), sent: z.number().int(), completed: z.number().int() })),
  notifications: z.array(z.object({ channel: z.string(), sent: z.number().int(), failed: z.number().int() })),
});

// ───────────────────────────── Planes (402) ─────────────────────────────

export const PlanLimitDetailsSchema = named(
  "PlanLimitDetails",
  z
    .object({
      plan: z.enum(PLAN_IDS),
      limit: z.enum(["envelopes_per_month", "users"]).optional(),
      feature: z.enum(PLAN_FEATURES).optional(),
      used: z.number().int().optional(),
      max: z.number().int().nullable().optional(),
      suggestedPlan: z.enum(PLAN_IDS).nullable(),
      upgradeUrl: z.string(),
    })
    .describe("`error.details` de un 402 plan_limit."),
);
