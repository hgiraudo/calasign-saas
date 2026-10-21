// Plataforma de acuerdos sobre PGlite: enmascarado de URL y cuerpo de los pasos HTTP, setPath en listas, teléfonos y
// canales de los envíos de workflows, idioma de los formularios, PATCH de negociaciones (fusión y expectedVersion),
// idempotencia al iniciar ejecuciones, CalaSign-Idempotency-Key y respuestas guardadas ({{http.x}}), control de edición
// concurrente de acuerdos y workflows, vista redactada y listado resumido de ejecuciones, borrador de una negociación
// aceptada, borrado de workflows con sobres en firma y retención de datos.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-agr-fix-"));
delete process.env.DATABASE_URL;

/** Llamadas de los pasos HTTP (sin red): cada una responde lo que diga `httpReply`. */
const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
let httpReply: (url: string) => unknown = () => ({ ok: true });
vi.mock("../src/modules/webhooks", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/modules/webhooks")>();
  return {
    ...orig,
    assertPublicDestination: async () => {},
    safeRequest: async (url: string, opts: { headers?: Record<string, string>; body?: string } = {}) => {
      calls.push({ url, headers: opts.headers ?? {}, body: String(opts.body ?? "") });
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(httpReply(url))) };
    },
  };
});

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
let userId: string;
let cookie: string;
let util: typeof import("../src/lib/util");

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
    payload: { email: "duena@fix.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Fixes" },
  });
  expect(res.statusCode).toBe(201);
  cookie = `cs_session=${res.cookies.find((x) => x.name === "cs_session")!.value}`;
  userId = res.json().user.id;
  tenant = res.json().tenant.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const H = (c = cookie) => ({ cookie: c, origin: "http://localhost:5173" });
const silent = { info() {}, warn() {}, error() {} };

async function newMember(email: string, role: string, roleId: string | null = null) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'scrypt$x')`, [id, email, email.split("@")[0]]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role, role_id) VALUES ($1,$2,$3,$4)`, [tenant, id, role, roleId]);
  const token = util.randomToken();
  await db.query(`INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1,$2,$3, now() + interval '14 days', 'password')`, [
    util.sha256Hex(token),
    id,
    tenant,
  ]);
  return { id, cookie: `cs_session=${token}` };
}

async function createWorkflow(body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/workflows", headers: H(), payload: body });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function startRun(workflowId: string, data: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: `/v1/workflows/${workflowId}/runs`, headers: { ...H(), ...headers }, payload: { data } });
}

let signTemplateId: string | null = null;
async function signTemplate() {
  if (signTemplateId) return signTemplateId;
  const tpl = await app.inject({ method: "POST", url: "/v1/document-templates", headers: H(), payload: { name: "Firma", source: "# Hola {{nombre}}\n\n{{firma:Cliente}}" } });
  expect(tpl.statusCode).toBe(201);
  signTemplateId = tpl.json().id as string;
  return signTemplateId;
}

describe("utilidades de datos", () => {
  it("setPath entra a las listas existentes (partes.0.nombre) y solo crea objetos donde no hay nada", async () => {
    const { setPath } = await import("../src/modules/agreements/common");
    const data: Record<string, unknown> = { partes: [{ nombre: "Ana", dni: "1" }, { nombre: "Beto" }], x: "texto" };
    setPath(data, "partes.0.nombre", "Ana María");
    expect(Array.isArray(data.partes)).toBe(true);
    expect(data.partes).toEqual([{ nombre: "Ana María", dni: "1" }, { nombre: "Beto" }]);
    setPath(data, "partes.1", { nombre: "Carla" });
    expect(data.partes).toEqual([{ nombre: "Ana María", dni: "1" }, { nombre: "Carla" }]);
    setPath(data, "x.y", 1); // valor simple: se reemplaza por un objeto
    expect(data.x).toEqual({ y: 1 });
    setPath(data, "nuevo.a.b", true);
    expect(data.nuevo).toEqual({ a: { b: true } });
    expect(() => setPath(data, "partes.nombre", "z")).toThrow();
    expect(() => setPath(data, "a.__proto__.b", 1)).toThrow();
    // Error de la API (400 invalid_path), no un Error suelto que terminaba en 500.
    for (const bad of ["partes.nombre", "a.__proto__.b"]) {
      try {
        setPath(data, bad, 1);
        expect.unreachable();
      } catch (e) {
        expect(e).toMatchObject({ status: 400, code: "invalid_path" });
      }
    }
  });

  it("mergeDataPatch: fusión profunda, null borra, listas reemplazan", async () => {
    const { mergeDataPatch } = await import("../src/modules/agreements/common");
    const base = { cliente: { nombre: "ACME", cuit: "1" }, items: [1, 2], precio: "100" };
    expect(mergeDataPatch(base, { cliente: { cuit: null, email: "a@b.c" }, items: [3], precio: null })).toEqual({ cliente: { nombre: "ACME", email: "a@b.c" }, items: [3] });
    expect(base.cliente.cuit).toBe("1"); // no modifica el original
  });
});

describe("workflows: pasos HTTP", () => {
  const httpStep = () => ({
    id: randomUUID(),
    type: "http_request",
    name: "Avisar",
    config: { url: "https://hooks.example.test/services/T0/SECRETO?token=abc", method: "POST", headers: { Authorization: "Bearer clave" }, bodyTemplate: '{"token":"s3cret","n":{{nombre}}}' },
  });

  it("sin templates:manage se enmascaran URL (ruta y consulta) y cuerpo; quien administra los ve y guardar lo enmascarado conserva lo guardado", async () => {
    const wf = await createWorkflow({ name: `HTTP ${randomUUID().slice(0, 6)}`, active: false, steps: [httpStep()] });
    const member = await newMember(`miembro-${randomUUID().slice(0, 6)}@fix.test`, "member");
    const seen = await app.inject({ method: "GET", url: `/v1/workflows/${wf.id}`, headers: H(member.cookie) });
    expect(seen.statusCode).toBe(200);
    const cfg = seen.json().steps[0].config;
    expect(cfg.url).toBe("https://hooks.example.test/••••••");
    expect(cfg.bodyTemplate).toBe("••••••");
    expect(cfg.headers.Authorization).toBe("••••••");
    expect(JSON.stringify(seen.json())).not.toContain("SECRETO");
    const list = await app.inject({ method: "GET", url: "/v1/workflows", headers: H(member.cookie) });
    expect(JSON.stringify(list.json())).not.toMatch(/SECRETO|s3cret|token=abc/);

    // Quien administra: completo en el detalle; en el listado, solo los encabezados enmascarados.
    const full = await app.inject({ method: "GET", url: `/v1/workflows/${wf.id}`, headers: H() });
    expect(full.json().steps[0].config.url).toContain("SECRETO");
    const ownerList = (await app.inject({ method: "GET", url: "/v1/workflows", headers: H() })).json().items.find((x: { id: string }) => x.id === wf.id);
    expect(ownerList.steps[0].config.url).toContain("SECRETO");
    expect(ownerList.steps[0].config.headers.Authorization).toBe("••••••");

    // Guardar pasos enmascarados (los que vio alguien sin el permiso) no pisa la URL, el cuerpo ni el encabezado.
    const patched = await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { name: "Renombrado", steps: seen.json().steps } });
    expect(patched.statusCode).toBe(200);
    const saved = (await db.one<any>(`SELECT steps FROM workflows WHERE id = $1`, [wf.id])).steps[0].config;
    expect(saved.url).toBe("https://hooks.example.test/services/T0/SECRETO?token=abc");
    expect(saved.bodyTemplate).toBe('{"token":"s3cret","n":{{nombre}}}');
    expect(saved.headers.Authorization).toBe("Bearer clave");
    // Un cambio real sí se guarda.
    const changed = { ...seen.json().steps[0], config: { ...seen.json().steps[0].config, url: "https://otro.example.test/x", bodyTemplate: "{}" } };
    const latest = (await app.inject({ method: "GET", url: `/v1/workflows/${wf.id}`, headers: H() })).json();
    expect((await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: { ...H(), "x-expected-updated-at": latest.updatedAt }, payload: { steps: [changed] } })).statusCode).toBe(200);
    const saved2 = (await db.one<any>(`SELECT steps FROM workflows WHERE id = $1`, [wf.id])).steps[0].config;
    expect(saved2.url).toBe("https://otro.example.test/x");
    expect(saved2.bodyTemplate).toBe("{}");
  });

  it("CalaSign-Idempotency-Key por paso y respuestas guardadas disponibles como {{http.x}}", async () => {
    calls.length = 0;
    httpReply = (url) => (url.includes("/crm") ? { id: "C-9", cliente: { nivel: "oro" } } : { ok: true });
    const wf = await createWorkflow({
      name: `Encadenado ${randomUUID().slice(0, 6)}`,
      steps: [
        { id: randomUUID(), type: "http_request", name: "CRM", config: { url: "https://api.example.test/crm", saveAs: "crm" } },
        {
          id: randomUUID(),
          type: "http_request",
          name: "ERP",
          config: { url: "https://api.example.test/erp", headers: { "X-Ref": "{{http.crm.id}}" }, bodyTemplate: '{"crmId": {{http.crm.id}}, "nivel": {{http.crm.cliente.nivel}}, "n": {{nombre}}}' },
        },
      ],
    });
    const run = await startRun(wf.id, { nombre: "Ana" });
    expect(run.statusCode).toBe(201);
    expect(run.json().status).toBe("completed");
    const runId = run.json().id as string;
    expect(calls).toHaveLength(2);
    expect(calls[0].headers["CalaSign-Idempotency-Key"]).toBe(`${runId}:0`);
    expect(calls[1].headers["CalaSign-Idempotency-Key"]).toBe(`${runId}:1`);
    expect(calls[1].headers["X-Ref"]).toBe("C-9");
    expect(JSON.parse(calls[1].body)).toEqual({ crmId: "C-9", nivel: "oro", n: "Ana" });
    // Sin bodyTemplate, el cuerpo por defecto lleva los datos y las respuestas guardadas por separado.
    const def = JSON.parse(calls[0].body);
    expect(def.data).toEqual({ nombre: "Ana" });
    expect(def.http).toEqual({});
  });

  it("POST /v1/workflows/:id/runs con Idempotency-Key: el reintento devuelve la misma ejecución", async () => {
    const wf = await createWorkflow({ name: `Idem ${randomUUID().slice(0, 6)}`, steps: [{ id: randomUUID(), type: "approval", name: "OK", config: { approverUserId: userId } }] });
    const key = { "idempotency-key": `run-${randomUUID()}` };
    const a = await startRun(wf.id, { pedido: 1 }, key);
    const b = await startRun(wf.id, { pedido: 1 }, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM workflow_runs WHERE workflow_id = $1`, [wf.id])).n).toBe(1);
    // Otro cuerpo con la misma clave: 409.
    expect((await startRun(wf.id, { pedido: 2 }, key)).statusCode).toBe(409);
  });

  it("Idempotency-Key con link público: la respuesta guardada no lleva el token y el reintento devuelve el collectUrl", async () => {
    const wf = await createWorkflow({
      name: `Idem link ${randomUUID().slice(0, 6)}`,
      steps: [{ id: randomUUID(), type: "collect_data", name: "Datos", config: { title: "Datos", fields: [{ key: "dni", label: "DNI", type: "text" }] } }],
    });
    const key = `run-${randomUUID()}`;
    const a = await startRun(wf.id, {}, { "idempotency-key": key });
    expect(a.statusCode).toBe(201);
    const url = a.json().collectUrl as string;
    expect(url).toMatch(/\/w\//);
    const token = url.split("/w/")[1];
    const stored = await db.one<any>(`SELECT response FROM idempotency_keys WHERE key LIKE $1`, [`%|${key}`]);
    expect(JSON.stringify(stored.response)).not.toContain(token);
    const b = await startRun(wf.id, {}, { "idempotency-key": key });
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(b.json().id).toBe(a.json().id);
    expect(b.json().collectUrl).toBe(url);
  });
});

describe("workflows: envíos, formularios y vistas", () => {
  it("teléfono que no es E.164 o ningún canal con dirección: el paso falla con un mensaje claro", async () => {
    const tplId = await signTemplate();
    const mk = async (recipient: Record<string, unknown>) => {
      const wf = await createWorkflow({
        name: `Envío ${randomUUID().slice(0, 6)}`,
        steps: [
          { id: randomUUID(), type: "generate_document", name: "Generar", config: { documentTemplateId: tplId, output: "doc" } },
          { id: randomUUID(), type: "send_for_signature", name: "Enviar", config: { document: "doc", envelopeKey: "e", subject: "Firma", recipients: [{ role: "Cliente", name: "{{nombre}}", ...recipient }] } },
        ],
      });
      const run = await startRun(wf.id, { nombre: "Ana", tel: "123" });
      expect(run.json().status).toBe("failed");
      return run.json().steps[1].error as string;
    };
    expect(await mk({ phone: "{{tel}}", channels: ["whatsapp"] })).toContain("Teléfono inválido");
    expect(await mk({ email: "ana@x.test", channels: ["whatsapp"] })).toContain("ningún canal");

    // Teléfono mal cargado que no se usa (solo correo): no hace fallar el paso; el teléfono se descarta.
    const wf = await createWorkflow({
      name: `Envío correo ${randomUUID().slice(0, 6)}`,
      steps: [
        { id: randomUUID(), type: "generate_document", name: "Generar", config: { documentTemplateId: tplId, output: "doc" } },
        {
          id: randomUUID(),
          type: "send_for_signature",
          name: "Enviar",
          config: { document: "doc", envelopeKey: "e", subject: "Firma", recipients: [{ role: "Cliente", name: "{{nombre}}", email: "ana@x.test", phone: "{{tel}}", channels: ["email"] }] },
        },
      ],
    });
    const run = await startRun(wf.id, { nombre: "Ana", tel: "123" });
    expect(run.json().steps[1].status).not.toBe("failed");
    const envId = run.json().context.envelopes.e?.envelopeId as string;
    expect(envId).toBeTruthy();
    const rcp = await db.one<any>(`SELECT email, phone FROM recipients WHERE envelope_id = $1`, [envId]);
    expect(rcp).toEqual({ email: "ana@x.test", phone: null });
  }, 60_000);

  it("los números y fechas del formulario se leen en el idioma de la organización", async () => {
    const wf = await createWorkflow({
      name: `Idioma ${randomUUID().slice(0, 6)}`,
      steps: [
        {
          id: randomUUID(),
          type: "collect_data",
          name: "Datos",
          config: { title: "Datos", fields: [{ key: "monto", label: "Amount", type: "number" }, { key: "inicio", label: "Start", type: "date" }] },
        },
      ],
    });
    await db.query(`UPDATE tenants SET default_locale = 'en' WHERE id = $1`, [tenant]);
    try {
      const run = await startRun(wf.id);
      const token = (run.json().collectUrl as string).split("/w/")[1];
      const sub = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${token}/steps/0`, payload: { values: { monto: "2,500", inicio: "03/01/2027" } } });
      expect(sub.statusCode).toBe(200);
      const ctx = (await db.one<any>(`SELECT context FROM workflow_runs WHERE id = $1`, [run.json().id])).context;
      expect(ctx.data).toEqual({ monto: 2500, inicio: "2027-03-01" });
    } finally {
      await db.query(`UPDATE tenants SET default_locale = 'es' WHERE id = $1`, [tenant]);
    }
  });

  it("vista redactada: errores de todos los pasos sin detalle; inicio público sin IP en la etiqueta (IP solo con audit:view); listado resumido", async () => {
    const tplId = await signTemplate();
    const wf = await createWorkflow({
      name: `Redactado ${randomUUID().slice(0, 6)}`,
      steps: [
        { id: randomUUID(), type: "generate_document", name: "Generar", config: { documentTemplateId: tplId, output: "doc" } },
        { id: randomUUID(), type: "send_for_signature", name: "Enviar", config: { document: "doc", envelopeKey: "e", subject: "Firma", recipients: [{ role: "Cliente", name: "X", email: "{{correo}}" }] } },
      ],
    });
    const run = await startRun(wf.id, { nombre: "Ana", correo: "no-es-correo-ana" });
    expect(run.json().steps[1].error).toContain("no-es-correo-ana");
    const role = await app.inject({ method: "POST", url: "/v1/roles", headers: H(), payload: { name: `Plantillas ${randomUUID().slice(0, 4)}`, permissions: ["envelopes:create", "templates:manage"] } });
    const tplAdmin = await newMember(`tpl-${randomUUID().slice(0, 6)}@fix.test`, "custom", role.json().id);
    const red = await app.inject({ method: "GET", url: `/v1/workflow-runs/${run.json().id}`, headers: H(tplAdmin.cookie) });
    expect(red.json().redacted).toBe(true);
    expect(red.json().steps[1].error).toBe("El paso falló");
    expect(JSON.stringify(red.json())).not.toContain("no-es-correo-ana");

    // Listado: resúmenes con el nombre del workflow, sin contexto ni pasos.
    const list = await app.inject({ method: "GET", url: `/v1/workflow-runs?workflowId=${wf.id}`, headers: H() });
    expect(list.statusCode).toBe(200);
    const item = list.json().items[0];
    expect(item).toMatchObject({ id: run.json().id, workflowName: wf.name, status: "failed", stepCount: 2, currentStep: 1, currentStepName: "Enviar", canManage: true });
    expect(item.context).toBeUndefined();
    expect(item.steps).toBeUndefined();

    // Inicio por el link público.
    const pub = await createWorkflow({
      name: `Público ${randomUUID().slice(0, 6)}`,
      publicStart: true,
      steps: [{ id: randomUUID(), type: "collect_data", name: "Datos", config: { title: "Datos", fields: [{ key: "nombre", label: "Nombre", type: "text" }] } }],
    });
    const slug = (pub.publicUrl as string).split("/wf/")[1];
    const started = await app.inject({ method: "POST", url: `/v1/public/workflows/${slug}/start`, payload: {}, remoteAddress: "203.0.113.77" });
    expect(started.statusCode).toBe(201);
    const owner = await app.inject({ method: "GET", url: `/v1/workflow-runs/${started.json().runId}`, headers: H() });
    expect(owner.json().startedBy).toBe("Link público");
    expect(owner.json().startedByIp).toBe("203.0.113.77");
    const other = await app.inject({ method: "GET", url: `/v1/workflow-runs/${started.json().runId}`, headers: H(tplAdmin.cookie) });
    expect(other.json().startedBy).toBe("Link público");
    expect(other.json().startedByIp).toBeUndefined();
  }, 60_000);

  it("borrar un workflow con una ejecución fallida que dejó sobres en firma: 409 hasta cancelarla", async () => {
    const wf = await createWorkflow({ name: `Borrar ${randomUUID().slice(0, 6)}`, steps: [{ id: randomUUID(), type: "approval", name: "OK", config: { approverUserId: userId } }] });
    const run = await startRun(wf.id);
    const runId = run.json().id as string;
    await db.query(`UPDATE workflow_runs SET status = 'failed' WHERE id = $1`, [runId]);
    const envId = util.uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, created_by, subject, status, metadata) VALUES ($1,$2,$3,'Del run','sent',$4)`, [
      envId,
      tenant,
      userId,
      JSON.stringify({ workflowRunId: runId }),
    ]);
    const del = await app.inject({ method: "DELETE", url: `/v1/workflows/${wf.id}`, headers: H() });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("runs_with_open_envelopes");
    const cancel = await app.inject({ method: "POST", url: `/v1/workflow-runs/${runId}/cancel`, headers: H() });
    expect(cancel.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [envId])).status).toBe("voided");
    expect((await app.inject({ method: "DELETE", url: `/v1/workflows/${wf.id}`, headers: H() })).statusCode).toBe(204);
  });

  it("PATCH de un workflow con X-Expected-Updated-At: 409 version_changed si cambió", async () => {
    const wf = await createWorkflow({ name: `Edición ${randomUUID().slice(0, 6)}`, steps: [{ id: randomUUID(), type: "approval", name: "OK", config: { approverUserId: userId } }] });
    const ok = await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: { ...H(), "x-expected-updated-at": wf.updatedAt }, payload: { name: "Pestaña 1" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().updatedAt).not.toBe(wf.updatedAt);
    const stale = await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: { ...H(), "x-expected-updated-at": wf.updatedAt }, payload: { name: "Pestaña 2" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_changed");
    expect((await db.one<any>(`SELECT name FROM workflows WHERE id = $1`, [wf.id])).name).toBe("Pestaña 1");
    // Sin el encabezado, como antes (integraciones).
    expect((await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { name: "API" } })).statusCode).toBe(200);
  });
});

describe("repositorio y negociaciones", () => {
  it("PATCH de un acuerdo con X-Expected-Updated-At: 409 si cambió desde que se leyó", async () => {
    const file = util.uuidv7();
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original','k2','application/pdf',1,'h')`, [file, tenant]);
    const ag = util.uuidv7();
    await db.query(`INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title, status, owner_user_id) VALUES ($1,$2,'external',$3,'a.pdf','Acuerdo','active',$4)`, [
      ag,
      tenant,
      file,
      userId,
    ]);
    const cur = (await app.inject({ method: "GET", url: `/v1/agreements/${ag}`, headers: H() })).json();
    const ok = await app.inject({ method: "PATCH", url: `/v1/agreements/${ag}`, headers: { ...H(), "x-expected-updated-at": cur.updatedAt }, payload: { title: "Uno" } });
    expect(ok.statusCode).toBe(200);
    const stale = await app.inject({ method: "PATCH", url: `/v1/agreements/${ag}`, headers: { ...H(), "x-expected-updated-at": cur.updatedAt }, payload: { currency: "USD" } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_changed");
    const after = await db.one<any>(`SELECT title, currency FROM agreements WHERE id = $1`, [ag]);
    expect(after).toEqual({ title: "Uno", currency: null });
    // Solo el campo enviado cambia (el título no vuelve al valor viejo).
    expect((await app.inject({ method: "PATCH", url: `/v1/agreements/${ag}`, headers: { ...H(), "x-expected-updated-at": ok.json().updatedAt }, payload: { currency: "USD" } })).statusCode).toBe(200);
    expect(await db.one<any>(`SELECT title, currency FROM agreements WHERE id = $1`, [ag])).toEqual({ title: "Uno", currency: "USD" });
  });

  let templateId: string;
  beforeAll(async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/document-templates",
      headers: H(),
      payload: { name: "Servicios", source: "# Contrato con {{cliente}}\n\nPrecio: {{precio}}\n\n{{firma:Cliente}}\n\n{{firma:Proveedor}}" },
    });
    expect(res.statusCode).toBe(201);
    templateId = res.json().id;
  });
  const createNegotiation = async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/negotiations",
      headers: H(),
      payload: { title: "Servicios", documentTemplateId: templateId, data: { cliente: "ACME", precio: "100", extra: { a: 1, b: 2 } }, participants: [{ name: "Cli", email: "cli@x.test", role: "Cliente" }] },
    });
    expect(res.statusCode).toBe(201);
    return res.json().negotiation.id as string;
  };

  it("PATCH de una negociación: data se fusiona (null borra) y expectedVersion vieja da 409", async () => {
    const id = await createNegotiation();
    const p1 = await app.inject({ method: "PATCH", url: `/v1/negotiations/${id}`, headers: H(), payload: { data: { precio: "200", extra: { a: null } }, expectedVersion: 1 } });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().negotiation.currentVersion).toBe(2);
    expect((await db.one<any>(`SELECT data FROM negotiations WHERE id = $1`, [id])).data).toEqual({ cliente: "ACME", precio: "200", extra: { b: 2 } });
    const stale = await app.inject({ method: "PATCH", url: `/v1/negotiations/${id}`, headers: H(), payload: { data: { precio: "300" }, expectedVersion: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_changed");
    // Sin expectedVersion (compatibilidad): también fusiona.
    expect((await app.inject({ method: "PATCH", url: `/v1/negotiations/${id}`, headers: H(), payload: { data: { precio: "300" } } })).statusCode).toBe(200);
    expect((await db.one<any>(`SELECT data FROM negotiations WHERE id = $1`, [id])).data).toEqual({ cliente: "ACME", precio: "300", extra: { b: 2 } });
  });

  it("borrar el borrador de una negociación aceptada la reabre (sin sobre) y se puede volver a aceptar", async () => {
    const id = await createNegotiation();
    const acc = await app.inject({ method: "POST", url: `/v1/negotiations/${id}/accept`, headers: H(), payload: { send: false } });
    expect(acc.statusCode).toBe(200);
    const envId = acc.json().envelope.id as string;
    expect(acc.json().envelope.status).toBe("draft");
    const del = await app.inject({ method: "DELETE", url: `/v1/envelopes/${envId}`, headers: H() });
    expect(del.statusCode).toBe(204);
    expect(await db.one<any>(`SELECT status, envelope_id FROM negotiations WHERE id = $1`, [id])).toEqual({ status: "open", envelope_id: null });
    const again = await app.inject({ method: "POST", url: `/v1/negotiations/${id}/accept`, headers: H(), payload: { send: false } });
    expect(again.statusCode).toBe(200);
    expect(again.json().envelope.id).not.toBe(envId);
  }, 60_000);
});

describe("retención de datos", () => {
  it("purga los datos de ejecuciones terminadas y negociaciones cerradas vencidas; las recientes no", async () => {
    const { purgeWorkflowRunData, purgeNegotiationData } = await import("../src/modules/agreements/retention");
    const { createBlobStore } = await import("../src/infra/storage");
    const deps = { db, blobs: createBlobStore(), log: silent };
    calls.length = 0;
    httpReply = () => ({ secreto: "respuesta" });
    const wf = await createWorkflow({
      name: `Retención ${randomUUID().slice(0, 6)}`,
      steps: [{ id: randomUUID(), type: "http_request", name: "Avisar", config: { url: "https://api.example.test/r", saveAs: "r" } }],
    });
    const old = (await startRun(wf.id, { dni: "12345678" })).json();
    const recent = (await startRun(wf.id, { dni: "87654321" })).json();
    expect(old.status).toBe("completed");
    await db.query(`UPDATE workflow_runs SET updated_at = now() - interval '400 days', context = context || '{"collectEmailSources": {"x": {"ip": "1.2.3.4"}}}'::jsonb WHERE id = $1`, [old.id]);

    const negOld = await (async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/negotiations",
        headers: H(),
        payload: { title: "Vieja", documentTemplateId: templateIdForRetention(), data: { cliente: "Persona Real" }, participants: [{ name: "Cli", email: "cli@x.test", role: "Cliente" }] },
      });
      return res;
    })();
    expect(negOld.statusCode).toBe(201);
    const nid = negOld.json().negotiation.id as string;
    await app.inject({ method: "POST", url: `/v1/negotiations/${nid}/comments`, headers: H(), payload: { body: "Comentario con datos" } });
    expect((await app.inject({ method: "POST", url: `/v1/negotiations/${nid}/cancel`, headers: H() })).statusCode).toBe(200);
    await db.query(`UPDATE negotiations SET updated_at = now() - interval '400 days' WHERE id = $1`, [nid]);

    // Sin AGREEMENTS_DATA_RETENTION_DAYS ni retención de la organización no hay plazo: no se borra nada.
    const prevEnv = process.env.AGREEMENTS_DATA_RETENTION_DAYS;
    delete process.env.AGREEMENTS_DATA_RETENTION_DAYS;
    try {
      expect(await purgeWorkflowRunData(deps)).toBe(0);
      expect(await purgeNegotiationData(deps)).toBe(0);
    } finally {
      if (prevEnv !== undefined) process.env.AGREEMENTS_DATA_RETENTION_DAYS = prevEnv;
    }

    expect(await purgeWorkflowRunData(deps, { defaultDays: 365 })).toBeGreaterThanOrEqual(1);
    const o = await db.one<any>(`SELECT context, data_purged_at FROM workflow_runs WHERE id = $1`, [old.id]);
    expect(o.data_purged_at).toBeTruthy();
    expect(o.context.data).toEqual({});
    expect(o.context.http).toEqual({});
    expect(o.context.collectEmailSources).toBeUndefined();
    const step = await db.one<any>(`SELECT output FROM workflow_run_steps WHERE run_id = $1 AND idx = 0`, [old.id]);
    expect(JSON.stringify(step.output)).not.toContain("secreto");
    const r = await db.one<any>(`SELECT context, data_purged_at FROM workflow_runs WHERE id = $1`, [recent.id]);
    expect(r.data_purged_at).toBeNull();
    expect(r.context.data).toEqual({ dni: "87654321" });
    const view = await app.inject({ method: "GET", url: `/v1/workflow-runs/${old.id}`, headers: H() });
    expect(view.json().dataPurgedAt).toBeTruthy();
    // Un run purgado no se reintenta: código propio (no el del envío masivo cancelado).
    await db.query(`UPDATE workflow_runs SET status = 'failed', current_step = 0 WHERE id = $1`, [old.id]);
    await db.query(`UPDATE workflow_run_steps SET status = 'failed' WHERE run_id = $1 AND idx = 0`, [old.id]);
    const retry = await app.inject({ method: "POST", url: `/v1/workflow-runs/${old.id}/retry`, headers: H() });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().error.code).toBe("run_purged");

    // La retención de la organización manda sobre la de la plataforma.
    await db.query(`UPDATE tenants SET retention_days = 3000 WHERE id = $1`, [tenant]);
    await db.query(`UPDATE workflow_runs SET updated_at = now() - interval '400 days' WHERE id = $1`, [recent.id]);
    try {
      await purgeWorkflowRunData(deps, { defaultDays: 365 });
      expect((await db.one<any>(`SELECT data_purged_at FROM workflow_runs WHERE id = $1`, [recent.id])).data_purged_at).toBeNull();
    } finally {
      await db.query(`UPDATE tenants SET retention_days = NULL WHERE id = $1`, [tenant]);
    }

    const tokenRow = await db.one<any>(`SELECT token_enc FROM negotiation_participants WHERE negotiation_id = $1`, [nid]);
    const { decrypt } = await import("../src/lib/util");
    expect(await purgeNegotiationData(deps, { defaultDays: 365 })).toBeGreaterThanOrEqual(1);
    const n = await db.one<any>(`SELECT data, data_purged_at FROM negotiations WHERE id = $1`, [nid]);
    expect(n.data).toEqual({});
    expect(n.data_purged_at).toBeTruthy();
    const v = await db.query<any>(`SELECT text_snapshot FROM negotiation_versions WHERE negotiation_id = $1`, [nid]);
    expect(v.every((x) => x.text_snapshot === "")).toBe(true);
    expect((await db.one<any>(`SELECT body FROM negotiation_comments WHERE negotiation_id = $1`, [nid])).body).toBe("");
    const pub = await app.inject({ method: "GET", url: `/v1/public/negotiations/${decrypt(tokenRow.token_enc)}` });
    expect(pub.statusCode).toBe(410);
    // Remitente: la vista dice que se purgó; el PDF y las diferencias, 410 purged (saldrían vacíos).
    const own = await app.inject({ method: "GET", url: `/v1/negotiations/${nid}`, headers: H() });
    expect(own.statusCode).toBe(200);
    expect(own.json().dataPurgedAt).toBeTruthy();
    for (const path of ["pdf", "diff?from=1&to=1"]) {
      const r = await app.inject({ method: "GET", url: `/v1/negotiations/${nid}/${path}`, headers: H() });
      expect(r.statusCode).toBe(410);
      expect(r.json().error.code).toBe("purged");
    }
  }, 60_000);
});

// La plantilla de negociaciones del describe anterior (creada en su beforeAll).
let retentionTemplate: string | null = null;
function templateIdForRetention(): string {
  if (!retentionTemplate) throw new Error("sin plantilla");
  return retentionTemplate;
}
beforeAll(async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/document-templates",
    headers: H(),
    payload: { name: "Retención", source: "# Contrato con {{cliente}}\n\n{{firma:Cliente}}\n\n{{firma:Proveedor}}" },
  });
  retentionTemplate = res.json().id;
});
