-- Barrido de extracción automática con IA (0058 sumó ai_metadata_retry_at): el índice parcial anterior pedía
-- ai_metadata_attempted_at IS NULL y la consulta nueva ya no lo usaba (recorría todos los sobres completados sin metadatos).
CREATE INDEX IF NOT EXISTS envelopes_ai_extract_idx ON envelopes (completed_at) WHERE status = 'completed' AND ai_metadata IS NULL;
