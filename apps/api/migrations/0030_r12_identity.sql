-- Ronda 12: cuándo se restableció la contraseña por última vez. Restablecerla desbloquea la cuenta (los intentos
-- fallidos anteriores dejan de contar). Antes se tomaba solo de la auditoría de sus organizaciones, y una cuenta sin
-- ninguna (p. ej. la quitaron de la única que tenía) no dejaba registro: seguía bloqueada 15 minutos.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_at timestamptz;
