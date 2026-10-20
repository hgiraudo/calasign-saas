-- CRM y conectores HRIS/CLM.
-- 1. Desconectar (DELETE de la conexión) ya no borra el historial de ejecuciones: connection_id pasa a NULL y la
--    ejecución conserva el nombre y el proveedor de la conexión en detail.connection (los guarda la ruta antes de borrar).
--    Los mapeos/flujos y los vínculos siguen borrándose con la conexión (sin credenciales no sirven).
-- 2. Secreto HMAC opcional por flujo para el webhook entrante de los conectores (cifrado; la API no lo devuelve).
-- 3. Índices por fecha para la purga de ejecuciones viejas (barrido periódico, INTEGRATION_RUNS_RETENTION_DAYS).
ALTER TABLE crm_runs DROP CONSTRAINT IF EXISTS crm_runs_connection_id_fkey;
ALTER TABLE crm_runs ADD CONSTRAINT crm_runs_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES crm_connections(id) ON DELETE SET NULL;
ALTER TABLE connector_runs DROP CONSTRAINT IF EXISTS connector_runs_connection_id_fkey;
ALTER TABLE connector_runs ADD CONSTRAINT connector_runs_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES connector_connections(id) ON DELETE SET NULL;
ALTER TABLE connector_flows ADD COLUMN IF NOT EXISTS webhook_secret_enc text;
CREATE INDEX IF NOT EXISTS crm_runs_created_idx ON crm_runs (created_at);
CREATE INDEX IF NOT EXISTS connector_runs_created_idx ON connector_runs (created_at);
