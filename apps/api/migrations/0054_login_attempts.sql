-- Intentos de contraseña por cuenta, contados ANTES de verificar: el bloqueo por intentos fallidos contaba la auditoría,
-- que se escribe después de verificar, y pedidos en paralelo (desde muchas IP) pasaban todos el chequeo.
CREATE TABLE IF NOT EXISTS login_attempts (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window_start  timestamptz NOT NULL,
  n             integer NOT NULL
);
