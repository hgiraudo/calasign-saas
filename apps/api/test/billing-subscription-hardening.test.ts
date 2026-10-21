// Suscripciones: cambios solo con sesión de usuario, proveedores configurados (webhook incluido) y por moneda, y baja
// programada / estado de la suscripción en el resumen.
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-billing-sub-"));
delete process.env.DATABASE_URL;

let server: Server;
let siteId = "MLB";
let meCalls = 0;
let meMode: "ok" | "error" | "slow" = "ok";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/users/me")) {
      meCalls++;
      if (meMode === "error") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (meMode === "slow") return; // nunca responde: corta el timeout
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 1, site_id: siteId }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { config } = await import("../src/config");
  config.billing.mercadopago.apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

async function setup(o: { env?: string; stripeKey?: string | null; stripeHook?: string | null; mpToken?: string | null; mpHook?: string | null; mpCurrencies?: string[]; mock?: boolean }) {
  const { config } = await import("../src/config");
  const p = await import("../src/modules/billing/providers");
  config.environment = o.env ?? "dev";
  config.billing.stripe.secretKey = o.stripeKey ?? null;
  config.billing.stripe.webhookSecret = o.stripeHook ?? null;
  config.billing.mercadopago.accessToken = o.mpToken ?? null;
  config.billing.mercadopago.webhookSecret = o.mpHook ?? null;
  config.billing.mercadopago.currencies = o.mpCurrencies ?? [];
  config.billing.mockEnabled = o.mock ?? false;
  p.resetMpCurrencyCache();
  return p;
}

describe("proveedores de suscripción", () => {
  beforeEach(() => {
    meCalls = 0;
    meMode = "ok";
  });

  it("Stripe exige STRIPE_WEBHOOK_SECRET; Mercado Pago, MP_WEBHOOK_SECRET en producción", async () => {
    let p = await setup({ stripeKey: "sk_test", mpToken: "TEST-1" });
    expect(p.subscriptionProviderConfigured("stripe")).toBe(false);
    expect(p.subscriptionProviderConfigured("mercadopago")).toBe(true); // fuera de producción alcanza el token
    p = await setup({ env: "prod", stripeKey: "sk_live", stripeHook: "whsec", mpToken: "APP-1" });
    expect(p.subscriptionProviderConfigured("stripe")).toBe(true);
    expect(p.subscriptionProviderConfigured("mercadopago")).toBe(false);
    p = await setup({ env: "prod", mpToken: "APP-1", mpHook: "s", mock: true });
    expect(p.subscriptionProviderConfigured("mercadopago")).toBe(true);
    expect(p.subscriptionProviderConfigured("mock")).toBe(false); // el simulado nunca en producción
  });

  it("Mercado Pago solo en sus monedas (MP_CURRENCIES); pickProvider no lo elige en otra", async () => {
    await setup({ stripeKey: "sk_test", stripeHook: "whsec", mpToken: "TEST-1", mpCurrencies: ["BRL"] });
    const { subscriptionProvidersFor } = await import("../src/modules/billing/providers");
    const { pickProvider } = await import("../src/modules/billing/subscriptions");
    const brl = await subscriptionProvidersFor("BRL");
    expect(brl.find((x) => x.id === "mercadopago")).toEqual({ id: "mercadopago", configured: true, currencies: ["BRL"] });
    const cop = await subscriptionProvidersFor("COP");
    expect(cop.find((x) => x.id === "mercadopago")?.configured).toBe(false);
    expect(cop.find((x) => x.id === "stripe")?.configured).toBe(true);
    expect(await pickProvider(undefined, "BRL")).toBe("mercadopago");
    expect(await pickProvider(undefined, "COP")).toBe("stripe");
    await expect(pickProvider("mercadopago", "COP")).rejects.toMatchObject({ status: 400, code: "provider_currency_unsupported" });
    await expect(pickProvider("mock", "COP")).rejects.toMatchObject({ code: "provider_not_configured" });
  });

  it("sin MP_CURRENCIES usa la moneda de la cuenta (cacheada, una consulta en vuelo) y, sin token, ninguna", async () => {
    let p = await setup({ mpToken: "TEST-1" });
    siteId = "MLB";
    const [a, b] = await Promise.all([p.mpSubscriptionCurrencies(), p.mpSubscriptionCurrencies()]);
    expect(a).toEqual(["BRL"]);
    expect(b).toEqual(["BRL"]);
    expect(await p.mpSubscriptionCurrencies()).toEqual(["BRL"]);
    expect(meCalls).toBe(1);
    // Con un valor bueno, un error posterior no lo pisa (no se vuelve a consultar).
    meMode = "error";
    expect(await p.mpSubscriptionCurrencies()).toEqual(["BRL"]);
    p = await setup({});
    expect(await p.mpSubscriptionCurrencies()).toEqual([]);
    // Sin proveedores no hay ninguno disponible: pickProvider explica la moneda.
    const { pickProvider } = await import("../src/modules/billing/subscriptions");
    await expect(pickProvider(undefined, "USD")).rejects.toMatchObject({ code: "provider_not_configured" });
  });
});

describe("moneda de Mercado Pago desconocida", () => {
  beforeEach(() => {
    meCalls = 0;
    meMode = "ok";
  });

  it("si /users/me falla y nunca hubo un valor bueno, Mercado Pago no se ofrece (no ARS) y no reintenta enseguida", async () => {
    const p = await setup({ mpToken: "TEST-1" });
    meMode = "error";
    expect(await p.mpSubscriptionCurrencies()).toEqual([]);
    const ars = await p.subscriptionProvidersFor("ARS");
    expect(ars.find((x) => x.id === "mercadopago")).toMatchObject({ configured: false, currencies: [] });
    expect(meCalls).toBe(1);
    // Pedirlo explícitamente: 503 pasajero con reintento, no «no cobra en esa moneda».
    const { pickProvider } = await import("../src/modules/billing/subscriptions");
    const err = await pickProvider("mercadopago", "BRL").catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "provider_unavailable" });
    expect(err.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(ars.find((x) => x.id === "mercadopago")?.misconfigured).toBeUndefined();
  });

  it("site_id desconocido: error de configuración (422 provider_misconfigured, sin reintento), no 503", async () => {
    const p = await setup({ mpToken: "TEST-1" });
    siteId = "MXX";
    try {
      expect(await p.mpSubscriptionCurrencies()).toEqual([]);
      expect(p.mpCurrencyMisconfigured()).toBe(true);
      const ars = await p.subscriptionProvidersFor("ARS");
      expect(ars.find((x) => x.id === "mercadopago")).toMatchObject({ configured: false, currencies: [], misconfigured: true });
      const { pickProvider } = await import("../src/modules/billing/subscriptions");
      const err = await pickProvider("mercadopago", "BRL").catch((e) => e);
      expect(err).toMatchObject({ status: 422, code: "provider_misconfigured" });
      expect(err.details?.retryAfterSeconds).toBeUndefined();
      // Con MP_CURRENCIES definido ya no es un error.
      const { config } = await import("../src/config");
      config.billing.mercadopago.currencies = ["MXN"];
      expect(p.mpCurrencyMisconfigured()).toBe(false);
    } finally {
      siteId = "MLB";
    }
  });

  it("/users/me tiene timeout corto (4 s)", async () => {
    const p = await setup({ mpToken: "TEST-1" });
    meMode = "slow";
    const t0 = Date.now();
    expect(await p.mpSubscriptionCurrencies()).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(6_000);
  }, 10_000);
});

describe("/v1/billing con API key u OAuth", () => {
  const req = (method: string, url: string) => ({ method, url, routeOptions: { url }, params: {}, body: {} }) as any;
  const access = { role: "admin", permissions: new Set(["billing:manage"]), groupIds: [], twoFactorSetupRequired: false } as any;
  const db = {} as any; // /v1/billing no consulta el plan (siempre permitido)

  it("los cambios exigen sesión de usuario; leer el resumen no", async () => {
    const { enforceRoutePolicy } = await import("../src/modules/access");
    const key = { tenantId: "t", userId: null, apiKeyId: "k", actor: { type: "api_key" }, access } as any;
    const oauth = { tenantId: "t", userId: "u", apiKeyId: null, oauth: { clientId: "c", clientPublicId: "c", scopes: [] }, actor: { type: "user" }, access } as any;
    const user = { tenantId: "t", userId: "u", apiKeyId: null, actor: { type: "user" }, access } as any;
    for (const [m, u] of [
      ["POST", "/v1/billing/cancel"],
      ["POST", "/v1/billing/checkout"],
      ["POST", "/v1/billing/portal"],
      ["PATCH", "/v1/billing/currency"],
    ]) {
      await expect(enforceRoutePolicy(db, req(m, u), key)).rejects.toMatchObject({ status: 403, code: "billing_requires_user" });
      await expect(enforceRoutePolicy(db, req(m, u), oauth)).rejects.toMatchObject({ status: 403, code: "billing_requires_user" });
      await expect(enforceRoutePolicy(db, req(m, u), user)).resolves.toBeUndefined();
    }
    await expect(enforceRoutePolicy(db, req("GET", "/v1/billing"), key)).resolves.toBeUndefined();
    // Sin billing:manage, ni la sesión.
    const noPerm = { ...user, access: { ...access, permissions: new Set() } };
    await expect(enforceRoutePolicy(db, req("POST", "/v1/billing/cancel"), noPerm)).rejects.toMatchObject({ status: 403 });
  });
});

describe("baja programada y estado de la suscripción", () => {
  type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
  let db: Db;
  let tenant: string;

  beforeAll(async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { uuidv7 } = await import("../src/lib/util");
    db = await createDb();
    await migrate(db);
    tenant = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
  }, 120_000);
  afterAll(async () => db?.close());

  it("guarda cancel_at_period_end / cancel_at y el estado, y los expone en el resumen", async () => {
    await setup({ stripeKey: "sk_test", stripeHook: "whsec" });
    const { applySubscription, billingOverview } = await import("../src/modules/billing/subscriptions");
    const base = { plan: "business" as const, provider: "stripe" as const, customerId: "cus_1", subscriptionId: "sub_1", source: "Stripe" };
    await applySubscription(db, tenant, { ...base, status: "active", renewsAt: "2026-11-20T00:00:00.000Z" });
    let o = await billingOverview(db, tenant);
    expect(o.subscription).toMatchObject({ status: "active", cancelAtPeriodEnd: false, cancelAt: null, renewsAt: "2026-11-20T00:00:00.000Z" });

    await applySubscription(db, tenant, { ...base, status: "active", cancelAtPeriodEnd: true, cancelAt: "2026-11-20T00:00:00.000Z" });
    o = await billingOverview(db, tenant);
    expect(o.subscription).toMatchObject({ cancelAtPeriodEnd: true, cancelAt: "2026-11-20T00:00:00.000Z" });

    // La misma suscripción sin informar la baja (p. ej. el alta por checkout): se conserva.
    await applySubscription(db, tenant, { ...base, status: "past_due" });
    o = await billingOverview(db, tenant);
    expect(o.subscription).toMatchObject({ status: "past_due", cancelAtPeriodEnd: true, cancelAt: "2026-11-20T00:00:00.000Z" });
    expect(o.plan.id).toBe("business");

    // Reanudada desde el portal.
    await applySubscription(db, tenant, { ...base, status: "active", cancelAtPeriodEnd: false, cancelAt: null });
    o = await billingOverview(db, tenant);
    expect(o.subscription).toMatchObject({ cancelAtPeriodEnd: false, cancelAt: null });

    // Otra suscripción: no hereda la baja de la anterior.
    await applySubscription(db, tenant, { ...base, status: "active", cancelAtPeriodEnd: true, cancelAt: "2026-11-20T00:00:00.000Z" });
    await applySubscription(db, tenant, { ...base, subscriptionId: "sub_2", status: "active" });
    o = await billingOverview(db, tenant);
    expect(o.subscription).toMatchObject({ cancelAtPeriodEnd: false, cancelAt: null });

    // Impaga: pasa a Free, sigue vinculada y el estado queda a la vista.
    await applySubscription(db, tenant, { ...base, plan: "free", subscriptionId: "sub_2", status: "unpaid" });
    o = await billingOverview(db, tenant);
    expect(o.plan.id).toBe("free");
    expect(o.subscription).toMatchObject({ status: "unpaid", provider: "stripe", portalAvailable: true, cancelAtPeriodEnd: false });
    expect(o.providers.find((p) => p.id === "stripe")?.configured).toBe(true);
  });
});
