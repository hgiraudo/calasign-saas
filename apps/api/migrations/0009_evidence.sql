-- Evidencia fuerte (Fase 5): niveles PAdES, certificados de la organización en custodia, sello de empresa.

-- Nivel del sello PAdES por organización. 'auto' = B-LT si la cadena publica OCSP/CRL, si no B-T.
ALTER TABLE tenants ADD COLUMN seal_level text NOT NULL DEFAULT 'auto'
  CHECK (seal_level IN ('auto','B-B','B-T','B-LT','B-LTA'));

-- Certificados de la organización (.p12/.pfx). La clave privada se guarda con cifrado de sobre:
-- clave de datos aleatoria (AES-256-GCM sobre el PKCS#8) envuelta con KMS o con la clave local.
-- Nunca se devuelve por la API.
CREATE TABLE tenant_certificates (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  name                text NOT NULL,
  subject             text NOT NULL,
  issuer              text NOT NULL,
  common_name         text,
  serial_number       text NOT NULL,
  not_before          timestamptz NOT NULL,
  not_after           timestamptz NOT NULL,
  sha256              text NOT NULL,
  key_algorithm       text NOT NULL,
  chain_pem           text NOT NULL,
  key_ciphertext      text,                                -- NULL después de borrar
  key_wrapped         text,
  key_wrap_method     text NOT NULL CHECK (key_wrap_method IN ('local','kms')),
  usages              text[] NOT NULL DEFAULT ARRAY['xml','pdf_seal'],
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at        timestamptz,
  deleted_at          timestamptz
);
CREATE INDEX tenant_certificates_tenant_idx ON tenant_certificates (tenant_id) WHERE deleted_at IS NULL;

-- Sello de empresa: el PDF final se firma además con un certificado de la organización.
ALTER TABLE envelopes ADD COLUMN company_seal_certificate_id uuid REFERENCES tenant_certificates(id);
