// Dominio propio (white-label): la organización firma desde firmas.cliente.com.
//   1. Registra el dominio → recibe un registro TXT de verificación y el CNAME hacia la plataforma.
//   2. Verifica: se consultan por DNS-over-HTTPS el TXT y que el dominio lleve a la plataforma (CNAME o A).
//   3. Verificado: los links de sus correos usan ese dominio, la web muestra su marca según el Host,
//      y Caddy emite el certificado bajo demanda preguntando a GET /internal/tls-allowed (docs/CUSTOM-DOMAINS.md).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SetCustomDomainInput, type CustomDomain, type HostBranding } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { iso, randomToken, requestPath, sha256Hex, uuidv7 } from "../lib/util";
import { auditFromRequest, recordAudit } from "./audit";
import { getTenantBranding } from "./branding";
import { SESSION_COOKIE, authenticate, type Services } from "./context";

const appHost = () => new URL(config.appUrl).hostname.toLowerCase();
const isLocalEnv = () => config.environment === "local";
/** Dominio registrable de la plataforma (calasign.com): sus subdominios no se pueden reclamar. */
const platformRoot = () => appHost().split(".").slice(-2).join(".");

/** Páginas de la cuenta (web): en un dominio propio redirigen al dominio de la plataforma. */
const ACCOUNT_PAGES = ["/app", "/login", "/signup", "/forgot", "/reset", "/invite", "/oauth/authorize", "/developers"];
/** Rutas que crean o usan una sesión de cuenta: en un dominio propio no se atienden. */
const ACCOUNT_APIS = ["/v1/auth", "/v1/invite", "/v1/oauth/authorize", "/v1/me", "/v1/integrations/sso"];
/** La ruta es `prefix` o está debajo (por segmento: "/v1/me" no abarca "/v1/members"). */
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

const txtName = (domain: string) => `_calasign-challenge.${domain}`;
const txtValue = (token: string) => `calasign-verify=${token}`;

// ───────────────────────────── DNS ─────────────────────────────

/** Registros de prueba (solo entorno local): POST /dev/dns-stub. */
const dnsStub = new Map<string, string[]>();

async function dohQuery(endpoint: string, name: string, type: "TXT" | "A"): Promise<{ type: number; data: string }[]> {
  const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DNS ${res.status}`);
  const body: any = await res.json();
  // Solo NOERROR (0) y NXDOMAIN (3) dicen algo del registro. SERVFAIL (2), REFUSED (5)… llegan con HTTP 200 y sin
  // Answer: tratarlos como "no publicado" desverificaba un dominio de correo por una falla del DNS (y el rechequeo de
  // dominios propios lo contaba como falta y no como error).
  const status = Number(body.Status ?? 0);
  if (status !== 0 && status !== 3) throw new Error(`DNS rcode ${status}`);
  return (body.Answer ?? []).map((a: any) => ({ type: Number(a.type), data: String(a.data) }));
}

/** Consulta por DNS-over-HTTPS: Cloudflare y, si falla, Google. */
async function doh(name: string, type: "TXT" | "A") {
  try {
    return await dohQuery("https://cloudflare-dns.com/dns-query", name, type);
  } catch {
    return dohQuery("https://dns.google/resolve", name, type);
  }
}

/** TXT por DNS-over-HTTPS. En local, primero los registros de prueba. */
export async function resolveTxt(name: string): Promise<string[]> {
  const key = name.toLowerCase();
  if (isLocalEnv() && dnsStub.has(key)) return dnsStub.get(key)!;
  return (await doh(key, "TXT")).filter((a) => a.type === 16).map((a) => a.data.replace(/"\s+"/g, "").replace(/^"|"$/g, ""));
}

/**
 * ¿El dominio sigue llevando a la plataforma? Sí si su cadena de CNAME pasa por el host de la plataforma, o si alguna
 * de sus direcciones A es de la plataforma. Un dominio servido por otro (o detrás de un proxy ajeno) da false.
 */
export async function routesToPlatform(domain: string): Promise<boolean> {
  const host = appHost();
  const strip = (v: string) => v.replace(/\.$/, "").toLowerCase();
  const ans = await doh(domain.toLowerCase(), "A");
  if (ans.some((a) => a.type === 5 && strip(a.data) === host)) return true;
  const mine = new Set((await doh(host, "A")).filter((a) => a.type === 1).map((a) => a.data));
  return ans.some((a) => a.type === 1 && mine.has(a.data));
}

// ───────────────────────────── Dominio por tenant ─────────────────────────────

const cache = new Map<string, { value: string | null; at: number }>();
const CACHE_MS = 60_000;
/** Tope de entradas: la clave por host sale del encabezado Host (lo elige el cliente) y se consulta en cada pedido. */
const CACHE_MAX = 10_000;

function cached<T extends string | null>(key: string, load: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.value as T);
  return load().then((v) => {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { value: v, at: Date.now() });
    return v;
  });
}

function invalidate() {
  cache.clear();
}

/** Cambió un dominio web de sub-marca (white-label/routes.ts): la caché de Host → organización ya no vale. */
export const invalidateDomainCache = invalidate;

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
  // Sin el punto final: "firmas.cliente.com." es el mismo dominio (el navegador lo abre con el mismo certificado), pero
  // no coincidía y ahí se servía la cuenta con su cookie de sesión, como si fuera un host ajeno a la organización.
  const h = (host ?? "").split(":")[0].toLowerCase().replace(/\.+$/, "");
  if (!h || h === appHost() || h === "localhost" || h === "127.0.0.1") return null;
  return cached(`h:${h}`, async () => {
    const r = await db.one<any>(`SELECT tenant_id FROM custom_domains WHERE domain = $1 AND status = 'verified'`, [h]);
    return r?.tenant_id ?? null;
  });
}

/**
 * Organización dueña del Host como dominio "de firmantes": su dominio propio verificado o el dominio web verificado de
 * una de sus sub-marcas (brand_domains). En los dos la organización controla el DNS, así que los dos necesitan el mismo
 * aislamiento de la sesión de cuenta y de los links de firma de otras organizaciones.
 */
async function signerHostTenant(db: Db, host: string | undefined): Promise<string | null> {
  const h = (host ?? "").split(":")[0].toLowerCase().replace(/\.+$/, "");
  if (!h || h === appHost() || h === "localhost" || h === "127.0.0.1") return null;
  return cached(`s:${h}`, async () => {
    const r = await db.one<any>(
      `SELECT tenant_id FROM custom_domains WHERE domain = $1 AND status = 'verified'
       UNION ALL SELECT tenant_id FROM brand_domains WHERE domain = $1 AND status = 'verified' LIMIT 1`,
      [h],
    );
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
/** Puntos por control fallido: falta el TXT o el dominio ya no apunta a la plataforma (2), error de DNS (1). */
const MISS_POINTS = 2;
const ERROR_POINTS = 1;
const DEMOTE_AT = 4;

/**
 * Vuelve a consultar los dominios verificados. Sin esto un dominio quedaba verificado para siempre: si la organización
 * lo perdía (venció y lo registró otro, o quedó un CNAME colgado que alguien reclamó), los correos seguían mandando los
 * links de firma —que dan acceso al sobre— a un host que ya no controla.
 * - El TXT solo no alcanza: es público (queda en los historiales de DNS) y quien se quede con el dominio puede volver
 *   a publicarlo. Por eso también se exige que el dominio siga apuntando a la plataforma (CNAME o IP).
 * - Cada control fallido suma puntos (falta: 2, error de DNS: 1) y con DEMOTE_AT seguidos el dominio vuelve a
 *   "pendiente": dos faltas (12 h) o cuatro errores (24 h). Antes un error nunca contaba, así que un dominio que solo
 *   devolvía errores no se desverificaba nunca. Un control correcto pone el contador en cero.
 * Al desverificarse, los links pasan al dominio de la plataforma y Caddy deja de emitir certificados para él. La
 * organización lo vuelve a verificar desde Ajustes.
 */
export async function recheckVerifiedDomains(
  d: { db: Db; log: { warn(o: object, m?: string): void } },
  deps: { txt?: (name: string) => Promise<string[]>; routes?: (domain: string) => Promise<boolean>; limit?: number } = {},
) {
  const txt = deps.txt ?? resolveTxt;
  const routes = deps.routes ?? routesToPlatform;
  const rows = await d.db.query<any>(
    `SELECT * FROM custom_domains WHERE status = 'verified' AND (last_checked_at IS NULL OR last_checked_at < now() - make_interval(hours => $1))
      ORDER BY last_checked_at NULLS FIRST LIMIT $2`,
    [RECHECK_HOURS, deps.limit ?? 20],
  );
  let demoted = 0;
  for (const r of rows) {
    let points: number;
    let problem: string;
    try {
      const values = await txt(txtName(r.domain));
      if (!values.includes(txtValue(r.verification_token))) {
        points = MISS_POINTS;
        problem = `Re-verificación: no se encontró el registro TXT ${txtName(r.domain)}`;
      } else if (!(await routes(r.domain))) {
        points = MISS_POINTS;
        problem = `Re-verificación: ${r.domain} ya no apunta a ${appHost()} (CNAME o dirección IP)`;
      } else {
        await d.db.query(`UPDATE custom_domains SET last_checked_at = now(), last_error = NULL, recheck_failures = 0 WHERE id = $1`, [r.id]);
        continue;
      }
    } catch (e) {
      points = ERROR_POINTS;
      problem = `Re-verificación: no se pudo consultar el DNS (${String((e as Error).message ?? e).slice(0, 200)})`;
      d.log.warn({ domain: r.domain, err: String((e as Error).message ?? e) }, "no se pudo re-verificar el dominio propio");
    }
    const failures = Number(r.recheck_failures ?? 0) + points;
    if (failures < DEMOTE_AT) {
      await d.db.query(`UPDATE custom_domains SET last_checked_at = now(), last_error = $2, recheck_failures = $3 WHERE id = $1`, [
        r.id,
        `${problem}: si sigue fallando, el dominio deja de usarse`,
        failures,
      ]);
      continue;
    }
    const down = await d.db.query(
      `UPDATE custom_domains SET status = 'pending', last_checked_at = now(), last_error = $2, recheck_failures = 0 WHERE id = $1 AND status = 'verified' RETURNING id`,
      [r.id, `${problem} en controles seguidos: el dominio dejó de usarse hasta que se vuelva a verificar`],
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
      data: { reason: points === ERROR_POINTS ? "dns_error" : problem.includes("TXT") ? "txt_missing" : "not_routed" },
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
    // También tiene que llevar a la plataforma (como exige el rechequeo periódico): con solo el TXT, un dominio que
    // apunta a otro lado (p. ej. uno que cambió de dueño y conservó el TXT) volvía a quedar verificado y los correos
    // mandaban links de firma, con su token, a un host ajeno.
    if (ok && !isLocalEnv()) {
      const routed = await routesToPlatform(r.domain).catch(() => false);
      if (!routed) {
        ok = false;
        error = `El dominio todavía no apunta a CalaSign: creá el CNAME ${r.domain} → ${appHost()} y volvé a verificar`;
      }
    }
    if (ok && r.status !== "verified") {
      const other = await s.db.one(`SELECT 1 FROM custom_domains WHERE domain = $1 AND status = 'verified' AND tenant_id <> $2`, [r.domain, a.tenantId]);
      if (other) {
        ok = false;
        error = "Ese dominio ya lo verificó otra organización";
      }
    }
    // Ni como dominio web de una sub-marca (white-label/routes.ts hace el chequeo inverso): con los dos verificados, la
    // marca, los links y el aislamiento de sesión dependían de qué tabla se consultaba primero.
    if (ok && (await s.db.one(`SELECT 1 FROM brand_domains WHERE domain = $1 AND status = 'verified'`, [r.domain]))) {
      ok = false;
      error = "Ese dominio ya está en uso";
    }
    try {
      await s.db.query(
        `UPDATE custom_domains SET status = CASE WHEN $2 THEN 'verified' ELSE status END,
           verified_at = CASE WHEN $2 AND verified_at IS NULL THEN now() ELSE verified_at END,
           last_checked_at = now(), last_error = $3, recheck_failures = CASE WHEN $2 THEN 0 ELSE recheck_failures END WHERE id = $1`,
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

  // Un dominio propio (o el de una sub-marca) sirve lo que ven los firmantes (/s, /f, /wf, /n, /verify…), nunca la cuenta: la organización
  // controla su DNS y podría quedarse con la cookie de sesión de quien entra ahí, que vale en el dominio de la
  // plataforma y en sus otras organizaciones. Las páginas de la cuenta redirigen a la plataforma, las rutas que crean
  // una sesión no existen acá, y la cookie de sesión de cuenta se ignora.
  // Por lista blanca: la cuenta solo existe en el host de la plataforma (APP_URL; en local, también localhost). Antes se
  // aplicaba solo a los dominios verificados, y uno que dejaba de estarlo (borrado o desverificado) pero seguía
  // apuntando a la plataforma, con su certificado todavía vigente, servía el login real y se quedaba con la cookie.
  app.addHook("onRequest", async (req, reply) => {
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    const platform = host === appHost() || (config.environment === "local" && (host === "localhost" || host === "127.0.0.1"));
    if (platform) return;
    const path = requestPath(req);
    if (req.method === "GET" && (path === "/" || ACCOUNT_PAGES.some((p) => under(path, p)))) {
      return reply.redirect(`${config.appUrl}${req.url}`, 302);
    }
    if (ACCOUNT_APIS.some((p) => under(path, p))) {
      return reply.code(401).send({ error: { code: "use_platform_host", message: `En un dominio propio no se inicia sesión: entrá por ${config.appUrl}` } });
    }
    // @fastify/cookie ya parseó las cookies (su hook corre antes): se quita la de sesión de las dos partes.
    const cookie = req.headers.cookie;
    if (cookie?.includes(`${SESSION_COOKIE}=`)) {
      req.headers.cookie = cookie
        .split(";")
        .filter((c) => c.trim().split("=")[0] !== SESSION_COOKIE)
        .join(";");
    }
    if (req.cookies && SESSION_COOKIE in req.cookies) delete req.cookies[SESSION_COOKIE];
  });

  // En un dominio propio, los links de firma de OTRAS organizaciones no funcionan.
  app.addHook("onRequest", async (req, reply) => {
    const path = requestPath(req);
    if (!path.startsWith("/v1/signing/")) return;
    const tenantId = await signerHostTenant(s.db, req.headers.host);
    if (!tenantId) return;
    const token = path.split("/")[3] ?? "";
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
