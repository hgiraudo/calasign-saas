-- Identidad (Fase 5): verificación de identidad del firmante (KYC), SSO de remitentes (OIDC / SAML 2.0)
-- y aprovisionamiento SCIM 2.0.

-- ───────────── KYC del firmante ─────────────

ALTER TABLE recipients ADD COLUMN id_verification_provider text CHECK (id_verification_provider IN ('mock','truora','veriff'));
ALTER TABLE recipients ADD COLUMN id_verification_level text
  CHECK (id_verification_level IN ('document','document_selfie','document_selfie_liveness'));
ALTER TABLE recipients ADD COLUMN identity_status text CHECK (identity_status IN ('pending','in_progress','verified','failed'));
ALTER TABLE recipients ADD COLUMN identity_verified_at timestamptz;
ALTER TABLE recipients ADD COLUMN identity_failure_reason text;

CREATE TABLE identity_verifications (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  envelope_id     uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id    uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  level           text NOT NULL,
  status          text NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created','pending','verified','failed','expired','canceled')),
  attempt         integer NOT NULL DEFAULT 1,
  provider_ref    text,                                -- id de la sesión en el proveedor
  provider_process_id text,                            -- id de proceso adicional (Truora)
  redirect_url    text,                                -- página del proveedor (flujos "redirect")
  result          jsonb,                               -- resultado normalizado (sin imágenes)
  name_match      jsonb,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX identity_verifications_recipient_idx ON identity_verifications (recipient_id, created_at DESC);
CREATE UNIQUE INDEX identity_verifications_ref_uq ON identity_verifications (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Imágenes del flujo integrado: cifradas en reposo (AES-256-GCM) además del cifrado del almacenamiento.
CREATE TABLE identity_captures (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  verification_id uuid NOT NULL REFERENCES identity_verifications(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('document_front','document_back','selfie','selfie_liveness')),
  file_id         uuid NOT NULL REFERENCES files(id),
  sha256          text NOT NULL,                       -- hash de la imagen en claro
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (verification_id, kind)
);

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check
  CHECK (kind IN ('original','signed','signature_image','attachment','logo','template','identity'));

ALTER TABLE tenants ADD COLUMN identity_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ───────────── SSO de remitentes ─────────────

CREATE TABLE sso_configs (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id),
  enabled                boolean NOT NULL DEFAULT false,
  protocol               text NOT NULL CHECK (protocol IN ('oidc','saml')),
  jit_enabled            boolean NOT NULL DEFAULT true,
  jit_role               text NOT NULL DEFAULT 'member' CHECK (jit_role IN ('admin','member')),
  enforce                boolean NOT NULL DEFAULT false,
  oidc_issuer            text,
  oidc_client_id         text,
  oidc_client_secret_enc text,
  oidc_scopes            text,
  saml_entry_point       text,
  saml_idp_issuer        text,
  saml_idp_cert          text,
  saml_email_attribute   text,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Dominio de correo → organización (descubrimiento "home realm").
CREATE TABLE sso_domains (
  domain          text PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX sso_domains_tenant_idx ON sso_domains (tenant_id);

-- Estado de un inicio de sesión en curso (state / RelayState). Un solo uso, 10 minutos.
CREATE TABLE sso_states (
  state_hash          text PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  protocol            text NOT NULL,
  code_verifier_enc   text,
  nonce               text,
  saml_request_id     text,
  redirect_path       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz
);

-- IDs de AuthnRequest SAML emitidos (validación de InResponseTo con varias instancias de la API).
CREATE TABLE saml_request_cache (
  key             text PRIMARY KEY,
  value           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Cómo se abrió cada sesión: la política "SSO obligatorio" admite solo sesiones SSO de esa organización.
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'password' CHECK (auth_method IN ('password','sso'));
ALTER TABLE sessions ADD COLUMN sso_tenant_id uuid REFERENCES tenants(id);

-- ───────────── SCIM 2.0 ─────────────

CREATE TABLE scim_tokens (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  prefix          text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX scim_tokens_tenant_idx ON scim_tokens (tenant_id);

-- Usuarios aprovisionados por SCIM: siguen visibles para el IdP aunque estén desactivados (sin membresía).
CREATE TABLE scim_users (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  external_id     text,
  active          boolean NOT NULL DEFAULT true,
  given_name      text,
  family_name     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE scim_groups (
  group_id        uuid PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  external_id     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenants ADD COLUMN scim_default_role text NOT NULL DEFAULT 'member' CHECK (scim_default_role IN ('admin','member'));
