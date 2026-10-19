-- La purga del sweep (jobs.ts, paso "idempotency") borra las claves de más de 7 días filtrando por created_at; sin
-- índice escaneaba toda la tabla en cada pasada (cada 30 s).
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys (created_at);
