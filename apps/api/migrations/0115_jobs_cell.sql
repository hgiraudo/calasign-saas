-- Residencia de datos en el trabajo de fondo: cada job lleva la celda de su organización y solo lo toma un worker que
-- atiende esa celda (SERVED_CELLS). NULL = cualquier celda (jobs sin organización, o despliegues de una sola celda).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cell text;

-- Los pendientes de antes: la celda de su organización (payload.tenantId o la del sobre de payload.envelopeId). Los ids
-- viejos ('local', 'dev') quedan NULL (cualquier worker): su celda efectiva es la por defecto de cada despliegue.
UPDATE jobs j SET cell = x.cell
  FROM (
    SELECT j2.id, COALESCE(d.cell, t.cell) AS cell
      FROM jobs j2
      JOIN tenants t ON t.id = COALESCE(
        CASE WHEN j2.payload->>'tenantId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (j2.payload->>'tenantId')::uuid END,
        (SELECT e.tenant_id FROM envelopes e
          WHERE e.id = CASE WHEN j2.payload->>'envelopeId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN (j2.payload->>'envelopeId')::uuid END))
      LEFT JOIN tenant_directory d ON d.tenant_id = t.id
     WHERE j2.status IN ('pending', 'running')
  ) x
 WHERE j.id = x.id AND x.cell IS NOT NULL AND x.cell NOT IN ('', 'local', 'dev');
