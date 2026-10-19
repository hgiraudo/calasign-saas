-- Renovación del sello de archivo: una a la vez por sobre. Pedidos simultáneos pagaban un sello de tiempo (y un
-- análisis completo del PDF) cada uno aunque solo uno se guardara.
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS archive_renewing_until timestamptz;
