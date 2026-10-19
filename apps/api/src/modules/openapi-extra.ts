// Piezas del OpenAPI que no son operaciones: conversión Zod → JSON Schema con $ref a components.schemas,
// catálogo de errores (con ejemplos reales del setErrorHandler de app.ts), tags, parámetros y operationId.
import type { ZodTypeAny } from "zod";
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
  invalid_pdf: {
    status: 400,
    code: "not_pdf",
    message: "El archivo no es un PDF",
    summary: "PDF inválido. Otros códigos: encrypted, empty, too_many_pages, unreadable, ambiguous_pdf",
  },
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
  too_many_webhooks: { status: 400, code: "too_many_webhooks", message: "Máximo 20 webhooks por organización", summary: "Tope de 20 endpoints" },
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

  payment_required: {
    status: 402,
    code: "payment_required",
    message: "Para firmar primero hay que completar el pago",
    details: { amount: 15000, currency: "COP", description: "Honorarios" },
    summary: "Cobro before_sign pendiente",
  },
  identity_required: { status: 403, code: "identity_required", message: "Hace falta verificar tu identidad para continuar", summary: "Falta la verificación de identidad del firmante" },
  not_found: { status: 404, code: "not_found", message: "Sobre no encontrado", summary: "No existe o la credencial no puede verlo (el mensaje nombra el recurso)" },

  not_draft: { status: 409, code: "not_draft", message: "Solo se puede modificar un sobre en borrador", summary: "El sobre ya no es un borrador" },
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
    summary: "10 intentos fallidos en 15 minutos bloquean la cuenta (aunque vengan de IPs distintas)",
  },

  file_too_large: { status: 413, code: "file_too_large", message: "El archivo supera el tamaño máximo", summary: "Archivo más grande que el máximo permitido" },

  envelope_incomplete: {
    status: 422,
    code: "envelope_incomplete",
    message: "Agregá al menos un documento. Ana Pérez no tiene ningún campo de firma",
    details: { problems: ["Agregá al menos un documento", "Ana Pérez no tiene ningún campo de firma"] },
    summary: "El borrador no se puede enviar: details.problems lista lo que falta",
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
  pdf_reader_busy: { status: 503, code: "pdf_reader_busy", message: "Hay muchos documentos leyéndose en este momento; probá de nuevo en unos segundos", summary: "Lector de PDF saturado: reintentar" },

  rate_limited: {
    status: 429,
    code: "bad_request",
    message: "Rate limit exceeded, retry in 1 minute",
    summary: "Límite de pedidos por IP superado. Ojo: el código es bad_request (no rate_limited); usar el status 429 y Retry-After.",
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
  413: "Archivo demasiado grande",
  422: "No procesable",
  429: "Demasiados pedidos",
  503: "Servicio ocupado",
};

/** Respuestas comunes en components.responses (nombre → status y códigos de ejemplo). */
const COMMON: { name: string; status: number; codes: string[] }[] = [
  { name: "BadRequest", status: 400, codes: ["validation_error"] },
  { name: "InvalidId", status: 400, codes: ["invalid_id"] },
  { name: "BadRequestOrInvalidId", status: 400, codes: ["validation_error", "invalid_id"] },
  { name: "Unauthorized", status: 401, codes: ["unauthorized"] },
  { name: "PaymentRequired", status: 402, codes: ["plan_limit_api"] },
  { name: "Forbidden", status: 403, codes: ["forbidden", "insufficient_scope"] },
  { name: "ForbiddenNoOAuth", status: 403, codes: ["forbidden", "oauth_denied"] },
  { name: "NotFound", status: 404, codes: ["not_found"] },
  { name: "TooManyRequests", status: 429, codes: ["rate_limited"] },
];

const RATE_HEADERS = {
  "Retry-After": { $ref: "#/components/headers/RetryAfter" },
  "X-RateLimit-Limit": { $ref: "#/components/headers/RateLimitLimit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/RateLimitRemaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/RateLimitReset" },
};

function errorResponse(status: number, codes: string[]) {
  const examples = Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/examples/${c}` }]));
  return {
    description: STATUS_TEXT[status] ?? "Error",
    ...(status === 429 ? { headers: RATE_HEADERS } : {}),
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
      RetryAfter: int("Segundos hasta que se renueva la ventana."),
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
  if (auth === "key") {
    add("unauthorized");
    add("forbidden");
    add(oauthDenied ? "oauth_denied" : "insufficient_scope");
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
  [/^\/v1\/agreements\//, "del acuerdo", true, "AgreementId"],
  [/^\/v1\/agreement-fields\//, "del campo", true, "AgreementFieldId"],
  [/^\/v1\/agreement-views\//, "de la vista", true, "AgreementViewId"],
  [/^\/v1\/document-templates\//, "de la plantilla de documento", true, "DocumentTemplateId"],
  [/^\/v1\/clauses\//, "de la cláusula", true, "ClauseId"],
  [/^\/v1\/workflows\//, "del workflow", true, "WorkflowId"],
  [/^\/v1\/workflow-runs\//, "de la ejecución", true, "WorkflowRunId"],
  [/^\/v1\/negotiations\//, "de la negociación", true, "NegotiationId"],
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
  "get /v1/crm/mappings": [{ name: "connectionId", description: "Solo los mapeos de esa conexión.", schema: { type: "string", format: "uuid" } }],
  "get /v1/crm/links": [{ name: "envelopeId", description: "Sobre cuyos vínculos se listan.", required: true, schema: { type: "string", format: "uuid" } }],
  "get /v1/crm/runs": [
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
  "get /v1/crm/mappings": null,
  "get /v1/crm/links": null,
  "get /v1/crm/runs": null,
  "get /v1/workflow-runs": null,
  "get /v1/negotiations/{id}/diff": null,
};

// ───────────────────────────── Tags ─────────────────────────────

export const TAGS: [string, string][] = [
  ["Sobres", "Crear un sobre (documentos, destinatarios y campos), enviarlo y seguirlo hasta el PDF final sellado."],
  ["Plantillas", "Documentos, roles y campos reutilizables; crear sobres desde una plantilla en un solo pedido."],
  ["Firma embebida", "Firma dentro de la app del integrador: URL de un solo uso para iframe o redirección."],
  ["Webhooks", "Endpoints que reciben los eventos de los sobres, firmados con HMAC-SHA256."],
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
  ["Slack y Teams", "Avisos de eventos de sobres a canales de Slack o Microsoft Teams."],
  ["Almacenamiento", "Copia automática de los PDF firmados a Google Drive, Dropbox, OneDrive o S3."],
  ["Reportes", "Estadísticas de actividad y exportación de sobres."],
  ["OAuth 2.0", "Apps OAuth y tokens (client_credentials, authorization_code con PKCE, refresh_token)."],
  ["Identidad", "Cuenta, sesión y API keys."],
  ["Equipo", "Miembros, invitaciones, roles y permisos, grupos y visibilidad compartida."],
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
      "t=<unix>,v1=<hex>. v1 = HMAC-SHA256(secreto whsec_…, \"<t>.<cuerpo crudo>\"). Verificar con el cuerpo tal cual llega y rechazar timestamps viejos. Se recalcula en cada intento.",
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
          "Cualquier respuesta fuera de 2xx (o un error de red) es un fallo: se reintenta hasta 8 intentos en total con espera exponencial (5 s, 10 s, 20 s… hasta 1 h). " +
          "El orden de llegada no está garantizado.",
        parameters: params,
        requestBody: { required: true, content: { "application/json": { schema: ref("WebhookEvent") } } },
        responses: { "2XX": { description: "Recibido. El cuerpo de la respuesta se guarda (primeros 1000 caracteres) en la entrega." } },
      },
    };
  }
  return out;
}
