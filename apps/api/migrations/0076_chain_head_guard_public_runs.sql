-- files.chain_head es solo una cache de la lectura con pdf.js de PDFs sellados antes de que finalize.ts escribiera la
-- Keyword calasign-chain-head (verify.ts lee el ancla de los bytes del PDF subido). Una vez fijada no cambia: solo se
-- permite NULL -> valor (como en 0072/0074, salvo mantenimiento explícito con SET LOCAL calasign.allow_evidence_write).
-- (El cuerpo de la función va en una sola línea: el runner, db.ts splitSql, corta en un punto y coma al final de línea.)
CREATE OR REPLACE FUNCTION calasign_files_chain_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('calasign.allow_evidence_write', true), '') = 'on' THEN RETURN NEW; END IF; RAISE EXCEPTION 'evidence_append_only: files.chain_head ya está fijado' USING ERRCODE = 'insufficient_privilege'; END $$;

DROP TRIGGER IF EXISTS files_chain_head_set_once ON files;
CREATE TRIGGER files_chain_head_set_once BEFORE UPDATE OF chain_head ON files FOR EACH ROW WHEN (OLD.chain_head IS NOT NULL AND NEW.chain_head IS DISTINCT FROM OLD.chain_head) EXECUTE FUNCTION calasign_files_chain_head_guard();

-- Workflows de inicio público: el tope por organización (compartido con los formularios web) cuenta solo las ejecuciones
-- que hicieron trabajo, es decir, que completaron su primer formulario (o que no tienen formulario y arrancan solas).
-- Los inicios sin completar tienen un tope aparte, más alto (por organización y hora).
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS public_collected_at timestamptz;
UPDATE workflow_runs SET public_collected_at = updated_at WHERE started_by IS NULL AND started_by_api_key IS NULL AND public_collected_at IS NULL AND created_at > now() - interval '1 day' AND (current_step > 0 OR status <> 'waiting');
CREATE INDEX IF NOT EXISTS workflow_runs_public_collected_idx ON workflow_runs (tenant_id, public_collected_at) WHERE public_collected_at IS NOT NULL;

-- Avisos de acuerdos: "¿un job anterior ya avisó a este destino?" (agreements/notices.ts alreadyNotified).
CREATE INDEX IF NOT EXISTS notifications_job_dest_idx ON notifications (tenant_id, destination, template) WHERE job_id IS NOT NULL;

-- Negociaciones: contrapartes observadoras (reciben copia del sobre, no firman). Su rol es una etiqueta libre.
ALTER TABLE negotiation_participants ADD COLUMN IF NOT EXISTS observer boolean NOT NULL DEFAULT false;
