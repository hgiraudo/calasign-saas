-- Barridos que no se traban con un sobre o archivo que falla siempre.
--
-- Retención: un sobre cuyo borrado falla (almacenamiento, BYOK, certificados) quedaba primero en el ORDER BY closed_at
-- LIMIT 50 y, con 50 así, la retención no avanzaba para nadie. Se registra el intento fallido y el error; el barrido lo
-- saltea por unas horas.
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS retention_attempted_at timestamptz;
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS retention_error text;
-- Vencimiento (barrido de sobres vencidos): mismo problema con el ORDER BY expires_at LIMIT 100.
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS sweep_failed_at timestamptz;
-- Pasada de huérfanos de la retención (originales que ya solo referencian sobres purgados).
ALTER TABLE files ADD COLUMN IF NOT EXISTS purge_attempted_at timestamptz;

-- Archivos que había que borrar (nada los referencia) y cuyo borrado en el almacenamiento falló: el barrido los
-- reintenta. Sin clave foránea: la fila de `files` puede desaparecer antes (la fila de acá se descarta sola).
CREATE TABLE IF NOT EXISTS pending_file_deletions (
  file_id       uuid PRIMARY KEY,
  queued_at     timestamptz NOT NULL DEFAULT now(),
  attempted_at  timestamptz,
  error         text
);
CREATE INDEX IF NOT EXISTS pending_file_deletions_attempted_idx ON pending_file_deletions (attempted_at NULLS FIRST);

-- Barrido de finalizaciones que agotaron sus intentos sin dejar envelope.finalize_failed (ver jobs.ts): sobres en
-- 'finalizing' (pocos) y sus jobs de finalización por sobre.
CREATE INDEX IF NOT EXISTS envelopes_finalizing_idx ON envelopes (updated_at) WHERE status = 'finalizing';
CREATE INDEX IF NOT EXISTS jobs_finalize_envelope_idx ON jobs ((payload->>'envelopeId')) WHERE queue = 'finalize';

-- Recordatorios y avisos de vencimiento también para sobres esperando firmas con certificado (reminders.ts).
CREATE INDEX IF NOT EXISTS envelopes_awaiting_cert_reminders_idx ON envelopes (status)
  WHERE status = 'awaiting_certificates' AND (reminder_every_days IS NOT NULL OR expiry_warning_days IS NOT NULL);
