-- no-transaction
-- Toma de jobs de un worker que atiende solo algunas celdas (SERVED_CELLS): los listos más viejos de cada celda suya
-- (y de los sin celda), por rango en (cell, run_at, id). Sin esto el filtro de celda recorría jobs_pending_run_at_idx
-- pasando por todos los pendientes de las otras celdas. Parcial: solo los pendientes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_cell_pending_run_at_idx ON jobs (cell, run_at, id) WHERE status = 'pending';
