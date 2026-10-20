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

  it("tope por organización compartido con los formularios web: cuentan los runs que completaron el formulario", async () => {
    const { config } = await import("../src/config");
    const wf = await publicWorkflow();
    const prev = config.webForms.maxPerTenantHour;
    const n = (await db.one<any>(`SELECT count(*)::int AS n FROM workflow_runs WHERE tenant_id = $1 AND public_collected_at > now() - interval '1 hour'`, [tenant])).n;
    config.webForms.maxPerTenantHour = n + 1;
    try {
      // Los inicios sin completar no gastan el cupo.
      const t1 = (await startPublic(wf.slug, "192.0.2.1")).json().token as string;
      const t2 = (await startPublic(wf.slug, "192.0.2.2")).json().token as string;
      expect(t2).toBeTruthy();
      await age(t1);
      await age(t2);
      const ok = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${t1}/steps/0`, payload: { values: { email: "c1@y.com", nombre: "C" } }, remoteAddress: "192.0.2.1" });
      expect(ok.statusCode).toBe(200);
      const over = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${t2}/steps/0`, payload: { values: { email: "c2@y.com", nombre: "C" } }, remoteAddress: "192.0.2.2" });
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe("workflow_rate_limited");
    } finally {
      config.webForms.maxPerTenantHour = prev;
    }
  });

  it("tope compartido: un run cuyo primer paso no es un formulario lo gasta al iniciar, aunque tenga un formulario después", async () => {
    const { config } = await import("../src/config");
    const [collect, approve] = collectThenApprove();
    const res = await createWorkflow({ name: `Aprobar ${randomUUID().slice(0, 6)}`, publicStart: true, steps: [approve, collect] });
    expect(res.statusCode).toBe(201);
    const slug = (res.json().publicUrl as string).split("/wf/")[1];
    const prev = config.webForms.maxPerTenantHour;
    const n = (await db.one<any>(`SELECT count(*)::int AS n FROM workflow_runs WHERE tenant_id = $1 AND public_collected_at > now() - interval '1 hour'`, [tenant])).n;
    config.webForms.maxPerTenantHour = n + 1;
    try {
      const first = await startPublic(slug, "192.0.2.11");
      expect(first.statusCode).toBe(201);
      const { sha256Hex } = await import("../src/lib/util");
      const run = await db.one<any>(`SELECT public_collected_at FROM workflow_runs WHERE public_token_hash = $1`, [sha256Hex(first.json().token)]);
      expect(run.public_collected_at).not.toBeNull();
      const over = await startPublic(slug, "192.0.2.12");
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe("workflow_rate_limited");
    } finally {
      config.webForms.maxPerTenantHour = prev;
    }
  });

  it("tope aparte (más alto) de inicios por organización y hora", async () => {
    const { config } = await import("../src/config");
    const wf = await publicWorkflow();
    const prev = config.webForms.maxPublicStartsPerTenantHour;
    const n = (await db.one<any>(
      `SELECT count(*)::int AS n FROM workflow_runs WHERE tenant_id = $1 AND started_by IS NULL AND started_by_api_key IS NULL AND created_at > now() - interval '1 hour'`,
      [tenant],
    )).n;
    config.webForms.maxPublicStartsPerTenantHour = n + 1;
    try {
      expect((await startPublic(wf.slug, "192.0.2.3")).statusCode).toBe(201);
      const over = await startPublic(wf.slug, "192.0.2.4");
      expect(over.statusCode).toBe(429);
      expect(over.json().error.code).toBe("workflow_rate_limited");
    } finally {
      config.webForms.maxPublicStartsPerTenantHour = prev;
    }
  });

  it("PATCH tras bajar de plan: editar un workflow publicado sí; activarlo o publicarlo, no", async () => {
    const wf = await publicWorkflow();
    const internal = await createWorkflow({ name: "Interno pub", steps: collectThenApprove() });
    await db.query(`UPDATE tenants SET billing_plan = 'starter' WHERE id = $1`, [tenant]);
    try {
      expect((await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { name: "Renombrado" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { active: false } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { active: true } })).statusCode).toBe(402);
      expect((await app.inject({ method: "PATCH", url: `/v1/workflows/${internal.json().id}`, headers: H(), payload: { publicStart: true } })).statusCode).toBe(402);
    } finally {
      await db.query(`UPDATE tenants SET billing_plan = NULL WHERE id = $1`, [tenant]);
    }
  });

  it("desactivar cancela las ejecuciones públicas que esperan su formulario; un link de un workflow inactivo no acepta datos", async () => {
    const wf = await publicWorkflow();
    const token = (await startPublic(wf.slug, "192.0.2.50")).json().token as string;
    // Una ejecución interna (iniciada por la dueña) que espera su formulario no se cancela y sigue aceptando datos.
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
    // Sin tiempo mínimo de llenado (solo en runs públicos).
    const internalToken = internal.json().collectUrl.split("/w/")[1];
    const accepted = await app.inject({ method: "POST", url: `/v1/public/workflow-runs/${internalToken}/steps/0`, payload: { values: { email: "z@y.com", nombre: "Z" } } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().status).toBe("waiting"); // espera la aprobación
    // El DELETE explica que desactivar no cancela las internas.
    const del = await app.inject({ method: "DELETE", url: `/v1/workflows/${wf.id}`, headers: H() });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.message).toMatch(/link público/);
  });

  it("vence (cancela) las ejecuciones que esperan un formulario sin actividad", async () => {
    const { workflowRunsSweep, COLLECT_IDLE_DAYS } = await import("../src/modules/agreements/workflows");
    const wf = await publicWorkflow();
    const token = (await startPublic(wf.slug, "192.0.2.60")).json().token as string;
    const { sha256Hex } = await import("../src/lib/util");
    const run = await db.one<any>(`SELECT id FROM workflow_runs WHERE public_token_hash = $1`, [sha256Hex(token)]);
    // Una ejecución interna esperando su formulario no vence sola.
    const internal = await app.inject({ method: "POST", url: `/v1/workflows/${wf.id}/runs`, headers: H(), payload: { data: {} } });
    expect(internal.statusCode).toBe(201);
    await db.query(`UPDATE workflow_runs SET updated_at = now() - make_interval(days => $2) WHERE id = $1`, [internal.json().id, COLLECT_IDLE_DAYS + 1]);
    await workflowRunsSweep({ db, blobs: await blobs(), log: deps().log });
    expect((await db.one<any>(`SELECT status FROM workflow_runs WHERE id = $1`, [run.id])).status).toBe("waiting");
    await db.query(`UPDATE workflow_runs SET updated_at = now() - make_interval(days => $2) WHERE id = $1`, [run.id, COLLECT_IDLE_DAYS + 1]);
    await workflowRunsSweep({ db, blobs: await blobs(), log: deps().log });
    expect((await db.one<any>(`SELECT status FROM workflow_runs WHERE id = $1`, [run.id])).status).toBe("cancelled");
    expect((await db.one<any>(`SELECT status FROM workflow_runs WHERE id = $1`, [internal.json().id])).status).toBe("waiting");
    await app.inject({ method: "POST", url: `/v1/workflow-runs/${internal.json().id}/cancel`, headers: H() });
    // Ya no bloquea el borrado del workflow.
    await app.inject({ method: "PATCH", url: `/v1/workflows/${wf.id}`, headers: H(), payload: { publicStart: false } });
    expect((await app.inject({ method: "DELETE", url: `/v1/workflows/${wf.id}`, headers: H() })).statusCode).toBe(204);
  });
});

describe("workflows: documentos generados y repositorio", () => {
  it("needsGeneratedDocuments: solo un envío pendiente que usa un PDF generado antes", async () => {
    const { needsGeneratedDocuments } = await import("../src/modules/agreements/workflows");
    const gen = { id: randomUUID(), type: "generate_document", name: "G", config: { documentTemplateId: randomUUID(), output: "doc", allowMissing: false } } as any;
    const send = { id: randomUUID(), type: "send_for_signature", name: "S", config: { document: "doc", envelopeKey: "e", subject: "x", recipients: [] } } as any;
    const http = { id: randomUUID(), type: "http_request", name: "H", config: { url: "https://x.test", method: "POST" } } as any;
    expect(needsGeneratedDocuments([gen, http, send], 1)).toBe(true);
    expect(needsGeneratedDocuments([gen, send, http], 2)).toBe(false);
    expect(needsGeneratedDocuments([gen, http, gen, send], 1)).toBe(false); // se vuelve a generar antes de enviarlo
  });

  it("reintento con los documentos ya borrados: se permite si no queda un envío que los use", async () => {
    const tpl = await app.inject({ method: "POST", url: "/v1/document-templates", headers: H(), payload: { name: "Carta R", source: "# Hola {{nombre}}" } });
    const mk = async (withSend: boolean) => {
      const steps: any[] = [
        { id: randomUUID(), type: "generate_document", name: "Generar", config: { documentTemplateId: tpl.json().id, output: "carta" } },
        { id: randomUUID(), type: "http_request", name: "Avisar", config: { url: "ftp://example.com/x" } },
      ];
      if (withSend) {
        steps.push({ id: randomUUID(), type: "send_for_signature", name: "Enviar", config: { document: "carta", envelopeKey: "e", subject: "Carta", recipients: [{ role: "Cliente", name: "Ana", email: "ana@x.test" }] } });
      }
      const wf = await createWorkflow({ name: `Reintento ${randomUUID().slice(0, 6)}`, steps });
      expect(wf.statusCode).toBe(201);
      const run = await app.inject({ method: "POST", url: `/v1/workflows/${wf.json().id}/runs`, headers: H(), payload: { data: { nombre: "Ana" } } });
      expect(run.json().status).toBe("failed");
      // Como el barrido de runs fallados viejos.
      await db.query(`UPDATE workflow_runs SET context = context || '{"documentsCleaned": true}'::jsonb WHERE id = $1`, [run.json().id]);
      return run.json().id as string;
    };
    const blocked = await app.inject({ method: "POST", url: `/v1/workflow-runs/${await mk(true)}/retry`, headers: H() });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("not_retryable");
    const id = await mk(false);
    const ok = await app.inject({ method: "POST", url: `/v1/workflow-runs/${id}/retry`, headers: H() });
    expect(ok.statusCode).toBe(200);
    const ctx = (await db.one<any>(`SELECT context FROM workflow_runs WHERE id = $1`, [id])).context;
    expect(ctx.documentsCleaned).toBeUndefined();
    expect(ctx.documents).toEqual({});
  }, 60_000);

  it("deduplicación por correo + IP sin carrera: dos envíos simultáneos de dos runs, uno solo pasa", async () => {
    const wf = await publicWorkflow();
    const ip = "198.51.100.200";
    const t1 = (await startPublic(wf.slug, ip)).json().token as string;
    const t2 = (await startPublic(wf.slug, ip)).json().token as string;
    await age(t1);
    await age(t2);
    const send = (t: string) => app.inject({ method: "POST", url: `/v1/public/workflow-runs/${t}/steps/0`, payload: { values: { email: "par@y.com", nombre: "P" } }, remoteAddress: ip });
    const codes = (await Promise.all([send(t1), send(t2)])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 429]);
  }, 60_000);

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

  it("observadores: rol libre permitido (copia del sobre); con un rol de firma, 400", async () => {
    const createObs = (participants: Record<string, unknown>[]) =>
      app.inject({ method: "POST", url: "/v1/negotiations", headers: H(), payload: { title: "Obs", documentTemplateId: templateId, data: { cliente: "ACME", precio: "100" }, participants } });
    const ok = await createObs([
      { name: "A", email: "a@x.com", role: "Cliente" },
      { name: "L", email: "l@x.com", role: "Abogado", observer: true },
    ]);
    expect(ok.statusCode).toBe(201);
    const obs = ok.json().negotiation.participants.find((p: any) => p.email === "l@x.com");
    expect(obs).toMatchObject({ role: "Abogado", observer: true });
    const bad = await createObs([
      { name: "A", email: "a@x.com", role: "Cliente" },
      { name: "L", email: "l@x.com", role: "Proveedor", observer: true },
    ]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("observer_signing_role");
    // Al aceptar, el observador va como copia y el remitente firma el rol sin contraparte.
    const id = ok.json().negotiation.id as string;
    const acc = await app.inject({ method: "POST", url: `/v1/negotiations/${id}/accept`, headers: H(), payload: {} });
    expect(acc.statusCode).toBe(200);
    const envelopeId = acc.json().envelope.id;
    const recips = await db.query<any>(`SELECT email, role FROM recipients WHERE envelope_id = $1 ORDER BY email`, [envelopeId]);
    expect(recips.find((r: any) => r.email === "l@x.com").role).toBe("cc");
  }, 60_000);

  it("negociación sobre PDF subido: al aceptar, los observadores van como copia", async () => {
    const content = "BT /F1 14 Tf 50 780 Td (Contrato subido) Tj ET";
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const meta = { title: "Subido", participants: [{ name: "A", email: "a@x.com", role: "Cliente" }, { name: "L", email: "l@x.com", role: "Abogado", observer: true }] };
    const b = "----calasign" + randomUUID().slice(0, 8);
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="c.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(pdf, "latin1"),
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const up = await app.inject({ method: "POST", url: "/v1/negotiations/upload", headers: { ...H(), "content-type": `multipart/form-data; boundary=${b}` }, payload: body });
    expect(up.statusCode).toBe(201);
    const id = up.json().negotiation.id as string;
    const acc = await app.inject({ method: "POST", url: `/v1/negotiations/${id}/accept`, headers: H(), payload: {} });
    expect(acc.statusCode).toBe(200);
    const recips = await db.query<any>(`SELECT email, role FROM recipients WHERE envelope_id = $1 ORDER BY email`, [acc.json().envelope.id]);
    expect(recips).toEqual([
      { email: "a@x.com", role: "signer" },
      { email: "l@x.com", role: "cc" },
    ]);
  }, 60_000);

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
