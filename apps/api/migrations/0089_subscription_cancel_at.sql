-- Baja programada de la suscripción (Stripe: cancel_at_period_end / cancel_at). La consola muestra "Termina el …" en
-- lugar de "Se renueva el …". El estado (past_due, unpaid…) ya se guarda en subscription_status.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_cancel_at timestamptz;
