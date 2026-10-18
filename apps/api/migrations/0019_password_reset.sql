-- Recuperación de contraseña: tokens de un solo uso (se guarda el SHA-256), válidos 30 minutos.
CREATE TABLE password_resets (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);
