-- Búsqueda de acuerdos por título: índice trigram sobre el título plegado (sin acentos, en minúsculas). La expresión
-- tiene que ser EXACTAMENTE la de titleFoldSql (modules/agreements/repository.ts): si no, el planificador no usa el
-- índice. Con el índice GIN del tsvector, el OR de las dos ramas se resuelve con BitmapOr en lugar de recorrer todos
-- los acuerdos de la organización.
-- pg_trgm puede no estar disponible (PGlite sin la extensión cargada, o un Postgres administrado que no la permite
-- al usuario de la aplicación): entonces no se crea el índice y la búsqueda sigue funcionando, sin él. Todo el bloque
-- va en una sola línea porque las migraciones se parten por punto y coma al final de línea.
DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXECUTE 'CREATE INDEX IF NOT EXISTS agreements_title_fold_trgm_idx ON agreements USING gin ((translate(lower(title), ''áàâãäåéèêëíìîïóòôõöúùûüýÿçñ'', ''aaaaaaeeeeiiiiooooouuuuyycn'')) gin_trgm_ops)'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm no disponible: sin índice trigram de títulos (%)', SQLERRM; END $$;

-- Listado de plantillas paginado por cursor (updated_at, id): el desempate por id en el mismo índice.
CREATE INDEX IF NOT EXISTS templates_tenant_cursor_idx ON templates (tenant_id, updated_at DESC, id DESC);
DROP INDEX IF EXISTS templates_tenant_idx;
