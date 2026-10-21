import { isIPv6 } from "node:net";
import { bearerToken, sha256Hex } from "./util";

/** Los 8 grupos (números) de una IPv6 válida, con "::" expandido y una IPv4 final (a.b.c.d) como dos grupos. */
function ipv6Groups(v: string): number[] {
  const groups = (part: string) =>
    part
      ? part.split(":").flatMap((g) => {
          if (!g.includes(".")) return [parseInt(g, 16)];
          const [a, b, c, d] = g.split(".").map(Number);
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  if (!v.includes("::")) return groups(v);
  const [head, tail] = v.split("::");
  const h = groups(head);
  const t = groups(tail);
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill(0), ...t];
}

/**
 * Normaliza una IP de un pedido: sin espacios, en minúsculas, sin zona (%eth0), sin corchetes ni puerto
 * ("[2001:db8::1]:443", "203.0.113.9:5678") y una IPv4 mapeada en IPv6 (::ffff:10.0.0.1 o ::ffff:a00:1) como IPv4.
 */
export function normalizeIp(ip: string | undefined | null): string {
  let v = String(ip ?? "").trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracketed) v = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  v = v.replace(/%.*$/, "");
  if (!isIPv6(v)) return v;
  const g = ipv6Groups(v);
  if (g.length === 8 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  }
  return v;
}

/**
 * Clave de límite por IP: una IPv4 (o IPv4 mapeada en IPv6) tal cual; una IPv6, su /64. Un cliente IPv6 suele tener
 * un /64 entero (2⁶⁴ direcciones): limitar por dirección exacta no frenaba a nadie. Loopback queda igual (la lista de
 * IPs sin límite del entorno local se compara con esta clave).
 */
export function rateLimitIpKey(ip: string | undefined | null): string {
  const v = normalizeIp(ip);
  if (!isIPv6(v) || v === "::1") return v;
  return `${ipv6Groups(v)
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Ruta con límite propio (config.rateLimit) que se cuenta por credencial y no por IP. Solo para rutas que exigen
     * autenticación (p. ej. las /test de integraciones): ahí la credencial ya pasó por authenticate().
     */
    rateLimitByCredential?: boolean;
  }
}

/**
 * Credenciales Bearer (hash) que ya autenticaron bien en este proceso, con su vencimiento. Mapa con orden de inserción
 * como LRU acotado: una credencial inventada nunca entra, así que no puede llenar el store del límite ni desalojar los
 * cupos legítimos.
 */
const KNOWN_CREDENTIALS_MAX = 10_000;
const KNOWN_CREDENTIAL_TTL_MS = 10 * 60_000;
const knownCredentials = new Map<string, number>();

function credentialHash(token: string): string {
  return sha256Hex(token).slice(0, 32);
}

/** Registra una credencial Bearer que acaba de autenticar bien (authenticate en context.ts). */
export function rememberAuthenticatedCredential(token: string): void {
  const h = credentialHash(token);
  knownCredentials.delete(h);
  knownCredentials.set(h, Date.now() + KNOWN_CREDENTIAL_TTL_MS);
  while (knownCredentials.size > KNOWN_CREDENTIALS_MAX) knownCredentials.delete(knownCredentials.keys().next().value as string);
}

/** Olvida una credencial que dejó de autenticar (revocada o vencida). */
export function forgetCredential(token: string): void {
  knownCredentials.delete(credentialHash(token));
}

function isKnownCredential(h: string): boolean {
  const exp = knownCredentials.get(h);
  if (exp === undefined) return false;
  if (exp <= Date.now()) {
    knownCredentials.delete(h);
    return false;
  }
  return true;
}

/** Solo para tests. */
export function resetKnownCredentials(): void {
  knownCredentials.clear();
}

/**
 * Clave del límite de pedidos.
 * - Rutas con límite propio (config.rateLimit, p. ej. login, alta, recupero de contraseña, 2FA, invitaciones, /oauth/token,
 *   /v1/verify, rutas públicas de firma): por IP (rateLimitIpKey), salvo que la ruta pida config.rateLimitByCredential.
 *   El plugin hereda el keyGenerator global en esas rutas: sin esta regla, un Bearer inventado distinto en cada pedido
 *   daba un cupo nuevo por pedido y anulaba el límite.
 * - Resto: con una credencial Bearer que ya autenticó bien en este proceso (rememberAuthenticatedCredential), un hash
 *   de la credencial, para que las integraciones detrás de un mismo NAT o proxy no compartan el cupo y una key repartida
 *   entre muchas IPs no lo multiplique. Una credencial no vista (inventada, o el primer pedido de una real) cuenta en el
 *   cupo de la IP. En el store en memoria del límite (uno por réplica) queda el hash, no la credencial.
 * El tope grueso por IP para el tráfico con credencial está en app.ts.
 */
export function rateLimitKey(req: {
  ip?: string | null;
  headers: { authorization?: string | string[] };
  routeOptions?: { config?: { rateLimit?: unknown; rateLimitByCredential?: boolean } };
}): string {
  const cfg = req.routeOptions?.config;
  if (cfg && typeof cfg.rateLimit === "object" && cfg.rateLimit !== null && cfg.rateLimitByCredential !== true) return rateLimitIpKey(req.ip);
  const token = bearerToken(req.headers.authorization as string | undefined);
  if (!token) return rateLimitIpKey(req.ip);
  const h = credentialHash(token);
  return isKnownCredential(h) ? `cred:${h}` : rateLimitIpKey(req.ip);
}
