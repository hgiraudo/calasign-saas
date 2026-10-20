-- Extracción automática con IA que falló por algo transitorio (BYOK o almacenamiento caídos): se reintenta después de
-- esta fecha, no en cada pasada (si no, esos sobres ocupaban la tanda de todas las organizaciones).
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS ai_metadata_retry_at timestamptz;
