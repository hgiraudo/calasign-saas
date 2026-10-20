-- Credencial con la que se creó la suscripción (REST hooks de Zapier, Make, Power Automate): si se revoca la key o la
-- app, o el usuario la desconecta o deja la organización, la suscripción deja de recibir eventos.
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS created_by_api_key uuid REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE webhook_endpoints ADD COLUMN IF NOT EXISTS oauth_client_id uuid REFERENCES oauth_clients(id) ON DELETE SET NULL;
