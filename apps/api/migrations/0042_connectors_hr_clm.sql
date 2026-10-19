-- Conectores out-of-the-box con RR. HH. (BambooHR, HiBob, Factorial) y gestión de contratos (Ironclad, Juro):
-- conexiones por organización, flujos registro → plantilla, vínculo sobre ↔ registro y ejecuciones.
-- Ver docs/CONECTORES.md.

CREATE TABLE connector_connections (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  provider            text NOT NULL CHECK (provider IN ('bamboohr','hibob','factorial','ironclad','juro')),
  category            text NOT NULL CHECK (category IN ('hris','clm')),
  name                text NOT NULL,
  auth_type           text NOT NULL CHECK (auth_type IN ('oauth','api_key')),
  credentials_enc     text NOT NULL,                       -- JSON cifrado (tokens OAuth o claves)
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,   -- región, dominio de la empresa, etc. (sin secretos)
  account_label       text,
  webhook_token_hash  text NOT NULL UNIQUE,                -- sha256 del secreto de la URL de webhook
  webhook_token_enc   text NOT NULL,                       -- el secreto cifrado (para mostrar la URL a los admins)
  active              boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_success_at     timestamptz,
  last_error          text
);
CREATE INDEX connector_connections_tenant_idx ON connector_connections (tenant_id);

CREATE TABLE connector_flows (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  connection_id       uuid NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  name                text NOT NULL,
  object_type         text NOT NULL CHECK (object_type IN ('employee','workflow','record','contract')),
  template_id         uuid REFERENCES templates(id) ON DELETE SET NULL,
  document_source     text NOT NULL DEFAULT 'template' CHECK (document_source IN ('template','record')),
  role_map            jsonb NOT NULL DEFAULT '[]'::jsonb,
  prefill_map         jsonb NOT NULL DEFAULT '[]'::jsonb,
  write_back          jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger             text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','webhook')),
  trigger_config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  send                boolean NOT NULL DEFAULT true,
  active              boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES users(id),
  created_by_api_key  uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_flows_tenant_idx ON connector_flows (tenant_id);
CREATE INDEX connector_flows_connection_idx ON connector_flows (connection_id);

CREATE TABLE connector_links (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  connection_id       uuid NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  flow_id             uuid REFERENCES connector_flows(id) ON DELETE SET NULL,
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  object_type         text NOT NULL,
  object_id           text NOT NULL,
  last_status         text,
  delivered_at        timestamptz,                         -- PDF firmado (y evidencia) entregados al origen
  signed_ref          text,                                -- referencia del PDF ya subido (no se repite en un reintento)
  remote_ref          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, envelope_id)
);
CREATE INDEX connector_links_envelope_idx ON connector_links (envelope_id);
CREATE INDEX connector_links_flow_object_idx ON connector_links (flow_id, object_id);

CREATE TABLE connector_runs (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  connection_id       uuid REFERENCES connector_connections(id) ON DELETE CASCADE,
  flow_id             uuid REFERENCES connector_flows(id) ON DELETE SET NULL,
  link_id             uuid REFERENCES connector_links(id) ON DELETE SET NULL,
  envelope_id         uuid,
  kind                text NOT NULL CHECK (kind IN ('send','write_back')),
  event               text,
  object_type         text,
  object_id           text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempts            integer NOT NULL DEFAULT 0,
  detail              jsonb NOT NULL DEFAULT '{}'::jsonb,
  error               text,
  dedupe_key          text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_runs_tenant_created_idx ON connector_runs (tenant_id, created_at DESC);
CREATE INDEX connector_runs_envelope_idx ON connector_runs (envelope_id);
