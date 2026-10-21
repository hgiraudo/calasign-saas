-- Nivel que declaraba la integración del proveedor (VERIFF_INTEGRATION_LEVEL, flujo de Truora por nivel) al iniciar la
-- verificación: lo que se infiere de la aprobación (coincidencia facial / prueba de vida informadas por la integración)
-- sale de este valor y no de la configuración al momento del resultado, así un cambio de la variable no afecta a las
-- verificaciones en curso. 'none' = la integración no declaraba nada; NULL = fila anterior (se usa la configuración).
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS integration_level text
  CHECK (integration_level IS NULL OR integration_level IN ('none', 'document', 'document_selfie', 'document_selfie_liveness'));
