-- Ronda 10: un workflow creado con una API key queda a nombre de esa key. Así los envíos del link público se
-- revisan contra la key (si se revoca, el workflow deja de enviar) y los sobres quedan a su nombre.
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS created_by_api_key uuid REFERENCES api_keys(id) ON DELETE SET NULL;
