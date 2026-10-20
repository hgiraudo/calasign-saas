-- Supresión de correos con alcance: una queja suprime la dirección solo para la organización del envío que la recibió
-- (tenant_id); un rebote permanente la suprime para toda la plataforma (tenant_id NULL) pero vence (expires_at,
-- EMAIL_BOUNCE_SUPPRESSION_DAYS, 60 días por defecto). Ver notifications/ses-feedback.ts y docs/CORREO-REBOTES.md.
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE email_suppressions DROP CONSTRAINT IF EXISTS email_suppressions_pkey;
ALTER TABLE email_suppressions ADD COLUMN IF NOT EXISTS id bigserial;
ALTER TABLE email_suppressions ADD PRIMARY KEY (id);
-- Quejas existentes (globales): pasan a la organización del aviso que las originó. Las que no se pueden atribuir se borran.
UPDATE email_suppressions s SET tenant_id = n.tenant_id
  FROM notifications n
 WHERE s.reason = 'complaint' AND s.tenant_id IS NULL AND s.provider_message_id IS NOT NULL AND n.provider_message_id = s.provider_message_id;
DELETE FROM email_suppressions WHERE reason = 'complaint' AND tenant_id IS NULL;
-- Rebotes existentes: vencen a los 60 días de su último rebote.
UPDATE email_suppressions SET expires_at = updated_at + interval '60 days' WHERE reason = 'bounce' AND expires_at IS NULL;
ALTER TABLE email_suppressions ADD CONSTRAINT email_suppressions_scope_check CHECK ((tenant_id IS NULL) = (reason = 'bounce'));
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_global_uq ON email_suppressions (address) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_tenant_uq ON email_suppressions (tenant_id, address) WHERE tenant_id IS NOT NULL;

-- Vinculación de Telegram: el token también cifrado, para devolver el mismo link mientras siga vigente y sin usar (la
-- página de firma ya no crea uno por cada carga).
ALTER TABLE telegram_link_tokens ADD COLUMN IF NOT EXISTS token_enc text;
CREATE INDEX IF NOT EXISTS telegram_link_tokens_recipient_idx ON telegram_link_tokens (recipient_id);

-- Formularios web: la huella de quien completó el formulario (HMAC de formulario + correo + IP) pasa a una columna
-- interna: en envelopes.metadata viajaba por la API, los eventos y los webhooks.
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS web_form_submitter text;
UPDATE envelopes SET web_form_submitter = metadata->>'webFormSubmitter', metadata = metadata - 'webFormSubmitter'
 WHERE metadata ? 'webFormSubmitter';
CREATE INDEX IF NOT EXISTS envelopes_web_form_submitter_idx ON envelopes (tenant_id, web_form_submitter) WHERE web_form_submitter IS NOT NULL;
