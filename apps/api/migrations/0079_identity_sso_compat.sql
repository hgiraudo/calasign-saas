-- Compatibilidad del endurecimiento de identidad (0077) con lo que ya estaba en uso.

-- OIDC: 0077 pasó a exigir email_verified = true por defecto (oidc_trust_unverified_email = false). Las conexiones
-- existentes se configuraron cuando el claim faltante se aceptaba (Microsoft Entra ID no lo manda por defecto): sin esto
-- dejaban de poder ingresar. Solo las conexiones nuevas usan el default estricto; la organización puede apagarlo.
UPDATE sso_configs SET oidc_trust_unverified_email = true WHERE oidc_issuer IS NOT NULL AND NOT oidc_trust_unverified_email;

-- Sesiones SSO abiertas antes del deploy: se crearon con 14 días fijos. Se recortan a la duración de la conexión de su
-- organización (session_ttl_hours, 24 h por defecto) contada desde que se abrieron, como las nuevas.
UPDATE sessions s
   SET expires_at = LEAST(s.expires_at, s.created_at + make_interval(hours => COALESCE((SELECT c.session_ttl_hours FROM sso_configs c WHERE c.tenant_id = s.sso_tenant_id), 24)))
 WHERE s.auth_method = 'sso';
