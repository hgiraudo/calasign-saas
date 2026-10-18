-- Ronda 15: un pago que llega con el sobre ya cerrado (anulado, rechazado o vencido) se reembolsa. Pasa con una sesión
-- de Stripe pagada antes de que el barrido la venciera, o con un Boleto/efectivo de Mercado Pago iniciado antes y
-- acreditado días después: la preferencia vencida no frena esos pagos. El barrido periódico hace el reembolso.
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS refund_required_at timestamptz;
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS refund_error text;
