-- Región que la organización eligió en el alta, cuando no es la celda donde quedó. Desde el 30-Oct-2026 el alta ofrece
-- todas las regiones del catálogo; si se elige una que el despliegue todavía no tiene configurada, la organización
-- queda en la celda por defecto (tenants.cell) y acá queda lo que pidió, para migrarla cuando esa celda exista.
-- NULL: quedó en la que eligió (o se dio de alta antes). Sin DEFAULT: no reescribe la tabla.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS requested_cell text;
