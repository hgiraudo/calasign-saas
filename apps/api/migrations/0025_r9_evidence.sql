-- Ronda 9: quién inició un workflow por API. Sin esta columna, las ejecuciones iniciadas por una API key o por el
-- link público quedaban con started_by NULL y cualquier API key "coincidía" con ellas (NULL === NULL en la app).
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS started_by_api_key uuid;
