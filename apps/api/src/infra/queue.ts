// Cola de trabajos sobre Postgres (FOR UPDATE SKIP LOCKED). Reemplazable por SQS detrás de la misma interfaz.
import { hostname } from "node:os";
import type { Db } from "./db";
import { scrubPii } from "../notifications/outbound";

export type JobQueueName = "notify" | "finalize" | "webhook" | "bulk" | "platform" | "agreements";

export interface EnqueueOptions {
  runAt?: Date;
  dedupeKey?: string;
  maxAttempts?: number;
  /** Mayor primero. Sin valor: jobPriority(queue, payload). */
  priority?: number;
}

/**
 * Prioridad por defecto (el claim toma ORDER BY priority DESC, run_at, id): lo que una persona está esperando en este
 * momento (restablecer la contraseña, el PDF final, su invitación) no hace cola detrás de un envío masivo de miles.
 * Contrapartida: con la cola saturada de avisos, el masivo espera; nunca al revés.
 */
export const PRIORITY = { passwordReset: 20, finalize: 10, invite: 5, notify: 2, normal: 0, bulk: -10 } as const;

export function jobPriority(queue: JobQueueName, payload: unknown): number {
  const kind = (payload as { kind?: unknown } | null)?.kind;
  if (queue === "notify" && kind === "password_reset") return PRIORITY.passwordReset;
  if (queue === "finalize") return PRIORITY.finalize;
  if (queue === "notify" && (kind === "invite" || kind === "certificate_request")) return PRIORITY.invite;
  if (queue === "notify") return PRIORITY.notify;
  if (queue === "bulk") return PRIORITY.bulk;
  return PRIORITY.normal;
}

/**
 * Encola dentro de la transacción del llamador (outbox): si la transacción falla, el trabajo no existe. Devuelve si
 * insertó (false: ya había un job con la misma dedupeKey).
 */
export async function enqueue(db: Db, queue: JobQueueName, payload: unknown, opts: EnqueueOptions = {}): Promise<boolean> {
  const rows = await db.query(
    `INSERT INTO jobs (queue, payload, run_at, dedupe_key, max_attempts, priority)
     VALUES ($1, $2, COALESCE($3, now()), $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [queue, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? 8, opts.priority ?? jobPriority(queue, payload)],
  );
  return rows.length > 0;
}

/**
 * Payload de un job que termina: sin datos sensibles que ya no hacen falta. El token de restablecimiento de contraseña
 * (cifrado) se borra apenas el job termina (hecho o fallado para siempre).
 */
const SCRUBBED_PAYLOAD = `CASE WHEN payload->>'kind' = 'password_reset' THEN payload - 'tokenEnc' ELSE payload END`;

/** locked_by de un job cuyo handler terminó bien pero cuyo 'done' no se pudo registrar: requeueStuckJobs lo pasa a done. */
export const UNRECORDED = "unrecorded";

interface JobRow {
  id: number;
  queue: JobQueueName;
  payload: any;
  attempts: number;
  max_attempts: number;
  postponable: boolean;
}

/** `attempts` incluye el intento en curso; si es >= `maxAttempts`, un error deja el job en 'failed'. */
export type JobHandler = (payload: any, job: JobContext & { id: number }) => Promise<void>;

/** postponable: el job tiene menos de 7 días (un error de BYOK lo pospone en vez de contar como intento). */
export interface JobContext {
  id?: number;
  attempts: number;
  maxAttempts: number;
  postponable?: boolean;
}

/** La clave BYOK de la organización no está disponible (el error puede llegar envuelto: se mira también el texto). */
export function isByokUnavailable(e: unknown): boolean {
  return (e as { code?: string })?.code === "byok_key_unavailable" || /La clave de cifrado de tu organización \(BYOK\)/.test(String(e));
}

/**
 * Si este error deja el job fallado para siempre: último intento y no es una caída de BYOK que la cola va a posponer.
 * Los handlers lo usan para su lógica de "último intento" (avisos, soltar reclamos): con BYOK caído no corresponde,
 * el job vuelve a correr cuando la clave se recupere (si no, se repetía cada 10 minutos).
 */
export function isLastAttempt(job: JobContext | undefined, err: unknown): boolean {
  if (!job || job.attempts < job.maxAttempts) return false;
  return !(job.postponable && isByokUnavailable(err));
}

export interface WorkerOptions {
  handlers: Record<JobQueueName, JobHandler>;
  concurrency?: number;
  pollMs?: number;
  log: { info(o: object, m?: string): void; error(o: object, m?: string): void };
  /**
   * Barrido periódico. Corre en su propio loop (nunca dos a la vez en el proceso, sin frenar la toma de jobs) cada
   * `sweepIntervalMs`; la señal se aborta al detener el worker.
   */
  onTick?: (signal: AbortSignal) => Promise<void>;
  sweepIntervalMs?: number;
  /** Cada cuánto un job en curso renueva su `locked_at` (por defecto 60 s; el sweep da por muerto a uno sin renovar en 10 min). */
  heartbeatMs?: number;
  /** Tope de la espera a los jobs en curso al detener el worker (por defecto 25 s). */
  shutdownGraceMs?: number;
  /** Esperas entre reintentos de registrar como 'done' un job que terminó bien (por defecto 0,5 s, 2 s y 5 s). */
  recordRetryMs?: number[];
  /** Candidatos listos más viejos que mira cada toma, además de los de prioridad alta (por defecto 100). */
  claimCandidates?: number;
  /**
   * Al apagar, un job que sigue corriendo vuelve a 'pending' con run_at = now() + esto (por defecto 30 s): el handler
   * local puede seguir hasta que el proceso salga y otro worker no tiene que tomarlo mientras tanto.
   */
  shutdownRequeueDelayMs?: number;
}

/**
 * Todos los niveles de jobPriority por encima del masivo (incluido el 0: webhooks, plataforma, acuerdos): el claim los
 * busca aparte (además de los listos más viejos) para que no esperen detrás de un atraso grande de prioridad menor.
 * Antes la lista era [20, 10, 5, 2] y los de prioridad 0 esperaban a que se vaciara un masivo de miles de filas.
 * Salen de PRIORITY: un nivel nuevo entra solo. Cada nivel es una búsqueda por rango en jobs_claim_idx
 * (priority = nivel AND run_at <= now()), sin recorrer los futuros.
 */
export const URGENT_PRIORITIES: number[] = [...new Set(Object.values(PRIORITY))].filter((p) => p > PRIORITY.bulk).sort((a, b) => b - a);

/** Cada cuánto el worker registra su latido en worker_heartbeats. */
const WORKER_BEAT_MS = 15_000;

export function startWorker(db: Db, opts: WorkerOptions) {
  const workerId = `${hostname()}:${process.pid}`;
  const concurrency = opts.concurrency ?? 4;
  const pollMs = opts.pollMs ?? 1000;
  const claimCandidates = Math.max(1, opts.claimCandidates ?? 100);
  // handlerDone: el handler ya terminó bien (puede estar reintentando registrar 'done'): al apagar no se devuelve a la cola.
  const inflight = new Map<number, JobRow & { handlerDone?: boolean }>();
  const abort = new AbortController();
  let stopped = false;
  let lastBeat = 0;

  // Toma en dos pasos. Recorrer jobs_claim_idx (priority DESC, run_at, id) filtrando run_at <= now() pasaba por todos
  // los pendientes FUTUROS de mayor prioridad (reintentos con backoff, pospuestos por BYOK…) antes de llegar a uno
  // listo. Ahora los candidatos son: los `claimCandidates` listos más viejos (jobs_pending_run_at_idx) más, por cada
  // nivel de prioridad alta conocido, sus listos más viejos (búsqueda por rango en jobs_claim_idx: priority = nivel y
  // run_at <= now(), sin tocar futuros). Así un restablecimiento de contraseña no espera a que se vacíe un masivo de
  // miles de jobs más viejos. Entre los candidatos se ordena por prioridad y se bloquea con SKIP LOCKED (el bloqueo
  // vuelve a evaluar status/run_at: un candidato que otro worker tomó entretanto se salta).
  async function claim(limit: number): Promise<JobRow[]> {
    return db.tx((t) =>
      t.query<JobRow>(
        `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $2, attempts = attempts + 1
         WHERE id IN (
           SELECT j.id FROM jobs j
            WHERE j.id IN (
                (SELECT c.id FROM jobs c WHERE c.status = 'pending' AND c.run_at <= now() ORDER BY c.run_at, c.id LIMIT $3)
                UNION
                (SELECT h.id FROM unnest($4::smallint[]) AS p(pr), LATERAL (
                   SELECT c.id FROM jobs c WHERE c.status = 'pending' AND c.priority = p.pr AND c.run_at <= now()
                    ORDER BY c.run_at, c.id LIMIT $1) h))
              AND j.status = 'pending' AND j.run_at <= now()
            ORDER BY j.priority DESC, j.run_at, j.id LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING id, queue, payload, attempts, max_attempts, (created_at > now() - interval '7 days') AS postponable`,
        [limit, workerId, claimCandidates, URGENT_PRIORITIES],
      ),
    );
  }

  /** Latido del worker (consultable en /internal/health). Un fallo no frena la toma de jobs. */
  async function beat(sweep = false) {
    if (!sweep && Date.now() - lastBeat < WORKER_BEAT_MS) return;
    if (!sweep) lastBeat = Date.now();
    await db
      .query(
        sweep
          ? `INSERT INTO worker_heartbeats (worker_id, sweep_at) VALUES ($1, now()) ON CONFLICT (worker_id) DO UPDATE SET sweep_at = now()`
          : `INSERT INTO worker_heartbeats (worker_id) VALUES ($1) ON CONFLICT (worker_id) DO UPDATE SET beat_at = now()`,
        [workerId],
      )
      .catch((e) => opts.log.error({ err: scrubPii(String(e)) }, "no se pudo registrar el latido del worker"));
  }

  // El handler terminó bien: se reintenta registrar 'done' (una caída breve de la base no repite el correo, el
  // webhook…). Si no hay caso, se marca locked_by = 'unrecorded' para que el sweep lo pase a 'done' sin esperar los
  // 10 minutos de un worker caído ni volver a correrlo; si ni eso se puede, queda 'running' sin latido y el sweep lo
  // resuelve como un worker caído (puede repetirse).
  async function recordDone(job: JobRow) {
    const waits = opts.recordRetryMs ?? [500, 2000, 5000];
    for (let i = 0; ; i++) {
      try {
        await db.query(
          `UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, payload = ${SCRUBBED_PAYLOAD} WHERE id = $1 AND attempts = $2`,
          [job.id, job.attempts],
        );
        return;
      } catch (e) {
        if (i >= waits.length) {
          opts.log.error({ jobId: job.id, queue: job.queue, err: scrubPii(String(e)) }, "job terminado pero no se pudo registrar");
          break;
        }
        await sleep(waits[i]);
      }
    }
    await db
      .query(`UPDATE jobs SET locked_by = $3 WHERE id = $1 AND attempts = $2 AND status = 'running'`, [job.id, job.attempts, UNRECORDED])
      .catch((e) => opts.log.error({ jobId: job.id, queue: job.queue, err: scrubPii(String(e)) }, "no se pudo marcar el job como terminado sin registrar"));
  }

  async function recordFailure(job: JobRow, e: unknown) {
    // Sin correos ni teléfonos: last_error se ve en el panel y termina en los logs.
    const err = scrubPii(e instanceof Error ? e.stack ?? e.message : String(e));
    // Clave BYOK de la organización caída: no es un intento (el job no puede hacer nada hasta que vuelva). Se pospone
    // 10 minutos, hasta 7 días desde que se encoló; si no, una caída de más de ~11 minutos dejaba exportaciones,
    // conectores y CRM fallados para siempre.
    if (job.postponable && isByokUnavailable(e)) {
      const postponed = await db.query(
        `UPDATE jobs SET status = 'pending', attempts = attempts - 1, last_error = $2, locked_at = NULL, run_at = now() + interval '10 minutes'
          WHERE id = $1 AND attempts = $3 RETURNING id`, // el límite de 7 días ya lo vio el handler (postponable)
        [job.id, err.slice(0, 4000), job.attempts],
      );
      if (postponed.length) {
        opts.log.info({ jobId: job.id, queue: job.queue }, "job pospuesto: clave BYOK no disponible");
        return;
      }
    }
    const final = job.attempts >= job.max_attempts;
    const backoffSec = Math.min(3600, 5 * 2 ** (job.attempts - 1));
    await db.query(
      `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL,
         run_at = now() + ($4 || ' seconds')::interval, finished_at = CASE WHEN $2 = 'failed' THEN now() END,
         payload = CASE WHEN $2 = 'failed' THEN ${SCRUBBED_PAYLOAD} ELSE payload END
       WHERE id = $1 AND attempts = $5`,
      [job.id, final ? "failed" : "pending", err.slice(0, 4000), String(backoffSec), job.attempts],
    );
    opts.log.error({ jobId: job.id, queue: job.queue, attempts: job.attempts, final, err: scrubPii(String(e)) }, "job falló");
  }

  // El resultado se registra solo si el job sigue en este intento (`attempts` cambia con cada toma). Si el sweep lo
  // devolvió a la cola por tardar más de 10 minutos y otro worker ya lo tomó, este intento viejo no puede pisar su
  // estado: un error tardío lo reprogramaría mientras corre el siguiente y saldría una vez más.
  async function run(job: JobRow & { handlerDone?: boolean }) {
    const handler = opts.handlers[job.queue];
    // Latido: mientras el job corre, renueva `locked_at`. Sin esto, un job vivo que tardaba más de 10 minutos (una
    // finalización con TSA/OCSP lentos, un envío masivo grande) quedaba "trabado" para el sweep: lo devolvía a la cola
    // y otro worker lo corría en paralelo, o, en el último intento, se registraba envelope.finalize_failed en la
    // evidencia y se avisaba a los administradores aunque la finalización terminara bien.
    const hb = setInterval(() => {
      db.query(`UPDATE jobs SET locked_at = now() WHERE id = $1 AND attempts = $2 AND status = 'running'`, [job.id, job.attempts]).catch((e) =>
        opts.log.error({ jobId: job.id, err: scrubPii(String(e)) }, "no se pudo renovar el job en curso"),
      );
    }, opts.heartbeatMs ?? 60_000);
    hb.unref?.();
    let ok = false;
    let failure: unknown = null;
    try {
      if (!handler) throw new Error(`sin handler para ${job.queue}`);
      await handler(job.payload, { id: job.id, attempts: job.attempts, maxAttempts: job.max_attempts, postponable: job.postponable });
      ok = true;
      job.handlerDone = true;
    } catch (e) {
      failure = e;
    }
    try {
      if (ok) await recordDone(job);
      else await recordFailure(job, failure);
    } finally {
      clearInterval(hb);
    }
  }

  async function claimLoop() {
    while (!stopped) {
      try {
        await beat();
        const free = concurrency - inflight.size;
        const jobs = free > 0 ? await claim(free) : [];
        for (const job of jobs) {
          inflight.set(job.id, job);
          run(job)
            .catch((e) => opts.log.error({ jobId: job.id, queue: job.queue, err: scrubPii(String(e)) }, "no se pudo registrar el resultado del job"))
            .finally(() => inflight.delete(job.id));
        }
        if (jobs.length === 0) await sleep(pollMs, abort.signal);
      } catch (e) {
        opts.log.error({ err: scrubPii(String(e)) }, "error en el loop del worker");
        await sleep(pollMs * 3, abort.signal);
      }
    }
  }

  // El barrido va aparte del claim: uno lento (IA, dominios, proveedores de pago) ya no frena la toma de jobs. Corre
  // en serie consigo mismo (el siguiente arranca `sweepIntervalMs` después de que empezó el anterior, o enseguida si
  // tardó más).
  async function sweepLoop() {
    if (!opts.onTick) return;
    const every = opts.sweepIntervalMs ?? 30_000;
    while (!stopped) {
      const started = Date.now();
      try {
        await opts.onTick(abort.signal);
        if (!stopped) await beat(true);
      } catch (e) {
        opts.log.error({ err: scrubPii(String(e)) }, "error en el barrido periódico");
      }
      await sleep(Math.max(0, every - (Date.now() - started)), abort.signal);
    }
  }

  const loopsDone = Promise.all([claimLoop(), sweepLoop()]);
  return {
    /**
     * Deja de tomar jobs, aborta el barrido y espera a los jobs en curso hasta `shutdownGraceMs` (25 s; systemd
     * manda SIGKILL a los 90 s). Los que siguen corriendo al vencer vuelven a 'pending' SIN descontar el intento y con
     * run_at dentro de `shutdownRequeueDelayMs` (30 s): la cola no sabe si su handler es idempotente (un correo pudo
     * haber salido), así que el intento interrumpido cuenta. Los que estaban en su último intento no vuelven (el sweep
     * los da por fallados a los 10 minutos) y los que ya terminaron (registro de 'done' reintentándose) tampoco: se
     * marcan 'unrecorded'. Si el handler llega a terminar antes de que el proceso salga, su 'done' igual se registra
     * (mismo `attempts`).
     */
    async stop() {
      stopped = true;
      abort.abort();
      const deadline = Date.now() + (opts.shutdownGraceMs ?? 25_000);
      // Que no quede una toma en curso: si se cerraba la base con un claim recién confirmado, esos jobs quedaban
      // 'running' sin correr (10 minutos, o 'failed' si era su último intento).
      await Promise.race([loopsDone, sleep(Math.max(0, deadline - Date.now()))]);
      while (inflight.size > 0 && Date.now() < deadline) await sleep(100);
      const delaySec = Math.max(0, opts.shutdownRequeueDelayMs ?? 30_000) / 1000;
      for (const job of inflight.values()) {
        try {
          if (job.handlerDone) {
            // Ya hizo su trabajo y recordDone sigue reintentando: no se vuelve a correr. Se marca 'unrecorded' para
            // que el sweep lo pase a 'done' (si tampoco se puede, queda como un worker caído).
            await db.query(`UPDATE jobs SET locked_by = $3 WHERE id = $1 AND attempts = $2 AND status = 'running'`, [job.id, job.attempts, UNRECORDED]);
            continue;
          }
          // Vuelve con run_at en el futuro: el handler local puede seguir hasta que el proceso salga y otro worker no
          // tiene que tomarlo en paralelo. Si era su último intento no se devuelve: queda 'running' y el sweep lo da
          // por fallado a los 10 minutos (o se registra 'done' si el handler llega a terminar).
          const back = await db.query(
            `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, run_at = now() + make_interval(secs => $4::float8)
              WHERE id = $1 AND attempts = $2 AND status = 'running' AND locked_by = $3 AND attempts < max_attempts RETURNING id`,
            [job.id, job.attempts, workerId, delaySec],
          );
          if (back.length) opts.log.info({ jobId: job.id, queue: job.queue }, "apagado: job en curso devuelto a la cola");
          else opts.log.info({ jobId: job.id, queue: job.queue }, "apagado: job en curso en su último intento, queda para el barrido");
        } catch (e) {
          opts.log.error({ jobId: job.id, err: scrubPii(String(e)) }, "apagado: no se pudo devolver el job a la cola");
        }
      }
      await db.query(`DELETE FROM worker_heartbeats WHERE worker_id = $1`, [workerId]).catch(() => {});
    },
  };
}

/**
 * Devuelve a la cola trabajos que quedaron tomados por un worker que murió. Un job que ya agotó sus intentos
 * (p. ej. uno que tumba el proceso cada vez) pasa a 'failed' en vez de reintentarse para siempre; se devuelven
 * esos jobs para que el llamador pueda reaccionar.
 */
export interface GaveUpJob {
  id: number;
  queue: JobQueueName;
  payload: any;
  /** Cuándo se encoló (los "ya avisado" se miran desde acá: ver finalizeGaveUp). */
  createdAt: Date;
}

export async function requeueStuckJobs(db: Db): Promise<GaveUpJob[]> {
  // Terminados bien pero sin registrar (ver recordDone): ya hicieron su trabajo, no se vuelven a correr.
  await db.query(
    `UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, payload = ${SCRUBBED_PAYLOAD}
      WHERE status = 'running' AND locked_by = $1`,
    [UNRECORDED],
  );
  const rows = await db.query<{ id: number; queue: JobQueueName; payload: any; status: string; created_at: Date }>(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
       locked_at = NULL,
       finished_at = CASE WHEN attempts >= max_attempts THEN now() END,
       last_error = CASE WHEN attempts >= max_attempts THEN left(COALESCE(last_error || E'\\n', '') || 'el worker se detuvo durante el job (intentos agotados)', 4000) ELSE last_error END
     WHERE status = 'running' AND locked_at < now() - interval '10 minutes'
     RETURNING id, queue, payload, status, created_at`,
  );
  // El payload completo se devuelve (finalizeGaveUp lo usa); el token de restablecimiento se borra igual.
  const failed = rows.filter((r) => r.status === "failed");
  for (const r of failed) {
    if (r.payload?.kind === "password_reset") await db.query(`UPDATE jobs SET payload = ${SCRUBBED_PAYLOAD} WHERE id = $1`, [r.id]);
  }
  return failed.map(({ id, queue, payload, created_at }) => ({ id, queue, payload, createdAt: new Date(created_at) }));
}

/** Estados finales del sobre: ningún flujo vuelve a encolar con una clave atada a un sobre así. */
const FINAL_ENVELOPE_STATUSES = `('completed','declined','voided','expired')`;

/** Clave del candado de la purga (pg_try_advisory_xact_lock): una sola purga a la vez entre todos los procesos. */
const PURGE_LOCK_KEY = 0x6a6f6273; // "jobs"

/**
 * Prefijos de las claves PERMANENTES (lista blanca): las que algún flujo usa como registro de "ya se hizo" mientras
 * el sobre siga vivo. Si se agrega un enqueue con una clave así, va acá.
 *  - invite:/completed:<rec> (envelopes.activateRecipient), certificate_request:<rec> (certsign), invite-verified:<rec> (otp)
 *  - finalize:<sobre> (no finalize:<sobre>:retry:<uuid>, reintento manual con clave única), finalize-certsign:<sobre>
 *  - expiry-warning:<rec>:<vence>[:<envío>] (reminders), exp:<conexión>:<sobre> (no la de reintento manual con
 *    :<timestamp>), agr:ingest:<sobre>
 */
const PERMANENT_KEY = `(
  starts_with(j.dedupe_key, 'invite:') OR starts_with(j.dedupe_key, 'completed:')
  OR starts_with(j.dedupe_key, 'certificate_request:') OR starts_with(j.dedupe_key, 'invite-verified:')
  OR (starts_with(j.dedupe_key, 'finalize:') AND strpos(j.dedupe_key, ':retry:') = 0)
  OR starts_with(j.dedupe_key, 'finalize-certsign:') OR starts_with(j.dedupe_key, 'expiry-warning:')
  OR (starts_with(j.dedupe_key, 'exp:') AND j.dedupe_key !~ '^exp:[^:]*:[^:]*:')
  OR starts_with(j.dedupe_key, 'agr:ingest:'))`;

/**
 * Purga de jobs terminados ('done'/'failed') hace más de `olderThanDays`, de a `batch` y hasta `maxBatches` lotes por
 * pasada. Cada lote corre en su transacción con pg_try_advisory_xact_lock: si otro proceso está purgando, esta pasada
 * no hace nada. El barrido la llama como mucho una vez por hora por proceso (modules/jobs.ts).
 *
 * Política de dedupe (jobs.dedupe_key es única y varios flujos la usan como registro de "ya se hizo"): LISTA BLANCA.
 *  - Claves permanentes (PERMANENT_KEY) → se retienen mientras el sobre del payload (`envelopeId`) exista y no esté
 *    en un estado final (completed, declined, voided, expired): purgarlas permitiría repetir la invitación, la
 *    finalización o el aviso de vencimiento.
 *  - Cualquier otra clave (por día/hora/ronda o por id único: auto-reminder:, wf-resume:, whdel:, whfan:, ntf:,
 *    cnjob:, crmjob:, bulk:, neg:, wf:approval:, agr:expiry:…) y sin clave → purgables pasado el plazo.
 *
 * Una fila retenida no se vuelve a mirar en cada barrido: se le pone `purge_checked_at = now()` y el índice de la
 * purga (0086) va por GREATEST(purge_checked_at, finished_at), así vuelve a ser candidata recién después de otro plazo.
 */
export async function purgeFinishedJobs(db: Db, opts: { olderThanDays: number; batch?: number; maxBatches?: number; signal?: AbortSignal }): Promise<number> {
  const batch = opts.batch ?? 5000;
  const days = Math.max(1, Math.floor(opts.olderThanDays));
  let total = 0;
  for (let i = 0; i < (opts.maxBatches ?? 10) && !opts.signal?.aborted; i++) {
    const r = await db.tx(async (t) => {
      const lock = await t.one<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [PURGE_LOCK_KEY]);
      if (!lock?.ok) return null;
      return t.one<{ seen: number; deleted: number }>(
        `WITH cand AS (
           SELECT j.id, (j.dedupe_key IS NOT NULL AND ${PERMANENT_KEY} AND EXISTS (
               SELECT 1 FROM envelopes e
                WHERE e.id = CASE WHEN j.payload->>'envelopeId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                  THEN (j.payload->>'envelopeId')::uuid END
                  AND e.status NOT IN ${FINAL_ENVELOPE_STATUSES})) AS keep
             FROM jobs j
            WHERE j.status IN ('done','failed') AND GREATEST(j.purge_checked_at, j.finished_at) < now() - make_interval(days => $1::int)
            LIMIT $2),
         del AS (DELETE FROM jobs WHERE id IN (SELECT id FROM cand WHERE NOT keep) RETURNING 1),
         kept AS (UPDATE jobs SET purge_checked_at = now() WHERE id IN (SELECT id FROM cand WHERE keep) RETURNING 1)
         SELECT (SELECT count(*) FROM cand)::int AS seen, (SELECT count(*) FROM del)::int AS deleted, (SELECT count(*) FROM kept)::int AS kept`,
        [days, batch],
      );
    });
    if (!r) break;
    total += r.deleted;
    if (r.seen < batch) break;
  }
  return total;
}

/** Estado de la cola para /internal/health: latidos de los workers y edad del pendiente más viejo listo para correr. */
export async function queueHealth(db: Db) {
  const workers = await db.query<{ beat_age: number; sweep_age: number | null }>(
    `SELECT EXTRACT(EPOCH FROM now() - beat_at)::float8 AS beat_age, EXTRACT(EPOCH FROM now() - sweep_at)::float8 AS sweep_age
       FROM worker_heartbeats ORDER BY beat_at DESC LIMIT 20`,
  );
  const oldest = await db.one<{ age: number | null }>(
    `SELECT EXTRACT(EPOCH FROM now() - min(run_at))::float8 AS age FROM jobs WHERE status = 'pending' AND run_at <= now()`,
  );
  return {
    workers: workers.map((w) => ({
      lastBeatSecondsAgo: Math.round(Number(w.beat_age)),
      lastSweepSecondsAgo: w.sweep_age == null ? null : Math.round(Number(w.sweep_age)),
    })),
    oldestReadyPendingSeconds: oldest?.age == null ? null : Math.round(Number(oldest.age)),
  };
}

/** Espera; con señal, termina antes si se aborta. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
