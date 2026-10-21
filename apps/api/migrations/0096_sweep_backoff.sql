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

-- Los índices de este bloque sobre envelopes y jobs (tablas grandes) están en 0098-0100, con CREATE INDEX
-- CONCURRENTLY fuera de una transacción: acá, en la misma transacción que los ALTER TABLE, el ACCESS EXCLUSIVE de
-- envelopes quedaba tomado mientras se construían (y el CREATE INDEX común sobre jobs bloqueaba sus escrituras).
-- Donde 0096 ya se aplicó con los índices, 0098-0100 no hacen nada (IF NOT EXISTS).
