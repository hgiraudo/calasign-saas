// Aviso de rechazo de Amazon SES del dominio de correo propio en su propia columna (ses_identity_error_at): la
// verificación por DNS escribe last_error y, si el DNS falla y después se recupera, el aviso de SES no se pierde.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-ses-flag-"));
delete process.env.DATABASE_URL;

/** Respuesta del DNS: los TXT publicados, o un error (SERVFAIL). */
let dns: (name: string) => string[] = () => [];
vi.mock("../src/modules/custom-domains", async (orig) => ({
  ...(await orig<typeof import("../src/modules/custom-domains")>()),
  resolveTxt: async (name: string) => dns(name),
}));

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let cookie: string;
let tenant: string;

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
    payload: { email: "duena@ses.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org SES" },
  });
  expect(res.statusCode).toBe(201);
  cookie = `cs_session=${res.cookies.find((x) => x.name === "cs_session")!.value}`;
  tenant = res.json().tenant.id;
  await db.query(`UPDATE tenants SET billing_plan = 'enterprise' WHERE id = $1`, [tenant]);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const H = () => ({ cookie, origin: "http://localhost:5173" });

describe("dominio de correo: aviso de SES y verificación por DNS", () => {
  it("un error de DNS y su recuperación no borran el aviso de SES; un envío con DKIM aceptado sí", async () => {
    const add = await app.inject({ method: "POST", url: "/v1/settings/email-domains", headers: H(), payload: { domain: "acme-ses.test" } });
    expect(add.statusCode).toBeLessThan(300);
    const row = await db.one<any>(`SELECT * FROM email_domains WHERE tenant_id = $1`, [tenant]);
    // Publica lo que pide el alta (TXT de propiedad y clave DKIM) tal como lo devuelve la API.
    const records = add.json().records as { purpose: string; name: string; value: string }[];
    const published = new Map(records.filter((r) => r.purpose === "ownership" || r.purpose === "dkim").map((r) => [r.name, r.value]));
    const ok = (name: string) => (published.has(name) ? [published.get(name)!] : []);
    dns = ok;
    const verify = () => app.inject({ method: "POST", url: `/v1/settings/email-domains/${row.domain}/verify`, headers: H() });
    expect((await verify()).json()).toMatchObject({ status: "verified", lastError: null, sesIdentityError: null });

    // SES rechaza el dominio: el aviso queda anotado y la API lo devuelve aparte de lastError.
    const { noteSesIdentityRejection, noteDkimSendResult } = await import("../src/notifications/outbound");
    await noteSesIdentityRejection(db, tenant, row.domain);
    const list = async () => (await app.inject({ method: "GET", url: "/v1/settings/email-domains", headers: H() })).json().items[0];
    expect(await list()).toMatchObject({ lastError: null, sesIdentityError: expect.stringMatching(/Amazon SES/) });

    // El DNS falla: last_error lo dice y el aviso de SES sigue.
    dns = () => {
      throw new Error("SERVFAIL");
    };
    const failed = (await verify()).json();
    expect(failed.lastError).toMatch(/DNS/);
    expect(failed.status).toBe("verified");
    expect(failed.sesIdentityError).toMatch(/Amazon SES/);

    // El DNS vuelve: last_error se limpia y el aviso de SES sigue (antes se perdía).
    dns = ok;
    const back = (await verify()).json();
    expect(back.lastError).toBeNull();
    expect(back.sesIdentityError).toMatch(/Amazon SES/);
    expect(back.sesIdentityErrorAt).toBeTruthy();

    // Un correo firmado con DKIM que SES acepta lo borra.
    await noteDkimSendResult(db, tenant, { provider: "ses", messageId: "x", dkimDomain: row.domain } as any);
    expect(await list()).toMatchObject({ lastError: null, sesIdentityError: null, sesIdentityErrorAt: null });
  });
});
