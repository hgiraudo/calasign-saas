// Firma con certificado propio: documento de identidad exigido sin documento (al guardar, al enviar y al firmar), PDF de
// trabajo y preparados borrados al anular, vencer y purgar (y los de códigos vencidos), preparación con nombre único y
// control optimista en la firma; verificación de identidad guardada sin datos completos y fotos sin EXIF.
// App real sobre PGlite.
import { createPrivateKey, randomInt, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-certsign-hardening-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
type Blobs = ReturnType<typeof import("../src/infra/storage")["createBlobStore"]>;
let db: Db;
let app: App;
let blobs: Blobs;
/** Si está, se llama cuando la API lee un blob (para simular algo concurrente en el medio de un pedido). */
let onGet: ((key: string) => Promise<void>) | null = null;
let tenant = "";
const KEY = "cs_test_certsign_hardening";
const headers = { authorization: `Bearer ${KEY}` };
const log = { info() {}, warn() {}, error() {} };

let util: typeof import("../src/lib/util");

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, retention_days) VALUES ($1, $2, 'T', 30)`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [util.uuidv7(), tenant, util.sha256Hex(KEY)]);
  const real = createBlobStore();
  blobs = {
    ...real,
    put: real.put.bind(real),
    delete: real.delete.bind(real),
    get: async (k: string) => {
      if (onGet) await onGet(k);
      return real.get(k);
    },
  } as Blobs;
  app = await buildApp({ db, blobs, logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const exists = async (k: string) =>
  blobs.get(k).then(
    () => true,
    () => false,
  );

async function draftEnvelope() {
  const env = util.uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'draft')`, [env, tenant]);
  return env;
}

/** Sobre esperando firmas con certificado: PDF de trabajo, firmante de turno y un código ya preparado. */
async function awaitingEnvelope(o: { reqs?: object; idDoc?: string | null; pdf?: Uint8Array; expiresAt?: string } = {}) {
  const env = util.uuidv7();
  const rec = util.uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, expires_at) VALUES ($1, $2, 'Contrato', 'awaiting_certificates', now(), $3)`, [
    env,
    tenant,
    o.expiresAt ?? null,
  ]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, signature_type, certificate_requirements, id_document_number)
     VALUES ($1,$2,$3,'signer','Juana','j@x.test','signed','certificate',$4,$5)`,
    [rec, tenant, env, JSON.stringify(o.reqs ?? { matchIdDocument: false, allowedIssuers: [], requireQualified: false }), o.idDoc ?? null],
  );
  await db.query(`INSERT INTO certificate_signatures (id, tenant_id, envelope_id, recipient_id, position, field_name) VALUES ($1,$2,$3,$4,1,'FirmaCertificado1')`, [
    util.uuidv7(),
    tenant,
    env,
    rec,
  ]);
  const working = o.pdf ?? new TextEncoder().encode("%PDF-1.4 trabajo");
  const workingKey = `tenants/${tenant}/envelopes/${env}/certsign/${util.uuidv7()}-working.pdf`;
  await blobs.put(workingKey, working, "application/pdf");
  const sha = util.sha256Hex(working);
  await db.query(`INSERT INTO envelope_certsign (envelope_id, tenant_id, working_key, working_sha256, completed_at, chain_head) VALUES ($1,$2,$3,$4, now(), 'c')`, [
    env,
    tenant,
    workingKey,
    sha,
  ]);
  const code = Array.from({ length: 10 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[randomInt(31)]).join("");
  const sess = util.uuidv7();
  const preparedKey = `tenants/${tenant}/envelopes/${env}/certsign/${sess}-x-prepared.pdf`;
  await blobs.put(preparedKey, new TextEncoder().encode("%PDF preparado"), "application/pdf");
  await db.query(
    `INSERT INTO certsign_sessions (id, code_hash, tenant_id, envelope_id, recipient_id, working_sha256, expires_at, prepared_key)
     VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes', $7)`,
    [sess, util.sha256Hex(`certsign:${code.replace(/[^A-Z0-9]/g, "")}`), tenant, env, rec, sha, preparedKey],
  );
  return { env, rec, code, sess, workingKey, preparedKey };
}

/** PDF mínimo de una página, hecho a mano (sin dependencias). */
function samplePdf() {
  const content = "BT /F1 14 Tf 50 780 Td (Contrato) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const certRecipient = (o: { name: string; idDocumentNumber?: string | null; matchIdDocument: boolean }) => ({
  id: util.uuidv7(),
  role: "signer",
  routingOrder: 1,
  name: o.name,
  email: "j@x.test",
  channels: ["email"],
  idDocumentType: o.idDocumentNumber ? "dni" : null,
  idDocumentNumber: o.idDocumentNumber ?? null,
  signatureType: "certificate",
  certificateRequirements: { matchIdDocument: o.matchIdDocument, allowedIssuers: [], requireQualified: false },
});

describe("documento de identidad exigido sin documento", () => {
  it("guardar destinatarios: 400 missing_id_document con el nombre; con documento o sin exigirlo, se guarda", async () => {
    const env = await draftEnvelope();
    const put = (r: object) => app.inject({ method: "PUT", url: `/v1/envelopes/${env}/recipients`, headers, payload: { recipients: [r] } });
    const bad = await put(certRecipient({ name: "Juana Pérez", matchIdDocument: true }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("missing_id_document");
    expect(bad.json().error.details.recipient).toBe("Juana Pérez");
    expect(bad.json().error.message).toMatch(/Juana Pérez/);
    expect((await put(certRecipient({ name: "Juana", matchIdDocument: true, idDocumentNumber: "30111222" }))).statusCode).toBe(200);
    expect((await put(certRecipient({ name: "Juana", matchIdDocument: false }))).statusCode).toBe(200);
  });

  it("enviar: el problema missing_id_document en un sobre armado a mano", async () => {
    const env = await draftEnvelope();
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, signature_type, certificate_requirements)
       VALUES ($1,$2,$3,'signer','Beto','b@x.test','certificate',$4)`,
      [util.uuidv7(), tenant, env, JSON.stringify({ matchIdDocument: true, allowedIssuers: [], requireQualified: false })],
    );
    const r = await app.inject({ method: "POST", url: `/v1/envelopes/${env}/send`, headers, payload: {} });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_id_document", params: { name: "Beto" } })]));
  });

  it("enviar un sobre creado desde una plantilla: el control se baja (con la marca) en vez de ser un problema", async () => {
    const env = await draftEnvelope();
    await db.query(`UPDATE envelopes SET metadata = $2 WHERE id = $1`, [env, JSON.stringify({ templateId: util.uuidv7() })]);
    const rec = util.uuidv7();
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, signature_type, certificate_requirements)
       VALUES ($1,$2,$3,'signer','Beto','b@x.test','certificate',$4)`,
      [rec, tenant, env, JSON.stringify({ matchIdDocument: true, allowedIssuers: [], requireQualified: false })],
    );
    const r = await app.inject({ method: "POST", url: `/v1/envelopes/${env}/send`, headers, payload: {} });
    // Falla por otros problemas (sin documentos), pero no por el documento de identidad.
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_id_document" })]));
  });

  it("plantilla → sobre y reemplazos: sin documento se baja a false con la marca; con documento se conserva", async () => {
    const { downgradeIdMatchSql, normalizeRequirements, idMatchSkipped } = await import("../src/modules/certsign-requirements");
    const run = async (req: object | null, doc: string | null) =>
      (await db.one<any>(`SELECT ${downgradeIdMatchSql("$1::jsonb", "$2::text")} AS r`, [req ? JSON.stringify(req) : null, doc])).r;
    const want = { matchIdDocument: true, allowedIssuers: ["X"], requireQualified: false };
    expect(await run(want, null)).toEqual({ ...want, matchIdDocument: false, idDocumentMatchSkipped: true });
    expect(await run(want, "  ")).toEqual({ ...want, matchIdDocument: false, idDocumentMatchSkipped: true });
    expect(await run(want, "30111222")).toEqual(want);
    expect(await run({ ...want, matchIdDocument: false }, null)).toEqual({ ...want, matchIdDocument: false });
    expect(await run(null, null)).toBeNull();
    // Por defecto false; pedido sin documento no rige.
    expect(normalizeRequirements({}, true).matchIdDocument).toBe(false);
    expect(normalizeRequirements({ matchIdDocument: true }, false).matchIdDocument).toBe(false);
    expect(normalizeRequirements({ matchIdDocument: true }, true).matchIdDocument).toBe(true);
    expect(idMatchSkipped({ matchIdDocument: true }, null)).toBe(true);
    expect(idMatchSkipped({ matchIdDocument: false, idDocumentMatchSkipped: true }, null)).toBe(true);
    expect(idMatchSkipped({ matchIdDocument: true }, "1")).toBe(false);
  });

  it("firmar (Firmador): sin documento se firma sin ese control y la evidencia registra que no se comparó", async () => {
    const { createLabPki } = await import("@calasign/pdf/lab");
    const pki = await createLabPki("http://127.0.0.1:9");
    const holder = await pki.issue("Juana Pérez");
    const x = await awaitingEnvelope({ reqs: { matchIdDocument: true, allowedIssuers: [], requireQualified: false }, idDoc: null, pdf: samplePdf() });
    await db.query(`UPDATE certsign_sessions SET prepared_key = NULL WHERE id = $1`, [x.sess]);
    const p = await app.inject({ method: "POST", url: `/v1/certsign/sessions/${x.code}/certificate`, payload: { chain: [holder.certPem, pki.intermediate.certPem] } });
    expect(p.statusCode, p.body).toBe(200);
    const sess = await db.one<any>(`SELECT cert_check FROM certsign_sessions WHERE id = $1`, [x.sess]);
    expect(sess.cert_check.idDocumentMatch).toBe("skipped_missing_id_document");
    const signature = Buffer.from(cryptoSign("sha256", Buffer.from(p.json().dataToSign, "base64"), createPrivateKey(holder.keyPem))).toString("base64");
    const ok = await app.inject({ method: "POST", url: `/v1/certsign/sessions/${x.code}/signature`, payload: { signature } });
    expect(ok.statusCode, ok.body).toBe(200);
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.certificate_signed'`, [x.env]);
    expect(ev.data.idDocumentMatch).toBe("skipped_missing_id_document");
  }, 60_000);

  it("migración 0092: roles de plantilla en false; sobres en curso sin documento bajados con la marca", async () => {
    const x = await awaitingEnvelope({ reqs: { matchIdDocument: true, allowedIssuers: [], requireQualified: false }, idDoc: null });
    const y = await awaitingEnvelope({ reqs: { matchIdDocument: true, allowedIssuers: [], requireQualified: false }, idDoc: "30111222" });
    const z = await awaitingEnvelope({ reqs: { matchIdDocument: true, allowedIssuers: [], requireQualified: false }, idDoc: null });
    await db.query(`UPDATE envelopes SET status = 'completed' WHERE id = $1`, [z.env]);
    const sql = readFileSync(new URL("../migrations/0092_certsign_id_match_default.sql", import.meta.url), "utf8");
    const updates = sql.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter((s) => s.startsWith("UPDATE"));
    expect(updates).toHaveLength(2);
    for (const stmt of updates) await db.query(stmt);
    const req = async (rec: string) => (await db.one<any>(`SELECT certificate_requirements AS r FROM recipients WHERE id = $1`, [rec])).r;
    expect(await req(x.rec)).toMatchObject({ matchIdDocument: false, idDocumentMatchSkipped: true });
    expect(await req(y.rec)).toMatchObject({ matchIdDocument: true });
    expect(await req(z.rec)).toMatchObject({ matchIdDocument: true });
  });
});

describe("delegación y reasignación de un firmante que debe corresponder a su documento", () => {
  /** Sobre enviado con un firmante con certificado de turno (link vigente). */
  async function sentEnvelope(reqs: object | null, idDoc: string | null) {
    const env = util.uuidv7();
    const rec = util.uuidv7();
    const token = util.randomToken();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at) VALUES ($1, $2, 'Contrato', 'sent', now())`, [env, tenant]);
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, signature_type, certificate_requirements, id_document_number,
         access_token_hash, access_token_enc)
       VALUES ($1,$2,$3,'signer','Juana','j@x.test','sent','certificate',$4,$5,$6,$7)`,
      [rec, tenant, env, reqs ? JSON.stringify(reqs) : null, idDoc, util.sha256Hex(token), util.encrypt(token)],
    );
    return { env, rec, token };
  }
  const delegate = (token: string, extra: object = {}) =>
    app.inject({ method: "POST", url: `/v1/signing/${token}/delegate`, payload: { name: "Beto", email: "beto@x.test", reason: "Viaje", ...extra } });
  const replacement = async (rec: string) =>
    db.one<any>(`SELECT certificate_requirements AS r, id_document_number AS doc, status FROM recipients WHERE replaces = $1`, [rec]);
  const MATCH = { matchIdDocument: true, allowedIssuers: [], requireQualified: false };

  it("delegar sin documento de la persona nueva: 409 delegation_requires_id_match y nada cambia", async () => {
    const x = await sentEnvelope(MATCH, "30111222");
    const d = await delegate(x.token);
    expect(d.statusCode).toBe(409);
    expect(d.json().error.code).toBe("delegation_requires_id_match");
    expect(await replacement(x.rec)).toBeNull();
    expect((await db.one<any>(`SELECT status FROM recipients WHERE id = $1`, [x.rec])).status).toBe("sent");
  });

  it("delegar con el documento de la persona nueva: el control se mantiene contra ese número", async () => {
    const x = await sentEnvelope(MATCH, "30111222");
    const d = await delegate(x.token, { idDocumentNumber: " 40999888 " });
    expect(d.statusCode, d.body).toBe(200);
    const r = await replacement(x.rec);
    expect(r.doc).toBe("40999888");
    expect(r.r).toMatchObject({ matchIdDocument: true, idDocumentSource: "delegator" });
    expect(r.r.idDocumentMatchSkipped).toBeUndefined();
    // El tipo de documento del original no pasa al reemplazo (la persona nueva puede tener otro): sin indicarlo queda
    // sin tipo; quien delega puede indicarlo. El evento registra el número enmascarado y su procedencia.
    const y = await sentEnvelope(MATCH, "30111222");
    await db.query(`UPDATE recipients SET id_document_type = 'dni' WHERE id = $1`, [y.rec]);
    expect((await delegate(y.token, { idDocumentNumber: "40999888" })).statusCode).toBe(200);
    expect((await db.one<any>(`SELECT id_document_type FROM recipients WHERE replaces = $1`, [y.rec])).id_document_type).toBeNull();
    const z = await sentEnvelope(MATCH, "30111222");
    await db.query(`UPDATE recipients SET id_document_type = 'dni' WHERE id = $1`, [z.rec]);
    expect((await delegate(z.token, { idDocumentNumber: "40999888", idDocumentType: "passport" })).statusCode).toBe(200);
    expect((await db.one<any>(`SELECT id_document_type FROM recipients WHERE replaces = $1`, [z.rec])).id_document_type).toBe("passport");
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.delegated'`, [y.env]);
    expect(ev.data).toMatchObject({ idDocument: "****9888", idDocumentSource: "delegator" });
    expect(JSON.stringify(ev.data)).not.toContain("40999888");
  });

  it("sin el control (o pedido sin documento, que no rige) se delega como siempre", async () => {
    for (const [reqs, doc] of [[{ ...MATCH, matchIdDocument: false }, "30111222"], [MATCH, null], [null, "30111222"]] as const) {
      const x = await sentEnvelope(reqs, doc);
      expect((await delegate(x.token)).statusCode).toBe(200);
    }
  });

  it("reasignar (lo decide el remitente) sin documento: se baja con la marca para la evidencia", async () => {
    const x = await sentEnvelope(MATCH, "30111222");
    const r = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${x.env}/recipients/${x.rec}/reassign`,
      headers,
      payload: { name: "Beto", email: "beto@x.test" },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await replacement(x.rec)).r).toMatchObject({ matchIdDocument: false, idDocumentMatchSkipped: true });
  });
});

describe("migración 0094: control del documento explícito en sobres no terminados", () => {
  it("sin la clave y con documento (creado antes de la 0092) pasa a true; el resto no cambia; idempotente", async () => {
    const noKey = { allowedIssuers: ["X"], requireQualified: false };
    const a = await awaitingEnvelope({ reqs: noKey, idDoc: "30111222" });
    const b = await awaitingEnvelope({ reqs: noKey, idDoc: "  " });
    const c = await awaitingEnvelope({ reqs: { ...noKey, matchIdDocument: false }, idDoc: "30111222" });
    const d = await awaitingEnvelope({ reqs: noKey, idDoc: "30111222" });
    await db.query(`UPDATE envelopes SET status = 'voided' WHERE id = $1`, [d.env]);
    const e = await awaitingEnvelope({ idDoc: "30111222" });
    await db.query(`UPDATE recipients SET certificate_requirements = NULL WHERE id = $1`, [e.rec]);
    // Los anteriores se crearon antes de aplicar la 0092 (regla vieja); f, después (la clave ausente ya era false).
    await db.query(
      `UPDATE recipients SET created_at = (SELECT applied_at FROM schema_migrations WHERE name = '0092_certsign_id_match_default.sql') - interval '1 day' WHERE id = ANY($1)`,
      [[a.rec, b.rec, c.rec, d.rec, e.rec]],
    );
    const f = await awaitingEnvelope({ reqs: noKey, idDoc: "30111222" });
    const sql = readFileSync(new URL("../migrations/0094_certsign_id_match_explicit.sql", import.meta.url), "utf8");
    const updates = sql.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter((s) => s.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    const req = async (rec: string) => (await db.one<any>(`SELECT certificate_requirements AS r FROM recipients WHERE id = $1`, [rec])).r;
    for (let i = 0; i < 2; i++) {
      await db.query(updates[0]!);
      expect(await req(a.rec)).toEqual({ ...noKey, matchIdDocument: true });
      expect(await req(b.rec)).toEqual(noKey);
      expect(await req(c.rec)).toEqual({ ...noKey, matchIdDocument: false });
      expect(await req(d.rec)).toEqual(noKey);
      expect(await req(e.rec)).toEqual({ matchIdDocument: true });
      expect(await req(f.rec)).toEqual(noKey);
    }
  });
});

describe("PDF de la firma con certificado al cerrar el sobre", () => {
  it("anular borra el PDF de trabajo y los preparados", async () => {
    const x = await awaitingEnvelope();
    const r = await app.inject({ method: "POST", url: `/v1/envelopes/${x.env}/void`, headers, payload: { reason: "Error" } });
    expect(r.statusCode).toBe(200);
    expect(await exists(x.workingKey)).toBe(false);
    expect(await exists(x.preparedKey)).toBe(false);
    expect(await db.one(`SELECT 1 FROM envelope_certsign WHERE envelope_id = $1`, [x.env])).toBeNull();
    expect(await db.one<any>(`SELECT status, prepared_key FROM certsign_sessions WHERE id = $1`, [x.sess])).toEqual({ status: "expired", prepared_key: null });
  });

  it("vencer (barrido) borra el PDF de trabajo y los preparados", async () => {
    const x = await awaitingEnvelope({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const { sweep } = await import("../src/modules/jobs");
    await sweep({ db, blobs, log });
    expect((await db.one<any>(`SELECT status FROM envelopes WHERE id = $1`, [x.env])).status).toBe("expired");
    expect(await exists(x.workingKey)).toBe(false);
    expect(await exists(x.preparedKey)).toBe(false);
    expect(await db.one(`SELECT 1 FROM envelope_certsign WHERE envelope_id = $1`, [x.env])).toBeNull();
  });

  it("barrido: preparados de códigos vencidos", async () => {
    const x = await awaitingEnvelope();
    await db.query(`UPDATE certsign_sessions SET expires_at = now() - interval '1 minute', status = 'prepared' WHERE id = $1`, [x.sess]);
    const { sweepCertsignPrepared } = await import("../src/modules/certsign");
    expect(await sweepCertsignPrepared(db, blobs)).toBeGreaterThanOrEqual(1);
    expect(await exists(x.preparedKey)).toBe(false);
    expect(await exists(x.workingKey)).toBe(true);
    expect(await db.one<any>(`SELECT status, prepared_key FROM certsign_sessions WHERE id = $1`, [x.sess])).toEqual({ status: "expired", prepared_key: null });
  });

  it("barrido: PDF de trabajo de un sobre anulado aunque la organización no tenga retención", async () => {
    const x = await awaitingEnvelope();
    await db.query(`UPDATE tenants SET retention_days = NULL WHERE id = $1`, [tenant]);
    try {
      // El borrado al anular falló: quedó la fila y el archivo.
      await db.query(`UPDATE envelopes SET status = 'voided', voided_at = now() WHERE id = $1`, [x.env]);
      const { sweepCertsignPrepared } = await import("../src/modules/certsign");
      await sweepCertsignPrepared(db, blobs);
      expect(await exists(x.workingKey)).toBe(false);
      expect(await exists(x.preparedKey)).toBe(false);
      expect(await db.one(`SELECT 1 FROM envelope_certsign WHERE envelope_id = $1`, [x.env])).toBeNull();
    } finally {
      await db.query(`UPDATE tenants SET retention_days = 30 WHERE id = $1`, [tenant]);
    }
  });

  it("purga por retención: borra los que quedaron (p. ej. si el borrado al anular falló) y vacía el resultado de identidad", async () => {
    const x = await awaitingEnvelope();
    await db.query(`UPDATE envelopes SET status = 'voided', voided_at = now() - interval '60 days' WHERE id = $1`, [x.env]);
    const ver = util.uuidv7();
    await db.query(
      `INSERT INTO identity_verifications (id, tenant_id, envelope_id, recipient_id, provider, level, status, attempt, result)
       VALUES ($1,$2,$3,$4,'mock','document','verified',1,$5)`,
      [
        ver,
        tenant,
        x.env,
        x.rec,
        JSON.stringify({
          status: "approved",
          document: { type: "DNI", number: "****1222", country: "AR", expiresOn: "2030-01-01" },
          person: { firstName: "Juana", lastName: "Pérez", fullName: "Juana Pérez", birthDate: "1990" },
          faceMatchScore: 0.9,
          liveness: true,
          riskFlags: [],
          reference: "ref-1",
          declineReason: null,
        }),
      ],
    );
    const { purgeExpiredEnvelopes } = await import("../src/modules/retention");
    const r = await purgeExpiredEnvelopes({ db, blobs, log }, { tenantId: tenant });
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(await exists(x.workingKey)).toBe(false);
    expect(await exists(x.preparedKey)).toBe(false);
    const v = await db.one<any>(`SELECT result FROM identity_verifications WHERE id = $1`, [ver]);
    expect(v.result).toMatchObject({ status: "approved", document: { type: "DNI", country: "AR", number: null }, person: { fullName: null, birthDate: null }, faceMatchScore: 0.9, purged: true });
  });
});

describe("preparación y firma", () => {
  it("cada preparación tiene su archivo; una firma sobre una preparación reemplazada se rechaza", async () => {
    const { createLabPki } = await import("@calasign/pdf/lab");
    const pki = await createLabPki("http://127.0.0.1:9");
    const holder = await pki.issue("Juana Pérez");
    const x = await awaitingEnvelope({ pdf: samplePdf() });
    await db.query(`UPDATE certsign_sessions SET prepared_key = NULL WHERE id = $1`, [x.sess]);
    const chain = [holder.certPem, pki.intermediate.certPem];
    const prepare = () => app.inject({ method: "POST", url: `/v1/certsign/sessions/${x.code}/certificate`, payload: { chain } });
    const p1 = await prepare();
    expect(p1.statusCode, p1.body).toBe(200);
    const k1 = (await db.one<any>(`SELECT prepared_key FROM certsign_sessions WHERE id = $1`, [x.sess])).prepared_key as string;
    const p2 = await prepare();
    expect(p2.statusCode).toBe(200);
    const k2 = (await db.one<any>(`SELECT prepared_key FROM certsign_sessions WHERE id = $1`, [x.sess])).prepared_key as string;
    expect(k2).not.toBe(k1);
    expect(k1).toMatch(new RegExp(`${x.sess}-.+-prepared\\.pdf$`));
    // El anterior no se borra en el momento (el Firmador puede estar bajándolo): lo borra el barrido pasado el margen.
    expect(await exists(k1)).toBe(true);
    expect(await exists(k2)).toBe(true);
    expect(await db.one(`SELECT 1 FROM certsign_stale_blobs WHERE storage_key = $1`, [k1])).not.toBeNull();
    const { sweepCertsignPrepared } = await import("../src/modules/certsign");
    await sweepCertsignPrepared(db, blobs);
    expect(await exists(k1)).toBe(true);
    await db.query(`UPDATE certsign_stale_blobs SET superseded_at = now() - interval '11 minutes' WHERE storage_key = $1`, [k1]);
    await sweepCertsignPrepared(db, blobs);
    expect(await exists(k1)).toBe(false);
    expect(await db.one(`SELECT 1 FROM certsign_stale_blobs WHERE storage_key = $1`, [k1])).toBeNull();
    // Si el preparado ya no existe, /prepared responde 409 document_changed (no 500).
    await db.query(`UPDATE certsign_sessions SET prepared_key = $2 WHERE id = $1`, [x.sess, k1]);
    const gone = await app.inject({ method: "GET", url: `/v1/certsign/sessions/${x.code}/prepared` });
    expect(gone.statusCode).toBe(409);
    expect(gone.json().error.code).toBe("document_changed");
    await db.query(`UPDATE certsign_sessions SET prepared_key = $2 WHERE id = $1`, [x.sess, k2]);

    const sign = (dataToSign: string) =>
      Buffer.from(cryptoSign("sha256", Buffer.from(dataToSign, "base64"), createPrivateKey(holder.keyPem))).toString("base64");
    // Mientras se firma, el certificado se vuelve a mandar (otra preparación): la firma es de los atributos anteriores.
    onGet = async (k) => {
      if (k !== k2) return;
      onGet = null;
      await db.query(`UPDATE certsign_sessions SET prepared_key = $2 WHERE id = $1`, [x.sess, `${k2}.otra`]);
    };
    const stale = await app.inject({ method: "POST", url: `/v1/certsign/sessions/${x.code}/signature`, payload: { signature: sign(p2.json().dataToSign) } });
    onGet = null;
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("document_changed");
    expect((await db.one<any>(`SELECT status FROM certificate_signatures WHERE recipient_id = $1`, [x.rec])).status).toBe("pending");

    // Sin la carrera, la firma se completa y la sesión ya no referencia el preparado (borrado).
    await db.query(`UPDATE certsign_sessions SET prepared_key = $2 WHERE id = $1`, [x.sess, k2]);
    const ok = await app.inject({ method: "POST", url: `/v1/certsign/sessions/${x.code}/signature`, payload: { signature: sign(p2.json().dataToSign) } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await db.one<any>(`SELECT status, prepared_key FROM certsign_sessions WHERE id = $1`, [x.sess])).toEqual({ status: "completed", prepared_key: null });
    expect(await exists(k2)).toBe(false);
  }, 60_000);
});

describe("verificación de identidad: datos guardados", () => {
  it("result guarda el número enmascarado y solo el año de nacimiento", async () => {
    const { storedIdvResult } = await import("../src/modules/identity/kyc");
    const r = storedIdvResult({
      status: "approved",
      document: { type: "DNI", number: "30 111 222", country: "AR", expiresOn: null },
      person: { firstName: "Juana", lastName: "Pérez", fullName: "Juana Pérez", birthDate: "1990-05-14" },
      faceMatchScore: 0.9,
      liveness: true,
      riskFlags: [],
      reference: null,
      declineReason: null,
    });
    expect(r.document.number).toBe("****1222");
    expect(r.person.birthDate).toBe("1990");
    expect(storedIdvResult({ ...r, person: { ...r.person, birthDate: "14/05/1990" } }).person.birthDate).toBe("1990");
    // Idempotente.
    expect(storedIdvResult(r).document.number).toBe("****1222");
  });

  it("la migración 0091 enmascara los existentes", async () => {
    const x = await awaitingEnvelope();
    const ver = util.uuidv7();
    await db.query(
      `INSERT INTO identity_verifications (id, tenant_id, envelope_id, recipient_id, provider, level, status, attempt, result)
       VALUES ($1,$2,$3,$4,'mock','document','verified',1,$5)`,
      [
        ver,
        tenant,
        x.env,
        x.rec,
        JSON.stringify({ status: "approved", document: { type: "DNI", number: "001-1234567-8", country: "DO" }, person: { fullName: "Ana", birthDate: "1988-02-01" } }),
      ],
    );
    const sql = readFileSync(new URL("../migrations/0091_identity_result_masked.sql", import.meta.url), "utf8");
    for (const stmt of sql.split(/;\s*$/m).map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await db.query(stmt);
    const v = await db.one<any>(`SELECT result FROM identity_verifications WHERE id = $1`, [ver]);
    expect(v.result.document.number).toBe("******67-8");
    expect(v.result.person.birthDate).toBe("1988");
    expect(v.result.person.fullName).toBe("Ana");
  });
});

describe("fotos de identidad sin metadatos", () => {
  const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);

  it("JPEG: quita APP1 (EXIF con GPS) y comentarios, conserva JFIF y los datos de imagen", async () => {
    const { stripImageMetadata } = await import("../src/modules/identity/image-meta");
    const jfif = seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
    const exif = seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPSLatitude -34.6037 GPSLongitude -58.3816 iPhone 15")]));
    const com = seg(0xfe, Buffer.from("comentario con datos"));
    const dqt = seg(0xdb, Buffer.alloc(65, 1));
    const scan = Buffer.concat([seg(0xda, Buffer.alloc(10, 2)), Buffer.alloc(200, 3), Buffer.from([0xff, 0xd9])]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, exif, com, dqt, scan]);
    const out = Buffer.from(stripImageMetadata(new Uint8Array(jpeg)));
    expect(out.includes(Buffer.from("Exif"))).toBe(false);
    expect(out.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(out.includes(Buffer.from("comentario"))).toBe(false);
    expect(out).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, dqt, scan]));
  });

  it("JPEG: del EXIF conserva solo la orientación (APP1 mínimo)", async () => {
    const { stripImageMetadata, exifOrientation, minimalExifSegment } = await import("../src/modules/identity/image-meta");
    // TIFF little-endian con dos entradas en IFD0: Make (ASCII, fuera de línea) y Orientation = 6.
    const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 16);
    tiff.write("II", 0, "latin1");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(2, 8);
    tiff.writeUInt16LE(0x010f, 10); // Make
    tiff.writeUInt16LE(2, 12);
    tiff.writeUInt32LE(16, 14);
    tiff.writeUInt32LE(38, 18);
    tiff.writeUInt16LE(0x0112, 22); // Orientation
    tiff.writeUInt16LE(3, 24);
    tiff.writeUInt32LE(1, 26);
    tiff.writeUInt16LE(6, 30);
    tiff.write("iPhone 15 GPS\0", 38, "latin1");
    const exif = seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]));
    const xmp = seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS</x:xmpmeta>", "latin1"));
    const dqt = seg(0xdb, Buffer.alloc(65, 1));
    const scan = Buffer.concat([seg(0xda, Buffer.alloc(10, 2)), Buffer.alloc(100, 3), Buffer.from([0xff, 0xd9])]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, xmp, dqt, scan]);
    const out = Buffer.from(stripImageMetadata(new Uint8Array(jpeg)));
    expect(out.includes(Buffer.from("iPhone"))).toBe(false);
    expect(out.includes(Buffer.from("xmpmeta"))).toBe(false);
    expect(out).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), minimalExifSegment(6), dqt, scan]));
    expect(exifOrientation(minimalExifSegment(6).subarray(4))).toBe(6);
    // Orientación normal (1) o sin orientación: no queda ningún APP1.
    const plain = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, Buffer.from("Exif\0\0GPS", "latin1")), dqt, scan]);
    expect(Buffer.from(stripImageMetadata(new Uint8Array(plain)))).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), dqt, scan]));
  });

  it("JPEG con imágenes secundarias MPF: se corta en el EOI de la principal y se quita el índice MPF", async () => {
    const { stripImageMetadata } = await import("../src/modules/identity/image-meta");
    const icc = seg(0xe2, Buffer.from("ICC_PROFILE\0\x01\x01perfil", "latin1"));
    const mpf = seg(0xe2, Buffer.from("MPF\0MM\0*indice", "latin1"));
    const dqt = seg(0xdb, Buffer.alloc(65, 1));
    // Datos comprimidos con un 0xFF relleno (FF 00) y un RST, que no son el EOI.
    const scan = Buffer.concat([seg(0xda, Buffer.alloc(10, 2)), Buffer.from([1, 0xff, 0x00, 2, 0xff, 0xd0, 3]), Buffer.from([0xff, 0xd9])]);
    const secondary = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPSLatitude -34.6")])),
      dqt,
      seg(0xda, Buffer.alloc(10, 2)),
      Buffer.alloc(20, 4),
      Buffer.from([0xff, 0xd9]),
    ]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), icc, mpf, dqt, scan, secondary]);
    const out = Buffer.from(stripImageMetadata(new Uint8Array(jpeg)));
    expect(out.includes(Buffer.from("GPSLatitude"))).toBe(false);
    expect(out.includes(Buffer.from("MPF\0"))).toBe(false);
    expect(out).toEqual(Buffer.concat([Buffer.from([0xff, 0xd8]), icc, dqt, scan]));
  });

  it("PNG: quita eXIf y tEXt", async () => {
    const { stripImageMetadata } = await import("../src/modules/identity/image-meta");
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = chunk("IHDR", Buffer.alloc(13, 1));
    const idat = chunk("IDAT", Buffer.alloc(50, 7));
    const iend = chunk("IEND", Buffer.alloc(0));
    const png = Buffer.concat([sig, ihdr, chunk("eXIf", Buffer.from("MM\0*GPS")), chunk("tEXt", Buffer.from("Author\0Juana")), idat, iend]);
    const out = Buffer.from(stripImageMetadata(new Uint8Array(png)));
    expect(out).toEqual(Buffer.concat([sig, ihdr, idat, iend]));
  });

  it("una imagen mal formada se rechaza", async () => {
    const { stripImageMetadata, InvalidImageError } = await import("../src/modules/identity/image-meta");
    expect(() => stripImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1]))).toThrow(InvalidImageError);
  });
});

