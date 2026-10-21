-- Extracción automática de metadatos (ai/sweep.ts): fallas no clasificadas seguidas. Pasado un tope deja de
-- reintentarse (cada intento se cobra). Solo la columna (con DEFAULT constante: no reescribe la tabla).
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS ai_metadata_failures integer NOT NULL DEFAULT 0;
