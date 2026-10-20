-- pg_trgm de nuevo, ahora que el deploy de dev instala postgresql*-contrib (en las instancias creadas antes de que
-- bootstrap lo instalara, 0088 no pudo crear la extensión ni el índice), y el índice trigram de títulos con la nueva
-- expresión de titleFoldSql (modules/agreements/repository.ts): normalize NFC y más letras latinas con diacríticos,
-- también en mayúscula. Tiene que ser EXACTAMENTE la misma expresión; si no, el planificador no usa el índice
-- (test/agreements-title-fold.test.ts lo compara con este archivo).
-- Primero se borra el índice anterior (expresión vieja: ya no lo usa ninguna consulta). Si pg_trgm no está disponible
-- (PGlite sin la extensión, un Postgres administrado que no la permite) no se crea y la búsqueda funciona sin él; la API
-- avisa en el log al arrancar. Todo el bloque en una sola línea: las migraciones se parten por punto y coma al final de línea.
DROP INDEX IF EXISTS agreements_title_fold_trgm_idx;
DO $$ BEGIN CREATE EXTENSION IF NOT EXISTS pg_trgm; EXECUTE 'CREATE INDEX IF NOT EXISTS agreements_title_fold_trgm_idx ON agreements USING gin ((translate(lower(normalize(title, NFC)), ''áàâãäåāăąçćčĉċďđéèêëēĕėęěğĝġģĥħíìîïīĭįĩıĵķĺļľŀłñńņňóòôõöøōŏőŕŗřśŝşšșţťŧțúùûüũūŭůűųŵýÿŷźżžÁÀÂÃÄÅĀĂĄÇĆČĈĊĎĐÉÈÊËĒĔĖĘĚĞĜĠĢĤĦÍÌÎÏĪĬĮĨİĴĶĹĻĽĿŁÑŃŅŇÓÒÔÕÖØŌŎŐŔŖŘŚŜŞŠȘŢŤŦȚÚÙÛÜŨŪŬŮŰŲŴÝŸŶŹŻŽ'', ''aaaaaaaaacccccddeeeeeeeeegggghhiiiiiiiiijklllllnnnnooooooooorrrsssssttttuuuuuuuuuuwyyyzzzaaaaaaaaacccccddeeeeeeeeegggghhiiiiiiiiijklllllnnnnooooooooorrrsssssttttuuuuuuuuuuwyyyzzz'')) gin_trgm_ops)'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_trgm no disponible: sin índice trigram de títulos (%)', SQLERRM; END $$;
