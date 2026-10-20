-- Extracción automática con IA: primer intento, para limitar los reintentos a 30 días desde ahí (no desde que se
-- completó el sobre: al activar la extracción, los sobres de más de 30 días no tenían ningún reintento).
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS ai_metadata_first_attempt_at timestamptz;
