-- Sesión de firma integrada (token de sesión del canje embebido, signer_session_tokens) desde la que se inició la
-- verificación de identidad: sha256 del token. Para un destinatario NO embebido, el token de sesión del integrador
-- sigue valiendo después de la verificación solo si la verificación aprobada se inició (y se siguió) desde esa misma
-- sesión (signer-token.ts). Se borra si la verificación se retoma, recibe fotos o se consulta desde otro token.
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS session_token_hash text;
