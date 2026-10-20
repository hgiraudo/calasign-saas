-- Descargas del MCP: las continuaciones (Range que no empieza en 0) valen solo poco después de una descarga contada
-- (last_download_at) y suman bytes servidos (bytes_served): no se puede bajar el archivo entero una y otra vez con
-- "bytes=1-".
ALTER TABLE download_links ADD COLUMN IF NOT EXISTS last_download_at timestamptz;
ALTER TABLE download_links ADD COLUMN IF NOT EXISTS bytes_served bigint NOT NULL DEFAULT 0;

-- Formularios web: el prellenado del rol público de solo lectura es opcional por formulario (los existentes, sin bloquear).
ALTER TABLE web_forms ADD COLUMN IF NOT EXISTS lock_prefill boolean NOT NULL DEFAULT false;

-- Envío masivo: ronda de reintento de cada fila. El cierre del último intento de un job viejo solo toca las filas de su
-- ronda (no las que "Reintentar fallidas" ya volvió a encolar).
ALTER TABLE bulk_send_items ADD COLUMN IF NOT EXISTS retry_round integer NOT NULL DEFAULT 0;

-- Códigos de verificación: tope por organización + destino.
CREATE INDEX IF NOT EXISTS otp_challenges_tenant_destination_idx ON otp_challenges (tenant_id, lower(destination), created_at DESC);
