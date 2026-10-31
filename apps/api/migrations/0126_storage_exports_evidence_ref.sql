-- Referencia del certificado de evidencia exportado (Dropbox: su ruta; OneDrive y SharePoint: su webUrl o id; Box: su
-- id), como remote_ref para el PDF. La re-exportación tras renovar el sello reemplaza ese archivo y solo ese: antes la
-- evidencia se reemplazaba por nombre y, si el nombre lo tenía un archivo del cliente (la exportación original había
-- quedado renombrada), se pisaba el del cliente. NULL: exportada antes de esta migración (se sube como una nueva).
ALTER TABLE storage_exports ADD COLUMN IF NOT EXISTS evidence_ref text;
