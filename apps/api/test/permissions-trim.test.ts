// Permisos (app real sobre PGlite): recortar un rol revoca lo que crearon sus miembros, canManage en plantillas,
// firma en persona abierta por un administrador y la baja del anfitrión en la auditoría, y ejecuciones de workflows
// sin datos para quien solo administra plantillas.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-perms-trim-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let tenant = "";
let ownerId = "";
let ownerCookie = "";

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
    payload: { email: "duena@perms.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Permisos" },
  });
  expect(res.statusCode).toBe(201);
  ownerCookie = res.cookies.find((x) => x.name === "cs_session")!.value;
  ownerId = res.json().user.id;
  tenant = res.json().tenant.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const H = (session: string) => ({ cookie: `cs_session=${session}`, origin: "http://localhost:5173" });

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
  return { id, session: token };
}

async function newRole(name: string, permissions: string[]) {
  const r = await app.inject({ method: "POST", url: "/v1/roles", headers: H(ownerCookie), payload: { name, permissions } });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

describe("PATCH /v1/roles/:id", () => {
  it("recortar permisos revoca las API keys e invitaciones que crearon sus miembros, y lo audita", async () => {
    const roleId = await newRole("Integraciones", ["envelopes:create", "api_keys:manage", "members:manage"]);
    const m = await newMember("integra@perms.test", "custom", roleId);
    const key = util.uuidv7();
    await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by, role) VALUES ($1,$2,'admin','cs_test',$3,$4,'admin')`, [
      key,
      tenant,
      util.sha256Hex(util.randomToken()),
      m.id,
    ]);
    const inv = util.uuidv7();
    await db.query(
      `INSERT INTO invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,'nuevo@perms.test','admin',$3,$4, now() + interval '7 days')`,
      [inv, tenant, util.sha256Hex(util.randomToken()), m.id],
    );

    // Solo el nombre: no revoca nada.
    const rename = await app.inject({ method: "PATCH", url: `/v1/roles/${roleId}`, headers: H(ownerCookie), payload: { name: "Integraciones 2" } });
    expect(rename.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT revoked_at FROM api_keys WHERE id = $1`, [key]))!.revoked_at).toBeNull();

    // Mismos permisos u otros de más: tampoco.
    const widen = await app.inject({
      method: "PATCH",
      url: `/v1/roles/${roleId}`,
      headers: H(ownerCookie),
      payload: { permissions: ["envelopes:create", "api_keys:manage", "members:manage", "audit:view"] },
    });
    expect(widen.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT revoked_at FROM api_keys WHERE id = $1`, [key]))!.revoked_at).toBeNull();

    const trim = await app.inject({ method: "PATCH", url: `/v1/roles/${roleId}`, headers: H(ownerCookie), payload: { permissions: ["envelopes:create"] } });
    expect(trim.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT revoked_at FROM api_keys WHERE id = $1`, [key]))!.revoked_at).not.toBeNull();
    expect((await db.one<any>(`SELECT revoked_at FROM invitations WHERE id = $1`, [inv]))!.revoked_at).not.toBeNull();
    // Sigue siendo miembro (no es una baja).
    expect(await db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [tenant, m.id])).not.toBeNull();
    const audit = await db.one<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'role.updated' AND target_id = $2 ORDER BY id DESC LIMIT 1`,
      [tenant, roleId],
    );
    expect(audit!.data.revokedCredentials[m.id]).toMatchObject({ apiKeys: [key], invitations: 1 });
  });
});

describe("canManage en plantillas", () => {
  it("GET /v1/templates y /v1/templates/:id dicen si quien consulta puede modificarla", async () => {
    const created = await app.inject({ method: "POST", url: "/v1/templates", headers: H(ownerCookie), payload: { name: "Contrato marco" } });
    expect(created.statusCode).toBe(201);
    const tplId = created.json().template.id as string;
    const m = await newMember("colega@perms.test", "member");

    const asOwner = await app.inject({ method: "GET", url: `/v1/templates/${tplId}`, headers: H(ownerCookie) });
    expect(asOwner.json().canManage).toBe(true);
    const asMember = await app.inject({ method: "GET", url: `/v1/templates/${tplId}`, headers: H(m.session) });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json().canManage).toBe(false);
    // Y efectivamente no puede modificarla.
    expect((await app.inject({ method: "PATCH", url: `/v1/templates/${tplId}`, headers: H(m.session), payload: { name: "x" } })).statusCode).toBe(403);

    const own = await app.inject({ method: "POST", url: "/v1/templates", headers: H(m.session), payload: { name: "La mía" } });
    expect(own.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: "/v1/templates", headers: H(m.session) });
    const items = list.json().items as { id: string; canManage: boolean }[];
    expect(items.find((i) => i.id === tplId)?.canManage).toBe(false);
    expect(items.find((i) => i.id === own.json().template.id)?.canManage).toBe(true);
    const ownerList = await app.inject({ method: "GET", url: "/v1/templates", headers: H(ownerCookie) });
    expect((ownerList.json().items as { canManage: boolean }[]).every((i) => i.canManage)).toBe(true);
  });
});

describe("firma en persona", () => {
  async function inPersonEnvelope(hostId: string) {
    const envelope = util.uuidv7();
    const recipient = util.uuidv7();
    const token = util.randomToken();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, created_by) VALUES ($1,$2,'Presencial','sent',$3)`, [envelope, tenant, ownerId]);
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc, auth_method, in_person_host_user_id)
       VALUES ($1,$2,$3,'signer','Ana','ana@x.test','sent',$4,$5,'in_person',$6)`,
      [recipient, tenant, envelope, util.sha256Hex(token), util.encrypt(token), hostId],
    );
    return { envelope, recipient };
  }

  it("la abre el anfitrión o quien tiene envelopes:manage_all (queda registrado)", async () => {
    const host = await newMember("anfitrion@perms.test", "member");
    const other = await newMember("otro@perms.test", "member");
    const { envelope, recipient } = await inPersonEnvelope(host.id);
    const url = `/v1/envelopes/${envelope}/recipients/${recipient}/in-person`;
    expect((await app.inject({ method: "POST", url, headers: H(other.session), payload: {} })).statusCode).toBeGreaterThanOrEqual(403);
    expect((await app.inject({ method: "POST", url, headers: H(host.session), payload: {} })).statusCode).toBe(200);
    const byAdmin = await app.inject({ method: "POST", url, headers: H(ownerCookie), payload: {} });
    expect(byAdmin.statusCode).toBe(200);
    const ev = await db.one<any>(
      `SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.in_person_started' ORDER BY seq DESC LIMIT 1`,
      [envelope],
    );
    expect(ev!.data).toMatchObject({ hostUserId: ownerId, assignedHostUserId: host.id, openedByAdmin: true });
  });

  it("la baja del anfitrión lista en la auditoría los sobres en curso donde lo era", async () => {
    const host = await newMember("anfitrion2@perms.test", "member");
    const { envelope } = await inPersonEnvelope(host.id);
    const del = await app.inject({ method: "DELETE", url: `/v1/members/${host.id}`, headers: H(ownerCookie) });
    expect(del.statusCode).toBe(204);
    const audit = await db.one<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'member.removed' AND target_id = $2 ORDER BY id DESC LIMIT 1`,
      [tenant, host.id],
    );
    expect(audit!.data.inPersonHostEnvelopes).toEqual([envelope]);
  });
});

describe("ejecuciones de workflows", () => {
  it("con templates:manage sin envelopes:view_all, las ajenas vienen sin datos ni link de recolección", async () => {
    const wf = await app.inject({
      method: "POST",
      url: "/v1/workflows",
      headers: H(ownerCookie),
      payload: {
        name: "Alta de proveedor",
        steps: [{ id: randomUUID(), type: "collect_data", name: "Datos", config: { title: "Datos", fields: [{ key: "cuit", label: "CUIT", type: "text" }] } }],
      },
    });
    expect(wf.statusCode).toBe(201);
    const run = await app.inject({ method: "POST", url: `/v1/workflows/${wf.json().id}/runs`, headers: H(ownerCookie), payload: { data: { secreto: "123" } } });
    expect(run.statusCode).toBe(201);
    const runId = run.json().id as string;
    expect(run.json().context.data).toEqual({ secreto: "123" });
    expect(run.json().redacted).toBeUndefined();

    const tplAdmin = await newMember("plantillas@perms.test", "custom", await newRole("Plantillas", ["envelopes:create", "templates:manage"]));
    const viewer = await newMember("auditora@perms.test", "custom", await newRole("Ve todo", ["envelopes:create", "envelopes:view_all"]));

    const redacted = await app.inject({ method: "GET", url: `/v1/workflow-runs/${runId}`, headers: H(tplAdmin.session) });
    expect(redacted.statusCode).toBe(200);
    expect(redacted.json()).toMatchObject({ redacted: true, collectUrl: null, canManage: true, context: { data: {}, envelopes: {}, http: {}, documents: {} } });
    expect(redacted.json().steps.every((s: { output: unknown }) => s.output === null)).toBe(true);
    const list = await app.inject({ method: "GET", url: "/v1/workflow-runs", headers: H(tplAdmin.session) });
    expect(list.json().items.find((r: { id: string }) => r.id === runId).context.data).toEqual({});

    const full = await app.inject({ method: "GET", url: `/v1/workflow-runs/${runId}`, headers: H(viewer.session) });
    expect(full.json().redacted).toBeUndefined();
    expect(full.json().context.data).toEqual({ secreto: "123" });

    // Error de un paso HTTP: redactado, solo el código (sin el cuerpo de la respuesta externa).
    await db.query(`UPDATE workflow_run_steps SET type = 'http_request', status = 'failed', error = $2 WHERE run_id = $1 AND idx = 0`, [
      runId,
      'El servicio respondió HTTP 500: {"apiKey":"sk_live_secreto"}',
    ]);
    const red2 = await app.inject({ method: "GET", url: `/v1/workflow-runs/${runId}`, headers: H(tplAdmin.session) });
    expect(red2.json().steps[0].error).toBe("El servicio respondió HTTP 500");
    const full2 = await app.inject({ method: "GET", url: `/v1/workflow-runs/${runId}`, headers: H(viewer.session) });
    expect(full2.json().steps[0].error).toContain("sk_live_secreto");
    const { redactedHttpError } = await import("../src/modules/agreements/workflows");
    expect(redactedHttpError("No se pudo conectar: getaddrinfo ENOTFOUND interno.acme")).toBe("No se pudo conectar");
    expect(redactedHttpError("otra cosa con datos")).toBe("La llamada HTTP falló");
    expect(redactedHttpError(null)).toBeNull();

    // Las que inicia él sí las ve completas.
    const mine = await app.inject({ method: "POST", url: `/v1/workflows/${wf.json().id}/runs`, headers: H(tplAdmin.session), payload: { data: { propio: true } } });
    expect(mine.statusCode).toBe(201);
    expect(mine.json().context.data).toEqual({ propio: true });
    expect(mine.json().collectUrl).toMatch(/\/w\//);
  });
});

describe("orden de bloqueos", () => {
  it("PATCH /v1/roles/:id bloquea la organización antes que el rol (como el cambio de rol de un miembro)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/modules/teams.ts", import.meta.url), "utf8");
    const start = src.indexOf('app.patch<P>("/v1/roles/:id"');
    const body = src.slice(start, src.indexOf("app.delete<P>(\"/v1/roles/:id\"", start));
    const tenantLock = body.indexOf("FROM tenants WHERE id = $1 FOR UPDATE");
    const roleLock = body.indexOf("FROM roles WHERE id = $1 AND tenant_id = $2 FOR UPDATE");
    expect(tenantLock).toBeGreaterThan(-1);
    expect(roleLock).toBeGreaterThan(tenantLock);
  });
});
