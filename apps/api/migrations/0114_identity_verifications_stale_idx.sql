-- no-transaction
-- Barrido de verificaciones sin resultado (expireStaleVerifications): pendientes de un proveedor externo ordenadas por
-- la última actividad. Parcial: solo las pendientes (pocas).
CREATE INDEX CONCURRENTLY IF NOT EXISTS identity_verifications_stale_idx ON identity_verifications (updated_at) WHERE status = 'pending' AND provider <> 'mock';
