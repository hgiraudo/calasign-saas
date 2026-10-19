-- Exportación a almacenamiento externo: un solo trabajo a la vez por exportación (si no, dos trabajos de la cola
-- subían el mismo PDF dos veces y, con Box, se pisaban el refresh token de un solo uso).
ALTER TABLE storage_exports ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
