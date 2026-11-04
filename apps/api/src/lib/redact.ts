// Redacción de secretos y datos personales en logs (SEG-20): los links de firma, invitaciones, códigos del Firmador,
// descargas, negociaciones, workflows públicos, pases de firma del celular y resets de contraseña llevan el secreto en la
// ruta; OAuth y SSO lo llevan en la query. Y un objeto logueado puede llevar el correo, el teléfono o el documento de
// una persona. Nada de eso puede terminar en journald / CloudWatch.

const REDACTED = "[redactado]";

/** Prefijos de ruta cuyo segmento siguiente es un secreto. */
const SECRET_AFTER: string[][] = [
  ["s"],
  ["v1", "signing"],
  ["embed"],
  ["v1", "certsign", "sessions"],
  ["v1", "downloads"],
  ["v1", "invite"],
  ["invite"],
  ["v1", "public", "negotiations"],
  ["v1", "public", "workflow-runs"],
  // Pase de firma (firma dibujada en el celular): la página /h/<token> y su endpoint público.
  ["v1", "public", "signature-handoffs"],
  ["h"],
  ["n"],
  ["w"],
  ["reset"],
];

/** Parámetros de query que nunca se registran. */
const SECRET_PARAMS = new Set([
  "code",
  "token",
  "state",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
  "signature",
  "samlresponse",
  "relaystate",
  "code_verifier",
  // Retorno de pagos y verificación de identidad: `k` lleva el token del firmante (de sesión o permanente).
  "k",
  // Nonce de los checkouts simulados (pagos y suscripciones).
  "n",
  "nonce",
  "ticket",
  "otp",
]);

/**
 * Parámetros de query con un dato personal: la búsqueda (`q` busca por nombre o correo del firmante), el correo que se
 * sugiere al IdP (`login_hint`) y los documentos de identidad de las búsquedas de ERP (Siigo y Alegra `identification`,
 * TOTVS `governmentalInformation.id`). Un valor con un correo adentro (el filtro de SCIM) se enmascara aunque el
 * parámetro no esté acá.
 */
const PII_PARAMS = new Set([
  "q",
  "search",
  "login_hint",
  "email",
  "phone",
  "identification",
  "governmentalinformation.id",
  "document",
  "cpf",
  "cnpj",
  "dni",
]);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Enmascara los correos de un texto como maskDestination: las dos primeras letras y el dominio (`an***@example.com`). */
export function maskEmails(s: string): string {
  return s.replace(EMAIL, (m) => m.replace(/([^@]{0,2})[^@]*/, "$1***"));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Segmentos con pinta de token aleatorio (base64url largo), aunque la ruta no esté en la lista. */
const TOKEN_LIKE = /^[A-Za-z0-9_-]{24,}$/;

function redactSegments(path: string): string {
  const segs = path.split("/");
  // En una ruta segs[0] es "" (empieza con "/"); en un valor de query el primer segmento también puede ser un token.
  if (segs[0] && TOKEN_LIKE.test(segs[0]) && !UUID.test(segs[0])) segs[0] = REDACTED;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (!s) continue;
    const before = segs.slice(1, i);
    const afterSecretPrefix = SECRET_AFTER.some((p) => p.length === before.length && p.every((x, j) => x === before[j]));
    if (afterSecretPrefix || (TOKEN_LIKE.test(s) && !UUID.test(s))) segs[i] = REDACTED;
  }
  return segs.join("/");
}

/**
 * Devuelve la URL (ruta + query) sin secretos ni datos personales. Sirve también para la URL de una llamada saliente
 * que va a un mensaje de error o a un log (la regla calasign-url-en-error-o-log de Semgrep la pide).
 */
export function redactUrl(url: string | undefined | null): string {
  if (!url) return "";
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  let out = maskEmails(redactSegments(path));
  if (q !== -1) {
    const params = new URLSearchParams(url.slice(q + 1));
    const parts: string[] = [];
    for (const [k, v] of params) {
      const name = k.toLowerCase();
      const hidden = SECRET_PARAMS.has(name) || PII_PARAMS.has(name);
      parts.push(`${encodeURIComponent(k)}=${hidden ? REDACTED : encodeURIComponent(maskEmails(redactSegments(v)))}`);
    }
    out += `?${parts.join("&")}`;
  }
  return out;
}

/** Serializador del request para el logger de Fastify: sin headers (cookies, Authorization) y con la URL redactada. */
export function safeRequestSerializer(req: { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    hostname: req.hostname,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/** Rutas de pino que se censuran si algún log incluye headers explícitamente. */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "headers.authorization",
  "headers.cookie",
];

// ── Datos personales en cualquier objeto logueado (SEG-20) ──

/**
 * Claves cuyo valor es un dato personal o un secreto: se censuran en cualquier objeto logueado, a cualquier
 * profundidad. La clave se compara en minúsculas, sin `_`, `-` ni `.`, y por el final: `signerEmail`, `recipient_phone`,
 * `cpfCnpj`, `clientSecret`, `accessToken`.
 *
 * Criterio: lo que identifica o contacta a una persona (correo, teléfono, documento, nombre y apellido, nacimiento) y los
 * secretos. Quedan fuera, para que el log siga sirviendo: `name` y `title` a secas (el nombre de una plantilla, de un
 * paso, de una app OAuth, de un archivo), los ids (`recipientId`, `userId`: con el id se busca a la persona en la base,
 * donde sí tiene que estar), la IP (la del log de acceso hace falta para investigar un abuso) y el dominio de un correo.
 */
const PII_KEY_ENDINGS = [
  "email",
  "phone",
  "phonenumber",
  "telefono",
  "telefone",
  "celular",
  "cpf",
  "cnpj",
  "cuit",
  "cuil",
  "dni",
  "curp",
  "taxid",
  "nationalid",
  "documentnumber",
  "idnumber",
  "identification",
  "passport",
  "fullname",
  "firstname",
  "lastname",
  "surname",
  "givenname",
  "familyname",
  "displayname",
  "username",
  "signername",
  "recipientname",
  "contactname",
  "birthdate",
  "dateofbirth",
  "password",
  "secret",
  "token",
  "apikey",
];

/**
 * Claves exactas: las cortas, que por el final pegarían en otras palabras (`nit` en `unit`, `rut` en `strut`), y las que
 * llevan el objeto entero de una persona o del pedido (`recipient`, `signers`, `body`).
 */
const PII_KEYS = new Set([
  "rut",
  "rfc",
  "nit",
  "ssn",
  "otp",
  "authorization",
  "cookie",
  "body",
  "recipient",
  "recipients",
  "signer",
  "signers",
  "contact",
  "contacts",
]);

/** Más hondo que esto no se recorre: se censura (y un objeto circular no cuelga el log). */
const MAX_DEPTH = 6;

function isPiiKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PII_KEYS.has(k) || PII_KEY_ENDINGS.some((e) => k.endsWith(e));
}

function cleanEntry(key: string, value: unknown, depth: number): unknown {
  // Un número o un booleano no es el dato (`signers: 3`, `hasPhone: true`): queda, y el log sigue diciendo algo.
  if (isPiiKey(key) && value != null && typeof value !== "number" && typeof value !== "boolean") return REDACTED;
  return sanitizeLogValue(value, depth + 1);
}

/**
 * Copia de un valor para el log sin datos personales: censura las claves de PII_KEY_ENDINGS / PII_KEYS y enmascara
 * los correos en cualquier texto. Recorre objetos planos, arrays y errores (un Error de Postgres trae el valor duplicado
 * en `detail`: «Key (email)=(…) already exists»); el error se copia con su prototipo para que pino lo serialice igual.
 * Los objetos de una clase (el pedido de Fastify, un Buffer, una fecha) quedan como están: los serializa pino. Nunca
 * cambia el valor original.
 */
export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskEmails(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => sanitizeLogValue(v, depth + 1));
  if (value instanceof Error) {
    // Con el prototipo de Error y no el de su clase: los getters de un DOMException (el TimeoutError de
    // AbortSignal.timeout) tiran si los lee otro objeto, y el log reventaba. El `constructor` propio, no enumerable,
    // mantiene el tipo que escribe pino (DatabaseError, DOMException); message y stack se leen del original.
    const e = value as unknown as Record<string, unknown>;
    const copy = Object.create(Error.prototype) as Record<string, unknown>;
    Object.defineProperty(copy, "constructor", { value: e.constructor });
    for (const k of new Set(["message", "stack", ...Object.getOwnPropertyNames(value)])) copy[k] = cleanEntry(k, e[k], depth);
    return copy;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = cleanEntry(k, v, depth);
  return out;
}

/** Hook de pino: cada argumento de cada log (el objeto, el mensaje y los de formato) pasa por sanitizeLogValue. */
export const LOG_HOOKS = {
  logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
    return method.apply(
      this,
      args.map((a) => sanitizeLogValue(a)),
    );
  },
};

/**
 * Opciones de pino de la API y del worker: el pedido sin headers y con la URL redactada, los headers sensibles
 * censurados si alguien los loguea y los datos personales censurados en cualquier objeto (LOG_HOOKS).
 */
export function safeLoggerOptions(level: string) {
  return {
    level,
    serializers: { req: safeRequestSerializer },
    redact: { paths: LOG_REDACT_PATHS, censor: REDACTED },
    hooks: LOG_HOOKS,
  };
}
