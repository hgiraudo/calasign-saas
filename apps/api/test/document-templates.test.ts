// Plantillas de documentos y cláusulas sobre PGlite: control de versión (X-Expected-Updated-At), ciclos de cláusulas al
// guardar, cláusula en uso al borrar, firmas condicionales al generar (aviso en vez de 422), constancia de versión en la
// metadata del sobre, listado sin la fuente y roles de más de 80 caracteres.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-doctpl-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let cookie: string;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: "duena@doctpl.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Plantillas" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name === "cs_session")!;
  cookie = `cs_session=${c.value}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const H = (extra: Record<string, string> = {}) => ({ cookie, origin: "http://localhost:5173", ...extra });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function clause(slug: string, body: string) {
  const r = await app.inject({ method: "POST", url: "/v1/clauses", headers: H(), payload: { slug, title: `Cláusula ${slug}`, body } });
  return r;
}

async function template(name: string, source: string) {
  const r = await app.inject({ method: "POST", url: "/v1/document-templates", headers: H(), payload: { name, source } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}

describe("plantillas de documentos", () => {
  it("PATCH con X-Expected-Updated-At: 409 version_changed si cambió; updatedAt estrictamente creciente", async () => {
    const t = await template("Versionada", "# Hola\n\n{{firma:Cliente}}");
    const first = await app.inject({ method: "PATCH", url: `/v1/document-templates/${t.id}`, headers: H({ "x-expected-updated-at": t.updatedAt }), payload: { name: "V2" } });
    expect(first.statusCode, first.body).toBe(200);
    expect(Date.parse(first.json().updatedAt)).toBeGreaterThan(Date.parse(t.updatedAt));
    // La pestaña que cargó la versión anterior ya no pisa el cambio.
    const stale = await app.inject({ method: "PATCH", url: `/v1/document-templates/${t.id}`, headers: H({ "x-expected-updated-at": t.updatedAt }), payload: { name: "Pisada" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_changed");
    expect(stale.json().error.details.updatedAt).toBe(first.json().updatedAt);
    // Dos guardados seguidos dan updatedAt distintos (el siguiente guardado con el devuelto pasa).
    const second = await app.inject({ method: "PATCH", url: `/v1/document-templates/${t.id}`, headers: H({ "x-expected-updated-at": first.json().updatedAt }), payload: { name: "V3" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().updatedAt).not.toBe(first.json().updatedAt);
    // Sin el encabezado no se controla (integraciones).
    expect((await app.inject({ method: "PATCH", url: `/v1/document-templates/${t.id}`, headers: H(), payload: { name: "V4" } })).statusCode).toBe(200);
  });

  it("un rol de firma de más de 80 caracteres no se guarda", async () => {
    const long = `{{firma:${"R".repeat(81)}}}`;
    const r = await app.inject({ method: "POST", url: "/v1/document-templates", headers: H(), payload: { name: "Larga", source: long } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("template_syntax");
    const t = await template("Corta", "{{firma:Cliente}}");
    const p = await app.inject({ method: "PATCH", url: `/v1/document-templates/${t.id}`, headers: H(), payload: { source: long } });
    expect(p.statusCode).toBe(400);
  });

  it("el listado no trae la fuente; trae el análisis (también de las cláusulas) y se actualiza al cambiar una cláusula", async () => {
    expect((await clause("firma-testigo", "{{firma:Testigo}}")).statusCode).toBe(201);
    const t = await template("Con testigo", "# Acta\n\n{{firma:Cliente}}\n\n{{clausula:firma-testigo}}");
    const list = async () => (await app.inject({ method: "GET", url: "/v1/document-templates", headers: H() })).json().items.find((x: any) => x.id === t.id);
    const item = await list();
    expect(item).toBeTruthy();
    expect(item.source).toBeUndefined();
    expect(item.analysis.roles).toEqual(["Cliente", "Testigo"]);
    const cl = (await app.inject({ method: "GET", url: "/v1/clauses", headers: H() })).json().items.find((c: any) => c.slug === "firma-testigo");
    expect((await app.inject({ method: "PATCH", url: `/v1/clauses/${cl.id}`, headers: H(), payload: { body: "{{firma:Garante}}" } })).statusCode).toBe(200);
    expect((await list()).analysis.roles).toEqual(["Cliente", "Garante"]);
    // El detalle sí trae la fuente.
    expect((await app.inject({ method: "GET", url: `/v1/document-templates/${t.id}`, headers: H() })).json().source).toContain("{{clausula:firma-testigo}}");
  });
});

describe("cláusulas", () => {
  it("un ciclo se rechaza al guardar (a → a y a → b → a), también dentro de un {{#if}}", async () => {
    const self = await clause("auto", "Texto\n{{clausula:auto}}");
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe("template_syntax");
    expect(self.json().error.message).toMatch(/ciclo/);
    const a = await clause("ca", "A");
    expect(a.statusCode).toBe(201);
    expect((await clause("cb", "{{#if x}}\n{{clausula:ca}}\n{{/if}}")).statusCode).toBe(201);
    const cyc = await app.inject({ method: "PATCH", url: `/v1/clauses/${a.json().id}`, headers: H(), payload: { body: "A\n{{clausula:cb}}" } });
    expect(cyc.statusCode).toBe(400);
    expect(cyc.json().error.message).toContain("{{clausula:ca}} → {{clausula:cb}} → {{clausula:ca}}");
  });

  it("PATCH con X-Expected-Updated-At: 409 version_changed si cambió", async () => {
    const c = (await clause("versionada", "v1")).json();
    const ok = await app.inject({ method: "PATCH", url: `/v1/clauses/${c.id}`, headers: H({ "x-expected-updated-at": c.updatedAt }), payload: { body: "v2" } });
    expect(ok.statusCode).toBe(200);
    expect(Date.parse(ok.json().updatedAt)).toBeGreaterThan(Date.parse(c.updatedAt));
    const stale = await app.inject({ method: "PATCH", url: `/v1/clauses/${c.id}`, headers: H({ "x-expected-updated-at": c.updatedAt }), payload: { body: "v3" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_changed");
  });

  it("borrar una cláusula en uso: 409 clause_in_use con las plantillas y cláusulas que la citan; /usage lo informa", async () => {
    const base = (await clause("garantia", "Garantía de 12 meses.")).json();
    const t = await template("Venta con garantía", "# Venta\n\n{{#if conGarantia}}\n{{clausula:garantia}}\n{{/if}}\n\n{{firma:Cliente}}");
    const other = (await clause("postventa", "{{clausula:garantia}}")).json();
    // Una plantilla archivada o un texto parecido ("garantia-extendida") no cuentan.
    const archived = await template("Archivada", "{{clausula:garantia}}");
    await app.inject({ method: "DELETE", url: `/v1/document-templates/${archived.id}`, headers: H() });
    await template("Otra", "{{clausula:garantia-extendida}}");
    const usage = await app.inject({ method: "GET", url: `/v1/clauses/${base.id}/usage`, headers: H() });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toEqual({ templates: [{ id: t.id, name: "Venta con garantía" }], clauses: [{ id: other.id, slug: "postventa", title: "Cláusula postventa" }] });
    const del = await app.inject({ method: "DELETE", url: `/v1/clauses/${base.id}`, headers: H() });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("clause_in_use");
    expect(del.json().error.details.templates.map((x: any) => x.id)).toEqual([t.id]);
    expect(del.json().error.details.clauses.map((x: any) => x.slug)).toEqual(["postventa"]);
    // Sin usos se borra.
    const free = (await clause("libre", "Nada")).json();
    expect((await app.inject({ method: "DELETE", url: `/v1/clauses/${free.id}`, headers: H() })).statusCode).toBe(204);
  });
});

describe("cláusulas: grafo desde los ancestros, cambios sin texto y uso con errores de sintaxis", () => {
  const insertRaw = async (slug: string, body: string) => {
    const tenant = await db.one<any>(`SELECT tenant_id FROM clauses LIMIT 1`);
    const id = crypto.randomUUID();
    await db.query(`INSERT INTO clauses (id, tenant_id, slug, title, body) VALUES ($1,$2,$3,$4,$5)`, [id, tenant.tenant_id, slug, `Cláusula ${slug}`, body]);
    return id;
  };

  it("una cita nueva que pasa el tope de niveles desde una cláusula que cita a la editada: 400 clause_depth", async () => {
    // n1 → n2 → … → n8: 8 niveles (el máximo).
    expect((await clause("n8", "Fin")).statusCode).toBe(201);
    for (let i = 7; i >= 1; i--) expect((await clause(`n${i}`, `N${i}\n{{clausula:n${i + 1}}}`)).statusCode).toBe(201);
    const leaf = await clause("n9", "Hoja");
    expect(leaf.statusCode).toBe(201);
    const n8 = (await app.inject({ method: "GET", url: "/v1/clauses", headers: H() })).json().items.find((x: any) => x.slug === "n8");
    // Desde n8 son 2 niveles, pero desde n1 serían 9.
    const deep = await app.inject({ method: "PATCH", url: `/v1/clauses/${n8.id}`, headers: H(), payload: { body: "Fin\n{{#if x}}\n{{clausula:n9}}\n{{/if}}" } });
    expect(deep.statusCode, deep.body).toBe(400);
    expect(deep.json().error.message).toMatch(/niveles/);
    // Una cláusula nueva por encima de n1 sería el 9º nivel.
    expect((await clause("n0", "{{clausula:n1}}")).statusCode).toBe(400);
  });

  it("cambiar solo el título de una cláusula guardada con un ciclo (antes de validar) no exige arreglarlo", async () => {
    const id = await insertRaw("vieja-ciclo", "Vieja\n{{clausula:vieja-ciclo}}");
    const t = await app.inject({ method: "PATCH", url: `/v1/clauses/${id}`, headers: H(), payload: { title: "Renombrada" } });
    expect(t.statusCode, t.body).toBe(200);
    const b = await app.inject({ method: "PATCH", url: `/v1/clauses/${id}`, headers: H(), payload: { body: "Vieja\n{{clausula:vieja-ciclo}} " } });
    expect(b.statusCode).toBe(400);
    // Un ancestro roto de antes (otra rama) no bloquea editar una cláusula que cita.
    const hoja = (await clause("hoja-de-rota", "H")).json();
    await insertRaw("rota", "{{clausula:rota}}\n{{clausula:hoja-de-rota}}");
    const ok = await app.inject({ method: "PATCH", url: `/v1/clauses/${hoja.id}`, headers: H(), payload: { body: "H2" } });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("uso: una cláusula con un error de sintaxis en otra parte igual cuenta como uso si escribe {{clausula:slug}}", async () => {
    const base = (await clause("objetivo", "Objetivo")).json();
    await insertRaw("con-error", "{{#if x}}\n{{ clausula : objetivo }}");
    const usage = await app.inject({ method: "GET", url: `/v1/clauses/${base.id}/usage`, headers: H() });
    expect(usage.json().clauses.map((x: any) => x.slug)).toEqual(["con-error"]);
    expect((await app.inject({ method: "DELETE", url: `/v1/clauses/${base.id}`, headers: H() })).statusCode).toBe(409);
  });
});

describe("generar", () => {
  it("una firma condicional que no salió: el firmante se omite con aviso (no 422) y la metadata guarda la versión", async () => {
    const body = "Las partes guardan reserva.";
    expect((await clause("reserva", body)).statusCode).toBe(201);
    const source = "# Alquiler\n\n{{clausula:reserva}}\n\n{{firma:Inquilino}}\n\n{{#if garante}}\n{{firma:Garante}}\n{{/if}}";
    const t = await template("Alquiler", source);
    const recipients = [
      { role: "Inquilino", name: "Ana", email: "ana@x.test" },
      { role: "Garante", name: "Gus", phone: "+5491112345678" },
    ];
    const r = await app.inject({ method: "POST", url: `/v1/document-templates/${t.id}/generate`, headers: H(), payload: { data: {}, recipients, send: false } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().warnings).toEqual([expect.objectContaining({ code: "signer_without_marks", roles: ["Garante"] })]);
    const envId = r.json().envelopeId;
    const recs = await db.query<any>(`SELECT name FROM recipients WHERE envelope_id = $1`, [envId]);
    expect(recs.map((x) => x.name)).toEqual(["Ana"]);
    const env = await db.one<any>(`SELECT metadata FROM envelopes WHERE id = $1`, [envId]);
    expect(env.metadata.documentProvenance).toEqual({ sourceSha256: sha(source), clauses: { reserva: sha(body) } });
    // Con garante, entran los dos y sin avisos.
    const both = await app.inject({ method: "POST", url: `/v1/document-templates/${t.id}/generate`, headers: H(), payload: { data: { garante: "Gus" }, recipients, send: false } });
    expect(both.statusCode, both.body).toBe(201);
    expect(both.json().warnings).toEqual([]);
    // Faltar el firmante de una marca que sí salió sigue siendo 422 missing_roles; ninguno con marcas, 422 unknown_roles.
    const missing = await app.inject({ method: "POST", url: `/v1/document-templates/${t.id}/generate`, headers: H(), payload: { data: { garante: "Gus" }, recipients: [recipients[0]], send: false } });
    expect(missing.json().error.code).toBe("missing_roles");
    const none = await app.inject({
      method: "POST",
      url: `/v1/document-templates/${t.id}/generate`,
      headers: H(),
      payload: { data: {}, recipients: [{ role: "Otro", name: "X", email: "x@x.test" }, { role: "inquilino", name: "Ana", email: "ana@x.test" }], send: false },
    });
    // "inquilino" es el mismo rol que "Inquilino" (sin distinguir mayúsculas); "Otro" no figura en la plantilla: 422 (un
    // rol desconocido suele ser un error de tipeo; solo se omiten los roles que la plantilla declara en otra rama).
    expect(none.statusCode, none.body).toBe(422);
    expect(none.json().error.code).toBe("unknown_roles");
    expect(none.json().error.details.roles).toEqual(["Otro"]);
    const allUnknown = await app.inject({ method: "POST", url: `/v1/document-templates/${t.id}/generate`, headers: H(), payload: { data: {}, recipients: [{ role: "Otro", name: "X", email: "x@x.test" }], send: false } });
    expect(allUnknown.statusCode).toBe(422);
  });

  it("documentProvenance es una clave reservada: el cliente no la puede escribir", async () => {
    const t = await template("Simple", "{{firma:Cliente}}");
    const r = await app.inject({
      method: "POST",
      url: `/v1/document-templates/${t.id}/generate`,
      headers: H(),
      payload: { data: {}, recipients: [{ role: "Cliente", name: "Ana", email: "ana@x.test" }], send: false, metadata: { documentProvenance: "falsa", ref: "A-1" } },
    });
    expect(r.statusCode, r.body).toBe(201);
    const env = await db.one<any>(`SELECT metadata FROM envelopes WHERE id = $1`, [r.json().envelopeId]);
    expect(env.metadata.ref).toBe("A-1");
    expect(env.metadata.documentProvenance.sourceSha256).toBe(sha("{{firma:Cliente}}"));
  });
});

describe("OpenAPI", () => {
  it("PATCH de plantillas y cláusulas declara X-Expected-Updated-At; borrar una cláusula documenta clause_in_use", async () => {
    const { buildOpenApi } = await import("../src/modules/openapi");
    const doc = buildOpenApi() as any;
    for (const p of ["/v1/document-templates/{id}", "/v1/clauses/{id}"]) {
      const op = doc.paths[p].patch;
      expect(JSON.stringify(op.parameters), p).toContain("ExpectedUpdatedAt");
      expect(JSON.stringify(op.responses["409"]), p).toContain("version_changed");
    }
    expect(JSON.stringify(doc.paths["/v1/clauses/{id}"].delete.responses["409"])).toContain("clause_in_use");
    expect(doc.paths["/v1/clauses/{id}/usage"].get).toBeTruthy();
  });
});
