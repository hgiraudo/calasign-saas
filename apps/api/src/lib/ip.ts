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

/**
 * Clave del límite de pedidos: con una credencial Bearer (API key o token OAuth), un hash de la credencial; sin ella,
 * la IP (rateLimitIpKey). Por IP sola, las integraciones detrás de un mismo NAT o proxy (muchas organizaciones con la
 * misma IP de salida) compartían el cupo, y una sola key repartida entre muchas IPs lo multiplicaba. Una credencial
 * inventada obtiene su propio cupo, pero el pedido termina en 401 tras una búsqueda por hash indexada. En el store en
 * memoria del límite (uno por réplica) queda el hash, no la credencial.
 */
export function rateLimitKey(req: { ip?: string | null; headers: { authorization?: string | string[] } }): string {
  const token = bearerToken(req.headers.authorization as string | undefined);
  return token ? `cred:${sha256Hex(token).slice(0, 32)}` : rateLimitIpKey(req.ip);
}
