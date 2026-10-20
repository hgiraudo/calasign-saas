-- Apps OAuth creadas con una API key: la key que la creó (created_by queda NULL si la key no tiene persona creadora).
-- Esa misma key, mientras siga vigente, puede seguir administrando su app (URIs de redirección, secreto).
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS created_by_api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
