-- CRM y ERP (Fase 6): conexiones por organización (HubSpot, Salesforce, Siigo, Alegra), mapeos de registros
-- a plantillas, vínculo sobre ↔ registro y registro de ejecuciones (envíos, write-backs, adjuntos).

CREATE TABLE crm_connections (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  provider          text NOT NULL CHECK (provider IN ('hubspot','salesforce','siigo','alegra')),
  name              text NOT NULL,
  auth_type         text NOT NULL CHECK (auth_type IN ('oauth','token')),
  credentials_enc   text NOT NULL,                       -- JSON cifrado (tokens / usuario + clave)
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- instance_url, portal_id, etc.
  account_label     text,
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_success_at   timestamptz,
  last_error        text
);
CREATE INDEX crm_connections_tenant_idx ON crm_connections (tenant_id);
CREATE INDEX crm_connections_portal_idx ON crm_connections ((config->>'portalId')) WHERE provider = 'hubspot';

CREATE TABLE crm_mappings (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  connection_id     uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  name              text NOT NULL,
  object_type       text NOT NULL CHECK (object_type IN ('deal','opportunity','customer','contact','invoice')),
  template_id       uuid REFERENCES templates(id) ON DELETE SET NULL,
  role_map          jsonb NOT NULL DEFAULT '[]'::jsonb,
  prefill_map       jsonb NOT NULL DEFAULT '[]'::jsonb,
  write_back        jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger           text NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','webhook','on_completion')),
  trigger_config    jsonb NOT NULL DEFAULT '{}'::jsonb,
  send              boolean NOT NULL DEFAULT true,
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_mappings_tenant_idx ON crm_mappings (tenant_id);
CREATE INDEX crm_mappings_connection_idx ON crm_mappings (connection_id);

-- Un sobre puede estar vinculado a registros de varias conexiones (ej. el Deal de HubSpot y el cliente de Siigo).
CREATE TABLE crm_links (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  connection_id     uuid NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  mapping_id        uuid REFERENCES crm_mappings(id) ON DELETE SET NULL,
  envelope_id       uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  object_type       text NOT NULL,
  object_id         text NOT NULL,
  last_status       text,
  pdf_attached_at   timestamptz,
  remote_ref        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, envelope_id)
);
CREATE INDEX crm_links_envelope_idx ON crm_links (envelope_id);

CREATE TABLE crm_runs (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  connection_id     uuid REFERENCES crm_connections(id) ON DELETE CASCADE,
  mapping_id        uuid REFERENCES crm_mappings(id) ON DELETE SET NULL,
  link_id           uuid REFERENCES crm_links(id) ON DELETE SET NULL,
  envelope_id       uuid,
  kind              text NOT NULL CHECK (kind IN ('send','write_back','attach','match','test')),
  event             text,
  object_type       text,
  object_id         text,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempts          integer NOT NULL DEFAULT 0,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  error             text,
  dedupe_key        text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_runs_tenant_created_idx ON crm_runs (tenant_id, created_at DESC);
CREATE INDEX crm_runs_envelope_idx ON crm_runs (envelope_id);
