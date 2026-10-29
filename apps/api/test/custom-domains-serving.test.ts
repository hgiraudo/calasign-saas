// Dominios propios: CUSTOM_DOMAINS_SERVING (links al dominio solo si el entorno lo sirve), aislamiento entre
// organizaciones en todas las rutas públicas con link, Turnstile con dominios de sub-marca, rechequeo en local sin DNS,
// dominios reservados con sufijos públicos y Vary: Host.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-domains-serving-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let config: (typeof import("../src/config"))["config"];
let uuidv7: () => string;
let sha256Hex: (s: string) => string;
const KEY = "cs_test_domains_serving_key";
const auth = { authorization: `Bearer ${KEY}` };
const A = { tenant: "", domain: "firmas.org-a.test", brand: "", brandDomain: "marca.org-a.test" };
const B = { tenant: "", domain: "firmas.org-b.test" };

async function tenantWithDomain(name: string, domain: string) {
  const id = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)`, [id, `t-${id.slice(-8)}`, name]);
  await db.query(
    `INSERT INTO custom_domains (id, tenant_id, domain, verification_token, status, verified_at) VALUES ($1,$2,$3,'tok','verified',now())`,
    [uuidv7(), id, domain],
  );
  return id;
}

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const util = await import("../src/lib/util");
  config = (await import("../src/config")).config;
  uuidv7 = util.uuidv7;
  sha256Hex = (s) => util.sha256Hex(s);
  db = await createDb();
  await migrate(db);
  A.tenant = await tenantWithDomain("Org A", A.domain);
  B.tenant = await tenantWithDomain("Org B", B.domain);
  A.brand = uuidv7();
  await db.query(`INSERT INTO brands (id, tenant_id, name, slug) VALUES ($1,$2,'Marca','marca-a-${A.brand.slice(-8)}')`, [A.brand, A.tenant]);
  await db.query(
    `INSERT INTO brand_domains (id, tenant_id, brand_id, domain, verification_token, status, verified_at) VALUES ($1,$2,$3,$4,'tok','verified',now())`,
    [uuidv7(), A.tenant, A.brand, A.brandDomain],
  );
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [
    uuidv7(),
    A.tenant,
    util.sha256Hex(KEY),
  ]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);

afterAll(async () => {
  config.customDomainsServing = false;
  await app?.close();
});

describe("CUSTOM_DOMAINS_SERVING", () => {
  it("por defecto false: los links quedan en la plataforma y las respuestas avisan; en true usan el dominio verificado", async () => {
    const { tenantBaseUrl, invalidateDomainCache } = await import("../src/modules/custom-domains");
    const { brandBaseUrl } = await import("../src/modules/white-label/brand");
    expect(config.customDomainsServing).toBe(false);
    expect(await tenantBaseUrl(db, A.tenant)).toBe(config.appUrl);
    expect(await brandBaseUrl(db, A.tenant, A.brand)).toBe(config.appUrl);
    const get = await app.inject({ method: "GET", url: "/v1/domains", headers: auth });
    expect(get.json().domain).toMatchObject({ domain: A.domain, servingEnabled: false });
    expect(get.json().domain.notice).toMatch(/no están habilitados en este entorno/);

    // La verificación sigue funcionando (TXT de prueba en local) y la respuesta trae el aviso.
    await app.inject({ method: "PUT", url: "/v1/domains", headers: auth, payload: { domain: "nuevo.org-a.test" } });
    const pending = (await app.inject({ method: "GET", url: "/v1/domains", headers: auth })).json().domain;
    await app.inject({ method: "POST", url: "/dev/dns-stub", payload: { name: pending.txtName, values: [pending.txtValue] } });
    const verified = await app.inject({ method: "POST", url: "/v1/domains/verify", headers: auth });
    expect(verified.json().domain).toMatchObject({ domain: "nuevo.org-a.test", status: "verified", servingEnabled: false });
    expect(verified.json().domain.notice).toMatch(/no están habilitados/);
    expect(await tenantBaseUrl(db, A.tenant)).toBe(config.appUrl);

    config.customDomainsServing = true;
    try {
      invalidateDomainCache();
      expect(await tenantBaseUrl(db, A.tenant)).toBe("https://nuevo.org-a.test");
      expect(await brandBaseUrl(db, A.tenant, A.brand)).toBe(`https://${A.brandDomain}`);
      const on = (await app.inject({ method: "GET", url: "/v1/domains", headers: auth })).json().domain;
      expect(on).toMatchObject({ servingEnabled: true, notice: null });
    } finally {
      config.customDomainsServing = false;
      // Vuelve al dominio original de A para el resto de las pruebas.
      await db.query(`UPDATE custom_domains SET domain = $2 WHERE tenant_id = $1`, [A.tenant, A.domain]);
      invalidateDomainCache();
    }
  });
});

describe("aislamiento de links públicos por dominio de firmantes", () => {
  it("negociaciones, ejecuciones de workflow y vueltas de pago e identidad de otra organización → 404", async () => {
    // Datos de la organización B.
    const negId = uuidv7();
    const negToken = "n".repeat(10) + "Tok_negociacion_B1";
    await db.query(`INSERT INTO negotiations (id, tenant_id, title) VALUES ($1,$2,'N')`, [negId, B.tenant]);
    await db.query(
      `INSERT INTO negotiation_participants (id, negotiation_id, tenant_id, name, email, token_hash, token_enc) VALUES ($1,$2,$3,'P','p@x.test',$4,'x')`,
      [uuidv7(), negId, B.tenant, sha256Hex(negToken)],
    );
    const wfId = uuidv7();
    const runToken = "r".repeat(10) + "Tok_ejecucion_B_123";
    await db.query(`INSERT INTO workflows (id, tenant_id, name, steps, signing_secret_enc) VALUES ($1,$2,'W','[]','x')`, [wfId, B.tenant]);
    await db.query(`INSERT INTO workflow_runs (id, tenant_id, workflow_id, steps, public_token_hash) VALUES ($1,$2,$3,'[]',$4)`, [
      uuidv7(),
      B.tenant,
      wfId,
      sha256Hex(runToken),
    ]);
    const env = uuidv7();
    const rec = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject) VALUES ($1,$2,'S')`, [env, B.tenant]);
    await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email) VALUES ($1,$2,$3,'signer','R','r@x.test')`, [
      rec,
      B.tenant,
      env,
    ]);
    const payId = uuidv7();
    await db.query(
      `INSERT INTO envelope_payments (id, tenant_id, envelope_id, recipient_id, provider, amount, currency, description) VALUES ($1,$2,$3,$4,'mock',10,'ARS','d')`,
      [payId, B.tenant, env, rec],
    );
    const idvId = uuidv7();
    await db.query(
      `INSERT INTO identity_verifications (id, tenant_id, envelope_id, recipient_id, provider, level) VALUES ($1,$2,$3,$4,'mock','document')`,
      [idvId, B.tenant, env, rec],
    );

    const urls = [
      `/v1/public/negotiations/${negToken}`,
      `/v1/public/negotiations/${negToken}/diff`,
      `/v1/public/workflow-runs/${runToken}`,
      `/v1/payments/return/${payId}`,
      `/v1/identity/return/${idvId}`,
    ];
    const blocked = (r: { statusCode: number; body: string }) => r.statusCode === 404 && r.body.includes("Link no encontrado");
    for (const url of urls) {
      // En el dominio de A (propio o de su sub-marca), los links de B no abren.
      expect(blocked(await app.inject({ method: "GET", url, headers: { host: A.domain } })), `${url} en ${A.domain}`).toBe(true);
      expect(blocked(await app.inject({ method: "GET", url, headers: { host: A.brandDomain } })), `${url} en ${A.brandDomain}`).toBe(true);
      // En el de B y en la plataforma, el gancho no corta (la ruta responde lo suyo).
      expect(blocked(await app.inject({ method: "GET", url, headers: { host: B.domain } })), `${url} en ${B.domain}`).toBe(false);
      expect(blocked(await app.inject({ method: "GET", url })), `${url} en la plataforma`).toBe(false);
    }
  });
});

describe("Turnstile: hostnames aceptados", () => {
  it("la plataforma, el dominio propio y el de una sub-marca de la organización; no los de otra", async () => {
    const { turnstileHostOk } = await import("../src/modules/custom-domains");
    const ok = turnstileHostOk(db, A.tenant);
    expect(await ok(new URL(config.appUrl).hostname)).toBe(true);
    expect(await ok(A.domain)).toBe(true);
    expect(await ok(A.brandDomain)).toBe(true);
    expect(await ok(B.domain)).toBe(false);
    expect(await ok("desconocido.example.com")).toBe(false);
  });
});

describe("re-verificación en local", () => {
  it("sin routes inyectado no consulta el DNS de ruteo (en local no lleva a la plataforma)", async () => {
    const { recheckVerifiedDomains } = await import("../src/modules/custom-domains");
    await db.query(`UPDATE custom_domains SET verification_token = 'tok', last_checked_at = now() - interval '7 hours', recheck_failures = 0`);
    const realFetch = globalThis.fetch;
    let dnsCalls = 0;
    globalThis.fetch = (async () => {
      dnsCalls++;
      throw new Error("sin red");
    }) as typeof fetch;
    try {
      const r = await recheckVerifiedDomains({ db, log: { warn() {} } }, { txt: async () => ["calasign-verify=tok"] });
      expect(r.checked).toBeGreaterThan(0);
      expect(dnsCalls).toBe(0);
      const row = await db.one<any>(`SELECT status, last_error, recheck_failures FROM custom_domains WHERE tenant_id = $1`, [A.tenant]);
      expect(row).toMatchObject({ status: "verified", last_error: null, recheck_failures: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("dominios reservados", () => {
  it("con APP_URL en un ccTLD de segundo nivel se reserva el dominio registrable, no el sufijo público", async () => {
    const { reservedDomainRoots, assertClaimableDomain } = await import("../src/modules/custom-domains");
    const prevUrl = config.appUrl;
    const prevHosts = config.platformHosts;
    config.appUrl = "https://app.calasign.com.ar";
    config.platformHosts = ["firmar.otramarca.co.uk", "localhost"];
    try {
      const roots = reservedDomainRoots();
      expect(roots).toContain("calasign.com.ar");
      expect(roots).toContain("otramarca.co.uk");
      expect(roots).not.toContain("com.ar");
      expect(() => assertClaimableDomain("firmas.calasign.com.ar")).toThrow(/calasign\.com\.ar/);
      expect(() => assertClaimableDomain("calasign.com.ar")).toThrow();
      expect(() => assertClaimableDomain("x.otramarca.co.uk")).toThrow();
      expect(() => assertClaimableDomain("algo.calasign.io")).toThrow();
      // Otro dominio bajo com.ar se puede reclamar (antes quedaba reservado todo com.ar).
      expect(() => assertClaimableDomain("firmas.cliente.com.ar")).not.toThrow();
    } finally {
      config.appUrl = prevUrl;
      config.platformHosts = prevHosts;
    }
  });
});

describe("marca por Host", () => {
  it("host-branding y brand-theme responden con Vary: Host", async () => {
    const hb = await app.inject({ method: "GET", url: "/v1/public/host-branding", headers: { host: A.domain } });
    expect(hb.statusCode).toBe(200);
    expect(String(hb.headers.vary)).toMatch(/host/i);
    const miss = await app.inject({ method: "GET", url: "/v1/public/host-branding", headers: { host: "desconocido.example.com" } });
    expect(String(miss.headers.vary)).toMatch(/host/i);
    const theme = await app.inject({ method: "GET", url: "/v1/public/brand-theme", headers: { host: A.brandDomain } });
    expect(theme.statusCode).toBe(200);
    expect(String(theme.headers.vary)).toMatch(/host/i);
  });

  it("brandForHost se cachea brevemente y se invalida cuando cambia un dominio", async () => {
    const { brandForHost } = await import("../src/modules/white-label/brand");
    const { invalidateDomainCache } = await import("../src/modules/custom-domains");
    expect(await brandForHost(db, A.brandDomain)).toEqual({ tenantId: A.tenant, brandId: A.brand });
    await db.query(`UPDATE brand_domains SET status = 'pending' WHERE brand_id = $1`, [A.brand]);
    // Dentro de la ventana de la caché sigue la respuesta anterior (sin consulta a la base).
    expect(await brandForHost(db, A.brandDomain)).toEqual({ tenantId: A.tenant, brandId: A.brand });
    invalidateDomainCache();
    expect(await brandForHost(db, A.brandDomain)).toBeNull();
    await db.query(`UPDATE brand_domains SET status = 'verified' WHERE brand_id = $1`, [A.brand]);
    invalidateDomainCache();
  });

  it("una consulta en curso durante un cambio de dominio no deja en la caché el valor anterior (tenantForHost, brandForHost)", async () => {
    const { brandForHost } = await import("../src/modules/white-label/brand");
    const { tenantForHost, invalidateDomainCache } = await import("../src/modules/custom-domains");
    // Base falsa: la primera consulta de custom_domains se demora y devuelve el valor previo al cambio.
    const slowDb = () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const state = { domainQueries: 0 };
      const fake = {
        one: async (sql: string) => {
          if (!/custom_domains/.test(sql)) return null;
          if (++state.domainQueries === 1) {
            await gate;
            return { tenant_id: "organizacion-anterior" };
          }
          return null;
        },
      } as unknown as Db;
      return { fake, release, state };
    };

    const t = slowDb();
    const pending = tenantForHost(t.fake, "carrera-1.example.org");
    await new Promise((r) => setImmediate(r));
    invalidateDomainCache();
    t.release();
    expect(await pending).toBe("organizacion-anterior");
    expect(await tenantForHost(t.fake, "carrera-1.example.org")).toBeNull();
    expect(t.state.domainQueries).toBe(2);

    const b = slowDb();
    const pendingBrand = brandForHost(b.fake, "carrera-2.example.org");
    await new Promise((r) => setImmediate(r));
    invalidateDomainCache();
    b.release();
    expect(await pendingBrand).toEqual({ tenantId: "organizacion-anterior", brandId: null });
    expect(await brandForHost(b.fake, "carrera-2.example.org")).toBeNull();
  });
});
