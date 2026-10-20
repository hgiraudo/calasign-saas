-- Webhooks de cobro: la marca de idempotencia se toma al recibir y se confirma al terminar (processed_at). Un evento
-- recibido y sin terminar se reintenta (el proveedor recibe 409 mientras es reciente; uno viejo se reprocesa): antes se
-- registraba como procesado antes de procesarlo y, si el proceso moría, el evento se perdía.
ALTER TABLE payment_webhook_events ADD COLUMN IF NOT EXISTS processed_at timestamptz;
UPDATE payment_webhook_events SET processed_at = received_at WHERE processed_at IS NULL;

-- Checkouts descartados al cambiar el pagador o su contacto: todos se cierran en el proveedor (stale_checkout_ids, la
-- cola del barrido) y un pago que llegue por cualquiera de ellos se reembolsa (discarded_checkout_refs, permanente).
-- checkout_ref identifica el checkout en lo que devuelve el proveedor: el id de la sesión en Stripe, la referencia
-- propia que va en external_reference en Mercado Pago (el pago no trae el id de la preferencia).
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS checkout_ref text;
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS stale_checkout_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS discarded_checkout_refs text[] NOT NULL DEFAULT '{}';
UPDATE envelope_payments SET stale_checkout_ids = ARRAY[stale_checkout_id], discarded_checkout_refs = ARRAY[stale_checkout_id] WHERE stale_checkout_id IS NOT NULL;
ALTER TABLE envelope_payments DROP COLUMN IF EXISTS stale_checkout_id;

-- Contracargo o disputa abierta en el proveedor (Stripe charge.dispute.created, Mercado Pago charged_back). El estado
-- del cobro no cambia: queda la marca y el evento en la evidencia.
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS disputed_at timestamptz;

-- Reembolsos y disputas informados por el proveedor se buscan por el id del pago acreditado.
CREATE INDEX IF NOT EXISTS envelope_payments_provider_payment_idx ON envelope_payments (provider, provider_payment_id);
