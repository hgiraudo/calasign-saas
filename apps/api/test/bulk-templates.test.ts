// Envío masivo contra plantillas reales (PGlite): edición de la plantilla bloqueada mientras un envío la usa,
// codificación del CSV, prellenado por etiqueta (solo campos prellenables, sin mayúsculas ni espacios), controles de la
// plantilla y del vencimiento al validar, teléfonos, idioma, columna Rol.whatsapp y números de línea del archivo.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-bulk-templates-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
let user: string;
const KEY = "cs_test_bulk_templates_key";
const auth = { authorization: `Bearer ${KEY}` };

/** Plantilla con un documento y un rol firmante "Cliente"; `fields`: [tipo, etiqueta, solo lectura con valor]. */
async function makeTemplate(name: string, fields: [string, string | null, string?][]) {
  const { uuidv7 } = await import("../src/lib/util");
  const tpl = uuidv7();
  const file = uuidv7();
  const doc = uuidv7();
  const role = uuidv7();
  await db.query(`INSERT INTO templates (id, tenant_id, name, created_by) VALUES ($1, $2, $3, $4)`, [tpl, tenant, name, user]);
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1, $2, 'original', 'x', 'application/pdf', 10, 'abc')`,
    [file, tenant],
  );
  await db.query(
    `INSERT INTO template_documents (id, tenant_id, template_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,0,'doc',$4,1,$5)`,
    [doc, tenant, tpl, file, JSON.stringify([{ width: 595, height: 842 }])],
  );
  await db.query(`INSERT INTO template_roles (id, tenant_id, template_id, name, role, routing_order) VALUES ($1,$2,$3,'Cliente','signer',1)`, [
    role,
    tenant,
    tpl,
  ]);
  const ids: string[] = [];
  for (const [type, label, ro] of fields) {
    const id = uuidv7();
    ids.push(id);
    await db.query(
      `INSERT INTO template_fields (id, tenant_id, template_id, document_id, role_id, type, page, x, y, width, height, required, label, value, read_only)
       VALUES ($1,$2,$3,$4,$5,$6,0,0.1,0.1,0.2,0.05,false,$7,$8,$9)`,
      [id, tenant, tpl, doc, role, type, label, ro ?? null, ro !== undefined],
    );
  }
  return { tpl, doc, role, fields: ids };
}

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
  user = uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, 'ana@x.com', 'Ana', 'x')`, [user]);
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

const validate = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/bulk-sends/validate", headers: auth, payload });

describe("plantilla en uso por un envío masivo", () => {
  it("roles, campos, documentos, asunto y borrado → 409 template_in_use_bulk mientras está en cola o en curso", async () => {
    const { uuidv7 } = await import("../src/lib/util");
    const t = await makeTemplate("En uso", [["signature", null]]);
    const bulk = uuidv7();
    await db.query(
      `INSERT INTO bulk_sends (id, tenant_id, template_id, template_name, status, total, options, actor, created_by) VALUES ($1,$2,$3,'En uso','running',1,'{}',$4,$5)`,
      [bulk, tenant, t.tpl, JSON.stringify({ type: "user", id: user, label: "Ana" }), user],
    );
    const calls = [
      {
        method: "PUT" as const,
        url: `/v1/templates/${t.tpl}/roles`,
        payload: { roles: [{ id: t.role, name: "Cliente", role: "signer", routingOrder: 1 }] },
      },
      { method: "PUT" as const, url: `/v1/templates/${t.tpl}/fields`, payload: { fields: [] } },
      { method: "DELETE" as const, url: `/v1/templates/${t.tpl}/documents/${t.doc}` },
      { method: "PATCH" as const, url: `/v1/templates/${t.tpl}`, payload: { subject: "Otro asunto" } },
      { method: "DELETE" as const, url: `/v1/templates/${t.tpl}` },
    ];
    for (const c of calls) {
      const r = await app.inject({ ...c, headers: auth });
      expect(r.statusCode, `${c.method} ${c.url}`).toBe(409);
      expect(r.json().error.code).toBe("template_in_use_bulk");
    }
    // El nombre no va en los sobres: se puede cambiar.
    expect((await app.inject({ method: "PATCH", url: `/v1/templates/${t.tpl}`, headers: auth, payload: { name: "Renombrada" } })).statusCode).toBe(
      200,
    );
    // Nada cambió.
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM template_fields WHERE template_id = $1`, [t.tpl]))!.n).toBe(1);
    // Terminado el envío, se puede editar.
    await db.query(`UPDATE bulk_sends SET status = 'completed' WHERE id = $1`, [bulk]);
    expect(
      (await app.inject({ method: "PATCH", url: `/v1/templates/${t.tpl}`, headers: auth, payload: { subject: "Otro asunto" } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/templates/${t.tpl}`, headers: auth })).statusCode).toBe(204);
  });

  it("un envío creado por la API bloquea la edición; el alta controla que la plantilla no cambió", async () => {
    const t = await makeTemplate("Alta", [
      ["signature", null],
      ["text", "Plan"],
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/v1/bulk-sends",
      headers: auth,
      payload: { templateId: t.tpl, csv: "Cliente.name,Cliente.email,field.plan\nAna,ana@x.com,Oro\n" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ status: "queued", total: 1, pending: 1 });
    const r = await app.inject({ method: "PUT", url: `/v1/templates/${t.tpl}/fields`, headers: auth, payload: { fields: [] } });
    expect(r.json().error.code).toBe("template_in_use_bulk");
  });

  it("loadTemplateForUse devuelve la versión leída (stamp)", async () => {
    const { loadTemplateForUse } = await import("../src/modules/templates");
    const t = await makeTemplate("Versión", [["signature", null]]);
    const l = await loadTemplateForUse(db, tenant, t.tpl);
    const v = await db.one<any>(`SELECT updated_at::text AS v FROM templates WHERE id = $1`, [t.tpl]);
    expect(l.stamp).toBe(v.v);
  });
});

describe("validación del envío masivo", () => {
  it("CSV con caracteres ilegibles (U+FFFD) → 422 csv_encoding con la línea", async () => {
    const t = await makeTemplate("Codificación", [["signature", null]]);
    const r = await validate({ templateId: t.tpl, csv: "Cliente.name,Cliente.email\nAna,ana@x.com\nJos�,jose@x.com\n" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("csv_encoding");
    expect(r.json().error.message).toMatch(/línea 3/);
  });

  it("CSV con saltos \\r solos (Mac clásico): filas y líneas distintas, el alta no choca; U+FFFD con la línea correcta", async () => {
    const t = await makeTemplate("Retorno de carro", [["signature", null]]);
    const csv = ["Cliente.name,Cliente.email", "Ana,ana@x.com", '"Bea\rGómez",bea@x.com', "Caro,caro@x", "Dani,dani@x.com"].join("\r");
    const v = await validate({ templateId: t.tpl, csv });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ total: 4, invalid: 1 });
    expect(v.json().errors).toMatchObject([{ row: 3, line: 5 }]);
    const created = await app.inject({
      method: "POST",
      url: "/v1/bulk-sends",
      headers: auth,
      payload: { templateId: t.tpl, csv, skipInvalid: true },
    });
    expect(created.statusCode).toBe(201);
    const items = await db.query<any>(`SELECT row_number, line_number FROM bulk_send_items WHERE bulk_send_id = $1 ORDER BY row_number`, [
      created.json().id,
    ]);
    expect(items.map((i) => [i.row_number, i.line_number])).toEqual([
      [1, 2],
      [2, 3],
      [3, 5],
      [4, 6],
    ]);
    const res = await app.inject({ method: "GET", url: `/v1/bulk-sends/${created.json().id}/results.csv`, headers: auth });
    const out = res.body.replace(/^\uFEFF/, "").split("\r\n");
    expect(out[0]).toBe("row,status,envelopeId,recipients,error,line");
    expect(out[3]).toMatch(/^3,failed,.*,5$/);
    const { assertCsvEncoding } = await import("../src/modules/bulk");
    expect(() => assertCsvEncoding("a\rb\r\nc\nJos\uFFFD")).toThrow(/línea 4/);
  });

  it("plantilla con un firmante sin campo de firma → 422 template_not_sendable; vencimiento pasado → 400", async () => {
    const t = await makeTemplate("Sin firma", [["text", "Plan"]]);
    const r = await validate({ templateId: t.tpl, csv: "Cliente.name,Cliente.email\nAna,ana@x.com\n" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("template_not_sendable");
    const ok = await makeTemplate("Con firma", [["signature", null]]);
    const past = await validate({
      templateId: ok.tpl,
      csv: "Cliente.name,Cliente.email\nAna,ana@x.com\n",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.code).toBe("invalid_expiry");
    // Y no se crea nada.
    const create = await app.inject({
      method: "POST",
      url: "/v1/bulk-sends",
      headers: auth,
      payload: { templateId: t.tpl, csv: "Cliente.name,Cliente.email\nAna,ana@x.com\n" },
    });
    expect(create.json().error.code).toBe("template_not_sendable");
  });

  it("teléfonos con separadores se normalizan; solo dígitos → error propio; idioma sin mayúsculas; Rol.whatsapp agrega el canal; filas por línea del archivo", async () => {
    const t = await makeTemplate("Datos", [["signature", null]]);
    const csv = [
      "Cliente.name,Cliente.email,Cliente.whatsapp,Cliente.locale",
      "Ana,ana@x.com,+54 9 (11) 2345-6789,PT-br",
      "",
      '"Bea',
      'Gómez",bea@x.com,5491123456789,EN',
      "Caro,caro@x.com,0054.911.2345.6789,xx",
    ].join("\r\n");
    const r = await validate({ templateId: t.tpl, csv });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total).toBe(3);
    // `row`: número de fila de datos (Bea es la 2ª, Caro la 3ª). `line`: la de Bea empieza en la línea 4 del archivo
    // (hay una vacía antes y su nombre ocupa dos líneas); la de Caro, en la 6.
    expect(body.errors.map((e: any) => e.row)).toEqual([2, 3]);
    expect(body.errors.map((e: any) => e.line)).toEqual([4, 6]);
    expect(body.errors[0].errors.join()).toMatch(/Cliente\.phone: falta el código de país/);
    expect(body.errors[1].errors.join()).toMatch(/Cliente\.locale/);
    expect(body.errors[1].errors.join()).not.toMatch(/phone/);

    const { csvToRows, normalizePhone } = await import("../src/modules/bulk");
    expect(normalizePhone("+54 9 (11) 2345-6789")).toBe("+5491123456789");
    expect(normalizePhone("0054.911.2345.6789")).toBe("+5491123456789");
    const rows = csvToRows(csv, [{ id: t.role, name: "Cliente" }]).rows;
    expect(rows[0].recipients[0]).toMatchObject({ locale: "pt-BR", channels: ["email", "whatsapp"], phone: "+54 9 (11) 2345-6789" });
    expect(rows[1].recipients[0]).toMatchObject({ locale: "en" });
    // Con columna de canales, se suma WhatsApp a los indicados.
    const withChannels = csvToRows("Cliente.email,Cliente.channels,Cliente.whatsapp\na@x.com,telegram,+5491123456789\n", [
      { id: t.role, name: "Cliente" },
    ]).rows;
    expect(withChannels[0].recipients[0].channels).toEqual(["telegram", "whatsapp"]);
  });
});

describe("columnas del CSV", () => {
  it("un rol llamado Campo/Field gana sobre el prefijo de campo; el apóstrofo inicial del encabezado se ignora", async () => {
    const { csvToRows } = await import("../src/modules/bulk");
    const roles = [{ id: "r1", name: "Campo" }];
    const r = csvToRows("Campo.email,campo.Plan,'subject\na@x.com,Oro,Hola\n", roles);
    expect(r.fileErrors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ recipients: [{ roleId: "r1", email: "a@x.com" }], prefill: { Plan: "Oro" }, subject: "Hola" });
    const q = csvToRows("'Cliente.email\na@x.com\n", [{ id: "r2", name: " Cliente " }]);
    expect(q.fileErrors).toEqual([]);
    expect(q.rows[0].recipients[0]).toMatchObject({ roleId: "r2", email: "a@x.com" });
    // field.Plan y campo. plan son el mismo campo.
    expect(csvToRows("field.Plan,campo. plan \nx,y\n", []).fileErrors[0]).toMatch(/mismo dato/);
  });
});

describe("prellenado por etiqueta", () => {
  const field = (id: string, type: string, label: string | null, extra: Record<string, unknown> = {}) =>
    ({
      id,
      documentId: "d",
      roleId: "r",
      type,
      page: 0,
      x: 0,
      y: 0,
      width: 0.1,
      height: 0.1,
      required: false,
      label,
      value: null,
      readOnly: false,
      options: null,
      min: null,
      max: null,
      conditions: null,
      formula: null,
      ...extra,
    }) as any;
  const loaded = (fields: any[]) =>
    ({
      tpl: { template: { id: "t" }, roles: [{ id: "r", name: "Cliente", role: "signer", routingOrder: 1 }], fields, documents: [] },
      row: {},
      docs: [],
    }) as any;
  const input = (prefill: Record<string, string>) =>
    ({ templateId: "t", recipients: [{ roleId: "r", name: "Ana", email: "a@x.com" }], prefill }) as any;

  it("solo campos prellenables (editables, sin fórmula, tipo con valor); sin mayúsculas ni espacios", async () => {
    const { planFromTemplate } = await import("../src/modules/templates");
    const l = loaded([
      field("f1", "text", "Plan"),
      field("f2", "checkbox", "plan"),
      field("f3", "text", " PLAN ", { readOnly: true, value: "Fijo" }),
      field("f4", "number", "Plan", { formula: "{A}+1" }),
      field("f5", "text", "Nombre"),
      field("f6", "text", "nombre"),
    ]);
    const p = planFromTemplate(l, input({ "  plan ": "Oro", NOMBRE: "Ana" }));
    expect(p.values.get("f1")).toBe("Oro");
    expect(p.values.get("f2")).toBeNull();
    expect(p.values.get("f3")).toBe("Fijo");
    expect(p.values.get("f4")).toBeNull();
    // Dos campos cuya etiqueta difiere solo en mayúsculas: el mismo grupo, se completan los dos.
    expect([p.values.get("f5"), p.values.get("f6")]).toEqual(["Ana", "Ana"]);
    // Solo campos que no se pueden prellenar con esa etiqueta → error; ninguno → unknown_prefill.
    expect(() => planFromTemplate(loaded([field("g1", "checkbox", "Acepto")]), input({ acepto: "x" }))).toThrow(/no se puede prellenar/);
    expect(() => planFromTemplate(l, input({ Otro: "x" }))).toThrow(/No hay ningún campo/);
    // Dos claves para el mismo campo con valores distintos → error.
    expect(() => planFromTemplate(l, input({ Plan: "Oro", "plan ": "Plata" }))).toThrow(/mismo campo/);
  });

  it("csvSkeleton: una columna por etiqueta (sin mayúsculas) y solo si algún campo con ella es prellenable", async () => {
    const { csvSkeleton } = await import("../src/modules/bulk");
    const tpl = {
      template: { name: "T", subject: null },
      roles: [{ id: "r", name: "Cliente" }],
      fields: [field("f1", "checkbox", "Plan"), field("f2", "text", "plan "), field("f3", "text", "PLAN"), field("f4", "checkbox", "Acepto")],
    } as any;
    const header = csvSkeleton(tpl).split("\r\n")[0];
    expect(header.match(/field\./gi)).toHaveLength(1);
    expect(header).toContain("field.plan");
    expect(header).not.toContain("Acepto");
  });
});

describe("plantilla que no se deja leer entera y errores del momento", () => {
  /** La base, pero el sello de la plantilla cambia en cada lectura (una edición tras otra) o una consulta da 40001. */
  const flaky = (mode: "stamp" | "serialization") => {
    let n = 0;
    return new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "one" && mode === "stamp")
          return async (sql: string, params?: unknown[]) =>
            /^SELECT updated_at::text AS v FROM templates WHERE id = \$1 AND tenant_id = \$2$/.test(sql)
              ? { v: `v${n++}` }
              : target.one(sql, params as any);
        if (prop === "query" && mode === "serialization")
          return async (sql: string, params?: unknown[]) => {
            if (/FROM bulk_sends WHERE tenant_id/.test(sql)) throw Object.assign(new Error("could not serialize access"), { code: "40001" });
            return target.query(sql, params as any);
          };
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
  };

  it("loadTemplateForUse → 503 template_busy con Retry-After; el envío masivo lo trata como del momento", async () => {
    const { loadTemplateForUse } = await import("../src/modules/templates");
    const { isTransientError } = await import("../src/modules/bulk");
    const t = await makeTemplate("Ocupada", [["signature", null]]);
    const err = await loadTemplateForUse(flaky("stamp"), tenant, t.tpl).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "template_busy" });
    expect(isTransientError(err)).toBe(true);

    const { createBlobStore } = await import("../src/infra/storage");
    const { buildApp } = await import("../src/app");
    for (const [mode, code, retry] of [
      ["stamp", "template_busy", "2"],
      ["serialization", "concurrent_update", "1"],
    ] as const) {
      const other = await buildApp({ db: flaky(mode), blobs: createBlobStore(), logger: false });
      await other.ready();
      try {
        const r =
          mode === "stamp"
            ? await other.inject({
                method: "POST",
                url: "/v1/bulk-sends/validate",
                headers: auth,
                payload: { templateId: t.tpl, csv: "Cliente.name,Cliente.email\nAna,ana@x.com\n" },
              })
            : await other.inject({ method: "GET", url: "/v1/bulk-sends", headers: auth });
        expect(r.statusCode, mode).toBe(503);
        expect(r.json().error.code).toBe(code);
        expect(r.headers["retry-after"]).toBe(retry);
      } finally {
        await other.close();
      }
    }
  });

  it("filas fallidas: datos o plantilla → no reintentables; el resto de los AppError (proveedor, configuración) → reintentables", async () => {
    const { bulkRowRetryable } = await import("../src/modules/bulk");
    const { AppError, badRequest } = await import("../src/lib/errors");
    const { ZodError } = await import("zod");
    for (const code of [
      "validation_error",
      "unknown_prefill",
      "readonly_field",
      "duplicate_prefill",
      "roles_missing",
      "template_deleted",
      "template_not_sendable",
      "invalid_expiry",
    ])
      expect(bulkRowRetryable(badRequest(code, "x")), code).toBe(false);
    expect(bulkRowRetryable(new ZodError([]))).toBe(false);
    for (const code of ["identity_provider_unavailable", "provider_not_configured", "plan_limit", "forbidden"])
      expect(bulkRowRetryable(new AppError(409, code, "x")), code).toBe(true);
    expect(bulkRowRetryable(new Error("boom"))).toBe(true);
    expect(bulkRowRetryable(new AppError(409, "bulk_unavailable", "x"), false)).toBe(false);
    expect(bulkRowRetryable(new AppError(409, "bulk_unavailable", "x"), true)).toBe(true);
  });
});
