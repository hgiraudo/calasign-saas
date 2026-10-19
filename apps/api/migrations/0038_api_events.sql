-- API más completa (docs/API-ROADMAP.md):
--   · GET /v1/events y /v1/events/stream leen envelope_events de toda la organización en orden de id (cursor).
--   · Búsqueda de sobres: filtros por fecha de actualización y por metadata (contención jsonb).
--   · Rotación del secreto de un webhook con período de gracia: durante la ventana se firma con los dos secretos.
CREATE INDEX IF NOT EXISTS envelope_events_tenant_id_idx ON envelope_events (tenant_id, id);
CREATE INDEX IF NOT EXISTS envelopes_tenant_updated_idx ON envelopes (tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS envelopes_metadata_idx ON envelopes USING gin (metadata jsonb_path_ops);

ALTER TABLE webhook_endpoints ADD COLUMN previous_secret_enc text;
ALTER TABLE webhook_endpoints ADD COLUMN previous_secret_expires_at timestamptz;
