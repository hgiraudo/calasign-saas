-- Ronda 14: un sobre anulado, rechazado o vencido cierra su checkout abierto en el proveedor (Stripe/Mercado Pago).
-- checkout_closed_at marca los que ya se cerraron, para que el barrido periódico no los vuelva a intentar.
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS checkout_closed_at timestamptz;
