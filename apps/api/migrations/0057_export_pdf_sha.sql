-- Hash del PDF que se subió en un intento anterior (exportación a almacenamiento, conectores): el certificado de
-- evidencia que se sube después (o en el reintento) describe ese PDF, no una versión renovada mientras tanto.
ALTER TABLE storage_exports ADD COLUMN IF NOT EXISTS pdf_sha256 text;
ALTER TABLE connector_links ADD COLUMN IF NOT EXISTS signed_sha256 text;
