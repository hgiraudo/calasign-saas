-- Ronda 13: los tokens OAuth recuerdan cómo se autenticó el usuario que los autorizó (contraseña o SSO, y la
-- organización del SSO). Sin esto, un token autorizado desde una sesión con contraseña seguía valiendo (y el refresh
-- lo renovaba) cuando la organización activaba "SSO obligatorio", aunque las sesiones con contraseña sí se cerraban.
-- Los tokens anteriores quedan sin dato y se tratan como autorizados con contraseña.
ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS auth_method text;
ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS sso_tenant_id uuid;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS auth_method text;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS sso_tenant_id uuid;
