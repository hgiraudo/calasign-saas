-- Ronda 10: un mapeo de CRM creado con una API key tiene dueño. Sin esta columna quedaba con created_by NULL:
-- el webhook enviaba sobres sin dueño (la key que lo configuró no los veía) y seguía enviando aunque se revocara la key.
ALTER TABLE crm_mappings ADD COLUMN created_by_api_key uuid REFERENCES api_keys(id) ON DELETE SET NULL;
