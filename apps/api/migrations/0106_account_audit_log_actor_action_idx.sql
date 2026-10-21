-- no-transaction
-- Bloqueo por intentos fallidos (recentFailedLogins, teams.ts: auth.login_failed por actor, también sin organización) y
-- deduplicación de descargas del hook de auditoría (misma acción del mismo actor en los últimos minutos). Sin él, el
-- caso sin organización recorría la tabla entera. CONCURRENTLY: la tabla es grande y recibe escrituras.
CREATE INDEX CONCURRENTLY IF NOT EXISTS account_audit_log_action_actor_idx ON account_audit_log (action, actor_id, occurred_at);
