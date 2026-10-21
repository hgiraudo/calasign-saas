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
     * La ruta autentica una credencial Bearer por su cuenta (sin pasar por authenticate(), p. ej. /mcp): con límite
     * propio, una credencial válida cuenta en su cupo. Las rutas con authenticate() en onRequest/preHandler se detectan
     * solas (bearerAuthRoute, ver markBearerAuthRoutes); este marcador no hace falta en ellas.
     */
    rateLimitByCredential?: boolean;
    /** Puesto por markBearerAuthRoutes: la ruta pasa por authenticate(). */
    bearerAuthRoute?: boolean;
  }
}

/** Marca de las funciones que devuelve authenticate() (context.ts), para detectar las rutas que autentican. */
export const AUTHENTICATES = Symbol.for("calasign.authenticates");

/**
 * Hook onRoute: marca (config.bearerAuthRoute) las rutas con authenticate() en onRequest o preHandler. Copia el config
 * (varias rutas comparten el mismo objeto `rl` y algunas son públicas).
 */
export function markBearerAuthRoutes(opts: { onRequest?: unknown; preHandler?: unknown; config?: object }): void {
  const has = (h: unknown) => (Array.isArray(h) ? h : [h]).some((f) => typeof f === "function" && (f as unknown as Record<symbol, unknown>)[AUTHENTICATES] === true);
  if (has(opts.onRequest) || has(opts.preHandler)) opts.config = { ...(opts.config ?? {}), bearerAuthRoute: true };
}

/**
 * Credenciales Bearer (hash) ya verificadas, con su organización: positivas 10 minutos, negativas (inventadas,
 * revocadas, vencidas) 60 segundos. Mapas con orden de inserción como LRU acotado: ni una lluvia de Bearer inventados
 * llena la memoria ni desaloja las positivas (van en mapas separados).
 */
const CACHE_MAX = 10_000;
const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 60_000;
const positive = new Map<string, { tenantId: string; exp: number }>();
const negative = new Map<string, number>();

/**
 * Presupuesto de verificaciones contra la base por IP (clave de límite) y minuto: las credenciales que no están en
 * ninguno de los dos mapas cuestan una consulta (indexada); con el presupuesto agotado, el pedido cuenta en la IP sin
 * consultar. Así Bearer inventados distintos en cada pedido no generan consultas sin fin: además de gastar el cupo de
 * la IP, no pasan de LOOKUPS_PER_IP consultas por minuto. El doble del cupo global por IP: quien agota el cupo de su
 * IP con Bearer inventados no deja sin verificar (y en el cupo de la IP, agotado) a una key válida que esta réplica no
 * conocía, salvo que siga mandando el doble de pedidos; una key válida ya conocida no consulta y no se ve afectada.
 */
const LOOKUPS_PER_IP = 1200;
const LOOKUP_WINDOW_MS = 60_000;
const LOOKUP_IPS_MAX = 50_000;
const lookups = new Map<string, { n: number; reset: number }>();

function credentialHash(token: string): string {
  return sha256Hex(token).slice(0, 32);
}

function lru<V>(m: Map<string, V>, k: string, v: V) {
  m.delete(k);
  m.set(k, v);
  while (m.size > CACHE_MAX) m.delete(m.keys().next().value as string);
}

/** Registra una credencial Bearer que acaba de autenticar bien (authenticate en context.ts, /mcp). */
export function rememberAuthenticatedCredential(token: string, tenantId: string): void {
  const h = credentialHash(token);
  negative.delete(h);
  lru(positive, h, { tenantId, exp: Date.now() + POSITIVE_TTL_MS });
}

/** Olvida una credencial que dejó de autenticar (revocada o vencida): por 60 segundos cuenta como inválida. */
export function forgetCredential(token: string): void {
  forgetCredentialHash(sha256Hex(token));
}

/** Como forgetCredential, con el sha256 completo de la credencial (api_keys.key_hash) al revocarla. */
export function forgetCredentialHash(sha256: string): void {
  const h = sha256.slice(0, 32);
  positive.delete(h);
  lru(negative, h, Date.now() + NEGATIVE_TTL_MS);
}

/** Solo para tests. */
export function resetKnownCredentials(): void {
  positive.clear();
  negative.clear();
  lookups.clear();
}

function takeLookup(ipKey: string): boolean {
  const now = Date.now();
  let e = lookups.get(ipKey);
  if (!e || e.reset <= now) {
    e = { n: 0, reset: now + LOOKUP_WINDOW_MS };
    lookups.delete(ipKey);
    lookups.set(ipKey, e);
    while (lookups.size > LOOKUP_IPS_MAX) lookups.delete(lookups.keys().next().value as string);
  }
  if (e.n >= LOOKUPS_PER_IP) return false;
  e.n++;
  return true;
}

/** Verifica una credencial Bearer (solo lectura): su organización si vale, null si no. */
export type CredentialVerifier = (token: string) => Promise<string | null>;

async function verifiedTenant(token: string, ipKey: string, verify: CredentialVerifier): Promise<string | null> {
  const h = credentialHash(token);
  const now = Date.now();
  const p = positive.get(h);
  if (p && p.exp > now) return p.tenantId;
  if (p) positive.delete(h);
  const n = negative.get(h);
  if (n !== undefined && n > now) return null;
  if (n !== undefined) negative.delete(h);
  if (!takeLookup(ipKey)) return null;
  let tenantId: string | null;
  try {
    tenantId = await verify(token);
  } catch {
    return null; // base caída: cuenta en la IP, sin recordar nada
  }
  if (tenantId) lru(positive, h, { tenantId, exp: now + POSITIVE_TTL_MS });
  else lru(negative, h, now + NEGATIVE_TTL_MS);
  return tenantId;
}

export interface RateLimitIdentity {
  /** Clave del cupo: `cred:<hash>` o la de la IP. */
  key: string;
  /** Organización de la credencial (solo con clave `cred:`). */
  tenantId: string | null;
}

type RateLimitReq = {
  ip?: string | null;
  headers: { authorization?: string | string[] };
  routeOptions?: { config?: { rateLimit?: unknown; rateLimitByCredential?: boolean; bearerAuthRoute?: boolean } };
};

/**
 * Clave del límite de pedidos (y organización, para el tope por IP y organización de app.ts).
 * - Con una credencial Bearer válida (verificada acá contra la base, con caché): un hash de la credencial, para que las
 *   integraciones detrás de un mismo NAT o proxy (un cliente MCP alojado, Zapier) no compartan el cupo y una key
 *   repartida entre muchas IPs no lo multiplique. Vale también en las rutas con límite propio que autentican (/mcp,
 *   /v1/xml/sign, …); en las rutas públicas con límite propio (login, alta, recupero, 2FA, invitaciones, firma, /v1/verify)
 *   cuenta siempre la IP: si no, cada key válida abría otro cupo contra esos límites.
 * - Sin credencial, o con una inventada, revocada o vencida: por IP (rateLimitIpKey). Un Bearer inventado distinto en
 *   cada pedido cuenta en el cupo de la IP y no abre cupos nuevos.
 * En el store en memoria del límite (uno por réplica) queda el hash, no la credencial.
 */
export async function rateLimitIdentity(req: RateLimitReq, verify: CredentialVerifier): Promise<RateLimitIdentity> {
  const ipKey = rateLimitIpKey(req.ip);
  const token = bearerToken(req.headers.authorization as string | undefined);
  if (!token) return { key: ipKey, tenantId: null };
  const cfg = req.routeOptions?.config;
  const ownLimit = !!cfg && typeof cfg.rateLimit === "object" && cfg.rateLimit !== null;
  if (ownLimit && cfg.bearerAuthRoute !== true && cfg.rateLimitByCredential !== true) return { key: ipKey, tenantId: null };
  const tenantId = await verifiedTenant(token, ipKey, verify);
  return tenantId ? { key: `cred:${credentialHash(token)}`, tenantId } : { key: ipKey, tenantId: null };
}

/** Clave del límite de pedidos (ver rateLimitIdentity). */
export async function rateLimitKey(req: RateLimitReq, verify: CredentialVerifier): Promise<string> {
  return (await rateLimitIdentity(req, verify)).key;
}
