// Piezas del OpenAPI que no son operaciones: conversión Zod → JSON Schema con $ref a components.schemas,
// catálogo de errores (con ejemplos reales del setErrorHandler de app.ts), tags, parámetros y operationId.
import type { ZodTypeAny } from "zod";
import { CRM_PROVIDERS } from "@calasign/shared";
import { ignoreOverride, zodToJsonSchema } from "zod-to-json-schema";
import { NAMED, REGISTRY } from "./openapi-schemas";

// ───────────────────────────── Operaciones ─────────────────────────────

export interface QueryParam {
  name: string;
  description: string;
  /** JSON Schema del valor (por defecto string). */
  schema?: Record<string, unknown>;
  required?: boolean;
}

export interface Op {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  operationId?: string;
  body?: ZodTypeAny;
  /** Cuerpo opcional (el handler acepta un pedido sin cuerpo). */
  bodyOptional?: boolean;
  multipart?: boolean;
  /** Descripción del campo `file` del multipart. */
  fileDescription?: string;
  /**
   * Además del cuerpo JSON (`body`), acepta multipart/form-data con ese mismo JSON en la parte `payload` y archivos en
   * otras partes (POST /v1/envelopes con el sobre completo). El texto describe las partes de archivo.
   */
  multipartPayload?: string;
  response?: ZodTypeAny | "pdf" | "csv" | "html" | "none";
  responseDescription?: string;
  status?: number;
  auth?: "key" | "token" | "none" | "client";
  idempotent?: boolean;
  /** Admite el encabezado X-Expected-Updated-At (control de edición concurrente de borradores y plantillas: 409 version_changed). */
  expectedUpdatedAt?: boolean;
  /** Cuerpo application/x-www-form-urlencoded (endpoints OAuth). */
  form?: ZodTypeAny;
  query?: QueryParam[];
  /** Códigos del catálogo ERRORS que puede devolver además de los comunes de su clase. */
  errors?: string[];
}

// ───────────────────────────── Zod → JSON Schema ─────────────────────────────

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);

/** anyOf [{type: X, …}, {type: "null"}] → {type: [X, "null"], …} (más compacto y válido en OpenAPI 3.1). */
function compact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compact);
  if (!node || typeof node !== "object") return node;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) o[k] = compact(v);
  const any = o.anyOf as Record<string, unknown>[] | undefined;
  // Un optional anidado (p. ej. dentro de un nullable) sale como anyOf [{ not: {} }, X]: equivale a X.
  if (Array.isArray(any) && any.length === 2 && JSON.stringify(any[0]) === '{"not":{}}') {
    const { anyOf: _drop, ...rest } = o;
    return compact({ ...any[1], ...rest });
  }
  if (Array.isArray(any) && any.length === 2 && any[1]?.type === "null" && Object.keys(any[1]).length === 1) {
    const base = any[0];
    if (base && typeof base.type === "string" && PRIMITIVES.has(base.type)) {
      const { anyOf: _drop, ...rest } = o;
      const merged: Record<string, unknown> = { ...base, ...rest, type: [base.type, "null"] };
      if (Array.isArray(base.enum)) merged.enum = [...base.enum, null];
      return merged;
    }
  }
  return o;
}

function convert(schema: ZodTypeAny, root: boolean): Record<string, unknown> {
  const out = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
    // Sin additionalProperties: false: la API ignora (no rechaza) propiedades desconocidas y las respuestas pueden sumar campos.
    removeAdditionalStrategy: "strict",
    allowedAdditionalProperties: undefined,
    override: (def, refs) => {
      const name = NAMED.get(def);
      if (!name) return ignoreOverride;
      // La raíz de un esquema con nombre se genera; adentro de otro esquema, se referencia.
      if (root && refs.currentPath.length === refs.basePath.length) return ignoreOverride;
      return ref(name);
    },
  }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = out;
  return compact(rest) as Record<string, unknown>;
}

/** JSON Schema de un esquema Zod; los esquemas con nombre (y los que contiene) van como $ref. */
export function js(schema: ZodTypeAny): Record<string, unknown> {
  const name = NAMED.get(schema._def);
  return name ? ref(name) : convert(schema, false);
}

/** Reglas de las entradas que JSON Schema no expresa (los .refine() del contrato): se validan igual (400 validation_error). */
const INPUT_RULES: Record<string, string> = {
  RecipientInput:
    "Reglas: email o phone (salvo embedded o inPerson); el canal email requiere email y whatsapp requiere phone (salvo embedded o inPerson); " +
    "solo telegram requiere telegramChatId; authMethod otp_email requiere email y otp_sms/otp_whatsapp requieren phone; " +
    "authMethod in_person se configura con inPerson; signatureType certificate solo con role signer.",
  FieldInput:
    "Reglas: x + width ≤ 1 y y + height ≤ 1; un dropdown necesita options; min ≤ max; solo un campo number puede tener formula; " +
    "readOnly requiere value. Además: el documento existe, page < pageCount y recipientId es un signer del sobre.",
  AnchorFieldInput:
    "Campo ubicado por un texto del PDF: se crea uno por cada aparición de anchor.text (en documentId o en todos los documentos). " +
    "offsetX/offsetY/width/height en puntos PDF, relativos a la esquina superior izquierda del texto. Sin ignoreIfNotPresent, un texto que no aparece es un 400 anchor_not_found.",
  FieldCondition: "Condición de visibilidad: el campo se muestra (y exige) solo si se cumplen todas. equals y not_equals requieren value.",
  TemplateRecipientInput:
    "Destinatario real para un rol de la plantilla (roleId o el nombre del rol en role). Reglas: email o phone; el canal email requiere email y whatsapp requiere phone; solo telegram requiere telegramChatId.",
  TemplateFieldInput: "Reglas: x + width ≤ 1 y y + height ≤ 1; un dropdown necesita options; solo un campo number puede tener formula. roleId tiene que ser un rol signer.",
  BulkRowInput:
    "Una fila: un destinatario por rol (role = nombre del rol, o roleId). Los datos se validan por fila como en POST /v1/envelopes/from-template; sin channels, se usa email si hay correo y si no whatsapp.",
};

/** components.schemas con todos los esquemas registrados. */
export function componentSchemas(examples: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of REGISTRY) {
    out[name] = convert(schema, true);
    if (INPUT_RULES[name]) (out[name] as Record<string, unknown>).description = INPUT_RULES[name];
    if (examples[name] !== undefined) (out[name] as Record<string, unknown>).example = examples[name];
  }
  out.OAuthError = {
    type: "object",
    description: "Error de los endpoints /oauth/* (RFC 6749 §5.2). No usa el formato { error: { code, message } }.",
    properties: {
      error: { type: "string", enum: ["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope"] },
      error_description: { type: "string" },
    },
    required: ["error", "error_description"],
  };
  return out;
}

// ───────────────────────────── Errores ─────────────────────────────

interface Err {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  summary: string;
}

const UPGRADE = "/app/settings/billing";
const planFeature = (feature: string, label: string, suggested: string): Err => ({
  status: 402,
  code: "plan_limit",
  message: `${label} no está incluido en el plan Free`,
  details: { plan: "free", feature, suggestedPlan: suggested, upgradeUrl: UPGRADE },
  summary: `El plan no incluye ${feature}`,
});

/** Catálogo de errores (código → ejemplo). Los mensajes son los que devuelven los handlers. */
export const ERRORS: Record<string, Err> = {
  validation_error: {
    status: 400,
    code: "validation_error",
    message: "recipients.0.email: Invalid email; recipients.0: email o phone requerido",
    details: [
      { path: "recipients.0.email", message: "Invalid email" },
      { path: "recipients.0", message: "email o phone requerido" },
    ],
    summary: "Cuerpo o parámetros inválidos. `details` lista cada problema con su ruta (path con puntos).",
  },
  invalid_id: { status: 400, code: "invalid_id", message: "Identificador inválido", summary: "Un id de la ruta o del cuerpo no es un UUID" },
  invalid_idempotency_key: { status: 400, code: "invalid_idempotency_key", message: "Idempotency-Key demasiado larga", summary: "Idempotency-Key de más de 200 caracteres" },
  file_required: { status: 400, code: "file_required", message: "Falta el archivo (campo 'file')", summary: "Falta el campo file del multipart" },
  not_pdf: {
    status: 400,
    code: "not_pdf",
    message: "El archivo no es un PDF",
    summary:
      "El archivo (subido, en base64 o descargado de `url`) no es un PDF; también un base64 inválido. Mismo código en todas las vías de subida. Otros problemas del PDF: encrypted, pdf_restricted, empty, too_many_pages, unreadable, ambiguous_pdf, pdf_hidden_layers, pdf_form_unsupported (400)",
  },
  pdf_restricted: {
    status: 400,
    code: "pdf_restricted",
    message: "El PDF tiene restricciones de uso (permisos): volvé a exportarlo o imprimilo a PDF y subilo de nuevo.",
    summary: "PDF cifrado solo con permisos (abre sin contraseña, pero no se puede procesar): volver a exportarlo o imprimirlo a PDF. Con contraseña de apertura el código es encrypted",
  },
  pdf_hidden_layers: {
    status: 400,
    code: "pdf_hidden_layers",
    message: "El PDF tiene capas ocultas (contenido opcional apagado): exportalo de nuevo sin capas o imprimilo a PDF y volvé a subirlo.",
    summary: "El PDF tiene contenido opcional (capas) apagado: el firmante no lo vería y el PDF sellado sí. Exportarlo sin capas o imprimirlo a PDF",
  },
  pdf_form_unsupported: {
    status: 400,
    code: "pdf_form_unsupported",
    message: "El PDF tiene un formulario cuyos campos no se pueden fijar tal como se ven: imprimilo a PDF y volvé a subirlo.",
    summary: "Los campos de formulario del PDF se fijan en la página al subirlo; uno no se pudo dibujar tal como lo muestra un lector (p. ej. NeedAppearances con caracteres que la fuente estándar no tiene). Imprimirlo a PDF",
  },
  unknown_part: {
    status: 400,
    code: "unknown_part",
    message: "Parte \"datos\" desconocida: el JSON va en la parte \"payload\"",
    summary: "multipart/form-data con un campo de texto que no es `payload`",
  },
  duplicate_part: { status: 400, code: "duplicate_part", message: "La parte \"contrato\" está repetida", summary: "Dos partes del multipart con el mismo nombre (también `payload` repetida)" },
  invalid_json: { status: 400, code: "invalid_json", message: "La parte \"payload\" no es JSON válido", summary: "La parte `payload` del multipart no es JSON" },
  too_many_documents: {
    status: 400,
    code: "too_many_documents",
    message: "Hasta 10 documentos por llamada",
    details: { max: 10 },
    summary: "Más documentos que los admitidos (el tope va en details.max): 10 en POST /v1/envelopes y 30 por sobre o plantilla al agregar uno (también too_many_pages: más de 1000 páginas en total)",
  },
  duplicate_document: {
    status: 400,
    code: "duplicate_document",
    message: "documents[1]: la parte \"contrato\" ya se usó en otro documento",
    summary: "Dos documentos citan con `file` la misma parte del multipart",
  },
  too_many_fields: {
    status: 400,
    code: "too_many_fields",
    message: "Las anclas generan más de 500 campos",
    summary: "Las anclas de texto (`anchor`) generan más de 500 campos (una por aparición: usar un texto más específico)",
  },
  unreadable_pdf: { status: 400, code: "unreadable_pdf", message: "No se pudo leer el PDF: Invalid PDF structure", summary: "El PDF no se pudo analizar para validar sus firmas" },
  xml_sign_failed: {
    status: 400,
    code: "xml_sign_failed",
    message: "No se pudo firmar el XML: no se encontró el nodo ext:ExtensionContent",
    summary: "El XML no se pudo firmar con el perfil pedido (estructura que el perfil no admite)",
  },
  phone_required: { status: 400, code: "phone_required", message: "El teléfono es obligatorio", summary: "El formulario pide teléfono (collectPhone) y no vino" },
  invalid_form_token: {
    status: 400,
    code: "invalid_form_token",
    message: "El formulario venció: volvé a enviarlo en unos segundos",
    details: { retryAfterSeconds: 3 },
    summary: "formToken vencido, ajeno o ya usado: pedir uno nuevo con GET y reenviar pasado details.retryAfterSeconds",
  },
  invalid_event: { status: 400, code: "invalid_event", message: "Evento desconocido: envelope.archived", summary: "`event` que no es un tipo de evento de webhook" },
  invalid_target: {
    status: 400,
    code: "invalid_target",
    message: "Recurso desconocido: usá https://app.calasign.com/mcp",
    summary: "`resource` (RFC 8707) distinto del servidor MCP de CalaSign",
  },
  public_client: { status: 400, code: "public_client", message: "Un cliente público no tiene secreto", summary: "La app es un cliente público (sin secreto): no hay secreto que rotar" },
  document_fetch_failed: {
    status: 400,
    code: "document_fetch_failed",
    message: "documents[0]: no se pudo descargar (destino no permitido: intranet.local resuelve a una dirección interna)",
    summary: "No se pudo descargar el PDF de `url` (no https, redirige, responde con error o apunta a una red interna)",
  },
  file_part_missing: {
    status: 400,
    code: "file_part_missing",
    message: "documents[0]: no llegó la parte de archivo \"contrato\" (multipart/form-data)",
    summary: "Un documento cita con `file` una parte del multipart que no llegó",
  },
  unused_file_part: { status: 400, code: "unused_file_part", message: "Partes de archivo que no cita ningún documento: anexo", summary: "Con `documents`, cada archivo del multipart tiene que estar citado" },
  payload_required: { status: 400, code: "payload_required", message: "Falta la parte \"payload\" con el JSON del sobre", summary: "multipart/form-data sin la parte JSON `payload`" },
  duplicate_ref: { status: 400, code: "duplicate_ref", message: "Hay destinatarios con el mismo ref", summary: "Dos documentos o dos destinatarios con el mismo `ref`" },
  invalid_cursor: { status: 400, code: "invalid_cursor", message: "Cursor inválido", summary: "cursor que no salió de nextCursor" },
  invalid_range: { status: 400, code: "invalid_range", message: "Fechas inválidas (usar ISO 8601)", summary: "from/to inválidos, invertidos o rango mayor a 3 años" },
  invalid_query: { status: 400, code: "invalid_query", message: "'from' no es una fecha válida", summary: "Filtro de fecha inválido" },
  duplicate_ids: { status: 400, code: "duplicate_ids", message: "Ids de destinatarios repetidos", summary: "Ids repetidos en la lista" },
  invalid_field: { status: 400, code: "invalid_field", message: "Campo 1: el destinatario no es firmante de este sobre", summary: "Campo con documento, página o destinatario inválido" },
  anchor_not_found: {
    status: 400,
    code: "anchor_not_found",
    message: "Campo 1: no se encontró el texto ancla \"[firma_cliente]\"",
    details: { anchor: "[firma_cliente]" },
    summary: "Ancla de texto que no aparece en el PDF (sin ignoreIfNotPresent)",
  },
  frame_ancestor_not_allowed: {
    status: 400,
    code: "frame_ancestor_not_allowed",
    message: "Origen no autorizado en la configuración de la organización: https://otra.app",
    summary: "frameAncestors fuera de los orígenes autorizados",
  },
  invalid_origin: { status: 400, code: "invalid_origin", message: "Solo orígenes https fuera del entorno local", summary: "Origen http fuera del entorno local" },
  invalid_url: { status: 400, code: "invalid_url", message: "La URL del webhook debe ser https", summary: "URL no https, con credenciales o a un destino local" },
  too_many_webhooks: { status: 400, code: "too_many_webhooks", message: "Máximo 20 webhooks por organización", summary: "Tope de 20 endpoints (activos o desactivados en los últimos 30 días)" },
  template_empty: { status: 400, code: "template_empty", message: "La plantilla no tiene documentos", summary: "Plantilla sin documentos" },
  unknown_role: { status: 400, code: "unknown_role", message: "Rol desconocido: Garante", summary: "roleId/role que no existe en la plantilla" },
  duplicate_role: { status: 400, code: "duplicate_role", message: "El rol Cliente tiene más de un destinatario", summary: "Dos destinatarios para el mismo rol" },
  unknown_prefill: { status: 400, code: "unknown_prefill", message: "No hay ningún campo \"Monto\" en la plantilla", summary: "Clave de prefill que no es id ni etiqueta de un campo" },
  readonly_field: { status: 400, code: "readonly_field", message: "El campo \"Precio\" es de solo lectura en la plantilla", summary: "Prefill de un campo de solo lectura" },
  invalid_prefill: { status: 400, code: "invalid_prefill", message: "Campo \"Cantidad\": valor prellenado inválido (no es un número)", summary: "Valor de prefill inválido para el tipo de campo" },
  duplicate_roles: { status: 400, code: "duplicate_roles", message: "Hay dos roles con el mismo nombre", summary: "Nombres de rol repetidos" },
  certificate_not_applicable: { status: 400, code: "certificate_not_applicable", message: "Solo un rol firmante puede firmar con certificado", summary: "signatureType certificate en un rol que no firma" },
  no_rows: { status: 400, code: "no_rows", message: "No hay filas para enviar", summary: "CSV o rows vacío" },
  too_many_rows: { status: 400, code: "too_many_rows", message: "Máximo 5000 filas por envío", summary: "Más de 5000 filas" },
  invalid_form: {
    status: 400,
    code: "invalid_form",
    message: "La plantilla no queda completa con esta configuración: Faltan destinatarios para: Testigo",
    summary: "Configuración que no completa la plantilla (también invalid_role)",
  },
  storage_provider_not_configured: { status: 409, code: "provider_not_configured", message: "Este proveedor no está configurado en el servidor", summary: "Proveedor de almacenamiento sin credenciales OAuth en el servidor" },
  site_required: { status: 400, code: "site_required", message: "Indicá la URL del sitio de SharePoint", summary: "SharePoint sin siteUrl" },
  too_many_connections: { status: 400, code: "too_many_connections", message: "Máximo 20 conexiones de almacenamiento por organización", summary: "Tope de 20 conexiones de almacenamiento" },
  provider_not_configured: { status: 400, code: "provider_not_configured", message: "El proveedor stripe no está configurado en este entorno", summary: "Proveedor de cobro no configurado" },
  invalid_payer: { status: 400, code: "invalid_payer", message: "El pagador tiene que ser un firmante", summary: "payerRecipientId no es un firmante del sobre" },
  invalid_logo: { status: 400, code: "invalid_logo", message: "El logo tiene que ser PNG, JPG o SVG", summary: "Formato no admitido o SVG con scripts/referencias externas" },
  identity_provider_unavailable: {
    status: 400,
    code: "identity_provider_unavailable",
    message: "El proveedor veriff no está configurado",
    summary: "Proveedor de verificación no configurado",
  },
  invalid_role: { status: 400, code: "invalid_role", message: "Rol inexistente", summary: "Rol inválido o inexistente (una API key no puede ser owner)" },
  invalid_group: { status: 400, code: "invalid_group", message: "Algún grupo no existe", summary: "groupIds con grupos de otra organización o inexistentes" },
  invalid_member: { status: 400, code: "invalid_member", message: "Algún usuario no es miembro de la organización", summary: "memberIds con usuarios que no son miembros" },
  invalid_text: {
    status: 400,
    code: "invalid_text",
    message: "El texto contiene caracteres no admitidos",
    summary: "Un texto del pedido trae el carácter NUL (\\u0000), que no se puede guardar. Puede pasar en cualquier ruta que guarda texto",
  },

  unauthorized: { status: 401, code: "unauthorized", message: "Autenticación requerida", summary: "Falta la credencial o no es válida (API key revocada, token vencido)" },

  plan_limit_api: { ...planFeature("api", "El acceso por API", "starter"), summary: "El plan no incluye acceso por API (toda llamada con API key u OAuth)" },
  plan_limit_envelopes: {
    status: 402,
    code: "plan_limit",
    message: "Llegaste al límite de 5 sobres por mes del plan Free",
    details: { plan: "free", limit: "envelopes_per_month", used: 5, max: 5, suggestedPlan: "starter", upgradeUrl: UPGRADE },
    summary: "Cupo mensual de sobres enviados agotado",
  },
  plan_limit_users: {
    status: 402,
    code: "plan_limit",
    message: "El plan Free permite hasta 1 usuario(s)",
    details: { plan: "free", limit: "users", used: 1, max: 1, suggestedPlan: "starter", upgradeUrl: UPGRADE },
    summary: "Cupo de usuarios del plan",
  },
  plan_limit_webhooks: planFeature("webhooks", "Los webhooks", "starter"),
  plan_limit_branding: planFeature("branding", "La marca propia", "starter"),
  plan_limit_white_label: planFeature("white_label", "La marca blanca", "enterprise"),
  plan_limit_bulk_send: planFeature("bulk_send", "El envío masivo", "business"),
  plan_limit_web_forms: planFeature("web_forms", "Los formularios web", "business"),
  plan_limit_payments: planFeature("payments", "El cobro al firmar", "business"),
  plan_limit_kyc: planFeature("kyc", "La verificación de identidad", "business"),
  plan_limit_custom_domain: planFeature("custom_domain", "El dominio propio", "enterprise"),
  plan_limit_sso: planFeature("sso", "El inicio de sesión único (SSO)", "enterprise"),
  plan_limit_scim: planFeature("scim", "El aprovisionamiento SCIM", "enterprise"),

  forbidden: {
    status: 403,
    code: "forbidden",
    message: "Falta el permiso envelopes:create",
    details: { permission: "envelopes:create" },
    summary: "El rol de la credencial no tiene el permiso (details.permission o details.missing)",
  },
  insufficient_scope: {
    status: 403,
    code: "insufficient_scope",
    message: "El token no tiene el scope envelopes:write",
    details: { requiredScope: "envelopes:write" },
    summary: "Token OAuth sin el scope que exige la ruta",
  },
  oauth_denied: {
    status: 403,
    code: "insufficient_scope",
    message: "Este endpoint no está disponible con tokens OAuth",
    summary: "Ruta no disponible con tokens OAuth (solo API key o sesión)",
  },
  session_required: { status: 403, code: "session_required", message: "Esta operación requiere iniciar sesión en la web", summary: "Solo con sesión web (no API key ni OAuth)" },
  two_factor_setup_required: {
    status: 403,
    code: "two_factor_setup_required",
    message: "Tu organización exige verificación en dos pasos: activala para continuar",
    summary: "La organización exige 2FA y el usuario todavía no lo activó (todo responde esto salvo /v1/me, /v1/me/* —incluido /v1/me/2fa/*— y /v1/auth/*). Aplica a la sesión web y a los tokens OAuth de usuario (authorization_code); no aplica a API keys, a tokens client_credentials ni a sesiones o tokens OAuth obtenidos con SSO (el segundo factor lo gestiona el proveedor de identidad)",
  },
  bad_origin: {
    status: 403,
    code: "bad_origin",
    message: "Origen no permitido",
    summary: "Pedido que modifica con la cookie de sesión desde otro origen (header Origin ajeno, defensa CSRF). Con `Authorization` no aplica",
  },
  ai_disabled: { status: 403, code: "ai_disabled", message: "La IA no está habilitada para esta organización", summary: "La IA está deshabilitada en la organización (Ajustes → IA)" },
  ai_notice_required: {
    status: 403,
    code: "ai_notice_required",
    message: "La organización tiene que aceptar el aviso de tratamiento de datos vigente (Ajustes → IA)",
    details: { noticeVersion: "ai-notice-v2" },
    summary: "Falta aceptar el aviso de tratamiento de datos vigente (al usar la IA, o al habilitarla sin acceptNotice: true)",
  },
  payment_required: {
    status: 402,
    code: "payment_required",
    message: "Para firmar primero hay que completar el pago",
    details: { amount: 15000, currency: "COP", description: "Honorarios" },
    summary: "Cobro before_sign pendiente",
  },
  identity_required: { status: 403, code: "identity_required", message: "Hace falta verificar tu identidad para continuar", summary: "Falta la verificación de identidad del firmante" },
  invalid_brand: { status: 400, code: "invalid_brand", message: "La marca no existe en esta organización", summary: "brandId no es una sub-marca de la organización" },
  not_found: { status: 404, code: "not_found", message: "Sobre no encontrado", summary: "No existe o la credencial no puede verlo (el mensaje nombra el recurso)" },
  envelope_closed: {
    status: 410,
    code: "envelope_closed",
    message: "El sobre ya no está disponible",
    summary: "El sobre ya no está en curso para el firmante (anulado, vencido, completado o rechazado)",
  },
  form_inactive: {
    status: 410,
    code: "form_inactive",
    message: "Este formulario ya no está disponible",
    summary: "El formulario se desactivó o quien lo creó ya no puede crear sobres (o el plan ya no incluye formularios web). También form_expired (venció) y form_exhausted (llegó a su máximo de envíos)",
  },
  form_unavailable: {
    status: 410,
    code: "form_unavailable",
    message: "Este formulario ya no está disponible",
    summary: "El formulario dejó de estar disponible mientras se procesaba el envío",
  },
  form_misconfigured: {
    status: 409,
    code: "form_misconfigured",
    message: "Este formulario no está disponible",
    summary: "La plantilla cambió después de publicar el formulario y su configuración ya no la completa (lo corrige quien lo creó)",
  },
  template_has_forms_edit: {
    status: 409,
    code: "template_has_forms",
    message: 'El cambio dejaría sin funcionar el formulario web "Alta de clientes": desactivalo o ajustalo antes',
    details: { forms: [{ id: "0190f1a2-0000-7000-8000-000000000001", name: "Alta de clientes" }] },
    summary:
      "Cambiar roles o campos de la plantilla dejaría mal configurado un formulario web activo que hoy funciona (rol de quien lo completa que deja de firmar o de ir primero, prellenado o destinatario fijo de algo que ya no está, rol firmante sin campo de firma, fórmula colgada). details.forms lista esos formularios ({id, name}); los que ya estaban mal no bloquean",
  },
  same_person: { status: 409, code: "same_person", message: "No podés delegar en vos mismo", summary: "Delegar en el mismo correo del firmante" },
  certificate_in_use: {
    status: 409,
    code: "certificate_in_use",
    message: "El certificado sella 1 sobre(s) que se están finalizando: esperá a que terminen",
    summary: "El certificado es el sello de empresa de sobres que se están finalizando",
  },
  crm_account_unknown: {
    status: 409,
    code: "crm_account_unknown",
    message: "La conexión de pipedrive no tiene guardada su cuenta: probala (POST /v1/crm/connections/{id}/test) o volvé a conectarla",
    summary: "Conexión de Pipedrive o Kommo sin su cuenta guardada (conexiones viejas): probarla la guarda",
  },
  company_mismatch: {
    status: 409,
    code: "company_mismatch",
    message: "El mapeo es de otra cuenta de pipedrive (12345), no de la cuenta 67890 desde la que se envía",
    summary: "`companyId` no es la cuenta del CRM de la conexión del mapeo",
  },
  delivery_pending: { status: 409, code: "delivery_pending", message: "La entrega ya se está reintentando", summary: "La entrega tiene un intento en curso o un reintento manual ya pedido" },
  endpoint_inactive: {
    status: 409,
    code: "endpoint_inactive",
    message: "El webhook está desactivado: reactivalo para reintentar la entrega",
    summary: "El endpoint de la entrega está inactivo (pausado o desactivado por fallas, 410 o permisos)",
  },
  template_has_forms: {
    status: 409,
    code: "template_has_forms",
    message: "La plantilla tiene formularios web activos (Alta de clientes): quien los creó o un administrador tiene que desactivarlos o borrarlos antes",
    details: { webForms: 1, names: ["Alta de clientes"] },
    summary: "La plantilla tiene formularios web activos (se borrarían con ella)",
  },
  not_embedded: {
    status: 409,
    code: "not_embedded",
    message: "El destinatario no es embebido y no tiene otra autenticación: creá el destinatario con embedded: true o exigí un código (OTP)",
    summary: "URL de firma pedida para un destinatario no embebido que solo se autentica con el link por correo",
  },
  otp_not_embeddable: {
    status: 409,
    code: "otp_not_embeddable",
    message: "Un firmante con código OTP no se puede mostrar dentro de un iframe",
    summary: "Se pidieron frameAncestors para un firmante con código OTP (sin frameAncestors la URL sale para pestaña)",
  },
  not_draft: { status: 409, code: "not_draft", message: "Solo se puede modificar un sobre en borrador", summary: "El sobre ya no es un borrador" },
  not_editable: { status: 409, code: "not_editable", message: "El sobre ya está finalizado", summary: "El sobre ya no admite cambios de sello o nivel de firma (solo borrador o enviado; trabado en la finalización, solo el sello)" },
  idempotency_mismatch: {
    status: 409,
    code: "idempotency_mismatch",
    message: "Idempotency-Key reutilizada con otro pedido",
    summary: "Misma Idempotency-Key con otro método, URL o cuerpo",
  },
  idempotency_in_progress: {
    status: 409,
    code: "idempotency_in_progress",
    message: "Ya hay un pedido en curso con esta Idempotency-Key; reintentá en unos segundos",
    summary: "Otro pedido con la misma clave todavía se está procesando",
  },
  id_in_use: { status: 409, code: "id_in_use", message: "Id de destinatario en uso", summary: "Un id de cliente ya lo usa otro sobre" },
  not_voidable: { status: 409, code: "not_voidable", message: "Solo se puede anular un sobre enviado y en curso", summary: "Estado distinto de sent / awaiting_certificates" },
  not_in_progress: { status: 409, code: "not_in_progress", message: "El sobre no está en curso", summary: "El sobre no está en estado sent" },
  not_finalizing: { status: 409, code: "not_finalizing", message: "El sobre no está esperando la finalización", summary: "El sobre no está en finalizing" },
  finalize_in_progress: { status: 409, code: "finalize_in_progress", message: "La finalización ya está en curso", summary: "Ya hay una finalización encolada o corriendo" },
  not_available: { status: 409, code: "not_available", message: "El sobre no está en curso", summary: "Sobre no enviado o destinatario todavía no activo" },
  not_replaceable: {
    status: 409,
    code: "not_replaceable",
    message: "Este destinatario ya no está pendiente",
    summary: "No es firmante/aprobador pendiente (también invalid_channels, otp_destination_required)",
  },
  not_cancellable: { status: 409, code: "not_cancellable", message: "El envío ya terminó", summary: "El envío masivo ya terminó o se canceló" },
  nothing_to_retry: {
    status: 409,
    code: "nothing_to_retry",
    message: "No hay filas para reintentar",
    summary: "No hay filas fallidas reintentables (las de datos inválidos se corrigen en un envío nuevo; también not_retryable si se canceló)",
  },
  conflict: { status: 409, code: "conflict", message: "El recurso ya existe o cambió al mismo tiempo; reintentá", summary: "Carrera contra una restricción única" },
  role_conflict: { status: 409, code: "role_exists", message: "Ya existe un rol con ese nombre", summary: "Nombre repetido (role_exists / group_exists) o rol en uso (role_in_use)" },
  last_owner: { status: 409, code: "last_owner", message: "La organización tiene que tener al menos un propietario", summary: "Dejaría a la organización sin propietario" },
  already_member: { status: 409, code: "already_member", message: "Esa persona ya es miembro de la organización", summary: "Invitación a un miembro existente" },
  enable_2fa_first: {
    status: 409,
    code: "enable_2fa_first",
    message: "Activá tu verificación en dos pasos antes de exigirla a la organización",
    summary: "Exigir 2FA sin tenerlo activado",
  },

  recipient_immutable: {
    status: 409,
    code: "recipient_immutable",
    message: "Ana Pérez ya firmó o terminó su participación: no se puede modificar",
    summary: "Corrección no aplicable (también recipient_viewed, routing_passed, recipient_is_payer, id_in_use, not_in_progress)",
  },
  not_completed: { status: 409, code: "not_completed", message: "El sobre todavía no está completado", summary: "El documento final todavía no existe" },
  email_taken: { status: 409, code: "email_taken", message: "Ya existe una cuenta con ese correo", summary: "Correo ya registrado" },
  template_id_in_use: { status: 400, code: "id_in_use", message: "Id de rol en uso", summary: "Un id de rol ya lo usa otra plantilla" },
  invalid_contact: {
    status: 400,
    code: "invalid_contact",
    message: "Ana Pérez: el canal email requiere correo",
    summary: "Datos de contacto incompatibles con los canales o el método de autenticación (también invalid_field, invalid_expiry, no_changes)",
  },
  sso_required: {
    status: 403,
    code: "sso_required",
    message: "Tu organización exige ingresar con inicio de sesión único (SSO)",
    details: { startUrl: "/v1/auth/sso/start?org=acme&login_hint=ana%40acme.com" },
    summary: "La organización exige SSO (también password_reset_required)",
  },
  too_many_attempts: {
    status: 429,
    code: "too_many_attempts",
    message: "Demasiados intentos fallidos. Probá de nuevo en unos minutos o restablecé tu contraseña.",
    summary:
      "10 intentos en 15 minutos bloquean la cuenta: se cuentan antes de verificar y desde cualquier IP, y un acierto los borra. Vale para el login, aceptar una invitación con contraseña y el segundo paso (2FA). Además, 5 códigos fallidos en un mismo desafío de 2FA cortan ese desafío con 401 too_many_attempts (volver a ingresar la contraseña). Sin Retry-After: no reintentar en un loop.",
  },

  file_too_large: {
    status: 413,
    code: "file_too_large",
    message: "El archivo supera el tamaño máximo",
    details: { limit: "file" },
    summary:
      'Un archivo supera el máximo de subida (details.limit "file"), o los documentos del pedido o del sobre/plantilla superan el total admitido, 100 MB por sobre o plantilla (details.limit "total")',
  },
  payload_too_large: {
    status: 413,
    code: "payload_too_large",
    message: "El sobre (sin el base64 de los documentos) supera 2 MB",
    summary: "El JSON del sobre (la parte `payload`, o el cuerpo sin el base64 de los documentos) es demasiado grande",
  },

  logic_order: {
    status: 422,
    code: "logic_order",
    message: 'El campo "Monto" de Ana Pérez depende de un campo de Juan Gómez, que firma después o al mismo tiempo',
    details: {
      problems: ['El campo "Monto" de Ana Pérez depende de un campo de Juan Gómez, que firma después o al mismo tiempo'],
      issues: [
        {
          code: "logic_order",
          params: { field: "Monto", recipient: "Ana Pérez", source: "Juan Gómez" },
          message: 'El campo "Monto" de Ana Pérez depende de un campo de Juan Gómez, que firma después o al mismo tiempo',
        },
      ],
    },
    summary:
      "Una condición cita un campo de alguien que firma después o en el mismo turno (o de un rol así en la plantilla): se decidiría con un valor que todavía no existe. Solo se rechazan problemas nuevos: los que ya tenía el borrador o la plantilla no bloquean otras ediciones. details.problems es la lista de textos (en español) y details.issues trae cada uno con code (logic_order, o logic_order_formula si la dependencia pasa por una fórmula: params.formula), params y message",
  },
  envelope_incomplete: {
    status: 422,
    code: "envelope_incomplete",
    message: "Agregá al menos un documento. Ana Pérez no tiene ningún campo de firma",
    details: {
      problems: ["Agregá al menos un documento", "Ana Pérez no tiene ningún campo de firma"],
      issues: [
        { code: "no_documents", params: {}, message: "Agregá al menos un documento" },
        { code: "signer_without_signature", params: { name: "Ana Pérez" }, message: "Ana Pérez no tiene ningún campo de firma" },
      ],
    },
    summary:
      "El borrador no se puede enviar (o la corrección de un sobre en curso lo dejaría inválido): details.problems lista lo que falta como textos (en español; `message` del error los une) y details.issues trae cada uno con code, params y message. Códigos: no_documents, no_signers, no_active_signer, signer_without_signature {name}, expiry_past, too_many_attachment_fields {max}, too_many_recipients {max}, too_many_fields {max}, formula_missing_ref {field, refs}, payer_not_signer, logic_order {field, recipient, source}, logic_order_formula {field, recipient, source, formula}",
  },
  roles_missing: {
    status: 422,
    code: "roles_missing",
    message: "Faltan destinatarios para: Garante",
    details: { roles: ["Garante"] },
    summary: "No se asignó un destinatario a cada rol de la plantilla",
  },
  rows_invalid: {
    status: 422,
    code: "rows_invalid",
    message: "1 de 2 filas tienen errores",
    details: { total: 2, valid: 1, invalid: 1, errors: [{ row: 2, errors: ["Cliente.email: Invalid email"] }], columns: ["Cliente.name", "Cliente.email"] },
    summary: "Filas inválidas sin skipInvalid (details = BulkValidationResult)",
  },
  invalid_csv: {
    status: 422,
    code: "invalid_csv",
    message: "Columna \"Garante.email\": no hay ningún rol \"Garante\" en la plantilla",
    details: { fileErrors: ["Columna \"Garante.email\": no hay ningún rol \"Garante\" en la plantilla"], columns: ["Garante.email"] },
    summary: "Encabezados del CSV que no corresponden a la plantilla",
  },

  pdf_too_heavy: { status: 422, code: "pdf_too_heavy", message: "El PDF es demasiado pesado para leer su texto", summary: "No se pudo leer el texto del PDF para buscar las anclas" },
  pdf_reader_busy: {
    status: 503,
    code: "pdf_reader_busy",
    message: "Hay muchos documentos leyéndose en este momento; probá de nuevo en unos segundos",
    summary: "Lector de PDF saturado. Reintentable: repetir en unos segundos (con espera creciente)",
  },

  invalid_date: { status: 400, code: "invalid_date", message: "Fecha fuera de rango o inválida", summary: "Fecha que no existe o fuera del rango admitido (p. ej. año 0)" },
  too_many_replacements: {
    status: 409,
    code: "too_many_replacements",
    message: "Este sobre ya tuvo demasiadas delegaciones o reasignaciones",
    summary: "Tope de 20 delegaciones o reasignaciones por sobre",
  },
  member_changed: {
    status: 409,
    code: "member_changed",
    message: "El rol del miembro cambió mientras tanto: volvé a cargar y probá de nuevo",
    summary: "El rol del miembro cambió durante el pedido: volver a leerlo y repetir",
  },
  export_in_progress: { status: 409, code: "export_in_progress", message: "La exportación ya está en curso", summary: "La exportación está pendiente o subiéndose (solo se reintenta una fallida o una pendiente abandonada)" },
  archive_renewal_limit: {
    status: 409,
    code: "archive_renewal_limit",
    message: "El sobre llegó al máximo de 50 renovaciones del sello de archivo",
    summary: "Tope de 50 renovaciones del sello de archivo por sobre",
  },
  archive_not_due: {
    status: 409,
    code: "archive_not_due",
    message: "El sello de archivo todavía no está por vencer: se renueva solo cuando se acerca su vencimiento",
    summary: "Falta para el vencimiento del sello de archivo, o renovar no lo extendería (el sello ya es del certificado vigente de la TSA)",
  },
  archive_not_applicable: {
    status: 409,
    code: "archive_not_applicable",
    message: "El PDF no tiene datos de validación a largo plazo (B-LT/B-LTA): no hay sello de archivo que renovar",
    summary: "El PDF no es de archivo (B-B/B-T) o el nivel de la organización no lo completa a B-LTA",
  },
  archive_renewal_in_progress: {
    status: 409,
    code: "archive_renewal_in_progress",
    message: "Ya hay una renovación del sello de archivo en curso para este sobre",
    summary: "Una renovación a la vez por sobre",
  },
  version_changed_negotiation: {
    status: 409,
    code: "version_changed",
    message: "Hay una versión nueva: revisala y repetí",
    summary: "La negociación tiene una versión nueva desde la que se revisó: revisarla y repetir",
  },
  version_changed: {
    status: 409,
    code: "version_changed",
    message: "Este borrador cambió en otra pestaña o lo editó otra persona: recargá para ver la versión actual",
    details: { updatedAt: "2026-05-04T13:00:00.000Z" },
    summary:
      "El borrador del sobre, la plantilla o el sobre en curso (al anular o recordar) cambió desde que se leyó: X-Expected-Updated-At no coincide con su updatedAt (details.updatedAt trae el actual; recargar y repetir)",
  },
  purged: {
    status: 410,
    code: "purged",
    message: "El original se eliminó por la política de retención; el PDF firmado sigue disponible",
    summary: "Los originales del sobre se borraron por la política de retención (retentionDays); el PDF firmado y la evidencia se conservan",
  },
  purged_clone: {
    status: 409,
    code: "purged",
    message: "Los originales de este sobre se eliminaron por la política de retención: no se puede clonar",
    summary: "No se puede clonar: los originales del sobre se borraron por la política de retención",
  },
  proposal_outdated: {
    status: 409,
    code: "proposal_outdated",
    message: "El texto cambió desde que se hizo la propuesta: rechazala y pedí una nueva",
    summary: "El texto cambió desde la propuesta: no se puede aceptar (rechazarla y pedir otra)",
  },
  ai_input_too_large: {
    status: 413,
    code: "ai_input_too_large",
    message: "El documento es demasiado largo para la asistencia con IA",
    details: { estimatedTokens: 250000, max: 150000 },
    summary: "Documento demasiado largo para la IA",
  },
  reminder_daily_limit: {
    status: 429,
    code: "reminder_daily_limit",
    message: "Ya se mandaron 5 recordatorios en las últimas 24 horas: probá mañana",
    summary: "Tope de recordatorios manuales por sobre en 24 horas (5 por defecto). Sin Retry-After: no reintentar en un loop.",
  },
  ai_budget_exceeded: {
    status: 429,
    code: "ai_budget_exceeded",
    message: "Se agotó el presupuesto mensual de IA de la organización",
    summary: "Presupuesto mensual de tokens de IA agotado (el efectivo es min(presupuesto de la organización, tope del plan)). Sin Retry-After.",
  },
  reminded_recently: {
    status: 429,
    code: "reminded_recently",
    message: "Ya se mandó un recordatorio hace unos minutos: esperá un poco antes de mandar otro",
    summary: "Un recordatorio manual cada 10 minutos por sobre. Sin Retry-After: no reintentar en un loop.",
  },
  form_rate_limited: {
    status: 429,
    code: "form_rate_limited",
    message: "Demasiados envíos de este formulario: probá más tarde",
    summary: "Tope de 60 sobres por hora por formulario web. Sin Retry-After.",
  },
  workflow_rate_limited: {
    status: 429,
    code: "workflow_rate_limited",
    message: "Demasiadas ejecuciones de este workflow: probá más tarde",
    summary: "Tope de 60 ejecuciones públicas por hora por workflow, y uno por organización compartido con los formularios web (por hora y por día). Sin Retry-After.",
  },
  captcha_failed: {
    status: 400,
    code: "captcha_failed",
    message: "No se pudo verificar que no sos un robot: completá la verificación y volvé a intentar",
    summary: "Falta o no es válido el token de Cloudflare Turnstile (captchaToken), exigido cuando GET devuelve captchaSiteKey",
  },
  workflow_inactive: {
    status: 410,
    code: "workflow_inactive",
    message: "Este formulario ya no está disponible",
    summary: "El workflow se desactivó o, en una ejecución pública, se despublicó o el plan ya no incluye web_forms",
  },
  too_fast: {
    status: 422,
    code: "too_fast",
    message: "Esperá unos segundos y volvé a enviar",
    summary: "Enviado antes del tiempo mínimo de llenado (2,5 s): reintentar en unos segundos",
  },
  form_recent_submission: {
    status: 429,
    code: "form_recent_submission",
    message: "Ya recibimos un envío igual hace unos minutos: revisá la pestaña donde completaste el formulario o probá más tarde",
    details: { retryAfterSeconds: 600 },
    summary: "El mismo correo desde la misma IP (en IPv6, el /64) ya completó otra ejecución del workflow hace poco",
  },
  too_many_comments: {
    status: 429,
    code: "too_many_comments",
    message: "La negociación llegó al máximo de 500 comentarios",
    summary: "Tope de 500 comentarios de las contrapartes por negociación (100 por contraparte) y otros 500 del remitente y su equipo",
  },
  too_many_proposals: {
    status: 429,
    code: "too_many_proposals",
    message: "Tenés 20 propuestas sin decidir: esperá a que las revisen",
    summary: "Tope de 20 propuestas pendientes por participante",
  },
  archive_recently_renewed: {
    status: 429,
    code: "archive_recently_renewed",
    message: "El sello de archivo de este sobre ya se renovó varias veces hoy",
    summary: "Tope de 3 renovaciones del sello de archivo por día y sobre. Sin Retry-After.",
  },
  ai_signer_limit: {
    status: 429,
    code: "ai_signer_limit",
    message: "Llegaste al máximo de consultas a la IA para este documento",
    summary: "Tope por firmante: 30 consultas por día y 100 en total. Sin Retry-After.",
  },
  tsa_unavailable: {
    status: 502,
    code: "tsa_unavailable",
    message: "La autoridad de sellado de tiempo no respondió como se esperaba: reintentá en unos minutos",
    summary: "La TSA externa falló. Reintentable: repetir en unos minutos",
  },
  ai_unavailable_upstream: {
    status: 502,
    code: "ai_unavailable",
    message: "No se pudo contactar al proveedor de IA",
    summary: "El proveedor de IA no respondió (error de red o del proveedor). Reintentable más tarde",
  },
  ai_unavailable: {
    status: 503,
    code: "ai_unavailable",
    message: "La IA no está disponible en este servidor",
    summary: "El servidor no tiene proveedor de IA configurado. No reintentar: no se resuelve solo",
  },
  ai_rate_limited: {
    status: 503,
    code: "ai_rate_limited",
    message: "El proveedor de IA está saturado; probá de nuevo en un momento",
    summary: "El proveedor de IA está saturado. Reintentable: repetir en unos segundos (con espera creciente)",
  },
  ai_timeout: {
    status: 504,
    code: "ai_timeout",
    message: "El proveedor de IA no respondió a tiempo; probá de nuevo más tarde",
    summary: "El proveedor de IA no respondió a tiempo (el consumo estimado se descuenta igual). Reintentable más tarde",
  },
  storage_unavailable: {
    status: 503,
    code: "storage_unavailable",
    message: "El almacenamiento de documentos no está disponible en este momento. Probá de nuevo en unos minutos.",
    summary: "Falla transitoria del almacenamiento de documentos (o de KMS). Reintentable: repetir en unos minutos. Puede pasar en cualquier ruta que lee o guarda archivos",
  },
  byok_key_unavailable: {
    status: 503,
    code: "byok_key_unavailable",
    message: "La clave de cifrado de tu organización (BYOK) no está disponible: no se pueden guardar ni leer documentos hasta que se restablezca el acceso a la clave.",
    details: { keyArn: "arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab", cause: "AccessDeniedException" },
    summary: "La clave KMS propia de la organización (BYOK) está deshabilitada o sin permiso para CalaSign. NO reintentar: requiere que un administrador restablezca el acceso a la clave (Ajustes → Datos)",
  },
  wrong_cell: {
    status: 421,
    code: "wrong_cell",
    message: "Los datos de esta organización están en otra región",
    details: { cell: "eu", baseUrl: "https://eu.calasign.com" },
    summary: "La organización está en otra celda (región): repetir el pedido en details.baseUrl (el header Location trae la URL completa). details.baseUrl puede ser null si esa celda no tiene URL propia",
  },

  rate_limited: {
    status: 429,
    code: "rate_limited",
    message: "Demasiados pedidos seguidos: esperá 42 s y reintentá",
    summary: "Límite de pedidos por IP superado: esperar lo que indica Retry-After (segundos) y reintentar. Versiones anteriores de la API respondían este 429 con el código bad_request.",
  },
};

const STATUS_TEXT: Record<number, string> = {
  400: "Pedido inválido",
  401: "No autenticado",
  402: "Límite del plan (plan_limit)",
  403: "Sin permiso",
  404: "No encontrado",
  409: "Conflicto con el estado actual",
  410: "Ya no disponible",
  413: "Contenido demasiado grande",
  421: "Organización en otra región (wrong_cell)",
  422: "No procesable",
  429: "Demasiados pedidos",
  502: "Servicio externo no disponible",
  503: "Servicio no disponible por ahora",
  504: "Servicio externo sin respuesta",
};

/** Respuestas comunes en components.responses (nombre → status y códigos de ejemplo). */
const COMMON: { name: string; status: number; codes: string[] }[] = [
  { name: "BadRequest", status: 400, codes: ["validation_error"] },
  { name: "InvalidId", status: 400, codes: ["invalid_id"] },
  { name: "BadRequestOrInvalidId", status: 400, codes: ["validation_error", "invalid_id"] },
  { name: "Unauthorized", status: 401, codes: ["unauthorized"] },
  { name: "PaymentRequired", status: 402, codes: ["plan_limit_api"] },
  { name: "Forbidden", status: 403, codes: ["forbidden", "insufficient_scope", "two_factor_setup_required"] },
  { name: "ForbiddenNoOAuth", status: 403, codes: ["forbidden", "oauth_denied", "two_factor_setup_required"] },
  { name: "NotFound", status: 404, codes: ["not_found"] },
  { name: "TooManyRequests", status: 429, codes: ["rate_limited"] },
  // Globales: pueden pasar en cualquier ruta (no se repiten en cada operación; ver info.description).
  { name: "InvalidText", status: 400, codes: ["invalid_text"] },
  { name: "BadOrigin", status: 403, codes: ["bad_origin"] },
  { name: "WrongCell", status: 421, codes: ["wrong_cell"] },
  { name: "StorageUnavailable", status: 503, codes: ["storage_unavailable", "byok_key_unavailable"] },
];

const RATE_HEADERS = {
  "Retry-After": { $ref: "#/components/headers/RetryAfter" },
  "X-RateLimit-Limit": { $ref: "#/components/headers/RateLimitLimit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/RateLimitRemaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/RateLimitReset" },
};

const LOCATION_HEADER = { Location: { description: "URL del mismo pedido en el despliegue que atiende la celda de la organización (si tiene URL propia).", schema: { type: "string" } } };

function errorResponse(status: number, codes: string[]) {
  const examples = Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/examples/${c}` }]));
  return {
    description: STATUS_TEXT[status] ?? "Error",
    ...(status === 429 ? { headers: RATE_HEADERS } : status === 421 ? { headers: LOCATION_HEADER } : {}),
    content: { "application/json": { schema: ref("Error"), examples } },
  };
}

export function errorComponents() {
  const examples: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(ERRORS)) {
    examples[k] = { summary: e.summary, value: { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } } };
  }
  const responses: Record<string, unknown> = {};
  for (const c of COMMON) responses[c.name] = errorResponse(c.status, c.codes);
  responses.OAuthError = {
    description: "Error OAuth (RFC 6749): invalid_request, invalid_grant, invalid_scope, unauthorized_client, unsupported_grant_type (400) o invalid_client (401)",
    content: { "application/json": { schema: ref("OAuthError"), example: { error: "invalid_grant", error_description: "El código venció o ya se usó" } } },
  };
  const int = (description: string) => ({ description, schema: { type: "integer" } });
  return {
    examples,
    responses,
    headers: {
      RetryAfter: int("Segundos hasta que se renueva la ventana. Solo en el 429 del límite por IP: los 429 con código propio (topes de negocio como reminded_recently) no lo traen y no se reintentan en un loop."),
      RateLimitLimit: int("Pedidos permitidos en la ventana (600/min por IP en general; algunas rutas tienen un límite menor)."),
      RateLimitRemaining: int("Pedidos que quedan en la ventana actual."),
      RateLimitReset: int("Segundos hasta que se renueva la ventana."),
      IdempotentReplay: { description: "\"true\" cuando la respuesta es la guardada de un pedido anterior con la misma Idempotency-Key.", schema: { type: "string", enum: ["true"] } },
    },
  };
}

/**
 * Errores de una operación: los comunes de su clase (autenticación, plan, validación, 404, 429) más los propios.
 * Solo se declaran los que pueden pasar de verdad para esa clase de operación.
 */
export function errorResponses(op: Op, oauthDenied: boolean): Record<string, unknown> {
  const byStatus = new Map<number, Set<string>>();
  const add = (code: string) => {
    const e = ERRORS[code];
    if (!e) throw new Error(`OpenAPI: código de error desconocido ${code} (${op.method} ${op.path})`);
    if (!byStatus.has(e.status)) byStatus.set(e.status, new Set());
    byStatus.get(e.status)!.add(code);
  };
  const auth = op.auth ?? "key";
  const hasPath = /\{\w+\}/.test(op.path);
  if (auth === "client") {
    // /oauth/*: errores RFC 6749, no el formato de la API.
    return { "400": { $ref: "#/components/responses/OAuthError" }, "401": { $ref: "#/components/responses/OAuthError" }, "429": { $ref: "#/components/responses/TooManyRequests" } };
  }
  // Registro dinámico: errores RFC 7591 con el mismo formato { error, error_description }; no autentica cliente (sin 401).
  if (op.path === "/oauth/register") {
    return { "400": { $ref: "#/components/responses/OAuthError" }, "429": { $ref: "#/components/responses/TooManyRequests" } };
  }
  if (auth === "key") {
    add("unauthorized");
    add("forbidden");
    add(oauthDenied ? "oauth_denied" : "insufficient_scope");
    if (!/^\/v1\/(me|auth)(\/|$)/.test(op.path)) add("two_factor_setup_required");
    if (!/^\/v1\/(me|billing)(\/|$)/.test(op.path)) add("plan_limit_api");
  }
  if (op.body || op.form || op.query?.length) add("validation_error");
  if (hasPath) {
    add("not_found");
    // Fuera de sobres y plantillas (que responden 404), un id que no es UUID llega a Postgres como 400 invalid_id.
    if (auth === "key" && !/^\/v1\/(envelopes|templates)\/\{id\}/.test(op.path)) add("invalid_id");
  }
  if (op.idempotent) {
    add("invalid_idempotency_key");
    add("idempotency_mismatch");
    add("idempotency_in_progress");
  }
  if (op.multipart) {
    add("file_required");
    add("file_too_large");
  }
  for (const c of op.errors ?? []) add(c);
  add("rate_limited");

  const out: Record<string, unknown> = {};
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const codes = [...byStatus.get(status)!];
    const common = COMMON.find((c) => c.status === status && c.codes.length === codes.length && c.codes.every((x) => codes.includes(x)));
    out[String(status)] = common ? { $ref: `#/components/responses/${common.name}` } : errorResponse(status, codes);
  }
  return out;
}

// ───────────────────────────── Parámetros ─────────────────────────────

const ID_NOUNS: [RegExp, string, boolean, string][] = [
  [/^\/v1\/envelopes\//, "del sobre", true, "EnvelopeId"],
  [/^\/v1\/templates\//, "de la plantilla", true, "TemplateId"],
  [/^\/v1\/webhooks\//, "del webhook", true, "WebhookId"],
  [/^\/v1\/webhook-deliveries\//, "de la entrega", true, "WebhookDeliveryId"],
  [/^\/v1\/bulk-sends\//, "del envío masivo", true, "BulkSendId"],
  [/^\/v1\/web-forms\//, "del formulario", true, "WebFormId"],
  [/^\/v1\/api-keys\//, "de la API key", true, "ApiKeyId"],
  [/^\/v1\/oauth\/apps\//, "de la app OAuth", true, "OAuthAppId"],
  [/^\/v1\/notification-integrations\//, "de la integración", true, "NotificationIntegrationId"],
  [/^\/v1\/storage\/connections\//, "de la conexión", true, "StorageConnectionId"],
  [/^\/v1\/storage\/exports\//, "de la exportación", true, "StorageExportId"],
  [/^\/v1\/certificates\//, "del certificado", true, "CertificateId"],
  [/^\/v1\/signature-providers\//, "del conector de firma", false, "SignatureProviderId"],
  [/^\/v1\/invitations\//, "de la invitación", true, "InvitationId"],
  [/^\/v1\/roles\//, "del rol personalizado", true, "RoleId"],
  [/^\/v1\/groups\//, "del grupo", true, "GroupId"],
  [/^\/v1\/crm\/connections\//, "de la conexión", true, "CrmConnectionId"],
  [/^\/v1\/crm\/mappings\//, "del mapeo", true, "CrmMappingId"],
  [/^\/v1\/crm\/runs\//, "de la ejecución", true, "CrmRunId"],
  [/^\/v1\/connectors\/connections\//, "de la conexión", true, "ConnectorConnectionId"],
  [/^\/v1\/connectors\/flows\//, "del flujo", true, "ConnectorFlowId"],
  [/^\/v1\/connectors\/runs\//, "de la ejecución", true, "ConnectorRunId"],
  [/^\/v1\/agreements\//, "del acuerdo", true, "AgreementId"],
  [/^\/v1\/agreement-fields\//, "del campo", true, "AgreementFieldId"],
  [/^\/v1\/agreement-views\//, "de la vista", true, "AgreementViewId"],
  [/^\/v1\/document-templates\//, "de la plantilla de documento", true, "DocumentTemplateId"],
  [/^\/v1\/clauses\//, "de la cláusula", true, "ClauseId"],
  [/^\/v1\/workflows\//, "del workflow", true, "WorkflowId"],
  [/^\/v1\/workflow-runs\//, "de la ejecución", true, "WorkflowRunId"],
  [/^\/v1\/negotiations\//, "de la negociación", true, "NegotiationId"],
  [/^\/v1\/settings\/scim\/tokens\//, "del token SCIM", true, "ScimTokenId"],
];

const NAMED_PARAMS: Record<string, [string, boolean]> = {
  documentId: ["Id del documento", true],
  recipientId: ["Id del destinatario", true],
  envelopeId: ["Id del sobre", true],
  userId: ["Id del usuario", true],
  proposalId: ["Id de la propuesta", true],
  token: ["Token del link (lo recibe el destinatario en su invitación)", false],
  code: ["Código de un solo uso de la sesión del Firmador (10 minutos)", false],
  provider: ["Proveedor", false],
  domain: ["Dominio", false],
  slug: ["Slug público", false],
  index: ["Índice del paso (desde 0)", false],
  commentId: ["Id del comentario", true],
  fieldId: ["Id del campo", true],
  clientId: ["client_id de la app OAuth", false],
  address: ["Dirección de correo", false],
  kind: ["Tipo de captura", false],
};

/** Parámetros de ruta reutilizados: nombre en components.parameters → definición. */
export const PATH_PARAMETERS: Record<string, Record<string, unknown>> = {};

function pathParam(path: string, name: string): Record<string, unknown> {
  let [description, isUuid] = NAMED_PARAMS[name] ?? ["", false];
  if (name === "id") {
    const hit = ID_NOUNS.find(([re]) => re.test(path));
    description = hit ? `Id ${hit[1]}` : "Id del recurso";
    isUuid = hit ? hit[2] : false;
  }
  if (name === "index") return { name, in: "path", required: true, description, schema: { type: "integer", minimum: 0 } };
  return { name, in: "path", required: true, ...(description ? { description: isUuid ? `${description} (UUID)` : description } : {}), schema: isUuid ? { type: "string", format: "uuid" } : { type: "string" } };
}

/** Parámetros de ruta como $ref a components.parameters (se registran al usarlos). */
export function pathParams(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => {
    const def = pathParam(path, m[1]);
    const key = m[1] === "id" ? (ID_NOUNS.find(([re]) => re.test(path))?.[3] ?? "ResourceId") : `${pascal(m[1])}Path`;
    const prev = PATH_PARAMETERS[key];
    if (prev && JSON.stringify(prev) !== JSON.stringify(def)) throw new Error(`OpenAPI: parámetro ${key} con dos definiciones`);
    PATH_PARAMETERS[key] = def;
    return { $ref: `#/components/parameters/${key}` };
  });
}

export function queryParams(q: QueryParam[] | undefined) {
  return (q ?? []).map((p) => ({ name: p.name, in: "query", required: p.required ?? false, description: p.description, schema: p.schema ?? { type: "string" } }));
}

// ───────────────────────────── operationId ─────────────────────────────

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

/** operationId determinístico desde método y ruta: GET /v1/crm/mappings/{id} → getCrmMappingsById. */
export function autoOperationId(method: string, path: string) {
  const parts = path
    .split("/")
    .filter((p) => p && p !== "v1")
    .map((p) => (p.startsWith("{") ? `By${pascal(p.slice(1, -1))}` : pascal(p)));
  return method + parts.join("");
}

// ───────────────────────────── Ops de otros módulos ─────────────────────────────

const LIMIT = (def: number, max: number): QueryParam => ({
  name: "limit",
  description: `Cantidad máxima de resultados (1..${max}, por defecto ${def}).`,
  schema: { type: "integer", minimum: 1, maximum: max, default: def },
});
const AGREEMENT_FILTERS: QueryParam[] = [
  { name: "q", description: "Texto completo (sin distinguir acentos)." },
  { name: "status", description: "Estado del acuerdo." },
  { name: "source", description: "Origen del acuerdo." },
  { name: "tag", description: "Etiqueta." },
  { name: "counterparty", description: "Contraparte." },
  { name: "expiresWithinDays", description: "Solo los que vencen dentro de N días.", schema: { type: "integer" } },
  { name: "viewId", description: "Aplica los filtros de una vista guardada.", schema: { type: "string", format: "uuid" } },
];

/** Parámetros de query de operaciones definidas en otros módulos (ai, acuerdos, CRM). Clave: "método ruta". */
export const EXTRA_QUERY: Record<string, QueryParam[]> = {
  "get /v1/envelopes/{id}/ai/preview": [
    { name: "feature", description: "Funcionalidad cuyo texto se previsualiza (por defecto summary).", schema: { type: "string", enum: ["detect_fields", "summary", "ask", "extract_metadata", "playbook_review"] } },
    { name: "documentId", description: "Solo ese documento del sobre.", schema: { type: "string", format: "uuid" } },
  ],
  "get /v1/agreements": [
    ...AGREEMENT_FILTERS,
    { name: "cursor", description: "nextCursor de la página anterior." },
    LIMIT(25, 100),
  ],
  "get /v1/agreements/export.csv": AGREEMENT_FILTERS,
  "get /v1/crm/mappings": [
    { name: "connectionId", description: "Solo los mapeos de esa conexión.", schema: { type: "string", format: "uuid" } },
    {
      name: "provider",
      description: "Solo mapeos de conexiones activas de ese proveedor.",
      schema: { type: "string", enum: [...CRM_PROVIDERS] },
    },
    {
      name: "companyId",
      description:
        "Con provider pipedrive o kommo: solo conexiones de esa cuenta del CRM (company_id de Pipedrive, id de cuenta de Kommo); las que no la tienen guardada no se incluyen (ver connectionsWithoutAccount).",
      schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
    },
  ],
  "get /v1/crm/links": [{ name: "envelopeId", description: "Sobre cuyos vínculos se listan.", required: true, schema: { type: "string", format: "uuid" } }],
  "get /v1/crm/runs": [
    { name: "connectionId", description: "Solo esa conexión.", schema: { type: "string", format: "uuid" } },
    { name: "envelopeId", description: "Solo ese sobre.", schema: { type: "string", format: "uuid" } },
    { name: "status", description: "Estado de la ejecución.", schema: { type: "string", enum: ["pending", "succeeded", "failed"] } },
    LIMIT(50, 200),
  ],
  "get /v1/connectors/flows": [{ name: "connectionId", description: "Solo los flujos de esa conexión.", schema: { type: "string", format: "uuid" } }],
  "get /v1/connectors/links": [{ name: "envelopeId", description: "Sobre cuyos vínculos se listan.", required: true, schema: { type: "string", format: "uuid" } }],
  "get /v1/connectors/connections/{id}/records": [
    { name: "q", description: "Texto a buscar (nombre, correo o título)." },
    { name: "objectType", description: "Tipo de registro (por defecto el primero del proveedor).", schema: { type: "string", enum: ["employee", "workflow", "record", "contract"] } },
  ],
  "get /v1/connectors/runs": [
    { name: "connectionId", description: "Solo esa conexión.", schema: { type: "string", format: "uuid" } },
    { name: "envelopeId", description: "Solo ese sobre.", schema: { type: "string", format: "uuid" } },
    { name: "status", description: "Estado de la ejecución.", schema: { type: "string", enum: ["pending", "succeeded", "failed"] } },
    LIMIT(50, 200),
  ],
  "get /v1/workflow-runs": [
    { name: "workflowId", description: "Solo las ejecuciones de ese workflow.", schema: { type: "string", format: "uuid" } },
    { name: "status", description: "Estados separados por coma." },
  ],
  "get /v1/negotiations": [{ name: "status", description: "Estado de la negociación." }],
  "get /v1/public/negotiations/{token}/diff": [
    { name: "from", description: "Versión inicial (por defecto la anterior a la actual).", schema: { type: "integer" } },
    { name: "to", description: "Versión final (por defecto la actual).", schema: { type: "integer" } },
  ],
  "get /v1/negotiations/{id}/diff": [
    { name: "from", description: "Versión inicial (por defecto la anterior a la actual).", schema: { type: "integer" } },
    { name: "to", description: "Versión final (por defecto la actual).", schema: { type: "integer" } },
  ],
};

/** Descripciones de otros módulos que solo enumeraban la query (ahora son parámetros). */
export const EXTRA_DESCRIPTION: Record<string, string | null> = {
  "get /v1/envelopes/{id}/ai/preview": null,
  "get /v1/agreements": "Además de los filtros listados, `f.<campo>=valor` filtra por un campo propio (uno por campo).",
  "get /v1/agreements/export.csv": "Mismos filtros que la búsqueda (incluido `f.<campo>=valor`).",
  "get /v1/crm/links": null,
  "get /v1/crm/runs": null,
  "get /v1/connectors/flows": null,
  "get /v1/connectors/links": null,
  "get /v1/connectors/connections/{id}/records": null,
  "get /v1/connectors/runs": null,
  "get /v1/workflow-runs": null,
  "get /v1/negotiations/{id}/diff": null,
};

// ───────────────────────────── Tags ─────────────────────────────

export const TAGS: [string, string][] = [
  ["Sobres", "Crear un sobre (documentos, destinatarios y campos), enviarlo y seguirlo hasta el PDF final sellado."],
  ["Plantillas", "Documentos, roles y campos reutilizables; crear sobres desde una plantilla en un solo pedido."],
  ["Firma embebida", "Firma dentro de la app del integrador: URL de un solo uso para iframe o redirección."],
  ["Webhooks", "Endpoints que reciben los eventos de los sobres, firmados con HMAC-SHA256."],
  ["Eventos", "Actividad de la organización para reconciliar sin depender de los webhooks: polling con cursor y Server-Sent Events."],
  ["Envío masivo", "Una plantilla + N filas (CSV o JSON) → N sobres, procesados en segundo plano."],
  ["Formularios web", "Links públicos desde una plantilla: quien entra se registra y firma su propio sobre."],
  ["Cobros", "Cobrar al firmante (antes o después de firmar) con Stripe o Mercado Pago."],
  ["Firma en persona", "Firma en el dispositivo de un anfitrión de la organización."],
  ["Verificación de identidad", "Verificación de identidad (KYC) del firmante antes de ver los documentos."],
  ["Firma con certificado", "Firma con el certificado digital propio del firmante mediante el Firmador CalaSign."],
  ["Evidencia", "Nivel PAdES, certificados de la organización, sello de empresa y validación/verificación pública de PDFs."],
  ["Firma XML", "Firma y verificación XML para facturación electrónica (DGII, DIAN, SUNAT, XAdES)."],
  ["IA", "Detección de campos, resúmenes, preguntas y revisión contra un playbook."],
  ["Repositorio de acuerdos", "Búsqueda y metadatos de los acuerdos firmados y externos."],
  ["Documentos generados", "Plantillas de documentos con variables y cláusulas que generan el PDF y el sobre."],
  ["Workflows", "Flujos de aprobación y recolección de datos antes de firmar."],
  ["Negociación", "Redlining y propuestas entre las partes antes de firmar."],
  ["CRM y ERP", "HubSpot, Salesforce, Siigo y Alegra: enviar desde un registro y devolver el resultado."],
  ["RR. HH. y contratos", "BambooHR, HiBob, Factorial, Ironclad y Juro: enviar desde un empleado o contrato y devolver el documento firmado con su evidencia."],
  ["Avisos a canales", "Avisos de eventos de sobres a canales de Slack, Microsoft Teams, Discord, Google Chat, Mattermost, Rocket.Chat o Webex (webhook entrante)."],
  ["Almacenamiento", "Copia automática de los PDF firmados a Google Drive, Dropbox, OneDrive o S3."],
  ["Reportes", "Estadísticas de actividad y exportación de sobres."],
  ["OAuth 2.0", "Apps OAuth y tokens (client_credentials, authorization_code con PKCE, refresh_token)."],
  ["Identidad", "Cuenta, sesión y API keys."],
  ["Equipo", "Miembros, invitaciones, roles y permisos, grupos y visibilidad compartida; SSO, aprovisionamiento SCIM y direcciones suprimidas por quejas."],
  ["Auditoría", "Registro de acciones administrativas de la cuenta."],
  ["Marca", "Color, logo y pie de correo de la organización."],
  ["Dominio propio", "Dominio de la organización para los links de firma."],
  ["Datos", "Región de los datos, clave KMS propia (BYOK) y archivo a largo plazo."],
  ["Firmante", "Lo que usa la página de firma con el token del link del destinatario (no lo llama el integrador)."],
];

// ───────────────────────────── Webhooks salientes (OpenAPI 3.1) ─────────────────────────────

const WEBHOOK_TEXT: Record<string, string> = {
  "envelope.sent": "El sobre se envió (salen las invitaciones del primer grupo).",
  "envelope.completed": "Firmaron todos y el PDF final sellado está disponible (signedSha256).",
  "envelope.declined": "Un destinatario rechazó y el sobre terminó (data.reason; también llega recipient.declined).",
  "envelope.voided": "El remitente anuló el sobre.",
  "envelope.expired": "El sobre venció sin completarse.",
  "recipient.viewed": "Un destinatario abrió el sobre (data.recipientId).",
  "recipient.signed": "Un destinatario firmó (data.recipientId).",
  "recipient.declined": "Un destinatario rechazó (data.recipientId, data.reason).",
  "recipient.approved": "Un aprobador aprobó (data.recipientId).",
  "webhook.test": "Evento de prueba (POST /v1/webhooks/{id}/test); data.envelope es null.",
};

export function webhooksObject() {
  const header = (name: string, description: string) => ({ name, in: "header", required: true, description, schema: { type: "string" } });
  const params = [
    header(
      "CalaSign-Signature",
      "t=<unix>,v1=<hex>. v1 = HMAC-SHA256(secreto whsec_…, \"<t>.<cuerpo crudo>\"). Durante el período de gracia de una rotación (POST /v1/webhooks/{id}/rotate-secret) lleva un v1 por secreto vigente (t=…,v1=<nuevo>,v1=<anterior>): aceptar si alguno coincide. Verificar con el cuerpo tal cual llega y rechazar timestamps viejos. Se recalcula en cada intento.",
    ),
    header("CalaSign-Event-Id", "Id del evento (= cuerpo.id). Igual en todos los reintentos y en todos los endpoints que lo reciben: usarlo para deduplicar."),
    header("CalaSign-Event-Type", "Tipo de evento (= cuerpo.type)."),
    header("CalaSign-Delivery-Id", "Id de la entrega (una por endpoint); es el que se reintenta con POST /v1/webhook-deliveries/{id}/retry."),
  ];
  const out: Record<string, unknown> = {};
  for (const [type, text] of Object.entries(WEBHOOK_TEXT)) {
    out[type] = {
      post: {
        operationId: `webhook${pascal(type)}`,
        tags: ["Webhooks"],
        summary: type,
        description:
          `${text} POST JSON a la URL del endpoint, con timeout de 10 s y sin seguir redirecciones. ` +
          "Cualquier respuesta fuera de 2xx (o un error de red) es un fallo: se reintenta hasta 8 intentos en total con espera exponencial (5 s, 10 s, 20 s… 320 s; unos 10 minutos en total). " +
          "Agotados los intentos la entrega queda en status failed y se puede reenviar con POST /v1/webhook-deliveries/{id}/retry. " +
          "El orden de llegada no está garantizado.",
        parameters: params,
        requestBody: { required: true, content: { "application/json": { schema: ref("WebhookEvent") } } },
        responses: { "2XX": { description: "Recibido. El cuerpo de la respuesta se guarda (primeros 1000 caracteres) en la entrega." } },
      },
    };
  }
  return out;
}
