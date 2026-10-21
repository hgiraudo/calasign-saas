-- Firma con certificado: hasta la 0092, un firmante sin la clave matchIdDocument (o con un valor no booleano) exigía
-- por defecto que el certificado correspondiera a su documento si tenía número de documento. Desde la 0092 el valor
-- por defecto es false: los sobres no terminados que se armaron con la regla vieja dejaban de controlar el documento
-- en silencio. Se deja explícito (true) el control que esos firmantes tenían. Idempotente: después de correr, la clave
-- es booleana y la fila ya no entra.
UPDATE recipients r
   SET certificate_requirements =
         CASE WHEN jsonb_typeof(r.certificate_requirements) = 'object' THEN r.certificate_requirements ELSE '{}'::jsonb END
         || '{"matchIdDocument": true}'::jsonb
  FROM envelopes e
 WHERE e.id = r.envelope_id AND e.status NOT IN ('completed', 'declined', 'voided', 'expired')
   AND r.role = 'signer' AND r.signature_type = 'certificate'
   AND jsonb_typeof(r.certificate_requirements -> 'matchIdDocument') IS DISTINCT FROM 'boolean'
   AND COALESCE(btrim(r.id_document_number), '') <> '';
