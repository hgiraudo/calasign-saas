-- Historial de claves BYOK por organización. Al cambiar o desactivar la clave, lo ya guardado sigue cifrado con la
-- anterior (no se re-cifra): una falla de KMS al leer un archivo se atribuye a la organización solo si la clave con la
-- que está cifrado es (o fue) suya. Si no (p. ej. un archivo anterior a BYOK cifrado con la clave de la plataforma),
-- es una falla de almacenamiento genérica, sin exponer el ARN interno.
CREATE TABLE IF NOT EXISTS tenant_byok_keys (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  key_arn         text NOT NULL,
  activated_at    timestamptz NOT NULL DEFAULT now(),
  deactivated_at  timestamptz
);
CREATE INDEX IF NOT EXISTS tenant_byok_keys_tenant_key_idx ON tenant_byok_keys (tenant_id, key_arn);
-- Una sola clave vigente por organización.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_byok_keys_current_uq ON tenant_byok_keys (tenant_id) WHERE deactivated_at IS NULL;

-- Claves anteriores: las activaciones registradas en la auditoría (byok.enabled), salvo la vigente.
INSERT INTO tenant_byok_keys (tenant_id, key_arn, activated_at, deactivated_at)
SELECT a.tenant_id, a.target_id, min(a.occurred_at), now()
  FROM account_audit_log a
 WHERE a.action = 'byok.enabled' AND a.target_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = a.tenant_id)
   AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = a.tenant_id AND t.byok_key_arn = a.target_id AND t.byok_status <> 'none')
   AND NOT EXISTS (SELECT 1 FROM tenant_byok_keys k WHERE k.tenant_id = a.tenant_id AND k.key_arn = a.target_id)
 GROUP BY a.tenant_id, a.target_id;

-- La clave actual (vigente, o cerrada si la organización la desactivó).
INSERT INTO tenant_byok_keys (tenant_id, key_arn, activated_at, deactivated_at)
SELECT t.id, t.byok_key_arn, COALESCE(t.byok_enabled_at, now()), CASE WHEN t.byok_status = 'none' THEN now() END
  FROM tenants t
 WHERE t.byok_key_arn IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM tenant_byok_keys k WHERE k.tenant_id = t.id AND k.key_arn = t.byok_key_arn);
