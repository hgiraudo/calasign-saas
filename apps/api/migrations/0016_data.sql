-- Datos: BYOK, celdas (residencia de datos), renovación de sellos de archivo y verificación de dominios SSO.

-- ───────────── BYOK: clave KMS del cliente ─────────────

ALTER TABLE tenants ADD COLUMN byok_key_arn text;
ALTER TABLE tenants ADD COLUMN byok_status text NOT NULL DEFAULT 'none';
ALTER TABLE tenants ADD CONSTRAINT tenants_byok_status_check CHECK (byok_status IN ('none','active','failing'));
ALTER TABLE tenants ADD COLUMN byok_error text;
ALTER TABLE tenants ADD COLUMN byok_checked_at timestamptz;
ALTER TABLE tenants ADD COLUMN byok_enabled_at timestamptz;
ALTER TABLE tenants ADD COLUMN byok_alerted_at timestamptz;

-- Las claves de los certificados en custodia también se pueden envolver con la clave del cliente.
ALTER TABLE tenant_certificates DROP CONSTRAINT tenant_certificates_key_wrap_method_check;
ALTER TABLE tenant_certificates ADD CONSTRAINT tenant_certificates_key_wrap_method_check CHECK (key_wrap_method IN ('local','kms','kms-byok'));
ALTER TABLE tenant_certificates ADD COLUMN key_wrap_key_arn text;

-- ───────────── Celdas: directorio global tenant → celda ─────────────

-- Plano de control: dónde viven los datos de cada organización. En un despliegue multi-celda esta tabla vive
-- en la base global; acá la comparte el mismo Postgres.
CREATE TABLE tenant_directory (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  cell            text NOT NULL,
  slug            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_directory_cell_idx ON tenant_directory (cell);
INSERT INTO tenant_directory (tenant_id, cell, slug) SELECT id, cell, slug FROM tenants;

-- ───────────── Renovación de sellos de archivo (PAdES B-LTA) ─────────────

ALTER TABLE envelopes ADD COLUMN archive_valid_until timestamptz;
ALTER TABLE envelopes ADD COLUMN archive_checked_at timestamptz;
ALTER TABLE envelopes ADD COLUMN archive_renewals integer NOT NULL DEFAULT 0;
ALTER TABLE envelopes ADD COLUMN archive_error text;
CREATE INDEX envelopes_archive_idx ON envelopes (archive_valid_until) WHERE status = 'completed';

-- Historial de versiones del PDF final: la versión original al completar y cada renovación.
CREATE TABLE envelope_signed_versions (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  envelope_id     uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  file_id         uuid NOT NULL REFERENCES files(id),
  version         integer NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('completed','archive_renewal')),
  valid_until     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_id, version)
);

-- ───────────── Dominios SSO: verificación por DNS ─────────────

ALTER TABLE sso_domains ADD COLUMN verification_token text;
ALTER TABLE sso_domains ADD COLUMN verified_at timestamptz;
ALTER TABLE sso_domains ADD COLUMN last_checked_at timestamptz;
ALTER TABLE sso_domains ADD COLUMN last_error text;
ALTER TABLE sso_domains ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE sso_domains SET verification_token = md5(random()::text || domain || clock_timestamp()::text) WHERE verification_token IS NULL;
ALTER TABLE sso_domains ALTER COLUMN verification_token SET NOT NULL;
-- Varias organizaciones pueden reclamar un dominio mientras ninguna lo verifique; verificado, es de una sola.
ALTER TABLE sso_domains DROP CONSTRAINT sso_domains_pkey;
ALTER TABLE sso_domains ADD PRIMARY KEY (domain, tenant_id);
CREATE UNIQUE INDEX sso_domains_verified_uq ON sso_domains (domain) WHERE verified_at IS NOT NULL;
