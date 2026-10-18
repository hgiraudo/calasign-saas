-- Firma con certificado propio del firmante (token USB, certificado instalado o archivo .p12): el titular
-- firma un hash en su dispositivo con el "Firmador CalaSign" y el servidor arma la firma PAdES incremental.

ALTER TABLE recipients ADD COLUMN signature_type text NOT NULL DEFAULT 'electronic';
ALTER TABLE recipients ADD CONSTRAINT recipients_signature_type_check CHECK (signature_type IN ('electronic','certificate'));
-- { matchIdDocument, allowedIssuers[], requireQualified }
ALTER TABLE recipients ADD COLUMN certificate_requirements jsonb;

ALTER TABLE template_roles ADD COLUMN signature_type text NOT NULL DEFAULT 'electronic';
ALTER TABLE template_roles ADD CONSTRAINT template_roles_signature_type_check CHECK (signature_type IN ('electronic','certificate'));
ALTER TABLE template_roles ADD COLUMN certificate_requirements jsonb;

-- Estado nuevo: todos firmaron electrónicamente y faltan las firmas con certificado.
ALTER TABLE envelopes DROP CONSTRAINT IF EXISTS envelopes_status_check;
ALTER TABLE envelopes ADD CONSTRAINT envelopes_status_check
  CHECK (status IN ('draft','sent','finalizing','awaiting_certificates','completed','declined','voided','expired'));

-- PDF de trabajo: documentos estampados + certificado de finalización, sin sello de plataforma. Cada firma con
-- certificado lo reemplaza por una revisión incremental nueva.
CREATE TABLE envelope_certsign (
  envelope_id         uuid PRIMARY KEY REFERENCES envelopes(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  working_key         text NOT NULL,
  working_sha256      text NOT NULL,
  completed_at        timestamptz NOT NULL,
  -- Cabeza de la cadena de eventos impresa en el certificado de finalización del PDF de trabajo.
  chain_head          text NOT NULL,
  ready               boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE certificate_signatures (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  position            integer NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','signed')),
  field_name          text NOT NULL,
  subject             text,
  issuer              text,
  common_name         text,
  serial_number       text,
  not_before          timestamptz,
  not_after           timestamptz,
  cert_sha256         text,
  trusted             boolean,
  identity_source     text,
  signed_at           timestamptz,
  signed_pdf_sha256   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_id)
);
CREATE INDEX certificate_signatures_envelope_idx ON certificate_signatures (envelope_id, position);

-- Sesión de firma del Firmador: código de un solo uso (se guarda su hash), atado al firmante y al PDF de trabajo.
CREATE TABLE certsign_sessions (
  id                  uuid PRIMARY KEY,
  code_hash           text NOT NULL UNIQUE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  working_sha256      text NOT NULL,
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created','prepared','completed','failed','expired')),
  expires_at          timestamptz NOT NULL,
  prepared_key        text,
  byte_range          jsonb,
  signed_attrs        text,
  chain_der           jsonb,
  signature_algorithm text,
  named_curve         text,
  cert_check          jsonb,
  error               text,
  ip                  text,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX certsign_sessions_recipient_idx ON certsign_sessions (recipient_id, created_at DESC);
