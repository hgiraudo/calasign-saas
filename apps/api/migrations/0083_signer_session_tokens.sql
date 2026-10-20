-- Tokens de sesión del firmante derivados del canje de la URL embebida (GET /embed/:code, embed.ts). Antes el canje
-- redirigía a /s/<access_token>: el token PERMANENTE del destinatario quedaba en el historial del iframe o la pestaña, en
-- logs y proxies del integrador y en kioscos compartidos, y se podía reabrir sin límite hasta que el sobre terminara.
-- Ahora redirige a /s/<token de sesión>: toda la superficie /s/:token y /v1/signing/:token/* lo acepta igual que al
-- permanente (signing.ts resolveToken / signerTokenHash) mientras:
--   · no venció: 2 h desde el último uso (deslizante) y nunca más de 8 h desde el canje (max_expires_at);
--   · no se revocó: al cerrarse el sobre (completado, rechazado, anulado o vencido) con 15 minutos de gracia, para que la
--     página embebida muestre el cierre (y el PDF final) y avise `closed` al integrador como antes; o al rotar o quitarse
--     el link del destinatario (en el acto);
--   · access_token_hash sigue siendo el link vigente del destinatario (una corrección del contacto, una delegación o una
--     reasignación lo invalidan aunque el disparador no hubiera corrido).
CREATE TABLE IF NOT EXISTS signer_session_tokens (
  token_hash        text PRIMARY KEY,
  recipient_id      uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  envelope_id       uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  embed_session_id  uuid REFERENCES embed_sessions(id) ON DELETE SET NULL,
  access_token_hash text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  expires_at        timestamptz NOT NULL,
  max_expires_at    timestamptz NOT NULL,
  revoked_at        timestamptz
);
CREATE INDEX IF NOT EXISTS signer_session_tokens_recipient_idx ON signer_session_tokens (recipient_id);
CREATE INDEX IF NOT EXISTS signer_session_tokens_envelope_idx ON signer_session_tokens (envelope_id);

-- (Cuerpos en una sola línea: el runner, db.ts splitSql, corta en un punto y coma al final de línea.)
CREATE OR REPLACE FUNCTION calasign_signer_session_tokens_envelope_closed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE signer_session_tokens SET revoked_at = LEAST(COALESCE(revoked_at, 'infinity'::timestamptz), now() + interval '15 minutes') WHERE envelope_id = NEW.id AND (revoked_at IS NULL OR revoked_at > now()); RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION calasign_signer_session_tokens_link_rotated() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE signer_session_tokens SET revoked_at = now() WHERE recipient_id = NEW.id AND access_token_hash IS DISTINCT FROM NEW.access_token_hash AND (revoked_at IS NULL OR revoked_at > now()); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS envelopes_revoke_signer_session_tokens ON envelopes;
CREATE TRIGGER envelopes_revoke_signer_session_tokens AFTER UPDATE OF status ON envelopes FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'declined', 'voided', 'expired')) EXECUTE FUNCTION calasign_signer_session_tokens_envelope_closed();
DROP TRIGGER IF EXISTS recipients_revoke_signer_session_tokens ON recipients;
CREATE TRIGGER recipients_revoke_signer_session_tokens AFTER UPDATE OF access_token_hash ON recipients FOR EACH ROW WHEN (OLD.access_token_hash IS DISTINCT FROM NEW.access_token_hash) EXECUTE FUNCTION calasign_signer_session_tokens_link_rotated();

-- Vuelta del pago simulado (billing/payments.ts): al link con el que se inició el checkout (el token de sesión embebido
-- si se pagó desde el iframe), no al permanente del destinatario. Cifrado como access_token_enc.
ALTER TABLE envelope_payments ADD COLUMN IF NOT EXISTS checkout_return_token_enc text;
