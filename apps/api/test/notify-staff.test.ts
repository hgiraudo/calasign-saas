import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-notify-staff-"));
delete process.env.DATABASE_URL;

// El SMTP rechaza en el acto una de las direcciones (p. ej. SES en sandbox con un correo sin verificar).
const sent: string[] = [];
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { to: string }) => {
    if (m.to === "rechazada@x.com") throw new Error("554 Message rejected: Email address is not verified");
    sent.push(m.to);
    return { provider: "smtp", messageId: `id-${sent.length}` };
  }),
}));

describe("avisos al equipo (propietarios y administradores)", () => {
  it("una dirección rechazada no hace reintentar el job ni repetir el correo a las demás", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { createJobHandlers } = await import("../src/modules/jobs");
    const { createBlobStore } = await import("../src/infra/storage");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);

    const tenant = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
    // La dirección rechazada va en el medio: antes, la primera recibía el aviso una vez por cada reintento.
    for (const [i, email] of ["ana@x.com", "rechazada@x.com", "zoe@x.com"].entries()) {
      const u = uuidv7();
      await db.query(`INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1,$2,$3,'x', now() + make_interval(secs => $4))`, [u, email, email, i]);
      await db.query(`INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES ($1,$2,'owner', now() + make_interval(secs => $3))`, [tenant, u, i]);
    }
    const env = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'declined')`, [env, tenant]);

    const log = { info() {}, warn() {}, error() {} };
    const handlers = createJobHandlers({ db, blobs: createBlobStore(), log });
    const job = { id: 1, attempts: 1, maxAttempts: 8 };
    await handlers.notify({ kind: "sender_declined", envelopeId: env, tenantId: tenant }, job);

    expect(sent.sort()).toEqual(["ana@x.com", "zoe@x.com"]);
    const rows = await db.query<any>(`SELECT destination, status FROM notifications WHERE envelope_id = $1 ORDER BY destination`, [env]);
    expect(rows).toEqual([
      { destination: "ana@x.com", status: "sent" },
      { destination: "rechazada@x.com", status: "failed" },
      { destination: "zoe@x.com", status: "sent" },
    ]);
    await db.close();
  }, 30_000);
});
