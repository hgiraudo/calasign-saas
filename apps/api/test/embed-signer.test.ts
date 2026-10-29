// Firma embebida desde la página del firmante: quien abrió el link con una URL de firma embebida (embed_session usada)
// no puede delegar aunque no se haya creado como embebido, y la página vuelve a poder enmarcarse al regresar de un
// proveedor de pago o identidad (sin embed=1). App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-embed-signer-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let tenant = "";
const ORIGIN = "https://app.integrador.test";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, embed_frame_ancestors) VALUES ($1, $2, 'T', $3)`, [tenant, `t-${tenant.slice(-8)}`, [ORIGIN]]);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

/** Sobre enviado con un firmante por link; con `session`, abierto alguna vez desde una URL de firma embebida. */
async function setup(o: { session?: "iframe" | "tab"; usedHoursAgo?: number } = {}) {
  const { randomToken, sha256Hex, uuidv7, encrypt } = await import("../src/lib/util");
  const envelope = uuidv7();
  const recipient = uuidv7();
  const token = randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [envelope, tenant]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc)
     VALUES ($1,$2,$3,'signer','Ana','ana@x.test','sent',$4,$5)`,
    [recipient, tenant, envelope, sha256Hex(token), encrypt(token)],
  );
  if (o.session) {
    const ago = `${o.usedHoursAgo ?? 0} hours`;
    await db.query(
      `INSERT INTO embed_sessions (id, tenant_id, envelope_id, recipient_id, code_hash, frame_ancestors, expires_at, used_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '5 minutes', now() - $7::interval, now() - $7::interval)`,
      [uuidv7(), tenant, envelope, recipient, sha256Hex(randomToken()), o.session === "tab" ? ["'none'"] : [ORIGIN], ago],
    );
  }
  return { envelope, recipient, token };
}

const delegate = (token: string) =>
  app.inject({ method: "POST", url: `/v1/signing/${token}/delegate`, payload: { name: "Beto", email: "beto@x.test", reason: "Vacaciones" } });
const frameAncestors = (csp: unknown) => /frame-ancestors ([^;]*)/.exec(String(csp ?? ""))?.[1]?.trim();

describe("delegar con una sesión embebida", () => {
  it("con una embed_session usada: canDelegate false y el endpoint lo rechaza", async () => {
    const { token } = await setup({ session: "iframe" });
    const s = await app.inject({ method: "GET", url: `/v1/signing/${token}` });
    expect(s.statusCode).toBe(200);
    expect(s.json().canDelegate).toBe(false);
    const d = await delegate(token);
    expect(d.statusCode).toBe(403);
    expect(d.json().error.message).toMatch(/embebido/);
  });

  it('también abierta "para pestaña" (vuelve al returnUrl del integrador)', async () => {
    const { token } = await setup({ session: "tab" });
    expect((await app.inject({ method: "GET", url: `/v1/signing/${token}` })).json().canDelegate).toBe(false);
    expect((await delegate(token)).statusCode).toBe(403);
  });

  it("con una sesión embebida de hace más de 24 h (después abrió el link del correo) puede delegar", async () => {
    const { token } = await setup({ session: "iframe", usedHoursAgo: 30 });
    expect((await app.inject({ method: "GET", url: `/v1/signing/${token}` })).json().canDelegate).toBe(true);
    expect((await delegate(token)).statusCode).toBe(200);
  });

  it("sin sesión embebida sigue pudiendo delegar", async () => {
    const { token } = await setup();
    expect((await app.inject({ method: "GET", url: `/v1/signing/${token}` })).json().canDelegate).toBe(true);
    const d = await delegate(token);
    expect(d.statusCode).toBe(200);
    expect(d.json().delegated).toBe(true);
  });
});

describe("frame-ancestors de /s/:token", () => {
  it("vuelta de un proveedor (sin embed=1) con sesión embebida usada: los orígenes de la sesión", async () => {
    const { token } = await setup({ session: "iframe" });
    for (const q of ["?payment=success", "?identity=return", ""]) {
      const r = await app.inject({ method: "GET", url: `/s/${token}${q}` });
      expect(frameAncestors(r.headers["content-security-policy"])).toBe(`'self' ${ORIGIN}`);
      expect(r.headers["x-frame-options"]).toBeUndefined();
    }
  });

  it("sin sesión embebida (o vencida, o para pestaña) no se abre", async () => {
    for (const o of [{}, { session: "iframe" as const, usedHoursAgo: 30 }, { session: "tab" as const }]) {
      const { token } = await setup(o);
      const r = await app.inject({ method: "GET", url: `/s/${token}?payment=success` });
      expect(frameAncestors(r.headers["content-security-policy"])).toBe("'none'");
    }
  });

  it("con embed=1 sigue como antes", async () => {
    const { token } = await setup({ session: "iframe" });
    const r = await app.inject({ method: "GET", url: `/s/${token}?embed=1` });
    expect(frameAncestors(r.headers["content-security-policy"])).toBe(`'self' ${ORIGIN}`);
  });
});
