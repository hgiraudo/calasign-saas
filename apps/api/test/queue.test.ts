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
});
