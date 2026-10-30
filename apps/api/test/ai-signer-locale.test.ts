// Asistente de IA del firmante: el aviso y el descargo siguen el idioma que el firmante eligió en la página (?locale=),
// no solo el del destinatario. Antes, con la página en inglés, el aviso seguía en castellano. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-ai-signer-locale-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let SIGNER_NOTICE: Record<string, string>;
let DISCLAIMER_EN = "";
const token = "tok_ai_locale_0123456789abcdef";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const util = await import("../src/lib/util");
  const svc = await import("../src/modules/ai/service");
  SIGNER_NOTICE = svc.SIGNER_NOTICE;
  DISCLAIMER_EN = svc.disclaimerFor("en");
  db = await createDb();
  await migrate(db);
  const tenant = util.uuidv7();
  const env = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, locale) VALUES ($1,$2,'Contrato','sent','es')`, [env, tenant]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, locale, access_token_hash, status) VALUES ($1,$2,$3,'signer','Firmante','f@example.test','es',$4,'sent')`,
    [util.uuidv7(), tenant, env, util.sha256Hex(token)],
  );
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const info = async (qs = "") => {
  const r = await app.inject({ method: "GET", url: `/v1/signing/${token}/ai${qs}` });
  expect(r.statusCode).toBe(200);
  return r.json() as { notice: string; disclaimer: string };
};

describe("idioma del asistente de IA del firmante", () => {
  it("sin ?locale= usa el del destinatario", async () => {
    expect((await info()).notice).toBe(SIGNER_NOTICE.es);
  });

  it("con ?locale= de la página, el aviso y el descargo salen en ese idioma", async () => {
    const en = await info("?locale=en");
    expect(en.notice).toBe(SIGNER_NOTICE.en);
    expect(en.disclaimer).toBe(DISCLAIMER_EN);
    expect((await info("?locale=pt-BR")).notice).toBe(SIGNER_NOTICE["pt-BR"]);
  });

  it("un idioma no soportado (o un nombre heredado del prototipo) no se usa: queda el del destinatario", async () => {
    expect((await info("?locale=fr")).notice).toBe(SIGNER_NOTICE.es);
    expect((await info("?locale=constructor")).notice).toBe(SIGNER_NOTICE.es);
  });
});
