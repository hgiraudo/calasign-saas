-- Mantenimiento de la cola de trabajos (infra/queue.ts, barrido "jobs-purge" de modules/jobs.ts).

-- Prioridad: el claim toma primero los de mayor prioridad (ORDER BY priority DESC, run_at, id). Ver jobPriority() en
-- queue.ts: restablecimiento de contraseña y finalización arriba, avisos individuales después, envío masivo abajo.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 0;
UPDATE jobs SET priority = CASE
    WHEN queue = 'notify' AND payload->>'kind' = 'password_reset' THEN 20
    WHEN queue = 'finalize' THEN 10
    WHEN queue = 'notify' AND payload->>'kind' IN ('invite','certificate_request') THEN 5
    WHEN queue = 'notify' THEN 2
    WHEN queue = 'bulk' THEN -10
    ELSE 0 END
  WHERE status IN ('pending','running');

-- Claim y edad del pendiente más viejo (/internal/health) sin recorrer los terminados.
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (priority DESC, run_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS jobs_pending_run_at_idx ON jobs (run_at, id) WHERE status = 'pending';
-- requeueStuckJobs (cada 30 s): antes era un seq scan de toda la tabla.
CREATE INDEX IF NOT EXISTS jobs_running_locked_idx ON jobs (locked_at) WHERE status = 'running';
-- Purga de terminados viejos, de a lotes.
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs (finished_at) WHERE status IN ('done','failed');

-- El token de restablecimiento de contraseña (cifrado) no tiene por qué quedar en jobs terminados: desde ahora se
-- borra al terminar el job; esto limpia los ya terminados.
UPDATE jobs SET payload = payload - 'tokenEnc' WHERE status IN ('done','failed') AND payload->>'kind' = 'password_reset';

-- Latido de cada worker (último ciclo del claim y último barrido), para /internal/health. Las filas de workers que
-- dejaron de latir hace más de un día las borra el barrido.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id   text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  beat_at     timestamptz NOT NULL DEFAULT now(),
  sweep_at    timestamptz
);
