-- identity_verifications.result guardaba el resultado completo del proveedor: número de documento y fecha de nacimiento.
-- Desde ahora se guarda enmascarado (como lo muestran la API y el certificado: asteriscos y los últimos 4) y del
-- nacimiento solo el año. La comparación con lo declarado ya quedó en name_match y nada vuelve a leer el número completo
-- ni la fecha, así que enmascarar los existentes es seguro (y es idempotente: un número ya enmascarado no cambia).
UPDATE identity_verifications SET result = jsonb_set(result, '{document,number}', to_jsonb(CASE WHEN length(regexp_replace(result->'document'->>'number', '\s+', '', 'g')) <= 4 THEN '****' ELSE repeat('*', least(6, length(regexp_replace(result->'document'->>'number', '\s+', '', 'g')) - 4)) || right(regexp_replace(result->'document'->>'number', '\s+', '', 'g'), 4) END))
 WHERE jsonb_typeof(result->'document') = 'object' AND COALESCE(result->'document'->>'number', '') <> '';
UPDATE identity_verifications SET result = jsonb_set(result, '{person,birthDate}', COALESCE(to_jsonb(substring(result->'person'->>'birthDate' from '(?:^|\D)((?:19|20)\d{2})(?:\D|$)')), 'null'::jsonb))
 WHERE jsonb_typeof(result->'person') = 'object' AND COALESCE(result->'person'->>'birthDate', '') <> '';
-- Sobres ya purgados por retención: queda solo el resumen (lo mismo que hace ahora la purga, PURGED_IDV_RESULT_SQL en
-- modules/retention.ts).
UPDATE identity_verifications v SET result = jsonb_build_object(
  'status', v.result->'status',
  'document', jsonb_build_object('type', v.result->'document'->'type', 'country', v.result->'document'->'country', 'number', NULL, 'expiresOn', NULL),
  'person', jsonb_build_object('firstName', NULL, 'lastName', NULL, 'fullName', NULL, 'birthDate', NULL),
  'faceMatchScore', v.result->'faceMatchScore', 'liveness', v.result->'liveness', 'riskFlags', COALESCE(v.result->'riskFlags', '[]'::jsonb),
  'reference', v.result->'reference', 'declineReason', v.result->'declineReason', 'purged', true)
 FROM envelopes e WHERE e.id = v.envelope_id AND e.purged_at IS NOT NULL AND v.result IS NOT NULL;
