-- no-transaction
-- Verificaciones en curso de un sobre: las busca el disparador de 0109 (calasign_identity_cancel_on_envelope_closed) en
-- cada cierre de sobre. Sin índice por envelope_id recorría la tabla. Parcial: solo las en curso (pocas).
CREATE INDEX CONCURRENTLY IF NOT EXISTS identity_verifications_active_envelope_idx ON identity_verifications (envelope_id) WHERE status IN ('created', 'pending');
