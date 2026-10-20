import { isIPv6 } from "node:net";

/**
 * Clave de límite por IP: una IPv4 (o IPv4 mapeada en IPv6) tal cual; una IPv6, su /64. Un cliente IPv6 suele tener
 * un /64 entero (2⁶⁴ direcciones): limitar por dirección exacta no frenaba a nadie. Loopback queda igual (la lista de
 * IPs sin límite del entorno local la compara por texto).
 */
export function rateLimitIpKey(ip: string | undefined | null): string {
  const v = String(ip ?? "").trim().toLowerCase().replace(/%.*$/, "");
  if (!isIPv6(v) || v === "::1") return v;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1];
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  let all: string[];
  if (v.includes("::")) {
    const [head, tail] = v.split("::");
    const h = groups(head);
    const t = groups(tail);
    all = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  } else all = groups(v);
  return `${all
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}
