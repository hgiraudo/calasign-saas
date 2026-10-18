-- Ronda 11 (pre-secuestro de cuenta): el registro no verifica el correo, así que alguien puede crear una cuenta con el
-- correo de otra persona y esperar a que el SSO (alta JIT) o SCIM de la organización de esa persona la vincule. Las
-- membresías que crean SSO o SCIM no admiten sesiones con contraseña hasta que el usuario la restablece (lo que prueba
-- que controla el correo).
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS password_allowed boolean NOT NULL DEFAULT true;
