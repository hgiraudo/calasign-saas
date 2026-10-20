-- Configuraciones guardadas antes de dos validaciones nuevas, que con ellas ya no se podían volver a guardar (400):
--
-- 1. Marca blanca: los textos propios del veredicto de la verificación pública (verify.*, salvo verify.title y
--    verify.text) y del reporte técnico (val.*) ya no se aplican (isProtectedTextKey en @calasign/shared). Se borran de
--    brands.config.texts y de tenants.branding.whiteLabel.texts (por idioma; un idioma que queda vacío se quita).
-- 2. Firma embebida: los comodines de frame-ancestors demasiado amplios (https://*.com.ar, https://*.github.io…:
--    wildcardOriginOk en @calasign/shared, con la misma lista de sufijos) se quitan de tenants.embed_frame_ancestors.
--    embed_sessions.frame_ancestors no se toca: lo pedido por una sesión siempre se cruza con lo autorizado de la
--    organización, y vaciarla haría que la sesión usara TODOS los orígenes autorizados.

CREATE FUNCTION _m0082_protected_key(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT k LIKE 'val.%' OR (k LIKE 'verify.%' AND k NOT IN ('verify.title', 'verify.text'))
$$;

CREATE FUNCTION _m0082_clean_texts(t jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(l.key, f.v), '{}'::jsonb)
    FROM jsonb_each(t) l
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN jsonb_typeof(l.value) = 'object'
                 THEN (SELECT jsonb_object_agg(k.key, k.value) FROM jsonb_each(l.value) k WHERE NOT _m0082_protected_key(k.key))
               ELSE l.value
             END AS v
    ) f
   WHERE f.v IS NOT NULL
$$;

UPDATE brands SET config = jsonb_set(config, '{texts}', _m0082_clean_texts(config->'texts'))
 WHERE jsonb_typeof(config->'texts') = 'object' AND _m0082_clean_texts(config->'texts') IS DISTINCT FROM config->'texts';

UPDATE tenants SET branding = jsonb_set(branding, '{whiteLabel,texts}', _m0082_clean_texts(branding->'whiteLabel'->'texts'))
 WHERE jsonb_typeof(branding->'whiteLabel'->'texts') = 'object'
   AND _m0082_clean_texts(branding->'whiteLabel'->'texts') IS DISTINCT FROM branding->'whiteLabel'->'texts';

CREATE FUNCTION _m0082_bad_origin(o text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN lower(btrim(o)) !~ '^https://\*\.[^:/]+(:[0-9]+)?$' THEN false
           ELSE (
             SELECT h !~ '\.' OR h ~ '(^\.|\.\.|\.$)' OR h = ANY (ARRAY[
    'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'gov.ar', 'edu.ar', 'int.ar', 'mil.ar', 'tur.ar', 'com.br', 'net.br', 'org.br',
    'gov.br', 'edu.br', 'art.br', 'blog.br', 'app.br', 'dev.br', 'eco.br', 'ind.br', 'inf.br', 'tv.br', 'com.mx', 'org.mx',
    'gob.mx', 'edu.mx', 'net.mx', 'com.uy', 'org.uy', 'edu.uy', 'gub.uy', 'net.uy', 'com.py', 'org.py', 'edu.py', 'gov.py',
    'net.py', 'coop.py', 'cl', 'gob.cl', 'co', 'com.co', 'org.co', 'edu.co', 'gov.co', 'net.co', 'com.pe', 'org.pe',
    'gob.pe', 'edu.pe', 'net.pe', 'nom.pe', 'com.ec', 'org.ec', 'gob.ec', 'edu.ec', 'net.ec', 'com.bo', 'org.bo', 'gob.bo',
    'com.ve', 'org.ve', 'gob.ve', 'com.es', 'org.es', 'nom.es', 'gob.es', 'edu.es', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
    'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'net.nz',
    'co.jp', 'ne.jp', 'or.jp', 'co.kr', 'com.cn', 'net.cn', 'org.cn', 'com.tw', 'com.hk', 'com.sg', 'co.in', 'net.in',
    'org.in', 'co.za', 'org.za', 'com.tr', 'com.pt', 'com.pl', 'co.il', 'com.ru', 'github.io', 'gitlab.io', 'herokuapp.com', 'vercel.app',
    'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'blogspot.com', 'glitch.me', 'onrender.com', 'fly.dev',
    'repl.co', 'ngrok.io', 'ngrok-free.app', 's3.amazonaws.com', 'amazonaws.com', 'wixsite.com', 'myshopify.com'
             ])
               FROM (SELECT regexp_replace(substring(lower(btrim(o)) from '^https://\*\.([^:/]+)'), '\.$', '') AS h) x
           )
         END
$$;

UPDATE tenants
   SET embed_frame_ancestors = ARRAY(SELECT u.o FROM unnest(embed_frame_ancestors) WITH ORDINALITY AS u(o, n) WHERE NOT _m0082_bad_origin(u.o) ORDER BY u.n)
 WHERE EXISTS (SELECT 1 FROM unnest(embed_frame_ancestors) AS u(o) WHERE _m0082_bad_origin(u.o));

DROP FUNCTION _m0082_bad_origin(text);
DROP FUNCTION _m0082_clean_texts(jsonb);
DROP FUNCTION _m0082_protected_key(text);
