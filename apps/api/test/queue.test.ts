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
      // Lista blanca: claves no listadas son purgables aunque el sobre siga vivo.
      await add("whfan:vivo:3:envelope.sent", live, "done", 40);
      await add("finalize:vivo:retry:abc", live, "done", 40); // reintento manual con clave única
      await add("exp:c1:vivo:1700000000000", live, "done", 40); // reintento manual de exportación
      await add("exp:c1:vivo", live, "done", 40); // permanente
      await add("expiry-warning:r1:2026-01-01T00:00:00.000Z:0", live, "done", 40); // permanente

      expect(await purgeFinishedJobs(db, { olderThanDays: 30, batch: 2 })).toBe(7);
      const left = (await db.query<any>(`SELECT dedupe_key FROM jobs ORDER BY dedupe_key`)).map((r) => r.dedupe_key);
      expect(left).toEqual(["exp:c1:vivo", "expiry-warning:r1:2026-01-01T00:00:00.000Z:0", "finalize:vivo", "invite:pendiente", "invite:reciente", "invite:vivo"]);

      // Las retenidas quedan marcadas y no se vuelven a revisar hasta otro plazo.
      const marked = await db.query<any>(`SELECT dedupe_key FROM jobs WHERE purge_checked_at IS NOT NULL ORDER BY dedupe_key`);
      expect(marked.map((r) => r.dedupe_key)).toEqual(["exp:c1:vivo", "expiry-warning:r1:2026-01-01T00:00:00.000Z:0", "finalize:vivo", "invite:vivo"]);
      await db.query(`UPDATE envelopes SET status = 'completed' WHERE id = $1`, [live]);
      expect(await purgeFinishedJobs(db, { olderThanDays: 30 })).toBe(0);
      // Pasado otro plazo desde la revisión, con el sobre ya terminado, se purgan.
      await db.query(`UPDATE jobs SET purge_checked_at = now() - interval '31 days' WHERE purge_checked_at IS NOT NULL`);
      expect(await purgeFinishedJobs(db, { olderThanDays: 30 })).toBe(4);

      // Si otro proceso tiene el candado de la purga, esta pasada no hace nada.
      await add("whdel:y", null, "done", 40);
      const locked = {
        ...db,
        tx: (fn: any) =>
          db.tx((t) => fn({ ...t, one: (sql: string, params?: unknown[]) => (/pg_try_advisory_xact_lock/.test(sql) ? Promise.resolve({ ok: false }) : t.one(sql, params)) })),
      } as typeof db;
      expect(await purgeFinishedJobs(locked, { olderThanDays: 30 })).toBe(0);
      expect(await purgeFinishedJobs(db, { olderThanDays: 30 })).toBe(1);
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
    // Vuelve con run_at ~30 s en el futuro: otro worker no lo toma mientras el handler local sigue.
    expect(await db.one<any>(`SELECT status, attempts, locked_by, run_at > now() + interval '20 seconds' AS later FROM jobs`)).toMatchObject({
      status: "pending",
      attempts: 1,
      locked_by: null,
      later: true,
    });
    await db.close();
  }, 60_000);

  it("apagado: un job en su último intento no vuelve a la cola, y uno ya terminado (registrando 'done') tampoco", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { enqueue, startWorker, UNRECORDED } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);
    const started = new Set<string>();
    // El registro de 'done' del job "b" falla siempre (base caída justo al terminar): recordDone queda reintentando.
    const flaky = {
      ...db,
      query: (sql: string, params?: unknown[]) =>
        /SET status = 'done'/.test(sql) && /attempts = \$2/.test(sql) && params?.[0] === bId ? Promise.reject(new Error("conexión perdida")) : db.query(sql, params),
    } as typeof db;
    await enqueue(db, "notify", { kind: "a" }, { maxAttempts: 1 });
    await enqueue(db, "notify", { kind: "b" });
    const bId = (await db.one<any>(`SELECT id FROM jobs WHERE payload->>'kind' = 'b'`))!.id;
    const worker = startWorker(flaky, {
      handlers: {
        notify: (p: any) => (started.add(p.kind), p.kind === "b" ? Promise.resolve() : new Promise<void>(() => {})),
      } as any,
      pollMs: 20,
      shutdownGraceMs: 300,
      recordRetryMs: [60_000],
      log: { info() {}, error() {} },
    });
    await until(async () => started.size === 2);
    await new Promise((r) => setTimeout(r, 100));
    await worker.stop();
    const rows = await db.query<any>(`SELECT payload->>'kind' AS kind, status, locked_by FROM jobs ORDER BY kind`);
    expect(rows[0]).toMatchObject({ kind: "a", status: "running" }); // último intento: lo resuelve el sweep
    expect(rows[1]).toMatchObject({ kind: "b", status: "running", locked_by: UNRECORDED }); // el sweep lo pasa a done
    await db.close();
  }, 60_000);

  it("toma en dos pasos: no recorre futuros y la prioridad alta no espera detrás de un atraso grande", async () => {
    const { createDb, migrate } = await import("../src/infra/db");
    const { startWorker } = await import("../src/infra/queue");
    const db = await createDb();
    await migrate(db);
    await db.query(`DELETE FROM jobs`);
    // Muchos futuros de prioridad alta, un atraso de masivos viejos y, más nuevos, un restablecimiento y un 7 (nivel
    // fuera de la lista de prioridades altas: entra solo como de los más viejos).
    await db.query(
      `INSERT INTO jobs (queue, payload, run_at, priority) SELECT 'finalize', '{"kind":"futuro"}', now() + interval '1 hour', 10 FROM generate_series(1, 50)`,
    );
    await db.query(
      `INSERT INTO jobs (queue, payload, run_at, priority) SELECT 'bulk', jsonb_build_object('kind', 'bulk', 'n', g), now() - interval '1 hour' + g * interval '1 second', -10 FROM generate_series(1, 20) g`,
    );
    await db.query(`INSERT INTO jobs (queue, payload, run_at, priority) VALUES ('notify', '{"kind":"password_reset"}', now() - interval '1 second', 20)`);
    await db.query(`INSERT INTO jobs (queue, payload, run_at, priority) VALUES ('notify', '{"kind":"custom"}', now() - interval '1 second', 7)`);
    const order: string[] = [];
    const worker = startWorker(db, {
      handlers: {
        notify: async (p: any) => void order.push(p.kind),
        bulk: async (p: any) => void order.push(`bulk${p.n}`),
        finalize: async () => void order.push("futuro"),
      } as any,
      concurrency: 1,
      claimCandidates: 5,
      pollMs: 20,
      log: { info() {}, error() {} },
    });
    try {
      await until(async () => order.length === 22);
      await new Promise((r) => setTimeout(r, 100));
      expect(order[0]).toBe("password_reset");
      // El masivo sale en orden de run_at; el 7 entra cuando queda entre los 5 más viejos y ahí pasa adelante.
      expect(order.slice(1, 17)).toEqual(Array.from({ length: 16 }, (_, i) => `bulk${i + 1}`));
      expect(order[17]).toBe("custom");
      expect(order.slice(18)).toEqual(["bulk17", "bulk18", "bulk19", "bulk20"]);
      expect(order).not.toContain("futuro");
    } finally {
      await worker.stop();
      await db.close();
    }
  }, 60_000);
});
