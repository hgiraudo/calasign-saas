-- Suscripciones reemplazadas pendientes de cancelar en el proveedor. Al cambiar de suscripción la nueva se aplica con
-- la organización bloqueada y la anterior queda acá; después, fuera del bloqueo, se cancela en el proveedor y se borra
-- la fila. Si el proveedor falla, el barrido periódico la reintenta. (Antes se cancelaba primero y el aviso de baja de
-- la anterior podía llegar antes de aplicar la nueva, verla todavía vigente y bajar la organización a Free.)
CREATE TABLE IF NOT EXISTS subscription_cancellations (
  provider        text NOT NULL,
  subscription_id text NOT NULL,
  tenant_id       uuid NOT NULL, -- sin FK: si se borra la organización, la anterior igual se tiene que cancelar
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempted_at    timestamptz NOT NULL DEFAULT now(),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  PRIMARY KEY (provider, subscription_id)
);
CREATE INDEX IF NOT EXISTS subscription_cancellations_attempted_idx ON subscription_cancellations (attempted_at);

-- Webhooks de cobro: quién tomó la marca de un evento en curso. Soltarla (si el manejador falla) solo borra la propia:
-- si un pedido tardó más que el umbral y otro la retomó, el primero ya no borra la del segundo.
ALTER TABLE payment_webhook_events ADD COLUMN IF NOT EXISTS claim_id uuid;
