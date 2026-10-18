-- Formularios web creados con una API key: la key es su dueña (puede editarlos y ve sus sobres) y, si se revoca,
-- el formulario deja de crear sobres.
ALTER TABLE web_forms ADD COLUMN created_by_api_key uuid REFERENCES api_keys(id) ON DELETE SET NULL;
