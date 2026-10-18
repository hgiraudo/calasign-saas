-- Plantillas creadas con una API key: la key es su dueña (puede cargarles documentos, roles y campos, y ver las
-- restringidas que creó). Antes solo contaba created_by (usuario), y una key sin templates:manage creaba
-- plantillas que después no podía completar.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS created_by_api_key uuid REFERENCES api_keys(id) ON DELETE SET NULL;
