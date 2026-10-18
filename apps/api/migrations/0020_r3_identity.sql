-- Code review ronda 3 (identidad y formularios web).

-- Una sola verificación de identidad en curso por destinatario. Si ya hubiera duplicadas (carrera anterior),
-- se cancelan todas menos la más reciente antes de crear el índice.
UPDATE identity_verifications v SET status = 'canceled', updated_at = now()
WHERE v.status IN ('created','pending')
  AND EXISTS (
    SELECT 1 FROM identity_verifications w
    WHERE w.recipient_id = v.recipient_id AND w.status IN ('created','pending')
      AND (w.created_at, w.id) > (v.created_at, v.id)
  );
CREATE UNIQUE INDEX identity_verifications_one_active_uq ON identity_verifications (recipient_id) WHERE status IN ('created','pending');

-- Destinatario que se registró solo en un formulario web público: su correo no está verificado, así que
-- no recibe invitaciones ni recordatorios hasta validarlo con el código por correo del formulario.
ALTER TABLE recipients ADD COLUMN self_registered boolean NOT NULL DEFAULT false;

-- Las plantillas aceptan el rol aprobador (el contrato ya lo permitía; la base lo rechazaba con un error interno).
ALTER TABLE template_roles DROP CONSTRAINT template_roles_role_check;
ALTER TABLE template_roles ADD CONSTRAINT template_roles_role_check CHECK (role IN ('signer','cc','approver'));
