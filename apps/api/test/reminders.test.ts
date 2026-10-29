import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-reminders-"));
delete process.env.DATABASE_URL;

describe("recordatorios automáticos y aviso de vencimiento", () => {
  it("encola recordatorio cada N días y un solo aviso de vencimiento", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { runAutomaticReminders } = await import("../src/modules/reminders");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);

    const tenant = uuidv7();
    const env = uuidv7();
    const rec = uuidv7();
    const now = new Date("2026-11-10T12:00:00Z");
    const days = (n: number) => new Date(now.getTime() + n * 86400_000).toISOString();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
    await db.query(
      `INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, expires_at, reminder_every_days, expiry_warning_days)
       VALUES ($1, $2, 'S', 'sent', $3, $4, 2, 6)`,
      [env, tenant, days(-3), days(5)],
    );
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, status, sent_at) VALUES ($1,$2,$3,'signer',1,'Ana','a@x.com','sent',$4)`,
      [rec, tenant, env, days(-3)],
    );

    const jobs = async () => (await db.query<any>(`SELECT payload FROM jobs ORDER BY id`)).map((j) => j.payload.kind);

    expect(await runAutomaticReminders(db, now)).toEqual({ reminded: 1, warned: 1 });
    expect(await jobs()).toEqual(["reminder", "expiry_warning"]);

    // Mismo momento otra vez: nada nuevo.
    expect(await runAutomaticReminders(db, now)).toEqual({ reminded: 0, warned: 0 });
    // Un día después: todavía no tocan (cada 2 días) y el aviso ya salió.
    expect(await runAutomaticReminders(db, new Date(now.getTime() + 86400_000))).toEqual({ reminded: 0, warned: 0 });
    // Dos días después: segundo recordatorio.
    expect((await runAutomaticReminders(db, new Date(now.getTime() + 2 * 86400_000 + 1000))).reminded).toBe(1);
    expect(await jobs()).toEqual(["reminder", "expiry_warning", "reminder"]);
    // Pasado el vencimiento (aunque el barrido no lo haya marcado 'expired'): sin recordatorio.
    expect((await runAutomaticReminders(db, new Date(now.getTime() + 6 * 86400_000))).reminded).toBe(0);

    const ev = await db.query<any>(`SELECT type, data FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [env]);
    expect(ev.map((e) => e.type)).toEqual(["envelope.reminded", "envelope.expiry_warning", "envelope.reminded"]);
    expect(ev[0].data.automatic).toBe(true);
    await db.close();
  }, 60_000);

  it("el tope de recordatorios sin vencimiento cuenta solo los que se encolaron", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { runAutomaticReminders } = await import("../src/modules/reminders");
    const { enqueue } = await import("../src/infra/queue");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);
    try {
      const tenant = uuidv7();
      const env = uuidv7();
      const rec = uuidv7();
      const now = new Date("2026-12-10T12:00:00Z");
      const ago = (n: number) => new Date(now.getTime() - n * 86400_000).toISOString();
      await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
      await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, reminder_every_days) VALUES ($1, $2, 'S', 'sent', $3, 2)`, [
        env,
        tenant,
        ago(3),
      ]);
      await db.query(
        `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, status, sent_at) VALUES ($1,$2,$3,'signer',1,'Ana','a@x.com','sent',$4)`,
        [rec, tenant, env, ago(3)],
      );
      // Ya hay un recordatorio de hoy para este destinatario (p. ej. otro barrido): la clave del día lo deduplica.
      expect(await enqueue(db, "notify", { kind: "reminder" }, { dedupeKey: `auto-reminder:${rec}:2026-12-10` })).toBe(true);
      expect(await enqueue(db, "notify", { kind: "reminder" }, { dedupeKey: `auto-reminder:${rec}:2026-12-10` })).toBe(false);

      expect((await runAutomaticReminders(db, now)).reminded).toBe(0);
      expect((await db.one<any>(`SELECT auto_reminders_sent FROM recipients WHERE id = $1`, [rec]))?.auto_reminders_sent).toBe(0);
      expect(await db.query(`SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.reminded'`, [env])).toEqual([]);

      // Dos días después sí se encola y cuenta.
      expect((await runAutomaticReminders(db, new Date(now.getTime() + 2 * 86400_000 + 1000))).reminded).toBe(1);
      expect((await db.one<any>(`SELECT auto_reminders_sent FROM recipients WHERE id = $1`, [rec]))?.auto_reminders_sent).toBe(1);
    } finally {
      await db.close();
    }
  }, 60_000);
});
