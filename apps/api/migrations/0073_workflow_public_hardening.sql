-- Workflows de inicio público: huella (HMAC de workflow + correo + IP/64) de quien completó el formulario, para no
-- aceptar el mismo envío repetido (como envelopes.web_form_submitter en los formularios web). Columna interna: no
-- viaja en la API.
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS public_submitter text;
CREATE INDEX IF NOT EXISTS workflow_runs_public_submitter_idx ON workflow_runs (workflow_id, public_submitter) WHERE public_submitter IS NOT NULL;
-- Tope por organización de los links públicos (formularios web + workflows): cuenta los runs públicos recientes.
CREATE INDEX IF NOT EXISTS workflow_runs_public_tenant_idx ON workflow_runs (tenant_id, created_at) WHERE started_by IS NULL AND started_by_api_key IS NULL;
-- Barrido de runs esperando un formulario sin actividad.
CREATE INDEX IF NOT EXISTS workflow_runs_waiting_updated_idx ON workflow_runs (updated_at) WHERE status = 'waiting';
