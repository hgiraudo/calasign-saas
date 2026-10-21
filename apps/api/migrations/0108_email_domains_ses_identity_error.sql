-- Aviso de rechazo de Amazon SES (identidad sin verificar) en su propia columna. Antes iba en last_error, que también
-- escribe la verificación por DNS: un error de DNS lo pisaba y, cuando el DNS volvía a responder, el aviso de SES se
-- perdía aunque SES siguiera rechazando (los envíos en espera no lo vuelven a anotar). last_error queda para el DNS.
ALTER TABLE email_domains ADD COLUMN IF NOT EXISTS ses_identity_error_at timestamptz;
UPDATE email_domains
   SET ses_identity_error_at = now(), last_error = NULL
 WHERE last_error LIKE 'SES rechazó el remitente:%';
