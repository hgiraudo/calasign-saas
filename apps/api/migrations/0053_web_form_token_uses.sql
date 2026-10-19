-- Formularios web: cada token de formulario sirve para un solo envío (antes, uno solo alcanzaba para crear sobres
-- sin límite durante 2 h, sin volver a pasar por el tiempo mínimo de llenado).
CREATE TABLE IF NOT EXISTS web_form_token_uses (
  token_hash  text PRIMARY KEY,
  used_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_form_token_uses_used_idx ON web_form_token_uses (used_at);
