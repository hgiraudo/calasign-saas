// Control de edición concurrente en los guardados "laterales" del editor (sello, asistencia de IA, visibilidad de la
// plantilla) y en el envío; y el 429 del límite por IP con código rate_limited en español. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-stale-panels-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
const KEY = "cs_test_stale_panels_key";
const auth = { authorization: `Bearer ${KEY}` };
const stale = "2000-01-01T00:00:00.000Z";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { sha256Hex, uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  const tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [
    uuidv7(),
    tenant,
    sha256Hex(KEY),
  ]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function newEnvelope() {
  const r = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "Contrato" } });
  expect(r.statusCode).toBe(201);
  const d = r.json();
  return { id: d.envelope.id as string, updatedAt: d.envelope.updatedAt as string };
}
const envUpdatedAt = async (id: string) =>
  (await app.inject({ method: "GET", url: `/v1/envelopes/${id}`, headers: auth })).json().envelope.updatedAt as string;

describe("sello y asistencia de IA con X-Expected-Updated-At", () => {
  it("seal-options: 409 si el sobre cambió; si no, devuelve el updatedAt nuevo del sobre", async () => {
    const e = await newEnvelope();
    const bad = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${e.id}/seal-options`,
      headers: { ...auth, "x-expected-updated-at": stale },
      payload: { signatureLevel: "advanced" },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("version_changed");
    const ok = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${e.id}/seal-options`,
      headers: { ...auth, "x-expected-updated-at": e.updatedAt },
      payload: { signatureLevel: "advanced" },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.signatureLevel).toBe("advanced");
    expect(body.envelopeUpdatedAt > e.updatedAt).toBe(true);
    expect(body.envelopeUpdatedAt).toBe(await envUpdatedAt(e.id));
    // Sin encabezado (integraciones) no se controla.
    const free = await app.inject({ method: "PUT", url: `/v1/envelopes/${e.id}/seal-options`, headers: auth, payload: { signatureLevel: "simple" } });
    expect(free.statusCode).toBe(200);
  });

  it("ai/settings: 409 si el sobre cambió; si no, devuelve el updatedAt nuevo del sobre", async () => {
    const e = await newEnvelope();
    const bad = await app.inject({
      method: "PATCH",
      url: `/v1/envelopes/${e.id}/ai/settings`,
      headers: { ...auth, "x-expected-updated-at": stale },
      payload: { signerAssist: false },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("version_changed");
    const ok = await app.inject({
      method: "PATCH",
      url: `/v1/envelopes/${e.id}/ai/settings`,
      headers: { ...auth, "x-expected-updated-at": e.updatedAt },
      payload: { signerAssist: false },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().envelopeUpdatedAt > e.updatedAt).toBe(true);
    expect(ok.json().envelopeUpdatedAt).toBe(await envUpdatedAt(e.id));
  });
});

describe("visibilidad de la plantilla con X-Expected-Updated-At", () => {
  it("409 si la plantilla cambió; si no, devuelve su updatedAt (que solo cambia si cambia la visibilidad)", async () => {
    const c = await app.inject({ method: "POST", url: "/v1/templates", headers: auth, payload: { name: "Plantilla" } });
    expect(c.statusCode).toBe(201);
    const tpl = c.json().template;
    const url = `/v1/templates/${tpl.id}/shares`;
    const bad = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "x-expected-updated-at": stale },
      payload: { groupIds: [], visibility: "restricted" },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("version_changed");
    const ok = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "x-expected-updated-at": tpl.updatedAt },
      payload: { groupIds: [], visibility: "restricted" },
    });
    expect(ok.statusCode).toBe(200);
    const after = ok.json().templateUpdatedAt as string;
    expect(after > tpl.updatedAt).toBe(true);
    const same = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "x-expected-updated-at": after },
      payload: { groupIds: [], visibility: "restricted" },
    });
    expect(same.statusCode).toBe(200);
    expect(same.json().templateUpdatedAt).toBe(after);
  });
});

describe("grupos de la plantilla: 404/409 antes que invalid_group", () => {
  it("plantilla inexistente → 404; versión vieja → 409 (aunque el grupo no exista)", async () => {
    const ghostGroup = "00000000-0000-4000-8000-000000000001";
    const missing = await app.inject({
      method: "PUT",
      url: `/v1/templates/00000000-0000-4000-8000-000000000002/shares`,
      headers: auth,
      payload: { groupIds: [ghostGroup] },
    });
    expect(missing.statusCode).toBe(404);
    const c = await app.inject({ method: "POST", url: "/v1/templates", headers: auth, payload: { name: "Plantilla grupos" } });
    const tpl = c.json().template;
    const url = `/v1/templates/${tpl.id}/shares`;
    const bad = await app.inject({ method: "PUT", url, headers: { ...auth, "x-expected-updated-at": stale }, payload: { groupIds: [ghostGroup] } });
    expect(bad.json().error.code).toBe("version_changed");
    const inv = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth, "x-expected-updated-at": tpl.updatedAt },
      payload: { groupIds: [ghostGroup] },
    });
    expect(inv.statusCode).toBe(400);
    expect(inv.json().error.code).toBe("invalid_group");
    // Sin cambio de visibilidad devuelve la versión leída con FOR UPDATE (la misma).
    const ok = await app.inject({ method: "PUT", url, headers: { ...auth, "x-expected-updated-at": tpl.updatedAt }, payload: { groupIds: [] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().templateUpdatedAt).toBe(tpl.updatedAt);
  });
});

describe("OpenAPI de los guardados laterales", () => {
  it("putSealOptions y PATCH ai/settings declaran X-Expected-Updated-At, version_changed y envelopeUpdatedAt", async () => {
    const doc = (await app.inject({ method: "GET", url: "/v1/openapi.json" })).json();
    for (const op of [doc.paths["/v1/envelopes/{id}/seal-options"].put, doc.paths["/v1/envelopes/{id}/ai/settings"].patch]) {
      expect(JSON.stringify(op.parameters)).toContain("ExpectedUpdatedAt");
      expect(JSON.stringify(op.responses["409"])).toContain("version_changed");
    }
    expect(doc.components.schemas.SealOptions.properties.envelopeUpdatedAt).toBeTruthy();
    expect(doc.components.schemas.EnvelopeAiMetadata.properties.envelopeUpdatedAt).toBeTruthy();
  });
});

describe("enviar con X-Expected-Updated-At", () => {
  it("409 version_changed si el borrador cambió; sin encabezado no se controla", async () => {
    const e = await newEnvelope();
    const bad = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${e.id}/send`,
      headers: { ...auth, "x-expected-updated-at": stale, "idempotency-key": "k-stale" },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("version_changed");
    // La clave se liberó y el encabezado no entra en su hash: la misma clave con la versión actual no es idempotency_mismatch.
    const cur = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${e.id}/send`,
      headers: { ...auth, "x-expected-updated-at": e.updatedAt, "idempotency-key": "k-stale" },
    });
    expect(cur.json().error.code).toBe("envelope_incomplete");
    const free = await app.inject({ method: "POST", url: `/v1/envelopes/${e.id}/send`, headers: auth });
    expect(free.json().error.code).toBe("envelope_incomplete");
  });

  it("un sobre ya enviado responde not_draft aunque la versión no coincida (la consola va al detalle)", async () => {
    const e = await newEnvelope();
    await db.query(`UPDATE envelopes SET status = 'sent', updated_at = now() WHERE id = $1`, [e.id]);
    const r = await app.inject({ method: "POST", url: `/v1/envelopes/${e.id}/send`, headers: { ...auth, "x-expected-updated-at": e.updatedAt } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("not_draft");
  });
});

describe("límite de pedidos por IP", () => {
  it("429 con código rate_limited, mensaje en español y Retry-After", async () => {
    let last = null as Awaited<ReturnType<App["inject"]>> | null;
    for (let i = 0; i < 700; i++) {
      last = await app.inject({ method: "GET", url: "/healthz", remoteAddress: "203.0.113.9" });
      if (last.statusCode === 429) break;
    }
    expect(last!.statusCode).toBe(429);
    const body = last!.json();
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toMatch(/^Demasiados pedidos seguidos: esperá \d+ s y reintentá$/);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
  });
});
