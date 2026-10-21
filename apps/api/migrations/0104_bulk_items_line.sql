-- Envío masivo: línea del CSV de origen de cada fila (cuenta el encabezado, las líneas vacías y los saltos dentro de
-- comillas), aparte de row_number, que sigue siendo el número de fila de datos (1, 2, …). NULL: filas en JSON o
-- anteriores a esta columna.
ALTER TABLE bulk_send_items ADD COLUMN IF NOT EXISTS line_number integer;
