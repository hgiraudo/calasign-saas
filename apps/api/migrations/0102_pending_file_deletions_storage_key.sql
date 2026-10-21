-- Borrado de archivos en dos fases (file-cleanup.ts): la fila de `files` se borra (y se anota acá con su clave) en una
-- transacción corta; el archivo del almacenamiento se borra después, fuera de ella. Si ese borrado falla, el barrido lo
-- reintenta con la clave guardada acá (la fila de `files` ya no existe). Sin clave: anotaciones de antes de este cambio
-- o de una primera fase que falló (la fila de `files` sigue y el barrido repite el borrado entero).
ALTER TABLE pending_file_deletions ADD COLUMN IF NOT EXISTS storage_key text;
