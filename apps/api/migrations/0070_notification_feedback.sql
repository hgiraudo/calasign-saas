-- Avisos salientes: rebotes y quejas de SES (vía SNS), supresión de direcciones, reintento por canal dentro del job,
-- tokens de vinculación de Telegram y tope de recordatorios automáticos sin vencimiento.

-- Estados nuevos del aviso: omitido por supresión, rebotado (permanente) y queja de spam.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('queued','sent','failed','suppressed','bounced','complained'));
-- Job que lo envió: un reintento manda solo lo que ese job todavía no envió.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS job_id bigint;
-- Último evento del proveedor (rebote transitorio, rebote permanente, queja).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS feedback_detail text;
CREATE INDEX IF NOT EXISTS notifications_provider_message_idx ON notifications (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_job_idx ON notifications (job_id) WHERE job_id IS NOT NULL;

-- Supresión global por dirección (en minúsculas): rebote permanente o queja. No se le vuelve a escribir.
CREATE TABLE IF NOT EXISTS email_suppressions (
  address              text PRIMARY KEY,
  reason               text NOT NULL CHECK (reason IN ('bounce','complaint')),
  detail               text,
  provider_message_id  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Vinculación de Telegram: token propio (no el de firma), de un solo uso, con vencimiento corto, guardado como hash.
-- access_token_hash: el link del firmante vigente al crearlo (una corrección del contacto lo invalida).
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token_hash         text PRIMARY KEY,
  recipient_id       uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  access_token_hash  text NOT NULL,
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_link_tokens_expires_idx ON telegram_link_tokens (expires_at);

-- Recordatorios automáticos enviados a cada destinatario (tope cuando el sobre no vence).
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS auto_reminders_sent integer NOT NULL DEFAULT 0;
