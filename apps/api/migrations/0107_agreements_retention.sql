-- Acuerdos: retención de datos de workflows y negociaciones terminados, e IP del inicio público fuera de la etiqueta.
--
-- started_by_ip: la IP desde la que se inició una ejecución por el link público. Antes iba en started_by_label
-- ("Link público (203.0.113.10)"), que ve cualquiera que vea la ejecución; ahora solo quien ve la auditoría.
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS started_by_ip text;
UPDATE workflow_runs
   SET started_by_ip = NULLIF(substring(started_by_label FROM '^Link público \((.*)\)$'), '?'),
       started_by_label = 'Link público'
 WHERE started_by IS NULL AND started_by_api_key IS NULL AND started_by_label LIKE 'Link público (%)';

-- data_purged_at: los datos (contexto, salidas de los pasos, textos negociados) se borraron por la retención; quedan
-- los metadatos mínimos (estado, pasos, fechas, ids de sobres).
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS data_purged_at timestamptz;
ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS data_purged_at timestamptz;
CREATE INDEX IF NOT EXISTS workflow_runs_retention_idx ON workflow_runs (updated_at)
  WHERE data_purged_at IS NULL AND status IN ('completed','failed','rejected','cancelled');
CREATE INDEX IF NOT EXISTS negotiations_retention_idx ON negotiations (updated_at)
  WHERE data_purged_at IS NULL AND status IN ('accepted','cancelled');
