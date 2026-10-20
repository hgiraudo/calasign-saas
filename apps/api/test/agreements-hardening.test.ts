// Plataforma de acuerdos sobre PGlite: defensas del link público de workflows (plan, Turnstile, tope por organización,
// tiempo mínimo, deduplicación por correo + IP, workflow desactivado/despublicado, vencimiento), aviso de aprobación por
// la cola, borrado de PDFs generados no usados, validación de roles y topes de comentarios en negociaciones, propuestas
// pendientes al cancelar y auditoría.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-agr-hard-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
let userId: string;
let cookie: string;
const real = globalThis.fetch;

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
    payload: { email: "duena@agr.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Acuerdos" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name === "cs_session")!;
  cookie = `cs_session=${c.value}`;
  userId = res.json().user.id;
  tenant = res.json().tenant.id;
}, 120_000);

afterAll(async () => {
  globalThis.fetch = real;
  await app?.close();
  await db?.close();
});

const H = () => ({ cookie, origin: "http://localhost:5173" });
const deps = () => ({ log: { info() {}, warn() {}, error() {} } });

async function blobs() {
  const { createBlobStore } = await import("../src/infra/storage");
  return createBlobStore();
}

async function createWorkflow(body: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/workflows", headers: H(), payload: body });
  return res;
}

function collectThenApprove() {
  return [
    {
      id: randomUUID(),
      type: "collect_data",
      name: "Datos",
      config: { title: "Tus datos", fields: [{ key: "email", label: "Correo", type: "email" }, { key: "nombre", label: "Nombre", type: "text" }] },
    },
    { id: randomUUID(), type: "approval", name: "Visto bueno", config: { approverUserId: userId, message: "Revisá el alta" } },
  ];
}

async function publicWorkflow() {
  const res = await createWorkflow({ name: `Alta ${randomUUID().slice(0, 6)}`, publicStart: true, steps: collectThenApprove() });
  expect(res.statusCode).toBe(201);
  const wf = res.json();
  return { id: wf.id as string, slug: (wf.publicUrl as string).split("/wf/")[1] };
}

async function startPublic(slug: string, ip = "203.0.113.10", body: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: `/v1/public/workflows/${slug}/start`, payload: body, remoteAddress: ip });
}

/** El formulario quedó esperando hace rato (pasó el tiempo mínimo de llenado). */
async function age(token: string) {
  const { sha256Hex } = await import("../src/lib/util");
  await db.query(
    `UPDATE workflow_run_steps SET started_at = now() - interval '1 minute' WHERE run_id = (SELECT id FROM workflow_runs WHERE public_token_hash = $1) AND status = 'waiting'`,
    [sha256Hex(token)],
  );
}

describe("workflows con inicio público", () => {
  it("exige el plan web_forms para publicar, ofrecer el link y completar datos", async () => {
    const wf = await publicWorkflow();
    const started = await startPublic(wf.slug);
    expect(started.statusCode).toBe(201);
    const token = started.json().token as string;
    await db.query(`UPDATE tenants SET billing_plan = 'starter' WHERE id = $1`, [tenant]);
    try {
      const create = await createWorkflow({ name: "Otro", publicStart: true, steps: collectThenApprove() });
      expect(create.statusCode).toBe(402);
      expect((await createWorkflow({ name: "Interno", steps: collectThenApprove() })).statusCode).toBe(201);
      expect((await app.inject({ method: "GET", url: `/v1/public/workflows/${wf.slug}` })).statusCode).toBe(404);
      expect((await startPublic(wf.slug)).statusCode).toBe(404);
      await age(token);
      const sub = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${token}/steps/0`, payload: { values: { email: "a@b.com", nombre: "A" } } });
      expect(sub.statusCode).toBe(410);
      // Despublicarlo sí se puede sin el plan.
      expect((await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { publicStart: false } })).statusCode).toBe(200);
    } finally {
      await db.query(`UPDATE tenants SET billing_plan = NULL WHERE id = $1`, [tenant]);
    }
  });

  it("Turnstile: con las claves configuradas, el inicio exige un token válido", async () => {
    const { config } = await import("../src/config");
    const wf = await publicWorkflow();
    config.webForms.turnstileSiteKey = "site";
    config.webForms.turnstileSecretKey = "secret";
    try {
      expect((await app.inject({ method: "GET", url: `/v1/public/workflows/${wf.slug}` })).json().captchaSiteKey).toBe("site");
      globalThis.fetch = (async () => new Response(JSON.stringify({ success: false }), { status: 200 })) as typeof fetch;
      const bad = await startPublic(wf.slug, "203.0.113.11", { captchaToken: "x" });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe("captcha_failed");
      expect((await startPublic(wf.slug, "203.0.113.11")).json().error.code).toBe("captcha_failed");
      globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, hostname: "localhost" }), { status: 200 })) as typeof fetch;
      expect((await startPublic(wf.slug, "203.0.113.11", { captchaToken: "ok" })).statusCode).toBe(201);
    } finally {
      config.webForms.turnstileSiteKey = null;
      config.webForms.turnstileSecretKey = null;
      globalThis.fetch = real;
    }
  });

  it("tiempo mínimo, deduplicación por correo + IP y aviso de aprobación por la cola", async () => {
    const wf = await publicWorkflow();
    const t1 = (await startPublic(wf.slug, "198.51.100.7")).json().token as string;
    const fast = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${t1}/steps/0`, payload: { values: { email: "x@y.com", nombre: "X" } }, remoteAddress: "198.51.100.7" });
    expect(fast.statusCode).toBe(422);
    expect(fast.json().error.code).toBe("too_fast");
    await age(t1);
    const ok = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${t1}/steps/0`, payload: { values: { email: "X@y.com", nombre: "X" } }, remoteAddress: "198.51.100.7" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("waiting"); // ahora espera la aprobación
    const run = await db.one<any>(`SELECT id FROM workflow_runs WHERE workflow_id = $1 AND public_submitter IS NOT NULL`, [wf.id]);
    const job = await db.one<any>(`SELECT payload FROM jobs WHERE queue = 'agreements' AND payload->>'runId' = $1 AND payload->>'kind' = 'workflow_approval_notice'`, [run.id]);
    expect(job.payload.stepIndex).toBe(1);

    // Mismo correo desde la misma IP en otra ejecución: rechazado. Desde otra IP, se acepta.
    const t2 = (await startPublic(wf.slug, "198.51.100.7")).json().token as string;
    await age(t2);
    const dup = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${t2}/steps/0`, payload: { values: { email: "x@y.com", nombre: "X" } }, remoteAddress: "198.51.100.7" });
    expect(dup.statusCode).toBe(429);
    expect(dup.json().error.code).toBe("form_recent_submission");
    const other = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${t2}/steps/0`, payload: { values: { email: "x@y.com", nombre: "X" } }, remoteAddress: "198.51.100.99" });
    expect(other.statusCode).toBe(200);
  });

  it("tope por organización compartido con los formularios web", async () => {
    const { config } = await import("../src/config");
    const wf = await publicWorkflow();
    const prev = config.webForms.maxPerTenantHour;
    const n = (await db.one<any>(`SELECT count(*)::int AS n FROM workflow_runs WHERE tenant_id = $1 AND started_by IS NULL AND started_by_api_key IS NULL`, [tenant])).n;
    config.webForms.maxPerTenantHour = n + 1;
    try {
      expect((await startPublic(wf.slug, "192.0.2.1")).statusCode).toBe(201);
      const over = await startPublic(wf.slug, "192.0.2.2");
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe("workflow_rate_limited");
    } finally {
      config.webForms.maxPerTenantHour = prev;
    }
  });

  it("desactivar cancela las ejecuciones públicas que esperan su formulario; un link de un workflow inactivo no acepta datos", async () => {
    const wf = await publicWorkflow();
    const token = (await startPublic(wf.slug, "192.0.2.50")).json().token as string;
    // Una ejecución interna (iniciada por la dueña) que espera su formulario no se cancela, pero tampoco acepta datos.
    const internal = await app.inject({ method: "POST", url: `/v1/workflows/${wf.id}/runs`, headers: H(), payload: { data: {} } });
    expect(internal.statusCode).toBe(201);
    const res = await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { active: false } });
    expect(res.statusCode).toBe(200);
    const runs = await db.query<any>(`SELECT status, started_by FROM workflow_runs WHERE workflow_id = $1`, [wf.id]);
    expect(runs.find((r) => !r.started_by).status).toBe("cancelled");
    expect(runs.find((r) => r.started_by).status).toBe("waiting");
    await age(token);
    const sub = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${token}/steps/0`, payload: { values: { email: "z@y.com", nombre: "Z" } } });
    expect(sub.statusCode).toBe(410);
    const internalToken = internal.json().collectUrl.split("/w/")[1];
    await age(internalToken);
    expect((await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${internalToken}/steps/0`, payload: { values: { email: "z@y.com", nombre: "Z" } } })).statusCode).toBe(410);
  });

  it("vence (cancela) las ejecuciones que esperan un formulario sin actividad", async () => {
    const { workflowRunsSweep, COLLECT_IDLE_DAYS } = await import("../src/modules/agreements/workflows");
    const wf = await publicWorkflow();
    const token = (await startPublic(wf.slug, "192.0.2.60")).json().token as string;
    const { sha256Hex } = await import("../src/lib/util");
    const run = await db.one<any>(`SELECT id FROM workflow_runs WHERE public_token_hash = $1`, [sha256Hex(token)]);
    await workflowRunsSweep({ db, blobs: await blobs(), log: deps().log });
    expect((await db.one<any>(`SELECT status FROM workflow_runs WHERE id = $1`, [run.id])).status).toBe("waiting");
    await db.query(`UPDATE workflow_runs SET updated_at = now() - make_interval(days => $2) WHERE id = $1`, [run.id, COLLECT_IDLE_DAYS + 1]);
    await workflowRunsSweep({ db, blobs: await blobs(), log: deps().log });
    expect((await db.one<any>(`SELECT status FROM workflow_runs WHERE id = $1`, [run.id])).status).toBe("cancelled");
    // Ya no bloquea el borrado del workflow.
    await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { publicStart: false } });
    expect((await app.inject({ method: "DELETE", url: `/v1/workflows/${wf.id}`, headers: H() })).statusCode).toBe(204);
  });
});

describe("workflows: documentos generados y repositorio", () => {
  it("al rechazar el run se borran los PDFs generados que no salieron en un sobre", async () => {
    const tpl = await app.inject({ method: "POST", url: "/v1/document-templates", headers: H(), payload: { name: "Carta", source: "# Hola {{nombre}}\n\nTexto." } });
    expect(tpl.statusCode).toBe(201);
    const res = await createWorkflow({
      name: "Con documento",
      steps: [
        { id: randomUUID(), type: "generate_document", name: "Generar", config: { documentTemplateId: tpl.json().id, output: "carta" } },
        { id: randomUUID(), type: "approval", name: "Aprobar", config: { approverUserId: userId } },
      ],
    });
    expect(res.statusCode).toBe(201);
    const run = await app.inject({ method: "POST", url: `/v1/workflows/${res.json().id}/runs`, headers: H(), payload: { data: { nombre: "Ana" } } });
    expect(run.statusCode).toBe(201);
    const fileId = run.json().context.documents.carta.fileId as string;
    expect(await db.one(`SELECT 1 FROM files WHERE id = $1`, [fileId])).toBeTruthy();
    const dec = await app.inject({ method: "POST", url: `/v1/workflow-runs/${run.json().id}/steps/1/decision`, headers: H(), payload: { approve: false } });
    expect(dec.statusCode).toBe(200);
    expect(await db.one(`SELECT 1 FROM files WHERE id = $1`, [fileId])).toBeNull();
    // Reintentar ya no es posible (y el run no vuelve a usar el documento).
    expect((await db.one<any>(`SELECT context->>'documentsCleaned' AS c FROM workflow_runs WHERE id = $1`, [run.json().id])).c).toBe("true");
  }, 60_000);

  it("PATCH de un acuerdo fusiona los metadatos en SQL", async () => {
    const { uuidv7 } = await import("../src/lib/util");
    const file = uuidv7();
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original','k','application/pdf',1,'h')`, [file, tenant]);
    const ag = uuidv7();
    await db.query(
      `INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title, status, owner_user_id, metadata) VALUES ($1,$2,'external',$3,'a.pdf','Acuerdo','active',$4,'{"a":"1"}')`,
      [ag, tenant, file, userId],
    );
    // Otro proceso agrega una clave entre la lectura y la escritura: no se pierde.
    await db.query(`UPDATE agreements SET metadata = metadata || '{"b":"2"}' WHERE id = $1`, [ag]);
    for (const key of ["region"]) {
      await app.inject({ method: "POST", url: "/v1/agreement-fields", headers: H(), payload: { key, label: "Región", type: "text" } });
    }
    const res = await app.inject({ method: "PATCH", url: `/v1/agreements/${ag}`, headers: H(), payload: { metadata: { region: "Sur" } } });
    expect(res.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT metadata FROM agreements WHERE id = $1`, [ag])).metadata).toEqual({ a: "1", b: "2", region: "Sur" });
    expect(await db.one(`SELECT 1 FROM account_audit_log WHERE tenant_id = $1 AND action = 'agreement_field.created'`, [tenant])).toBeTruthy();
  });
});

describe("negociaciones", () => {
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

  const create = (participants: { name: string; email: string; role?: string | null }[]) =>
    app.inject({ method: "POST", url: "/v1/negotiations", headers: H(), payload: { title: "Servicios", documentTemplateId: templateId, data: { cliente: "ACME", precio: "100" }, participants } });

  it("valida los roles de las contrapartes contra el documento", async () => {
    const dup = await create([
      { name: "A", email: "a@x.com", role: "Cliente" },
      { name: "B", email: "b@x.com", role: "cliente" },
    ]);
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error.code).toBe("duplicate_role");
    const unknown = await create([{ name: "A", email: "a@x.com", role: "Garante" }]);
    expect(unknown.json().error.code).toBe("unknown_role");
    const missing = await create([{ name: "A", email: "a@x.com", role: null }]);
    expect(missing.json().error.code).toBe("missing_roles");
    // Un rol sin contraparte (lo firma el remitente) se permite.
    expect((await create([{ name: "A", email: "a@x.com", role: "Cliente" }])).statusCode).toBe(201);
  });

  it("topes de comentarios por contraparte, cancelación con propuestas pendientes y auditoría", async () => {
    const res = await create([
      { name: "A", email: "a@x.com", role: "Cliente" },
      { name: "B", email: "b@x.com", role: "Proveedor" },
    ]);
    expect(res.statusCode).toBe(201);
    const id = res.json().negotiation.id as string;
    const { decrypt } = await import("../src/lib/util");
    const parts = await db.query<any>(`SELECT id, token_enc, email FROM negotiation_participants WHERE negotiation_id = $1 ORDER BY email`, [id]);
    const tokenA = decrypt(parts[0].token_enc);
    const tokenB = decrypt(parts[1].token_enc);
    // A llega a su cupo (insertado directo para no pasar por el límite por minuto); B y el remitente siguen pudiendo comentar.
    await db.query(
      `INSERT INTO negotiation_comments (id, negotiation_id, version, author_type, author_id, author_name, body)
       SELECT gen_random_uuid(), $1, 1, 'participant', $2, 'A', 'c' FROM generate_series(1, 100)`,
      [id, parts[0].id],
    );
    const capped = await app.inject({ method: "POST", url: `/v1/public/negotiations/${tokenA}/comments`, payload: { body: "uno más" } });
    expect(capped.statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: `/v1/public/negotiations/${tokenB}/comments`, payload: { body: "hola" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/v1/negotiations/${id}/comments`, headers: H(), payload: { body: "respuesta" } })).statusCode).toBe(201);

    const prop = await app.inject({ method: "POST", url: `/v1/public/negotiations/${tokenB}/proposals`, payload: { kind: "variable", key: "precio", newValue: "90" } });
    expect(prop.statusCode).toBe(201);
    const edit = await app.inject({ method: "PATCH", url: `/v1/negotiations/${id}`, headers: H(), payload: { data: { cliente: "ACME SA", precio: "100" }, summary: "Razón social" } });
    expect(edit.statusCode).toBe(200);
    const cancel = await app.inject({ method: "POST", url: `/v1/negotiations/${id}/cancel`, headers: H() });
    expect(cancel.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM negotiation_proposals WHERE negotiation_id = $1 AND status = 'pending'`, [id])).n).toBe(0);
    const actions = (await db.query<any>(`SELECT action FROM account_audit_log WHERE tenant_id = $1 AND target_id = $2`, [tenant, id])).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["negotiation.created", "negotiation.updated", "negotiation.cancelled"]));
  });

  it("auditoría de plantillas y cláusulas", async () => {
    expect((await app.inject({ method: "PATCH", url: `/v1/document-templates/${templateId}`, headers: H(), payload: { name: "Servicios v2" } })).statusCode).toBe(200);
    const cl = await app.inject({ method: "POST", url: "/v1/clauses", headers: H(), payload: { slug: "confid", title: "Confidencialidad", body: "Las partes guardan reserva." } });
    expect(cl.statusCode).toBe(201);
    expect((await app.inject({ method: "PATCH", url: `/v1/clauses/${cl.json().id}`, headers: H(), payload: { title: "Reserva" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/clauses/${cl.json().id}`, headers: H() })).statusCode).toBe(204);
    const actions = (await db.query<any>(`SELECT action FROM account_audit_log WHERE tenant_id = $1`, [tenant])).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["document_template.updated", "clause.created", "clause.updated", "clause.deleted"]));
  });
});
