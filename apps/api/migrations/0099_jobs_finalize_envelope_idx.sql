-- no-transaction
-- Jobs de finalización por sobre (barrido de finalizaciones, ver jobs.ts). Antes en 0096; CONCURRENTLY para no
-- bloquear las escrituras de jobs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_finalize_envelope_idx ON jobs ((payload->>'envelopeId')) WHERE queue = 'finalize';
