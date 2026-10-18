-- Ronda 14: una vista de acuerdos creada con una API key queda a nombre de esa key. Sin esta columna quedaba con
-- user_id NULL: la key recibía 201 pero no la veía en su lista ni la podía usar (404), y cualquier otra key la veía
-- como "propia" en las vistas compartidas (NULL === NULL en la app).
ALTER TABLE agreement_views ADD COLUMN IF NOT EXISTS created_by_api_key uuid REFERENCES api_keys(id) ON DELETE SET NULL;
