-- Checkout descartado al cambiar el pagador (delegación, reasignación, corrección de su contacto): se guarda para
-- cerrarlo en el proveedor (si no, seguía cobrable y se podía pagar dos veces).
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS stale_checkout_id text;
