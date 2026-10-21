-- no-transaction
-- Como 0119, para los niveles de prioridad alta (URGENT_PRIORITIES): los listos más viejos de cada celda y prioridad,
-- por rango en (cell, priority, run_at, id) sin tocar los futuros ni los de otras celdas.
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_cell_claim_idx ON jobs (cell, priority, run_at, id) WHERE status = 'pending';
