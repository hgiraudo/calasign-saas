-- Suscripciones reemplazadas: la fila ya no se borra al cancelarla en el proveedor, se marca done_at. Así queda
-- constancia de que esa suscripción fue reemplazada y un alta atrasada o reprocesada de ella (p. ej. Stripe reintenta
-- un checkout.session.completed viejo) no la vuelve a aplicar ni cancela la vigente. El barrido toma solo las
-- pendientes (done_at IS NULL), con backoff por attempts y un máximo de intentos.
ALTER TABLE subscription_cancellations ADD COLUMN IF NOT EXISTS done_at timestamptz;
DROP INDEX IF EXISTS subscription_cancellations_attempted_idx;
CREATE INDEX IF NOT EXISTS subscription_cancellations_pending_idx ON subscription_cancellations (attempted_at) WHERE done_at IS NULL;
