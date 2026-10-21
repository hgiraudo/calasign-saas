-- Autenticación del personal (sesiones, re-autenticación y bloqueo por red).

-- Sesiones: id visible (listar y cerrar una sesión sin exponer el hash del token), momento del último ingreso con
-- credenciales (re-autenticación de acciones sensibles como activar la 2FA), última actividad (cierre por inactividad,
-- SESSION_IDLE_HOURS) y si se pidió "recordarme" (cookie persistente de 14 días, sin cierre por inactividad). Las
-- sesiones abiertas antes de esta migración tenían cookie de 14 días: quedan como "recordarme".
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_uq ON sessions (id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS authenticated_at timestamptz;
UPDATE sessions SET authenticated_at = created_at WHERE authenticated_at IS NULL;
ALTER TABLE sessions ALTER COLUMN authenticated_at SET DEFAULT now();
ALTER TABLE sessions ALTER COLUMN authenticated_at SET NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT true;

-- Intentos de ingreso por (cuenta, ámbito): 'ip:<red>' (la /24 o /64 del cliente: 10 en 15 minutos), 'account' (techo
-- global de la cuenta contra el ataque distribuido: 100 por hora) y '2fa' (códigos del segundo paso, que solo prueba
-- quien ya pasó la contraseña). Antes era una fila por cuenta: los fallos de cualquier IP bloqueaban a la persona.
-- Las filas existentes quedan como el techo global.
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'account';
ALTER TABLE login_attempts DROP CONSTRAINT IF EXISTS login_attempts_pkey;
ALTER TABLE login_attempts ADD PRIMARY KEY (user_id, scope);

-- "Olvidé mi contraseña": el tope de pedidos es por (cuenta, red), así que pedidos desde otra red no dejan sin correo
-- a la persona.
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS ip_key text;
CREATE INDEX IF NOT EXISTS password_resets_user_ip_idx ON password_resets (user_id, ip_key, created_at DESC);

-- "Recordarme" pedido en el login con contraseña: lo hereda la sesión que abre el segundo paso.
ALTER TABLE login_challenges ADD COLUMN IF NOT EXISTS remember boolean NOT NULL DEFAULT false;
