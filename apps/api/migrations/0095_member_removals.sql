-- Bajas de miembros desde la consola. Sin registro, el alta automática por SSO (JIT) o una activación por SCIM volvía
-- a sumar a la persona apenas ingresaba (o el IdP la sincronizaba): la baja no se sostenía. Mientras haya fila, JIT y
-- SCIM la rechazan; la borra aceptar una invitación nueva de la organización (también si la acepta el alta JIT/SCIM con
-- una invitación pendiente, que se crea después de la baja).
CREATE TABLE IF NOT EXISTS member_removals (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  removed_by  uuid,
  removed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
