// El JSON de evidencia es determinista: un reintento de exportación genera los mismos bytes (Dropbox/Drive deduplican
// por contenido; con generatedAt = ahora, cada reintento dejaba otra copia).
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-evidence-file-"));
delete process.env.DATABASE_URL;

vi.mock("../src/modules/white-label/brand", async (orig) => ({
  ...(await orig<typeof import("../src/modules/white-label/brand")>()),
  brandForEnvelope: async () => ({ baseUrl: "https://app.test", key: "k", productName: null, whiteLabel: false }),
}));

const { evidenceCertificate } = await import("../src/modules/connectors/evidence-file");

function fakeDb(completedAt: Date | null) {
  const envelope = { id: "e1", tenant_id: "t1", brand_id: null, subject: "S", status: "completed", created_at: new Date("2026-01-01T00:00:00Z"), completed_at: completedAt, sha256: "abc" };
  const events = [{ seq: 1, type: "envelope.created", actor_type: "user", actor_id: "u", actor_label: "U", ip: null, user_agent: null, data: {}, occurred_at: new Date("2026-01-02T00:00:00Z"), prev_hash: "0", hash: "h1" }];
  return {
    one: async () => envelope,
    query: async (sql: string) => (sql.includes("envelope_events") ? events : []),
  } as any;
}

describe("certificado de evidencia", () => {
  it("generatedAt es el cierre del sobre: dos generaciones dan los mismos bytes", async () => {
    const db = fakeDb(new Date("2026-01-03T00:00:00Z"));
    const a = await evidenceCertificate(db, "e1", { signedSha256: "abc" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await evidenceCertificate(db, "e1", { signedSha256: "abc" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(a)).generatedAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("sin cierre, el último evento de la cadena", async () => {
    const a = await evidenceCertificate(fakeDb(null), "e1");
    expect(JSON.parse(new TextDecoder().decode(a)).generatedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("solo los eventos hasta el cierre (envelope.completed): una descarga posterior no cambia el archivo", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const db = await createDb();
    try {
      await migrate(db);
      const util = await import("../src/lib/util");
      const { appendEvent, SYSTEM } = await import("../src/infra/evidence");
      const tenant = util.uuidv7();
      const env = util.uuidv7();
      await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
      await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, completed_at) VALUES ($1, $2, 'S', 'completed', now())`, [env, tenant]);
      for (const type of ["envelope.created", "envelope.completed"]) await appendEvent(db, { tenantId: tenant, envelopeId: env, type, actor: SYSTEM, data: {} });
      const a = await evidenceCertificate(db, env);
      await appendEvent(db, { tenantId: tenant, envelopeId: env, type: "document.downloaded", actor: SYSTEM, data: {} });
      const b = await evidenceCertificate(db, env);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(b)).events.map((e: any) => e.type)).toEqual(["envelope.created", "envelope.completed"]);
    } finally {
      await db.close();
    }
  }, 120_000);
});
