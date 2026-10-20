// URL de firma solo para destinatarios embebidos (o que la página igual autentica) y ?embed=1 sin sesión embebida
// usada no relaja frame-ancestors. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-embed-url-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";
const ORIGIN = "https://app.integrador.test";
const KEY = "cs_test_embed_url_hardening_key";
const auth = { authorization: `Bearer ${KEY}` };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, embed_frame_ancestors) VALUES ($1, $2, 'T', $3)`, [tenant, `t-${tenant.slice(-8)}`, [ORIGIN]]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

type Opts = { embedded?: boolean; authMethod?: string; kyc?: "pending" | "verified" };

async function setup(o: Opts = {}) {
  const { randomToken, sha256Hex, uuidv7, encrypt } = await import("../src/lib/util");
  const envelope = uuidv7();
  const recipient = uuidv7();
  const token = randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [envelope, tenant]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc, embedded, auth_method,
       id_verification_provider, identity_status)
     VALUES ($1,$2,$3,'signer','Ana','ana@x.test','sent',$4,$5,$6,$7,$8,$9)`,
    [recipient, tenant, envelope, sha256Hex(token), encrypt(token), o.embedded ?? false, o.authMethod ?? "link", o.kyc ? "mock" : null, o.kyc ?? null],
  );
  return { envelope, recipient, token };
}

const signingUrl = (envelope: string, recipient: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/recipients/${recipient}/signing-url`, headers: auth, payload });
const frameAncestors = (csp: unknown) => /frame-ancestors ([^;]*)/.exec(String(csp ?? ""))?.[1]?.trim();

describe("POST …/signing-url", () => {
  it("destinatario no embebido solo con el link: 409 not_embedded", async () => {
    const { envelope, recipient } = await setup();
    const r = await signingUrl(envelope, recipient);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("not_embedded");
  });

  it("embebido: 201", async () => {
    const { envelope, recipient } = await setup({ embedded: true });
    const r = await signingUrl(envelope, recipient);
    expect(r.statusCode).toBe(201);
    expect(r.json().tabOnly).toBeUndefined();
  });

  it("no embebido con OTP: 201 para pestaña (y con frameAncestors sigue 409 otp_not_embeddable)", async () => {
    const { envelope, recipient } = await setup({ authMethod: "otp_email" });
    const r = await signingUrl(envelope, recipient);
    expect(r.statusCode).toBe(201);
    expect(r.json().tabOnly).toBe(true);
    const f = await signingUrl(envelope, recipient, { frameAncestors: [ORIGIN] });
    expect(f.statusCode).toBe(409);
    expect(f.json().error.code).toBe("otp_not_embeddable");
  });

  it("verificación de identidad pendiente: 201; ya verificada (la página no la vuelve a pedir): 409", async () => {
    const p = await setup({ kyc: "pending" });
    expect((await signingUrl(p.envelope, p.recipient)).statusCode).toBe(201);
    const v = await setup({ kyc: "verified" });
    const r = await signingUrl(v.envelope, v.recipient);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("not_embedded");
  });
});

describe("?embed=1 y frame-ancestors", () => {
  it("sin sesión embebida usada, ?embed=1 no relaja el CSP", async () => {
    const { token } = await setup({ embedded: true });
    const r = await app.inject({ method: "GET", url: `/s/${token}?embed=1` });
    expect(frameAncestors(r.headers["content-security-policy"])).toBe("'none'");
  });

  it("flujo normal: canje del código → /s/…?embed=1 enmarcable y /embed informa los orígenes", async () => {
    const { envelope, recipient, token } = await setup({ embedded: true });
    const su = await signingUrl(envelope, recipient, { frameAncestors: [ORIGIN] });
    expect(su.statusCode).toBe(201);
    const code = String(su.json().url).split("/embed/")[1];
    const ex = await app.inject({ method: "GET", url: `/embed/${code}` });
    expect(ex.statusCode).toBe(302);
    expect(ex.headers.location).toBe(`/s/${token}?embed=1`);
    const page = await app.inject({ method: "GET", url: String(ex.headers.location) });
    expect(frameAncestors(page.headers["content-security-policy"])).toBe(`'self' ${ORIGIN}`);
    const info = await app.inject({ method: "GET", url: `/v1/signing/${token}/embed` });
    expect(info.json()).toMatchObject({ embedded: true, origins: [ORIGIN] });
  });
});
