-- API de eventos: cursor por orden de confirmación, sin margen de tiempo (devapi/events.ts).
-- Cada registro de evidencia guarda el id de la transacción que lo escribió. Un evento se entrega solo cuando su
-- transacción es anterior a todas las que siguen abiertas (pg_snapshot_xmin): ninguna confirmación posterior puede
-- quedar detrás del cursor, por mucho que tarde una transacción o aunque los relojes estén desfasados.
-- Los registros existentes quedan con el id de esta migración (mismo valor para todos: su orden sigue siendo el id).
ALTER TABLE envelope_events ADD COLUMN IF NOT EXISTS tx_id xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX IF NOT EXISTS envelope_events_tenant_tx_idx ON envelope_events (tenant_id, tx_id, id);
