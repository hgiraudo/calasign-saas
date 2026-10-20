-- Purga de tokens de sesión del firmante (0083) en el barrido periódico (jobs.ts "signer-session-tokens"): borra los
-- vencidos o revocados hace más de un día, de a 5000 por pasada; estos índices evitan recorrer la tabla entera.
CREATE INDEX IF NOT EXISTS signer_session_tokens_expires_idx ON signer_session_tokens (expires_at);
CREATE INDEX IF NOT EXISTS signer_session_tokens_revoked_idx ON signer_session_tokens (revoked_at) WHERE revoked_at IS NOT NULL;

-- Vuelta neutra desde el proveedor de verificación de identidad (GET /v1/identity/return/:id, signer-return.ts): último
-- token con que el firmante inició o retomó la verificación (cifrado como access_token_enc), fallback sin la cookie de
-- vuelta (iframe de terceros). envelope_payments.checkout_return_token_enc (0083) cumple el mismo papel para los pagos.
ALTER TABLE identity_verifications ADD COLUMN IF NOT EXISTS return_token_enc text;
