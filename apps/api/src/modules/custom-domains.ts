// Dominio propio (white-label): la organización firma desde firmas.cliente.com.
//   1. Registra el dominio → recibe un registro TXT de verificación y un CNAME recomendado.
//   2. Verifica: se consulta el TXT por DNS-over-HTTPS.
//   3. Verificado: los links de sus correos usan ese dominio, la web muestra su marca según el Host,
//      y Caddy emite el certificado bajo demanda preguntando a GET /internal/tls-allowed (docs/CUSTOM-DOMAINS.md).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SetCustomDomainInput, type CustomDomain, type HostBranding } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { iso, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { auditFromRequest, recordAudit } from "./audit";
import { getTenantBranding } from "./branding";
import { authenticate, type Services } from "./context";

const appHost = () => new URL(config.appUrl).hostname.toLowerCase();
const isLocalEnv = () => config.environment === "local";
/** Dominio registrable de la plataforma (calasign.com): sus subdominios no se pueden reclamar. */
const platformRoot = () => appHost().split(".").slice(-2).join(".");

const txtName = (domain: string) => `_calasign-challenge.${domain}`;
const txtValue = (token: string) => `calasign-verify=${token}`;

// ───────────────────────────── DNS ─────────────────────────────

/** Registros de prueba (solo entorno local): POST /dev/dns-stub. */
const dnsStub = new Map<string, string[]>();

async function dohTxt(endpoint: string, name: string): Promise<string[]> {
  const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DNS ${res.status}`);
  const body: any = await res.json();
  return (body.Answer ?? [])
    .filter((a: any) => a.type === 16)
    .map((a: any) => String(a.data).replace(/"\s+"/g, "").replace(/^"|"$/g, ""));
}

/** TXT por DNS-over-HTTPS (Cloudflare y, si falla, Google). En local, primero los registros de prueba. */
export async function resolveTxt(name: string): Promise<string[]> {
  const key = name.toLowerCase();
  if (isLocalEnv() && dnsStub.has(key)) return dnsStub.get(key)!;
  try {
    return await dohTxt("https://cloudflare-dns.com/dns-query", key);
  } catch {
    return dohTxt("https://dns.google/resolve", key);
  }
}

// ───────────────────────────── Dominio por tenant ─────────────────────────────

const cache = new Map<string, { value: string | null; at: number }>();
const CACHE_MS = 60_000;

function cached<T extends string | null>(key: string, load: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.value as T);
  return load().then((v) => {
    cache.set(key, { value: v, at: Date.now() });
    return v;
  });
}

function invalidate() {
  cache.clear();
}

/** URL base para los links de una organización: su dominio verificado o la de la plataforma. */
export async function tenantBaseUrl(db: Db, tenantId: string): Promise<string> {
  const d = await cached(`t:${tenantId}`, async () => {
    const r = await db.one<any>(`SELECT domain FROM custom_domains WHERE tenant_id = $1 AND status = 'verified'`, [tenantId]);
    return r?.domain ?? null;
  });
  return d ? `https://${d}` : config.appUrl;
}

/** Tenant dueño de un dominio verificado (por Host), o null. */
export async function tenantForHost(db: Db, host: string | undefined): Promise<string | null> {
  const h = (host ?? "").split(":")[0].toLowerCase();
  if (!h || h === appHost() || h === "localhost" || h === "127.0.0.1") return null;
  return cached(`h:${h}`, async () => {
    const r = await db.one<any>(`SELECT tenant_id FROM custom_domains WHERE domain = $1 AND status = 'verified'`, [h]);
    return r?.tenant_id ?? null;
  });
}

function toApi(r: any): CustomDomain {
  return {
    domain: r.domain,
    status: r.status,
    txtName: txtName(r.domain),
    txtValue: txtValue(r.verification_token),
    cnameTarget: appHost(),
    verifiedAt: iso(r.verified_at),
    lastCheckedAt: iso(r.last_checked_at),
    lastError: r.last_error,
  };
}

// ───────────────────────────── Re-verificación periódica ─────────────────────────────

const RECHECK_HOURS = 6;
const MISSING_MARK = "Re-verificación: no se encontró el registro TXT";

/**
 * Vuelve a consultar el TXT de los dominios verificados. Sin esto un dominio quedaba verificado para siempre: si la
 * organización lo perdía (venció y lo registró otro, o quedó un CNAME colgado que alguien reclamó), los correos seguían
 * mandando los links de firma —que dan acceso al sobre— a un host que ya no controla. Si el TXT falta en dos controles
 * seguidos (separados por RECHECK_HOURS), el dominio vuelve a "pendiente": los links pasan al dominio de la plataforma y
 * Caddy deja de emitir certificados para él. Un error de DNS no cuenta como falta (no se arriesga a cortar por un
 * problema de la consulta). La organización lo vuelve a verificar desde Ajustes.
 */
export async function recheckVerifiedDomains(
  d: { db: Db; log: { warn(o: object, m?: string): void } },
  resolve: (name: string) => Promise<string[]> = resolveTxt,
  limit = 20,
) {
  const rows = await d.db.query<any>(
    `SELECT * FROM custom_domains WHERE status = 'verified' AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(hours => $1))
      ORDER BY last_checked_at NULLS FIRST LIMIT $2`,
    [RECHECK_HOURS, limit],
  );
  let demoted = 0;
  for (const r of rows) {
    let values: string[];
    try {
      values = await resolve(txtName(r.domain));
    } catch (e) {
      await d.db.query(`UPDATE custom_domains SET last_checked_at = now() WHERE id = $1`, [r.id]);
      d.log.warn({ domain: r.domain, err: String((e as Error).message ?? e) }, "no se pudo re-verificar el dominio propio");
      continue;
    }
    if (values.includes(txtValue(r.verification_token))) {
      await d.db.query(`UPDATE custom_domains SET last_checked_at = now(), last_error = NULL WHERE id = $1`, [r.id]);
      continue;
    }
    if (!String(r.last_error ?? "").startsWith(MISSING_MARK)) {
      await d.db.query(`UPDATE custom_domains SET last_checked_at = now(), last_error = $2 WHERE id = $1`, [
        r.id,
        `${MISSING_MARK} ${txtName(r.domain)}: si sigue faltando en el próximo control, el dominio deja de usarse`,
      ]);
      continue;
    }
    const down = await d.db.query(
      `UPDATE custom_domains SET status = 'pending', last_checked_at = now(), last_error = $2 WHERE id = $1 AND status = 'verified' RETURNING id`,
      [r.id, `${MISSING_MARK} ${txtName(r.domain)} en dos controles seguidos: el dominio dejó de usarse hasta que se vuelva a verificar`],
    );
    if (!down.length) continue;
    demoted++;
    invalidate();
    await recordAudit(d.db, {
      tenantId: r.tenant_id,
      action: "domain.unverified",
      actor: { type: "system", label: "Re-verificación de dominio" },
      targetType: "domain",
      targetId: r.domain,
      data: { reason: "txt_missing" },
    });
  }
  return { checked: rows.length, demoted };
}

/** El pedido viene por loopback y sin pasar por el proxy (Caddy agrega X-Forwarded-For a lo que proxea). */
function isDirectLoopback(req: FastifyRequest) {
  const ra = req.socket.remoteAddress ?? "";
  const loop = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  return loop && !req.headers["x-forwarded-for"];
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function customDomainRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.get("/v1/domains", { preHandler: auth }, async (req) => {
    const r = await s.db.one<any>(`SELECT * FROM custom_domains WHERE tenant_id = $1`, [req.auth!.tenantId]);
    return { domain: r ? toApi(r) : null };
  });

  app.put("/v1/domains", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const { domain } = SetCustomDomainInput.parse(req.body);
    for (const root of new Set([platformRoot(), "calasign.com", "calasign.io"])) {
      if (domain === appHost() || domain === root || domain.endsWith(`.${root}`)) {
        throw badRequest("reserved_domain", `No se pueden usar dominios de ${root}`);
      }
    }
    // Solo un dominio verificado por otra organización lo bloquea: uno pendiente no prueba nada (cualquiera puede
    // registrar un dominio ajeno) y gana quien publique su TXT.
    const taken = await s.db.one<any>(`SELECT tenant_id FROM custom_domains WHERE domain = $1 AND status = 'verified' AND tenant_id <> $2`, [domain, a.tenantId]);
    if (taken) throw conflict("domain_taken", "Ese dominio ya está registrado por otra organización");
    const existing = await s.db.one<any>(`SELECT * FROM custom_domains WHERE tenant_id = $1`, [a.tenantId]);
    if (existing?.domain === domain) return { domain: toApi(existing) };
    await s.db.tx(async (t) => {
      await t.query(`DELETE FROM custom_domains WHERE tenant_id = $1`, [a.tenantId]);
      await t.query(`INSERT INTO custom_domains (id, tenant_id, domain, verification_token) VALUES ($1,$2,$3,$4)`, [
        uuidv7(),
        a.tenantId,
        domain,
        randomToken(18),
      ]);
    });
    invalidate();
    await auditFromRequest(s.db, req, a, "domain.set", { targetType: "domain", targetId: domain });
    return { domain: toApi(await s.db.one<any>(`SELECT * FROM custom_domains WHERE tenant_id = $1`, [a.tenantId])) };
  });

  app.post("/v1/domains/verify", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const a = req.auth!;
    const r = await s.db.one<any>(`SELECT * FROM custom_domains WHERE tenant_id = $1`, [a.tenantId]);
    if (!r) throw notFound("Dominio");
    let ok = false;
    let error: string | null = null;
    try {
      const values = await resolveTxt(txtName(r.domain));
      ok = values.includes(txtValue(r.verification_token));
      if (!ok) error = values.length ? `El TXT existe pero no coincide (${values.length} valor/es)` : `No se encontró el registro TXT ${txtName(r.domain)}`;
    } catch (e) {
      error = `No se pudo consultar el DNS: ${String((e as Error).message ?? e)}`;
    }
    if (ok && r.status !== "verified") {
      const other = await s.db.one(`SELECT 1 FROM custom_domains WHERE domain = $1 AND status = 'verified' AND tenant_id <> $2`, [r.domain, a.tenantId]);
      if (other) {
        ok = false;
        error = "Ese dominio ya lo verificó otra organización";
      }
    }
    try {
      await s.db.query(
        `UPDATE custom_domains SET status = CASE WHEN $2 THEN 'verified' ELSE status END,
           verified_at = CASE WHEN $2 AND verified_at IS NULL THEN now() ELSE verified_at END,
           last_checked_at = now(), last_error = $3 WHERE id = $1`,
        [r.id, ok, error],
      );
    } catch (e) {
      // Carrera con otra organización que verificó el mismo dominio a la vez (índice único de verificados).
      if ((e as { code?: string }).code !== "23505") throw e;
      ok = false;
      await s.db.query(`UPDATE custom_domains SET last_checked_at = now(), last_error = $2 WHERE id = $1`, [r.id, "Ese dominio ya lo verificó otra organización"]);
    }
    // Verificado: los registros pendientes de otras organizaciones para el mismo dominio ya no sirven.
    if (ok) await s.db.query(`DELETE FROM custom_domains WHERE domain = $1 AND status = 'pending' AND tenant_id <> $2`, [r.domain, a.tenantId]);
    invalidate();
    if (ok) await auditFromRequest(s.db, req, a, "domain.verified", { targetType: "domain", targetId: r.domain });
    return { domain: toApi(await s.db.one<any>(`SELECT * FROM custom_domains WHERE id = $1`, [r.id])) };
  });

  app.delete("/v1/domains", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const r = await s.db.one<any>(`DELETE FROM custom_domains WHERE tenant_id = $1 RETURNING domain`, [a.tenantId]);
    invalidate();
    if (r) await auditFromRequest(s.db, req, a, "domain.removed", { targetType: "domain", targetId: r.domain });
    return reply.code(204).send();
  });

  // Marca de la organización según el Host (la web la usa en el login y en el encabezado).
  app.get("/v1/public/host-branding", async (req, reply) => {
    const tenantId = await tenantForHost(s.db, req.headers.host);
    if (!tenantId) return reply.code(404).send({ error: { code: "not_found", message: "Sin dominio propio" } });
    const [t, b] = await Promise.all([s.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]), getTenantBranding(s.db, tenantId)]);
    const out: HostBranding = {
      organizationName: t?.name ?? "",
      primaryColor: b.primaryColor,
      logoUrl: b.logoUrl ? b.logoUrl.replace(config.appUrl, "") : null,
    };
    reply.header("cache-control", "public, max-age=300");
    return out;
  });

  // Caddy (on_demand_tls → ask): 200 solo para dominios verificados (y el propio de la plataforma).
  app.get<{ Querystring: { domain?: string } }>("/internal/tls-allowed", async (req, reply) => {
    if (!isDirectLoopback(req)) return reply.code(404).send();
    const d = String(req.query.domain ?? "").toLowerCase();
    if (d && d === appHost()) return reply.code(200).send("ok");
    const r = d ? await s.db.one(`SELECT 1 FROM custom_domains WHERE domain = $1 AND status = 'verified'`, [d]) : null;
    return reply.code(r ? 200 : 404).send(r ? "ok" : "");
  });

  // En un dominio propio, los links de firma de OTRAS organizaciones no funcionan.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/v1/signing/")) return;
    const tenantId = await tenantForHost(s.db, req.headers.host);
    if (!tenantId) return;
    const token = req.url.split("/")[3]?.split("?")[0] ?? "";
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return;
    const r = await s.db.one<any>(`SELECT tenant_id FROM recipients WHERE access_token_hash = $1`, [sha256Hex(token)]);
    if (r && r.tenant_id !== tenantId) return reply.code(404).send({ error: { code: "not_found", message: "Link no encontrado" } });
  });

  if (isLocalEnv()) {
    // Solo local: registros DNS de prueba para las pruebas automáticas.
    app.post("/dev/dns-stub", async (req) => {
      const b = (req.body ?? {}) as { name?: string; values?: string[] };
      if (!b.name || !Array.isArray(b.values)) throw new AppError(400, "invalid_request", "name y values requeridos");
      dnsStub.set(b.name.toLowerCase(), b.values.map(String));
      return { ok: true };
    });
  }
}
