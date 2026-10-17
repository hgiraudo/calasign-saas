-- Firmante y evidencia: OTP, aprobador, delegación/reasignación, recordatorios automáticos, verificación pública.

-- Rol aprobador y estados de reemplazo.
ALTER TABLE recipients DROP CONSTRAINT recipients_role_check;
ALTER TABLE recipients ADD CONSTRAINT recipients_role_check CHECK (role IN ('signer','cc','approver'));
ALTER TABLE recipients DROP CONSTRAINT recipients_status_check;
ALTER TABLE recipients ADD CONSTRAINT recipients_status_check
  CHECK (status IN ('created','sent','viewed','signed','declined','completed','delegated','reassigned'));

-- Cadena de reemplazos (delegó / fue reasignado).
ALTER TABLE recipients ADD COLUMN replaced_by uuid;
ALTER TABLE recipients ADD COLUMN replaces uuid;
ALTER TABLE recipients ADD COLUMN replace_reason text;
ALTER TABLE recipients ADD COLUMN authenticated_at timestamptz;

-- Configuración del sobre.
ALTER TABLE envelopes ADD COLUMN allow_delegation boolean NOT NULL DEFAULT true;
ALTER TABLE envelopes ADD COLUMN reminder_every_days integer CHECK (reminder_every_days BETWEEN 1 AND 60);
ALTER TABLE envelopes ADD COLUMN expiry_warning_days integer DEFAULT 3 CHECK (expiry_warning_days BETWEEN 1 AND 60);
ALTER TABLE envelopes ADD COLUMN last_reminder_at timestamptz;
ALTER TABLE envelopes ADD COLUMN expiry_warning_sent_at timestamptz;
CREATE INDEX envelopes_reminders_idx ON envelopes (status) WHERE status = 'sent' AND (reminder_every_days IS NOT NULL OR expiry_warning_days IS NOT NULL);

-- Códigos de un solo uso para autenticar al firmante.
CREATE TABLE otp_challenges (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  method              text NOT NULL CHECK (method IN ('otp_email','otp_sms','otp_whatsapp')),
  destination         text NOT NULL,
  code_hash           text NOT NULL,
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  verified_at         timestamptz
);
CREATE INDEX otp_challenges_recipient_idx ON otp_challenges (recipient_id, created_at DESC);

-- Sesión del firmante tras validar el código (cookie HttpOnly con path del link).
CREATE TABLE signer_sessions (
  token_hash          text PRIMARY KEY,
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  method              text NOT NULL,
  ip                  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL
);
CREATE INDEX signer_sessions_recipient_idx ON signer_sessions (recipient_id);

-- Verificación pública por hash del PDF sellado.
CREATE INDEX files_signed_sha256_idx ON files (sha256) WHERE kind = 'signed';
