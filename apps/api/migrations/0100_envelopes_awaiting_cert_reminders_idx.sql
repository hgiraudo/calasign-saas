-- no-transaction
-- Recordatorios y avisos de vencimiento también para sobres esperando firmas con certificado (reminders.ts). Antes en
-- 0096; CONCURRENTLY para no bloquear las escrituras de envelopes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS envelopes_awaiting_cert_reminders_idx ON envelopes (status)
  WHERE status = 'awaiting_certificates' AND (reminder_every_days IS NOT NULL OR expiry_warning_days IS NOT NULL);
