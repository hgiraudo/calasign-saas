-- Plataforma: OAuth 2.0, avisos a Slack/Teams, exportación a almacenamiento en la nube y dominio propio.

-- ───────────────────────────── OAuth 2.0 ─────────────────────────────

-- Aplicación registrada por una organización. Puede usar client_credentials (actúa como la propia app,
-- con un rol como una API key) y/o authorization_code + PKCE (actúa en nombre de un usuario que la autoriza).
CREATE TABLE oauth_clients (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  client_id           text NOT NULL UNIQUE,
  secret_hash         text,                                   -- null: cliente público (solo authorization_code + PKCE)
  secret_prefix       text,
  name                text NOT NULL,
  description         text,
  redirect_uris       text[] NOT NULL DEFAULT '{}',
  grant_types         text[] NOT NULL,
  scopes              text[] NOT NULL,
  -- client_credentials: identidad de servicio respaldada por una API key interna (rol y propiedad de sobres).
  service_api_key_id  uuid REFERENCES api_keys(id),
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz
);
CREATE INDEX oauth_clients_tenant_idx ON oauth_clients (tenant_id);

-- Las API keys internas de las apps OAuth no se listan entre las API keys de la organización.
ALTER TABLE api_keys ADD COLUMN oauth_client_id uuid REFERENCES oauth_clients(id);

CREATE TABLE oauth_authorization_codes (
  code_hash             text PRIMARY KEY,
  client_id             uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  user_id               uuid NOT NULL REFERENCES users(id),
  redirect_uri          text NOT NULL,
  scopes                text[] NOT NULL,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL CHECK (code_challenge_method = 'S256'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz
);

-- Tokens opacos (solo se guarda el hash). Los refresh tokens rotan: cada uso emite uno nuevo de la misma
-- familia; si se presenta uno ya usado, se revoca la familia entera (detección de reutilización).
CREATE TABLE oauth_tokens (
  id                  uuid PRIMARY KEY,
  token_hash          text NOT NULL UNIQUE,
  kind                text NOT NULL CHECK (kind IN ('access','refresh')),
  client_id           uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  user_id             uuid REFERENCES users(id),
  service_api_key_id  uuid REFERENCES api_keys(id),
  scopes              text[] NOT NULL,
  family_id           uuid NOT NULL,
  code_hash           text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  revoked_at          timestamptz,
  last_used_at        timestamptz
);
CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id);
CREATE INDEX oauth_tokens_client_user_idx ON oauth_tokens (client_id, user_id);

CREATE TABLE oauth_consents (
  client_id   uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  scopes      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, user_id, tenant_id)
);

-- ───────────────────────────── Avisos a Slack / Microsoft Teams ─────────────────────────────

CREATE TABLE notification_integrations (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL CHECK (kind IN ('slack','teams')),
  name          text NOT NULL,
  url_enc       text NOT NULL,                                -- URL del webhook entrante, cifrada (es un secreto)
  url_hint      text NOT NULL,                                -- host + final de la URL, para mostrar
  events        text[] NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz,
  last_status   integer,
  last_error    text
);
CREATE INDEX notification_integrations_tenant_idx ON notification_integrations (tenant_id) WHERE active;

-- ───────────────────────────── Exportación a almacenamiento en la nube ─────────────────────────────

CREATE TABLE storage_connections (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  provider         text NOT NULL CHECK (provider IN ('gdrive','dropbox','onedrive','s3')),
  name             text NOT NULL,
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,      -- carpeta, bucket, endpoint, región, prefijo
  credentials_enc  text NOT NULL,                           -- tokens OAuth o claves de acceso, cifrados
  account_label    text,
  active           boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_success_at  timestamptz,
  last_error       text
);
CREATE INDEX storage_connections_tenant_idx ON storage_connections (tenant_id) WHERE active;

CREATE TABLE storage_exports (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  connection_id  uuid NOT NULL REFERENCES storage_connections(id) ON DELETE CASCADE,
  envelope_id    uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempts       integer NOT NULL DEFAULT 0,
  remote_ref     text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, envelope_id)
);
CREATE INDEX storage_exports_tenant_idx ON storage_exports (tenant_id, created_at DESC);

-- ───────────────────────────── Dominio propio (white-label) ─────────────────────────────

CREATE TABLE custom_domains (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL UNIQUE REFERENCES tenants(id),
  domain              text NOT NULL UNIQUE,
  verification_token  text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified')),
  verified_at         timestamptz,
  last_checked_at     timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
