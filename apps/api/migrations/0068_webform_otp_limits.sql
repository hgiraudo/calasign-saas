-- Topes de formularios web por organización (todos sus formularios) y de códigos de verificación por destino y por
-- organización: índices para contarlos sin recorrer la tabla.
CREATE INDEX IF NOT EXISTS envelopes_web_form_tenant_idx ON envelopes (tenant_id, created_at DESC) WHERE (metadata->>'webFormId') IS NOT NULL;
CREATE INDEX IF NOT EXISTS otp_challenges_destination_idx ON otp_challenges (lower(destination), created_at DESC);
CREATE INDEX IF NOT EXISTS otp_challenges_tenant_idx ON otp_challenges (tenant_id, created_at DESC);
