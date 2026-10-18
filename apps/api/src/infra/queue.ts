// Cola de trabajos sobre Postgres (FOR UPDATE SKIP LOCKED). Reemplazable por SQS detrás de la misma interfaz.
import { hostname } from "node:os";
import type { Db } from "./db";

export type JobQueueName = "notify" | "finalize" | "webhook" | "bulk" | "platform" | "agreements";

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Encola dentro de la transacción del llamador (outbox): si la transacción falla, el trabajo no existe. */
export async function enqueue(db: Db, queue: JobQueueName, payload: unknown, opts: EnqueueOptions = {}) {
  await db.query(
    `INSERT INTO jobs (queue, payload, run_at, dedupe_key, max_attempts)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [queue, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? 8],
  );
}

interface JobRow {
  id: number;
  queue: JobQueueName;
  payload: any;
  attempts: number;
  max_attempts: number;
}

/** `attempts` incluye el intento en curso; si es >= `maxAttempts`, un error deja el job en 'failed'. */
export type JobHandler = (payload: any, job: { id: number; attempts: number; maxAttempts: number }) => Promise<void>;

export interface WorkerOptions {
  handlers: Record<JobQueueName, JobHandler>;
  concurrency?: number;
  pollMs?: number;
  log: { info(o: object, m?: string): void; error(o: object, m?: string): void };
  onTick?: () => Promise<void>;
}

export function startWorker(db: Db, opts: WorkerOptions) {
  const workerId = `${hostname()}:${process.pid}`;
  const concurrency = opts.concurrency ?? 4;
  const pollMs = opts.pollMs ?? 1000;
  let running = 0;
  let stopped = false;
  let lastTick = 0;

  async function claim(limit: number): Promise<JobRow[]> {
    return db.tx((t) =>
      t.query<JobRow>(
        `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
           ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING id, queue, payload, attempts, max_attempts`,
        [limit, workerId],
      ),
    );
  }

  // El resultado se registra solo si el job sigue en este intento (`attempts` cambia con cada toma). Si el sweep lo
  // devolvió a la cola por tardar más de 10 minutos y otro worker ya lo tomó, este intento viejo no puede pisar su
  // estado: un error tardío lo reprogramaría mientras corre el siguiente y saldría una vez más.
  async function run(job: JobRow) {
    const handler = opts.handlers[job.queue];
    try {
      if (!handler) throw new Error(`sin handler para ${job.queue}`);
      await handler(job.payload, { id: job.id, attempts: job.attempts, maxAttempts: job.max_attempts });
      await db.query(`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL WHERE id = $1 AND attempts = $2`, [job.id, job.attempts]);
    } catch (e) {
      const err = e instanceof Error ? e.stack ?? e.message : String(e);
      const final = job.attempts >= job.max_attempts;
      const backoffSec = Math.min(3600, 5 * 2 ** (job.attempts - 1));
      await db.query(
        `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL,
           run_at = now() + ($4 || ' seconds')::interval, finished_at = CASE WHEN $2 = 'failed' THEN now() END
         WHERE id = $1 AND attempts = $5`,
        [job.id, final ? "failed" : "pending", err.slice(0, 4000), String(backoffSec), job.attempts],
      );
      opts.log.error({ jobId: job.id, queue: job.queue, attempts: job.attempts, final, err: String(e) }, "job falló");
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        if (opts.onTick && Date.now() - lastTick > 30_000) {
          lastTick = Date.now();
          await opts.onTick();
        }
        const free = concurrency - running;
        const jobs = free > 0 ? await claim(free) : [];
        for (const job of jobs) {
          running++;
          run(job)
            .catch((e) => opts.log.error({ jobId: job.id, queue: job.queue, err: String(e) }, "no se pudo registrar el resultado del job"))
            .finally(() => running--);
        }
        if (jobs.length === 0) await sleep(pollMs);
      } catch (e) {
        opts.log.error({ err: String(e) }, "error en el loop del worker");
        await sleep(pollMs * 3);
      }
    }
  }

  loop();
  return {
    async stop() {
      stopped = true;
      while (running > 0) await sleep(100);
    },
  };
}

/**
 * Devuelve a la cola trabajos que quedaron tomados por un worker que murió. Un job que ya agotó sus intentos
 * (p. ej. uno que tumba el proceso cada vez) pasa a 'failed' en vez de reintentarse para siempre; se devuelven
 * esos jobs para que el llamador pueda reaccionar.
 */
export async function requeueStuckJobs(db: Db): Promise<{ id: number; queue: JobQueueName; payload: any }[]> {
  const rows = await db.query<{ id: number; queue: JobQueueName; payload: any; status: string }>(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
       locked_at = NULL,
       finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
       last_error = CASE WHEN attempts >= max_attempts THEN left(COALESCE(last_error || E'\\n', '') || 'el worker se detuvo durante el job (intentos agotados)', 4000) ELSE last_error END
     WHERE status = 'running' AND locked_at < now() - interval '10 minutes'
     RETURNING id, queue, payload, status`,
  );
  return rows.filter((r) => r.status === "failed").map(({ id, queue, payload }) => ({ id, queue, payload }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
