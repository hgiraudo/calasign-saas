-- Experiencia (Fase 4): firma en persona (modo anfitrión), correcciones en vuelo, reportes, reenvío de copias.

-- Método de autenticación "en persona": el firmante firma en el dispositivo del anfitrión, que abre la sesión.
ALTER TABLE recipients DROP CONSTRAINT IF EXISTS recipients_auth_method_check;
ALTER TABLE recipients ADD CONSTRAINT recipients_auth_method_check
  CHECK (auth_method IN ('link','otp_email','otp_sms','otp_whatsapp','in_person'));
ALTER TABLE recipients ADD COLUMN in_person_host_user_id uuid REFERENCES users(id);
-- El firmante confirmó su identidad en la pantalla de entrega del dispositivo.
ALTER TABLE recipients ADD COLUMN identity_confirmed_at timestamptz;

-- Reportes por rango de fechas.
CREATE INDEX envelopes_tenant_sent_idx ON envelopes (tenant_id, sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX envelopes_tenant_completed_idx ON envelopes (tenant_id, completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX notifications_tenant_created_idx ON notifications (tenant_id, created_at);
