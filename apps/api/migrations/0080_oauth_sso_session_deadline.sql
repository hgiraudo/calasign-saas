-- Tokens OAuth autorizados desde una sesión SSO: el tope de la familia arranca en la sesión que autorizó, no en el
-- canje del código. El código guarda cuándo vence esa sesión (sso_session_expires_at) y cada token de la familia el
-- tope que se le aplicó (sso_deadline): tope = min(vencimiento de la sesión, creación del código + duración de la
-- conexión). Filas anteriores (NULL): el tope sigue siendo el inicio de la familia + la duración de la conexión.
ALTER TABLE oauth_authorization_codes ADD COLUMN IF NOT EXISTS sso_session_expires_at timestamptz;
ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS sso_deadline timestamptz;
