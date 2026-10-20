import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// config.ts lee el entorno al importarse: DATA_DIR propio y PGlite (sin DATABASE_URL).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-queue-"));
delete process.env.DATABASE_URL;

const until = async (cond: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("cola de trabajos", () => {
  it("un intento que el sweep ya devolvió a la cola no pisa el estado del intento siguiente", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { enqueue, requeueStuckJobs, startWorker } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);

    // Cada intento queda colgado hasta que el test lo suelta (como un SMTP que no responde).
    const pending: { attempts: number; release: (ok: boolean) => void }[] = [];
    const log = { info() {}, error() {} };
    const worker = startWorker(db, {
      handlers: {
        notify: (_p: unknown, job: { attempts: number }) =>
          new Promise<void>((resolve, reject) => pending.push({ attempts: job.attempts, release: (ok) => (ok ? resolve() : reject(new Error("timeout SMTP"))) })),
      } as any,
      pollMs: 20,
      log,
    });
    try {
      await enqueue(db, "notify", { kind: "invite" });
      await until(async () => pending.length === 1);

      // El primer intento lleva más de 10 minutos: el sweep lo devuelve a la cola y otro worker lo toma.
      await db.query(`UPDATE jobs SET locked_at = now() - interval '11 minutes'`);
      await requeueStuckJobs(db);
      await until(async () => pending.length === 2);
      expect(pending[1].attempts).toBe(2);

      // El primer intento termina tarde con error: no puede reprogramar el job mientras corre el segundo.
      pending[0].release(false);
      await new Promise((r) => setTimeout(r, 200));
      const mid = await db.one<any>(`SELECT status, attempts FROM jobs`);
      expect(mid).toMatchObject({ status: "running", attempts: 2 });
      expect(pending.length).toBe(2);

      // El segundo intento termina bien: el job queda hecho.
      pending[1].release(true);
      await until(async () => (await db.one<any>(`SELECT status FROM jobs`))?.status === "done");
    } finally {
      for (const p of pending) p.release(true);
      await worker.stop();
      await db.close();
    }
  }, 180_000);

  it("un job vivo renueva su toma: el sweep no lo da por muerto aunque tarde más de 10 minutos", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { enqueue, requeueStuckJobs, startWorker } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);

    let release: () => void = () => {};
    let calls = 0;
    const worker = startWorker(db, {
      handlers: {
        finalize: () => {
          calls++;
          return new Promise<void>((resolve) => (release = resolve));
        },
      } as any,
      pollMs: 20,
      heartbeatMs: 50,
      log: { info() {}, error() {} },
    });
    try {
      await enqueue(db, "finalize", { envelopeId: "x" }, { maxAttempts: 1 });
      await until(async () => calls === 1);

      // Último intento, vivo, que ya lleva 11 minutos: el latido renueva la toma antes de que pase el sweep.
      await db.query(`UPDATE jobs SET locked_at = now() - interval '11 minutes'`);
      await new Promise((r) => setTimeout(r, 300));
      const gaveUp = await requeueStuckJobs(db);
      expect(gaveUp).toEqual([]);
      expect(await db.one<any>(`SELECT status, attempts FROM jobs`)).toMatchObject({ status: "running", attempts: 1 });

      release();
      await until(async () => (await db.one<any>(`SELECT status FROM jobs`))?.status === "done");
      expect(calls).toBe(1);
    } finally {
      release();
      await worker.stop();
      await db.close();
    }
  }, 180_000);

  it("purga terminados viejos sin soltar claves que todavía deduplican", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { purgeFinishedJobs } = await import("../src/infra/queue");
    const { uuidv7 } = await import("../src/lib/util");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);
    try {
      const tenant = uuidv7();
      const live = uuidv7();
      const done = uuidv7();
      await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'T')`, [tenant, `t-${tenant.slice(-8)}`]);
      await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'vivo', 'sent'), ($3, $2, 'listo', 'completed')`, [live, tenant, done]);
      const add = (key: string | null, envelopeId: string | null, status: string, daysAgo: number) =>
        db.query(
          `INSERT INTO jobs (queue, payload, status, dedupe_key, finished_at) VALUES ('notify', $1, $2, $3, CASE WHEN $2 IN ('done','failed') THEN now() - make_interval(days => $4::int) END)`,
          [JSON.stringify({ kind: "invite", envelopeId }), status, key, daysAgo],
        );
      await add("invite:vivo", live, "done", 40); // sobre vivo: la clave sigue deduplicando
      await add("finalize:vivo", live, "failed", 40);
      await add("invite:listo", done, "done", 40); // sobre terminado: purgable
      await add(null, live, "done", 40); // sin clave: purgable
      await add("auto-reminder:r1:2026-01-01", live, "done", 40); // clave del día: purgable
      await add("whdel:x", null, "done", 40); // id único, sin sobre: purgable
      await add("invite:reciente", done, "done", 5); // dentro del plazo
      await add("invite:pendiente", done, "pending", 40); // no terminado

      expect(await purgeFinishedJobs(db, { olderThanDays: 30, batch: 2 })).toBe(4);
      const left = (await db.query<any>(`SELECT dedupe_key FROM jobs ORDER BY dedupe_key`)).map((r) => r.dedupe_key);
      expect(left).toEqual(["finalize:vivo", "invite:pendiente", "invite:reciente", "invite:vivo"]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("toma por prioridad: restablecimiento y finalización antes que avisos, y el masivo al final", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { enqueue, startWorker } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);
    const order: string[] = [];
    const runAt = new Date(Date.now() - 1000);
    await enqueue(db, "bulk", { bulkSendId: "b" }, { runAt });
    await enqueue(db, "notify", { kind: "completed" }, { runAt });
    await enqueue(db, "notify", { kind: "invite" }, { runAt });
    await enqueue(db, "finalize", { envelopeId: "e" }, { runAt });
    await enqueue(db, "notify", { kind: "password_reset", userId: "u", tokenEnc: "secreto" }, { runAt });
    const worker = startWorker(db, {
      handlers: {
        notify: async (p: any) => void order.push(p.kind),
        finalize: async () => void order.push("finalize"),
        bulk: async () => void order.push("bulk"),
      } as any,
      concurrency: 1,
      pollMs: 20,
      log: { info() {}, error() {} },
    });
    try {
      await until(async () => order.length === 5);
      expect(order).toEqual(["password_reset", "finalize", "invite", "completed", "bulk"]);
      await until(async () => (await db.one<any>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'done'`))?.n === 5);
      // El token cifrado no queda en el job terminado.
      const pr = await db.one<any>(`SELECT payload FROM jobs WHERE payload->>'kind' = 'password_reset'`);
      expect(pr.payload).toEqual({ kind: "password_reset", userId: "u" });
    } finally {
      await worker.stop();
      await db.close();
    }
  }, 60_000);

  it("terminado pero sin registrar: reintenta, marca 'unrecorded' y el sweep lo pasa a done sin repetirlo", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { enqueue, requeueStuckJobs, startWorker } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);
    let doneTries = 0;
    // La base rechaza el registro de 'done' (como una caída breve justo al terminar).
    const flaky = {
      ...db,
      query: (sql: string, params?: unknown[]) => {
        if (/SET status = 'done'/.test(sql) && /attempts = \$2/.test(sql)) {
          doneTries++;
          return Promise.reject(new Error("conexión perdida"));
        }
        return db.query(sql, params);
      },
    } as typeof db;
    let calls = 0;
    const worker = startWorker(flaky, {
      handlers: { notify: async () => void calls++ } as any,
      pollMs: 20,
      recordRetryMs: [10, 10],
      log: { info() {}, error() {} },
    });
    try {
      await enqueue(db, "notify", { kind: "invite" });
      await until(async () => (await db.one<any>(`SELECT locked_by FROM jobs`))?.locked_by === "unrecorded");
      expect(doneTries).toBe(3);
      expect((await db.one<any>(`SELECT status FROM jobs`))?.status).toBe("running");
      expect(await requeueStuckJobs(db)).toEqual([]);
      expect(await db.one<any>(`SELECT status, attempts FROM jobs`)).toMatchObject({ status: "done", attempts: 1 });
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toBe(1);
    } finally {
      await worker.stop();
      await db.close();
    }
  }, 60_000);

  it("last_error y logs sin correos ni teléfonos", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { enqueue, startWorker } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);
    const logged: string[] = [];
    const worker = startWorker(db, {
      handlers: {
        notify: async () => {
          throw new Error("550 <ana.perez@example.com>: user unknown; sms +54 9 11 5555-1234 rechazado");
        },
      } as any,
      pollMs: 20,
      log: { info() {}, error: (o: object) => void logged.push(JSON.stringify(o)) },
    });
    try {
      await enqueue(db, "notify", { kind: "invite" }, { maxAttempts: 1 });
      await until(async () => (await db.one<any>(`SELECT status FROM jobs`))?.status === "failed");
      const { last_error } = (await db.one<any>(`SELECT last_error FROM jobs`))!;
      expect(last_error).toContain("user unknown");
      expect(last_error).not.toContain("ana.perez@example.com");
      expect(last_error).not.toContain("5555-1234");
      expect(logged.join("\n")).not.toContain("ana.perez@example.com");
    } finally {
      await worker.stop();
      await db.close();
    }
  }, 60_000);

  it("apagado: con tope de espera, el job en curso vuelve a 'pending' sin descontar el intento", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { enqueue, startWorker } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);
    let started = false;
    let swept = 0;
    let sweepAborted = false;
    const worker = startWorker(db, {
      handlers: { notify: () => ((started = true), new Promise<void>(() => {})) } as any,
      pollMs: 20,
      shutdownGraceMs: 300,
      onTick: async (signal) => {
        swept++;
        await new Promise<void>((r) => signal.addEventListener("abort", () => ((sweepAborted = true), r()), { once: true }));
      },
      log: { info() {}, error() {} },
    });
    await enqueue(db, "notify", { kind: "invite" });
    // El barrido colgado no frena la toma de jobs.
    await until(async () => started);
    expect(swept).toBe(1);
    const t0 = Date.now();
    await worker.stop();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(sweepAborted).toBe(true);
    expect(await db.one<any>(`SELECT status, attempts, locked_by FROM jobs`)).toMatchObject({ status: "pending", attempts: 1, locked_by: null });
    await db.close();
  }, 60_000);
});
