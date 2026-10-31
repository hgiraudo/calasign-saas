// DAST (scripts/dast.sh): crea en la API efímera la cuenta que usa ZAP y escribe sus credenciales en <dir>/auth.json.
// Uso: node scripts/dast/seed.mjs <base> <dir>
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [base, dir] = process.argv.slice(2);
if (!base || !dir) throw new Error("uso: node scripts/dast/seed.mjs <base> <dir>");
const origin = new URL(base).origin;
let cookie = "";

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() ?? [];
  const sess = set.map((c) => c.split(";")[0]).find((c) => /^(__Host-)?cs_session=/.test(c));
  if (sess) cookie = sess;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const stamp = Date.now();
await api("POST", "/v1/auth/signup", {
  name: "ZAP",
  email: `zap+${stamp}@example.com`,
  // Al azar en cada corrida: la cuenta vive lo que dura la API efímera.
  password: `dast-${randomBytes(18).toString("base64url")}`,
  organization: `DAST ${stamp}`,
  locale: "es",
});
const { secret } = await api("POST", "/v1/api-keys", { name: "zap" });
// Un sobre, para que el escaneo tenga algo real detrás de las rutas con id.
const env = await api("POST", "/v1/envelopes", { subject: "DAST" }).catch(() => null);
writeFileSync(join(dir, "auth.json"), JSON.stringify({ apiKey: secret, cookie, envelopeId: env?.id ?? null }));
console.log(`cuenta de ZAP creada${env?.id ? ` (sobre ${env.id})` : ""}`);
