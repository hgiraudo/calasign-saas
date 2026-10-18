-- Fase 6 — IA (opt-in por organización): configuración, consumo de tokens, metadatos del contrato,
-- asistencia al firmante y alertas de renovación.

ALTER TABLE tenants ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN ai_monthly_token_budget integer NOT NULL DEFAULT 500000;
ALTER TABLE tenants ADD COLUMN ai_auto_extract boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN ai_renewal_alert_days integer NOT NULL DEFAULT 30;
ALTER TABLE tenants ADD COLUMN ai_playbook jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tenants ADD COLUMN ai_notice_version text;
ALTER TABLE tenants ADD COLUMN ai_notice_accepted_at timestamptz;
ALTER TABLE tenants ADD COLUMN ai_notice_accepted_by uuid;

ALTER TABLE envelopes ADD COLUMN ai_signer_assist boolean NOT NULL DEFAULT false;
ALTER TABLE envelopes ADD COLUMN ai_metadata jsonb;
ALTER TABLE envelopes ADD COLUMN ai_metadata_confidence jsonb;
ALTER TABLE envelopes ADD COLUMN ai_metadata_source text CHECK (ai_metadata_source IN ('ai','manual'));
ALTER TABLE envelopes ADD COLUMN ai_metadata_updated_at timestamptz;
ALTER TABLE envelopes ADD COLUMN ai_metadata_attempted_at timestamptz;
ALTER TABLE envelopes ADD COLUMN ai_renewal_alert_at date;
ALTER TABLE envelopes ADD COLUMN ai_renewal_alert_sent_at timestamptz;
ALTER TABLE envelopes ADD COLUMN ai_review jsonb;

CREATE INDEX envelopes_ai_renewal_idx ON envelopes (ai_renewal_alert_at) WHERE ai_renewal_alert_sent_at IS NULL AND ai_renewal_alert_at IS NOT NULL;
CREATE INDEX envelopes_ai_pending_extract_idx ON envelopes (completed_at) WHERE status = 'completed' AND ai_metadata IS NULL AND ai_metadata_attempted_at IS NULL;

-- Una fila por llamada al modelo (mock incluido): base del presupuesto mensual y de la auditoría.
CREATE TABLE ai_usage (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid,
  feature             text NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  prompt_sha256       text NOT NULL,
  actor_type          text NOT NULL,
  actor_id            text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_tenant_month_idx ON ai_usage (tenant_id, created_at);
