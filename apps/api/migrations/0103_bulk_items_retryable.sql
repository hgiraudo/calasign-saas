-- Envío masivo: si una fila fallida se puede reintentar ("Reintentar fallidas"). true: falló por algo del momento o
-- ajeno a sus datos (error temporal o interno, cupo del mes, plan o permisos de quien lo lanzó); false: por sus datos o
-- por la plantilla (se corrige en un envío nuevo). NULL: filas de antes de esta columna (y las no fallidas), que se
-- siguen tratando como antes (reintentables si guardan el pedido entero).
ALTER TABLE bulk_send_items ADD COLUMN IF NOT EXISTS retryable boolean;
