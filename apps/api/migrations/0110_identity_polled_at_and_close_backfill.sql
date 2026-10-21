-- polled_at: última consulta del firmante al proveedor (GET …/identity y el envío, como máximo una cada 5 s). Antes esa
-- consulta movía updated_at, que ahora es la última actividad del proveedor (inicio, webhooks, resultados en revisión)
-- y es desde donde corre el plazo de provider_timeout (expireStaleVerifications).
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS polled_at timestamptz;

-- Complemento del backfill de 0109 (que canceló las verificaciones colgadas en sobres cerrados pero no tocó a sus
-- destinatarios): los que quedaron "in_progress" en un sobre cerrado vuelven a "pending", como hace el disparador.
UPDATE recipients r SET identity_status = 'pending' FROM envelopes e WHERE e.id = r.envelope_id AND r.identity_status = 'in_progress' AND e.status IN ('completed', 'declined', 'voided', 'expired');
