// /v1/xml/verify evalúa la confianza del certificado del firmante (pentest white-box del 31-Oct-2026): antes decía
// `valid: true` con un certificado autofirmado, y cualquiera puede generarse uno con el nombre de cualquier empresa.
// `valid` sigue siendo la integridad (el XML no cambió); `trusted` dice si el certificado llega al almacén de confianza.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLabPki, startLab, type LabPki, type LabServer } from "@calasign/pdf/lab";
import { LocalKeyProvider } from "@calasign/pdf";
import { signXml } from "@calasign/xades";

const dir = mkdtempSync(join(tmpdir(), "calasign-xml-trust-"));
process.env.DATA_DIR = join(dir, "data");
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let pki: LabPki;
let ajena: LabPki;
let server: LabServer;
let cookie: string;
const ORIGIN = { origin: "http://localhost:5173" };
const ECF = `<?xml version="1.0" encoding="utf-8"?><ECF><Encabezado><Version>1.0</Version><IdDoc><TipoeCF>31</TipoeCF><eNCF>E310000000099</eNCF></IdDoc><Totales><MontoTotal>2360.00</MontoTotal></Totales></Encabezado></ECF>`;

beforeAll(async () => {
  ({ pki, server } = await startLab());
  // Otra PKI con la misma forma (raíz → intermedia → hoja) cuya raíz NO está en el almacén de confianza.
  ajena = await createLabPki(server.url);
  mkdirSync(join(dir, "trust"));
  writeFileSync(join(dir, "trust", "root.pem"), pki.root.certPem);
  process.env.TRUST_STORE_DIR = join(dir, "trust");

  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();

  const tenantId = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1,'xml-trust','XML','enterprise')`, [tenantId]);
  const userId = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,'xml@example.com','Ana','scrypt$x')`, [userId]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenantId, userId]);
  cookie = util.randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method, ip, user_agent, authenticated_at, last_seen_at)
     VALUES ($1,$2,$3, now() + interval '1 day', 'password', '203.0.113.7', 'vitest', now(), now())`,
    [util.sha256Hex(cookie), userId, tenantId],
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await server?.close();
});

async function verify(xml: string) {
  const res = await app.inject({ method: "POST", url: "/v1/xml/verify", cookies: { cs_session: cookie }, headers: ORIGIN, payload: { xml } });
  expect(res.statusCode).toBe(200);
  return res.json() as { valid: boolean; trusted: boolean; trustWarnings: string[]; signer: { subject: string } | null; errors: string[] };
}

describe("/v1/xml/verify: confianza del certificado", () => {
  it("un certificado de una CA del almacén: valid y trusted, sin advertencias", async () => {
    const id = await pki.issue("Empresa Facturadora S.A.S.");
    const xml = await signXml(ECF, new LocalKeyProvider("xml", id.keyPem, id.certPem + pki.intermediate.certPem + pki.root.certPem), {
      profile: "xades-bes",
      includeChain: true,
    });
    const v = await verify(xml);
    expect(v).toMatchObject({ valid: true, trusted: true, trustWarnings: [], errors: [] });
    expect(v.signer?.subject).toContain("Empresa Facturadora");
  });

  it("la misma empresa con un certificado de una CA desconocida: valid (no cambió) pero no trusted, y dice por qué", async () => {
    const id = await ajena.issue("Empresa Facturadora S.A.S.");
    const xml = await signXml(ECF, new LocalKeyProvider("xml", id.keyPem, id.certPem + ajena.intermediate.certPem + ajena.root.certPem), {
      profile: "xades-bes",
      includeChain: true,
    });
    const v = await verify(xml);
    expect(v.valid).toBe(true);
    expect(v.signer?.subject).toContain("Empresa Facturadora");
    expect(v.trusted).toBe(false);
    expect(v.trustWarnings).toContain("la autoridad certificante no está en el almacén de confianza");
  });

  it("un certificado autofirmado: no trusted", async () => {
    // La raíz ajena es autofirmada y tiene su clave: es el caso de quien se genera su propio certificado.
    const xml = await signXml(ECF, new LocalKeyProvider("xml", ajena.root.keyPem, ajena.root.certPem), { profile: "xades-bes" });
    const v = await verify(xml);
    expect(v.valid).toBe(true);
    expect(v.trusted).toBe(false);
    expect(v.trustWarnings.length).toBeGreaterThan(0);
  });

  it("sin la raíz en KeyInfo (hoja + intermedia) igual llega a la raíz del almacén", async () => {
    const id = await pki.issue("Otra Empresa S.A.");
    const xml = await signXml(ECF, new LocalKeyProvider("xml", id.keyPem, id.certPem + pki.intermediate.certPem), {
      profile: "dgii-ecf",
      includeChain: true,
    });
    expect(await verify(xml)).toMatchObject({ valid: true, trusted: true, trustWarnings: [] });
  });

  it("sólo la hoja en KeyInfo (lo habitual en DGII): no se puede afirmar la confianza y lo dice", async () => {
    const id = await pki.issue("Otra Empresa S.A.");
    const xml = await signXml(ECF, new LocalKeyProvider("xml", id.keyPem, id.certPem + pki.intermediate.certPem), { profile: "dgii-ecf" });
    const v = await verify(xml);
    expect(v).toMatchObject({ valid: true, trusted: false, trustWarnings: ["no se pudo completar la cadena de certificación"] });
  });

  it("sin firma: ni valid ni trusted", async () => {
    const v = await verify(ECF);
    expect(v).toMatchObject({ valid: false, trusted: false });
    expect(v.errors).toContain("sin ds:Signature");
  });
});
