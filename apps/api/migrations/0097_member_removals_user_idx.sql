-- member_removals se consulta y se borra por usuario (baja de la cuenta: ON DELETE CASCADE desde users, liberación de
-- bloqueos JIT/SCIM): la clave primaria (tenant_id, user_id) no sirve para buscar solo por user_id.
CREATE INDEX IF NOT EXISTS member_removals_user_idx ON member_removals (user_id);
