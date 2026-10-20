-- Webhooks salientes: desactivación automática por fallas, idempotencia del fanout y retención de entregas.

-- Salud del endpoint (modules/webhooks.ts): fallas definitivas seguidas (0 al entregar bien), desde cuándo falla sin
-- ningún éxito, último éxito y motivo de una desactivación automática ('gone', 'failing', 'permission_lost'; el de
-- 'credential_revoked' se sigue calculando). deactivated_at: cuándo pasó a inactivo (el tope de 20 no cuenta los
-- inactivos de hace más de 30 días).
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS failing_since timestamptz;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS last_success_at timestamptz;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS auto_deactivated_reason text;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
-- Los inactivos de antes: desde su última modificación (tabla chica, máximo 20 por organización).
UPDATE webhook_endpoints SET deactivated_at = updated_at WHERE NOT active AND deactivated_at IS NULL;

-- Un evento (sobre, seq, tipo) se entrega una sola vez por endpoint: el fanout deriva el event_id de esos datos y
-- re-ejecutarlo (reintento del job, worker caído a mitad) no duplica entregas. Antes cada ejecución usaba un id nuevo,
-- así que no debería haber repetidos; por las dudas se deja la más vieja de cada par.
DELETE FROM webhook_deliveries d USING webhook_deliveries d2
 WHERE d.endpoint_id = d2.endpoint_id AND d.event_id = d2.event_id AND (d.created_at, d.id) > (d2.created_at, d2.id);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_endpoint_event_uq ON webhook_deliveries (endpoint_id, event_id);

-- Retención (purgeOldWebhookDeliveries) y borrado de las entregas de un sobre purgado o borrado.
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries (created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_envelope_idx ON webhook_deliveries (envelope_id) WHERE envelope_id IS NOT NULL;
