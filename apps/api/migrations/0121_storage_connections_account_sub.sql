-- Cuenta de Google de una conexión de Drive: el `sub` del id_token (id estable de la cuenta; el email puede cambiar o
-- faltar). Revocar en Google corta toda la concesión de esa cuenta, así que al desconectar se revoca solo si ninguna
-- otra conexión usa la misma cuenta: se compara por `sub` y, en filas anteriores sin él, por account_label (email).
ALTER TABLE storage_connections ADD COLUMN IF NOT EXISTS account_sub text;
CREATE INDEX IF NOT EXISTS storage_connections_gdrive_sub_idx ON storage_connections (account_sub) WHERE provider = 'gdrive' AND account_sub IS NOT NULL;
