-- Sello de archivo: el intervalo mínimo entre renovaciones se mide desde la última renovación exitosa. Antes se medía
-- desde archive_checked_at, que también mueve una falla: un sobre ya renovado que fallaba esperaba 30 días en lugar de
-- reintentarse al día siguiente.
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS archive_renewed_at timestamptz;
UPDATE envelopes e SET archive_renewed_at = v.at
  FROM (SELECT envelope_id, max(created_at) AS at FROM envelope_signed_versions WHERE reason = 'archive_renewal' GROUP BY envelope_id) v
 WHERE v.envelope_id = e.id AND e.archive_renewed_at IS NULL;

-- Avisos a la organización que salen una sola vez (p. ej. "la TSA no puede extender el sello de archivo", por
-- certificado de TSA): el barrido horario reclama la fila y solo el primero manda el correo.
CREATE TABLE IF NOT EXISTS tenant_alerts (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  key         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, key)
);

-- Conexiones de almacenamiento desactivadas por el sistema (p. ej. quien la conectó con su cuenta personal dejó la
-- organización): el motivo se muestra traducido y una así no se reactiva sin volver a conectarla.
ALTER TABLE storage_connections ADD COLUMN IF NOT EXISTS deactivated_reason text;
