// Redacción de secretos en logs: los links de firma, invitaciones, códigos del Firmador, descargas, negociaciones,
// workflows públicos y resets de contraseña llevan el secreto en la ruta; OAuth y SSO lo llevan en la query.
// Nada de eso puede terminar en journald / CloudWatch.

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
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Segmentos con pinta de token aleatorio (base64url largo), aunque la ruta no esté en la lista. */
const TOKEN_LIKE = /^[A-Za-z0-9_-]{24,}$/;

function redactSegments(path: string): string {
  const segs = path.split("/");
  // segs[0] es "" (la ruta empieza con "/").
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i];
    if (!s) continue;
    const before = segs.slice(1, i);
    const afterSecretPrefix = SECRET_AFTER.some((p) => p.length === before.length && p.every((x, j) => x === before[j]));
    if (afterSecretPrefix || (TOKEN_LIKE.test(s) && !UUID.test(s))) segs[i] = REDACTED;
  }
  return segs.join("/");
}

/** Devuelve la URL (ruta + query) sin secretos. */
export function redactUrl(url: string | undefined | null): string {
  if (!url) return "";
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  let out = redactSegments(path);
  if (q !== -1) {
    const params = new URLSearchParams(url.slice(q + 1));
    const parts: string[] = [];
    for (const [k, v] of params) {
      const secret = SECRET_PARAMS.has(k.toLowerCase());
      parts.push(`${encodeURIComponent(k)}=${secret ? REDACTED : encodeURIComponent(redactSegments(v))}`);
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
