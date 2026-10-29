// Reportes y exportaciones (app real sobre PGlite): el listado y el CSV de acuerdos no leen el texto completo del PDF,
// búsqueda por título plegado con índice trigram, contrapartes por nombre/correo, total solo en la primera página,
// CSV con separador, zona horaria, corte avisado (X-Truncated) y auditoría, meses del reporte en la zona pedida,
// plantillas paginadas por cursor e historial de exportaciones a almacenamiento solo con envelopes:view_all.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-reports-exports-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let tenant = "";
let ownerId = "";
let ownerCookie = "";
let fileId = "";
/** Filas que devolvió cada consulta (para medir qué columnas viajan a Node). */
const captured: { sql: string; rows: any[] }[] = [];

const SECRET = "palabrasecretadelpdf";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  // Espía: db.one usa db.query, así que esto ve todas las lecturas fuera de transacciones.
  const realQuery = db.query.bind(db);
  db.query = (async (sql: string, params?: unknown[]) => {
    const rows = await realQuery(sql, params);
    captured.push({ sql, rows });
    return rows;
  }) as Db["query"];
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: "duena@reportes.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Reportes" },
  });
  expect(res.statusCode).toBe(201);
  ownerCookie = res.cookies.find((x) => x.name === "cs_session")!.value;
  ownerId = res.json().user.id;
  tenant = res.json().tenant.id;
  fileId = util.uuidv7();
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original','k','application/pdf',1,'h')`,
    [fileId, tenant],
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const H = (session = ownerCookie) => ({ cookie: `cs_session=${session}`, origin: "http://localhost:5173" });

async function agreement(title: string, counterparties: unknown[] = [], createdAt = "now()") {
  const id = util.uuidv7();
  await db.query(
    `INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title, counterparties, owner_user_id, text_folded, created_at)
     VALUES ($1,$2,'external',$3,'a.pdf',$4,$5::jsonb,$6,$7, ${createdAt})`,
    [id, tenant, fileId, title, JSON.stringify(counterparties), ownerId, `${SECRET} ${"x".repeat(5000)}`],
  );
  return id;
}

async function newMember(email: string, roleId: string) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'scrypt$x')`, [id, email, email.split("@")[0]]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role, role_id) VALUES ($1,$2,'custom',$3)`, [tenant, id, roleId]);
  const token = util.randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1,$2,$3, now() + interval '14 days', 'password')`,
    [util.sha256Hex(token), id, tenant],
  );
  return token;
}

describe("repositorio de acuerdos", () => {
  it("el listado y el CSV no traen text_folded ni search_vector", async () => {
    await agreement("Contrato de Género", [{ name: "Ana Pérez", email: "ana@cliente.test" }]);
    captured.length = 0;
    const list = await app.inject({ method: "GET", url: "/v1/agreements?q=genero", headers: H() });
    expect(list.statusCode).toBe(200);
    const csv = await app.inject({ method: "GET", url: "/v1/agreements/export.csv", headers: H() });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toContain(SECRET);
    expect(list.body).not.toContain(SECRET);
    const agreementRows = captured.filter((c) => /FROM agreements ag JOIN files/.test(c.sql)).flatMap((c) => c.rows);
    expect(agreementRows.length).toBeGreaterThan(0);
    for (const r of agreementRows) {
      expect(r).not.toHaveProperty("text_folded");
      expect(r).not.toHaveProperty("search_vector");
    }
    // El fragmento se arma en SQL (ts_headline), sin traer el texto.
    expect(list.json().items[0]).toHaveProperty("excerpt");
  });

  it("título comparado plegado de los dos lados, con índice trigram", async () => {
    await agreement("ÁRBOL Ñandú");
    const r = await app.inject({ method: "GET", url: `/v1/agreements?q=${encodeURIComponent("arbol ñandu")}`, headers: H() });
    expect(r.json().items.map((x: any) => x.title)).toContain("ÁRBOL Ñandú");
    const idx = await db.one<any>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'agreements_title_fold_trgm_idx'`);
    expect(idx?.indexdef).toContain("gin_trgm_ops");
  });

  it("contraparte: por nombre o correo, no por las claves del JSON", async () => {
    await agreement("Con contraparte", [{ name: "Bruno", email: "bruno@proveedor.test", role: "proveedor" }]);
    const byKey = await app.inject({ method: "GET", url: "/v1/agreements?counterparty=name", headers: H() });
    expect(byKey.json().items).toHaveLength(0);
    const byEmail = await app.inject({ method: "GET", url: "/v1/agreements?counterparty=proveedor.test", headers: H() });
    expect(byEmail.json().items.map((x: any) => x.title)).toEqual(["Con contraparte"]);
    const byName = await app.inject({ method: "GET", url: "/v1/agreements?counterparty=brun", headers: H() });
    expect(byName.json().items.map((x: any) => x.title)).toEqual(["Con contraparte"]);
  });

  it("el total solo viene en la primera página", async () => {
    const p1 = await app.inject({ method: "GET", url: "/v1/agreements?limit=1", headers: H() });
    expect(p1.json().total).toBeGreaterThanOrEqual(3);
    const p2 = await app.inject({ method: "GET", url: `/v1/agreements?limit=1&cursor=${p1.json().nextCursor}`, headers: H() });
    expect(p2.statusCode).toBe(200);
    expect(p2.json().total).toBeNull();
    expect(p2.json().items).toHaveLength(1);
  });

  it("CSV: separador ';', sin caché y corte avisado con X-Truncated y fila final", async () => {
    const semi = await app.inject({ method: "GET", url: "/v1/agreements/export.csv?sep=%3B", headers: H() });
    expect(semi.headers["cache-control"]).toBe("private, no-store");
    expect(semi.headers["x-truncated"]).toBeUndefined();
    expect(semi.body.startsWith("﻿id;titulo;estado;")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/agreements/export.csv?sep=x", headers: H() })).statusCode).toBe(400);

    await db.query(
      `INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title, owner_user_id)
       SELECT gen_random_uuid(), $1, 'external', $2, 'a.pdf', 'Masivo ' || g, $3 FROM generate_series(1, 10000) g`,
      [tenant, fileId, ownerId],
    );
    const big = await app.inject({ method: "GET", url: "/v1/agreements/export.csv", headers: H() });
    expect(big.headers["x-truncated"]).toBe("true");
    const lines = big.body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(1 + 10_000 + 1);
    expect(lines[lines.length - 1]).toContain("TRUNCADO");
    await db.query(`DELETE FROM agreements WHERE tenant_id = $1 AND title LIKE 'Masivo %'`, [tenant]);
  }, 60_000);
});

describe("reportes", () => {
  it("los meses se agrupan en la zona pedida (y UTC por defecto)", async () => {
    // 31/01 23:30 en Buenos Aires = 01/02 02:30 UTC.
    await db.query(
      `INSERT INTO envelopes (id, tenant_id, subject, status, created_by, created_at) VALUES ($1,$2,'Fin de mes','draft',$3,'2026-02-01T02:30:00Z')`,
      [util.uuidv7(), tenant, ownerId],
    );
    const range = `from=${encodeURIComponent("2026-01-01T03:00:00Z")}&to=${encodeURIComponent("2026-03-01T02:59:59Z")}`;
    const ba = await app.inject({ method: "GET", url: `/v1/reports/summary?${range}&tz=America/Argentina/Buenos_Aires`, headers: H() });
    expect(ba.statusCode).toBe(200);
    expect(ba.json().timeZone).toBe("America/Argentina/Buenos_Aires");
    expect(ba.json().byMonth.map((m: any) => m.month)).toEqual(["2026-01", "2026-02"]);
    expect(ba.json().byMonth.find((m: any) => m.month === "2026-01").created).toBe(1);
    expect(ba.json().totals.created).toBe(1);

    const utc = await app.inject({ method: "GET", url: `/v1/reports/summary?${range}`, headers: H() });
    expect(utc.json().timeZone).toBe("UTC");
    expect(utc.json().byMonth.map((m: any) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(utc.json().byMonth.find((m: any) => m.month === "2026-02").created).toBe(1);

    // Zona desconocida (p. ej. un navegador con tzdata más nueva que la del servidor): UTC, informado en timeZone.
    const bad = await app.inject({ method: "GET", url: `/v1/reports/summary?${range}&tz=Marte/Olimpo`, headers: H() });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().timeZone).toBe("UTC");
    expect(bad.json().byMonth.map((m: any) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    // Sin distinguir mayúsculas: devuelve el nombre canónico.
    const ci = await app.inject({ method: "GET", url: `/v1/reports/summary?${range}&tz=america/argentina/buenos_aires`, headers: H() });
    expect(ci.statusCode).toBe(200);
    expect(ci.json().timeZone).toBe("America/Argentina/Buenos_Aires");
    expect(ci.json().byMonth.find((m: any) => m.month === "2026-01").created).toBe(1);
  });

  it("sin 'from': el comienzo del mes cinco meses antes, en la zona pedida (al oeste de UTC)", async () => {
    const to = encodeURIComponent("2026-03-15T12:00:00Z");
    const ba = await app.inject({ method: "GET", url: `/v1/reports/summary?to=${to}&tz=America/Argentina/Buenos_Aires`, headers: H() });
    expect(ba.statusCode).toBe(200);
    // 1/10/2025 00:00 en Buenos Aires (UTC-3).
    expect(ba.json().from).toBe("2025-10-01T03:00:00.000Z");
    expect(ba.json().byMonth.map((m: any) => m.month)).toEqual(["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"]);
    const utc = await app.inject({ method: "GET", url: `/v1/reports/summary?to=${to}`, headers: H() });
    expect(utc.json().from).toBe("2025-10-01T00:00:00.000Z");
    expect(utc.json().byMonth).toHaveLength(6);
  });

  it("CSV de sobres: separador, columnas locales, sin corte y auditado", async () => {
    const range = `from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-03-01T00:00:00Z")}`;
    const r = await app.inject({ method: "GET", url: `/v1/reports/envelopes.csv?${range}&sep=%3B&tz=America/Argentina/Buenos_Aires`, headers: H() });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-truncated"]).toBeUndefined();
    const lines = r.body.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "﻿id;asunto;estado;origen;creado;enviado;completado;vence;remitente;correo_remitente;destinatarios;creado_local;enviado_local;completado_local;vence_local",
    );
    expect(lines[1]).toContain(";2026-01-31 23:30:00;");
    const audit = await db.one<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'reports.exported' ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(audit?.data).toMatchObject({ rows: 1, truncated: false });
    // Un solo registro por exportación (el del handler; el hook genérico de rutas ya no la duplica).
    const n = await db.one<any>(`SELECT count(*)::int AS n FROM account_audit_log WHERE tenant_id = $1 AND action = 'reports.exported'`, [tenant]);
    expect(n?.n).toBe(1);
  });

  it("CSV de sobres: más de 50.000 se corta con X-Truncated y fila final", async () => {
    await db.query(
      `INSERT INTO envelopes (id, tenant_id, subject, status, created_at)
       SELECT gen_random_uuid(), $1, 'Masivo', 'draft', '2025-06-01T00:00:00Z'::timestamptz + g * interval '1 second' FROM generate_series(1, 50000) g`,
      [tenant],
    );
    const range = `from=${encodeURIComponent("2025-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-03-01T00:00:00Z")}`;
    const r = await app.inject({ method: "GET", url: `/v1/reports/envelopes.csv?${range}`, headers: H() });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-truncated"]).toBe("true");
    const lines = r.body.trimEnd().split("\r\n");
    expect(lines).toHaveLength(1 + 50_000 + 1);
    expect(lines[lines.length - 1]).toContain("TRUNCADO");
    const audit = await db.one<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'reports.exported' ORDER BY id DESC LIMIT 1`,
      [tenant],
    );
    expect(audit?.data).toMatchObject({ rows: 50_000, truncated: true });
  }, 120_000);

  it("CSV de auditoría: separador y occurred_at_local", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/audit-log.csv?sep=semicolon&tz=UTC`, headers: H() });
    expect(r.statusCode).toBe(200);
    const head = r.body.split("\r\n")[0];
    expect(head).toBe("﻿id;occurred_at;action;actor_type;actor_id;actor_label;target_type;target_id;ip;user_agent;data;occurred_at_local");
  });

  it("CSV con zona desconocida: columnas locales en UTC (no 400) e informada en X-Time-Zone", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/audit-log.csv?tz=Marte/Olimpo`, headers: H() });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-time-zone"]).toBe("UTC");
    expect(r.body.split("\r\n")[0]).toContain("occurred_at_local");
    const range = `from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-03-01T00:00:00Z")}`;
    const e = await app.inject({ method: "GET", url: `/v1/reports/envelopes.csv?${range}&sep=%3B&tz=AMERICA/ARGENTINA/BUENOS_AIRES`, headers: H() });
    expect(e.statusCode).toBe(200);
    expect(e.headers["x-time-zone"]).toBe("America/Argentina/Buenos_Aires");
    expect(e.body).toContain(";2026-01-31 23:30:00;");
  });
});

describe("plantillas paginadas por cursor", () => {
  it("nextCursor recorre todas sin repetir; sin cursor, la primera página", async () => {
    for (const n of ["P1", "P2", "P3"]) {
      const c = await app.inject({ method: "POST", url: "/v1/templates", headers: H(), payload: { name: n } });
      expect(c.statusCode).toBe(201);
    }
    const all = await app.inject({ method: "GET", url: "/v1/templates", headers: H() });
    expect(all.json().items.map((x: any) => x.name)).toEqual(["P3", "P2", "P1"]);
    expect(all.json().nextCursor).toBeNull();
    const p1 = await app.inject({ method: "GET", url: "/v1/templates?limit=2", headers: H() });
    expect(p1.json().items.map((x: any) => x.name)).toEqual(["P3", "P2"]);
    expect(p1.json().nextCursor).toBeTruthy();
    const p2 = await app.inject({ method: "GET", url: `/v1/templates?limit=2&cursor=${p1.json().nextCursor}`, headers: H() });
    expect(p2.json().items.map((x: any) => x.name)).toEqual(["P1"]);
    expect(p2.json().nextCursor).toBeNull();
    const bad = await app.inject({ method: "GET", url: "/v1/templates?cursor=xx", headers: H() });
    expect(bad.statusCode).toBe(400);
  });
});

describe("historial de exportaciones a almacenamiento", () => {
  it("exige envelopes:view_all (lista asuntos de toda la organización)", async () => {
    const role = await app.inject({ method: "POST", url: "/v1/roles", headers: H(), payload: { name: "Ajustes", permissions: ["settings:manage"] } });
    expect(role.statusCode).toBe(201);
    const session = await newMember("ajustes@reportes.test", role.json().id);
    expect((await app.inject({ method: "GET", url: "/v1/storage/connections", headers: H(session) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/storage/exports", headers: H(session) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/storage/exports", headers: H() })).statusCode).toBe(200);
  });
});
