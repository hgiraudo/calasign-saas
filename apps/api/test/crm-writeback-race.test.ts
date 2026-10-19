// Write-back de CRM: los trabajos "sent" y "completed" del mismo vínculo corren a la vez y el CRM tiene que quedar en
// el estado final, para todos los proveedores CRM (la lógica es común). PGlite propio y un fetch falso que aplica la
// escritura de "sent" tarde (llega al CRM después que la de "completed").
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-crm-race-"));
delete process.env.DATABASE_URL;

const SENT = "S-ENVIADO";
const DONE = "S-FIRMADO";

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
let db: Db;
let tenant: string;
let envelope: string;
const real = globalThis.fetch;

const PROVIDERS = [
  { provider: "hubspot", auth: "token", creds: { token: "hs-token" }, config: {}, objectType: "deal" },
  { provider: "salesforce", auth: "oauth", creds: { access_token: "sf", expires_at: null }, config: { instanceUrl: "https://acme.my.salesforce.com" }, objectType: "opportunity" },
  { provider: "zoho", auth: "oauth", creds: { access_token: "zo", expires_at: Date.now() + 3_600_000 }, config: { apiDomain: "https://www.zohoapis.com", product: "crm" }, objectType: "deal" },
  { provider: "pipedrive", auth: "oauth", creds: { access_token: "pd", expires_at: Date.now() + 3_600_000 }, config: { apiDomain: "https://acme.pipedrive.com" }, objectType: "deal" },
] as const;

/** CRM falso: guarda el último valor de estado aplicado. La escritura de "sent" se aplica 150 ms después. */
function fakeCrm() {
  const state = { applied: [] as string[], sentInFlight: null as null | (() => void) };
  let signal: () => void = () => {};
  const sentStarted = new Promise<void>((r) => (signal = r));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/dealFields")) return json({ success: true, data: [{ key: "calasign_status", name: "Estado", field_type: "varchar" }] });
    const body = typeof init?.body === "string" ? init.body : "";
    const method = init?.method ?? "GET";
    if (method === "PUT" || method === "PATCH") {
      const value = body.includes(DONE) ? DONE : body.includes(SENT) ? SENT : "?";
      if (value === SENT) {
        signal();
        await new Promise((r) => setTimeout(r, 150));
      }
      state.applied.push(value);
      return json({ success: true, data: [{ status: "success", code: "SUCCESS" }] });
    }
    return json({ success: true, data: [] });
  }) as typeof fetch;
  return { state, sentStarted };
}

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  envelope = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'completed')`, [envelope, tenant]);
});
afterAll(async () => {
  globalThis.fetch = real;
  await db?.close();
});

async function setup(p: (typeof PROVIDERS)[number]) {
  const { encrypt, uuidv7 } = await import("../src/lib/util");
  const conn = uuidv7();
  const mapping = uuidv7();
  const link = uuidv7();
  await db.query(
    `INSERT INTO crm_connections (id, tenant_id, provider, name, auth_type, credentials_enc, config) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [conn, tenant, p.provider, p.provider, p.auth, encrypt(JSON.stringify(p.creds)), JSON.stringify(p.config)],
  );
  await db.query(`INSERT INTO crm_mappings (id, tenant_id, connection_id, name, object_type, write_back) VALUES ($1,$2,$3,'m',$4,$5)`, [
    mapping,
    tenant,
    conn,
    p.objectType,
    JSON.stringify({ statusProperty: "calasign_status", statusValues: { sent: SENT, completed: DONE }, attachPdf: false }),
  ]);
  await db.query(`INSERT INTO crm_links (id, tenant_id, connection_id, mapping_id, envelope_id, object_type, object_id) VALUES ($1,$2,$3,$4,$5,$6,'42')`, [
    link,
    tenant,
    conn,
    mapping,
    envelope,
    p.objectType,
  ]);
  const run = async (event: string) => {
    const id = uuidv7();
    await db.query(
      `INSERT INTO crm_runs (id, tenant_id, connection_id, mapping_id, link_id, envelope_id, kind, event, object_type, object_id) VALUES ($1,$2,$3,$4,$5,$6,'write_back',$7,$8,'42')`,
      [id, tenant, conn, mapping, link, envelope, event, p.objectType],
    );
    return id;
  };
  return { link, run };
}

describe("write-back de CRM con trabajos en paralelo", () => {
  for (const p of PROVIDERS) {
    it(`${p.provider}: "sent" que llega al CRM después de "completed" no deja el estado en "sent"`, async () => {
      const { handleCrmJob } = await import("../src/modules/crm");
      const { link, run } = await setup(p);
      const crm = fakeCrm();
      const sentRun = await run("sent");
      const doneRun = await run("completed");
      const blobs = {} as any;
      const sentJob = handleCrmJob({ db, blobs }, { runId: sentRun });
      await crm.sentStarted; // "sent" ya reclamó el vínculo y su escritura está en vuelo
      await Promise.all([handleCrmJob({ db, blobs }, { runId: doneRun }), sentJob]);
      expect(crm.state.applied.at(-1)).toBe(DONE);
      expect((await db.one<any>(`SELECT last_status FROM crm_links WHERE id = $1`, [link]))!.last_status).toBe("completed");
      const runs = await db.query<any>(`SELECT event, status, detail FROM crm_runs WHERE link_id = $1`, [link]);
      expect(runs.every((r) => r.status === "succeeded")).toBe(true);
      expect(runs.find((r) => r.event === "sent")!.detail.statusRewritten?.value).toBe(DONE);
    });

    it(`${p.provider}: un "sent" que llega con el estado final ya escrito se omite`, async () => {
      const { handleCrmJob } = await import("../src/modules/crm");
      const { link, run } = await setup(p);
      const crm = fakeCrm();
      await handleCrmJob({ db, blobs: {} as any }, { runId: await run("completed") });
      const late = await run("sent");
      await handleCrmJob({ db, blobs: {} as any }, { runId: late });
      expect(crm.state.applied).toEqual([DONE]);
      expect((await db.one<any>(`SELECT last_status FROM crm_links WHERE id = $1`, [link]))!.last_status).toBe("completed");
      expect((await db.one<any>(`SELECT detail FROM crm_runs WHERE id = $1`, [late]))!.detail.skipped).toMatch(/completed/);
    });
  }
});
