-- Ronda 12: las apps OAuth registradas antes de que el alta rechazara esquemas peligrosos podían conservar URIs de
-- redirección javascript:, data:, vbscript:, file:, blob:, about: o filesystem:. Se quitan de la lista guardada
-- (el navegador ignora tabs y saltos de línea dentro del esquema, por eso se sacan antes de comparar).
UPDATE oauth_clients
   SET redirect_uris = ARRAY(
         SELECT u FROM unnest(redirect_uris) AS u
          WHERE lower(regexp_replace(btrim(u), '[\t\n\r]', '', 'g')) !~ '^(javascript|data|vbscript|file|blob|about|filesystem):'
       ),
       updated_at = now()
 WHERE EXISTS (
         SELECT 1 FROM unnest(redirect_uris) AS u
          WHERE lower(regexp_replace(btrim(u), '[\t\n\r]', '', 'g')) ~ '^(javascript|data|vbscript|file|blob|about|filesystem):'
       );
