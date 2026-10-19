-- Conectores MCP (Claude, ChatGPT, Claude Code, Gemini CLI): registro dinámico de clientes OAuth (RFC 7591).
-- Una app registrada por POST /oauth/register no es de ninguna organización: la autoriza un usuario en la pantalla
-- de consentimiento y los tokens quedan en la organización de ese usuario (oauth_tokens.tenant_id, como siempre).
-- Por eso tenant_id pasa a admitir null, solo para estas apps; las de una organización siguen igual.
ALTER TABLE oauth_clients ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE oauth_clients ADD COLUMN registration text NOT NULL DEFAULT 'tenant';
ALTER TABLE oauth_clients ADD COLUMN client_uri text;
ALTER TABLE oauth_clients ADD COLUMN logo_uri text;
ALTER TABLE oauth_clients ADD COLUMN token_endpoint_auth_method text;
ALTER TABLE oauth_clients ADD CONSTRAINT oauth_clients_registration_chk CHECK (
  (registration = 'tenant' AND tenant_id IS NOT NULL)
  OR (registration = 'dynamic' AND tenant_id IS NULL AND service_api_key_id IS NULL AND NOT ('client_credentials' = ANY (grant_types)))
);
-- Barrido de apps registradas que nunca se usaron (ver purgeUnusedDynamicClients).
CREATE INDEX oauth_clients_dynamic_idx ON oauth_clients (created_at) WHERE registration = 'dynamic';
