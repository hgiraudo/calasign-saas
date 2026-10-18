-- Ronda 16: aceptar una invitación con contraseña, si la cuenta tiene 2FA, ya no crea la membresía antes del segundo
-- factor. El desafío recuerda la invitación y la membresía se crea recién al verificar el código; si no, alguien con
-- solo la contraseña sumaba la cuenta de la víctima a su propia organización.
ALTER TABLE login_challenges ADD COLUMN IF NOT EXISTS invitation_id uuid REFERENCES invitations(id) ON DELETE CASCADE;
