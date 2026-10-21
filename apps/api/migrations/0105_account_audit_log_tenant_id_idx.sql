-- no-transaction
-- Listado de la auditoría (GET /v1/audit-log): filtra por organización y pagina por id descendente (cursor = id). El
-- índice (tenant_id, occurred_at DESC, id DESC) de 0005 no sirve para ese orden. CONCURRENTLY: la tabla es grande y
-- recibe escrituras en cada acción administrativa.
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_audit_log_tenant_id_idx ON account_audit_log (tenant_id, id DESC);
