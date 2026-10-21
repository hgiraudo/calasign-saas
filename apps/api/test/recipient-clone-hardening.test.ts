// Destinatarios reutilizados y clonado: el chat de Telegram no sigue a otra persona, el clonado pasa por los controles de
// verificación de identidad y firma con certificado y conserva las claves reservadas de la metadata, dejar la firma en
// persona con otro authMethod, nivel de firma fijo al enviar y revisión con IA de documentos que cambiaron. PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AI_NOTICE_VERSION } from "@calasign/shared";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-recipient-clone-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
let user: string;
let uuid: () => string;
let setAiProviderForTests: typeof import("../src/modules/ai/provider")["setAiProviderForTests"];
const KEY = "cs_test_recipient_clone_key";
const auth = { authorization: `Bearer ${KEY}` };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { sha256Hex, uuidv7 } = await import("../src/lib/util");
  ({ setAiProviderForTests } = await import("../src/modules/ai/provider"));
  uuid = uuidv7;
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(
    `INSERT INTO tenants (id, slug, name, billing_plan, ai_enabled, ai_monthly_token_budget, ai_notice_version, ai_notice_accepted_at, ai_playbook)
     VALUES ($1, $2, 'T', 'enterprise', true, 1000000, $3, now(), $4)`,
    [tenant, `t-${tenant.slice(-8)}`, AI_NOTICE_VERSION, JSON.stringify(["La jurisdicción es Bogotá"])],
  );
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
  user = uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, 'Anfitriona', 'x')`, [user, `host-${user.slice(-8)}@x.test`]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`, [tenant, user]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  setAiProviderForTests(undefined);
  await app?.close();
  await db?.close();
});
afterEach(async () => {
  await db.query(`UPDATE tenants SET billing_plan = 'enterprise' WHERE id = $1`, [tenant]);
});

async function draft(subject = "Contrato", extra: object = {}) {
  const r = await app.inject({ method: "POST", url: "/v1/envelopes", headers: auth, payload: { subject, ...extra } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().envelope.id as string;
}
const putRecipients = (id: string, recipients: object[]) => app.inject({ method: "PUT", url: `/v1/envelopes/${id}/recipients`, headers: auth, payload: { recipients } });
const clone = (id: string, payload: object = {}) => app.inject({ method: "POST", url: `/v1/envelopes/${id}/clone`, headers: auth, payload });

function minimalPdf() {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
function multipart(pdf: Buffer) {
  const b = "----calasignclone";
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    pdf,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { payload, headers: { ...auth, "content-type": `multipart/form-data; boundary=${b}` } };
}

describe("chat de Telegram de un destinatario reutilizado", () => {
  it("si cambia el correo o el teléfono, el chat vinculado se descarta; con los mismos datos se conserva", async () => {
    const id = await draft();
    const rid = uuid();
    expect((await putRecipients(id, [{ id: rid, name: "María", email: "maria@x.test", channels: ["email", "telegram"] }])).statusCode).toBe(200);
    await db.query(`UPDATE recipients SET telegram_chat_id = '111' WHERE id = $1`, [rid]);
    const chat = async () => (await db.one<any>(`SELECT telegram_chat_id FROM recipients WHERE id = $1`, [rid])).telegram_chat_id;
    // Mismos datos (otro nombre): sigue vinculado.
    expect((await putRecipients(id, [{ id: rid, name: "María P.", email: "maria@x.test", channels: ["email", "telegram"] }])).statusCode).toBe(200);
    expect(await chat()).toBe("111");
    // Solo Telegram con otro correo: ya no vale el chat de María (400 como si no estuviera vinculado).
    const bad = await putRecipients(id, [{ id: rid, name: "Juan", email: "juan@x.test", channels: ["telegram"] }]);
    expect(bad.statusCode).toBe(400);
    expect(await chat()).toBe("111");
    // Otra persona en la misma fila: el link de Juan no va al chat de María.
    expect((await putRecipients(id, [{ id: rid, name: "Juan", email: "juan@x.test", channels: ["email", "telegram"] }])).statusCode).toBe(200);
    expect(await chat()).toBeNull();
    // Teléfono distinto también.
    await db.query(`UPDATE recipients SET telegram_chat_id = '222' WHERE id = $1`, [rid]);
    expect((await putRecipients(id, [{ id: rid, name: "Juan", email: "juan@x.test", phone: "+5491100000000", channels: ["email", "telegram"] }])).statusCode).toBe(200);
    expect(await chat()).toBeNull();
  });

  it("el clon no copia el chat; un destinatario solo Telegram recibe por su correo", async () => {
    const id = await draft();
    const a = uuid();
    const b = uuid();
    expect((await putRecipients(id, [{ id: a, name: "Ana", email: "ana@x.test" }, { id: b, name: "Beto", email: "beto@x.test", channels: ["email", "telegram"] }])).statusCode).toBe(200);
    await db.query(`UPDATE recipients SET telegram_chat_id = '333' WHERE envelope_id = $1`, [id]);
    await db.query(`UPDATE recipients SET channels = ARRAY['telegram'] WHERE id = $1`, [a]);
    const c = await clone(id);
    expect(c.statusCode, c.body).toBe(201);
    const rows = await db.query<any>(`SELECT name, channels, telegram_chat_id FROM recipients WHERE envelope_id = $1 ORDER BY name`, [c.json().envelope.id]);
    expect(rows).toEqual([
      { name: "Ana", channels: ["telegram", "email"], telegram_chat_id: null },
      { name: "Beto", channels: ["email", "telegram"], telegram_chat_id: null },
    ]);
  });
});

describe("clonado: verificación de identidad, certificado y metadata", () => {
  it("la verificación de identidad del original pasa por el plan y el proveedor", async () => {
    const id = await draft();
    const rid = uuid();
    expect((await putRecipients(id, [{ id: rid, name: "Ana", email: "ana@x.test", idVerification: { provider: "mock", level: "document" } }])).statusCode).toBe(200);
    const ok = await clone(id);
    expect(ok.statusCode, ok.body).toBe(201);
    const r = await db.one<any>(`SELECT id_verification_provider AS p, id_verification_level AS l, identity_status AS s FROM recipients WHERE envelope_id = $1`, [ok.json().envelope.id]);
    expect(r).toEqual({ p: "mock", l: "document", s: "pending" });
    // Sin kyc en el plan actual: 402, como un PUT recipients.
    await db.query(`UPDATE tenants SET billing_plan = 'starter' WHERE id = $1`, [tenant]);
    const noPlan = await clone(id);
    expect(noPlan.statusCode).toBe(402);
    expect(noPlan.json().error.code).toBe("plan_limit");
    await db.query(`UPDATE tenants SET billing_plan = 'enterprise' WHERE id = $1`, [tenant]);
    // Proveedor no configurado.
    await db.query(`UPDATE recipients SET id_verification_provider = 'veriff' WHERE id = $1`, [rid]);
    const noProvider = await clone(id);
    expect(noProvider.statusCode).toBe(400);
    expect(noProvider.json().error.code).toBe("identity_provider_unavailable");
  });

  it("la firma con certificado se copia con sus controles (documento de identidad exigido)", async () => {
    const id = await draft();
    const rid = uuid();
    expect(
      (await putRecipients(id, [{ id: rid, name: "Ana", email: "ana@x.test", idDocumentNumber: "123", signatureType: "certificate", certificateRequirements: { matchIdDocument: true } }]))
        .statusCode,
    ).toBe(200);
    const ok = await clone(id);
    expect(ok.statusCode, ok.body).toBe(201);
    const r = await db.one<any>(`SELECT signature_type, certificate_requirements FROM recipients WHERE envelope_id = $1`, [ok.json().envelope.id]);
    expect(r.signature_type).toBe("certificate");
    expect(r.certificate_requirements.matchIdDocument).toBe(true);
    await db.query(`UPDATE recipients SET id_document_number = NULL WHERE id = $1`, [rid]);
    const bad = await clone(id);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("missing_id_document");
  });

  it("con metadata propia conserva las claves reservadas del documento y clonedFrom", async () => {
    const id = await draft("Con metadata");
    await db.query(`UPDATE envelopes SET metadata = $2 WHERE id = $1`, [id, JSON.stringify({ templateId: "tpl-1", agreement: { a: 1 }, workflowRunId: "w", foo: 1 })]);
    const c = await clone(id, { metadata: { bar: 2, clonedFrom: "falso", templateId: "otro" } });
    expect(c.statusCode, c.body).toBe(201);
    const m = (await db.one<any>(`SELECT metadata FROM envelopes WHERE id = $1`, [c.json().envelope.id])).metadata;
    expect(m).toEqual({ bar: 2, templateId: "tpl-1", agreement: { a: 1 }, clonedFrom: id });
  });
});

describe("firma en persona y otro authMethod", () => {
  it("un authMethod explícito distinto o el rol cc dejan la firma en persona (antes se revertía en silencio)", async () => {
    const id = await draft();
    const rid = uuid();
    const base = { id: rid, name: "Ana", email: "ana@x.test" };
    expect((await putRecipients(id, [{ ...base, authMethod: "in_person", inPerson: { hostUserId: user } }])).statusCode).toBe(200);
    const row = async () => db.one<any>(`SELECT auth_method, in_person_host_user_id AS host FROM recipients WHERE id = $1`, [rid]);
    expect(await row()).toEqual({ auth_method: "in_person", host: user });
    // Sin authMethod ni inPerson: sin cambios.
    expect((await putRecipients(id, [base])).statusCode).toBe(200);
    expect(await row()).toEqual({ auth_method: "in_person", host: user });
    expect((await putRecipients(id, [{ ...base, authMethod: "otp_email" }])).statusCode).toBe(200);
    expect(await row()).toEqual({ auth_method: "otp_email", host: null });
    expect((await putRecipients(id, [{ ...base, authMethod: "in_person", inPerson: { hostUserId: user } }])).statusCode).toBe(200);
    expect((await putRecipients(id, [{ ...base, role: "cc" }])).statusCode).toBe(200);
    expect(await row()).toEqual({ auth_method: "link", host: null });
  });
});

describe("seal-options en un sobre enviado", () => {
  it("el nivel de firma no cambia (409 signature_level_locked); el mismo valor y el sello sí", async () => {
    const id = await draft();
    const put = (payload: object) => app.inject({ method: "PUT", url: `/v1/envelopes/${id}/seal-options`, headers: auth, payload });
    expect((await put({ signatureLevel: "advanced" })).statusCode).toBe(200);
    await db.query(`UPDATE envelopes SET status = 'sent' WHERE id = $1`, [id]);
    const bad = await put({ signatureLevel: "qualified" });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("signature_level_locked");
    expect((await db.one<any>(`SELECT signature_level FROM envelopes WHERE id = $1`, [id])).signature_level).toBe("advanced");
    expect((await put({ signatureLevel: "advanced" })).statusCode).toBe(200);
    expect((await put({ companySealCertificateId: null })).statusCode).toBe(200);
  });
});

describe("revisión con IA contra el playbook", () => {
  it("si los documentos cambian durante la llamada al modelo, el resultado no se guarda (409 documents_changed)", async () => {
    const id = await draft();
    const up = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/documents`, ...multipart(minimalPdf()) });
    expect(up.statusCode, up.body).toBe(201);
    let changeDocs = false;
    const usage = { provider: "mock" as const, model: "test", inputTokens: 10, outputTokens: 5, promptSha256: "" };
    setAiProviderForTests({
      name: "mock",
      model: "test",
      reviewPlaybook: async () => {
        // Mientras el modelo responde, alguien sube otro documento (deja ai_review en NULL).
        if (changeDocs) expect((await app.inject({ method: "POST", url: `/v1/envelopes/${id}/documents`, ...multipart(minimalPdf()) })).statusCode).toBe(201);
        return { result: [], usage } as any;
      },
    } as any);
    const ok = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/ai/review`, headers: auth, payload: {} });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await db.one<any>(`SELECT ai_review FROM envelopes WHERE id = $1`, [id])).ai_review).not.toBeNull();
    changeDocs = true;
    const raced = await app.inject({ method: "POST", url: `/v1/envelopes/${id}/ai/review`, headers: auth, payload: {} });
    expect(raced.statusCode, raced.body).toBe(409);
    expect(raced.json().error.code).toBe("documents_changed");
    expect((await db.one<any>(`SELECT ai_review FROM envelopes WHERE id = $1`, [id])).ai_review).toBeNull();
  });
});
