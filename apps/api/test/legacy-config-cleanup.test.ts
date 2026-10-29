// Configuraciones guardadas antes de validaciones nuevas (migración 0082): textos protegidos de la marca blanca
// (verify.* / val.*) y comodines de frame-ancestors demasiado amplios. Se descartan (no dan 400) al guardar, no se
// devuelven ni se aplican al leer, y la migración los borra. App real sobre PGlite.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-legacy-config-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let tenant = "";
let cookie = "";
const H = () => ({ cookie, origin: "http://localhost:5173" });
const GOOD = "https://app.cliente.test";
const BAD = "https://*.com.ar";
const LEGACY_TEXTS = {
  es: { "verify.noMatchTitle": "Documento válido ✓", "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" },
  en: { "val.intact": "OK" },
};

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: "duena@legacy.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Legacy" },
  });
  expect(res.statusCode).toBe(201);
  cookie = `cs_session=${res.cookies.find((x) => x.name === "cs_session")!.value}`;
  tenant = res.json().tenant.id;
  await db.query(`UPDATE tenants SET billing_plan = 'enterprise' WHERE id = $1`, [tenant]);
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

/** Aplica la 0082 otra vez (como el runner: sin comentarios, cortada en ';' a fin de línea). */
async function run0082() {
  const sql = readFileSync(join(__dirname, "../migrations/0082_white_label_texts_frame_ancestors.sql"), "utf8");
  const stmts = sql
    .replace(/--[^\n]*(\n|$)/g, "\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) await db.query(s);
}

const frameAncestors = (csp: unknown) => /frame-ancestors ([^;]*)/.exec(String(csp ?? ""))?.[1]?.trim();

describe("marca blanca: textos protegidos guardados antes de la validación", () => {
  it("PUT de la marca por defecto con la configuración completa (con claves viejas) → 200 y se descartan", async () => {
    await db.query(`UPDATE tenants SET branding = COALESCE(branding,'{}'::jsonb) || $2::jsonb WHERE id = $1`, [
      tenant,
      JSON.stringify({ whiteLabel: { texts: LEGACY_TEXTS } }),
    ]);
    const get = await app.inject({ method: "GET", url: "/v1/settings/brands/default", headers: H() });
    expect(get.statusCode).toBe(200);
    // Al devolver ya no aparecen.
    expect(get.json().config.texts).toEqual({ es: { "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" } });
    // La consola (o una versión vieja) manda las claves viejas: se descartan.
    const put = await app.inject({
      method: "PUT",
      url: "/v1/settings/brands/default",
      headers: H(),
      payload: { config: { ...get.json().config, texts: LEGACY_TEXTS } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().config.texts).toEqual({ es: { "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" } });
    const stored = await db.one<any>(`SELECT branding->'whiteLabel'->'texts' AS t FROM tenants WHERE id = $1`, [tenant]);
    expect(stored.t).toEqual({ es: { "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" }, en: {} });
  });

  it("PUT de una sub-marca con claves viejas → 200 y se descartan", async () => {
    const id = util.uuidv7();
    await db.query(`INSERT INTO brands (id, tenant_id, name, slug, config) VALUES ($1,$2,'Sub','sub-legacy',$3)`, [
      id,
      tenant,
      JSON.stringify({ texts: LEGACY_TEXTS }),
    ]);
    const get = await app.inject({ method: "GET", url: `/v1/settings/brands/${id}`, headers: H() });
    expect(get.json().config.texts).toEqual({ es: { "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" } });
    const put = await app.inject({ method: "PUT", url: `/v1/settings/brands/${id}`, headers: H(), payload: { config: { texts: LEGACY_TEXTS } } });
    expect(put.statusCode).toBe(200);
    const stored = await db.one<any>(`SELECT config->'texts'->'es' AS es FROM brands WHERE id = $1`, [id]);
    expect(stored.es).toEqual({ "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" });
  });

  it("0082 borra las claves protegidas de brands.config y tenants.branding (un idioma vacío se quita)", async () => {
    const id = util.uuidv7();
    await db.query(`INSERT INTO brands (id, tenant_id, name, slug, config) VALUES ($1,$2,'Mig','mig-legacy',$3)`, [
      id,
      tenant,
      JSON.stringify({ productName: "X", texts: LEGACY_TEXTS }),
    ]);
    await db.query(`UPDATE tenants SET branding = jsonb_set(branding, '{whiteLabel}', $2::jsonb) WHERE id = $1`, [
      tenant,
      JSON.stringify({ hidePoweredBy: true, texts: LEGACY_TEXTS }),
    ]);
    await run0082();
    const b = await db.one<any>(`SELECT config FROM brands WHERE id = $1`, [id]);
    expect(b.config).toEqual({ productName: "X", texts: { es: { "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" } } });
    const t = await db.one<any>(`SELECT branding->'whiteLabel' AS w FROM tenants WHERE id = $1`, [tenant]);
    expect(t.w).toEqual({ hidePoweredBy: true, texts: { es: { "verify.title": "Mi verificación", "sign.doneTitle": "¡Listo!" } } });
  });
});

describe("frame-ancestors: comodines demasiado amplios guardados antes de la validación", () => {
  it("no se devuelven ni se aplican al CSP; el PATCH con la lista completa los descarta con aviso; uno nuevo sigue dando 400", async () => {
    await db.query(`UPDATE tenants SET embed_frame_ancestors = $2 WHERE id = $1`, [tenant, [GOOD, BAD]]);
    const get = await app.inject({ method: "GET", url: "/v1/settings/embed", headers: H() });
    expect(get.json()).toEqual({ frameAncestors: [GOOD] });

    // Página del firmante embebido (originsForRecipient): ni el CSP ni /v1/signing/:token/embed incluyen el comodín.
    const envelope = util.uuidv7();
    const recipient = util.uuidv7();
    const token = util.randomToken();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [envelope, tenant]);
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc, embedded, auth_method)
       VALUES ($1,$2,$3,'signer','Ana','ana@x.test','sent',$4,$5,true,'link')`,
      [recipient, tenant, envelope, util.sha256Hex(token), util.encrypt(token)],
    );
    const su = await app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/recipients/${recipient}/signing-url`, headers: H(), payload: {} });
    expect(su.statusCode).toBe(201);
    const ex = await app.inject({ method: "GET", url: `/embed/${String(su.json().url).split("/embed/")[1]}` });
    expect(frameAncestors(ex.headers["content-security-policy"])).toBe(`'self' ${GOOD}`);
    const page = await app.inject({ method: "GET", url: String(ex.headers.location) });
    expect(frameAncestors(page.headers["content-security-policy"])).toBe(`'self' ${GOOD}`);
    expect((await app.inject({ method: "GET", url: `/v1/signing/${token}/embed` })).json().origins).toEqual([GOOD]);

    const patch = await app.inject({ method: "PATCH", url: "/v1/settings/embed", headers: H(), payload: { frameAncestors: [GOOD, BAD] } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toEqual({ frameAncestors: [GOOD], discarded: [BAD] });
    expect((await db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [tenant])).embed_frame_ancestors).toEqual([GOOD]);

    const fresh = await app.inject({
      method: "PATCH",
      url: "/v1/settings/embed",
      headers: H(),
      payload: { frameAncestors: [GOOD, "https://*.github.io"] },
    });
    expect(fresh.statusCode).toBe(400);
  });

  it("0082 quita los comodines inválidos de tenants.embed_frame_ancestors y deja el resto en orden", async () => {
    await db.query(`UPDATE tenants SET embed_frame_ancestors = $2 WHERE id = $1`, [
      tenant,
      ["https://*.cliente.test", BAD, GOOD, "https://*.github.io:8443", "https://*.co", "http://localhost:5173"],
    ]);
    await run0082();
    expect((await db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [tenant])).embed_frame_ancestors).toEqual([
      "https://*.cliente.test",
      GOOD,
      "http://localhost:5173",
    ]);
  });
});
