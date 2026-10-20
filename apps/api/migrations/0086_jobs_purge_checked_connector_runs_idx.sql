-- Purga de jobs (infra/queue.ts purgeFinishedJobs) y búsqueda de reentregas de webhooks de conectores.

-- Una fila terminada que se retiene (clave permanente atada a un sobre vivo) se marca con la fecha de la revisión:
-- vuelve a ser candidata recién pasado otro plazo de retención, en vez de rescanearse en cada barrido.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS purge_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS jobs_purge_idx ON jobs ((GREATEST(purge_checked_at, finished_at))) WHERE status IN ('done','failed');
-- Lo reemplaza jobs_purge_idx (la purga era su único uso).
DROP INDEX IF EXISTS jobs_finished_idx;

-- Reentregas de un webhook de conector (connectors/index.ts): flow_id + object_id dentro de la ventana de created_at.
CREATE INDEX IF NOT EXISTS connector_runs_flow_object_idx ON connector_runs (flow_id, object_id, created_at);
