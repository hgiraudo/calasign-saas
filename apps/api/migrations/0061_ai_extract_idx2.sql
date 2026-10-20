-- Barrido de extracción automática con IA: índice más selectivo que 0060 (que abarcaba todos los sobres completados
-- sin metadatos, incluidos los de organizaciones sin IA) y sin el de 0011, que la consulta actual ya no usa. Por
-- organización: el barrido parte de las organizaciones con extracción automática.
DROP INDEX IF EXISTS envelopes_ai_pending_extract_idx;
DROP INDEX IF EXISTS envelopes_ai_extract_idx;
CREATE INDEX IF NOT EXISTS envelopes_ai_extract_tenant_idx ON envelopes (tenant_id, completed_at)
  WHERE status = 'completed' AND ai_metadata IS NULL AND (ai_metadata_attempted_at IS NULL OR ai_metadata_retry_at IS NOT NULL);
