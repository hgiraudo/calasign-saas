// Recorrido del remitente sobre PGlite: editar una plantilla no rompe formularios web activos (409 template_has_forms),
// el envío público no expone el detalle de una mala configuración, clonado con includeValues y plantilla desde un
// borrador (solo valores prellenables), cobro con X-Expected-Updated-At, expiresAt null (sin vencimiento) y búsqueda
// con % y _ literales.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-sender-flow-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
let uuid: () => string;
const KEY = "cs_test_sender_flow_key";
const auth = { authorization: `Bearer ${KEY}` };
const stale = "2000-01-01T00:00:00.000Z";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { sha256Hex, uuidv7 } = await import("../src/lib/util");
  uuid = uuidv7;
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
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

async function newFile() {
  const id = uuid();
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1, $2, 'original', 'x', 'application/pdf', 10, 'abc')`,
    [id, tenant],
  );
  return id;
}

const box = (y: number) => ({ page: 0, x: 0.1, y, width: 0.2, height: 0.05 });

/** Plantilla con un documento, un rol firmante "Cliente" (firma + texto "Plan") y un formulario activo que prellena Plan. */
async function templateWithForm(name: string) {
  const c = await app.inject({ method: "POST", url: "/v1/templates", headers: auth, payload: { name } });
  expect(c.statusCode).toBe(201);
  const tpl = c.json().template.id as string;
  const doc = uuid();
  await db.query(
    `INSERT INTO template_documents (id, tenant_id, template_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,0,'doc',$4,1,$5)`,
    [doc, tenant, tpl, await newFile(), JSON.stringify([{ width: 595, height: 842 }])],
  );
  const role = uuid();
  const r = await app.inject({
    method: "PUT",
    url: `/v1/templates/${tpl}/roles`,
    headers: auth,
    payload: { roles: [{ id: role, name: "Cliente", role: "signer", routingOrder: 1 }] },
  });
  expect(r.statusCode).toBe(200);
  const fields = [
    { id: uuid(), documentId: doc, roleId: role, type: "signature", ...box(0.1) },
    { id: uuid(), documentId: doc, roleId: role, type: "text", label: "Plan", required: false, ...box(0.3) },
  ];
  const f = await app.inject({ method: "PUT", url: `/v1/templates/${tpl}/fields`, headers: auth, payload: { fields } });
  expect(f.statusCode).toBe(200);
  const w = await app.inject({
    method: "POST",
    url: "/v1/web-forms",
    headers: auth,
    payload: { templateId: tpl, name: `Form ${name}`, signerRoleId: role, prefill: { Plan: "Oro" } },
  });
  expect(w.statusCode).toBe(201);
  return { tpl, doc, role, fields, form: w.json() as { id: string; slug: string; name: string } };
}

describe("plantilla con formularios web activos", () => {
  it("PUT roles: pasar a copia el rol de quien completa el formulario → 409 template_has_forms con el formulario", async () => {
    const t = await templateWithForm("roles");
    const r = await app.inject({
      method: "PUT",
      url: `/v1/templates/${t.tpl}/roles`,
      headers: auth,
      payload: { roles: [{ id: t.role, name: "Cliente", role: "cc", routingOrder: 1 }] },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("template_has_forms");
    expect(r.json().error.details.forms).toEqual([{ id: t.form.id, name: t.form.name }]);
    // No se tocó nada (la transacción se revirtió).
    expect((await db.one<any>(`SELECT role FROM template_roles WHERE id = $1`, [t.role])).role).toBe("signer");
    // Agregar otro firmante sin firma también rompe el envío del formulario (firmante sin campo de firma).
    const extra = await app.inject({
      method: "PUT",
      url: `/v1/templates/${t.tpl}/roles`,
      headers: auth,
      payload: {
        roles: [
          { id: t.role, name: "Cliente", role: "signer", routingOrder: 1 },
          { name: "Garante", role: "signer", routingOrder: 2 },
        ],
      },
    });
    expect(extra.statusCode).toBe(409);
    // Con el formulario desactivado, el cambio pasa.
    await app.inject({ method: "PATCH", url: `/v1/web-forms/${t.form.id}`, headers: auth, payload: { active: false } });
    const ok = await app.inject({
      method: "PUT",
      url: `/v1/templates/${t.tpl}/roles`,
      headers: auth,
      payload: { roles: [{ id: t.role, name: "Cliente", role: "cc", routingOrder: 1 }] },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("PUT fields: quitar la firma o el campo prellenado → 409; un formulario que ya estaba roto no bloquea", async () => {
    const t = await templateWithForm("fields");
    const noSig = await app.inject({ method: "PUT", url: `/v1/templates/${t.tpl}/fields`, headers: auth, payload: { fields: [t.fields[1]] } });
    expect(noSig.statusCode).toBe(409);
    expect(noSig.json().error.details.forms).toEqual([{ id: t.form.id, name: t.form.name }]);
    const noPlan = await app.inject({ method: "PUT", url: `/v1/templates/${t.tpl}/fields`, headers: auth, payload: { fields: [t.fields[0]] } });
    expect(noPlan.statusCode).toBe(409);
    // Mover un campo (sin romper nada) pasa.
    const moved = await app.inject({
      method: "PUT",
      url: `/v1/templates/${t.tpl}/fields`,
      headers: auth,
      payload: { fields: [t.fields[0], { ...t.fields[1], y: 0.5 }] },
    });
    expect(moved.statusCode).toBe(200);
    // El formulario ya roto (prellena un campo que no existe): editar la plantilla no queda bloqueado por él.
    await db.query(`UPDATE web_forms SET prefill = '{"Otro":"x"}'::jsonb WHERE id = $1`, [t.form.id]);
    const again = await app.inject({ method: "PUT", url: `/v1/templates/${t.tpl}/fields`, headers: auth, payload: { fields: [t.fields[0]] } });
    expect(again.statusCode).toBe(200);
  });

  it("PUT roles en dos pasos: copia → firmante no bloquea (la firma la pide PUT fields); un rol nuevo pide solo desactivarlo", async () => {
    const t = await templateWithForm("two-step");
    const roles = (extra: object) => ({ roles: [{ id: t.role, name: "Cliente", role: "signer", routingOrder: 1 }, extra] });
    // Rol nuevo: el formulario no tiene destinatario para él (y no se puede ajustar antes): 409 que pide desactivarlo.
    const copia = uuid();
    const add = await app.inject({
      method: "PUT",
      url: `/v1/templates/${t.tpl}/roles`,
      headers: auth,
      payload: roles({ id: copia, name: "Copia", role: "cc", routingOrder: 2 }),
    });
    expect(add.statusCode).toBe(409);
    expect(add.json().error.message).toMatch(/quien lo creó o un administrador tiene que desactivarlo antes/);
    expect(add.json().error.message).not.toMatch(/ajustar/);
    // Con el formulario desactivado se agrega la copia, se le pone destinatario fijo y se reactiva.
    await app.inject({ method: "PATCH", url: `/v1/web-forms/${t.form.id}`, headers: auth, payload: { active: false } });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/templates/${t.tpl}/roles`,
          headers: auth,
          payload: roles({ id: copia, name: "Copia", role: "cc", routingOrder: 2 }),
        })
      ).statusCode,
    ).toBe(200);
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/web-forms/${t.form.id}`,
      headers: auth,
      payload: { active: true, fixedRecipients: [{ roleId: copia, name: "Copia", email: "copia@x.test" }] },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    // La copia pasa a firmante (todavía sin campo de firma): pasa; el campo se agrega después en PUT fields.
    const toSigner = await app.inject({
      method: "PUT",
      url: `/v1/templates/${t.tpl}/roles`,
      headers: auth,
      payload: roles({ id: copia, name: "Copia", role: "signer", routingOrder: 2 }),
    });
    expect(toSigner.statusCode, toSigner.body).toBe(200);
    const withSig = await app.inject({
      method: "PUT",
      url: `/v1/templates/${t.tpl}/fields`,
      headers: auth,
      payload: { fields: [...t.fields, { id: uuid(), documentId: t.doc, roleId: copia, type: "signature", ...box(0.7) }] },
    });
    expect(withSig.statusCode).toBe(200);
    // Ya funcionando, quitarle la firma en PUT fields sí rompe el formulario.
    const noSig = await app.inject({ method: "PUT", url: `/v1/templates/${t.tpl}/fields`, headers: auth, payload: { fields: t.fields } });
    expect(noSig.statusCode).toBe(409);
    expect(noSig.json().error.message).toMatch(/desactivarlo o ajustarlo antes/);
  });

  it("solo bloquean los formularios que reciben envíos (no vencidos ni agotados)", async () => {
    const cc = (t: { role: string }) => ({ roles: [{ id: t.role, name: "Cliente", role: "cc", routingOrder: 1 }] });
    const expired = await templateWithForm("expired");
    await db.query(`UPDATE web_forms SET expires_at = now() - interval '1 day' WHERE id = $1`, [expired.form.id]);
    expect((await app.inject({ method: "PUT", url: `/v1/templates/${expired.tpl}/roles`, headers: auth, payload: cc(expired) })).statusCode).toBe(
      200,
    );
    const used = await templateWithForm("used");
    await db.query(`UPDATE web_forms SET max_uses = 2, uses = 2 WHERE id = $1`, [used.form.id]);
    expect((await app.inject({ method: "PUT", url: `/v1/templates/${used.tpl}/roles`, headers: auth, payload: cc(used) })).statusCode).toBe(200);
    // Con usos disponibles sí bloquea.
    const left = await templateWithForm("left");
    await db.query(`UPDATE web_forms SET max_uses = 3, uses = 2 WHERE id = $1`, [left.form.id]);
    expect((await app.inject({ method: "PUT", url: `/v1/templates/${left.tpl}/roles`, headers: auth, payload: cc(left) })).statusCode).toBe(409);
  });

  it("DELETE de un documento de la plantilla que rompe un formulario activo → 409", async () => {
    const t = await templateWithForm("doc-delete");
    const del = () => app.inject({ method: "DELETE", url: `/v1/templates/${t.tpl}/documents/${t.doc}`, headers: auth });
    const r = await del();
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("template_has_forms");
    expect(await db.one(`SELECT 1 FROM template_documents WHERE id = $1`, [t.doc])).toBeTruthy();
    await app.inject({ method: "PATCH", url: `/v1/web-forms/${t.form.id}`, headers: auth, payload: { active: false } });
    expect((await del()).statusCode).toBe(204);
  });

  it("envío público con la plantilla rota: no disponible, sin el detalle de la configuración", async () => {
    const { encrypt } = await import("../src/lib/util");
    const submit = (slug: string) =>
      app.inject({
        method: "POST",
        url: `/v1/public/forms/${slug}/submit`,
        payload: {
          name: "Ana",
          email: `ana${Math.random()}@x.test`,
          formToken: encrypt(JSON.stringify({ s: slug, t: Date.now() - 5000, n: Math.random() })),
        },
      });
    // Firma borrada directo en la base (p. ej. una plantilla vieja): el formulario figura no disponible.
    const t = await templateWithForm("submit");
    await db.query(`DELETE FROM template_fields WHERE template_id = $1 AND type = 'signature'`, [t.tpl]);
    const r = await submit(t.form.slug);
    expect(r.statusCode).toBe(410);
    expect(JSON.stringify(r.json())).not.toMatch(/firma/);
    const g = await app.inject({ method: "GET", url: `/v1/web-forms/${t.form.id}`, headers: auth });
    expect(JSON.stringify(g.json())).toMatch(/misconfigured/);
    // Lo que solo detecta el envío (demasiados campos de adjunto): 409 form_misconfigured genérico, no envelope_incomplete.
    const t2 = await templateWithForm("submit2");
    for (let i = 0; i < 21; i++) {
      await db.query(
        `INSERT INTO template_fields (id, tenant_id, template_id, document_id, role_id, type, page, x, y, width, height, required) VALUES ($1,$2,$3,$4,$5,'attachment',0,0.5,0.1,0.1,0.02,false)`,
        [uuid(), tenant, t2.tpl, t2.doc, t2.role],
      );
    }
    const r2 = await submit(t2.form.slug);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toEqual({ code: "form_misconfigured", message: "Este formulario no está disponible" });
  });
});

/** Borrador con un documento, un firmante y campos de varios tipos (valores como si los hubieran completado). */
async function draftWithValues() {
  const e = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "Contrato" } });
  const id = e.json().envelope.id as string;
  const doc = uuid();
  await db.query(
    `INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,0,'d.pdf',$4,1,$5)`,
    [doc, tenant, id, await newFile(), JSON.stringify([{ width: 595, height: 842 }])],
  );
  const rid = uuid();
  const r = await app.inject({
    method: "PUT",
    url: `/v1/envelopes/${id}/recipients`,
    headers: auth,
    payload: { recipients: [{ id: rid, name: "Ana", email: "ana@x.test" }] },
  });
  expect(r.statusCode).toBe(200);
  const f = await app.inject({
    method: "PUT",
    url: `/v1/envelopes/${id}/fields`,
    headers: auth,
    payload: {
      fields: [
        { documentId: doc, recipientId: rid, type: "signature", ...box(0.1) },
        { documentId: doc, recipientId: rid, type: "text", label: "Empresa", value: "ACME", required: false, ...box(0.2) },
        { documentId: doc, recipientId: rid, type: "checkbox", label: "Acepto", required: false, ...box(0.3) },
        { documentId: doc, recipientId: rid, type: "name", label: "Nombre", required: false, ...box(0.4) },
      ],
    },
  });
  expect(f.statusCode, f.body).toBe(200);
  // Lo que "escribió" el firmante en tipos que el remitente no puede prellenar.
  await db.query(`UPDATE fields SET value = 'true' WHERE envelope_id = $1 AND label = 'Acepto'`, [id]);
  await db.query(`UPDATE fields SET value = 'Ana Pérez' WHERE envelope_id = $1 AND label = 'Nombre'`, [id]);
  return id;
}

describe("valores al clonar y al guardar como plantilla", () => {
  it("clone con includeValues copia solo los tipos prellenables (el borrador se puede volver a guardar)", async () => {
    const id = await draftWithValues();
    const c = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/clone`, headers: auth, payload: { includeValues: true } });
    expect(c.statusCode).toBe(201);
    const vals = Object.fromEntries(
      c
        .json()
        .fields.filter((f: any) => f.label)
        .map((f: any) => [f.label, f.value]),
    );
    expect(vals).toEqual({ Empresa: "ACME", Acepto: null, Nombre: null });
    // Los campos del clon se guardan tal cual (antes: "el tipo checkbox no admite valor prellenado").
    const put = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${c.json().envelope.id}/fields`,
      headers: auth,
      payload: { fields: c.json().fields },
    });
    expect(put.statusCode).toBe(200);
  });

  it("plantilla desde un borrador conserva lo prellenado aunque no sea de solo lectura", async () => {
    const id = await draftWithValues();
    const t = await app.inject({ method: "POST", url: `/v1/templates/from-envelope/${id}`, headers: auth, payload: { name: "Desde borrador" } });
    expect(t.statusCode).toBe(201);
    const vals = Object.fromEntries(
      t
        .json()
        .fields.filter((f: any) => f.label)
        .map((f: any) => [f.label, f.value]),
    );
    expect(vals).toEqual({ Empresa: "ACME", Acepto: null, Nombre: null });
    // Enviado, lo no fijado de solo lectura no se lleva (puede ser lo que escribió un firmante).
    await db.query(`UPDATE envelopes SET status = 'sent' WHERE id = $1`, [id]);
    const t2 = await app.inject({ method: "POST", url: `/v1/templates/from-envelope/${id}`, headers: auth, payload: { name: "Desde enviado" } });
    expect(t2.json().fields.find((f: any) => f.label === "Empresa").value).toBeNull();
  });
});

describe("cobro con X-Expected-Updated-At", () => {
  it("PUT y DELETE: 409 si el borrador cambió; si no, cambian el updatedAt del sobre y lo devuelven", async () => {
    const e = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "Con cobro" } });
    const id = e.json().envelope.id as string;
    const rid = uuid();
    const r = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${id}/recipients`,
      headers: auth,
      payload: { recipients: [{ id: rid, name: "Ana", email: "ana@x.test" }] },
    });
    const v0 = r.json().envelope.updatedAt as string;
    const body = { amount: 10, currency: "BRL", description: "Tasa", payerRecipientId: rid, provider: "mock" };
    const bad = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${id}/payment`,
      headers: { ...auth, "x-expected-updated-at": stale },
      payload: body,
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("version_changed");
    const ok = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${id}/payment`,
      headers: { ...auth, "x-expected-updated-at": v0 },
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    const v1 = ok.json().envelopeUpdatedAt as string;
    expect(v1 > v0).toBe(true);
    const detail = await app.inject({ method: "GET", url: `/v1/envelopes/${id}`, headers: auth });
    expect(detail.json().envelope.updatedAt).toBe(v1);
    // Con la versión vieja (antes del cobro), quitarlo da 409; con la nueva, 200 sin cobro y otra versión.
    const badDel = await app.inject({ method: "DELETE", url: `/v1/envelopes/${id}/payment`, headers: { ...auth, "x-expected-updated-at": v0 } });
    expect(badDel.statusCode).toBe(409);
    const del = await app.inject({ method: "DELETE", url: `/v1/envelopes/${id}/payment`, headers: { ...auth, "x-expected-updated-at": v1 } });
    expect(del.statusCode).toBe(200);
    expect(del.json().payment).toBeNull();
    expect(del.json().envelopeUpdatedAt > v1).toBe(true);
  });
});

describe("cobro: quitar sin cobro", () => {
  it("DELETE sin cobro configurado no controla la versión (no hay nada que pisar)", async () => {
    const e = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "Sin cobro" } });
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/envelopes/${e.json().envelope.id}/payment`,
      headers: { ...auth, "x-expected-updated-at": stale },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().payment).toBeNull();
  });
});

describe("destinatario solo Telegram", () => {
  it("sin telegramChatId: 400 si no está vinculado; si ya lo está (mismo id), se guarda y conserva el chat", async () => {
    const e = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "Telegram" } });
    const id = e.json().envelope.id as string;
    const rid = uuid();
    const put = (r: object) =>
      app.inject({
        method: "PUT",
        url: `/v1/envelopes/${id}/recipients`,
        headers: auth,
        payload: { recipients: [{ id: rid, name: "Ana", email: "ana@x.test", ...r }] },
      });
    expect((await put({})).statusCode).toBe(200);
    const bad = await put({ channels: ["telegram"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");
    expect(bad.json().error.message).toMatch(/telegramChatId/);
    await db.query(`UPDATE recipients SET telegram_chat_id = '12345' WHERE id = $1`, [rid]);
    const ok = await put({ channels: ["telegram"] });
    expect(ok.statusCode, ok.body).toBe(200);
    const row = await db.one<any>(`SELECT channels, telegram_chat_id FROM recipients WHERE id = $1`, [rid]);
    expect(row).toEqual({ channels: ["telegram"], telegram_chat_id: "12345" });
    // Otro destinatario nuevo solo Telegram sin chat sigue rechazado.
    const other = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${id}/recipients`,
      headers: auth,
      payload: {
        recipients: [
          { id: rid, name: "Ana", email: "ana@x.test", channels: ["telegram"] },
          { name: "Beto", email: "b@x.test", channels: ["telegram"] },
        ],
      },
    });
    expect(other.statusCode).toBe(400);
  });
});

describe("expiresAt: ausente = 30 días, null = sin vencimiento", () => {
  it("alta en un paso, desde plantilla y clonado", async () => {
    const days = (iso: string | null) => (iso ? Math.round((Date.parse(iso) - Date.now()) / 86400_000) : null);
    const a = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "A" } });
    expect(days(a.json().envelope.expiresAt)).toBe(30);
    const b = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject: "B", expiresAt: null } });
    expect(b.json().envelope.expiresAt).toBeNull();
    const cl = await app.inject({ method: "POST", url: `/v1/envelopes/${a.json().envelope.id}/clone`, headers: auth, payload: { expiresAt: null } });
    expect(cl.statusCode).toBe(201);
    expect(cl.json().envelope.expiresAt).toBeNull();
    const cl30 = await app.inject({ method: "POST", url: `/v1/envelopes/${a.json().envelope.id}/clone`, headers: auth, payload: {} });
    expect(days(cl30.json().envelope.expiresAt)).toBe(30);
    const t = await templateWithForm("expiry");
    const recipients = [{ roleId: t.role, name: "Ana", email: "ana@x.test" }];
    const ft = await app.inject({
      method: "POST",
      url: "/v1/envelopes/from-template",
      headers: auth,
      payload: { templateId: t.tpl, recipients, expiresAt: null },
    });
    expect(ft.statusCode).toBe(201);
    expect(ft.json().envelope.expiresAt).toBeNull();
    const ft30 = await app.inject({ method: "POST", url: "/v1/envelopes/from-template", headers: auth, payload: { templateId: t.tpl, recipients } });
    expect(days(ft30.json().envelope.expiresAt)).toBe(30);
  });
});

describe("plantilla con firma con certificado que corresponda al documento", () => {
  it("el sobre nace con el requisito del rol; al enviar se baja (con la marca) solo si falta el documento", async () => {
    const t = await templateWithForm("certsign-id-match");
    await db.query(`UPDATE template_roles SET signature_type = 'certificate', certificate_requirements = $2 WHERE id = $1`, [
      t.role,
      JSON.stringify({ matchIdDocument: true, allowedIssuers: [], requireQualified: false }),
    ]);
    const reqs = async (env: string) =>
      (await db.one<any>(`SELECT certificate_requirements AS r FROM recipients WHERE envelope_id = $1 AND role = 'signer'`, [env])).r;
    const create = async (idDocumentNumber?: string) => {
      const r = await app.inject({
        method: "POST",
        url: "/v1/envelopes/from-template",
        headers: auth,
        payload: {
          templateId: t.tpl,
          recipients: [{ roleId: t.role, name: "Ana", email: "ana@x.test", ...(idDocumentNumber ? { idDocumentNumber } : {}) }],
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().envelope.id as string;
    };
    const send = async (env: string) => {
      const r = await app.inject({ method: "POST", url: `/v1/envelopes/${env}/send`, headers: auth, payload: {} });
      expect(r.statusCode, r.body).toBe(200);
    };
    // Sin documento: el borrador conserva el pedido (el remitente todavía puede cargar el documento); al enviar se baja.
    const sin = await create();
    expect(await reqs(sin)).toEqual({ matchIdDocument: true, allowedIssuers: [], requireQualified: false });
    await send(sin);
    expect(await reqs(sin)).toMatchObject({ matchIdDocument: false, idDocumentMatchSkipped: true });
    // Con documento se conserva al crear y al enviar.
    const con = await create("30111222");
    await send(con);
    expect(await reqs(con)).toEqual({ matchIdDocument: true, allowedIssuers: [], requireQualified: false });
  });
});

describe("búsqueda con comodines literales", () => {
  it("% y _ se buscan como texto en sobres y plantillas", async () => {
    for (const subject of ["Descuento 50% marzo", "Descuento 50 marzo", "Plan a_b", "Plan axb"]) {
      await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject } });
      await app.inject({ method: "POST", url: "/v1/templates", headers: auth, payload: { name: subject } });
    }
    const envs = async (q: string) =>
      (await app.inject({ method: "GET", url: `/v1/envelopes?q=${encodeURIComponent(q)}`, headers: auth }))
        .json()
        .items.map((e: any) => e.subject)
        .sort();
    const tpls = async (q: string) =>
      (await app.inject({ method: "GET", url: `/v1/templates?q=${encodeURIComponent(q)}`, headers: auth }))
        .json()
        .items.map((e: any) => e.name)
        .sort();
    expect(await envs("50%")).toEqual(["Descuento 50% marzo"]);
    expect(await envs("a_b")).toEqual(["Plan a_b"]);
    expect(await tpls("50%")).toEqual(["Descuento 50% marzo"]);
    expect(await tpls("a_b")).toEqual(["Plan a_b"]);
    expect(await tpls("\\")).toEqual([]);
  });

  it("% y _ literales en el actor del registro de auditoría y en las plantillas de documentos", async () => {
    for (const label of ["Ventas 50%", "Ventas 50", "a_b", "axb"]) {
      await db.query(`INSERT INTO account_audit_log (tenant_id, actor_type, actor_label, action) VALUES ($1, 'system', $2, 'test.like')`, [
        tenant,
        label,
      ]);
      await db.query(`INSERT INTO document_templates (id, tenant_id, name, locale, source) VALUES ($1, $2, $3, 'es', 'x')`, [uuid(), tenant, label]);
    }
    const audit = async (q: string) => {
      const r = await app.inject({ method: "GET", url: `/v1/audit-log?action=test.like&actor=${encodeURIComponent(q)}`, headers: auth });
      expect(r.statusCode, r.body).toBe(200);
      return r
        .json()
        .items.map((e: any) => e.actorLabel ?? e.actor?.label)
        .sort();
    };
    const docs = async (q: string) => {
      const r = await app.inject({ method: "GET", url: `/v1/document-templates?q=${encodeURIComponent(q)}`, headers: auth });
      expect(r.statusCode, r.body).toBe(200);
      return r
        .json()
        .items.map((e: any) => e.name)
        .sort();
    };
    expect(await audit("50%")).toEqual(["Ventas 50%"]);
    expect(await audit("a_b")).toEqual(["a_b"]);
    expect(await docs("50%")).toEqual(["Ventas 50%"]);
    expect(await docs("a_b")).toEqual(["a_b"]);
  });
});
