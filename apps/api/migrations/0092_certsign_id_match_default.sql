-- Firma con certificado: «el certificado tiene que corresponder al documento» pasa a ser false por defecto y solo traba
-- cuando el remitente lo pide a mano en un destinatario con documento. En las plantillas el número de documento no se
-- conoce (llega en cada sobre, o no llega en formularios, envíos masivos, CRM…): se apaga en los roles que lo pedían.
UPDATE template_roles SET certificate_requirements = certificate_requirements || '{"matchIdDocument": false}'::jsonb
 WHERE jsonb_typeof(certificate_requirements) = 'object' AND COALESCE((certificate_requirements->>'matchIdDocument')::boolean, false);

-- Sobres no terminados con destinatarios que lo piden sin número de documento: se baja con la marca que la firma
-- registra en la evidencia (idDocumentMatch = skipped_missing_id_document) en vez de quedar trabados.
UPDATE recipients r SET certificate_requirements = r.certificate_requirements || '{"matchIdDocument": false, "idDocumentMatchSkipped": true}'::jsonb
  FROM envelopes e
 WHERE e.id = r.envelope_id AND e.status NOT IN ('completed', 'declined', 'voided', 'expired')
   AND jsonb_typeof(r.certificate_requirements) = 'object' AND COALESCE((r.certificate_requirements->>'matchIdDocument')::boolean, false)
   AND COALESCE(btrim(r.id_document_number), '') = '';

-- Preparados de la firma con certificado reemplazados por una preparación nueva de la misma sesión: el Firmador puede
-- estar bajándolos o firmándolos todavía, así que no se borran en el momento; el barrido los borra pasado un margen.
-- Sin claves foráneas: si el sobre se borra, la fila tiene que seguir para que el barrido borre el archivo.
CREATE TABLE certsign_stale_blobs (
  storage_key   text PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  envelope_id   uuid NOT NULL,
  superseded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX certsign_stale_blobs_superseded ON certsign_stale_blobs (superseded_at);
CREATE INDEX certsign_stale_blobs_envelope ON certsign_stale_blobs (envelope_id);
