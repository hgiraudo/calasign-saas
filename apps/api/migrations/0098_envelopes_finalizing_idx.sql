-- no-transaction
-- Barrido de finalizaciones que agotaron sus intentos sin dejar envelope.finalize_failed (ver jobs.ts): sobres en
-- 'finalizing' (pocos). Antes en 0096; CONCURRENTLY para no bloquear las escrituras de envelopes (ver
-- docs/MODELO-DE-DATOS.md, migraciones sin transacción).
CREATE INDEX CONCURRENTLY IF NOT EXISTS envelopes_finalizing_idx ON envelopes (updated_at) WHERE status = 'finalizing';
