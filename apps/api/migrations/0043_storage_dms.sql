-- Gestores documentales: archivado automático también en SharePoint (biblioteca de un sitio) y Box, y referencia del
-- PDF ya subido para que un reintento (por ejemplo, si falló solo el certificado de evidencia) no lo duplique.
ALTER TABLE storage_connections DROP CONSTRAINT IF EXISTS storage_connections_provider_check;
ALTER TABLE storage_connections ADD CONSTRAINT storage_connections_provider_check CHECK (provider IN ('gdrive','dropbox','onedrive','sharepoint','box','s3'));
ALTER TABLE storage_exports ADD COLUMN IF NOT EXISTS pdf_ref text;
